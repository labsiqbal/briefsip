use super::*;

pub fn tools(db: &Connection, turn: &Value) -> Result<Vec<Value>> {
    let members = if let Some(channel) = turn["channel"].as_str() {
        all(db,"SELECT a.id FROM channel_members m JOIN agents a ON a.id=m.agent WHERE m.channel=? AND m.agent<>? AND NOT EXISTS(SELECT 1 FROM agent_visibility v WHERE v.agent=a.id AND v.hidden=1) ORDER BY a.id",[channel,string(turn,"agent")])?
    } else {
        all(db,"SELECT id FROM agents WHERE id<>? AND NOT EXISTS(SELECT 1 FROM agent_visibility v WHERE v.agent=agents.id AND v.hidden=1) ORDER BY id",[string(turn,"agent")])?
    };
    let ids: Vec<_> = members.iter().map(|r| r["id"].clone()).collect();
    Ok(["delegate_task","transfer_task"].into_iter().map(|name|json!({"type":"function","function":{"name":name,"description":if name=="delegate_task"{"Ask another teammate to perform a subtask, then use their result. You remain owner."}else{"Transfer this task to another teammate, who becomes owner and completes it."},"parameters":{"type":"object","properties":{"recipient":{"type":"string","enum":ids},"task":{"type":"string","maxLength":16000},"wait":{"type":"boolean"}},"required":["recipient","task"],"additionalProperties":false}}})).collect())
}
pub fn execute(
    state: &AppState,
    db: &Connection,
    turn: &Value,
    call: &Value,
    args: &Value,
) -> Result<Value> {
    let target = string(args, "recipient");
    if !closed(args, &["recipient", "task", "wait"])
        || target == string(turn, "agent")
        || if let Some(channel) = turn["channel"].as_str() {
            !exists(
                db,
                "SELECT 1 FROM channel_members WHERE channel=? AND agent=?",
                [channel, target],
            )?
        } else {
            !exists(db, "SELECT 1 FROM agents WHERE id=?", [target])?
        }
    {
        return Err(error(
            400,
            "Coordination recipient is not another channel member.",
        ));
    }
    if data::agents::hidden(db, target)? {
        return Err(error(409, "Recipient agent is hidden."));
    }
    let prompt = field(args, "task", 16000)?;
    let ancestors=all(db,"WITH RECURSIVE tree(id,parent) AS(SELECT id,parent FROM turns WHERE id=? UNION ALL SELECT t.id,t.parent FROM turns t JOIN tree ON t.id=tree.parent) SELECT * FROM tree",[string(turn,"id")])?;
    let root = ancestors
        .iter()
        .find(|r| r["parent"].is_null())
        .ok_or_else(Failure::storage)?;
    let depth = ancestors
        .iter()
        .filter(|r| {
            exists(
                db,
                "SELECT 1 FROM coordination WHERE child=?",
                [string(r, "id")],
            )
            .unwrap_or(true)
        })
        .count();
    let family:i64=db.query_row("WITH RECURSIVE tree(id) AS(SELECT id FROM turns WHERE id=? UNION ALL SELECT t.id FROM turns t JOIN tree ON t.parent=tree.id) SELECT count(*) FROM coordination WHERE turn IN(SELECT id FROM tree)",[string(root,"id")],|r|r.get(0))?;
    if depth as i64 >= state.config.turns.limit("depth", 3) || family >= 32 {
        return Err(error(429,"Coordination limit reached: delegation depth or family limit reached. Complete existing work or start a new request."));
    }
    if db.query_row(
        "SELECT count(*) FROM turns WHERE agent=? AND status IN('queued','running')",
        [target],
        |r| r.get::<_, i64>(0),
    )? >= 100
    {
        return Err(error(429, "Recipient queue is full."));
    }
    let cutoff = state.config.now() - state.config.turns.limit("rateWindowMs", 300_000);
    if db.query_row(
        "SELECT count(*) FROM agent_message_events WHERE agent=? AND created>?",
        params![string(turn, "agent"), cutoff],
        |r| r.get::<_, i64>(0),
    )? >= 20
    {
        return Err(error(429, "Agent message rate limit reached."));
    }
    admission::account(state, db, target)?;
    db.execute(
        "INSERT INTO agent_message_events VALUES(?,?,?)",
        params![
            uuid::Uuid::new_v4().to_string(),
            string(turn, "agent"),
            state.config.now()
        ],
    )?;
    let child = if call["function"]["name"] == "delegate_task" {
        Some(uuid::Uuid::new_v4().to_string())
    } else {
        None
    };
    if let Some(child) = &child {
        db.execute("INSERT INTO turns(id,agent,channel,recipient,parent,text,status,created) VALUES(?,?,?,?,?,?,'queued',?)",params![child,target,turn["channel"].as_str(),target,string(turn,"id"),prompt,iso(db,state.config.now())?])?;
        db.execute(
            "UPDATE turns SET status='queued',waiting_for=? WHERE id=?",
            [child, string(turn, "id")],
        )?;
    } else {
        db.execute(
            "UPDATE turns SET status='queued',agent=? WHERE id=?",
            [target, string(turn, "id")],
        )?;
    }
    db.execute(
        "INSERT INTO coordination(turn,owner,target,kind,prompt,call,child) VALUES(?,?,?,?,?,?,?)",
        params![
            string(turn, "id"),
            string(turn, "agent"),
            target,
            string(&call["function"], "name"),
            prompt,
            call.to_string(),
            child
        ],
    )?;
    Ok(Value::Null)
}
pub fn settle(db: &Connection) -> Result<()> {
    loop {
        let rows=all(db,"SELECT p.id FROM turns p JOIN turns c ON c.id=p.waiting_for WHERE p.status='queued' AND c.status IN('failed','cancelled','interrupted') AND NOT EXISTS(SELECT 1 FROM delegation_tasks WHERE delivery=c.id)",[])?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            db.execute("UPDATE turns SET status='interrupted',error='Delegation did not finish. Check the subtask results before sending new work.' WHERE id=?",[string(&row,"id")])?;
        }
    }
    for row in all(db,"SELECT p.id FROM turns p JOIN turns c ON c.id=p.waiting_for WHERE p.status='queued' AND c.status='done' AND NOT EXISTS(SELECT 1 FROM delegation_tasks WHERE delivery=c.id AND wake_delivered=0)",[])? {db.execute("UPDATE turns SET waiting_for=NULL WHERE id=?",[string(&row,"id")])?;}
    Ok(())
}
