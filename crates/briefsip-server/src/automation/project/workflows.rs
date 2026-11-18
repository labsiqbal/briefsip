use super::*;
pub(super) fn root(s: &Scope, id: &str) -> Result<Value> {
    s.scope("workflows", json!([id]), id)?;
    let mut row =
        one(s.db, "SELECT * FROM workflows WHERE id=?", [id])?.ok_or_else(|| s.missing())?;
    row["homeDeviceId"] = s.home(string(&row, "agent"))?["home_device"].clone();
    Ok(row)
}
pub(super) fn version(s: &Scope, id: &str, rev: i64) -> Result<Value> {
    s.scope("workflow_versions", json!([id, rev]), id)?;
    let row = one(
        s.db,
        "SELECT graph FROM workflow_versions WHERE workflow=? AND revision=?",
        params![id, rev],
    )?
    .ok_or_else(|| s.missing())?;
    data::json(&row["graph"])
}
pub(super) fn graph(s: &Scope, owner: &str, v: &Value) -> Result<Value> {
    let g = super::super::workflows::validation::validate_scope(s.db, v, Some(s.project))
        .map_err(|e| Failure::new(400, "invalid_workflow", e.message))?;
    for n in g["nodes"].as_array().into_iter().flatten() {
        if n["kind"] == "agent" {
            s.home(string(n, "agent"))?;
        }
        if n["kind"] == "parallel" {
            return Err(Failure::new(
                400,
                "invalid_workflow",
                "Parallel steps are not supported by canonical execution.",
            ));
        }
        if let Some(channel) = n["channel"].as_str() {
            if !exists(s.db,"SELECT 1 FROM channels c JOIN channel_members m ON m.channel=c.id JOIN record_scopes s ON s.table_name='channels' AND s.key_json=json_array(c.id) AND s.root_kind='channel' AND s.root_id=c.id WHERE c.id=? AND c.archived=0 AND m.agent=? AND s.project=? AND (s.visibility='project' OR s.account=?)",[channel,owner,s.project,s.account])?{return Err(s.missing())}
        }
    }
    Ok(g)
}
fn read(s: &Scope, p: &[&str], q: &[(String, String)]) -> Result<Value> {
    let target = if p[3] == "workflows" {
        p.get(4).copied()
    } else {
        None
    };
    if let Some(id) = target {
        let mut r = root(s, id)?;
        if p.last() != Some(&"versions") {
            if !q.is_empty() {
                return Err(s.missing());
            }
            r["projectId"] = json!(s.project);
            r["graph"] = version(s, id, r["revision"].as_i64().ok_or_else(Failure::storage)?)?;
            return Ok(r);
        }
        let before = before(q, "before", 9007199254740991, || s.missing())?;
        let mut rows=all(s.db,"SELECT v.revision FROM workflow_versions v JOIN record_scopes s ON s.table_name='workflow_versions' AND s.key_json=json_array(v.workflow,v.revision) WHERE v.workflow=? AND v.revision<? AND s.project=? AND s.root_kind='workflow' AND s.root_id=v.workflow AND (s.visibility='project' OR s.account=?) ORDER BY v.revision DESC LIMIT 21",params![id,before,s.project,s.account])?;
        for r in &mut rows {
            r["graph"] = version(s, id, r["revision"].as_i64().ok_or_else(Failure::storage)?)?;
        }
        let mut items = Vec::new();
        let mut bytes = 0;
        for row in rows.iter().take(20) {
            let size = crate::db::canonical(row).len();
            if size > 240000 {
                return Err(Failure::new(
                    413,
                    "workflow_too_large",
                    "Workflow version exceeds the page limit.",
                ));
            }
            if bytes + size > 240000 {
                break;
            }
            bytes += size;
            items.push(row.clone());
        }
        let next = if items.len() < rows.len() {
            items
                .last()
                .map(|r| json!(r["revision"].to_string()))
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        return Ok(json!({"items":items,"nextCursor":next}));
    }
    let agent = if p[3] == "agents" { Some(p[4]) } else { None };
    if let Some(a) = agent {
        s.home(a)?;
    }
    if q.iter().any(|(k, _)| {
        !["after", "deleted"].contains(&k.as_str()) || q.iter().filter(|(n, _)| n == k).count() > 1
    }) || param(q, "deleted").is_some_and(|s| s != "0" && s != "1")
        || param(q, "after")
            .is_some_and(|s| !s.is_empty() && crate::web::id(s).as_deref() != Some(s))
    {
        return Err(s.missing());
    }
    let rows=all(s.db,"SELECT w.id,w.agent,w.name,w.revision,w.deleted FROM workflows w JOIN record_scopes s ON s.table_name='workflows' AND s.key_json=json_array(w.id) AND s.root_kind='workflow' AND s.root_id=w.id WHERE s.project=? AND (s.visibility='project' OR s.account=?) AND w.id>? AND w.deleted=? AND (? IS NULL OR w.agent=?) ORDER BY w.id LIMIT 21",params![s.project,s.account,param(q,"after").unwrap_or(""),i64::from(param(q,"deleted")==Some("1")),agent,agent])?;
    let mut out = Vec::new();
    let next = rows
        .get(19)
        .filter(|_| rows.len() > 20)
        .map(|r| r["id"].clone())
        .unwrap_or(Value::Null);
    for mut row in rows.into_iter().take(20) {
        if let Ok(h) = s.home(string(&row, "agent")) {
            if s.scope(
                "workflow_versions",
                json!([row["id"], row["revision"]]),
                string(&row, "id"),
            )
            .is_ok()
            {
                row["projectId"] = json!(s.project);
                row["homeDeviceId"] = h["home_device"].clone();
                out.push(row);
            }
        }
    }
    Ok(json!({"items":out,"nextCursor":next}))
}
fn save(s: &Scope, path: &str, p: &[&str], v: &Value) -> Result<Value> {
    let creating = p[3] == "agents";
    let op = if creating { "create" } else { p[5] };
    fields(
        v,
        match op {
            "create" | "edit" => &["requestId", "id", "revision", "name", "graph"],
            "restore" => &["requestId", "id", "revision", "version"],
            _ => &["requestId", "id", "revision"],
        },
    )?;
    let (request, expected) = command(v)?;
    let mut normalized = v.clone();
    if op == "create" || op == "edit" {
        normalized["name"] = json!(label(&v["name"])?);
    }
    if op == "restore" && revision(&v["version"])? == 0 {
        return Err(Failure::new(
            400,
            "invalid_revision",
            "Revision must be greater than zero.",
        ));
    }
    let workflow = if creating { request.as_str() } else { p[4] };
    let current = if creating {
        None
    } else {
        Some(root(s, workflow)?)
    };
    let owner = if creating {
        p[4]
    } else {
        current
            .as_ref()
            .map(|r| string(r, "agent"))
            .ok_or_else(|| s.missing())?
    };
    let home = s.home(owner)?;
    if creating
        && exists(s.db, "SELECT 1 FROM workflows WHERE id=?", [workflow])?
        && root(s, workflow)?["deleted"] == 1
    {
        return Err(s.missing());
    }
    if current.as_ref().is_some_and(|r| r["deleted"] == 1) && op != "delete" {
        return Err(s.missing());
    }
    let digest = s.digest(path, &normalized);
    if let Some(saved) = s.replay(path, &request, &digest)? {
        if op != "delete" {
            version(
                s,
                workflow,
                saved["receipt"]["recordRevision"]
                    .as_i64()
                    .ok_or_else(Failure::storage)?,
            )?;
        }
        return Ok(saved);
    }
    if current.as_ref().is_some_and(|r| r["deleted"] == 1) {
        return Err(s.missing());
    }
    if current
        .as_ref()
        .map(|r| r["revision"].clone())
        .unwrap_or(json!(0))
        != expected
    {
        return Err(Failure::new(
            409,
            if op == "delete" {
                "stale_revision"
            } else {
                "workflow_conflict"
            },
            if op == "delete" {
                "Workflow changed."
            } else {
                "Workflow changed. Reload before saving."
            },
        ));
    }
    let g = if op == "delete" || op == "restore" {
        version(
            s,
            workflow,
            if op == "delete" {
                expected
            } else {
                revision(&v["version"])?
            },
        )?
    } else {
        v["graph"].clone()
    };
    let g = if op == "delete" {
        g
    } else {
        graph(s, owner, &g)?
    };
    if op=="delete"&&exists(s.db,"SELECT 1 FROM workflow_runs WHERE workflow=? AND status IN('ready','waiting','approval')",[workflow])?{return Err(Failure::new(409,"workflow_active","Stop active runs first."))}
    let name = if op == "delete" || op == "restore" {
        current.as_ref().map(|r| string(r, "name")).unwrap_or("")
    } else {
        string(&normalized, "name")
    };
    s.db.execute("INSERT INTO workflows(id,agent,name,revision,deleted) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,revision=excluded.revision,deleted=excluded.deleted",params![workflow,owner,name,expected+1,op=="delete"])?;
    s.db.execute(
        "INSERT INTO workflow_versions VALUES(?,?,?)",
        params![workflow, expected + 1, crate::db::canonical(&g)],
    )?;
    let parent = if creating {
        json!({})
    } else {
        s.scope("workflows", json!([workflow]), workflow)?
    };
    if creating {
        s.map("workflows", json!([workflow]), workflow, &parent)?;
    }
    s.map(
        "workflow_versions",
        json!([workflow, expected + 1]),
        workflow,
        &parent,
    )?;
    if op == "delete" {
        s.db.execute(
            "UPDATE schedules SET enabled=0,revision=revision+1 WHERE id=?",
            [workflow],
        )?;
    }
    let mut data = if op == "delete" {
        json!({"id":workflow,"deleted":1,"revision":expected+1})
    } else {
        json!({"id":workflow,"agent":owner,"name":name,"revision":expected+1,"graph":g})
    };
    data["projectId"] = json!(s.project);
    data["homeDeviceId"] = home["home_device"].clone();
    s.observe("workflow", workflow)?;
    if op == "delete" {
        s.observe("workflow_schedule", workflow)?;
    }
    s.save(
        path,
        &request,
        &digest,
        if creating { 201 } else { 200 },
        workflow,
        expected + 1,
        data,
    )
}
pub(super) fn run_root(s: &Scope, id: &str) -> Result<(Value, Value)> {
    let mapping=one(s.db,"SELECT root_id FROM record_scopes WHERE table_name='workflow_runs' AND key_json=? AND project=? AND root_kind='workflow' AND (visibility='project' OR account=?)",params![json!([id]).to_string(),s.project,s.account])?.ok_or_else(||s.missing())?;
    let workflow = root(s, string(&mapping, "root_id"))?;
    let run = one(
        s.db,
        "SELECT * FROM workflow_runs WHERE id=? AND workflow=? AND agent=?",
        params![id, workflow["id"].as_str(), workflow["agent"].as_str()],
    )?
    .ok_or_else(|| s.missing())?;
    version(
        s,
        string(&workflow, "id"),
        run["version"].as_i64().ok_or_else(Failure::storage)?,
    )?;
    Ok((run, workflow))
}
fn runs(s: &Scope, p: &[&str], q: &[(String, String)]) -> Result<Value> {
    if p[3] == "workflow-runs" {
        let cursor = before(q, "after", 0, || s.missing())?;
        let (mut run, w) = run_root(s, p[4])?;
        let rows = all(
            s.db,
            "SELECT * FROM workflow_steps WHERE run=? AND seq>? ORDER BY seq LIMIT 21",
            params![p[4], cursor],
        )?;
        for row in rows.iter().take(20) {
            s.scope(
                "workflow_steps",
                json!([p[4], row["seq"]]),
                string(&w, "id"),
            )?;
            if let Some(t) = row["turn"].as_str() {
                if !exists(s.db,"SELECT 1 FROM record_scopes WHERE table_name='turns' AND key_json=? AND project=? AND (visibility='project' OR account=?)",params![json!([t]).to_string(),s.project,s.account])?{return Err(s.missing())}
            }
        }
        let page = page(rows, "seq");
        run["graph"] = data::json(&run["graph"])?;
        run["projectId"] = json!(s.project);
        run["homeDeviceId"] = w["homeDeviceId"].clone();
        run["stepCount"] = run["steps"].clone();
        run["steps"] = page["items"].clone();
        run["nextCursor"] = page["nextCursor"].clone();
        return Ok(run);
    }
    let cursor = before(q, "before", 9007199254740991, || s.missing())?;
    let w = root(s, p[4])?;
    let rows=all(s.db,"SELECT r.rowid AS seq,r.id,r.version,r.status,r.cursor,r.steps,r.revision,r.error,r.created,substr(r.last,1,1000) AS result FROM workflow_runs r JOIN record_scopes s ON s.table_name='workflow_runs' AND s.key_json=json_array(r.id) JOIN record_scopes v ON v.table_name='workflow_versions' AND v.key_json=json_array(r.workflow,r.version) WHERE r.workflow=? AND r.agent=? AND r.rowid<? AND s.project=? AND s.root_kind='workflow' AND s.root_id=r.workflow AND (s.visibility='project' OR s.account=?) AND v.project=s.project AND v.root_kind='workflow' AND v.root_id=r.workflow AND (v.visibility='project' OR v.account=?) ORDER BY r.rowid DESC LIMIT 21",params![p[4],w["agent"].as_str(),cursor,s.project,s.account,s.account])?;
    Ok(page(rows, "seq"))
}
pub(super) fn run_command(s: &Scope, path: &str, p: &[&str], v: &Value) -> Result<Value> {
    let op = p[5];
    fields(
        v,
        match op {
            "run" => &["requestId", "id", "revision", "input"],
            "approve" => &["requestId", "id", "revision", "accepted"],
            _ => &["requestId", "id", "revision"],
        },
    )?;
    let (request, expected) = command(v)?;
    if expected < 1 {
        return Err(Failure::new(
            400,
            "invalid_revision",
            "Revision must be greater than zero.",
        ));
    }
    if op == "run"
        && v["input"]
            .as_str()
            .is_none_or(|v| v.encode_utf16().count() > 16000)
        || op == "approve" && !v["accepted"].is_boolean()
    {
        return Err(Failure::new(
            400,
            "invalid_workflow_command",
            "Invalid workflow command.",
        ));
    }
    let (run, w) = if op == "run" {
        (None, root(s, p[4])?)
    } else {
        let (r, w) = run_root(s, p[4])?;
        (Some(r), w)
    };
    let run_id = if op == "run" { request.as_str() } else { p[4] };
    if op == "run" && exists(s.db, "SELECT 1 FROM workflow_runs WHERE id=?", [run_id])? {
        run_root(s, run_id)?;
    }
    let digest = s.digest(path, v);
    if let Some(saved) = s.replay(path, &request, &digest)? {
        if op == "run" {
            run_root(s, run_id)?;
        }
        return Ok(saved);
    }
    if w["deleted"] == 1 {
        return Err(s.missing());
    }
    if op == "run" {
        if w["revision"] != expected {
            return Err(Failure::new(409, "stale_revision", "Workflow changed."));
        }
        let (_, device) = s.device(string(&w, "agent"))?;
        let count = one(
            s.db,
            "SELECT count(*) AS n FROM workflow_runs WHERE status IN('ready','waiting','approval')",
            [],
        )?
        .ok_or_else(Failure::storage)?;
        if count["n"].as_i64().unwrap_or(0) >= 100 {
            let mut e = Failure::new(429, "server_capacity", "Workflow queue is full.");
            e.retryable = true;
            return Err(e);
        }
        let g = graph(s, string(&w, "agent"), &version(s, p[4], expected)?)?;
        s.db.execute("INSERT INTO workflow_runs(id,workflow,version,agent,graph,input,last,cursor,status,created) VALUES(?,?,?,?,?,?,?,?,'ready',?)",params![run_id,p[4],expected,w["agent"].as_str(),crate::db::canonical(&g),v["input"].as_str(),v["input"].as_str(),g["entry"].as_str(),iso(s.db,s.state.config.now())?])?;
        let parent = s.scope("workflows", json!([p[4]]), p[4])?;
        s.map(
            "workflow_runs",
            json!([run_id]),
            p[4],
            &json!({"account":s.account,"visibility":parent["visibility"]}),
        )?;
        s.observe("workflow_run", run_id)?;
        return s.save(
            path,
            &request,
            &digest,
            201,
            run_id,
            1,
            json!({"id":run_id,"projectId":s.project,"homeDeviceId":device["id"],"revision":1}),
        );
    }
    let run = run.ok_or_else(|| s.missing())?;
    if run["revision"] != expected {
        return Err(Failure::new(409, "stale_revision", "Workflow run changed."));
    }
    match op {
        "cancel" => {
            if !["ready", "waiting", "approval"].contains(&string(&run, "status")) {
                return Err(Failure::new(409, "workflow_conflict", "Run has stopped."));
            }
            for step in all(
                s.db,
                "SELECT seq FROM workflow_steps WHERE run=? AND status IN('waiting','approval')",
                [run_id],
            )? {
                s.scope(
                    "workflow_steps",
                    json!([run_id, step["seq"]]),
                    string(&w, "id"),
                )?;
            }
            cancel_tasks(s, run_id)?;
            s.db.execute("UPDATE workflow_steps SET status='cancelled',detail='Workflow cancelled.' WHERE run=? AND status IN('waiting','approval')",[run_id])?;
            s.db.execute(
                "UPDATE workflow_runs SET status='cancelled',revision=revision+1 WHERE id=?",
                [run_id],
            )?;
        }
        "approve" => {
            s.scope(
                "workflow_steps",
                json!([run_id, run["steps"]]),
                string(&w, "id"),
            )?;
            let step = one(
                s.db,
                "SELECT * FROM workflow_steps WHERE run=? AND seq=?",
                params![run_id, run["steps"].as_i64()],
            )?
            .ok_or_else(|| {
                Failure::new(409, "workflow_conflict", "Run is not waiting for approval.")
            })?;
            if run["status"] != "approval" || step["status"] != "approval" {
                return Err(Failure::new(
                    409,
                    "workflow_conflict",
                    "Run is not waiting for approval.",
                ));
            }
            let g = data::json(&run["graph"])?;
            let n = g["nodes"]
                .as_array()
                .and_then(|a| a.iter().find(|n| n["id"] == run["cursor"]))
                .ok_or_else(Failure::storage)?;
            s.db.execute(
                "UPDATE workflow_steps SET status=?,detail=? WHERE run=? AND seq=?",
                params![
                    if v["accepted"] == true {
                        "done"
                    } else {
                        "failed"
                    },
                    if v["accepted"] == true {
                        "approved"
                    } else {
                        "rejected"
                    },
                    run_id,
                    run["steps"].as_i64()
                ],
            )?;
            s.db.execute(
                "UPDATE workflow_runs SET status=?,cursor=?,error=?,revision=revision+1 WHERE id=?",
                params![
                    if v["accepted"] == true {
                        "ready"
                    } else {
                        "failed"
                    },
                    if v["accepted"] == true {
                        string(n, "yes")
                    } else {
                        string(&run, "cursor")
                    },
                    if v["accepted"] == true {
                        None
                    } else {
                        Some("Workflow approval denied.")
                    },
                    run_id
                ],
            )?;
        }
        "retry" => {
            let admission = one(
                s.db,
                "SELECT actor FROM receipts WHERE request_id=?",
                [run_id],
            )?
            .ok_or_else(missing)?;
            let original = Scope {
                account: string(&admission, "actor"),
                ..*s
            };
            original.device(string(&w, "agent")).map_err(|_| {
                Failure::new(
                    403,
                    "execution_denied",
                    "Workflow initiator authority was revoked.",
                )
            })?;
            s.device(string(&w, "agent"))?;
            s.scope(
                "workflow_steps",
                json!([run_id, run["steps"]]),
                string(&w, "id"),
            )?;
            version(
                s,
                string(&w, "id"),
                w["revision"].as_i64().ok_or_else(Failure::storage)?,
            )?;
            super::super::workflows::runtime::retry(s.state, s.db, &run, v).map_err(|e| {
                let mut failure = Failure::new(
                    e.status,
                    if e.status == 429 {
                        "server_capacity"
                    } else {
                        "workflow_conflict"
                    },
                    e.message,
                );
                failure.retryable = e.status == 429;
                failure
            })?;
            let changed = one(
                s.db,
                "SELECT retry_settings FROM workflow_runs WHERE id=?",
                [run_id],
            )?
            .ok_or_else(Failure::storage)?;
            let node = data::json(&changed["retry_settings"])?;
            if node["kind"] == "agent" {
                s.device(string(&node, "agent"))?;
            }
        }
        _ => return Err(missing()),
    }
    s.observe("workflow_run", run_id)?;
    s.save(path,&request,&digest,200,run_id,expected+1,json!({"id":run_id,"projectId":s.project,"homeDeviceId":w["homeDeviceId"],"revision":expected+1}))
}
fn cancel_tasks(s: &Scope, run: &str) -> Result<()> {
    let admission = one(
        s.db,
        "SELECT actor,project FROM receipts WHERE request_id=?",
        [run],
    )?
    .ok_or_else(|| Failure::new(409, "workflow_conflict", "Workflow admission not found."))?;
    for row in all(s.db,"SELECT k.* FROM workflow_steps s JOIN tasks k ON k.logical_turn=s.turn AND k.predecessor_task IS NULL WHERE s.run=? AND k.project=? AND k.initiator_account=? ORDER BY s.seq",params![run,admission["project"].as_str(),admission["actor"].as_str()])? {
        runtime::cancel_task(s,&row,"Workflow cancelled.")?;
    }
    Ok(())
}
fn notifications(
    s: &Scope,
    path: &str,
    p: &[&str],
    get: bool,
    q: &[(String, String)],
    v: &Value,
) -> Result<Value> {
    if get {
        let cursor = before(q, "before", 9007199254740991, || s.missing())?;
        let rows=all(s.db,"SELECT seq,run,name,created,read,read+1 AS revision,'/api/projects/'||project||'/workflow-runs/'||run AS detailRef FROM project_workflow_notifications WHERE project=? AND account=? ORDER BY seq DESC",[s.project,s.account])?;
        let visible = rows
            .into_iter()
            .filter(|r| run_root(s, string(r, "run")).is_ok())
            .collect::<Vec<_>>();
        let unread = visible.iter().filter(|r| r["read"] == 0).count();
        let mut page = page(
            visible
                .into_iter()
                .filter(|r| r["seq"].as_i64().is_some_and(|n| n < cursor))
                .take(21)
                .collect(),
            "seq",
        );
        page["unread"] = json!(unread);
        return Ok(page);
    }
    fields(v, &["requestId", "id"])?;
    let request = id(&v["requestId"])?;
    if id(&v["id"])? != request {
        return Err(Failure::new(
            400,
            "request_id_mismatch",
            "Command IDs must match.",
        ));
    }
    run_root(s, p[4])?;
    let old = one(
        s.db,
        "SELECT read FROM project_workflow_notifications WHERE project=? AND account=? AND run=?",
        [s.project, s.account, p[4]],
    )?
    .ok_or_else(|| s.missing())?;
    let digest = s.digest(path, v);
    if let Some(saved) = s.replay(path, &request, &digest)? {
        return Ok(saved);
    }
    s.db.execute(
        "UPDATE project_workflow_notifications SET read=1 WHERE project=? AND account=? AND run=?",
        [s.project, s.account, p[4]],
    )?;
    if old["read"] == 0 {
        crate::data::sync::append_record(
            s.db,
            s.project,
            "workflow_notification",
            p[4],
            Some(s.account),
            s.state.config.now(),
        )?;
    }
    s.save(
        path,
        &request,
        &digest,
        200,
        p[4],
        2,
        json!({"run":p[4],"read":1,"revision":2}),
    )
}
fn schedule_view(row: &Value) -> Result<Value> {
    Ok(
        json!({"id":row["id"],"projectId":row["project"],"agentId":row["agent"],"homeDeviceId":row["home_device"],"initiatorAccountId":row["initiator_account"],"assignmentRevision":row["assignment_revision"],"authorityGeneration":row["authority_generation"],"revision":row["revision"],"zone":row["zone"],"zoneRevision":row["zone_revision"],"spec":data::json(&row["spec_json"])?,"nextAt":row["next_at"],"enabled":row["enabled"]==1,"input":row["input"]}),
    )
}
fn schedule(
    s: &Scope,
    path: &str,
    id: &str,
    get: bool,
    q: &[(String, String)],
    v: &Value,
) -> Result<Value> {
    let w = root(s, id)?;
    version(s, id, w["revision"].as_i64().ok_or_else(Failure::storage)?)?;
    let previous=one(s.db,"SELECT s.*,t.input FROM schedules s JOIN workflow_schedule_targets t ON t.schedule=s.id WHERE s.id=? AND s.project=? AND t.workflow=?",[id,s.project,id])?;
    if get {
        let cursor = before(q, "before", 9007199254740991, || {
            Failure::new(404, "resource_not_found", "Schedule not found.")
        })?;
        let Some(row) = previous else {
            return Ok(json!({"schedule":null,"occurrences":[],"nextCursor":null}));
        };
        let rows=all(s.db,"SELECT rowid AS seq,occurrence_id AS occurrenceId,due_at AS dueAt,schedule_revision AS scheduleRevision,zone_revision AS zoneRevision,initiator_account AS initiatorAccountId,assignment_revision AS assignmentRevision,authority_generation AS authorityGeneration,task AS taskId,state,missed_count AS missedCount,CASE WHEN state='admitted' THEN run ELSE NULL END AS runId FROM occurrences WHERE schedule=? AND rowid<? ORDER BY rowid DESC LIMIT 21",params![id,cursor])?;
        let page = page(rows, "seq");
        let mut data = schedule_view(&row)?;
        data["occurrences"] = page["items"].clone();
        data["nextCursor"] = page["nextCursor"].clone();
        return Ok(data);
    }
    fields(
        v,
        &["requestId", "id", "revision", "spec", "input", "enabled"],
    )?;
    let (request, expected) = command(v)?;
    let spec =
        super::super::schedule::parse(&v["spec"]).map_err(super::routines::schedule_error)?;
    if v["input"]
        .as_str()
        .is_none_or(|v| v.encode_utf16().count() > 16000)
        || !v["enabled"].is_boolean()
    {
        return Err(Failure::new(400, "invalid_schedule", "Invalid schedule."));
    }
    if w["deleted"] == 1 {
        return Err(Failure::new(
            404,
            "resource_not_found",
            "Schedule not found.",
        ));
    }
    let digest = s.digest(path, v);
    if let Some(saved) = s.replay(path, &request, &digest)? {
        return Ok(saved);
    }
    if previous
        .as_ref()
        .map(|r| r["revision"].clone())
        .unwrap_or(json!(0))
        != expected
    {
        return Err(Failure::new(409, "stale_revision", "Schedule changed."));
    }
    let (home, device) = s.device(string(&w, "agent"))?;
    let same = previous
        .as_ref()
        .and_then(|r| data::json(&r["spec_json"]).ok())
        .as_ref()
        == Some(&spec);
    if spec["kind"] == "legacy_interval" && !same {
        return Err(Failure::new(400, "invalid_schedule", "Invalid schedule."));
    }
    let timing = same
        && previous.as_ref().is_some_and(|r| {
            r["next_at"].is_null()
                || (spec["kind"] != "once" && spec["kind"] != "cron")
                || r["zone"] == device["zone"] && r["zone_revision"] == device["zone_revision"]
        });
    let next = if timing {
        previous
            .as_ref()
            .map(|r| r["next_at"].clone())
            .unwrap_or(Value::Null)
    } else if spec["kind"] == "cron" {
        json!(
            super::super::schedule::local(&spec, string(&device, "zone"), s.state.config.now())
                .map_err(super::routines::schedule_error)?
                .1
        )
    } else {
        json!(super::routines::timing(
            &spec,
            string(&device, "zone"),
            s.state.config.now()
        )?)
    };
    if v["enabled"]==true&&(same&&next.is_null()||["once","instant"].contains(&string(&spec,"kind"))&&exists(s.db,"SELECT 1 FROM occurrences WHERE schedule=? AND due_at=? AND state IN('admitted','consumed')",params![id,next.as_i64()])?){return Err(Failure::new(409,"schedule_processed","Scheduled time was already processed. Choose a new time."))}
    let generation = one(
        s.db,
        "SELECT generation FROM authority_state WHERE id=1 AND serving_state='active'",
        [],
    )?
    .ok_or_else(|| s.missing())?;
    let blocked=all(s.db,"UPDATE occurrences SET state='blocked' WHERE schedule=? AND state='pending' RETURNING occurrence_id",[id])?;
    s.db.execute("INSERT INTO schedules(id,project,agent,home_device,initiator_account,assignment_revision,authority_generation,kind,zone,zone_revision,spec_json,next_at,enabled,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET initiator_account=excluded.initiator_account,assignment_revision=excluded.assignment_revision,authority_generation=excluded.authority_generation,kind=excluded.kind,zone=excluded.zone,zone_revision=excluded.zone_revision,spec_json=excluded.spec_json,next_at=excluded.next_at,enabled=excluded.enabled,revision=excluded.revision",params![id,s.project,w["agent"].as_str(),w["homeDeviceId"].as_str(),s.account,home["assignment"].as_i64(),generation["generation"].as_str(),spec["kind"].as_str(),device["zone"].as_str(),device["zone_revision"].as_i64(),crate::db::canonical(&spec),next.as_i64(),v["enabled"]==true,expected+1])?;
    s.db.execute("INSERT INTO workflow_schedule_targets VALUES(?,?,?) ON CONFLICT(schedule) DO UPDATE SET input=excluded.input",params![id,id,v["input"].as_str()])?;
    s.observe("workflow_schedule", id)?;
    for old in blocked {
        s.observe(
            "workflow_schedule_occurrence",
            &json!([id, old["occurrence_id"]]).to_string(),
        )?;
    }
    let row=one(s.db,"SELECT s.*,t.input FROM schedules s JOIN workflow_schedule_targets t ON t.schedule=s.id WHERE s.id=?",[id])?.ok_or_else(Failure::storage)?;
    s.save(
        path,
        &request,
        &digest,
        if previous.is_some() { 200 } else { 201 },
        id,
        expected + 1,
        schedule_view(&row)?,
    )
}
pub(super) fn route(
    s: &Scope,
    path: &str,
    p: &[&str],
    method: &Method,
    q: &[(String, String)],
    v: &Value,
) -> Result<Response> {
    let get = *method == Method::GET;
    if p[3] == "workflow-notifications" {
        if get && p.len() == 4 {
            return Ok(read_response(notifications(s, path, p, true, q, v)?));
        }
        if !get && p.len() == 6 {
            return envelope(notifications(s, path, p, false, q, v)?);
        }
        return Err(missing());
    }
    if p.last() == Some(&"schedule") {
        let value = schedule(s, path, p[4], get, q, v)?;
        return if get {
            Ok(read_response(value))
        } else {
            envelope(value)
        };
    }
    if get && (p[3] == "workflow-runs" && p.len() == 5 || p.last() == Some(&"runs")) {
        return Ok(read_response(runs(s, p, q)?));
    }
    if get && (p[3] == "agents" || p.len() == 4 || p.len() == 5 || p.last() == Some(&"versions")) {
        return Ok(read_response(read(s, p, q)?));
    }
    if !get && p.len() == 6 && ["run", "approve", "cancel", "retry"].contains(&p[5]) {
        return envelope(run_command(s, path, p, v)?);
    }
    if !get && (p[3] == "agents" || p.len() == 6 && ["edit", "restore", "delete"].contains(&p[5])) {
        return envelope(save(s, path, p, v)?);
    }
    Err(missing())
}
