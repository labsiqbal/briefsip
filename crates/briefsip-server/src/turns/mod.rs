mod admission;
mod compaction;
mod execution;
mod history;
mod memory;
mod provider;
mod questions;
mod queue;
mod shell;
mod stream;
mod tools;
mod verification;

use crate::{data, web::Failure, AppState};
use axum::{extract::Request, http::Method, response::Response, routing::any, Router};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{atomic::Ordering, Arc, Mutex},
};
use tokio::sync::{watch, Notify};

use crate::data::{
    all, closed, error, exists, field, integer, iso, one, string, transaction, uuid,
};
type Result<T> = std::result::Result<T, Failure>;

#[derive(Clone, Default)]
pub struct Runtime {
    active: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
    wake: Arc<Notify>,
}
impl Runtime {
    fn cancel(&self, turn: &str) {
        if let Ok(active) = self.active.lock() {
            if let Some(cancel) = active.get(turn) {
                cancel.send_replace(true);
            }
        }
    }
}

pub fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch(include_str!("schema.sql"))?;
    db.execute("UPDATE turns SET status='interrupted',error='Server stopped during this turn. Check the result before resuming.',revision=revision+1 WHERE status='running'", [])?;
    db.execute("UPDATE provider_calls SET status='interrupted',finished=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='pending'", [])?;
    Ok(())
}

pub fn pending(state: &AppState) -> bool {
    state.trial_pending.load(Ordering::Acquire)
}

pub fn start(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if state.auth.is_some() {
            return;
        }
        let mut changes = state.events.subscribe();
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            if std::env::var("BRIEFSIP_TEST_SERVER").as_deref() == Ok("rust") {
                if let Ok(parent) = std::env::var("BRIEFSIP_TEST_PARENT") {
                    if parent.bytes().all(|b| b.is_ascii_digit())
                        && !std::path::Path::new(&format!("/proc/{parent}")).exists()
                    {
                        std::process::exit(0);
                    }
                }
            }
            if let Err(error) = schedule(&state) {
                eprintln!("Turn scheduling failed: {}", error.message);
            }
            tokio::select! { _ = changes.recv() => (), _ = state.turns.wake.notified() => (), _ = timer.tick() => () }
        }
    })
}
fn schedule(state: &AppState) -> Result<()> {
    let guard = state.database.lock().map_err(|_| Failure::storage())?;
    let db = &guard.connection;
    if pending(state) {
        return Ok(());
    }
    queue::expire(db)?;
    for approval in all(db,"SELECT id FROM harness_approvals WHERE state='approval' AND turn IN (SELECT id FROM turns WHERE status<>'running')",[])? {
        db.execute("UPDATE harness_approvals SET state='expired',revision=revision+1 WHERE id=?",[string(&approval,"id")])?;
    }
    let mut active = state.turns.active.lock().map_err(|_| Failure::storage())?;
    for (id, cancel) in active.iter() {
        if !exists(
            db,
            "SELECT 1 FROM turns WHERE id=? AND status='running' AND paused=0",
            [id],
        )? {
            cancel.send_replace(true);
        }
    }
    if pending(state) {
        return Ok(());
    }
    let capacity = state
        .config
        .data
        .concurrency
        .as_ref()
        .and_then(Value::as_u64)
        .unwrap_or(4) as usize;
    let queued = all(db, "SELECT t.*,a.thread_limit FROM turns t JOIN agents a ON a.id=t.agent WHERE t.status='queued' AND t.paused=0 AND t.waiting_for IS NULL AND NOT EXISTS(SELECT 1 FROM questions q WHERE q.turn=t.id AND q.answer IS NULL) AND t.dispatch_mode<>'steer' AND NOT EXISTS(SELECT 1 FROM agent_visibility v WHERE v.agent=t.agent AND v.hidden=1) AND NOT EXISTS(SELECT 1 FROM queue_edits e JOIN turns h ON h.id=e.turn WHERE e.state='held' AND e.expires_at>unixepoch('subsec')*1000 AND h.agent=t.agent AND h.thread IS t.thread AND coalesce((SELECT position FROM queue_positions WHERE turn=h.id),h.seq)<=coalesce((SELECT position FROM queue_positions WHERE turn=t.id),t.seq)) ORDER BY coalesce((SELECT position FROM queue_positions WHERE turn=t.id),t.seq)", [])?;
    for row in queued {
        if active.len() >= capacity {
            break;
        }
        let id = string(&row, "id");
        if active.contains_key(id) {
            continue;
        }
        let agent = string(&row, "agent");
        if exists(
            db,
            "SELECT 1 FROM turns WHERE agent=? AND thread IS ? AND status='running'",
            params![agent, row["thread"].as_str()],
        )? {
            continue;
        }
        if !row["thread"].is_null() {
            let count:i64 = db.query_row("SELECT count(*) FROM turns WHERE agent=? AND thread IS NOT NULL AND status='running'", [agent], |r|r.get(0))?;
            if count >= row["thread_limit"].as_i64().unwrap_or(2) {
                continue;
            }
        }
        if db.execute("UPDATE turns SET status='running',started_at=coalesce(started_at,?) WHERE id=? AND status='queued' AND paused=0",params![iso(db,state.config.now())?,id])? == 0 { continue; }
        let (cancel, mut receiver) = watch::channel(false);
        active.insert(id.to_owned(), cancel);
        let task_state = state.clone();
        let id = id.to_owned();
        tokio::spawn(async move {
            let result = tokio::select! { result=execution::run(&task_state,&id) => result, _=receiver.changed()=>Err(error(409,"Turn stopped.")) };
            if let Err(failure) = result {
                if let Ok(db) = task_state.database.lock() {
                    let _=db.connection.execute("UPDATE turns SET status='failed',error=?,stopped_at=? WHERE id=? AND status='running'",params![failure.message,iso(&db.connection,task_state.config.now()).ok(),id]);
                    let _=db.connection.execute("UPDATE provider_calls SET status='failed',finished=? WHERE turn=? AND status='pending'",params![iso(&db.connection,task_state.config.now()).ok(),id]);
                }
            }
            if let Ok(mut active) = task_state.turns.active.lock() {
                active.remove(&id);
            }
            task_state.turns.wake.notify_one();
        });
    }
    Ok(())
}

