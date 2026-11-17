use super::*;
pub fn readable(db: &Connection, account: &str, task_id: &str) -> Result<Value> {
    let t = task(db, task_id)?;
    authority::member(db, account, string(&t, "project"), false)?;
    if !exists(db,"SELECT 1 FROM record_scopes WHERE table_name='turns' AND key_json=? AND project=? AND (visibility='project' OR account=?)",params![json!([t["logical_turn"]]).to_string(),string(&t,"project"),account])?{return Err(missing())}
    Ok(t)
}
fn questions(db: &Connection, turn: &str) -> Result<Vec<Value>> {
    let mut rows = all(
        db,
        "SELECT id,prompt,choices,answer FROM questions WHERE turn=? ORDER BY rowid",
        [turn],
    )?;
    for row in &mut rows {
        row["choices"] = data::json(&row["choices"])?;
    }
    Ok(rows)
}
fn result_ref(task: &str, action: &str, row: &Value) -> Value {
    json!({"v":1,"taskId":task,"actionId":action,"digest":row["digest"],"size":row["size"],"encoding":"canonical-json-v1"})
}
pub fn lookup(
    db: &Connection,
    account: &str,
    task_id: &str,
    q: &[(String, String)],
) -> Result<Value> {
    let after = data::param(q, "afterResultSequence")
        .map(|s| s.parse::<i64>())
        .transpose()
        .map_err(|_| fail(400, "invalid_cursor", "Invalid result cursor."))?
        .unwrap_or(-1);
    if after < -1 {
        return Err(fail(400, "invalid_cursor", "Invalid result cursor."));
    }
    let t = readable(db, account, task_id)?;
    let tail=one(db,"SELECT id FROM tasks t WHERE logical_turn=? AND NOT EXISTS(SELECT 1 FROM tasks n WHERE n.predecessor_task=t.id)",[string(&t,"logical_turn")])?.ok_or_else(Failure::storage)?;
    let rows=all(db,"SELECT a.id,a.sequence,r.digest,r.encoding,r.content_json,r.size FROM task_actions a JOIN task_results r ON r.action=a.id WHERE a.task=? AND a.sequence>? ORDER BY a.sequence LIMIT 41",params![task_id,after])?;
    let mut results = Vec::new();
    let mut size = 0;
    for row in rows.iter().take(40) {
        size += n(row, "size");
        let mut r = json!({"actionId":row["id"],"sequence":row["sequence"],"resultRef":result_ref(task_id,string(row,"id"),row)});
        if size <= 128 * 1024 {
            r["content"] = data::json(&row["content_json"])?;
        }
        results.push(r);
    }
    let receipt = one(
        db,
        "SELECT result_json FROM receipts WHERE request_id=?",
        [string(&t, "logical_turn")],
    )?
    .map(|r| data::json(&r["result_json"]))
    .transpose()?
    .ok_or_else(Failure::storage)?;
    let next = if rows.len() > 40 {
        results.last().map(|r| r["sequence"].clone())
    } else {
        None
    };
    Ok(
        json!({"status":200,"data":{"taskId":t["id"],"logicalTurnId":t["logical_turn"],"currentTaskId":tail["id"],"state":t["state"],"revision":t["revision"],"projectId":t["project"],"agentId":t["agent"],"homeDeviceId":t["home_device"],"payloadDigest":t["payload_digest"],"questions":questions(db,string(&t,"logical_turn"))?,"results":results,"nextResultSequence":next},"receipt":receipt["receipt"]}),
    )
}
pub fn result(
    db: &Connection,
    account: &str,
    task_id: &str,
    action: &str,
    q: &[(String, String)],
) -> Result<Value> {
    readable(db, account, task_id)?;
    let r = one(
        db,
        "SELECT digest,size,encoding,content_json FROM task_results WHERE task=? AND action=?",
        [task_id, action],
    )?
    .ok_or_else(|| fail(404, "resource_not_found", "Result not found."))?;
    let content = string(&r, "content_json");
    let offset = data::param(q, "offset")
        .map(str::parse::<usize>)
        .transpose()
        .map_err(|_| fail(400, "invalid_cursor", "Invalid result offset."))?
        .unwrap_or(0);
    let utf16 = content.encode_utf16().collect::<Vec<_>>();
    if offset > utf16.len() {
        return Err(fail(400, "invalid_cursor", "Invalid result offset."));
    }
    let end = offset.saturating_add(8000).min(utf16.len());
    Ok(
        json!({"read":{"resultRef":result_ref(task_id,action,&r),"chunk":content,"nextOffset":if end<utf16.len(){Some(end)}else{None}},"offset":offset}),
    )
}
pub fn control(
    db: &Connection,
    account: &str,
    task_id: &str,
    v: &Value,
    now: i64,
) -> Result<Value> {
    fields(
        v,
        &[
            "requestId",
            "expectedRevision",
            "operation",
            "recipientAgentId",
            "decision",
        ],
    )?;
    let request = id(&v["requestId"])?;
    let expected = revision(&v["expectedRevision"], 1)?;
    let op = string(v, "operation");
    if !["pause", "resume", "cancel", "reassign", "resolve_uncertain"].contains(&op) {
        return Err(fail(400, "invalid_control", "Invalid control operation."));
    }
    if op != "resolve_uncertain" && v.get("decision").is_some() {
        return Err(fail(
            400,
            "decision_forbidden",
            "Decision is only allowed for resolve_uncertain.",
        ));
    }
    if op != "reassign" && v.get("recipientAgentId").is_some() {
        return Err(fail(
            400,
            "recipient_forbidden",
            "recipientAgentId is only allowed for reassign.",
        ));
    }
    let mut payload = json!([
        "briefsip-task-control-v1",
        task_id,
        request,
        expected,
        op,
        v["decision"]
    ]);
    if op == "reassign" {
        let recipient = id(&v["recipientAgentId"])?;
        payload
            .as_array_mut()
            .ok_or_else(Failure::storage)?
            .push(json!(recipient));
    }
    let pd = digest(&payload);
    let task = if op == "resolve_uncertain" {
        let t = task(db, task_id)?;
        authority::member(db, account, string(&t, "project"), true)?;
        t
    } else {
        let t = readable(db, account, task_id)?;
        let m = authority::member(db, account, string(&t, "project"), false)?;
        authority::assignment(db, account, string(&t, "project"), string(&t, "agent"), &m)?;
        t
    };
    let scope = format!("tasks:control:{task_id}");
    if let Some(old) = replay(
        db,
        account,
        string(&task, "project"),
        &request,
        &scope,
        &pd,
        false,
    )? {
        return Ok(old);
    }
    if task["state"] == "transferred" {
        let mut e = fail(409, "task_transferred", "Task was moved.");
        e.details = one(
            db,
            "SELECT id AS successorTaskId FROM tasks WHERE predecessor_task=?",
            [task_id],
        )?;
        return Err(e);
    }
    if n(&task, "revision") != expected {
        return Err(stale());
    }
    if terminal(&task) {
        return Err(fail(409, "task_terminal", "Task has ended."));
    }
    if ["resume", "reassign"].contains(&op) {
        if exists(
            db,
            "SELECT 1 FROM questions WHERE turn=? AND answer IS NULL",
            [string(&task, "logical_turn")],
        )? {
            return Err(fail(
                409,
                "question_pending",
                "Answer the task question before resuming or reassigning.",
            ));
        }
        if data::table(db,"turn_waits")?&&exists(db,"SELECT 1 FROM turn_waits WHERE turn=? AND status='waiting'",[string(&task,"logical_turn")])?||exists(db,"SELECT 1 FROM wait_provisions WHERE state='pending' AND json_extract(request_json,'$.provision.target.taskId')=?",[task_id])?{return Err(fail(409,"event_pending","Complete or cancel the event wait before resuming or reassigning."))}
    }
    let mut state = string(&task, "state").to_owned();
    let mut replacement = None;
    let mut resolution = None;
    let mut successor = None;
    match op {
        "pause" => {
            if state != "uncertain" {
                state = "paused".into()
            }
        }
        "resume" => {
            if !["paused", "waiting_device", "waiting_resource"].contains(&state.as_str()) {
                return Err(fail(409, "task_not_paused", "Task is not paused."));
            }
            state = "running".into()
        }
        "cancel" => state = "cancelled".into(),
        "reassign" => {
            successor = Some(transfer(
                db,
                &task,
                &id(&v["recipientAgentId"])?,
                None,
                now,
            )?);
            state = "transferred".into()
        }
        _ => {
            let d = &v["decision"];
            fields(
                d,
                &[
                    "kind",
                    "actionId",
                    "evidenceRequestId",
                    "resultRef",
                    "acknowledgement",
                    "reason",
                ],
            )?;
            let kind = string(d, "kind");
            let action_id = id(&d["actionId"])?;
            if !["known_result", "not_sent", "retry_with_risk"].contains(&kind) {
                return Err(fail(400, "invalid_resolution", "Invalid resolution."));
            }
            if exists(
                db,
                "SELECT 1 FROM task_action_resolutions WHERE action=? AND task=?",
                [&action_id, task_id],
            )? {
                return Err(fail(
                    409,
                    "resolution_conflict",
                    "Action uncertainty was already resolved.",
                ));
            }
            let a = one(
                db,
                "SELECT * FROM task_actions WHERE id=? AND task=?",
                [&action_id, task_id],
            )?
            .ok_or_else(|| {
                fail(
                    409,
                    "resolution_conflict",
                    "Action uncertainty cannot be resolved.",
                )
            })?;
            if state != "uncertain"
                || !["uncertain", "acknowledged", "reported", "not_sent"]
                    .contains(&string(&a, "state"))
            {
                return Err(fail(
                    409,
                    "resolution_conflict",
                    "Action uncertainty cannot be resolved.",
                ));
            }
            if kind == "known_result" {
                fields(d, &["kind", "actionId", "evidenceRequestId", "resultRef"])?;
                let evidence = id(&d["evidenceRequestId"])?;
                let row=one(db,"SELECT result_json,scope,project FROM receipts WHERE request_id=? AND scope IN(?,?)",params![evidence,format!("tasks:reconcile:{task_id}"),format!("tasks:recovery-results:{task_id}")])?.ok_or_else(||fail(409,"evidence_invalid","Result evidence is unavailable."))?;
                let saved = data::json(&row["result_json"])?;
                let r = &saved["data"]["resultRef"];
                if row["project"] != task["project"]
                    || r["taskId"] != task_id
                    || r["actionId"] != action_id
                    || *r != d["resultRef"]
                    || !exists(
                        db,
                        "SELECT 1 FROM task_results WHERE action=? AND task=? AND digest=?",
                        [action_id.as_str(), task_id, string(r, "digest")],
                    )?
                {
                    return Err(fail(
                        409,
                        "evidence_invalid",
                        "Result evidence is unavailable.",
                    ));
                }
                db.execute("UPDATE task_actions SET state='acknowledged',effect_status='known',uncertain_reason=NULL WHERE id=?",[&action_id])?;
            } else if kind == "not_sent" {
                fields(d, &["kind", "actionId", "evidenceRequestId"])?;
                let evidence = id(&d["evidenceRequestId"])?;
                if a["state"] != "not_sent" || a["effect_status"] != "none" {
                    return Err(fail(
                        409,
                        "resolution_conflict",
                        "Action already has a result or uncertain effects.",
                    ));
                }
                if !exists(db,"SELECT 1 FROM task_reports WHERE action=? AND receipt_id=? AND json_extract(payload_json,'$.state')='not_sent' AND json_extract(payload_json,'$.effectStatus')='none'",[&action_id,&evidence])?{return Err(fail(409,"evidence_invalid","not_sent evidence is unavailable."))}
                replacement = Some(request.clone());
            } else {
                fields(d, &["kind", "actionId", "acknowledgement", "reason"])?;
                if a["state"] != "uncertain" || a["effect_status"] != "unknown" {
                    return Err(fail(
                        409,
                        "resolution_conflict",
                        "Retry with risk only applies to uncertain effects.",
                    ));
                }
                if d["acknowledgement"] != "effect_may_have_happened"
                    || !d["reason"].as_str().is_some_and(|s| {
                        !s.trim().is_empty()
                            && s.encode_utf16().count() <= 1000
                            && !s.chars().any(|c| c < ' ' || c == '\u{7f}')
                    })
                {
                    return Err(fail(
                        400,
                        "resolution_reason_required",
                        "Retry with risk requires a reason.",
                    ));
                }
                replacement = Some(request.clone());
            }
            resolution = Some((
                action_id,
                kind.to_owned(),
                d["evidenceRequestId"].as_str().map(str::to_owned),
            ));
            state = if exists(
                db,
                "SELECT 1 FROM turns WHERE id=? AND paused=1",
                [string(&task, "logical_turn")],
            )? {
                "paused"
            } else {
                "running"
            }
            .into();
        }
    }
    let rev = n(&task, "revision") + 1;
    let mut data = json!({"taskId":task_id,"state":state,"revision":rev});
    if let Some(r) = &replacement {
        data["replacementActionId"] = json!(r);
    }
    if op == "resolve_uncertain" {
        data["resolution"] = v["decision"]["kind"].clone();
    }
    if let Some(successor) = successor {
        for (k, v) in successor.as_object().ok_or_else(Failure::storage)? {
            data[k] = v.clone();
        }
    }
    let result = Save {
        account,
        task: &task,
        request: &request,
        scope: &scope,
        payload: &pd,
        now,
    }
    .save(db, task_id, rev, 200, data, Some(v))?;
    if let Some((action, kind, evidence)) = resolution {
        db.execute(
            "INSERT INTO task_action_resolutions VALUES(?,?,?,?,?,?,?,?)",
            params![
                action,
                task_id,
                request,
                account,
                kind,
                evidence,
                replacement,
                now
            ],
        )?;
    }
    db.execute(
        "UPDATE tasks SET state=?,revision=? WHERE id=?",
        params![state, rev, task_id],
    )?;
    observe(db, &task, now)?;
    if ["pause", "resume"].contains(&op) {
        db.execute(
            "UPDATE turns SET paused=?,revision=revision+1 WHERE id=?",
            params![i64::from(op == "pause"), string(&task, "logical_turn")],
        )?;
    }
    if op == "cancel" {
        cancel(db, &task, now)?;
    }
    Ok(result)
}
fn cancel(db: &Connection, task: &Value, now: i64) -> Result<()> {
    let ids=all(db,"WITH RECURSIVE t(id) AS(SELECT ? UNION SELECT x.id FROM turns x JOIN t ON x.parent=t.id) SELECT id FROM t",[string(task,"logical_turn")])?;
    for row in ids {
        let id = string(&row, "id");
        db.execute("UPDATE turns SET status='cancelled',paused=0,error=NULL,revision=revision+1 WHERE id=? AND status NOT IN('done','failed','cancelled')",[id])?;
        db.execute("UPDATE tasks SET state='cancelled',revision=revision+1 WHERE logical_turn=? AND state NOT IN('completed','failed','cancelled','transferred')",[id])?;
        db.execute("UPDATE execution_owners SET stopped=1,last_seen=? WHERE task IN(SELECT id FROM tasks WHERE logical_turn=?)",params![now,id])?;
    }
    Ok(())
}
pub fn transfer(
    db: &Connection,
    task: &Value,
    recipient: &str,
    instruction: Option<&str>,
    now: i64,
) -> Result<Value> {
    if task["agent"] == recipient {
        return Err(fail(
            409,
            "recipient_invalid",
            "Recipient must be a different agent.",
        ));
    }
    if task["state"] != "paused" {
        return Err(fail(
            409,
            "task_not_paused",
            "Pause the task before reassigning.",
        ));
    }
    if authority::unresolved(db, string(task, "id"))? {
        return Err(fail(
            409,
            "outcome_unresolved",
            "Previous action is not reconciled yet.",
        ));
    }
    authority::dispatch(db, task)?;
    let recipient_row=one(db,"SELECT h.home_device FROM agent_authority h JOIN agent_projects p ON p.agent=h.agent WHERE p.project=? AND p.agent=? AND p.deleted=0",[string(task,"project"),recipient])?.ok_or_else(||fail(404,"resource_not_found","Recipient not found."))?;
    let mut candidate = task.clone();
    candidate["agent"] = json!(recipient);
    candidate["home_device"] = recipient_row["home_device"].clone();
    candidate["predecessor_task"] = task["id"].clone();
    let current = authority::dispatch(db, &candidate)?;
    let device=one(db,"SELECT d.* FROM devices d JOIN installations i ON i.id=d.installation WHERE d.id=? AND d.account=? AND i.account=d.account AND i.revoked=0 AND d.status NOT IN('blocked','revoked')",[string(&recipient_row,"home_device"),string(&current["member"],"account")])?.ok_or_else(||fail(404,"resource_not_found","Recipient home device is unavailable."))?;
    if !data::json(&device["capabilities_json"])?
        .as_array()
        .is_some_and(|c| c.contains(&json!("execution")))
    {
        return Err(fail(
            422,
            "capability_missing",
            "Recipient home device does not support execution.",
        ));
    }
    let binding = if current["participation"]["provider_binding"].is_null() {
        None
    } else {
        one(db,"SELECT * FROM provider_bindings WHERE id=? AND device=? AND owner_account=? AND readiness='ready'",[string(&current["participation"],"provider_binding"),string(&recipient_row,"home_device"),string(&current["member"],"account")])?
    };
    if !current["participation"]["provider_binding"].is_null() && binding.is_none()
        || !task["provider_binding_owner"].is_null()
            && binding
                .as_ref()
                .is_none_or(|b| b["owner_account"] != task["provider_binding_owner"])
    {
        return Err(fail(
            409,
            "binding_stale",
            "Recipient provider is not ready yet or owner changed.",
        ));
    }
    if db.query_row(
        "SELECT count(*) FROM tasks WHERE logical_turn=?",
        [string(task, "logical_turn")],
        |r| r.get::<_, i64>(0),
    )? >= 9
    {
        return Err(fail(409, "transfer_limit", "Transfer limit reached."));
    }
    let task_id = uuid::Uuid::new_v4().to_string();
    let cap = data::json(&current["participation"]["capabilities_json"])?;
    let mut payload = data::json(&task["payload_json"])?;
    if let Some(instruction) = instruction {
        payload["message"]["text"] = json!(instruction);
    }
    let pd = digest(&json!([
        "briefsip-task-transfer-v1",
        task["id"],
        task_id,
        recipient,
        device["id"],
        payload,
        current["sourceRevisions"]
    ]));
    let state = if device["status"] == "ready" {
        "queued"
    } else {
        "waiting_device"
    };
    db.execute(
        "UPDATE tasks SET state='transferred',revision=revision+1 WHERE id=?",
        [string(task, "id")],
    )?;
    data::limits::task_capacity(db, string(task, "project"), recipient)?;
    db.execute(
        "UPDATE execution_owners SET stopped=1 WHERE task=?",
        [string(task, "id")],
    )?;
    db.execute("INSERT INTO tasks(id,logical_turn,predecessor_task,project,agent,initiator_account,home_device,assignment_revision,capability_revision,capability_digest,capability_snapshot_json,provider_binding_id,provider_binding_revision,provider_binding_owner,state,payload_digest,payload_json,revision,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)",params![task_id,string(task,"logical_turn"),string(task,"id"),string(task,"project"),recipient,string(task,"initiator_account"),string(&device,"id"),n(&current,"assignment"),n(&current["participation"],"capability_revision"),digest(&json!(["briefsip-capabilities-v1",cap])),canonical(&cap),binding.as_ref().and_then(|b|b["id"].as_str()),binding.as_ref().map(|b|n(b,"revision")),binding.as_ref().and_then(|b|b["owner_account"].as_str()),state,pd,canonical(&payload),now])?;
    observe(db, &super::task(db, &task_id)?, now)?;
    db.execute("UPDATE turns SET agent=?,recipient=CASE WHEN channel IS NULL THEN NULL ELSE ? END,routing='assigned',status='queued',paused=0,revision=revision+1,error=NULL WHERE id=?",[recipient,recipient,string(task,"logical_turn")])?;
    Ok(
        json!({"logicalTurnId":task["logical_turn"],"previousTaskId":task["id"],"taskId":task_id,"homeDeviceId":device["id"],"state":state,"revision":1}),
    )
}
pub fn answer(
    db: &Connection,
    account: &str,
    task_id: &str,
    question_id: &str,
    v: &Value,
    now: i64,
) -> Result<Value> {
    fields(
        v,
        &[
            "requestId",
            "expectedRevision",
            "text",
            "acknowledgeUncertain",
        ],
    )?;
    let request = id(&v["requestId"])?;
    revision(&v["expectedRevision"], 1)?;
    let input_text = v["text"]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 4000)
        .ok_or_else(|| {
            fail(
                400,
                "invalid_question_answer",
                "Invalid answer or answer does not match the choices.",
            )
        })?;
    let answer = input_text.trim().to_owned();
    let ack = v
        .get("acknowledgeUncertain")
        .cloned()
        .unwrap_or(json!(false));
    if !ack.is_boolean() {
        return Err(fail(
            400,
            "invalid_question_answer",
            "Invalid answer or answer does not match the choices.",
        ));
    }
    let pd = digest(&json!([
        "briefsip-question-answer-v1",
        task_id,
        question_id,
        request,
        v["expectedRevision"],
        input_text,
        ack
    ]));
    let t = readable(db, account, task_id)?;
    let m = authority::member(db, account, string(&t, "project"), false)?;
    authority::assignment(db, account, string(&t, "project"), string(&t, "agent"), &m)?;
    let question = one(
        db,
        "SELECT * FROM questions WHERE id=? AND turn=?",
        [question_id, string(&t, "logical_turn")],
    )?
    .ok_or_else(|| fail(404, "resource_not_found", "Question not found."))?;
    let scope = format!("tasks:answer:{task_id}:{question_id}");
    if let Some(old) = replay(
        db,
        account,
        string(&t, "project"),
        &request,
        &scope,
        &pd,
        false,
    )? {
        return Ok(old);
    }
    if t["revision"] != v["expectedRevision"] {
        return Err(stale());
    }
    if t["state"] != "paused"
        || !question["answer"].is_null()
        || !exists(
            db,
            "SELECT 1 FROM turns WHERE id=? AND paused=1",
            [string(&t, "logical_turn")],
        )?
    {
        return Err(fail(
            409,
            "question_closed",
            "Question was already answered or task stopped.",
        ));
    }
    authority::dispatch(db, &t)?;
    let choices = data::json(&question["choices"])?;
    if choices
        .as_array()
        .is_some_and(|c| !c.is_empty() && !c.contains(&json!(answer)))
    {
        return Err(fail(
            400,
            "invalid_question_answer",
            "Choose one of the available answers.",
        ));
    }
    let state = if exists(
        db,
        "SELECT 1 FROM devices WHERE id=? AND status='ready'",
        [string(&t, "home_device")],
    )? {
        "running"
    } else {
        "waiting_device"
    };
    db.execute(
        "UPDATE questions SET answer=? WHERE id=?",
        [&answer, question_id],
    )?;
    db.execute(
        "UPDATE turns SET status='queued',paused=0,revision=revision+1,error=NULL WHERE id=?",
        [string(&t, "logical_turn")],
    )?;
    db.execute(
        "UPDATE tasks SET state=?,revision=revision+1 WHERE id=?",
        [state, task_id],
    )?;
    observe(db, &t, now)?;
    let result = Save{account,task:&t,request:&request,scope:&scope,payload:&pd,now}.save(db,question_id,n(&t,"revision")+1,200,json!({"id":question_id,"answer":answer,"taskId":task_id,"state":state,"revision":n(&t,"revision")+1}),None)?;
    db.execute("INSERT INTO question_answers VALUES(?,?,?)",params![request,canonical(&json!({"taskId":task_id,"questionId":question_id,"actorId":account,"projectId":t["project"],"id":request,"text":input_text,"acknowledgeUncertain":ack,"expectedRevision":v["expectedRevision"]})),canonical(&result["data"])])?;
    let root = sources::root(db, &t)?;
    let payload = data::json(&t["payload_json"])?;
    db.execute(
        "INSERT INTO record_scopes VALUES('question_answers',?,?,?,?,?,?)",
        params![
            json!([request]).to_string(),
            account,
            string(&t, "project"),
            if payload["kind"] == "channel" {
                "project"
            } else {
                "owner"
            },
            string(&root, "root_kind"),
            string(&root, "root_id")
        ],
    )?;
    Ok(result)
}
