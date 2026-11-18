use super::*;
use subtle::ConstantTimeEq;
pub fn acquire(db: &Connection, p: &Principal, v: &Value, token: &str, now: i64) -> Result<Value> {
    fields(
        v,
        &[
            "requestId",
            "taskId",
            "previousExecutorGeneration",
            "executorTokenHash",
            "lockProof",
        ],
    )?;
    let request = id(&v["requestId"])?;
    let task_id = id(&v["taskId"])?;
    let previous = revision(&v["previousExecutorGeneration"], 0)?;
    let th = hex(&v["executorTokenHash"], "executorTokenHash")?;
    if token.len() != 43
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        || !bool::from(hash(token).as_bytes().ct_eq(th.as_bytes()))
    {
        return Err(fail(401, "executor_invalid", "Invalid executor token."));
    }
    let proof = &v["lockProof"];
    fields(
        proof,
        &[
            "bootId",
            "processId",
            "processStart",
            "lockId",
            "previousOwnerStopped",
            "reconciledThrough",
            "journalDigest",
        ],
    )?;
    let boot = id(&proof["bootId"])?;
    let lock = id(&proof["lockId"])?;
    let journal = hex(&proof["journalDigest"], "journalDigest")?;
    if !data::integer(&proof["processId"], 1, 9007199254740991)
        || !proof["processStart"].as_str().is_some_and(|s| {
            !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit())
        })
        || !proof["previousOwnerStopped"].is_boolean()
    {
        return Err(fail(400, "invalid_lock_proof", "Invalid lock proof."));
    }
    let reconciled = revision(&proof["reconciledThrough"], 0)?;
    let proof = json!({"bootId":boot,"processId":proof["processId"],"processStart":proof["processStart"],"lockId":lock,"previousOwnerStopped":proof["previousOwnerStopped"],"reconciledThrough":reconciled,"journalDigest":journal});
    let pd = digest(&json!([
        "briefsip-acquire-v1",
        request,
        task_id,
        previous,
        th,
        proof
    ]));
    devices::current(db, p, now)?;
    let task = task(db, &task_id)?;
    if task["home_device"] != p.device {
        return Err(missing());
    }
    authority::dispatch(db, &task)?;
    let scope = format!("tasks:acquire:{task_id}");
    if let Some(old) = replay(
        db,
        &p.account,
        string(&task, "project"),
        &request,
        &scope,
        &pd,
        false,
    )? {
        return Ok(old);
    }
    let current = one(
        db,
        "SELECT * FROM execution_owners WHERE task=?",
        [&task_id],
    )?;
    if proof["previousOwnerStopped"] != true
        || current.as_ref().is_some_and(|c| {
            previous != n(c, "executor_generation")
                || data::json(&c["lock_proof_json"]).is_ok_and(|p| p["lockId"] == lock)
                || reconciled != n(c, "reconciled_through")
        })
        || current.is_none() && previous != 0
    {
        return Err(fail(
            409,
            "ownership_conflict",
            "Previous executor is not reconciled yet.",
        ));
    }
    if terminal(&task) {
        return Err(fail(409, "task_terminal", "Task has ended."));
    }
    if authority::unresolved(db, &task_id)? {
        return Err(fail(
            409,
            "ownership_conflict",
            "Action result is not reconciled yet.",
        ));
    }
    let generation = current
        .as_ref()
        .map(|c| n(c, "executor_generation"))
        .unwrap_or(0)
        + 1;
    let ownership = json!({"authorityGeneration":p.authority,"deviceGeneration":p.generation,"taskId":task_id,"executorGeneration":generation});
    db.execute("INSERT INTO execution_owners VALUES(?,?,?,?,?,?,?,?,?,0) ON CONFLICT(task) DO UPDATE SET device=excluded.device,authority_generation=excluded.authority_generation,device_generation=excluded.device_generation,executor_generation=excluded.executor_generation,token_hash=excluded.token_hash,lock_proof_json=excluded.lock_proof_json,reconciled_through=excluded.reconciled_through,last_seen=excluded.last_seen,stopped=0",params![task_id,p.device,p.authority,p.generation,generation,th,canonical(&proof),reconciled,now])?;
    db.execute("UPDATE tasks SET state=CASE WHEN state IN('queued','waiting_device','waiting_resource') THEN 'running' ELSE state END,revision=revision+1 WHERE id=?",[&task_id])?;
    observe(db, &task, now)?;
    Save {
        account: &p.account,
        task: &task,
        request: &request,
        scope: &scope,
        payload: &pd,
        now,
    }
    .save(
        db,
        &task_id,
        n(&task, "revision") + 1,
        200,
        json!({"ownership":ownership,"taskId":task_id,"revision":n(&task,"revision")+1}),
        None,
    )
}
fn prepared(db: &Connection, task: &str, action: &str) -> Result<Value> {
    one(db,"SELECT result_json FROM receipts WHERE scope=? AND json_extract(result_json,'$.receipt.recordId')=?",[format!("tasks:prepare:{task}"),action.to_owned()])?.map(|r|data::json(&r["result_json"])).transpose()?.ok_or_else(||fail(409,"action_conflict","Prepare receipt not found."))
}
pub fn prepare(
    db: &Connection,
    p: &Principal,
    task_id: &str,
    action_id: &str,
    v: &Value,
    token: &str,
    now: i64,
) -> Result<Value> {
    fields(
        v,
        &[
            "requestId",
            "sequence",
            "ownership",
            "payloadDigest",
            "actionKind",
            "contextSnapshotId",
            "contextDigest",
            "grantRevision",
            "expectedTaskRevision",
            "bindingId",
            "bindingRevision",
            "intentDigest",
            "journalSequence",
            "resourceIntent",
            "mcpIntent",
            "resolutionRequestId",
        ],
    )?;
    if v.get("resourceIntent").is_some()
        || v.get("mcpIntent").is_some()
        || v["actionKind"] == "resource"
    {
        return Err(fail(
            422,
            "capability_missing",
            "Action capability is not available yet.",
        ));
    }
    let request = id(&v["requestId"])?;
    revision(&v["sequence"], 0)?;
    authority::ownership(&v["ownership"])?;
    hex(&v["payloadDigest"], "payloadDigest")?;
    id(&v["contextSnapshotId"])?;
    hex(&v["contextDigest"], "contextDigest")?;
    revision(&v["grantRevision"], 1)?;
    revision(&v["expectedTaskRevision"], 1)?;
    let intent = hex(&v["intentDigest"], "intentDigest")?;
    revision(&v["journalSequence"], 1)?;
    let kind = string(v, "actionKind");
    if ![
        "provider",
        "canonical",
        "read",
        "compute",
        "local",
        "browser",
    ]
    .contains(&kind)
    {
        return Err(fail(400, "invalid_action_kind", "Invalid action type."));
    }
    if kind == "provider" {
        if v.get("bindingId").is_none() || v.get("bindingRevision").is_none() {
            return Err(fail(
                400,
                "binding_required",
                "Provider action requires a binding.",
            ));
        }
        id(&v["bindingId"])?;
        revision(&v["bindingRevision"], 1)?;
    } else if v.get("bindingId").is_some() || v.get("bindingRevision").is_some() {
        return Err(fail(
            400,
            "binding_forbidden",
            "Binding is only allowed for provider actions.",
        ));
    }
    if let Some(r) = v.get("resolutionRequestId") {
        id(r)?;
    }
    let command = json!({"requestId":request,"sequence":v["sequence"],"ownership":v["ownership"],"payloadDigest":v["payloadDigest"],"actionKind":kind,"contextSnapshotId":v["contextSnapshotId"],"contextDigest":v["contextDigest"],"grantRevision":v["grantRevision"],"expectedTaskRevision":v["expectedTaskRevision"],"bindingId":v["bindingId"],"bindingRevision":v["bindingRevision"],"intentDigest":intent,"journalSequence":v["journalSequence"],"resolutionRequestId":v["resolutionRequestId"]});
    if intent
        != digest(&json!([
            task_id,
            action_id,
            command["sequence"],
            command["ownership"],
            command["payloadDigest"],
            kind,
            command["contextSnapshotId"],
            command["contextDigest"],
            command["bindingId"],
            command["bindingRevision"],
            command["grantRevision"],
            null,
            null,
            command["resolutionRequestId"]
        ]))
    {
        return Err(fail(
            409,
            "intent_digest_mismatch",
            "Intent digest does not match.",
        ));
    }
    let task = task(db, task_id)?;
    let owner = authority::owner(db, p, &task, &v["ownership"], token, false, now)?;
    let current = authority::dispatch(db, &task)?;
    let scope = format!("tasks:prepare:{task_id}");
    let pd = digest(&json!([
        "briefsip-action-prepare-v1",
        task_id,
        action_id,
        command
    ]));
    if let Some(old) = replay(
        db,
        &p.account,
        string(&task, "project"),
        &request,
        &scope,
        &pd,
        false,
    )? {
        return Ok(old);
    }
    authority::runnable(db, &task)?;
    if exists(
        db,
        "SELECT 1 FROM turns WHERE id=? AND profile_setup=1",
        [string(&task, "logical_turn")],
    )? && !matches!(kind, "provider" | "canonical")
    {
        return Err(fail(
            403,
            "execution_denied",
            "Agent setup can only call the provider and profile tools.",
        ));
    }
    if task["revision"] != v["expectedTaskRevision"] {
        return Err(stale());
    }
    if n(v, "journalSequence") <= n(&owner, "reconciled_through") {
        return Err(fail(
            409,
            "journal_conflict",
            "Journal sequence was already reconciled.",
        ));
    }
    if exists(
        db,
        "SELECT 1 FROM task_actions WHERE id=? OR (task=? AND sequence=?)",
        params![action_id, task_id, n(v, "sequence")],
    )? {
        return Err(fail(
            409,
            "action_conflict",
            "Action sequence was already used.",
        ));
    }
    if authority::unresolved(db, task_id)? {
        return Err(fail(
            409,
            "outcome_unresolved",
            "Previous action is not reconciled yet.",
        ));
    }
    let next: i64 = db.query_row(
        "SELECT coalesce(max(sequence),-1)+1 FROM task_actions WHERE task=?",
        [task_id],
        |r| r.get(0),
    )?;
    if next != n(v, "sequence") {
        return Err(fail(
            409,
            "action_conflict",
            "Action sequence is out of order.",
        ));
    }
    context::fresh(
        db,
        &task,
        &current,
        string(v, "contextSnapshotId"),
        string(v, "contextDigest"),
    )?;
    if current["assignment"] != v["grantRevision"] {
        return Err(fail(409, "stale_revision", "Assignment changed."));
    }
    if kind == "provider" {
        authority::binding(db, &task, &current, &v["bindingId"], &v["bindingRevision"])?;
    }
    let reserved=one(db,"SELECT r.* FROM task_action_resolutions r WHERE (r.replacement_action_id=? OR r.task=?) AND r.replacement_action_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM task_actions a WHERE a.id=r.replacement_action_id) LIMIT 1",[action_id,task_id])?;
    if reserved.as_ref().is_some_and(|r| {
        r["task"] != task_id
            || r["replacement_action_id"] != action_id
            || r["request_id"] != v["resolutionRequestId"]
    }) {
        return Err(fail(
            409,
            "resolution_conflict",
            "Replacement must use a reservation that has been decided.",
        ));
    }
    if v.get("resolutionRequestId").is_some() && reserved.is_none() {
        return Err(fail(
            409,
            "resolution_conflict",
            "Replacement reservation does not match.",
        ));
    }
    db.execute("INSERT INTO task_actions(id,task,sequence,action_kind,authority_generation,device_generation,executor_generation,intent_digest,context_snapshot_id,context_digest,binding_id,binding_revision,grant_revision,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared')",params![action_id,task_id,n(v,"sequence"),kind,p.authority,p.generation,n(&v["ownership"],"executorGeneration"),intent,string(v,"contextSnapshotId"),string(v,"contextDigest"),v["bindingId"].as_str(),v["bindingRevision"].as_i64(),n(v,"grantRevision")])?;
    Save {
        account: &p.account,
        task: &task,
        request: &request,
        scope: &scope,
        payload: &pd,
        now,
    }
    .save(
        db,
        action_id,
        n(&task, "revision"),
        200,
        json!({"taskId":task_id,"actionId":action_id,"sequence":v["sequence"],"state":"prepared"}),
        Some(&command),
    )
}
pub fn commit(
    db: &Connection,
    p: &Principal,
    task_id: &str,
    action_id: &str,
    v: &Value,
    token: &str,
    now: i64,
) -> Result<Value> {
    fields(
        v,
        &[
            "requestId",
            "ownership",
            "intentDigest",
            "expectedTaskRevision",
            "journalSequence",
        ],
    )?;
    let request = id(&v["requestId"])?;
    authority::ownership(&v["ownership"])?;
    hex(&v["intentDigest"], "intentDigest")?;
    revision(&v["expectedTaskRevision"], 1)?;
    revision(&v["journalSequence"], 0)?;
    let task = task(db, task_id)?;
    authority::owner(db, p, &task, &v["ownership"], token, false, now)?;
    let scope = format!("tasks:commit:{task_id}");
    let pd = digest(&json!(["briefsip-action-commit-v1", task_id, action_id, v]));
    if let Some(old) = replay(
        db,
        &p.account,
        string(&task, "project"),
        &request,
        &scope,
        &pd,
        false,
    )? {
        return Ok(old);
    }
    let action=one(db,"SELECT * FROM task_actions WHERE id=? AND task=? AND executor_generation=? AND authority_generation=? AND device_generation=? AND state='prepared'",params![action_id,task_id,n(&v["ownership"],"executorGeneration"),p.authority,p.generation])?.filter(|a|a["intent_digest"]==v["intentDigest"]).ok_or_else(||fail(409,"action_conflict","Action is not ready to commit."))?;
    authority::runnable(db, &task)?;
    let current = authority::dispatch(db, &task)?;
    if task["revision"] != v["expectedTaskRevision"] {
        return Err(stale());
    }
    context::fresh(
        db,
        &task,
        &current,
        string(&action, "context_snapshot_id"),
        string(&action, "context_digest"),
    )?;
    if !action["binding_id"].is_null() {
        authority::binding(
            db,
            &task,
            &current,
            &action["binding_id"],
            &action["binding_revision"],
        )?;
    }
    if prepared(db, task_id, action_id)?["input"]["journalSequence"] != v["journalSequence"] {
        return Err(fail(
            409,
            "journal_conflict",
            "Journal sequence differs from prepare.",
        ));
    }
    db.execute("UPDATE task_actions SET state='committed',committed_at=?,effect_status='unknown' WHERE id=?",params![now,action_id])?;
    db.execute(
        "UPDATE tasks SET state='running',revision=revision+1 WHERE id=?",
        [task_id],
    )?;
    observe(db, &task, now)?;
    let mut admission = json!({"v":1,"actionId":action_id,"taskId":task_id,"ownership":v["ownership"],"intentDigest":v["intentDigest"],"actionKind":action["action_kind"],"contextSnapshotId":action["context_snapshot_id"],"contextDigest":action["context_digest"],"grantRevision":action["grant_revision"],"committedAt":now,"oneUse":true});
    if !action["binding_id"].is_null() {
        admission["bindingId"] = action["binding_id"].clone();
        admission["bindingRevision"] = action["binding_revision"].clone();
    }
    let mut result=Save{account:&p.account,task:&task,request:&request,scope:&scope,payload:&pd,now}.save(db,action_id,n(&task,"revision")+1,200,json!({"actionId":action_id,"state":"committed","admission":admission,"dispatchable":false}),None)?;
    result["data"]["dispatchable"] = json!(true);
    Ok(result)
}
pub fn route(
    db: &Connection,
    p: &Principal,
    task_id: &str,
    op: &str,
    v: &Value,
    token: &str,
    now: i64,
) -> Result<Value> {
    let task = task(db, task_id)?;
    if op == "reconcile" {
        return reconcile(db, p, &task, v, token, now);
    }
    if op == "complete" {
        return complete(db, p, &task, v, token, now);
    }
    if op == "context-mutations" {
        return mutations::run(db, p, &task, v, token, now);
    }
    authority::owner(db, p, &task, &v["ownership"], token, op == "execution", now)?;
    authority::dispatch(db, &task)?;
    match op {
        "execution" => {
            fields(v, &["requestId", "ownership"])?;
            id(&v["requestId"])?;
            let next: i64 = db.query_row(
                "SELECT coalesce(max(sequence),-1)+1 FROM task_actions WHERE task=?",
                [task_id],
                |r| r.get(0),
            )?;
            let mut resolution=one(db,"SELECT r.action actionId,r.resolution kind,r.request_id requestId,r.replacement_action_id replacementActionId FROM task_action_resolutions r JOIN task_actions a ON a.id=r.action AND a.task=r.task WHERE r.task=? AND a.sequence=?",params![task_id,next-1])?;
            if let Some(saved) = resolution
                .as_mut()
                .filter(|saved| saved["kind"] == "known_result")
            {
                if let Some(result)=one(db,"SELECT r.content_json,p.journal_sequence FROM task_results r JOIN task_reports p ON p.action=r.action WHERE r.task=? AND r.action=?",[task_id,string(saved,"actionId")])? {
                    saved["result"]=data::json(&result["content_json"])?;
                    saved["journalSequence"]=result["journal_sequence"].clone();
                }
            }
            Ok(
                json!({"taskId":task_id,"state":task["state"],"revision":task["revision"],"nextSequence":next,"resolution":resolution}),
            )
        }
        "context" => context::snapshot(db, p, &task, v, now),
        "wait-provider" => {
            fields(v, &["requestId", "ownership", "expectedTaskRevision"])?;
            let request = id(&v["requestId"])?;
            revision(&v["expectedTaskRevision"], 1)?;
            let pd = digest(&json!(["briefsip-task-wait-provider-v1", task_id, v]));
            let scope = format!("tasks:wait-provider:{task_id}");
            if let Some(old) = replay(
                db,
                &p.account,
                string(&task, "project"),
                &request,
                &scope,
                &pd,
                false,
            )? {
                return Ok(old);
            }
            if task["revision"] != v["expectedTaskRevision"] {
                return Err(stale());
            }
            authority::runnable(db, &task)?;
            if !task["provider_binding_id"].is_null() {
                return Err(fail(
                    409,
                    "binding_available",
                    "Task has a provider binding.",
                ));
            }
            if authority::unresolved(db, task_id)? {
                return Err(fail(
                    409,
                    "outcome_unresolved",
                    "Previous action is not reconciled yet.",
                ));
            }
            db.execute(
                "UPDATE tasks SET state='waiting_resource',revision=revision+1 WHERE id=?",
                [task_id],
            )?;
            observe(db, &task, now)?;
            Save{account:&p.account,task:&task,request:&request,scope:&scope,payload:&pd,now}.save(db,task_id,n(&task,"revision")+1,200,json!({"taskId":task_id,"state":"waiting_resource","revision":n(&task,"revision")+1}),None)
        }
        _ => Err(missing()),
    }
}
fn reconcile(
    db: &Connection,
    p: &Principal,
    task: &Value,
    v: &Value,
    token: &str,
    now: i64,
) -> Result<Value> {
    fields(
        v,
        &[
            "requestId",
            "actionId",
            "ownership",
            "payloadDigest",
            "state",
            "resultDigest",
            "effectStatus",
            "journalSequence",
            "resultRef",
            "resultContent",
            "uncertainReason",
            "noMarkerEvidence",
            "stopEvidence",
        ],
    )?;
    let request = id(&v["requestId"])?;
    let action_id = id(&v["actionId"])?;
    let task_id = string(task, "id");
    authority::ownership(&v["ownership"])?;
    hex(&v["payloadDigest"], "payloadDigest")?;
    let sequence = revision(&v["journalSequence"], 0)?;
    let state = string(v, "state");
    let effect = string(v, "effectStatus");
    if ![
        "prepared",
        "committed",
        "in_flight",
        "reported",
        "acknowledged",
        "not_sent",
        "uncertain",
    ]
    .contains(&state)
    {
        return Err(fail(400, "invalid_action_state", "Invalid action state."));
    }
    if !["none", "known", "unknown"].contains(&effect) {
        return Err(fail(400, "invalid_effect_status", "Invalid effect status."));
    }
    let known = matches!(state, "reported" | "acknowledged");
    let encoded = v.get("resultContent").map(canonical);
    if encoded.as_ref().is_some_and(|r| r.len() > 8388608) {
        return Err(fail(413, "result_too_large", "Result exceeds the limit."));
    }
    if known {
        let r = &v["resultRef"];
        fields(
            r,
            &["v", "taskId", "actionId", "digest", "size", "encoding"],
        )?;
        if effect != "known"
            || encoded.is_none()
            || r["v"] != 1
            || r["taskId"] != task_id
            || r["actionId"] != action_id
            || r["encoding"] != "canonical-json-v1"
        {
            return Err(fail(
                400,
                "result_required",
                "Known result requires complete content and ref.",
            ));
        }
        let rd = hex(&v["resultDigest"], "resultDigest")?;
        hex(&r["digest"], "resultRef.digest")?;
        revision(&r["size"], 1)?;
        if encoded
            .as_ref()
            .is_some_and(|e| hash(e) != rd || e.len() as i64 != n(r, "size"))
            || r["digest"] != rd
        {
            return Err(fail(
                409,
                "result_digest_mismatch",
                "Result digest does not match.",
            ));
        }
    } else if ["resultDigest", "resultRef", "resultContent"]
        .iter()
        .any(|key| v.get(key).is_some())
    {
        return Err(fail(
            400,
            "result_forbidden",
            "Result is only allowed in the reported or acknowledged state.",
        ));
    }
    if state == "uncertain"
        && (effect != "unknown" || text(&v["uncertainReason"], 1000, "uncertainReason").is_err())
    {
        return Err(fail(
            400,
            "uncertain_reason_required",
            "Uncertain outcome requires a reason.",
        ));
    }
    let mut marker = Value::Null;
    let mut stop = Value::Null;
    if state == "not_sent" {
        if effect != "none"
            || v.get("noMarkerEvidence").is_none()
            || v.get("stopEvidence").is_none()
        {
            return Err(fail(
                422,
                "stop_evidence_required",
                "not_sent requires stop evidence and no marker.",
            ));
        }
        if canonical(v).len() > 65536 {
            return Err(fail(
                413,
                "payload_too_large",
                "Stop evidence exceeds the limit.",
            ));
        }
        marker = v["noMarkerEvidence"].clone();
        fields(&marker, &["entry", "signature"])?;
        let mut entry = marker["entry"].clone();
        if !entry.is_object() || !marker["signature"].is_string() {
            return Err(fail(
                400,
                "invalid_stop_evidence",
                "Invalid no-marker evidence.",
            ));
        }
        entry["signature"] = marker["signature"].clone();
        recovery::parse_entry(&entry)?;
        stop = v["stopEvidence"].clone();
        recovery::parse_stop(&stop)?;
    } else if v.get("noMarkerEvidence").is_some() || v.get("stopEvidence").is_some() {
        return Err(fail(
            400,
            "stop_evidence_forbidden",
            "Stop evidence is only allowed for not_sent.",
        ));
    }
    if state != "uncertain" && state != "not_sent" && v.get("uncertainReason").is_some() {
        return Err(fail(
            400,
            "uncertain_reason_forbidden",
            "Uncertainty reason does not match the state.",
        ));
    }
    let command = json!({"requestId":request,"actionId":action_id,"ownership":v["ownership"],"payloadDigest":v["payloadDigest"],"state":state,"effectStatus":effect,"journalSequence":sequence,"resultDigest":v["resultDigest"],"resultRef":v["resultRef"],"uncertainReason":v["uncertainReason"],"resultContentDigest":encoded.as_ref().map(|e|hash(e)),"noMarkerEvidence":marker,"stopEvidence":stop});
    let pd = digest(&json!(["briefsip-task-reconcile-v1", task_id, command]));
    let scope = format!("tasks:reconcile:{task_id}");
    devices::current(db, p, now)?;
    if task["home_device"] != p.device
        || v["ownership"]["taskId"] != task_id
        || v["ownership"]["authorityGeneration"] != p.authority
        || v["ownership"]["deviceGeneration"] != p.generation
    {
        return Err(fail(
            409,
            "ownership_conflict",
            "Evidence ownership does not match.",
        ));
    }
    let action=one(db,"SELECT * FROM task_actions WHERE id=? AND task=? AND executor_generation=? AND device_generation=? AND authority_generation=?",params![action_id,task_id,n(&v["ownership"],"executorGeneration"),p.generation,p.authority])?.ok_or_else(||fail(409,"ownership_conflict","Evidence ownership does not match."))?;
    if let Some(old) = replay(
        db,
        &p.account,
        string(task, "project"),
        &request,
        &scope,
        &pd,
        false,
    )? {
        return Ok(old);
    }
    let owner = authority::owner(db, p, task, &v["ownership"], token, true, now)?;
    if prepared(db, task_id, &action_id)?["input"]["payloadDigest"] != v["payloadDigest"] {
        return Err(fail(409, "payload_conflict", "Action payload changed."));
    }
    if action["action_kind"] == "canonical"
        && known
        && !exists(
            db,
            "SELECT 1 FROM task_results WHERE action=? AND task=? AND digest=? AND content_json=?",
            params![action_id, task_id, v["resultDigest"].as_str(), encoded],
        )?
    {
        return Err(fail(
            409,
            "canonical_result_required",
            "Canonical result must come from the tool RPC.",
        ));
    }
    let report_digest = digest(&json!([
        "briefsip-task-report-v1",
        task_id,
        action_id,
        v["payloadDigest"],
        state,
        effect,
        sequence,
        v["resultDigest"],
        v["resultRef"],
        v["uncertainReason"],
        marker,
        stop
    ]));
    if let Some(previous) = one(
        db,
        "SELECT * FROM task_reports WHERE action=?",
        [&action_id],
    )? {
        if previous["report_digest"] == report_digest {
            return one(
                db,
                "SELECT result_json FROM receipts WHERE request_id=?",
                [string(&previous, "receipt_id")],
            )?
            .map(|r| data::json(&r["result_json"]))
            .transpose()?
            .ok_or_else(Failure::storage);
        }
        let old = data::json(&previous["payload_json"])?;
        if old["effectStatus"] == "known"
            && (old["resultDigest"] != v["resultDigest"] || old["resultRef"] != v["resultRef"])
            || old["state"] == "not_sent"
        {
            return Err(fail(
                409,
                "payload_conflict",
                "Final action result already uses different content.",
            ));
        }
        if old["state"] == "acknowledged" && state != "acknowledged" {
            return Err(fail(
                409,
                "action_conflict",
                "Report ACK cannot be downgraded.",
            ));
        }
    }
    if sequence <= n(&owner, "reconciled_through") {
        return Err(fail(
            409,
            "journal_conflict",
            "Journal sequence was already reconciled.",
        ));
    }
    if state == "not_sent" {
        let entry = &marker["entry"];
        let current = one(
            db,
            "SELECT signing_public_key FROM devices WHERE id=?",
            [&p.device],
        )?
        .ok_or_else(Failure::storage)?;
        let key = &current["signing_public_key"];
        let source = (json!(p.authority), json!(p.device), json!(p.generation));
        if entry["taskId"] != task_id
            || entry["actionId"] != action_id
            || entry["sequence"] != action["sequence"]
            || entry["executorGeneration"] != v["ownership"]["executorGeneration"]
            || entry["actionKind"] != action["action_kind"]
            || entry["payloadDigest"] != v["payloadDigest"]
            || entry["intentDigest"] != action["intent_digest"]
            || entry["bindingId"] != action["binding_id"]
            || entry["bindingRevision"] != action["binding_revision"]
            || entry["grantRevision"] != action["grant_revision"]
            || entry["state"] != "not_sent"
            || entry["effectStatus"] != "none"
            || entry.get("resultDigest").is_some()
            || entry.get("resultRef").is_some()
            || entry["journalSequence"] != sequence
            || devices::verify(
                key,
                &recovery::journal_body(&source.0, &source.1, &source.2, entry),
                &marker["signature"],
            )
            .is_err()
        {
            return Err(fail(
                403,
                "stop_evidence_invalid",
                "Journal evidence does not match the action.",
            ));
        }
        let lock = data::json(&owner["lock_proof_json"])?;
        recovery::verify_stop(
            key,
            entry,
            &stop,
            &action,
            &lock,
            (&source.0, &source.1, &source.2),
            now,
        )
        .map_err(|_| {
            fail(
                403,
                "stop_evidence_invalid",
                "Stop evidence does not match the original executor.",
            )
        })?;
    }
    let allowed = match state {
        "prepared" => vec!["prepared"],
        "committed" => vec!["committed"],
        "in_flight" => vec!["committed", "in_flight"],
        "reported" | "acknowledged" => vec![
            "committed",
            "in_flight",
            "reported",
            "acknowledged",
            "uncertain",
        ],
        "not_sent" => vec!["committed", "in_flight", "prepared", "uncertain"],
        _ => vec!["committed", "in_flight", "reported", "uncertain"],
    };
    if !allowed.contains(&string(&action, "state")) {
        return Err(fail(409, "action_conflict", "Invalid action transition."));
    }
    let next_action = if known { "acknowledged" } else { state };
    let next_state = if !terminal(task) && state == "uncertain" {
        "uncertain"
    } else {
        string(task, "state")
    };
    let rev = n(task, "revision") + 1;
    let mut data = json!({"taskId":task_id,"actionId":action_id,"taskState":next_state,"actionState":next_action,"uncertain":next_state=="uncertain","dispatchable":false});
    if known {
        data["resultRef"] = v["resultRef"].clone();
    }
    let result = Save {
        account: &p.account,
        task,
        request: &request,
        scope: &scope,
        payload: &pd,
        now,
    }
    .save(db, &action_id, rev, 200, data, None)?;
    if let Some(encoded) = encoded {
        let prior = one(
            db,
            "SELECT digest,content_json FROM task_results WHERE action=?",
            [&action_id],
        )?;
        if prior
            .as_ref()
            .is_some_and(|r| r["digest"] != v["resultDigest"] || r["content_json"] != encoded)
        {
            return Err(fail(
                409,
                "payload_conflict",
                "Saved result cannot be changed.",
            ));
        }
        if prior.is_none() {
            db.execute(
                "INSERT INTO task_results VALUES(?,?,?,?,?,?,?)",
                params![
                    action_id,
                    task_id,
                    v["resultDigest"].as_str(),
                    encoded.len() as i64,
                    "canonical-json-v1",
                    encoded,
                    now
                ],
            )?;
        }
    }
    let mut report = json!({"v":1,"taskId":task_id,"actionId":action_id,"payloadDigest":v["payloadDigest"],"state":state,"effectStatus":effect,"journalSequence":sequence});
    for key in [
        "resultDigest",
        "resultRef",
        "uncertainReason",
        "noMarkerEvidence",
        "stopEvidence",
    ] {
        if let Some(value) = v.get(key) {
            report[key] = value.clone();
        }
    }
    db.execute("INSERT INTO task_reports VALUES(?,?,?,?,?,?,?) ON CONFLICT(action) DO UPDATE SET report_digest=excluded.report_digest,journal_sequence=excluded.journal_sequence,payload_json=excluded.payload_json,result_ref=excluded.result_ref,receipt_id=excluded.receipt_id",params![action_id,report_digest,p.device,sequence,canonical(&report),if known{Some(action_id.as_str())}else{None},request])?;
    db.execute("UPDATE task_actions SET state=?,result_digest=?,effect_status=?,uncertain_reason=? WHERE id=?",params![next_action,v["resultDigest"].as_str(),effect,v["uncertainReason"].as_str(),action_id])?;
    db.execute(
        "UPDATE execution_owners SET reconciled_through=?,last_seen=? WHERE task=?",
        params![sequence, now, task_id],
    )?;
    db.execute(
        "UPDATE tasks SET state=?,revision=? WHERE id=?",
        params![next_state, rev, task_id],
    )?;
    observe(db, task, now)?;
    Ok(result)
}
fn complete(
    db: &Connection,
    p: &Principal,
    task: &Value,
    v: &Value,
    token: &str,
    now: i64,
) -> Result<Value> {
    fields(v, &["requestId", "actionId", "ownership"])?;
    let request = id(&v["requestId"])?;
    let action = id(&v["actionId"])?;
    let task_id = string(task, "id");
    authority::ownership(&v["ownership"])?;
    let pd = digest(&json!([
        "briefsip-task-complete-v1",
        task_id,
        action,
        v["ownership"]
    ]));
    let scope = format!("tasks:complete:{task_id}");
    authority::owner(db, p, task, &v["ownership"], token, true, now)?;
    authority::dispatch(db, task)?;
    if let Some(old) = replay(
        db,
        &p.account,
        string(task, "project"),
        &request,
        &scope,
        &pd,
        false,
    )? {
        return Ok(old);
    }
    authority::owner(db, p, task, &v["ownership"], token, false, now)?;
    authority::runnable(db, task)?;
    let turn = one(
        db,
        "SELECT agent,status,paused,profile_setup FROM turns WHERE id=?",
        [string(task, "logical_turn")],
    )?
    .ok_or_else(missing)?;
    if turn["agent"] != task["agent"]
        || turn["paused"] == 1
        || matches!(string(&turn, "status"), "done" | "cancelled" | "failed")
    {
        return Err(fail(
            409,
            "task_not_runnable",
            "Task conversation cannot be completed.",
        ));
    }
    let row=one(db,"SELECT a.*,r.content_json,r.digest,r.size,r.encoding FROM task_actions a JOIN task_results r ON r.action=a.id AND r.task=a.task WHERE a.id=? AND a.task=? AND a.action_kind='provider' AND a.state='acknowledged' AND a.effect_status='known'",[&action,task_id])?.ok_or_else(||fail(409,"result_missing","Provider result is not available yet."))?;
    if exists(db,"SELECT 1 FROM task_actions WHERE task=? AND sequence>?",params![task_id,n(&row,"sequence")])?||authority::unresolved(db,task_id)?||exists(db,"SELECT 1 FROM task_action_resolutions r WHERE r.task=? AND r.replacement_action_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM task_actions a WHERE a.id=r.replacement_action_id)",[task_id])?{return Err(fail(409,"outcome_unresolved","Answer is not the result of the last completed action."))}
    let content = data::json(&row["content_json"])?;
    if content.as_object().is_none_or(|o| o.len() != 1)
        || text(&content["text"], 8388608, "text").is_err()
    {
        return Err(fail(
            409,
            "result_invalid",
            "Provider result must contain answer text.",
        ));
    }
    if turn["profile_setup"]==1&&!exists(db,"SELECT 1 FROM task_actions a JOIN task_results o ON o.action=a.id AND o.task=a.task WHERE a.task=? AND a.action_kind='canonical' AND a.state='acknowledged' AND json_type(o.content_json,'$.name')='text' AND json_type(o.content_json,'$.instructions')='text' AND json_type(o.content_json,'$.revision')='integer'",[task_id])?{return Err(fail(409,"setup_incomplete","Task setup profile is not saved yet."))}
    let rev = n(task, "revision") + 1;
    let result=Save{account:&p.account,task,request:&request,scope:&scope,payload:&pd,now}.save(db,task_id,rev,200,json!({"taskId":task_id,"actionId":action,"state":"completed","revision":rev,"resultRef":{"v":1,"taskId":task_id,"actionId":action,"digest":row["digest"],"size":row["size"],"encoding":row["encoding"]}}),None)?;
    db.execute(
        "UPDATE turns SET status='done',paused=0,reply=?,error=NULL,revision=revision+1 WHERE id=?",
        [string(&content, "text"), string(task, "logical_turn")],
    )?;
    db.execute(
        "UPDATE tasks SET state='completed',revision=? WHERE id=?",
        params![rev, task_id],
    )?;
    db.execute(
        "UPDATE execution_owners SET stopped=1,last_seen=? WHERE task=?",
        params![now, task_id],
    )?;
    observe(db, task, now)?;
    Ok(result)
}
