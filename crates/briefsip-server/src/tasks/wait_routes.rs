use super::*;
use crate::automation::project::waits as workflow;
use sha2::{Digest, Sha256};

fn invalid() -> Failure {
    fail(409, "wait_invalid", "Wait scope is no longer active.")
}

fn turn(db: &Connection, wait_id: &str) -> Result<(Value, Value, Value)> {
    let wait = one(db, "SELECT w.*,p.request_json,p.state provision_state FROM turn_waits w JOIN wait_provisions p ON p.id=w.id WHERE w.id=?", [wait_id])?.ok_or_else(missing)?;
    let provision = data::json(&wait["request_json"])?["provision"].clone();
    let task = task(db, string(&provision["target"], "taskId"))?;
    if provision["target"]["kind"] != "turn" || task["logical_turn"] != wait["turn"] {
        return Err(missing());
    }
    Ok((wait, task, provision))
}

fn readable(db: &Connection, actor: &Actor, task: &Value) -> Result<()> {
    let project = string(task, "project");
    let recovery = exists(
        db,
        "SELECT 1 FROM authority_state WHERE id=1 AND serving_state='read_only_recovery'",
        [],
    )?;
    if recovery {
        if !exists(db, "SELECT 1 FROM projects p JOIN project_members m ON m.project=p.id AND m.account=p.account WHERE p.id=? AND p.account=? AND p.deleted=0 AND m.deleted=0 AND m.role='owner'", [project, &actor.account])? {
            return Err(missing());
        }
    } else {
        authority::member(db, &actor.account, project, false)?;
    }
    if !exists(db, "SELECT 1 FROM record_scopes WHERE table_name='turns' AND key_json=json_array(?) AND project=? AND (visibility='project' OR account=?)", [string(task,"logical_turn"), project, &actor.account])? {
        return Err(missing());
    }
    Ok(())
}

fn status(wait: &Value, closed: bool, now: i64) -> &str {
    match string(wait, "status") {
        "waiting" if closed => "closed",
        "waiting" if n(wait, "deadline") <= now => "expired",
        other => other,
    }
}

fn add_receipt(value: &mut Value, wait: &Value) -> Result<()> {
    if !wait["delivery"].is_null() {
        value["delivery"] = wait["delivery"].clone();
        value["receipt"] = data::json(&wait["result"])?["receipt"].clone();
    }
    Ok(())
}

fn turn_status(db: &Connection, actor: &Actor, id: &str, now: i64) -> Result<Value> {
    let (wait, task, _) = turn(db, id)?;
    readable(db, actor, &task)?;
    let closed = matches!(
        string(&task, "state"),
        "cancelled" | "failed" | "transferred" | "completed"
    );
    let mut value = json!({"id":id,"event":wait["event"],"deadline":wait["deadline"],"status":status(&wait,closed,now),"secretGeneration":wait["secret_generation"],"sourceDeviceId":wait["source_device_id"]});
    add_receipt(&mut value, &wait)?;
    Ok(value)
}

struct Scope {
    wait: Value,
    record: Value,
    provision: Value,
    device: Value,
    fingerprint: String,
}

