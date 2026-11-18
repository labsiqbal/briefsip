use super::*;

const RECOVERY_TIMEOUT: Duration = Duration::from_secs(4);

pub(super) fn missing() -> Failure {
    fail(
        409,
        "executor_missing",
        "Local executor token is unavailable.",
    )
}
fn receipt_mismatch() -> Failure {
    fail(
        502,
        "receipt_mismatch",
        "Publication receipt does not match the journal report.",
    )
}

pub(super) fn intent(row: &Value) -> Result<Value> {
    crate::web::parse_json(text(row, "intent_json").as_bytes())
}

pub(super) fn latest_row(db: &Connection, action: &str) -> Result<Value> {
    one(
        db,
        "SELECT * FROM device_journal WHERE action_id=?",
        [action],
    )?
    .ok_or_else(|| fail(404, "action_missing", "Action journal not found."))
}

pub(super) fn watermark(db: &Connection) -> Result<i64> {
    let sequence = db.query_row("UPDATE device_state SET journal_sequence=journal_sequence+1 WHERE id=1 RETURNING journal_sequence",[],|r|r.get(0))?;
    Ok(sequence)
}

fn result_ref(row: &Value) -> Value {
    json!({"v":1,"taskId":row["task_id"],"actionId":row["action_id"],"digest":row["result_digest"],
        "size":text(row,"result_json").len(),"encoding":"canonical-json-v1"})
}

pub(super) fn reported(row: &Value, saved: &Value) -> Result<Value> {
    let content = crate::web::parse_json(text(row, "result_json").as_bytes())?;
    Ok(
        json!({"requestId":saved["reportRequestId"],"actionId":row["action_id"],"ownership":saved["ownership"],"payloadDigest":row["payload_digest"],
        "state":"reported","effectStatus":"known","journalSequence":row["journal_sequence"],"resultDigest":row["result_digest"],
        "resultRef":result_ref(row),"resultContent":content}),
    )
}

fn report_digest(task: &str, report: &Value) -> String {
    digest(&json!(["briefsip-task-reconcile-v1",task,{
        "requestId":report["requestId"],"actionId":report["actionId"],"ownership":report["ownership"],"payloadDigest":report["payloadDigest"],
        "state":report["state"],"effectStatus":report["effectStatus"],"journalSequence":report["journalSequence"],"resultDigest":report["resultDigest"],
        "resultRef":report["resultRef"],"uncertainReason":report["uncertainReason"],"resultContentDigest":report.get("resultContent").map(|v| db::digest(&db::canonical(v))),
        "noMarkerEvidence":report["noMarkerEvidence"],"stopEvidence":report["stopEvidence"]
    }]))
}

fn save_report(db: &Connection, task: &str, action: &str, report: &Value) -> Result<()> {
    let digest = report_digest(task, report);
    let encoded = db::canonical(report);
    db.execute("INSERT INTO device_outbox(action_id,report_digest,state,receipt_json,report_json) VALUES (?,?,'pending',NULL,?)
        ON CONFLICT(action_id) DO UPDATE SET report_json=excluded.report_json WHERE device_outbox.report_json IS NULL
          AND device_outbox.report_digest=excluded.report_digest AND device_outbox.state='pending'",
        params![action,digest,encoded])?;
    let prior = one(
        db,
        "SELECT report_json,report_digest FROM device_outbox WHERE action_id=?",
        [action],
    )?
    .ok_or_else(Failure::storage)?;
    if prior["report_json"] != encoded || prior["report_digest"] != digest {
        return Err(fail(
            409,
            "journal_conflict",
            "Durable report content cannot change.",
        ));
    }
    Ok(())
}

impl Host {
    pub(super) fn executor_token(&self, task: &str, ownership: &Value) -> Result<String> {
        let refs = self.executor_refs()?;
        let record = refs
            .iter()
            .find(|value| value["taskId"] == task && value["ownership"] == *ownership)
            .ok_or_else(missing)?;
        let request = id(&record["requestId"])?;
        let reference = format!("executor/{task}/{request}");
        if record["tokenReference"] != reference {
            return Err(missing());
        }
        let token = self
            .keys
            .read(&self.secret_service(), &reference)?
            .ok_or_else(missing)?;
        decode(&json!(token), 32).map_err(|_| missing())?;
        Ok(token)
    }

