use super::*;

pub fn offline() -> Failure {
    let mut e = fail(
        503,
        "device_offline",
        "Wait provision is waiting for the home device.",
    );
    e.retryable = true;
    e
}
pub fn reserve(
    db: &Connection,
    p: &Principal,
    task: &Value,
    v: &Value,
    args: &Value,
    now: i64,
) -> Result<Value> {
    let key = canonical(&json!(["turn", task["id"], v["toolCall"]["id"]]));
    if let Some(saved)=one(db,"SELECT request_json FROM wait_provisions WHERE id=? OR(target_key=? AND secret_generation=1)",[string(v,"requestId"),&key])?{
        if data::json(&saved["request_json"])?["command"]!=*v{return Err(conflict())}
        return Ok(json!({"waitPending":true}));
    }
    if !args["event"]
        .as_str()
        .is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 256)
        || !data::integer(&args["timeoutSeconds"], 1, 604800)
    {
        return Err(fail(
            400,
            "wait_invalid",
            "Invalid event name or wait limit.",
        ));
    }
    if n(&one(db,"SELECT count(*) n FROM wait_provisions WHERE json_extract(request_json,'$.provision.target.taskId')=?",[string(task,"id")])?.ok_or_else(Failure::storage)?,"n")>=8{return Err(fail(409,"wait_limit","Limit of eight waits per task reached."))}
    let body = json!({"v":1,"provisionId":v["requestId"],"waitKey":v["requestId"],"projectId":task["project"],"agentId":task["agent"],"sourceDeviceId":p.device,"sourceDeviceGeneration":p.generation,"authorityGeneration":p.authority,"secretGeneration":1,"event":args["event"],"deadline":now+n(args,"timeoutSeconds")*1000,"target":{"kind":"turn","taskId":task["id"],"actionId":v["actionId"],"toolCallId":v["toolCall"]["id"]}});
    insert(db, &body, &key, Some(v))?;
    Ok(json!({"waitPending":true}))
}
pub fn insert(db: &Connection, body: &Value, key: &str, command: Option<&Value>) -> Result<Value> {
    let mut provision = body.clone();
    let pd = digest(&json!(["briefsip-wait-provision-v1", body]));
    provision["payloadDigest"] = json!(pd);
    let mut saved = json!({"provision":provision});
    if let Some(v) = command {
        saved["command"] = v.clone()
    }
    db.execute("INSERT INTO wait_provisions(id,project,agent,source_device,source_generation,authority_generation,target_key,secret_generation,payload_digest,request_json,deadline,state) VALUES(?,?,?,?,?,?,?,1,?,?,?,'pending')",params![string(body,"provisionId"),string(body,"projectId"),string(body,"agentId"),string(body,"sourceDeviceId"),n(body,"sourceDeviceGeneration"),string(body,"authorityGeneration"),key,pd,canonical(&saved),n(body,"deadline")])?;
    Ok(provision)
}
fn original(
    db: &Connection,
    p: &Principal,
    row: &Value,
    saved: &Value,
    result: &Value,
    now: i64,
) -> Result<Value> {
    let v = &saved["command"];
    let task = task(db, string(&saved["provision"]["target"], "taskId"))?;
    let scope = format!("tasks:context-mutations:{}", string(&task, "id"));
    if let Some(old) = replay(
        db,
        &p.account,
        string(row, "project"),
        string(v, "requestId"),
        &scope,
        string(v, "payloadDigest"),
        false,
    )? {
        return Ok(old);
    }
    let prepared=one(db,"SELECT result_json FROM receipts WHERE scope=? AND json_extract(result_json,'$.receipt.recordId')=?",[format!("tasks:prepare:{}",string(&task,"id")),string(v,"actionId").to_owned()])?.ok_or_else(Failure::storage)?;
    let input = data::json(&prepared["result_json"])?["input"].clone();
    let saved = mutations::publish(db, p, &task, v, &input, result, now)?;
    db.execute(
        "UPDATE tasks SET revision=revision+1 WHERE id=?",
        [string(&task, "id")],
    )?;
    observe(db, &task, now)?;
    Ok(saved)
}
fn valid(db: &Connection, p: &Principal, saved: &Value, now: i64) -> Result<bool> {
    let provision = &saved["provision"];
    let v = &saved["command"];
    let task = task(db, string(&provision["target"], "taskId"))?;
    let check = || -> Result<()> {
        devices::current(db, p, now)?;
        let current = authority::dispatch(db, &task)?;
        authority::runnable(db, &task)?;
        if task["revision"] != v["expectedRevision"] {
            return Err(stale());
        }
        if !exists(db,"SELECT 1 FROM execution_owners WHERE task=? AND device=? AND executor_generation=? AND device_generation=? AND authority_generation=? AND stopped=0",params![task["id"].as_str(),p.device,n(&v["ownership"],"executorGeneration"),p.generation,p.authority])?{return Err(stale())}
        let action=one(db,"SELECT * FROM task_actions WHERE id=? AND task=? AND state='committed' AND action_kind='canonical'",[string(v,"actionId"),string(&task,"id")])?.ok_or_else(stale)?;
        let prepared=one(db,"SELECT result_json FROM receipts WHERE scope=? AND json_extract(result_json,'$.receipt.recordId')=?",[format!("tasks:prepare:{}",string(&task,"id")),string(v,"actionId").to_owned()])?.ok_or_else(Failure::storage)?;
        let prepared = data::json(&prepared["result_json"])?;
        let mut previous = task.clone();
        previous["revision"] = prepared["input"]["expectedTaskRevision"].clone();
        context::fresh(
            db,
            &previous,
            &current,
            string(&action, "context_snapshot_id"),
            string(&action, "context_digest"),
        )?;
        if !data::json(&current["participation"]["capabilities_json"])?["tools"]
            .as_array()
            .is_some_and(|t| t.contains(&json!("wait_for_event")))
        {
            return Err(stale());
        }
        Ok(())
    };
    match check() {
        Ok(()) => Ok(true),
        Err(e) if [401, 403, 404, 409].contains(&e.status) => Ok(false),
        Err(e) => Err(e),
    }
}
pub fn secret_result(
    state: &AppState,
    db: &Connection,
    p: &Principal,
    v: &Value,
    now: i64,
) -> Result<Value> {
    fields(
        v,
        &[
            "requestId",
            "provisionId",
            "payloadDigest",
            "waitKey",
            "secretGeneration",
            "sourceDeviceGeneration",
            "state",
            "secretRef",
            "errorCode",
        ],
    )?;
    let request = id(&v["requestId"])?;
    let provision_id = id(&v["provisionId"])?;
    hex(&v["payloadDigest"], "payloadDigest")?;
    let generation = revision(&v["secretGeneration"], 1)?;
    revision(&v["sourceDeviceGeneration"], 1)?;
    let key = string(v, "waitKey");
    if !matches!(string(v, "state"), "ready" | "failed")
        || key.is_empty()
        || key.encode_utf16().count() > 1024
        || v["state"] == "ready"
            && (v["secretRef"].as_str() != Some(canonical(&json!([key, generation])).as_str())
                || v.get("errorCode").is_some())
        || v["state"] == "failed"
            && (!matches!(
                string(v, "errorCode"),
                "keystore_unavailable" | "wait_expired" | "wait_invalid"
            ) || v.get("secretRef").is_some())
    {
        return Err(fail(400, "wait_invalid", "Invalid wait secret result."));
    }
    devices::current(db, p, now)?;
    let row = one(
        db,
        "SELECT * FROM wait_provisions WHERE id=?",
        [&provision_id],
    )?
    .ok_or_else(|| fail(409, "wait_invalid", "Wait reservation not found."))?;
    let saved = data::json(&row["request_json"])?;
    let provision = &saved["provision"];
    if row["source_device"] != p.device
        || row["source_generation"] != p.generation
        || row["authority_generation"] != p.authority
        || row["payload_digest"] != v["payloadDigest"]
        || v["secretGeneration"] != row["secret_generation"]
        || v["sourceDeviceGeneration"] != p.generation
        || v["waitKey"] != provision["waitKey"]
    {
        return Err(fail(
            409,
            "wait_invalid",
            "Result does not match the wait reservation.",
        ));
    }
    let pd = digest(&json!(["briefsip-wait-secret-result-v1", v]));
    if let Some(old) = replay(
        db,
        &p.account,
        string(&row, "project"),
        &request,
        "wait-secret-results",
        &pd,
        false,
    )? {
        return Ok(old);
    }
    if !row["result_request_id"].is_null() {
        return Err(conflict());
    }
    if provision["target"]["kind"] == "workflow" {
        let result = crate::automation::project::waits::activate(
            state,
            db,
            provision,
            v,
            row["state"] == "pending",
        )?;
        let activated = result["state"] == "activated";
        let task = json!({"project":row["project"]});
        let ack = Save {
            account: &p.account,
            task: &task,
            request: &request,
            scope: "wait-secret-results",
            payload: &pd,
            now,
        }
        .save(
            db,
            &provision_id,
            n(&result["receipt"], "recordRevision"),
            200,
            json!({"provisionId":provision_id,"state":result["state"],"receipt":result["receipt"]}),
            None,
        )?;
        db.execute(
            "UPDATE wait_provisions SET state=?,result_request_id=? WHERE id=?",
            params![
                if activated { "activated" } else { "closed" },
                request,
                provision_id
            ],
        )?;
        return Ok(ack);
    }
    let activated = row["state"] == "pending"
        && v["state"] == "ready"
        && n(provision, "deadline") > now
        && valid(db, p, &saved, now)?;
    let task = task(db, string(&provision["target"], "taskId"))?;
    let command = &saved["command"];
    if activated {
        let action = one(
            db,
            "SELECT sequence FROM task_actions WHERE id=?",
            [string(command, "actionId")],
        )?
        .ok_or_else(Failure::storage)?;
        db.execute("INSERT INTO turn_waits(id,turn,call_id,call,event,secret_ref,secret_generation,source_device_id,deadline,status,after_output,after_action) VALUES(?,?,?,?,?,?,?,?,?,'waiting',(SELECT count(*) FROM generated_files WHERE turn=?),?)",params![string(provision,"waitKey"),string(&task,"logical_turn"),string(&command["toolCall"],"id"),canonical(&command["toolCall"]),string(provision,"event"),string(v,"secretRef"),n(provision,"secretGeneration"),p.device,n(provision,"deadline"),string(&task,"logical_turn"),n(&action,"sequence")])?;
    }
    let result = if activated {
        json!({"id":provision["waitKey"],"status":"waiting","event":provision["event"],"deadline":provision["deadline"]})
    } else {
        json!({"status":"closed","error":if v["state"]=="failed"{string(v,"errorCode")}else if n(provision,"deadline")<=now{"wait_expired"}else{"wait_invalid"}})
    };
    let original = original(db, p, &row, &saved, &result, now)?;
    let ack=Save{account:&p.account,task:&task,request:&request,scope:"wait-secret-results",payload:&pd,now}.save(db,&provision_id,n(&original["receipt"],"recordRevision"),200,json!({"provisionId":provision_id,"state":if activated{"activated"}else{"closed"},"receipt":original["receipt"]}),None)?;
    db.execute(
        "UPDATE wait_provisions SET state=?,result_request_id=? WHERE id=?",
        [
            if activated {
                "activated"
            } else if v["state"] == "failed" {
                "failed"
            } else {
                "closed"
            },
            &request,
            &provision_id,
        ],
    )?;
    Ok(ack)
}
pub fn maintain(db: &Connection, now: i64) -> Result<()> {
    transaction(db, || {
        for row in all(db,"SELECT w.*,d.account FROM wait_provisions w JOIN devices d ON d.id=w.source_device JOIN tasks t ON t.id=json_extract(w.request_json,'$.provision.target.taskId') WHERE w.state='pending' AND(w.deadline<=? OR t.state<>'running' OR t.revision<>json_extract(w.request_json,'$.command.expectedRevision') OR d.status IN('revoked','blocked') OR d.generation<>w.source_generation) ORDER BY w.deadline,w.id LIMIT 40",[now])?{
            let saved=data::json(&row["request_json"])?;let task=task(db,string(&saved["provision"]["target"],"taskId"))?;
            let p=Principal{device:string(&row,"source_device").to_owned(),account:string(&row,"account").to_owned(),generation:n(&row,"source_generation"),authority:string(&row,"authority_generation").to_owned(),session:None};
            original(db,&p,&row,&saved,&json!({"status":"closed","error":if n(&row,"deadline")<=now{"wait_expired"}else{"wait_invalid"}}),now)?;
            if n(&row,"deadline")<=now&&!terminal(&task){db.execute("UPDATE tasks SET state='failed',revision=revision+1 WHERE id=?",[string(&task,"id")])?;db.execute("UPDATE turns SET status='failed',revision=revision+1,error='Event wait timed out.' WHERE id=?",[string(&task,"logical_turn")])?;observe(db,&task,now)?;}
            db.execute("UPDATE wait_provisions SET state='closed' WHERE id=?",[string(&row,"id")])?;
        }
        Ok(())
    })
}
pub fn send(db: &Connection, now: i64) -> Result<()> {
    for row in all(db,"SELECT request_json FROM wait_provisions w JOIN devices d ON d.id=w.source_device WHERE w.state='pending' AND d.status='ready' AND d.generation=w.source_generation AND w.authority_generation=(SELECT generation FROM authority_state WHERE id=1) AND w.id=(SELECT id FROM wait_provisions candidate WHERE candidate.source_device=w.source_device AND candidate.state='pending' ORDER BY deadline,id LIMIT 1) LIMIT 4",[])?{devices::waits::provision(db,&data::json(&row["request_json"])?["provision"],now)?;}
    Ok(())
}
