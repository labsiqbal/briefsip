use super::*;
use subtle::ConstantTimeEq;
pub fn member(db: &Connection, account: &str, project: &str, owner: bool) -> Result<Value> {
    if !exists(
        db,
        "SELECT 1 FROM authority_state WHERE id=1 AND serving_state='active'",
        [],
    )? {
        let mut e = fail(503, "authority_unavailable", "Authority is not active yet.");
        e.retryable = true;
        return Err(e);
    }
    let row=one(db,"SELECT p.account,p.revision,m.role,m.grant_revision FROM projects p JOIN project_members m ON m.project=p.id JOIN accounts a ON a.id=m.account WHERE p.id=? AND m.account=? AND p.deleted=0 AND m.deleted=0 AND a.blocked=0",[project,account])?.ok_or_else(||fail(404,"resource_not_found","Resource not found."))?;
    if owner && (row["account"] != account || row["role"] != "owner") {
        return Err(fail(
            403,
            "owner_required",
            "Only the owner can perform this action.",
        ));
    }
    Ok(row)
}
pub fn assignment(
    db: &Connection,
    account: &str,
    project: &str,
    agent: &str,
    member: &Value,
) -> Result<i64> {
    if member["role"] == "owner" {
        return Ok(n(member, "grant_revision"));
    }
    one(db,"SELECT revision FROM collaborator_agents WHERE project=? AND account=? AND agent=? AND enabled=1",[project,account,agent])?.map(|r|n(&r,"revision")).ok_or_else(||fail(403,"execution_denied","Task assignment was revoked."))
}
pub fn dispatch(db: &Connection, task: &Value) -> Result<Value> {
    let member=one(db,"SELECT p.account,p.revision,m.role,m.grant_revision FROM projects p JOIN project_members m ON m.project=p.id JOIN accounts a ON a.id=m.account WHERE p.id=? AND m.account=? AND p.deleted=0 AND m.deleted=0 AND a.blocked=0",[string(task,"project"),string(task,"initiator_account")])?.ok_or_else(||fail(403,"execution_denied","Task initiator access was revoked."))?;
    let part=one(db,"SELECT a.name,a.role,a.model,a.instructions,a.revision agent_revision,p.rules,p.capabilities_json,p.revision capability_revision,h.revision home_revision,h.provider_binding FROM agent_projects p JOIN agents a ON a.id=p.agent JOIN agent_authority h ON h.agent=a.id WHERE p.project=? AND p.agent=? AND p.deleted=0 AND h.owner_account=? AND h.home_device=?",params![string(task,"project"),string(task,"agent"),string(&member,"account"),string(task,"home_device")])?.ok_or_else(||fail(403,"execution_denied","Task scope is invalid."))?;
    if !exists(db,"SELECT 1 FROM record_scopes WHERE table_name='turns' AND key_json=? AND project=? AND (visibility='project' OR account=?)",params![json!([task["logical_turn"]]).to_string(),string(task,"project"),string(task,"initiator_account")])?{return Err(fail(403,"execution_denied","Task scope is invalid."))}
    let assign = assignment(
        db,
        string(task, "initiator_account"),
        string(task, "project"),
        string(task, "agent"),
        &member,
    )?;
    let mut revisions = vec![
        json!({"kind":"project","id":task["project"],"revision":member["revision"]}),
        json!({"kind":"agent","id":task["agent"],"revision":part["agent_revision"]}),
        json!({"kind":"homeBinding","id":task["agent"],"revision":part["home_revision"]}),
        json!({"kind":"membership","id":task["initiator_account"],"revision":member["grant_revision"]}),
        json!({"kind":"assignment","id":task["initiator_account"],"revision":assign}),
        json!({"kind":"capability","id":task["agent"],"revision":part["capability_revision"]}),
    ];
    let payload = data::json(&task["payload_json"])?;
    let root = match string(&payload, "kind") {
        "side" => Some(("threads", "thread", string(&payload, "threadId"))),
        "channel" => Some(("channels", "channel", string(&payload, "channelId"))),
        _ => None,
    };
    if let Some((table, kind, id)) = root {
        let row = one(db, &format!("SELECT * FROM {table} WHERE id=?"), [id])?
            .ok_or_else(|| fail(403, "execution_denied", "Task conversation is inactive."))?;
        if row["archived"]==1||row["deleted"]==1||!exists(db,"SELECT 1 FROM record_scopes WHERE table_name=? AND key_json=? AND project=? AND root_kind=? AND root_id=? AND (visibility='project' OR account=?)",params![table,json!([id]).to_string(),string(task,"project"),kind,id,string(task,"initiator_account")])?{return Err(fail(403,"execution_denied","Task conversation is inactive."))}
        let original = one(
            db,
            "SELECT agent FROM tasks WHERE logical_turn=? AND predecessor_task IS NULL UNION ALL SELECT agent FROM turns WHERE id=? LIMIT 1",
            [string(task, "logical_turn"),string(task, "logical_turn")],
        )?
        .ok_or_else(missing)?;
        if kind == "thread" && row["agent"] != original["agent"]
            || kind == "channel"
                && !exists(
                    db,
                    "SELECT 1 FROM channel_members WHERE channel=? AND agent=?",
                    [id, string(task, "agent")],
                )?
        {
            return Err(fail(
                403,
                "execution_denied",
                "Agent is outside the conversation.",
            ));
        }
        revisions.push(json!({"kind":kind,"id":id,"revision":row["revision"]}));
    }
    let workflow = automation::dispatch(db, task)?;
    if let Some(run) = workflow {
        revisions.push(json!({"kind":"workflowRun","id":run["id"],"revision":run["revision"]}));
    }
    let family = ancestors(db, task)?;
    let ancestors = family.into_iter().skip(1).collect::<Vec<_>>();
    if ancestors.iter().any(|a| a["status"] == "cancelled") {
        return Err(fail(
            403,
            "execution_denied",
            "Requesting task was cancelled.",
        ));
    }
    if ancestors.iter().any(|a| a["paused"] == 1) {
        return Err(fail(
            409,
            "task_not_runnable",
            "Requesting task was paused.",
        ));
    }
    for a in &ancestors {
        revisions.push(json!({"kind":"requester","id":a["id"],"revision":a["revision"]}));
    }
    if let Some(channel) = ancestors.iter().find_map(|r| r["channel"].as_str()) {
        let room=one(db,"SELECT c.revision FROM channels c JOIN channel_members m ON m.channel=c.id AND m.agent=? JOIN record_scopes s ON s.table_name='channels' AND s.key_json=json_array(c.id) AND s.project=? AND s.root_kind='channel' AND s.root_id=c.id WHERE c.id=? AND c.archived=0 AND (s.visibility='project' OR s.account=?)",[string(task,"agent"),string(task,"project"),channel,string(task,"initiator_account")])?.ok_or_else(||fail(403,"execution_denied","Requester channel access was revoked."))?;
        revisions.push(json!({"kind":"originChannel","id":channel,"revision":room["revision"]}));
    }
    sort(&mut revisions);
    Ok(
        json!({"member":member,"participation":part,"sourceRevisions":revisions,"assignment":assign}),
    )
}
pub fn sort(rows: &mut [Value]) {
    rows.sort_by(|a, b| {
        string(a, "kind")
            .cmp(string(b, "kind"))
            .then_with(|| string(a, "id").cmp(string(b, "id")))
    });
}
pub fn ownership(v: &Value) -> Result<()> {
    fields(
        v,
        &[
            "authorityGeneration",
            "deviceGeneration",
            "taskId",
            "executorGeneration",
        ],
    )?;
    id(&v["authorityGeneration"])?;
    id(&v["taskId"])?;
    revision(&v["deviceGeneration"], 1)?;
    revision(&v["executorGeneration"], 1)?;
    Ok(())
}
pub fn owner(
    db: &Connection,
    p: &Principal,
    task: &Value,
    v: &Value,
    token: &str,
    evidence: bool,
    now: i64,
) -> Result<Value> {
    ownership(v)?;
    devices::current(db, p, now)?;
    if task["home_device"] != p.device
        || v["taskId"] != task["id"]
        || v["authorityGeneration"] != p.authority
        || v["deviceGeneration"] != p.generation
    {
        return Err(fail(409, "ownership_conflict", "Ownership does not match."));
    }
    let row=one(db,"SELECT * FROM execution_owners WHERE task=? AND device=? AND authority_generation=? AND device_generation=? AND executor_generation=? AND (stopped=0 OR ?=1)",params![string(task,"id"),p.device,p.authority,p.generation,n(v,"executorGeneration"),i64::from(evidence)])?.ok_or_else(||fail(409,"ownership_conflict","Executor was replaced."))?;
    let expected = string(&row, "token_hash");
    let actual = hash(token);
    if token.len() != 43
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        || !bool::from(actual.as_bytes().ct_eq(expected.as_bytes()))
    {
        return Err(fail(401, "executor_invalid", "Invalid executor token."));
    }
    Ok(row)
}
pub fn unresolved(db: &Connection, id: &str) -> Result<bool> {
    exists(db,"SELECT 1 FROM task_actions a WHERE a.task=? AND a.state NOT IN('acknowledged','not_sent') AND NOT EXISTS(SELECT 1 FROM task_action_resolutions r WHERE r.action=a.id)",[id])
}
pub fn runnable(db: &Connection, task: &Value) -> Result<()> {
    if task["state"] != "running" {
        return Err(fail(409, "task_not_runnable", "Task cannot be resumed."));
    }
    if exists(
        db,
        "SELECT 1 FROM questions WHERE turn=? AND answer IS NULL",
        [string(task, "logical_turn")],
    )? {
        return Err(fail(
            409,
            "question_pending",
            "Answer the task question before resuming.",
        ));
    }
    if data::table(db, "turn_waits")?
        && exists(
            db,
            "SELECT 1 FROM turn_waits WHERE turn=? AND status='waiting'",
            [string(task, "logical_turn")],
        )?
    {
        let mut e = fail(409, "event_pending", "Task is waiting for an event.");
        e.retryable = true;
        return Err(e);
    }
    sources::waiting_agents(db, task)?;
    Ok(())
}
pub fn binding(
    db: &Connection,
    task: &Value,
    current: &Value,
    id: &Value,
    rev: &Value,
) -> Result<()> {
    if current["participation"]["provider_binding"]!=*id||!exists(db,"SELECT 1 FROM provider_bindings WHERE id=? AND device=? AND owner_account=? AND revision=? AND readiness='ready'",params![id.as_str(),string(task,"home_device"),string(&current["member"],"account"),rev.as_i64()])?{return Err(fail(409,"binding_stale","Provider binding changed or is unavailable."))}
    Ok(())
}

pub fn ancestors(db: &Connection, task: &Value) -> Result<Vec<Value>> {
    let rows = all(db,"WITH RECURSIVE a AS(SELECT id,parent,channel,status,paused,revision,1 depth FROM turns WHERE id=? UNION ALL SELECT t.id,t.parent,t.channel,t.status,t.paused,t.revision,a.depth+1 FROM turns t JOIN a ON t.id=a.parent WHERE a.depth<9) SELECT * FROM a",[string(task,"logical_turn")])?;
    if rows.len() > 8 {
        return Err(fail(
            403,
            "execution_denied",
            "Coordination scope is unavailable.",
        ));
    }
    for row in &rows {
        if !exists(db,"SELECT 1 FROM record_scopes WHERE table_name='turns' AND key_json=? AND project=? AND (visibility='project' OR account=?)",[&json!([row["id"]]).to_string(),string(task,"project"),string(task,"initiator_account")])? {return Err(fail(403,"execution_denied","Coordination scope is unavailable."));}
    }
    Ok(rows)
}
