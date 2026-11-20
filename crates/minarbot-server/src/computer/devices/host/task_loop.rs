use super::*;
use std::{collections::HashMap, sync::Mutex};

#[derive(Default)]
pub(super) struct TaskSlots(Mutex<HashMap<String, Option<ProviderSlot>>>);

struct ProviderSlot {
    binding: String,
    agent: String,
    project: String,
}

struct TaskRun {
    slots: Arc<TaskSlots>,
    task: String,
}

impl TaskSlots {
    pub(super) fn is_active(&self, task: &str) -> Result<bool> {
        Ok(self
            .0
            .lock()
            .map_err(|_| Failure::storage())?
            .contains_key(task))
    }

    fn begin(self: &Arc<Self>, task: &str) -> Result<TaskRun> {
        let mut slots = self.0.lock().map_err(|_| Failure::storage())?;
        if slots.contains_key(task) {
            return Err(fail(409, "executor_busy", "Task is being processed."));
        }
        slots.insert(task.into(), None);
        Ok(TaskRun {
            slots: self.clone(),
            task: task.into(),
        })
    }
}

impl TaskRun {
    fn reserve_provider(&self, binding: &str, snapshot: &Value) -> Result<bool> {
        let agent = id(&snapshot["agentId"])?;
        let project = id(&snapshot["projectId"])?;
        let mut entries = self.slots.0.lock().map_err(|_| Failure::storage())?;
        let slots = || entries.values().flatten();
        if slots().count() >= 4
            || slots().filter(|slot| slot.binding == binding).count() >= 2
            || slots().any(|slot| slot.agent == agent && slot.project == project)
        {
            return Ok(false);
        }
        entries.insert(
            self.task.clone(),
            Some(ProviderSlot {
                binding: binding.into(),
                agent,
                project,
            }),
        );
        Ok(true)
    }

    fn release_provider(&self) -> Result<()> {
        self.slots
            .0
            .lock()
            .map_err(|_| Failure::storage())?
            .insert(self.task.clone(), None);
        Ok(())
    }
}

impl Drop for TaskRun {
    fn drop(&mut self) {
        if let Ok(mut slots) = self.slots.0.lock() {
            slots.remove(&self.task);
        }
    }
}

impl Host {
    pub(super) async fn run_task(
        &mut self,
        token: &str,
        task: &str,
        provider: &super::provider::Provider,
    ) -> Result<Value> {
        let active = self.tasks.begin(task)?;
        let result = self.run_task_steps(token, task, provider, &active).await;
        match result {
            Ok(state) => Ok(json!({"taskId":task,"state":state})),
            Err(error)
                if matches!(
                    error.code,
                    "waiting_agents" | "question_pending" | "event_pending" | "task_not_runnable"
                ) =>
            {
                Ok(json!({"taskId":task,"state":error.code}))
            }
            Err(error) => Err(error),
        }
    }