pub fn handles(path: &str, method: &Method) -> bool {
    let p: Vec<_> = path.split('/').skip(1).collect();
    matches!(p.as_slice(),["api","agents"|"threads"|"channels",_,"turns"] if *method==Method::POST)
        || matches!(p.as_slice(),["api","agents"|"threads"|"channels",_,"compaction"] if *method==Method::GET)
        || matches!(
            p.as_slice(),
            [
                "api",
                "agents" | "threads" | "channels",
                _,
                "turns",
                _,
                "cancel" | "pause" | "resume" | "reassign" | "dispatch" | "edit"
            ] | ["api", "agents" | "threads" | "channels", _, "queue"]
                | [
                    "api",
                    "agents" | "threads" | "channels",
                    _,
                    "turns",
                    _,
                    "harness-approvals",
                    _
                ]
                | [
                    "api",
                    "agents" | "threads" | "channels",
                    _,
                    "turns",
                    _,
                    "questions",
                    _,
                    "answer"
                ]
        )
}
pub async fn local(state: &AppState, request: Request) -> Result<Response> {
    let path = request.uri().path().to_owned();
    let p: Vec<_> = path.split('/').skip(1).collect();
    let method = request.method().clone();
    let q = data::query(&request);
    let v = if method == Method::POST {
        if !data::origin(state, request.headers())
            || crate::text_header(request.headers(), "content-type")
                .unwrap_or("")
                .split(';')
                .next()
                != Some("application/json")
        {
            return Err(error(403, "Request must originate from Briefsip."));
        }
        let bytes = axum::body::to_bytes(request.into_body(), 64000)
            .await
            .map_err(|_| error(413, "Request is too large."))?;
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| error(400, "Invalid JSON."))?;
        if !v.is_object() {
            return Err(error(400, "JSON object is required."));
        }
        if !uuid(&field(&v, "id", 36)?) {
            return Err(error(400, "Invalid request ID."));
        }
        v
    } else {
        json!({})
    };
    let (status, value) = {
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        let db = &guard.connection;
        transaction(db, || {
            admission::route(state, db, &path, &p, &method, &q, &v)
        })?
    };
    state.turns.wake.notify_one();
    Ok(crate::json_response(status, value))
}
pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/agents/{id}/turns/{turn}/harness-approvals/{approval}",
            any(crate::dispatch),
        )
        .route(
            "/api/threads/{id}/turns/{turn}/harness-approvals/{approval}",
            any(crate::dispatch),
        )
        .route(
            "/api/channels/{id}/turns/{turn}/harness-approvals/{approval}",
            any(crate::dispatch),
        )
        .route("/api/agents/{id}/turns", any(crate::dispatch))
        .route("/api/threads/{id}/turns", any(crate::dispatch))
        .route("/api/channels/{id}/turns", any(crate::dispatch))
        .route("/api/agents/{id}/turns/{turn}/cancel", any(crate::dispatch))
        .route(
            "/api/threads/{id}/turns/{turn}/cancel",
            any(crate::dispatch),
        )
        .route(
            "/api/channels/{id}/turns/{turn}/cancel",
            any(crate::dispatch),
        )
        .route("/api/agents/{id}/turns/{turn}/pause", any(crate::dispatch))
        .route("/api/threads/{id}/turns/{turn}/pause", any(crate::dispatch))
        .route(
            "/api/channels/{id}/turns/{turn}/pause",
            any(crate::dispatch),
        )
        .route("/api/agents/{id}/turns/{turn}/resume", any(crate::dispatch))
        .route(
            "/api/threads/{id}/turns/{turn}/resume",
            any(crate::dispatch),
        )
        .route(
            "/api/channels/{id}/turns/{turn}/resume",
            any(crate::dispatch),
        )
        .route(
            "/api/agents/{id}/turns/{turn}/reassign",
            any(crate::dispatch),
        )
        .route(
            "/api/threads/{id}/turns/{turn}/reassign",
            any(crate::dispatch),
        )
        .route(
            "/api/channels/{id}/turns/{turn}/reassign",
            any(crate::dispatch),
        )
        .route(
            "/api/agents/{id}/turns/{turn}/dispatch",
            any(crate::dispatch),
        )
        .route(
            "/api/threads/{id}/turns/{turn}/dispatch",
            any(crate::dispatch),
        )
        .route("/api/agents/{id}/turns/{turn}/edit", any(crate::dispatch))
        .route("/api/threads/{id}/turns/{turn}/edit", any(crate::dispatch))
        .route("/api/channels/{id}/turns/{turn}/edit", any(crate::dispatch))
        .route("/api/agents/{id}/queue", any(crate::dispatch))
        .route("/api/threads/{id}/queue", any(crate::dispatch))
        .route("/api/channels/{id}/queue", any(crate::dispatch))
        .route(
            "/api/agents/{id}/turns/{turn}/questions/{question}/answer",
            any(crate::dispatch),
        )
        .route(
            "/api/threads/{id}/turns/{turn}/questions/{question}/answer",
            any(crate::dispatch),
        )
        .route(
            "/api/channels/{id}/turns/{turn}/questions/{question}/answer",
            any(crate::dispatch),
        )
}
