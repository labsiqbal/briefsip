use super::*;

pub fn tool(db: &Connection, task: &Value, name: &str, args: &Value) -> Result<Value> {
    let agent = string(task, "agent");
    let scope="JOIN record_scopes s ON s.table_name='routines' AND s.key_json=json_array(r.id) AND s.project=? AND s.root_kind='agent' AND s.root_id=r.agent AND(s.visibility='project' OR s.account=?)";
    if name == "list_routines" {
        let after = args.get("after").map(id).transpose()?.unwrap_or_default();
        let mut rows=all(db,&format!("SELECT r.id,r.name,r.enabled,r.trigger,r.next_at,r.interval_ms,r.revision FROM routines r {scope} WHERE r.agent=? AND r.id>? ORDER BY r.id LIMIT 11"),[string(task,"project"),string(task,"initiator_account"),agent,&after])?;
        let next = if rows.len() > 10 {
            rows[9]["id"].clone()
        } else {
            Value::Null
        };
        rows.truncate(10);
        return Ok(json!({"routines":rows,"next_after":next}));
    }
    let routine = id(&args["id"])?;
    let row=one(db,&format!("SELECT r.id,r.name,r.prompt,r.enabled,r.trigger,r.next_at,r.interval_ms,r.revision,s.account,s.visibility FROM routines r {scope} WHERE r.agent=? AND r.id=?"),[string(task,"project"),string(task,"initiator_account"),agent,&routine])?.ok_or_else(||fail(404,"resource_not_found","Routine not found for this agent."))?;
    let flow = one(
        db,
        "SELECT graph,revision FROM routine_flows WHERE routine=?",
        [&routine],
    )?;
    if flow.is_some() && !exists(db,"SELECT 1 FROM record_scopes WHERE table_name='routine_flows' AND key_json=? AND project=? AND root_kind='agent' AND root_id=? AND(visibility='project' OR account=?)",[canonical(&json!([routine])),string(task,"project").to_owned(),agent.to_owned(),string(task,"initiator_account").to_owned()])?{return Err(fail(404,"resource_not_found","Routine flow not found for this project."))}
    if name == "read_routine" {
        let flow = match flow {
            Some(f) => json!({"graph":data::json(&f["graph"])?,"revision":f["revision"]}),
            None => json!({"graph":{"root":agent,"nodes":[agent],"links":[]},"revision":0}),
        };
        let mut row = row;
        row.as_object_mut()
            .ok_or_else(Failure::storage)?
            .remove("account");
        row.as_object_mut()
            .ok_or_else(Failure::storage)?
            .remove("visibility");
        row["flow"] = flow;
        return Ok(row);
    }
    let revision = revision(&args["revision"], 0)?;
    if revision == 9007199254740991 {
        return Err(fail(400, "invalid_revision", "Invalid flow revision."));
    }
    if revision != flow.as_ref().map(|r| n(r, "revision")).unwrap_or(0) {
        return Err(stale());
    }
    if let Some(links) = args["links"].as_array() {
        for link in links {
            for key in ["from", "to"] {
                if link[key].as_str().is_some_and(|a| {
                    !exists(
                        db,
                        "SELECT 1 FROM agent_projects WHERE project=? AND agent=? AND deleted=0",
                        [string(task, "project"), a],
                    )
                    .unwrap_or(false)
                }) {
                    return Err(fail(404, "resource_not_found", "Routine agent not found."));
                }
            }
        }
    }
    let graph = crate::automation::flows::validate_scope(
        db,
        agent,
        &args["links"],
        Some(string(task, "project")),
    )?;
    for node in graph["nodes"].as_array().into_iter().flatten() {
        self::agent(db, task, node.as_str().ok_or_else(Failure::storage)?)
            .map_err(|_| fail(404, "resource_not_found", "Routine agent not found."))?;
    }
    db.execute("INSERT INTO routine_flows VALUES(?,?,?) ON CONFLICT(routine) DO UPDATE SET graph=excluded.graph,revision=excluded.revision",params![routine,canonical(&graph),revision+1])?;
    if flow.is_none() {
        db.execute(
            "INSERT INTO record_scopes VALUES('routine_flows',?,?,?,?,'agent',?)",
            params![
                canonical(&json!([routine])),
                string(&row, "account"),
                string(task, "project"),
                string(&row, "visibility"),
                agent
            ],
        )?;
    }
    Ok(json!({"graph":graph,"revision":revision+1}))
}

