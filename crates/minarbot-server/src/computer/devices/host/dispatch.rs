use super::*;

fn executor_busy() -> Failure {
    fail(409, "executor_busy", "Task is being processed.")
}

fn recovery_required() -> Failure {
    fail(
        409,
        "recovery_required",
        "Action must be reconciled before resuming.",
    )
}

fn invalid_response() -> Failure {
    fail(502, "invalid_response", "Invalid device response.")
}

impl Host {
    pub(super) fn executor_refs(&self) -> Result<Vec<Value>> {
        let stored: String = self.db.query_row(
            "SELECT executor_refs_json FROM device_state WHERE id=1",
            [],
            |row| row.get(0),
        )?;
        let refs = crate::web::parse_json(stored.as_bytes())?;
        refs.as_array().cloned().ok_or_else(journal::missing)
    }

    fn save_executor(&self, record: &Value) -> Result<()> {
        let tx = self.db.unchecked_transaction()?;
        let mut refs = self.executor_refs()?;
        refs.retain(|prior| {
            prior["taskId"] != record["taskId"] || prior["requestId"] != record["requestId"]
        });
        refs.push(record.clone());
        tx.execute(
            "UPDATE device_state SET executor_refs_json=? WHERE id=1",
            [db::canonical(&json!(refs))],
        )?;
        if let Some(generation) = record["ownership"]["executorGeneration"].as_i64() {
            tx.execute(
                "UPDATE device_state SET highest_executor_generation=max(highest_executor_generation,?) WHERE id=1",
                [generation],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    fn lock_proof(&self, task: &str) -> Result<Value> {
        let lock = self.executor.as_ref().ok_or_else(executor_busy)?;
        let reconciled: i64 = self.db.query_row(
            "SELECT coalesce(max(j.journal_sequence),0) FROM device_journal j JOIN device_outbox o ON o.action_id=j.action_id WHERE j.task_id=? AND o.state='acknowledged'",
            [task],
            |row| row.get(0),
        )?;
        let rows = rows(
            &self.db,
            "SELECT action_id,state,journal_sequence FROM device_journal WHERE task_id=? ORDER BY sequence",
            [task],
        )?;
        let mut proof = lock.runner.clone();
        proof["previousOwnerStopped"] = true.into();
        proof["reconciledThrough"] = reconciled.into();
        proof["journalDigest"] = digest(&json!(rows)).into();
        Ok(proof)
    }

    pub(super) async fn acquire_task(
        &mut self,
        token: &str,
        mut record: Value,
        persisted: bool,
    ) -> Result<Value> {
        let task = id(&record["taskId"])?;
        let request = id(&record["requestId"])?;
        let reference = format!("executor/{task}/{request}");
        if record["tokenReference"] != reference {
            return Err(journal::missing());
        }
        let service = self.secret_service();
        let runner = match self.keys.read(&service, &reference)? {
            Some(value) => value,
            None if !persisted => {
                let value = B64.encode(keys::entropy::<32>()?);
                self.keys.write(&service, &reference, &value)?;
                if self.keys.read(&service, &reference)?.as_deref() != Some(&value) {
                    return Err(keys::unavailable());
                }
                value
            }
            None => return Err(keys::unavailable()),
        };
        decode(&json!(runner), 32).map_err(|_| keys::unavailable())?;
        self.save_executor(&record)?;
        let command = json!({"requestId":request,"taskId":task,
            "previousExecutorGeneration":record["acquire"]["previousExecutorGeneration"],
            "lockProof":record["acquire"]["lockProof"],"executorTokenHash":db::digest(&runner)});
        let result = self
            .post_path(
                &format!("/api/devices/{}/acquire", self.identity.device_id),
                token,
                &command,
                Some(&runner),
                LIMIT,
                TIMEOUT,
            )
            .await;
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                if !error.retryable {
                    record["rejected"] = true.into();
                    self.save_executor(&record)?;
                }
                return Err(error);
            }
        };
        let data = &result["data"];
        crate::tasks::validate_device_ownership(&data["ownership"])?;
        let ownership = &data["ownership"];
        let descriptor = self
            .identity
            .descriptor
            .as_ref()
            .ok_or_else(invalid_response)?;
        if data["taskId"] != task
            || ownership["taskId"] != task
            || ownership["authorityGeneration"] != descriptor["authorityGeneration"]
            || ownership["deviceGeneration"] != descriptor["deviceGeneration"]
            || ownership["executorGeneration"].as_i64()
                != command["previousExecutorGeneration"]
                    .as_i64()
                    .and_then(|value| value.checked_add(1))
            || revision(&data["revision"], 1).is_err()
        {
            return Err(invalid_response());
        }
        record["ownership"] = ownership.clone();
        self.save_executor(&record)?;
        Ok(data.clone())
    }

    pub(super) fn latest_owner(&self, task: &str) -> Result<Option<Value>> {
        Ok(self
            .executor_refs()?
            .into_iter()
            .filter(|record| record["taskId"] == task && record["ownership"].is_object())
            .max_by_key(|record| record["ownership"]["executorGeneration"].as_i64()))
    }

    pub(super) async fn start_task(&mut self, token: &str, task: &str) -> Result<Value> {
        let task = id(&json!(task))?;
        self.acquire_executor()?;
        let proof = self.lock_proof(&task)?;
        let previous = self.executor_refs()?.into_iter().rev().find(|record| {
            record["taskId"] == task
                && record["ownership"].is_null()
                && record["acquire"].is_object()
                && record["rejected"] != true
        });
        if let Some(pending) = previous {
            let same_runner = pending["acquire"]["lockProof"]["lockId"] == proof["lockId"];
            let recovered = self.acquire_task(token, pending, true).await?;
            if same_runner {
                return Ok(recovered);
            }
        }
        let previous = self.latest_owner(&task)?;
        if let Some(previous) = &previous {
            if previous["acquire"]["lockProof"]["lockId"] == proof["lockId"] {
                let state = self
                    .execution_state(token, &task, &previous["ownership"])
                    .await?;
                return Ok(
                    json!({"taskId":task,"ownership":previous["ownership"],"revision":state["revision"]}),
                );
            }
        }
        let request = request_id();
        let generation = previous
            .as_ref()
            .and_then(|previous| previous["ownership"]["executorGeneration"].as_i64())
            .unwrap_or(0);
        self.acquire_task(token, json!({
            "taskId":task,"requestId":request,"tokenReference":format!("executor/{task}/{request}"),
            "acquire":{"lockProof":proof,"previousExecutorGeneration":generation}
        }), false).await
    }

    pub(super) async fn execution_state(
        &mut self,
        token: &str,
        task: &str,
        ownership: &Value,
    ) -> Result<Value> {
        let runner = self.executor_token(task, ownership)?;
        let command = json!({"requestId":request_id(),"ownership":ownership});
        let reply = self
            .post_path(
                &format!("/api/tasks/{task}/execution"),
                token,
                &command,
                Some(&runner),
                RESULT_LIMIT,
                TIMEOUT,
            )
            .await?;
        let data = &reply["data"];
        if data["taskId"] != task
            || !matches!(
                text(data, "state"),
                "queued"
                    | "waiting_device"
                    | "waiting_resource"
                    | "running"
                    | "paused"
                    | "approval"
                    | "uncertain"
                    | "completed"
                    | "failed"
                    | "cancelled"
                    | "transferred"
            )
            || revision(&data["nextSequence"], 0).is_err()
            || revision(&data["revision"], 1).is_err()
        {
            return Err(invalid_response());
        }
        Ok(data.clone())
    }

    pub(super) async fn task_context(
        &mut self,
        token: &str,
        task: &str,
        ownership: &Value,
        expected: &Value,
    ) -> Result<Value> {
        let runner = self.executor_token(task, ownership)?;
        let body =
            json!({"requestId":request_id(),"ownership":ownership,"expectedTaskRevision":expected});
        let response = self
            .post_path(
                &format!("/api/tasks/{task}/context"),
                token,
                &body,
                Some(&runner),
                RESULT_LIMIT,
                TIMEOUT,
            )
            .await?;
        Ok(response["data"].clone())
    }

    pub(super) async fn execute_action<F, Fut>(
        &mut self,
        token: &str,
        input: &Value,
        effect: F,
    ) -> Result<Value>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<Value>>,
    {
        self.acquire_executor()?;
        let task = id(&input["taskId"])?;
        let action = id(&input["actionId"])?;
        let row = self.stage_action(input)?;
        let saved = journal::intent(&row)?;
        let runner = self.executor_token(&task, &saved["ownership"])?;
        match text(&row, "state") {
            "acknowledged" => return Ok(row),
            "reported" => {}
            "prepared" => {
                if saved["runner"] != self.executor.as_ref().ok_or_else(executor_busy)?.runner {
                    return Err(recovery_required());
                }
                self.checkpoint(&format!("{}-not-sent", text(&row, "action_kind")))
                    .await;
                let body = self.prepare_body(&row, &saved)?;
                self.post_path(
                    &format!("/api/tasks/{task}/actions/{action}/prepare"),
                    token,
                    &body,
                    Some(&runner),
                    LIMIT,
                    TIMEOUT,
                )
                .await?;
                if saved["actionKind"] == "provider" {
                    self.checkpoint("provider-prepare-reply").await;
                }
                self.update_dispatch(&action, "committed", "unknown", false)?;
                let command = json!({"requestId":saved["commitRequestId"],"ownership":saved["ownership"],
                    "intentDigest":saved["intentDigest"],"expectedTaskRevision":saved["context"]["snapshot"]["taskRevision"],
                    "journalSequence":saved["prepareJournalSequence"]});
                let grant = Duration::from_secs(2);
                let start = tokio::time::Instant::now();
                let committed = self
                    .post_path(
                        &format!("/api/tasks/{task}/actions/{action}/commit"),
                        token,
                        &command,
                        Some(&runner),
                        LIMIT,
                        grant,
                    )
                    .await?;
                if saved["actionKind"] == "provider" {
                    self.checkpoint("provider-commit-reply").await;
                }
                if committed["data"]["dispatchable"] != true || start.elapsed() > grant {
                    return Err(fail(
                        409,
                        "recovery_required",
                        "Commit grant is missing, late, or already used.",
                    ));
                }
                let deadline = tokio::time::Instant::now() + grant;
                self.validate_admission(&row, &saved, &committed)?;
                self.update_dispatch(&action, "in_flight", "unknown", true)?;
                if tokio::time::Instant::now() > deadline {
                    return Err(fail(
                        409,
                        "recovery_required",
                        "Action start limit exceeded.",
                    ));
                }
                let result = if saved["actionKind"] == "canonical" {
                    self.replay_canonical(token, &runner, &task, &row, &saved, TIMEOUT)
                        .await
                } else {
                    match effect().await {
                        Ok(content) => {
                            self.checkpoint("provider-in-flight").await;
                            self.save_outcome(&task, &action, &saved, &content)
                        }
                        Err(error) => Err(error),
                    }
                };
                if let Err(error) = result {
                    let tx = self.db.unchecked_transaction()?;
                    tx.execute("UPDATE device_journal SET state='uncertain',effect_status='unknown',uncertain_reason=?,journal_sequence=? WHERE action_id=? AND state='in_flight'",
                        params!["Effects started without a durable result.", journal::watermark(&tx)?, action])?;
                    tx.commit()?;
                    return Err(error);
                }
            }
            _ => return Err(recovery_required()),
        }
        let row = journal::latest_row(&self.db, &action)?;
        if row["action_kind"] == "provider" {
            self.checkpoint("provider-saved").await;
        }
        self.reconcile(token, &row, &saved, &runner, TIMEOUT)
            .await?;
        journal::latest_row(&self.db, &action)
    }

    pub(super) fn update_dispatch(
        &self,
        action: &str,
        state: &str,
        effect: &str,
        marked: bool,
    ) -> Result<()> {
        let tx = self.db.unchecked_transaction()?;
        let expected = if marked { "committed" } else { "prepared" };
        if tx.execute("UPDATE device_journal SET state=?,effect_status=?,send_marker=?,journal_sequence=? WHERE action_id=? AND state=? AND send_marker=0",
            params![state,effect,marked,journal::watermark(&tx)?,action,expected])? != 1 {
            return Err(fail(409, "dispatch_forbidden", "Action must not be sent again."));
        }
        tx.commit()?;
        Ok(())
    }

    fn validate_admission(&self, row: &Value, saved: &Value, reply: &Value) -> Result<()> {
        let actual = &reply["data"]["admission"];
        let receipt = &reply["receipt"];
        let mut expected = json!({"v":1,"actionId":row["action_id"],"taskId":row["task_id"],
            "ownership":saved["ownership"],"intentDigest":row["intent_digest"],"actionKind":row["action_kind"],
            "contextSnapshotId":saved["context"]["snapshotRef"]["snapshotId"],
            "contextDigest":saved["context"]["snapshotRef"]["digest"],"grantRevision":row["grant_revision"],
            "committedAt":actual["committedAt"],"oneUse":true});
        if row["action_kind"] == "provider" {
            expected["bindingId"] = row["binding_id"].clone();
            expected["bindingRevision"] = row["binding_revision"].clone();
        }
        if actual != &expected
            || revision(&actual["committedAt"], 0).is_err()
            || receipt["requestId"] != saved["commitRequestId"]
            || receipt["recordId"] != row["action_id"]
            || receipt["projectId"] != saved["context"]["snapshot"]["projectId"]
            || !self.own_receipt(receipt)
        {
            return Err(fail(
                409,
                "admission_invalid",
                "Admission does not match the journal intent.",
            ));
        }
        Ok(())
    }

    pub(super) fn stage_action(&self, input: &Value) -> Result<Value> {
        let task = id(&input["taskId"])?;
        let action = id(&input["actionId"])?;
        let sequence = revision(&input["sequence"], 0)?;
        let grant = revision(&input["grantRevision"], 1)?;
        let context = &input["context"];
        let snapshot = &context["snapshot"];
        let reference = &context["snapshotRef"];
        let ownership = &input["ownership"];
        let kind = text(input, "actionKind");
        let payload = &input["payload"];
        let binding = match kind {
            "provider" => Some((
                id(&input["bindingId"])?,
                revision(&input["bindingRevision"], 1)?,
            )),
            "canonical" | "read" | "compute" | "local" | "browser" => {
                if input.get("bindingId").is_some() || input.get("bindingRevision").is_some() {
                    return Err(fail(
                        400,
                        "binding_invalid",
                        "Binding does not match the action type.",
                    ));
                }
                None
            }
            _ => return Err(fail(400, "invalid_action_kind", "Invalid action type.")),
        };
        let resolution = input.get("resolutionRequestId").map(id).transpose()?;
        if db::canonical(payload).len() > LIMIT {
            return Err(fail(
                413,
                "payload_too_large",
                "Action payload exceeds the limit.",
            ));
        }
        crate::tasks::validate_device_ownership(ownership)?;
        id(&reference["snapshotId"])?;
        revision(&reference["revision"], 1)?;
        revision(&snapshot["taskRevision"], 1)?;
        let descriptor = self
            .identity
            .descriptor
            .as_ref()
            .ok_or_else(journal::missing)?;
        if ownership["taskId"] != task
            || ownership["authorityGeneration"] != descriptor["authorityGeneration"]
            || ownership["deviceGeneration"] != descriptor["deviceGeneration"]
            || reference["v"] != 1
            || reference["taskId"] != task
            || snapshot["taskId"] != task
            || snapshot["authorityGeneration"] != ownership["authorityGeneration"]
            || snapshot["homeDeviceId"] != self.identity.device_id
            || id(&snapshot["projectId"]).is_err()
            || reference["digest"] != digest(snapshot)
        {
            return Err(fail(
                409,
                "context_invalid",
                "Context does not match the task, home device, or digest.",
            ));
        }
        let input_digest = digest(input);
        if let Some(prior) = one(
            &self.db,
            "SELECT * FROM device_journal WHERE action_id=?",
            [&action],
        )? {
            if journal::intent(&prior)?["inputDigest"] != input_digest {
                return Err(fail(
                    409,
                    "action_conflict",
                    "Action journal already uses different content.",
                ));
            }
            return Ok(prior);
        }
        if one(&self.db, "SELECT 1 FROM device_journal j LEFT JOIN device_outbox o ON o.action_id=j.action_id WHERE j.task_id=? AND j.state<>'acknowledged' AND (o.state IS NULL OR o.state<>'acknowledged') LIMIT 1", [&task])?.is_some() {
            return Err(fail(409,"outcome_unresolved","Previous action ACK is not durable yet."));
        }
        let payload_digest = if kind == "canonical" {
            fields(payload, &["toolCall", "expectedRevision", "fileInput"])?;
            validate_tool_call(&payload["toolCall"])?;
            revision(&payload["expectedRevision"], 0)?;
            digest(&json!([
                "briefsip-canonical-tool-v1",
                payload["toolCall"],
                payload["expectedRevision"],
                payload["fileInput"]
            ]))
        } else {
            digest(payload)
        };
        let binding_id = binding.as_ref().map(|(id, _)| id);
        let binding_revision = binding.as_ref().map(|(_, revision)| revision);
        let intent_digest = digest(&json!([
            task,
            action,
            sequence,
            ownership,
            payload_digest,
            kind,
            reference["snapshotId"],
            reference["digest"],
            binding_id,
            binding_revision,
            grant,
            null,
            null,
            resolution
        ]));
        if db::canonical(context).len() > RESULT_LIMIT {
            return Err(fail(
                413,
                "context_too_large",
                "Journal context exceeds the limit.",
            ));
        }
        let mut saved = input.clone();
        saved["runner"] = self
            .executor
            .as_ref()
            .ok_or_else(executor_busy)?
            .runner
            .clone();
        saved["children"] = json!([]);
        saved["inputDigest"] = input_digest.into();
        saved["payloadDigest"] = payload_digest.clone().into();
        saved["intentDigest"] = intent_digest.clone().into();
        saved["prepareRequestId"] = request_id().into();
        saved["commitRequestId"] = request_id().into();
        saved["reportRequestId"] = request_id().into();
        let tx = self.db.unchecked_transaction()?;
        let watermark = journal::watermark(&tx)?;
        saved["prepareJournalSequence"] = watermark.into();
        tx.execute("INSERT INTO device_journal(action_id,task_id,sequence,action_kind,authority_generation,device_generation,
            executor_generation,state,payload_digest,intent_digest,intent_json,binding_id,binding_revision,grant_revision,
            effect_status,send_marker,journal_sequence,created) VALUES (?,?,?,?,?,?,?,'prepared',?,?,?,?,?,?,'none',0,?,?)",
            params![action,task,sequence,kind,ownership["authorityGeneration"].as_str(),ownership["deviceGeneration"].as_i64(),
                ownership["executorGeneration"].as_i64(),payload_digest,intent_digest,db::canonical(&saved),binding_id,
                binding_revision,grant,watermark,now()])?;
        tx.commit()?;
        journal::latest_row(&self.db, &action)
    }
}

pub(super) fn validate_tool_call(call: &Value) -> Result<()> {
    fields(call, &["id", "function"])?;
    let function = &call["function"];
    fields(function, &["name", "arguments"])?;
    if !call["id"].as_str().is_some_and(|s| {
        !s.is_empty()
            && s.encode_utf16().count() <= 200
            && !s.chars().any(|c| c < ' ' || c == '\u{7f}')
    }) || !function["name"]
        .as_str()
        .is_some_and(|s| !s.is_empty() && s.encode_utf16().count() <= 160)
        || function["arguments"]
            .as_str()
            .is_none_or(|s| s.encode_utf16().count() > 20000)
    {
        return Err(fail(400, "invalid_tool_call", "Invalid tool call."));
    }
    Ok(())
}
