use super::*;
use std::collections::{BTreeSet, HashSet};
pub(super) fn validate(db: &Connection, root: &str, links: &Value) -> Result<Value> {
    validate_scope(db, root, links, None)
}
pub(crate) fn validate_scope(
    db: &Connection,
    root: &str,
    links: &Value,
    project: Option<&str>,
) -> Result<Value> {
    let invalid = |m| error(400, m);
    let links = links
        .as_array()
        .filter(|l| l.len() <= 64)
        .ok_or_else(|| invalid("Flow requires a source agent and up to 64 links."))?;
    let agents = if let Some(project) = project {
        all(
            db,
            "SELECT agent AS id FROM agent_projects WHERE project=? AND deleted=0",
            [project],
        )?
    } else {
        all(db, "SELECT id FROM agents", [])?
    };
    let known: HashSet<_> = agents.iter().map(|r| string(r, "id").to_owned()).collect();
    let mut seen = HashSet::new();
    let mut remaining = BTreeSet::from([root.to_owned()]);
    let mut clean = Vec::new();
    for l in links {
        let a = string(l, "from");
        let b = string(l, "to");
        if !data::closed(l, &["from", "to"])
            || !known.contains(a)
            || !known.contains(b)
            || a == b
            || b == root
        {
            return Err(invalid(
                "Flow links must connect two different agents without returning to the source.",
            ));
        }
        if !seen.insert((a, b)) {
            return Err(invalid("Flow links must not be duplicated."));
        }
        remaining.insert(a.to_owned());
        remaining.insert(b.to_owned());
        clean.push(json!({"from":a,"to":b}));
    }
    if remaining.len() > 32 {
        return Err(invalid("A flow supports up to 32 agents."));
    }
    let mut ordered = Vec::new();
    while !remaining.is_empty() {
        let ready: Vec<_> = remaining
            .iter()
            .filter(|n| {
                !clean
                    .iter()
                    .any(|l| l["to"] == **n && remaining.contains(string(l, "from")))
            })
            .cloned()
            .collect();
        if ready.is_empty() {
            return Err(invalid("Flow must not contain cycles."));
        }
        for n in ready {
            remaining.remove(&n);
            ordered.push(n);
        }
    }
    let mut reached = HashSet::from([root.to_owned()]);
    for n in &ordered {
        if clean
            .iter()
            .any(|l| l["to"] == *n && reached.contains(string(l, "from")))
        {
            reached.insert(n.clone());
        }
    }
    if reached.len() != ordered.len() {
        return Err(invalid(
            "All links must be reachable from the source agent.",
        ));
    }
    Ok(json!({"root":root,"nodes":ordered,"links":clean}))
}
pub(crate) fn save(db: &Connection, routine: &str, owner: &str, v: &Value) -> Result<Value> {
    if !integer(&v["revision"], 0, 9007199254740991) {
        return Err(error(400, "Invalid flow revision."));
    }
    if !data::exists(
        db,
        "SELECT 1 FROM routines WHERE id=? AND agent=?",
        [routine, owner],
    )? {
        return Err(error(404, "Routine not found."));
    }
    let revision = one(
        db,
        "SELECT revision FROM routine_flows WHERE routine=?",
        [routine],
    )?
    .map(|r| r["revision"].clone())
    .unwrap_or(json!(0));
    if revision != v["revision"] {
        return Err(error(409, "Flow changed. Reload before saving."));
    }
    let graph = validate(db, owner, &v["links"])?;
    let next = revision.as_i64().unwrap_or(0) + 1;
    db.execute("INSERT INTO routine_flows VALUES(?,?,?) ON CONFLICT(routine) DO UPDATE SET graph=excluded.graph,revision=excluded.revision",params![routine,graph.to_string(),next])?;
    Ok(json!({"graph":graph,"revision":next}))
}
pub fn route(
    db: &Connection,
    path: &str,
    p: &[&str],
    q: &[(String, String)],
    get: bool,
    v: &Value,
) -> Result<Value> {
    if path == "/api/flows" {
        let after = data::param(q, "after").unwrap_or("");
        if q.iter().any(|(k, _)| k != "after") || q.len() > 1 || !after.is_empty() && !uuid(after) {
            return Err(error(400, "Invalid flow list position."));
        }
        let mut rows=all(db,"SELECT routines.*,agents.name AS owner_name,routine_flows.graph,routine_flows.revision AS flow_revision FROM routine_flows JOIN routines ON routines.id=routine_flows.routine JOIN agents ON agents.id=routines.agent WHERE routines.id NOT IN(SELECT routine FROM local_routine_deletions) AND routines.id>? ORDER BY routines.id LIMIT 21",[after])?;
        for r in &mut rows {
            parse_graph(r)?;
        }
        let next = if rows.len() > 20 {
            rows[19]["id"].clone()
        } else {
            Value::Null
        };
        rows.truncate(20);
        return Ok(json!({"flows":rows,"next_after":next}));
    }
    let routine = routines::read(db, p[2])?;
    if p.last() == Some(&"flow-runs") {
        let mut rows=all(db,"SELECT root_turn,turns.created,graph FROM flow_runs JOIN turns ON turns.id=flow_runs.root_turn WHERE routine=? ORDER BY turns.seq DESC LIMIT 20",[p[2]])?;
        for r in &mut rows {
            parse_graph(r)?;
            r["steps"]=json!(all(db,"SELECT flow_steps.agent,agents.name,flow_steps.status,turns.status AS task_status,turns.paused,CASE WHEN threads.deleted=0 THEN turns.thread END AS thread,substr(flow_steps.result,1,1000) AS result,length(flow_steps.result) AS result_length FROM flow_steps JOIN agents ON agents.id=flow_steps.agent LEFT JOIN turns ON turns.id=flow_steps.turn LEFT JOIN threads ON threads.id=turns.thread WHERE root_turn=? ORDER BY flow_steps.rowid",[string(r,"root_turn")])?);
        }
        return Ok(json!(rows));
    }
    if get {
        return match one(
            db,
            "SELECT graph,revision FROM routine_flows WHERE routine=?",
            [p[2]],
        )? {
            Some(mut r) => {
                parse_graph(&mut r)?;
                Ok(r)
            }
            None => Ok(
                json!({"graph":{"root":routine["agent"],"nodes":[routine["agent"]],"links":[]},"revision":0}),
            ),
        };
    }
    command(db, "flow_commands", path, v, || {
        save(db, p[2], string(&routine, "agent"), v)
    })
}
pub fn snapshot(db: &Connection, routine: &str, turn: &str) -> Result<()> {
    let Some(r) = one(
        db,
        "SELECT graph FROM routine_flows WHERE routine=?",
        [routine],
    )?
    else {
        return Ok(());
    };
    let g = data::json(&r["graph"])?;
    if g["links"].as_array().is_none_or(|a| a.is_empty()) {
        return Ok(());
    }
    db.execute(
        "INSERT INTO flow_runs VALUES(?,?,?)",
        params![turn, routine, string(&r, "graph")],
    )?;
    for n in g["nodes"].as_array().ok_or_else(Failure::storage)? {
        db.execute(
            "INSERT INTO flow_steps VALUES(?,?,?,?,?)",
            params![
                turn,
                n.as_str(),
                if *n == g["root"] { Some(turn) } else { None },
                if *n == g["root"] { "queued" } else { "waiting" },
                ""
            ],
        )?;
    }
    Ok(())
}
pub fn settle(state: &AppState, db: &Connection) -> Result<()> {
    for run in all(db,"SELECT * FROM flow_runs WHERE EXISTS(SELECT 1 FROM flow_steps WHERE root_turn=flow_runs.root_turn AND status IN('waiting','queued'))",[])? {
        let root=string(&run,"root_turn");let graph=data::json(&run["graph"])?;
        for s in all(db,"SELECT f.agent,t.status,t.paused,t.no_update,t.reply,t.error FROM flow_steps f JOIN turns t ON t.id=f.turn WHERE root_turn=? AND f.status='queued'",[root])?{if s["paused"]==1||!["done","failed","cancelled"].contains(&string(&s,"status")){continue;}let status=if s["status"]=="done"{if s["no_update"]==1{"skipped"}else{"done"}}else{"failed"};db.execute("UPDATE flow_steps SET status=?,result=? WHERE root_turn=? AND agent=?",params![status,s["reply"].as_str().or(s["error"].as_str()).unwrap_or(""),root,string(&s,"agent")])?;}
        for _ in 0..32 {let rows=all(db,"SELECT agent,status,result FROM flow_steps WHERE root_turn=?",[root])?;let mut changed=false;
            for s in rows.iter().filter(|r|r["status"]=="waiting") {let agent=string(s,"agent");let parents:Vec<_>=graph["links"].as_array().ok_or_else(Failure::storage)?.iter().filter(|l|l["to"]==agent).map(|l|string(l,"from")).collect();let inputs:Vec<_>=parents.iter().filter_map(|a|rows.iter().find(|r|r["agent"]==*a)).collect();
                if inputs.len()!=parents.len()||inputs.iter().any(|r|!["done","failed","skipped"].contains(&string(r,"status"))){continue;}
                let failure=if inputs.iter().all(|r|r["status"]!="done"){Some(("skipped","No successful input. Step skipped."))}else if data::agents::hidden(db,agent)?{Some(("failed","Flow agent is hidden. Restore the agent before starting a new flow."))}else{None};
                if let Some((status,result))=failure{db.execute("UPDATE flow_steps SET status=?,result=? WHERE root_turn=? AND agent=?",params![status,result,root,agent])?;changed=true;continue;}
                let mut data=Vec::new();for r in inputs {let name=data::agents::read(db,string(r,"agent"))?["name"].clone();data.push(json!({"agent":r["agent"],"status":r["status"],"text":r["result"],"name":name}));}
                let text=format!("Continue this routine flow using the completed upstream results. Failed inputs are context, not successful work. Follow your own instructions and permissions.\n\n{}",json!(data));
                if text.len()>256*1024{db.execute("UPDATE flow_steps SET status='failed',result='Combined flow input exceeds 256 KiB. Summarize source results before starting a new flow.' WHERE root_turn=? AND agent=?",[root,agent])?;continue;}
                let (turn,_)=enqueue(state,db,agent,"Routine flow",&text)?;db.execute("UPDATE flow_steps SET turn=?,status='queued' WHERE root_turn=? AND agent=?",params![turn,root,agent])?;changed=true;
            }
if !changed{break;}
        }
    }
    Ok(())
}