    pub(super) fn prepare_body(&self, row: &Value, saved: &Value) -> Result<Value> {
        let context = &saved["context"];
        let mut body = json!({"requestId":saved["prepareRequestId"],"sequence":row["sequence"],"ownership":saved["ownership"],
            "payloadDigest":row["payload_digest"],"actionKind":row["action_kind"],"contextSnapshotId":context["snapshotRef"]["snapshotId"],
            "contextDigest":context["snapshotRef"]["digest"],"grantRevision":row["grant_revision"],
            "expectedTaskRevision":context["snapshot"]["taskRevision"],"journalSequence":saved["prepareJournalSequence"],"intentDigest":row["intent_digest"]});
        if row["action_kind"] == "provider" {
            body["bindingId"] = row["binding_id"].clone();
            body["bindingRevision"] = row["binding_revision"].clone();
        }
        if let Some(resolution) = saved.get("resolutionRequestId") {
            body["resolutionRequestId"] = id(resolution)?.into();
        }
        Ok(body)
    }

    pub(super) async fn replay_canonical(
        &mut self,
        token: &str,
        runner: &str,
        task: &str,
        row: &Value,
        saved: &Value,
        timeout: Duration,
    ) -> Result<()> {
        let action = id(&row["action_id"])?;
        let mut body = saved["payload"].clone();
        body["requestId"] = action.clone().into();
        body["actionId"] = action.clone().into();
        body["ownership"] = saved["ownership"].clone();
        body["payloadDigest"] = row["payload_digest"].clone();
        let response = self
            .post_path(
                &format!("/api/tasks/{task}/context-mutations"),
                token,
                &body,
                Some(runner),
                RESULT_LIMIT,
                timeout,
            )
            .await?;
        let result = &response["data"];
        let content = result.get("resultContent").ok_or_else(receipt_mismatch)?;
        let encoded = db::canonical(content);
        let content_digest = db::digest(&encoded);
        let reference = json!({"v":1,"taskId":task,"actionId":action,"digest":content_digest,"size":encoded.len(),"encoding":"canonical-json-v1"});
        let receipt = &response["receipt"];
        if result["actionId"] != action
            || result["resultRef"] != reference
            || receipt["requestId"] != action
            || receipt["recordId"] != action
            || receipt["projectId"] != saved["context"]["snapshot"]["projectId"]
            || receipt["payloadDigest"] != row["payload_digest"]
            || !self.own_receipt(receipt)
        {
            return Err(receipt_mismatch());
        }
        self.checkpoint("tool-reply").await;
        self.save_outcome(task, &action, saved, content)
    }

    pub(super) fn save_outcome(
        &self,
        task: &str,
        action: &str,
        saved: &Value,
        content: &Value,
    ) -> Result<()> {
        let encoded = db::canonical(content);
        let digest = db::digest(&encoded);
        let tx = self.db.unchecked_transaction()?;
        let row = latest_row(&tx, action)?;
        if row["result_json"].is_string() {
            return if row["result_json"] == encoded && row["result_digest"] == digest {
                Ok(())
            } else {
                Err(fail(
                    409,
                    "result_conflict",
                    "Journal result cannot be changed.",
                ))
            };
        }
        if tx.execute("UPDATE device_journal SET state='reported',result_digest=?,result_json=?,effect_status='known',journal_sequence=?
            WHERE action_id=? AND send_marker=1 AND (state='in_flight' OR (state='uncertain' AND action_kind='canonical'))",
            params![digest,encoded,watermark(&tx)?,action])? != 1 {
            return Err(fail(409, "result_forbidden", "Action does not have a send marker yet."));
        }
        let report = reported(&latest_row(&tx, action)?, saved)?;
        save_report(&tx, task, action, &report)?;
        tx.commit()?;
        Ok(())
    }