fn active_turn(
    db: &Connection,
    id: &str,
    now: i64,
    reveal: Option<(&Actor, i64)>,
) -> Result<Scope> {
    let (wait, task, provision) = turn(db, id)?;
    if let Some((actor, expected)) = reveal {
        readable(db, actor, &task)?;
        authority::member(db, &actor.account, string(&task, "project"), true)?;
        if n(&wait, "secret_generation") != expected || !wait["delivery"].is_null() {
            return Err(invalid());
        }
    } else if wait["provision_state"] != "activated" {
        return Err(missing());
    }
    let authority = one(
        db,
        "SELECT generation FROM authority_state WHERE id=1 AND serving_state='active'",
        [],
    )?
    .ok_or_else(invalid)?;
    if task["home_device"] != wait["source_device_id"]
        || task["project"] != provision["projectId"]
        || task["agent"] != provision["agentId"]
        || wait["secret_generation"] != provision["secretGeneration"]
        || authority["generation"] != provision["authorityGeneration"]
    {
        return Err(invalid());
    }
    let device = one(
        db,
        "SELECT * FROM devices WHERE id=?",
        [string(&wait, "source_device_id")],
    )?
    .ok_or_else(invalid)?;
    if !devices::waits::connection(db, string(&device, "id"), n(&device, "generation"), now) {
        return Err(waits::offline());
    }
    let current = authority::dispatch(db, &task)?;
    if device["generation"] != provision["sourceDeviceGeneration"]
        || device["account"] != current["member"]["account"]
        || reveal.is_some_and(|(actor, _)| device["account"] != actor.account)
    {
        return Err(invalid());
    }
    if wait["delivery"].is_null()
        && (status(&wait, false, now) != "waiting"
            || !matches!(
                string(&task, "state"),
                "running" | "paused" | "waiting_device" | "waiting_resource"
            ))
    {
        return Err(invalid());
    }
    let fingerprint = digest(&json!([
        task["id"],
        task["revision"],
        current["sourceRevisions"],
        device["generation"],
        device["connection_generation"],
        provision["payloadDigest"]
    ]));
    Ok(Scope {
        wait,
        record: task,
        provision,
        device,
        fingerprint,
    })
}

enum Target {
    Turn(String),
    Workflow(String, i64),
}

fn step(value: &str) -> Result<i64> {
    value
        .parse::<i64>()
        .ok()
        .filter(|seq| *seq > 0 && seq.to_string() == value)
        .ok_or_else(missing)
}

impl Target {
    fn scope(&self, state: &AppState, db: &Connection, reveal: (&Actor, i64)) -> Result<Scope> {
        match self {
            Self::Turn(wait) => active_turn(db, wait, state.config.now(), Some(reveal)),
            Self::Workflow(run, seq) => Ok(workflow_scope(&workflow::active(
                state,
                db,
                run,
                *seq,
                Some((&reveal.0.account, reveal.1)),
            )?)),
        }
    }

    fn status(&self, state: &AppState, db: &Connection, actor: &Actor) -> Result<Value> {
        let now = state.config.now();
        match self {
            Self::Turn(wait) => turn_status(db, actor, wait, now),
            Self::Workflow(run, seq) => {
                let wait = workflow::read(state, db, &actor.account, run, *seq)?;
                let closed = wait["run_status"] != "waiting" || wait["steps"] != *seq;
                let mut value = json!({"run":run,"seq":seq,"event":wait["event"],"deadline":wait["deadline"],"status":status(&wait,closed,now),"secretGeneration":wait["secret_generation"],"sourceDeviceId":wait["source_device_id"]});
                add_receipt(&mut value, &wait)?;
                Ok(value)
            }
        }
    }
}

fn workflow_scope(active: &workflow::Active) -> Scope {
    Scope {
        wait: active.wait.clone(),
        record: active.run.clone(),
        provision: active.provision.clone(),
        device: active.device.clone(),
        fingerprint: active.fingerprint.clone(),
    }
}

fn transport(scope: &Scope, expires: i64) -> Value {
    json!({
        "waitKey":scope.provision["waitKey"],
        "sourceDeviceId":scope.device["id"],
        "deviceGeneration":scope.device["generation"],
        "authorityGeneration":scope.provision["authorityGeneration"],
        "secretGeneration":scope.wait["secret_generation"],
        "connectionGeneration":scope.device["connection_generation"],
        "expiresAt":expires
    })
}

async fn reveal(state: &AppState, actor: &Actor, target: &Target, body: &Value) -> Result<Value> {
    fields(
        body,
        &[
            "requestId",
            "ephemeralPublicKey",
            "expectedSecretGeneration",
        ],
    )?;
    let request_id = id(&body["requestId"])?;
    let expected = revision(&body["expectedSecretGeneration"], 1)?;
    let scope = {
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        target.scope(state, &guard.connection, (actor, expected))?
    };
    let mut request = transport(&scope, state.config.now() + 60000);
    request["requestId"] = json!(request_id);
    request["ephemeralPublicKey"] = body["ephemeralPublicKey"].clone();
    request["ownerAccountId"] = json!(actor.account);
    let result = devices::waits::request(state, &request, None).await?;
    let now = state.config.now();
    state
        .auth
        .as_ref()
        .ok_or_else(Failure::storage)?
        .require_current(&state.database, actor, now)?;
    let guard = state.database.lock().map_err(|_| Failure::storage())?;
    let current = target.scope(state, &guard.connection, (actor, expected))?;
    if current.fingerprint != scope.fingerprint || n(&result, "expiresAt") <= now {
        return Err(invalid());
    }
    Ok(result)
}