fn denied() -> Failure {
    fail(403, "execution_denied", "Automation authority is invalid.")
}
fn scope(
    db: &Connection,
    task: &Value,
    table: &str,
    key: Value,
    kind: &str,
    root: &str,
) -> Result<()> {
    if !exists(db,"SELECT 1 FROM record_scopes WHERE table_name=? AND key_json=? AND project=? AND root_kind=? AND root_id=? AND (visibility='project' OR account=?)",params![table,canonical(&key),string(task,"project"),kind,root,string(task,"initiator_account")])? {
        return Err(denied());
    }
    Ok(())
}
fn agent(db: &Connection, task: &Value, agent: &str) -> Result<Value> {
    one(db,"SELECT d.id FROM projects p JOIN project_members m ON m.project=p.id AND m.account=? AND m.deleted=0 JOIN accounts a ON a.id=m.account AND a.blocked=0 JOIN accounts o ON o.id=p.account AND o.blocked=0 JOIN agent_projects ap ON ap.project=p.id AND ap.agent=? AND ap.deleted=0 JOIN agent_authority h ON h.agent=ap.agent AND h.owner_account=p.account JOIN record_scopes s ON s.table_name='agents' AND s.key_json=json_array(ap.agent) AND s.account=p.account AND s.root_kind='agent' AND s.root_id=ap.agent JOIN devices d ON d.id=h.home_device AND d.account=p.account AND d.status NOT IN('revoked','blocked') JOIN installations i ON i.id=d.installation AND i.account=d.account AND i.revoked=0 WHERE p.id=? AND p.deleted=0 AND (m.role='owner' OR EXISTS(SELECT 1 FROM collaborator_agents c WHERE c.project=p.id AND c.account=m.account AND c.agent=ap.agent AND c.enabled=1)) AND EXISTS(SELECT 1 FROM json_each(d.capabilities_json) WHERE value='execution') AND (h.provider_binding IS NULL OR EXISTS(SELECT 1 FROM provider_bindings b WHERE b.id=h.provider_binding AND b.device=d.id AND b.owner_account=p.account))",[string(task,"initiator_account"),agent,string(task,"project")])?.ok_or_else(denied)
}
pub fn routine_step(db: &Connection, task: &Value) -> Result<Option<Value>> {
    let family = authority::ancestors(db, task)?;
    let ids = json!(family.iter().map(|r| r["id"].clone()).collect::<Vec<_>>());
    one(db,"SELECT s.*,o.routine,o.project,o.initiator_account,o.authority_generation,o.state occurrence_state FROM routine_steps s JOIN routine_occurrences o ON o.id=s.occurrence WHERE s.turn IN(SELECT value FROM json_each(?))",[canonical(&ids)])
}
pub fn dispatch(db: &Connection, task: &Value) -> Result<Option<Value>> {
    if let Some(step) = routine_step(db, task)? {
        let root = one(
            db,
            "SELECT agent FROM routines WHERE id=?",
            [string(&step, "routine")],
        )?
        .ok_or_else(denied)?;
        for (table, key) in [
            ("routines", json!([step["routine"]])),
            ("routine_occurrences", json!([step["occurrence"]])),
        ] {
            scope(db, task, table, key, "agent", string(&root, "agent"))?;
        }
        agent(db, task, string(&root, "agent"))?;
        agent(db, task, string(task, "agent"))?;
        let executable = if task["logical_turn"] == step["turn"] {
            step["occurrence_state"] == "admitted" && step["state"] == "queued"
        } else {
            matches!(string(&step, "occurrence_state"), "admitted" | "done")
                && matches!(string(&step, "state"), "queued" | "done")
        };
        let generation = one(
            db,
            "SELECT generation FROM authority_state WHERE id=1 AND serving_state='active'",
            [],
        )?
        .ok_or_else(denied)?;
        if step["project"] != task["project"]
            || step["initiator_account"] != task["initiator_account"]
            || step["authority_generation"] != generation["generation"]
            || !matches!(string(task, "state"), "completed" | "failed") && !executable
        {
            return Err(denied());
        }
    }
    let family = authority::ancestors(db, task)?;
    let ids = json!(family.iter().map(|r| r["id"].clone()).collect::<Vec<_>>());
    let Some(step) = one(
        db,
        "SELECT * FROM workflow_steps WHERE turn IN(SELECT value FROM json_each(?))",
        [canonical(&ids)],
    )?
    else {
        return Ok(None);
    };
    let run = one(
        db,
        "SELECT * FROM workflow_runs WHERE id=?",
        [string(&step, "run")],
    )?
    .ok_or_else(denied)?;
    let receipt = one(db,"SELECT actor,project,scope FROM receipts WHERE request_id=? AND json_extract(result_json,'$.receipt.recordId')=?",[string(&run,"id"),string(&run,"id")])?.ok_or_else(denied)?;
    if receipt["actor"] != task["initiator_account"]
        || receipt["project"] != task["project"]
        || receipt["scope"]
            != format!(
                "retained:/api/projects/{}/workflows/{}/run",
                string(task, "project"),
                string(&run, "workflow")
            )
    {
        return Err(denied());
    }
    for (table, key) in [
        ("workflow_runs", json!([run["id"]])),
        ("workflows", json!([run["workflow"]])),
        (
            "workflow_versions",
            json!([run["workflow"], run["version"]]),
        ),
        ("workflow_steps", json!([step["run"], step["seq"]])),
    ] {
        scope(db, task, table, key, "workflow", string(&run, "workflow"))?;
    }
    let config = one(
        db,
        "SELECT agent FROM workflows WHERE id=? AND deleted=0",
        [string(&run, "workflow")],
    )?
    .ok_or_else(denied)?;
    let version = one(
        db,
        "SELECT graph FROM workflow_versions WHERE workflow=? AND revision=?",
        params![string(&run, "workflow"), n(&run, "version")],
    )?
    .ok_or_else(denied)?;
    if config["agent"] != run["agent"]
        || data::json(&version["graph"])? != data::json(&run["graph"])?
    {
        return Err(denied());
    }
    agent(db, task, string(&run, "agent"))?;
    let executable = if task["logical_turn"] == step["turn"] {
        run["status"] == "waiting" && run["steps"] == step["seq"] && step["status"] == "waiting"
    } else {
        matches!(
            string(&run, "status"),
            "ready" | "waiting" | "approval" | "done"
        ) && matches!(string(&step, "status"), "waiting" | "done")
    };
    if task["state"] != "completed" && !executable {
        return Err(denied());
    }
    let graph = data::json(&run["graph"])?;
    let node = if step["settings"].is_string() {
        data::json(&step["settings"])?
    } else {
        graph["nodes"]
            .as_array()
            .and_then(|ns| ns.iter().find(|n| n["id"] == step["node"]))
            .cloned()
            .ok_or_else(denied)?
    };
    if !matches!(string(&node, "kind"), "agent" | "model")
        && !(node["kind"] == "condition" && node["operator"] == "model")
    {
        return Err(denied());
    }
    let target = if node["kind"] == "agent" {
        string(&node, "agent")
    } else {
        string(&run, "agent")
    };
    let home = agent(db, task, target)?;
    if task["logical_turn"] == step["turn"]
        && task["predecessor_task"].is_null()
        && (task["agent"] != target || task["home_device"] != home["id"])
    {
        return Err(denied());
    }
    Ok(Some(run))
}
