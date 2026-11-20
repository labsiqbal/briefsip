use super::*;
const COLUMNS: &str =
    "r.id,r.agent,r.name,r.prompt,r.next_at,r.interval_ms,r.enabled,r.revision,r.trigger";
fn invalid() -> Failure {
    Failure::new(400, "invalid_routine", "Invalid routine.")
}
pub(super) fn root(s: &Scope, id: &str) -> Result<Value> {
    let mut row = one(
        s.db,
        &format!("SELECT {COLUMNS} FROM routines r WHERE r.id=?"),
        [id],
    )?
    .ok_or_else(|| s.missing())?;
    s.scope("routines", json!([id]), string(&row, "agent"))?;
    row["homeDeviceId"] = s.home(string(&row, "agent"))?["home_device"].clone();
    row["projectId"] = json!(s.project);
    Ok(row)
}
pub(super) fn spec(s: &Scope, r: &Value) -> Result<Value> {
    if let Some(row) = one(
        s.db,
        "SELECT spec_json FROM routine_schedule_bindings WHERE routine=?",
        [string(r, "id")],
    )? {
        if row["spec_json"].is_string() {
            return data::json(&row["spec_json"]);
        }
    }
    Ok(if r["interval_ms"].is_null() {
        json!({"kind":"instant","at":r["next_at"]})
    } else {
        json!({"kind":"interval","amount":r["interval_ms"].as_f64().unwrap_or(0.)/60000.,"unit":"minute","anchorAt":r["next_at"]})
    })
}
pub(super) fn flow(s: &Scope, r: &Value) -> Result<Value> {
    let Some(mut row) = one(
        s.db,
        "SELECT graph,revision FROM routine_flows WHERE routine=?",
        [string(r, "id")],
    )?
    else {
        return Ok(
            json!({"graph":{"root":r["agent"],"nodes":[r["agent"]],"links":[]},"revision":0}),
        );
    };
    s.scope("routine_flows", json!([r["id"]]), string(r, "agent"))?;
    row["graph"] = data::json(&row["graph"])?;
    Ok(row)
}
fn read(s: &Scope, p: &[&str], q: &[(String, String)]) -> Result<Value> {
    let agent = if p[3] == "agents" { Some(p[4]) } else { None };
    let target = if p[3] == "routines" {
        p.get(4).copied()
    } else {
        None
    };
    if let Some(id) = target {
        let mut r = root(s, id)?;
        if p.last() == Some(&"runs") {
            let cursor = before(q, "before", 9007199254740991, || s.missing())?;
            let mut rows=all(s.db,"SELECT o.seq,o.id,o.due_at AS dueAt,o.schedule_revision AS scheduleRevision,o.zone,o.zone_revision AS zoneRevision,o.schedule_kind AS scheduleKind,o.source,o.missed_count AS missedCount,o.state,o.task AS taskId FROM routine_occurrences o JOIN record_scopes s ON s.table_name='routine_occurrences' AND s.key_json=json_array(o.id) WHERE o.routine=? AND o.project=? AND o.seq<? AND s.project=o.project AND s.root_kind='agent' AND s.root_id=? AND (s.visibility='project' OR s.account=?) ORDER BY o.seq DESC LIMIT 21",params![id,s.project,cursor,r["agent"].as_str(),s.account])?;
            for row in &mut rows {
                row["steps"]=json!(all(s.db,"SELECT agent AS agentId,turn AS taskId,state,substr(result,1,1000) AS preview FROM routine_steps WHERE occurrence=? ORDER BY agent",[string(row,"id")])?);
            }
            let mut items = Vec::new();
            let mut bytes = 0;
            for row in rows.iter().take(20) {
                let size = crate::db::canonical(row).len();
                if bytes + size > 240000 {
                    break;
                }
                bytes += size;
                items.push(row.clone());
            }
            let next = if items.len() < rows.len() {
                items
                    .last()
                    .map(|r| json!(r["seq"].to_string()))
                    .unwrap_or(Value::Null)
            } else {
                Value::Null
            };
            return Ok(json!({"items":items,"nextCursor":next}));
        }
        if !q.is_empty() {
            return Err(s.missing());
        }
        let f = flow(s, &r)?;
        if p.last() == Some(&"flow") {
            return Ok(f);
        }
        r["schedule"] = spec(s, &r)?;
        r["flow"] = f;
        return Ok(r);
    }
    if let Some(a) = agent {
        s.home(a)?;
    }
    if q.iter().any(|(k, _)| k != "after")
        || q.len() > 1
        || param(q, "after").is_some_and(|a| !uuid(a))
    {
        return Err(s.missing());
    }
    let mut rows=all(s.db,&format!("SELECT {COLUMNS},h.home_device AS homeDeviceId FROM routines r JOIN record_scopes s ON s.table_name='routines' AND s.key_json=json_array(r.id) AND s.root_kind='agent' AND s.root_id=r.agent JOIN projects p ON p.id=s.project JOIN accounts o ON o.id=p.account AND o.blocked=0 JOIN agent_projects ap ON ap.agent=r.agent AND ap.project=p.id AND ap.deleted=0 JOIN agent_authority h ON h.agent=r.agent AND h.owner_account=p.account JOIN record_scopes a ON a.table_name='agents' AND a.key_json=json_array(r.agent) AND a.account=p.account AND a.root_kind='agent' AND a.root_id=r.agent JOIN project_members m ON m.project=p.id AND m.account=? AND m.deleted=0 WHERE s.project=? AND (s.visibility='project' OR s.account=m.account) AND (? IS NULL OR r.agent=?) AND r.id>? AND (m.role='owner' OR EXISTS(SELECT 1 FROM collaborator_agents c WHERE c.project=p.id AND c.account=m.account AND c.agent=r.agent AND c.enabled=1)) ORDER BY r.id LIMIT 21"),params![s.account,s.project,agent,agent,param(q,"after").unwrap_or("")])?;
    for r in &mut rows {
        r["projectId"] = json!(s.project);
        r["schedule"] = spec(s, r)?;
    }
    Ok(page(rows, "id"))
}
pub(super) fn timing(spec: &Value, zone: &str, now: i64) -> Result<i64> {
    match string(spec, "kind") {
        "instant" => spec["at"].as_i64().ok_or_else(invalid),
        "once" => schedule::once(spec, zone)
            .and_then(schedule::valid_epoch)
            .map_err(schedule_error),
        "cron" => {
            let mut next = None;
            schedule::scan(
                string(spec, "expression"),
                zone,
                now,
                now.saturating_add(1825 * 86400000),
                |at, index| {
                    if index == 0 {
                        next = Some(at);
                        Ok(false)
                    } else {
                        Ok(true)
                    }
                },
            )
            .map_err(schedule_error)?;
            next.ok_or_else(|| {
                Failure::new(
                    422,
                    "schedule_unsatisfiable",
                    "Cron has no occurrence within 1,825 days.",
                )
            })
        }
        _ => spec["anchorAt"].as_i64().ok_or_else(invalid),
    }
}
pub(super) fn schedule_error(mut e: Failure) -> Failure {
    e.code = if e.status == 422 {
        "invalid_zone"
    } else {
        "invalid_schedule"
    };
    e
}
fn save(s: &Scope, path: &str, p: &[&str], v: &Value) -> Result<Value> {
    let creating = p[3] == "agents";
    let op = if creating { "create" } else { p[5] };
    fields(
        v,
        if op == "flow" {
            &["requestId", "id", "revision", "links"]
        } else {
            &[
                "requestId",
                "id",
                "revision",
                "name",
                "prompt",
                "nextAt",
                "intervalSeconds",
                "schedule",
                "enabled",
                "trigger",
            ]
        },
    )?;
    let (request, expected) = command(v)?;
    let mut normalized = v.clone();
    let mut schedule = None;
    if op != "flow" {
        if v.get("schedule").is_some() {
            if v.get("nextAt").is_some() || v.get("intervalSeconds").is_some() {
                return Err(invalid());
            }
            let spec = schedule::parse(&v["schedule"]).map_err(schedule_error)?;
            if spec["kind"] == "legacy_interval" {
                return Err(invalid());
            }
            schedule = Some(spec);
        }
        if v["prompt"]
            .as_str()
            .is_none_or(|p| p.trim().is_empty() || p.encode_utf16().count() > 16000)
            || !v["enabled"].is_boolean()
            || schedule.is_none() && !integer(&v["nextAt"], 0, schedule::MAX_TIME)
            || !v["intervalSeconds"].is_null() && !integer(&v["intervalSeconds"], 60, 31536000)
            || v.get("trigger")
                .is_some_and(|t| t != "schedule" && t != "webhook")
        {
            return Err(invalid());
        }
        normalized["name"] = json!(label(&v["name"])?);
        normalized["prompt"] = json!(string(v, "prompt").trim());
        if schedule.is_none() {
            normalized["intervalSeconds"] = v["intervalSeconds"].clone();
            schedule = Some(if v["intervalSeconds"].is_null() {
                json!({"kind":"instant","at":v["nextAt"]})
            } else {
                json!({"kind":"interval","amount":v["intervalSeconds"].as_f64().unwrap_or(0.)/60.,"unit":"minute","anchorAt":v["nextAt"]})
            });
        }
    }
    let routine = if creating { request.as_str() } else { p[4] };
    let current = if creating {
        None
    } else {
        Some(root(s, routine)?)
    };
    let agent = if creating {
        p[4]
    } else {
        current
            .as_ref()
            .map(|r| string(r, "agent"))
            .ok_or_else(invalid)?
    };
    let home = s.home(agent)?;
    if op == "flow" {
        flow(s, current.as_ref().ok_or_else(invalid)?)?;
    }
    let digest = s.digest(path, &normalized);
    if let Some(old) = s.replay(path, &request, &digest)? {
        root(s, routine)?;
        return Ok(old);
    }
    if expected == 9007199254740991 {
        return Err(invalid());
    }
    let result = if op == "flow" {
        let current = current.as_ref().ok_or_else(invalid)?;
        if flow(s, current)?["revision"] != expected {
            return Err(Failure::new(409, "stale_revision", "Flow changed."));
        }
        let graph = flows::validate_scope(s.db, agent, &v["links"], Some(s.project))
            .map_err(|e| Failure::new(400, "invalid_flow", e.message))?;
        for a in graph["nodes"].as_array().into_iter().flatten() {
            s.home(a.as_str().ok_or_else(invalid)?)?;
        }
        s.db.execute("INSERT INTO routine_flows VALUES(?,?,?) ON CONFLICT(routine) DO UPDATE SET graph=excluded.graph,revision=excluded.revision",params![routine,crate::db::canonical(&graph),expected+1])?;
        if s.scope("routine_flows", json!([routine]), agent).is_err() {
            let parent = s.scope("routines", json!([routine]), agent)?;
            s.map("routine_flows", json!([routine]), agent, &parent)?;
        }
        json!({"graph":graph,"revision":expected+1})
    } else {
        if current
            .as_ref()
            .map(|r| r["revision"].clone())
            .unwrap_or(json!(0))
            != expected
        {
            return Err(Failure::new(409, "stale_revision", "Routine changed."));
        }
        let spec = schedule.ok_or_else(invalid)?;
        let (_, device) = s.device(agent)?;
        let duration = if v.get("schedule").is_some() {
            schedule::interval(&spec)
        } else {
            v["intervalSeconds"].as_i64().unwrap_or(0) * 1000
        };
        if v.get("schedule").is_none()
            && duration > 0
            && duration < 300000
            && current
                .as_ref()
                .is_none_or(|r| r["interval_ms"] != duration)
        {
            return Err(invalid());
        }
        let previous = one(
            s.db,
            "SELECT * FROM routine_schedule_bindings WHERE routine=?",
            [routine],
        )?;
        let same = current
            .as_ref()
            .is_some_and(|r| self::spec(s, r).ok().as_ref() == Some(&spec));
        let next = if same
            && previous.as_ref().is_some_and(|b| {
                (spec["kind"] != "once" && spec["kind"] != "cron")
                    || (b["zone"] == device["zone"]
                        && b["zone_revision"] == device["zone_revision"])
            }) {
            current
                .as_ref()
                .and_then(|r| r["next_at"].as_i64())
                .ok_or_else(invalid)?
        } else if spec["kind"] == "cron" {
            schedule::next_cron(
                string(&spec, "expression"),
                string(&device, "zone"),
                s.state.config.now(),
                true,
            )
            .map_err(|error| {
                if error.code == "schedule_unsatisfiable" {
                    error
                } else {
                    schedule_error(error)
                }
            })?
        } else {
            timing(&spec, string(&device, "zone"), s.state.config.now())?
        };
        if v["enabled"]==true&&v["trigger"].as_str().or_else(||current.as_ref().and_then(|r|r["trigger"].as_str())).unwrap_or("schedule")=="schedule"&&exists(s.db,"SELECT 1 FROM routine_occurrences WHERE routine=? AND due_at=? AND source='schedule' AND task IS NOT NULL",params![routine,if v.get("schedule").is_none(){v["nextAt"].as_i64().unwrap_or(next)}else{next}])?{return Err(Failure::new(409,"schedule_processed","Scheduled time was already processed. Choose a new time."))}
        if creating {
            if exists(s.db, "SELECT 1 FROM routines WHERE id=?", [routine])? {
                root(s, routine)?;
                return Err(Failure::new(
                    409,
                    "resource_conflict",
                    "Routine ID was already used.",
                ));
            }
            s.db.execute("INSERT INTO routines(id,agent,name,prompt,next_at,interval_ms,enabled,trigger) VALUES(?,?,?,?,?,?,?,?)",params![routine,agent,normalized["name"].as_str(),normalized["prompt"].as_str(),next,if duration==0{None}else{Some(duration)},v["enabled"]==true,v["trigger"].as_str().unwrap_or("schedule")])?;
            s.map("routines", json!([routine]), agent, &json!({}))?;
        } else {
            s.db.execute("UPDATE routines SET name=?,prompt=?,next_at=?,interval_ms=?,enabled=?,trigger=?,revision=revision+1 WHERE id=?",params![normalized["name"].as_str(),normalized["prompt"].as_str(),next,if duration==0{None}else{Some(duration)},v["enabled"]==true,v["trigger"].as_str().unwrap_or_else(||current.as_ref().map(|r|string(r,"trigger")).unwrap_or("schedule")),routine])?;
        }
        for old in all(s.db,"UPDATE routine_occurrences SET state='blocked' WHERE routine=? AND state='pending' RETURNING id",[routine])?{s.observe("routine_occurrence",string(&old,"id"))?;}
        let owners = exists(
            s.db,
            "SELECT 1 FROM sqlite_schema WHERE name='execution_owners'",
            [],
        )?;
        for task in all(s.db,"SELECT k.*,o.id AS occurrence FROM routine_occurrences o JOIN tasks k ON k.id=o.task WHERE o.routine=? AND o.state='admitted' AND k.state IN('queued','waiting_device','waiting_resource')",[routine])? {
            if owners && exists(s.db, "SELECT 1 FROM execution_owners WHERE task=?", [string(&task,"id")])? {continue}
            runtime::cancel_task(s, &task, "Routine changed before execution.")?;
            s.db.execute("UPDATE routine_occurrences SET state='blocked' WHERE id=?",[string(&task,"occurrence")])?;
            s.db.execute("UPDATE routine_steps SET state='failed',result='The routine changed before the run.' WHERE occurrence=? AND state IN('waiting','queued')",[string(&task,"occurrence")])?;
            s.observe("routine_occurrence", string(&task,"occurrence"))?;
        }
        let generation = one(
            s.db,
            "SELECT generation FROM authority_state WHERE id=1",
            [],
        )?
        .ok_or_else(Failure::storage)?;
        s.db.execute("INSERT INTO routine_schedule_bindings VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(routine) DO UPDATE SET initiator_account=excluded.initiator_account,assignment_revision=excluded.assignment_revision,authority_generation=excluded.authority_generation,zone=excluded.zone,zone_revision=excluded.zone_revision,spec_json=excluded.spec_json",params![routine,s.project,s.account,home["assignment"].as_i64(),generation["generation"].as_str(),home["home_device"].as_str(),device["zone"].as_str(),device["zone_revision"].as_i64(),crate::db::canonical(&spec)])?;
        let mut row = root(s, routine)?;
        row["schedule"] = spec;
        row
    };
    s.observe(
        if op == "flow" {
            "routine_flow"
        } else {
            "routine"
        },
        routine,
    )?;
    s.save(
        path,
        &request,
        &digest,
        if creating { 201 } else { 200 },
        routine,
        expected + 1,
        result,
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
    if p.last() == Some(&"calendar.ics") {
        if !get || !q.is_empty() {
            return Err(missing());
        }
        s.home(p[4])?;
        let mut rows=all(s.db,"SELECT r.id,r.name,r.next_at,r.interval_ms,r.revision,b.spec_json,d.zone,(SELECT due_at FROM routine_occurrences o WHERE o.routine=r.id AND o.schedule_revision=r.revision AND o.source='schedule' AND o.state='pending') AS pendingDueAt FROM routines r LEFT JOIN routine_schedule_bindings b ON b.routine=r.id AND b.project=? JOIN agent_authority h ON h.agent=r.agent JOIN devices d ON d.id=h.home_device JOIN record_scopes s ON s.table_name='routines' AND s.key_json=json_array(r.id) AND s.project=? AND s.root_kind='agent' AND s.root_id=? WHERE r.agent=? AND r.enabled=1 AND r.trigger='schedule' AND (s.visibility='project' OR s.account=?) ORDER BY r.next_at,r.id",[s.project,s.project,p[4],p[4],s.account])?;
        for row in &mut rows {
            row["schedule"] = spec(s, row)?;
        }
        let mut response = Response::new(axum::body::Body::from(
            crate::connectors::calendar::render(s.db, &rows, s.state.config.now())?,
        ));
        response.headers_mut().insert(
            "content-type",
            "text/calendar; charset=utf-8"
                .parse()
                .map_err(|_| Failure::storage())?,
        );
        response.headers_mut().insert(
            "content-disposition",
            "attachment; filename=\"minarbot-routines.ics\""
                .parse()
                .map_err(|_| Failure::storage())?,
        );
        return Ok(response);
    }
    if p.last() == Some(&"webhook") {
        if !q.is_empty() {
            return Err(missing());
        }
        let value = webhooks::settings(s, path, p[4], get, v)?;
        return if get {
            Ok(read_response(value))
        } else {
            envelope(value)
        };
    }
    if get && !matches!(p.last(), Some(&"edit" | &"run")) {
        return Ok(read_response(read(s, p, q)?));
    }
    if !get && p.last() == Some(&"run") {
        fields(v, &["requestId"])?;
        let request = id(&v["requestId"])?;
        let r = root(s, p[4])?;
        flow(s, &r)?;
        let digest = s.digest(path, v);
        if let Some(saved) = s.replay(path, &request, &digest)? {
            s.scope(
                "routine_occurrences",
                json!([saved["receipt"]["recordId"]]),
                string(&r, "agent"),
            )?;
            return envelope(saved);
        }
        let mut data = runtime::routine(s, &r, &request, "manual", None)?;
        let record = string(&data, "occurrenceId").to_owned();
        let revision = data["revision"].as_i64().ok_or_else(Failure::storage)?;
        data["payloadDigest"] = json!(digest);
        return envelope(s.save(path, &request, &digest, 202, &record, revision, data)?);
    }
    if !get && (p[3] == "agents" || matches!(p.last(), Some(&"edit" | &"flow"))) {
        return envelope(save(s, path, p, v)?);
    }
    Err(missing())
}