    pub(super) fn own_receipt(&self, receipt: &Value) -> bool {
        self.identity
            .descriptor
            .as_ref()
            .is_some_and(|d| receipt["actorId"] == d["accountId"])
    }

    pub(super) fn recovery_report(&self, row: &Value, saved: &Value) -> Result<Value> {
        let task = id(&row["task_id"])?;
        let action = id(&row["action_id"])?;
        if let Some(existing) = one(
            &self.db,
            "SELECT report_json FROM device_outbox WHERE action_id=?",
            [&action],
        )?
        .filter(|o| o["report_json"].is_string())
        {
            return crate::web::parse_json(text(&existing, "report_json").as_bytes());
        }
        let tx = self.db.unchecked_transaction()?;
        let report = if row["result_json"].is_string() {
            reported(row, saved)?
        } else {
            let sequence = watermark(&tx)?;
            let mut body = json!({"requestId":saved["reportRequestId"],"actionId":action,"ownership":saved["ownership"],
                "payloadDigest":row["payload_digest"],"journalSequence":sequence});
            if row["send_marker"] == 1 {
                let reason = "Runner stopped after the send marker without a durable result.";
                tx.execute("UPDATE device_journal SET state='uncertain',effect_status='unknown',uncertain_reason=?,journal_sequence=? WHERE action_id=?",
                    params![reason,sequence,action])?;
                body["state"] = "uncertain".into();
                body["effectStatus"] = "unknown".into();
                body["uncertainReason"] = reason.into();
            } else {
                let source = &saved["ownership"];
                let mut entry = json!({"taskId":task,"actionId":action,"sequence":row["sequence"],"executorGeneration":source["executorGeneration"],
                    "actionKind":row["action_kind"],"payloadDigest":row["payload_digest"],"intentDigest":row["intent_digest"],
                    "grantRevision":row["grant_revision"],"state":"not_sent","effectStatus":"none","journalSequence":sequence});
                if row["action_kind"] == "provider" {
                    entry["bindingId"] = row["binding_id"].clone();
                    entry["bindingRevision"] = row["binding_revision"].clone();
                }
                let device = json!(self.identity.device_id);
                let entry_body = crate::tasks::device_journal_body(
                    &source["authorityGeneration"],
                    &device,
                    &source["deviceGeneration"],
                    &entry,
                );
                let key = self.recovery_key(source)?;
                let entry_signature = key.sign(&entry_body)?;
                let runner = &saved["runner"];
                let boot_id = &self.executor.as_ref().ok_or_else(missing)?.boot_id;
                let mut children = saved["children"].as_array().ok_or_else(missing)?.clone();
                children.sort_by(|a, b| {
                    a["processGroupId"]
                        .as_i64()
                        .cmp(&b["processGroupId"].as_i64())
                        .then(a["processId"].as_i64().cmp(&b["processId"].as_i64()))
                        .then(text(a, "processStart").cmp(text(b, "processStart")))
                });
                let mut stop = json!({"v":1,"sourceAuthority":source["authorityGeneration"],"taskId":task,"actionId":action,
                    "sourceDeviceId":device,"sourceDeviceGeneration":source["deviceGeneration"],"executorGeneration":source["executorGeneration"],
                    "bootId":runner["bootId"],"processId":runner["processId"],"processStart":runner["processStart"],"lockId":runner["lockId"],
                    "observationBootId":boot_id,"observation":if runner["bootId"]==*boot_id {"process_exited"} else {"boot_changed"},
                    "children":children,"observedAt":now(),"journalDigest":db::digest(&entry_body.to_string())});
                stop["signature"] = key.sign(&crate::tasks::device_stop_body(&stop))?.into();
                body["state"] = "not_sent".into();
                body["effectStatus"] = "none".into();
                body["noMarkerEvidence"] = json!({"entry":entry,"signature":entry_signature});
                body["stopEvidence"] = stop;
                if db::canonical(&body).len() > LIMIT {
                    return Err(fail(
                        413,
                        "stop_evidence_too_large",
                        "Stop evidence exceeds the limit.",
                    ));
                }
                tx.execute("UPDATE device_journal SET state='not_sent',effect_status='none',entry_signature=?,journal_sequence=? WHERE action_id=?",
                    params![entry_signature,sequence,action])?;
            }
            body
        };
        save_report(&tx, &task, &action, &report)?;
        tx.commit()?;
        Ok(report)
    }

