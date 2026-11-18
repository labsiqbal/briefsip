mod admission;
mod authority;
mod automation;
mod context;
pub(crate) mod execution;
mod human;
mod messages;
mod mutations;
mod reads;
mod recovery;
mod shared;
mod sources;
pub(crate) mod wait_routes;
pub(crate) mod waits;

pub fn maintain(state: &AppState) -> Result<()> {
    let guard = state.database.lock().map_err(|_| Failure::storage())?;
    let db = &guard.connection;
    waits::maintain(db, state.config.now())?;
    let due=all(db,"SELECT w.id,w.turn,t.id task,t.project,t.state,w.deadline FROM turn_waits w JOIN tasks t ON t.logical_turn=w.turn WHERE w.status='waiting' AND (w.deadline<=? OR t.state IN('cancelled','failed','transferred')) ORDER BY w.deadline,w.id LIMIT 40",[state.config.now()])?;
    if due.is_empty() {
        waits::send(db, state.config.now())?;
        return Ok(());
    }
    transaction(db, || {
        for wait in due {
            let expired = n(&wait, "deadline") <= state.config.now();
            db.execute(
                "UPDATE turn_waits SET status=? WHERE id=?",
                [
                    if expired { "expired" } else { "closed" },
                    string(&wait, "id"),
                ],
            )?;
            if expired
                && !matches!(
                    string(&wait, "state"),
                    "cancelled" | "completed" | "failed" | "transferred"
                )
            {
                db.execute(
                    "UPDATE tasks SET state='failed',revision=revision+1 WHERE id=?",
                    [string(&wait, "task")],
                )?;
                db.execute("UPDATE turns SET status='failed',revision=revision+1,error='Event wait timed out.' WHERE id=?",[string(&wait,"turn")])?;
                observe(db, &task(db, string(&wait, "task"))?, state.config.now())?;
            }
        }
        Ok(())
    })
}