    async fn run_task_steps(
        &mut self,
        token: &str,
        task: &str,
        provider: &super::provider::Provider,
        active: &TaskRun,
    ) -> Result<String> {
        let task = id(&json!(task))?;
        self.acquire_executor()?;
        for row in rows(&self.db, "SELECT j.* FROM device_journal j LEFT JOIN device_outbox o ON o.action_id=j.action_id
            WHERE j.task_id=? AND j.state<>'acknowledged' AND (o.state IS NULL OR o.state<>'acknowledged') ORDER BY j.sequence", [&task])?
        {
            self.recover_action(token, &row).await?;
        }
        let mut owned = None;
        for _ in 0..40 {
            let latest = one(
                &self.db,
                "SELECT * FROM device_journal WHERE task_id=? ORDER BY sequence DESC LIMIT 1",
                [&task],
            )?;
            let previous = self.latest_owner(&task)?;
            if previous.is_none() && owned.is_none() {
                owned = Some(self.start_task(token, &task).await?);
            }
            let ownership = &owned
                .as_ref()
                .or(previous.as_ref())
                .ok_or_else(journal::missing)?["ownership"];
            let mut state = self.execution_state(token, &task, ownership).await?;
            if !matches!(
                text(&state, "state"),
                "running" | "queued" | "waiting_device"
            ) {
                return Ok(text(&state, "state").to_owned());
            }
            let sequence = latest
                .as_ref()
                .and_then(|row| row["sequence"].as_i64())
                .map_or(0, |value| value + 1);
            if state["nextSequence"] != sequence {
                return Err(fail(
                    409,
                    "journal_incomplete",
                    "Local journal does not match the canonical action.",
                ));
            }
            let latest = latest.unwrap_or(Value::Null);
            let resolution = state["resolution"].clone();
            if latest["state"] == "uncertain"
                && resolution["actionId"] == latest["action_id"]
                && resolution["kind"] == "known_result"
                && resolution.get("result").is_some()
            {
                self.resolve_known(&latest, &resolution)?;
                continue;
            }
            let prior_provider =
                latest["action_kind"] == "provider" && latest["state"] == "acknowledged";
            let prior_result = if prior_provider {
                crate::web::parse_json(text(&latest, "result_json").as_bytes())?
            } else {
                Value::Null
            };
            if prior_provider && prior_result["text"].is_string() {
                self.complete_task(token, &task, &latest).await?;
                return Ok("completed".into());
            }
            if owned.is_none() {
                let value = self.start_task(token, &task).await?;
                state = self
                    .execution_state(token, &task, &value["ownership"])
                    .await?;
                owned = Some(value);
            }
            if state["state"] != "running" {
                return Ok(text(&state, "state").to_owned());
            }
            let ownership = &owned.as_ref().ok_or_else(journal::missing)?["ownership"];
            let context = self
                .task_context(token, &task, ownership, &state["revision"])
                .await?;
            let snapshot = &context["snapshot"];
            let grant = snapshot["sourceRevisions"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|row| row["kind"] == "assignment")
                .map(|row| &row["revision"])
                .ok_or_else(|| fail(502, "invalid_response", "Invalid task assignment."))?;
            let retry = resolution["actionId"] == latest["action_id"]
                && resolution["replacementActionId"].is_string();
            let action = if retry {
                id(&resolution["replacementActionId"])?
            } else {
                request_id()
            };
            let mut input = json!({"taskId":task,"actionId":action,"sequence":sequence,
                "ownership":ownership,"context":context,"grantRevision":grant});
            if retry {
                input["resolutionRequestId"] = id(&resolution["requestId"])?.into();
            }
            let safe_unsent = latest["state"] == "not_sent" && latest["effect_status"] == "none";
            if prior_provider || latest["action_kind"] == "canonical" && (safe_unsent || retry) {
                let call = if prior_provider {
                    prior_result["toolCall"].clone()
                } else {
                    journal::intent(&latest)?["payload"]["toolCall"].clone()
                };
                let expected = revision(&snapshot["taskRevision"], 1)? + 1;
                input["actionKind"] = "canonical".into();
                input["payload"] = json!({"toolCall":call,"expectedRevision":expected});
                self.execute_action(token, &input, || async { Err(Failure::storage()) })
                    .await?;
                continue;
            }
            if !latest.is_null() && latest["state"] != "acknowledged" && !safe_unsent && !retry {
                return Err(fail(
                    409,
                    "outcome_unresolved",
                    "Previous result is not complete yet.",
                ));
            }
            let admission = &snapshot["admission"];
            if admission.get("providerBindingId") == Some(&Value::Null) {
                self.wait_provider(token, &task, ownership, &context)
                    .await?;
                return Ok("waiting_resource".into());
            }
            let binding = id(&admission["providerBindingId"])?;
            let revision = revision(&admission["providerBindingRevision"], 1)?;
            if !active.reserve_provider(&binding, snapshot)? {
                return Ok("waiting_capacity".into());
            }
            let call = provider.prepare(&binding, &context)?;
            let client = self.client.clone();
            input["actionKind"] = "provider".into();
            input["bindingId"] = binding.into();
            input["bindingRevision"] = revision.into();
            input["payload"] = json!({"purpose":"answer"});
            let result = self
                .execute_action(token, &input, || async {
                    let result = call.send(client).await?;
                    provider_result(snapshot, &result)?;
                    Ok(result)
                })
                .await;
            active.release_provider()?;
            result?;
        }
        Ok("yielded".into())
    }

    async fn wait_provider(
        &mut self,
        token: &str,
        task: &str,
        ownership: &Value,
        context: &Value,
    ) -> Result<()> {
        let runner = self.executor_token(task, ownership)?;
        let expected = revision(&context["snapshot"]["taskRevision"], 1)?;
        let command =
            json!({"requestId":request_id(),"ownership":ownership,"expectedTaskRevision":expected});
        let response = self
            .post_path(
                &format!("/api/tasks/{task}/wait-provider"),
                token,
                &command,
                Some(&runner),
                LIMIT,
                TIMEOUT,
            )
            .await?;
        let data = &response["data"];
        let receipt = &response["receipt"];
        let digest = digest(&json!(["minarbot-task-wait-provider-v1", task, command]));
        if data["taskId"] != task
            || data["state"] != "waiting_resource"
            || data["revision"] != expected + 1
            || receipt["requestId"] != command["requestId"]
            || receipt["recordId"] != task
            || receipt["recordRevision"] != data["revision"]
            || !self.own_receipt(receipt)
            || receipt["projectId"] != context["snapshot"]["projectId"]
            || receipt["payloadDigest"] != digest
            || receipt["status"] != 200
        {
            return Err(fail(
                502,
                "receipt_mismatch",
                "Provider wait receipt does not match the task.",
            ));
        }
        Ok(())
    }

    pub(super) async fn complete_task(
        &mut self,
        token: &str,
        task: &str,
        row: &Value,
    ) -> Result<Value> {
        if row["task_id"] != task {
            return Err(fail(
                409,
                "action_conflict",
                "Action does not belong to the task.",
            ));
        }
        let action = id(&row["action_id"])?;
        if one(
            &self.db,
            "SELECT 1 FROM device_outbox WHERE action_id=? AND state='acknowledged'",
            [&action],
        )?
        .is_none()
        {
            return Err(fail(
                409,
                "result_missing",
                "Provider result is not acknowledged by the server yet.",
            ));
        }
        let mut saved = journal::intent(row)?;
        let metadata = saved.as_object_mut().ok_or_else(Failure::storage)?;
        if !metadata.contains_key("completeRequestId")
            || metadata.remove("completionError").is_some()
        {
            metadata
                .entry("completeRequestId")
                .or_insert_with(|| request_id().into());
            self.db.execute(
                "UPDATE device_journal SET intent_json=? WHERE action_id=?",
                params![db::canonical(&saved), action],
            )?;
        }
        let runner = self.executor_token(task, &saved["ownership"])?;
        self.complete_recovered(token, row, saved, &runner, false)
            .await
    }

    fn resolve_known(&self, row: &Value, resolution: &Value) -> Result<()> {
        let action = id(&row["action_id"])?;
        if row["effect_status"] != "unknown"
            || one(
                &self.db,
                "SELECT 1 FROM device_outbox WHERE action_id=? AND state='acknowledged'",
                [&action],
            )?
            .is_none()
        {
            return Err(fail(
                409,
                "outcome_unresolved",
                "Previous evidence is not acknowledged by the server yet.",
            ));
        }
        let mut saved = journal::intent(row)?;
        saved["knownResolutionId"] = id(&resolution["requestId"])?.into();
        let content = db::canonical(&resolution["result"]);
        let sequence = revision(&resolution["journalSequence"], 1)?;
        let tx = self.db.unchecked_transaction()?;
        tx.execute(
            "UPDATE device_state SET journal_sequence=max(journal_sequence,?) WHERE id=1",
            [sequence],
        )?;
        tx.execute("UPDATE device_journal SET state='acknowledged',effect_status='known',result_digest=?,result_json=?,
            uncertain_reason=NULL,intent_json=?,journal_sequence=max(journal_sequence,?) WHERE action_id=?",
            params![db::digest(&content),content,db::canonical(&saved),sequence,action])?;
        tx.commit()?;
        Ok(())
    }
}

fn provider_result(snapshot: &Value, result: &Value) -> Result<()> {
    let invalid = || {
        fail(
            502,
            "provider_result_invalid",
            "Provider did not return text or a single valid tool call.",
        )
    };
    let object = result
        .as_object()
        .filter(|object| object.len() == 1)
        .ok_or_else(invalid)?;
    if db::canonical(result).len() > RESULT_LIMIT - 4096 {
        return Err(invalid());
    }
    if let Some(text) = object.get("text") {
        return if text
            .as_str()
            .is_some_and(|s| !s.trim().is_empty() && !s.contains('\0'))
        {
            Ok(())
        } else {
            Err(invalid())
        };
    }
    let call = &result["toolCall"];
    dispatch::validate_tool_call(call).map_err(|_| invalid())?;
    let function = &call["function"];
    if !snapshot["tools"].as_array().is_some_and(|list| {
        list.iter()
            .any(|tool| tool["function"]["name"] == function["name"])
    }) || !serde_json::from_str::<Value>(text(function, "arguments"))
        .is_ok_and(|args| args.is_object())
    {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_slots_fence_duplicate_tasks_and_each_capacity_boundary() -> Result<()> {
        let slots = Arc::new(TaskSlots::default());
        let agent = request_id();
        let project = request_id();
        let scope = json!({"agentId":agent,"projectId":project});
        let other = || json!({"agentId":request_id(),"projectId":project});
        let task = request_id();
        let first = slots.begin(&task)?;
        assert_eq!(
            slots.begin(&task).err().map(|error| error.code),
            Some("executor_busy")
        );
        assert!(first.reserve_provider("binding-a", &scope)?);
        let second = slots.begin(&request_id())?;
        assert!(!second.reserve_provider("binding-b", &scope)?);
        assert!(second.reserve_provider("binding-a", &other())?);
        let third = slots.begin(&request_id())?;
        assert!(!third.reserve_provider("binding-a", &other())?);
        assert!(third.reserve_provider("binding-b", &other())?);
        let fourth = slots.begin(&request_id())?;
        assert!(fourth.reserve_provider("binding-c", &other())?);
        let fifth = slots.begin(&request_id())?;
        assert!(!fifth.reserve_provider("binding-d", &other())?);
        first.release_provider()?;
        assert!(fifth.reserve_provider("binding-a", &scope)?);
        drop(first);
        slots.begin(&task)?;
        Ok(())
    }
}