pub async fn human_route(
    state: &AppState,
    actor: &Actor,
    path: &str,
    method: &Method,
    body: &Value,
) -> Result<Option<Response>> {
    let parts = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
    let (target, tail) = match parts.as_slice() {
        ["api", "turn-waits", wait, tail @ ..] => (Target::Turn(id(&json!(wait))?), tail),
        ["api", "workflow-waits", run, seq, tail @ ..] => {
            (Target::Workflow(id(&json!(run))?, step(seq)?), tail)
        }
        _ => return Ok(None),
    };
    state
        .auth
        .as_ref()
        .ok_or_else(Failure::storage)?
        .require_current(&state.database, actor, state.config.now())?;
    let value = match (method, tail) {
        (&Method::GET, [] | ["connection"]) => {
            let guard = state.database.lock().map_err(|_| Failure::storage())?;
            target.status(state, &guard.connection, actor)?
        }
        (&Method::POST, ["connection"]) => reveal(state, actor, &target, body).await?,
        _ => return Err(missing()),
    };
    Ok(Some(crate::json_response(
        200,
        json!({"ok":true,"data":value}),
    )))
}

async fn verify_event(
    state: &AppState,
    scope: &Scope,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<(Value, i64)> {
    if body.is_empty() {
        return Err(fail(400, "event_invalid", "Event body is empty."));
    }
    let expires = state.config.now() + 5000;
    let mut request = transport(scope, expires);
    request["byteLength"] = json!(body.len());
    request["bodyDigest"] = json!(format!("{:x}", Sha256::digest(body)));
    request["headers"] = json!({
        "x-briefsip-time":crate::text_header(headers,"x-briefsip-time"),
        "x-briefsip-id":crate::text_header(headers,"x-briefsip-id"),
        "x-briefsip-signature":crate::text_header(headers,"x-briefsip-signature")
    });
    if !scope.wait["delivery"].is_null() {
        request["accepted"] = json!({"id":scope.wait["delivery"],"digest":scope.wait["digest"]});
    }
    let verified = devices::waits::request(state, &request, Some(body)).await?;
    if verified["id"] != request["headers"]["x-briefsip-id"]
        || verified["digest"] != request["bodyDigest"]
    {
        return Err(invalid());
    }
    Ok((verified, expires))
}

fn event_value(wait: &Value, verified: &Value, body: &[u8]) -> Result<Option<Value>> {
    if !wait["delivery"].is_null() {
        if wait["delivery"] != verified["id"] || wait["digest"] != verified["digest"] {
            return Err(fail(
                409,
                "event_conflict",
                "Wait already received a different event.",
            ));
        }
        return Ok(None);
    }
    let event = crate::web::parse_json(body)?;
    if event["event"] != wait["event"] {
        return Err(fail(409, "event_conflict", "Event name does not match."));
    }
    Ok(Some(
        json!({"event":event["event"],"eventTime":verified["eventTime"],"payload":event["payload"]}),
    ))
}

async fn deliver_turn(
    state: &AppState,
    id: &str,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<Value> {
    let scope = {
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        active_turn(&guard.connection, id, state.config.now(), None)?
    };
    let (verified, expires) = verify_event(state, &scope, headers, body).await?;
    let guard = state.database.lock().map_err(|_| Failure::storage())?;
    let db = &guard.connection;
    let now = state.config.now();
    transaction(db, || {
        let current = active_turn(db, id, now, None)?;
        if current.fingerprint != scope.fingerprint || expires <= now {
            return Err(invalid());
        }
        let Some(event) = event_value(&current.wait, &verified, body)? else {
            return data::json(&current.wait["result"]);
        };
        let task = &current.record;
        let request = uuid::Uuid::new_v4().to_string();
        let pd = digest(&json!([
            "briefsip-turn-event-v1",
            id,
            verified["id"],
            verified["digest"]
        ]));
        let scope = format!("turn-wait-event:{id}");
        let result = Save {
            account: string(&current.device, "account"),
            task,
            request: &request,
            scope: &scope,
            payload: &pd,
            now,
        }
        .save(
            db,
            id,
            n(task, "revision") + 1,
            200,
            json!({"id":id,"turn":current.wait["turn"],"delivery":verified["id"],"accepted":true}),
            None,
        )?;
        db.execute(
            "UPDATE turn_waits SET status='received',delivery=?,digest=?,result=? WHERE id=?",
            params![
                string(&verified, "id"),
                string(&verified, "digest"),
                canonical(&result),
                id
            ],
        )?;
        db.execute("INSERT INTO flow_tool_calls(turn,call_id,call,result,after_output,after_action) SELECT turn,call_id,call,?,after_output,after_action FROM turn_waits WHERE id=?",params![canonical(&event),id])?;
        db.execute(
            "UPDATE tasks SET revision=revision+1 WHERE id=?",
            [string(task, "id")],
        )?;
        db.execute(
            "UPDATE turns SET revision=revision+1 WHERE id=?",
            [string(&current.wait, "turn")],
        )?;
        observe(db, task, now)?;
        Ok(result)
    })
}

async fn deliver_workflow(
    state: &AppState,
    run: &str,
    seq: i64,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<Value> {
    let scope = {
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        workflow_scope(&workflow::active(state, &guard.connection, run, seq, None)?)
    };
    let (verified, expires) = verify_event(state, &scope, headers, body).await?;
    let guard = state.database.lock().map_err(|_| Failure::storage())?;
    let db = &guard.connection;
    transaction(db, || {
        let current = workflow::active(state, db, run, seq, None)?;
        if current.fingerprint != scope.fingerprint || expires <= state.config.now() {
            return Err(invalid());
        }
        let Some(event) = event_value(&current.wait, &verified, body)? else {
            return data::json(&current.wait["result"]);
        };
        workflow::deliver(state, db, &current, &verified, &event)
    })
}

pub async fn event(
    state: &AppState,
    request: Request,
    request_id: &mut String,
) -> Result<Response> {
    let path = request.uri().path().to_owned();
    let parts = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
    *request_id = uuid::Uuid::new_v4().to_string();
    let _capacity = data::limits::reserve(&path, request.method(), request.headers())?;
    if request.method() != Method::POST {
        return Err(fail(405, "method_not_allowed", "Use POST for events."));
    }
    if request.uri().query().is_some() {
        return Err(fail(400, "invalid_route", "Invalid event route."));
    }
    if request.headers().contains_key("origin") {
        return Err(fail(
            403,
            "origin_denied",
            "Send events from the server integration.",
        ));
    }
    let media = crate::text_header(request.headers(), "content-type")
        .unwrap_or("")
        .to_ascii_lowercase();
    if media != "application/json"
        && !media.split_once(';').is_some_and(|(kind, parameter)| {
            kind.trim_end() == "application/json" && parameter.trim() == "charset=utf-8"
        })
    {
        return Err(fail(
            415,
            "unsupported_media_type",
            "Use Content-Type application/json.",
        ));
    }
    let headers = request.headers().clone();
    let body = axum::body::to_bytes(request.into_body(), 65536)
        .await
        .map_err(|_| fail(413, "payload_too_large", "Event exceeds 64 KiB."))?;
    let result = match parts.as_slice() {
        ["api", "turn-waits", wait, "events"] => {
            deliver_turn(state, &id(&json!(wait))?, &headers, &body).await?
        }
        ["api", "workflow-waits", run, seq, "events"] => {
            deliver_workflow(state, &id(&json!(run))?, step(seq)?, &headers, &body).await?
        }
        _ => return Err(missing()),
    };
    *request_id = string(&result["receipt"], "requestId").to_owned();
    response(result)
}
