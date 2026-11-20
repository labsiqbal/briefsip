use super::*;

fn candidates(db: &Connection, task: &Value, after: &str) -> Result<(Vec<Value>, Option<String>)> {
    let family = authority::ancestors(db, task)?;
    let turns = json!(family.iter().map(|r| r["id"].clone()).collect::<Vec<_>>());
    let channel = crate::turns::messaging::channel(db, string(task, "logical_turn"))?;
    let rows = all(db,"WITH RECURSIVE ancestors(id,predecessor_task,agent) AS (SELECT id,predecessor_task,agent FROM tasks WHERE logical_turn IN(SELECT value FROM json_each(?)) UNION ALL SELECT t.id,t.predecessor_task,t.agent FROM tasks t JOIN ancestors ON t.id=ancestors.predecessor_task) SELECT a.id,a.name,a.role,substr(a.instructions,1,300) description FROM agents a JOIN agent_projects ap ON ap.agent=a.id AND ap.project=? AND ap.deleted=0 JOIN agent_authority h ON h.agent=a.id JOIN projects p ON p.id=ap.project AND p.account=h.owner_account AND p.deleted=0 JOIN project_members m ON m.project=ap.project AND m.account=? AND m.deleted=0 WHERE (m.role='owner' OR EXISTS(SELECT 1 FROM collaborator_agents ca WHERE ca.project=ap.project AND ca.account=m.account AND ca.agent=a.id AND ca.enabled=1)) AND NOT EXISTS(SELECT 1 FROM ancestors x WHERE x.agent=a.id) AND (? IS NULL OR EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel=? AND cm.agent=a.id)) AND NOT EXISTS(SELECT 1 FROM agent_visibility v WHERE v.agent=a.id AND v.hidden=1) AND a.id>? ORDER BY a.id",params![canonical(&turns),string(task,"project"),string(task,"initiator_account"),channel,channel,after])?;
    Ok((rows, channel))
}
pub fn list(db: &Connection, task: &Value, args: &Value) -> Result<Value> {
    let after = args
        .get("after")
        .map(id)
        .transpose()
        .map_err(|_| fail(400, "invalid_id", "Invalid agent list position."))?
        .unwrap_or_default();
    let (mut rows, channel) = candidates(db, task, &after)?;
    let next = rows
        .get(10)
        .and_then(|_| rows.get(9))
        .map(|r| r["id"].clone())
        .unwrap_or(Value::Null);
    rows.truncate(10);
    for row in &mut rows {
        let active = one(db,"SELECT count(*) total,coalesce(max(k.state='running'),0) working,coalesce(sum(k.state IN('queued','waiting_device','waiting_resource') AND json_extract(k.payload_json,'$.kind')<>'channel'),0) queued FROM tasks k JOIN record_scopes s ON s.table_name='turns' AND s.key_json=json_array(k.logical_turn) AND s.project=k.project WHERE k.project=? AND k.agent=? AND k.state IN('queued','waiting_device','waiting_resource','running','paused','approval','uncertain') AND(s.visibility='project' OR s.account=?) AND(? IS NULL OR s.root_kind='channel' AND s.root_id=?)",params![string(task,"project"),string(row,"id"),string(task,"initiator_account"),channel,channel])?.ok_or_else(Failure::storage)?;
        row["status"] = json!(if n(&active, "working") > 0 {
            "working"
        } else if n(&active, "total") > 0 {
            "waiting"
        } else {
            "idle"
        });
        row["queuedMessages"] = active["queued"].clone();
    }
    Ok(json!({"agents":rows,"next_after":next}))
}
fn map(
    db: &Connection,
    task: &Value,
    table: &str,
    id: &str,
    kind: &str,
    root: &str,
    visibility: &str,
) -> Result<()> {
    db.execute(
        "INSERT INTO record_scopes VALUES(?,?,?,?,?,?,?)",
        params![
            table,
            canonical(&json!([id])),
            string(task, "initiator_account"),
            string(task, "project"),
            visibility,
            kind,
            root
        ],
    )?;
    Ok(())
}
pub fn send(db: &Connection, task: &Value, args: &Value, call: &Value, now: i64) -> Result<Value> {
    let recipients = args["recipients"]
        .as_array()
        .filter(|r| !r.is_empty() && r.len() <= 8)
        .ok_or_else(|| {
            fail(
                409,
                "invalid_tool_call",
                "Invalid recipient, text, or reply request.",
            )
        })?
        .iter()
        .map(id)
        .collect::<Result<Vec<_>>>()?;
    let text = text(&args["text"], 16000, "Message")?;
    if !args["expects_reply"].is_boolean()
        || recipients
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != recipients.len()
    {
        return Err(fail(
            409,
            "invalid_tool_call",
            "Invalid recipient, text, or reply request.",
        ));
    }
    let (allowed, channel) = candidates(db, task, "")?;
    if recipients
        .iter()
        .any(|id| !allowed.iter().any(|r| r["id"] == *id))
    {
        return Err(fail(
            404,
            "recipient_unavailable",
            "Recipient is unavailable or requested this task.",
        ));
    }
    let ancestors = authority::ancestors(db, task)?;
    let root = ancestors.last().ok_or_else(Failure::storage)?;
    let family=one(db,"WITH RECURSIVE family(id) AS(SELECT ? UNION ALL SELECT t.id FROM turns t JOIN family f ON t.parent=f.id) SELECT count(*) n FROM family",[string(root,"id")])?.ok_or_else(Failure::storage)?;
    if ancestors.len() >= 8 || n(&family, "n") + recipients.len() as i64 > 32 {
        return Err(fail(
            409,
            "coordination_limit",
            "Coordination limit reached.",
        ));
    }
    if exists(
        db,
        "SELECT 1 FROM agent_requests WHERE turn=? AND call_id=?",
        [string(task, "logical_turn"), string(call, "id")],
    )? {
        return Err(fail(
            409,
            "call_conflict",
            "Coordination tool ID was already used.",
        ));
    }
    let request = uuid::Uuid::new_v4().to_string();
    let visibility = if channel.is_some() {
        "project"
    } else {
        "owner"
    };
    let sender = one(
        db,
        "SELECT name FROM agents WHERE id=?",
        [string(task, "agent")],
    )?
    .ok_or_else(Failure::storage)?;
    db.execute(
        "INSERT INTO agent_requests(id,turn,call_id,expects_reply) VALUES(?,?,?,?)",
        params![
            request,
            string(task, "logical_turn"),
            string(call, "id"),
            args["expects_reply"] == true
        ],
    )?;
    map(
        db,
        task,
        "agent_requests",
        &request,
        "task",
        string(task, "id"),
        visibility,
    )?;
    for recipient in recipients {
        crate::data::limits::task_capacity(db, string(task, "project"), &recipient)?;
        let thread = uuid::Uuid::new_v4().to_string();
        let child = uuid::Uuid::new_v4().to_string();
        let home = one(
            db,
            "SELECT home_device FROM agent_authority WHERE agent=?",
            [&recipient],
        )?
        .ok_or_else(missing)?;
        db.execute(
            "INSERT INTO threads(id,agent,name) VALUES(?,?,?)",
            params![
                thread,
                recipient,
                format!("Message from {}", string(&sender, "name"))
            ],
        )?;
        map(db, task, "threads", &thread, "thread", &thread, visibility)?;
        db.execute("INSERT INTO turns(id,agent,thread,parent,text,status,created) VALUES(?,?,?,?,?,'queued',?)",params![child,recipient,thread,string(task,"logical_turn"),text,data::iso(db,now)?])?;
        map(db, task, "turns", &child, "thread", &thread, visibility)?;
        let payload =
            json!({"v":1,"kind":"side","threadId":thread,"message":{"text":text,"files":[]}});
        let mut candidate = task.clone();
        candidate["id"] = json!(child);
        candidate["logical_turn"] = json!(child);
        candidate["agent"] = json!(recipient);
        candidate["home_device"] = home["home_device"].clone();
        candidate["predecessor_task"] = Value::Null;
        candidate["payload_json"] = json!(canonical(&payload));
        let current = authority::dispatch(db, &candidate)?;
        let device=one(db,"SELECT d.status,d.capabilities_json FROM devices d JOIN installations i ON i.id=d.installation AND i.account=d.account AND i.revoked=0 WHERE d.id=? AND d.account=? AND d.status NOT IN('blocked','revoked')",[string(&home,"home_device"),string(&current["member"],"account")])?.ok_or_else(missing)?;
        if !data::json(&device["capabilities_json"])?
            .as_array()
            .is_some_and(|a| a.contains(&json!("execution")))
        {
            return Err(missing());
        }
        let part = &current["participation"];
        let capability = data::json(&part["capabilities_json"])?;
        let binding = if let Some(binding) = part["provider_binding"].as_str() {
            Some(
                one(
                    db,
                    "SELECT * FROM provider_bindings WHERE id=? AND device=? AND owner_account=?",
                    [
                        binding,
                        string(&home, "home_device"),
                        string(&current["member"], "account"),
                    ],
                )?
                .ok_or_else(|| fail(409, "binding_stale", "Recipient provider is unavailable."))?,
            )
        } else {
            None
        };
        let revisions = current["sourceRevisions"]
            .as_array()
            .ok_or_else(Failure::storage)?
            .iter()
            .map(|r| (string(r, "kind").to_owned(), r["revision"].clone()))
            .collect::<serde_json::Map<_, _>>();
        let pd = digest(&json!([
            "minarbot-agent-message-v1",
            request,
            child,
            task["id"],
            recipient,
            home["home_device"],
            payload,
            revisions
        ]));
        let state = if device["status"] == "ready" {
            "queued"
        } else {
            "waiting_device"
        };
        db.execute("INSERT INTO tasks(id,logical_turn,project,agent,initiator_account,home_device,assignment_revision,capability_revision,capability_digest,capability_snapshot_json,provider_binding_id,provider_binding_revision,provider_binding_owner,state,payload_digest,payload_json,revision,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)",params![child,child,string(task,"project"),recipient,string(task,"initiator_account"),string(&home,"home_device"),current["assignment"].as_i64(),part["capability_revision"].as_i64(),digest(&json!(["minarbot-capabilities-v1",capability])),canonical(&capability),binding.as_ref().and_then(|b|b["id"].as_str()),binding.as_ref().and_then(|b|b["revision"].as_i64()),binding.as_ref().and_then(|b|b["owner_account"].as_str()),state,pd,canonical(&payload),now])?;
        observe(db, &candidate, now)?;
        db.execute(
            "INSERT INTO agent_deliveries VALUES(?,?)",
            params![request, child],
        )?;
        map(
            db,
            task,
            "agent_deliveries",
            &child,
            "task",
            &child,
            visibility,
        )?;
        Save{account:string(task,"initiator_account"),task,request:&child,scope:&format!("tasks:admit:{}",string(task,"project")),payload:&pd,now}.save(db,&child,1,202,json!({"taskId":child,"state":state,"revision":1,"homeDeviceId":home["home_device"],"payloadDigest":pd}),None)?;
    }
    Ok(
        json!({"request":request,"status":if args["expects_reply"]==true{"waiting"}else{"sent"},"expects_reply":args["expects_reply"]}),
    )
}
pub fn interrupt(
    db: &Connection,
    task: &Value,
    args: &Value,
    call: &Value,
    now: i64,
) -> Result<Value> {
    let recipient = id(&args["recipient"])?;
    let reason = text(&args["reason"], 2000, "Stop reason")?;
    if !candidates(db, task, "")?
        .0
        .iter()
        .any(|r| r["id"] == recipient)
    {
        return Err(fail(
            409,
            "recipient_unavailable",
            "You can only stop teammate work you requested in a private conversation.",
        ));
    }
    let rows=all(db,"SELECT source.*,d.turn delivery FROM agent_requests r JOIN record_scopes s ON s.table_name='agent_requests' AND s.key_json=json_array(r.id) AND s.root_kind='task' JOIN tasks source ON source.id=s.root_id AND source.logical_turn=r.turn AND source.project=s.project JOIN agent_deliveries d ON d.request=r.id JOIN tasks child ON child.logical_turn=d.turn WHERE source.project=? AND source.initiator_account=? AND source.agent=? AND child.project=source.project AND child.initiator_account=source.initiator_account AND(s.visibility='project' OR s.account=?) AND child.agent=? AND r.settled=0 AND child.state NOT IN('completed','failed','cancelled','transferred') AND NOT EXISTS(SELECT 1 FROM tasks next WHERE next.predecessor_task=child.id) ORDER BY d.turn",[string(task,"project"),string(task,"initiator_account"),string(task,"agent"),string(task,"initiator_account"),&recipient])?;
    let mut cancelled = Vec::new();
    for row in rows {
        if crate::turns::messaging::channel(db, string(&row, "logical_turn"))?.is_some() {
            continue;
        }
        sources::messages(db, &row)?;
        for child in all(db,"WITH RECURSIVE branch(id) AS(SELECT ? UNION ALL SELECT t.id FROM turns t JOIN branch b ON t.parent=b.id) SELECT DISTINCT k.logical_turn FROM tasks k JOIN branch b ON b.id=k.logical_turn JOIN record_scopes s ON s.table_name='turns' AND s.key_json=json_array(k.logical_turn) WHERE k.project=? AND k.initiator_account=? AND s.project=k.project AND(s.visibility='project' OR s.account=?) AND k.state NOT IN('completed','failed','cancelled','transferred') ORDER BY k.logical_turn",[string(&row,"delivery"),string(task,"project"),string(task,"initiator_account"),string(task,"initiator_account")])? {
            let turn=string(&child,"logical_turn");
            for changed in all(db,"UPDATE tasks SET state='cancelled',revision=revision+1 WHERE logical_turn=? AND state NOT IN('completed','failed','cancelled','transferred') RETURNING *",[turn])?{observe(db,&changed,now)?;}
            db.execute("UPDATE execution_owners SET stopped=1 WHERE task IN(SELECT id FROM tasks WHERE logical_turn=?)",[turn])?;
            db.execute("UPDATE turns SET status='cancelled',paused=1,error=?,revision=revision+1 WHERE id=? AND status<>'done'",[format!("Stopped by requester: {}",reason.trim()),turn.to_owned()])?;
            cancelled.push(turn.to_owned());
        }
    }
    if cancelled.is_empty() {
        return Err(fail(
            409,
            "recipient_unavailable",
            "You have no active work for this recipient.",
        ));
    }
    cancelled.sort();
    cancelled.dedup();
    let mut notice = send(
        db,
        task,
        &json!({"recipients":[recipient],"text":format!("The work I asked for has been stopped. Reason: {}\nNotice only; do not continue the work or send a reply.",reason.trim()),"expects_reply":false}),
        call,
        now,
    )?;
    notice["status"] = json!("interrupted");
    notice["recipient"] = json!(recipient);
    notice["cancelled"] = json!(cancelled);
    Ok(notice)
}