    pub(super) async fn reconcile(
        &mut self,
        token: &str,
        row: &Value,
        saved: &Value,
        runner: &str,
        timeout: Duration,
    ) -> Result<()> {
        let task = id(&row["task_id"])?;
        let action = id(&row["action_id"])?;
        let prior = row["state"].clone();
        if row["action_kind"] == "canonical"
            && row["send_marker"] == 1
            && row["result_json"].is_null()
        {
            self.replay_canonical(token, runner, &task, row, saved, timeout)
                .await?;
        }
        let current = latest_row(&self.db, &action)?;
        let report = self.recovery_report(&current, saved)?;
        if report.to_string().len() > RESULT_LIMIT {
            return Err(fail(
                413,
                "result_too_large",
                "Result remains saved locally; publication exceeds the limit.",
            ));
        }
        let path = format!("/api/tasks/{task}/reconcile");
        let mut reply = self
            .post_path(&path, token, &report, Some(runner), LIMIT, timeout)
            .await;
        if reply
            .as_ref()
            .is_err_and(|err| err.code == "ownership_conflict")
            && (prior == "prepared" || current["state"] == "not_sent")
        {
            let prepare = self.prepare_body(&current, saved)?;
            self.post_path(
                &format!("/api/tasks/{task}/actions/{action}/prepare"),
                token,
                &prepare,
                Some(runner),
                LIMIT,
                timeout,
            )
            .await?;
            reply = self
                .post_path(&path, token, &report, Some(runner), LIMIT, timeout)
                .await;
        }
        let receipt = &reply?["receipt"];
        if row["action_kind"] == "canonical" {
            self.checkpoint("tool-report").await;
        }
        if row["action_kind"] == "provider" {
            self.checkpoint("provider-report-reply").await;
        }
        self.acknowledge(&action, saved, &report, receipt)
    }