use crate::{
    auth::Actor,
    computer::devices::{self, Principal},
    data::{self, all, exists, one, string, transaction},
    db::{canonical, digest as hash},
    web::Failure,
    AppState,
};
use axum::{
    extract::Request,
    http::{HeaderMap, Method},
    response::Response,
    routing::any,
    Router,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
type Result<T> = std::result::Result<T, Failure>;
use devices::{fields, id, revision};

fn fail(status: u16, code: &'static str, message: &str) -> Failure {
    Failure::new(status, code, message)
}
fn conflict() -> Failure {
    fail(
        409,
        "payload_conflict",
        "Request ID was already used for different content.",
    )
}
fn stale() -> Failure {
    fail(409, "stale_revision", "Task changed.")
}
fn missing() -> Failure {
    fail(404, "resource_not_found", "Task not found.")
}
fn digest(v: &Value) -> String {
    hash(&canonical(v))
}
fn hex(v: &Value, name: &str) -> Result<String> {
    v.as_str()
        .filter(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .map(str::to_owned)
        .ok_or_else(|| {
            Failure::new(
                400,
                "invalid_digest",
                format!("{name} must be a SHA-256 digest."),
            )
        })
}
fn text(v: &Value, max: usize, name: &str) -> Result<String> {
    v.as_str()
        .filter(|s| !s.trim().is_empty() && s.encode_utf16().count() <= max && !s.contains('\0'))
        .map(str::to_owned)
        .ok_or_else(|| Failure::new(400, "invalid_message", format!("{name} is invalid.")))
}
fn n(v: &Value, key: &str) -> i64 {
    v[key].as_i64().unwrap_or(0)
}
fn terminal(task: &Value) -> bool {
    matches!(
        string(task, "state"),
        "completed" | "failed" | "cancelled" | "transferred"
    )
}
fn task(db: &Connection, task: &str) -> Result<Value> {
    one(db, "SELECT * FROM tasks WHERE id=?", [task])?.ok_or_else(missing)
}
fn replay(
    db: &Connection,
    account: &str,
    project: &str,
    request: &str,
    scope: &str,
    payload: &str,
    human: bool,
) -> Result<Option<Value>> {
    let Some(row) = one(db, "SELECT * FROM receipts WHERE request_id=?", [request])? else {
        return Ok(None);
    };
    if row["actor"] != account || row["project"] != project || row["scope"] != scope {
        return Err(if human {
            fail(403, "receipt_denied", "Receipt is outside your access.")
        } else {
            conflict()
        });
    }
    if row["payload_digest"] != payload {
        return Err(conflict());
    }
    let mut value = data::json(&row["result_json"])?;
    value["status"] = json!(200);
    Ok(Some(value))
}
struct Save<'a> {
    account: &'a str,
    task: &'a Value,
    request: &'a str,
    scope: &'a str,
    payload: &'a str,
    now: i64,
}
impl Save<'_> {
    fn save(
        &self,
        db: &Connection,
        record: &str,
        rev: i64,
        status: u16,
        value: Value,
        input: Option<&Value>,
    ) -> Result<Value> {
        let mut receipt = json!({"requestId":self.request,"actorId":self.account,"projectId":self.task["project"],"payloadDigest":self.payload,"status":status,"recordId":record,"recordRevision":rev,"committedAt":self.now});
        if self.task["project"].is_null() {
            receipt
                .as_object_mut()
                .ok_or_else(Failure::storage)?
                .remove("projectId");
        }
        let result = json!({"data":value,"receipt":receipt,"status":status});
        let mut saved = result.clone();
        if let Some(input) = input {
            saved["input"] = input.clone();
        }
        db.execute(
            "INSERT INTO receipts VALUES(?,?,?,?,?,?,?,?)",
            params![
                self.request,
                self.account,
                self.task["project"].as_str(),
                self.scope,
                self.payload,
                status,
                saved.to_string(),
                self.now
            ],
        )?;
        Ok(result)
    }
}
fn observe(db: &Connection, task: &Value, now: i64) -> Result<()> {
    data::sync::append_record(
        db,
        string(task, "project"),
        "task",
        string(task, "id"),
        None,
        now,
    )
}
pub(crate) fn response(result: Value) -> Result<Response> {
    let status = result["status"].as_u64().ok_or_else(Failure::storage)? as u16;
    Ok(crate::json_response(
        status,
        json!({"ok":true,"data":result["data"],"revision":result["receipt"]["recordRevision"],"receipt":result["receipt"]}),
    ))
}
pub fn device_path(path: &str) -> bool {
    let p = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
    matches!(
        p.as_slice(),
        [
            "api",
            "tasks",
            _,
            "execution"
                | "wait-provider"
                | "context"
                | "context-mutations"
                | "reconcile"
                | "complete"
        ] | ["api", "tasks", _, "actions", _, "prepare" | "commit"]
    )
}
pub fn result_path(path: &str) -> bool {
    path.ends_with("/reconcile") || path.ends_with("/recovery-results")
}
pub fn query_allowed(path: &str, method: &Method, query: &[(String, String)]) -> bool {
    let p = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
    let key = match p.as_slice() {
        ["api", "tasks", _] => "afterResultSequence",
        ["api", "tasks", _, "results", _] => "offset",
        _ => return false,
    };
    *method == Method::GET
        && query.len() == 1
        && query[0].0 == key
        && !query[0].1.is_empty()
        && query[0].1.len() <= 16
        && query[0].1.bytes().all(|b| b.is_ascii_digit())
        && query[0]
            .1
            .parse::<u64>()
            .is_ok_and(|n| n <= 9007199254740991)
}
pub async fn device(state: &AppState, request: Request, request_id: &str) -> Result<Response> {
    if request.method() != Method::POST {
        return Err(fail(
            405,
            "method_not_allowed",
            "Use POST for device actions.",
        ));
    }
    let path = request.uri().path().to_owned();
    let target = request.uri().to_string();
    let headers = request.headers().clone();
    let limit = if result_path(&path) { 8388608 } else { 65536 };
    let raw = axum::body::to_bytes(request.into_body(), limit)
        .await
        .map_err(|_| {
            let mut e = fail(413, "payload_too_large", "Payload exceeds the limit.");
            e.details = Some(json!({"maxBytes":limit}));
            e
        })?;
    let v = crate::web::parse_json(&raw)?;
    if id(&v["requestId"])? != request_id {
        return Err(fail(
            400,
            "request_id_mismatch",
            "Header and body IDs must match.",
        ));
    }
    if path.ends_with("/context-mutations")
        && matches!(
            string(&v["toolCall"]["function"], "name"),
            "query_data" | "list_data_tables"
        )
    {
        let p = {
            let guard = state.database.lock().map_err(|_| Failure::storage())?;
            devices::authenticate(
                &guard.connection,
                &headers,
                "POST",
                &target,
                &raw,
                request_id,
                false,
                state.config.now(),
            )?
        };
        let token = crate::text_header(&headers, "x-briefsip-executor").ok_or_else(|| {
            fail(
                401,
                "executor_invalid",
                "Executor token is not available yet.",
            )
        })?;
        let task_id = id(&json!(path.split('/').nth(3).unwrap_or("")))?;
        return shared::run(&state, &task_id, &p, &v, token).await;
    }
    let guard = state.database.lock().map_err(|_| Failure::storage())?;
    let db = &guard.connection;
    let p = devices::authenticate(
        db,
        &headers,
        "POST",
        &target,
        &raw,
        request_id,
        false,
        state.config.now(),
    )?;
    let token = crate::text_header(&headers, "x-briefsip-executor").ok_or_else(|| {
        fail(
            401,
            "executor_invalid",
            "Executor token is not available yet.",
        )
    })?;
    let parts = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
    let task_id = id(&json!(parts[2]))?;
    let result = transaction(db, || match parts.as_slice() {
        ["api", "tasks", _, "actions", a, "prepare"] => execution::prepare(
            db,
            &p,
            &task_id,
            &id(&json!(a))?,
            &v,
            token,
            state.config.now(),
        ),
        ["api", "tasks", _, "actions", a, "commit"] => execution::commit(
            db,
            &p,
            &task_id,
            &id(&json!(a))?,
            &v,
            token,
            state.config.now(),
        ),
        ["api", "tasks", _, op] => {
            execution::route(db, &p, &task_id, op, &v, token, state.config.now())
        }
        _ => Err(missing()),
    })?;
    if result["waitPending"] == true {
        return Err(waits::offline());
    }
    if path.ends_with("/execution") {
        return Ok(crate::json_response(
            200,
            json!({"ok":true,"data":result,"revision":result["revision"]}),
        ));
    }
    response(result)
}
pub async fn human(
    state: &AppState,
    path: &str,
    method: &Method,
    v: &Value,
    actor: &Actor,
    q: &[(String, String)],
    headers: &HeaderMap,
) -> Result<Option<Response>> {
    if !path.starts_with("/api/tasks") {
        return Ok(None);
    }
    if let Some(auth) = &state.auth {
        auth.require_current(&state.database, actor, state.config.now())?;
    }
    let p = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
    let guard = state.database.lock().map_err(|_| Failure::storage())?;
    let db = &guard.connection;
    let result = transaction(db, || match p.as_slice() {
        ["api", "tasks"] if *method == Method::POST => {
            admission::admit(db, &actor.account, v, state.config.now())
        }
        ["api", "tasks", t] if *method == Method::GET => {
            human::lookup(db, &actor.account, &id(&json!(t))?, q)
        }
        ["api", "tasks", t, "results", a] if *method == Method::GET => {
            human::result(db, &actor.account, &id(&json!(t))?, &id(&json!(a))?, q)
        }
        ["api", "tasks", t, "control"] if *method == Method::POST => {
            human::control(db, &actor.account, &id(&json!(t))?, v, state.config.now())
        }
        ["api", "tasks", t, "questions", question, "answer"] if *method == Method::POST => {
            human::answer(
                db,
                &actor.account,
                &id(&json!(t))?,
                &id(&json!(question))?,
                v,
                state.config.now(),
            )
        }
        ["api", "tasks", t, "recovery-session"] if *method == Method::POST => {
            recovery::session(db, &actor.account, &id(&json!(t))?, v, state.config.now())
        }
        ["api", "tasks", t, op @ ("recovery-import" | "recovery-results")]
            if *method == Method::POST =>
        {
            recovery::ingest(
                db,
                actor,
                &id(&json!(t))?,
                v,
                crate::text_header(headers, "x-briefsip-recovery").unwrap_or(""),
                *op == "recovery-results",
                state.config.now(),
            )
        }
        _ => Err(fail(
            404,
            "resource_not_found",
            "Route is not available yet.",
        )),
    })?;
    if let Some(read) = result.get("read") {
        let value = json!({"ok":true,"data":read});
        let offset = result["offset"].as_u64().ok_or_else(Failure::storage)? as usize;
        return Ok(Some(data::wire::response(
            &value,
            &[(&value["data"]["chunk"], offset..offset.saturating_add(8000))],
        )));
    }
    response(result).map(Some)
}
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/tasks", any(crate::dispatch))
        .route("/api/tasks/{id}", any(crate::dispatch))
        .route("/api/tasks/{id}/control", any(crate::dispatch))
        .route("/api/tasks/{id}/execution", any(crate::dispatch))
        .route("/api/tasks/{id}/wait-provider", any(crate::dispatch))
        .route("/api/tasks/{id}/context", any(crate::dispatch))
        .route("/api/tasks/{id}/context-mutations", any(crate::dispatch))
        .route("/api/tasks/{id}/reconcile", any(crate::dispatch))
        .route("/api/tasks/{id}/complete", any(crate::dispatch))
        .route("/api/tasks/{id}/recovery-session", any(crate::dispatch))
        .route("/api/tasks/{id}/recovery-import", any(crate::dispatch))
        .route("/api/tasks/{id}/recovery-results", any(crate::dispatch))
        .route(
            "/api/tasks/{id}/actions/{action}/prepare",
            any(crate::dispatch),
        )
        .route(
            "/api/tasks/{id}/actions/{action}/commit",
            any(crate::dispatch),
        )
        .route(
            "/api/tasks/{id}/questions/{question}/answer",
            any(crate::dispatch),
        )
        .route("/api/tasks/{id}/results/{action}", any(crate::dispatch))
}