    pub(super) fn acknowledge(
        &self,
        action: &str,
        saved: &Value,
        report: &Value,
        receipt: &Value,
    ) -> Result<()> {
        let outbox = one(
            &self.db,
            "SELECT report_digest,receipt_json FROM device_outbox WHERE action_id=?",
            [action],
        )?
        .ok_or_else(receipt_mismatch)?;
        if !self.own_receipt(receipt)
            || receipt["requestId"] != report["requestId"]
            || receipt["recordId"] != action
            || receipt["projectId"] != saved["context"]["snapshot"]["projectId"]
            || receipt["payloadDigest"] != outbox["report_digest"]
            || receipt["status"] != 200
            || revision(&receipt["recordRevision"], 1).is_err()
            || revision(&receipt["committedAt"], 0).is_err()
        {
            return Err(receipt_mismatch());
        }
        let encoded = db::canonical(receipt);
        if !outbox["receipt_json"].is_null() && outbox["receipt_json"] != encoded {
            return Err(receipt_mismatch());
        }
        let tx = self.db.unchecked_transaction()?;
        tx.execute(
            "UPDATE device_outbox SET state='acknowledged',receipt_json=? WHERE action_id=?",
            params![encoded, action],
        )?;
        tx.execute(
            "UPDATE device_journal SET state='acknowledged' WHERE action_id=? AND state='reported'",
            [action],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub(super) async fn complete_recovered(
        &mut self,
        token: &str,
        row: &Value,
        mut saved: Value,
        runner: &str,
        recover: bool,
    ) -> Result<()> {
        let task = id(&row["task_id"])?;
        let action = id(&row["action_id"])?;
        let request = id(&saved["completeRequestId"])?;
        let command = json!({"requestId":request,"actionId":action,"ownership":saved["ownership"]});
        let response = self
            .post_path(
                &format!("/api/tasks/{task}/complete"),
                token,
                &command,
                Some(runner),
                LIMIT,
                if recover { RECOVERY_TIMEOUT } else { TIMEOUT },
            )
            .await;
        match response {
            Ok(response) => {
                self.checkpoint("completion-reply").await;
                let data = &response["data"];
                let receipt = &response["receipt"];
                if !self.own_receipt(receipt)
                    || receipt["requestId"] != request
                    || receipt["recordId"] != task
                    || receipt["projectId"] != saved["context"]["snapshot"]["projectId"]
                    || receipt["recordRevision"] != data["revision"]
                    || receipt["payloadDigest"]
                        != digest(&json!([
                            "briefsip-task-complete-v1",
                            task,
                            action,
                            saved["ownership"]
                        ]))
                    || receipt["status"] != 200
                    || data["state"] != "completed"
                    || data["taskId"] != task
                    || data["actionId"] != action
                    || data["resultRef"] != result_ref(row)
                {
                    return Err(receipt_mismatch());
                }
                if saved
                    .get("completionReceipt")
                    .is_some_and(|previous| previous != receipt)
                {
                    return Err(receipt_mismatch());
                }
                saved["completionReceipt"] = receipt.clone();
            }
            Err(err) if recover && !err.retryable && err.status != 401 => {
                saved["completionError"] = err.code.into();
            }
            Err(err) => return Err(err),
        }
        self.db.execute(
            "UPDATE device_journal SET intent_json=? WHERE action_id=?",
            params![db::canonical(&saved), action],
        )?;
        Ok(())
    }

    pub(super) async fn recover_journal(&mut self, token: &str) -> Result<()> {
        let pending = rows(&self.db, "SELECT j.* FROM device_journal j LEFT JOIN device_outbox o ON o.action_id=j.action_id
            WHERE (j.state<>'acknowledged' AND (o.state IS NULL OR o.state<>'acknowledged')) OR
            (j.state='acknowledged' AND j.action_kind='provider' AND json_extract(j.intent_json,'$.completeRequestId') IS NOT NULL
                AND json_extract(j.intent_json,'$.completionReceipt') IS NULL AND json_extract(j.intent_json,'$.completionError') IS NULL)
            ORDER BY j.journal_sequence LIMIT 40", [])?;
        if pending.is_empty() {
            return Ok(());
        }
        self.acquire_executor()?;
        let deadline = tokio::time::Instant::now() + RECOVERY_TIMEOUT;
        for row in pending {
            let result = tokio::time::timeout_at(deadline, async {
                let saved = intent(&row)?;
                let ownership = &saved["ownership"];
                let enrolled = self.identity.descriptor.as_ref().ok_or_else(missing)?;
                if ownership["taskId"] != row["task_id"]
                    || ownership["deviceGeneration"] != enrolled["deviceGeneration"]
                    || ownership["authorityGeneration"] != enrolled["authorityGeneration"]
                    || ownership["executorGeneration"] != row["executor_generation"]
                {
                    return Err(fail(
                        409,
                        "ownership_conflict",
                        "Journal evidence belongs to another enrollment.",
                    ));
                }
                let runner = self.executor_token(&id(&row["task_id"])?, &saved["ownership"])?;
                if row["state"] == "acknowledged" {
                    self.complete_recovered(token, &row, saved, &runner, true)
                        .await
                } else {
                    self.reconcile(token, &row, &saved, &runner, RECOVERY_TIMEOUT)
                        .await
                }
            })
            .await;
            match result {
                Ok(Ok(())) => {}
                Ok(Err(err)) => eprintln!("Device journal recovery deferred: {}", err.code),
                Err(_) => break,
            }
        }
        Ok(())
    }
}
