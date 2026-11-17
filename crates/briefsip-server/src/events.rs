use crate::{db::Database, web::Failure};
use axum::{
    body::Body,
    http::{header, HeaderValue},
    response::Response,
};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    convert::Infallible,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;

pub struct Scope {
    table: &'static str,
    clause: &'static str,
    id: String,
}
pub fn scope(path: &str) -> Option<Scope> {
    let parts: Vec<_> = path.split('/').collect();
    let ["", "api", kind, id, "turns", "stream"] = parts.as_slice() else {
        return None;
    };
    if id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-')
    {
        return None;
    }
    let (table, clause) = match *kind {
        "agents" => ("agents", "agent=? AND channel IS NULL AND thread IS NULL"),
        "threads" => ("threads", "thread=? AND channel IS NULL"),
        "channels" => ("channels", "channel=?"),
        _ => return None,
    };
    Some(Scope {
        table,
        clause,
        id: id.to_string(),
    })
}
fn exists(db: &Database, scope: &Scope) -> Result<bool, Failure> {
    let predicate = if scope.table == "threads" {
        " AND deleted=0"
    } else {
        ""
    };
    Ok(db
        .connection
        .query_row(
            &format!("SELECT 1 FROM {} WHERE id=?{predicate}", scope.table),
            [&scope.id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}
fn snapshots(db: &Database, scope: &Scope) -> Result<Vec<(String, String)>, Failure> {
    let sql = format!(
        "SELECT id FROM turns WHERE {} AND status='running' ORDER BY seq LIMIT 100",
        scope.clause
    );
    let mut statement = db.connection.prepare(&sql)?;
    let turns = statement
        .query_map([&scope.id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut frames = Vec::new();
    for turn in turns {
        let call: Option<(i64,String,String,String)> = db.connection.query_row("SELECT c.seq,coalesce(s.text,''),c.model,c.status FROM provider_calls c LEFT JOIN provider_streams s ON s.call=c.seq WHERE c.turn=? AND c.purpose='completion' AND c.phase IN('answer','budget_summary') ORDER BY c.seq DESC LIMIT 1", [&turn], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional()?;
        if let Some((seq, text, model, status)) = call {
            let last: Option<(String,String,i64,i64)> = db.connection.query_row("SELECT id,kind,ordinal,final FROM provider_stream_segments WHERE call=? ORDER BY ordinal DESC LIMIT 1", [seq], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional()?;
            let revision: i64 = db.connection.query_row(
                "SELECT coalesce(max(revision),0) FROM provider_stream_segments WHERE call=?",
                [seq],
                |row| row.get(0),
            )?;
            let segment = match &last {
                Some((id, kind, _, _)) if kind == "text" => id.clone(),
                Some((_, _, ordinal, _)) => format!("text-{}", ordinal + 1),
                None => "text-0".to_owned(),
            };
            let partial: Value = json!({"seq":seq,"text":text,"model":model,"status":status,"segment":segment,"revision":revision,"final":last.is_some_and(|value| value.3 != 0)});
            frames.push((
                turn.clone(),
                format!("data: {}\n\n", json!({"id":turn,"partial":partial})),
            ));
        }
    }
    Ok(frames)
}
#[derive(Clone)]
pub struct Hub {
    shutdown: watch::Sender<bool>,
}
impl Hub {
    pub fn new() -> Self {
        let (shutdown, _) = watch::channel(false);
        Self { shutdown }
    }
    pub fn close(&self) {
        self.shutdown.send_replace(true);
    }
    pub fn response(&self, scope: Scope, db: &Arc<Mutex<Database>>) -> Result<Response, Failure> {
        {
            let guard = db.lock().map_err(|_| Failure::storage())?;
            if !exists(&guard, &scope)? {
                return Err(Failure::new(
                    404,
                    "resource_not_found",
                    "Conversation not found.",
                ));
            }
        }
        let db = db.clone();
        let mut shutdown = self.shutdown.subscribe();
        let stream = async_stream::stream! {
            let mut previous = HashMap::new();
            let mut poll = tokio::time::interval(Duration::from_millis(40));
            poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut heartbeat = tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(15), Duration::from_secs(15));
            loop {
                tokio::select! {
                    _ = shutdown.changed() => break,
                    _ = heartbeat.tick() => yield Ok::<_, Infallible>(": keepalive\n\n".to_owned()),
                    _ = poll.tick() => {
                        // ponytail: 100 durable snapshots per reader; turn lane can publish after commits to avoid polling.
                        let result = db.lock().map_err(|_| Failure::storage()).and_then(|db| if exists(&db, &scope)? { snapshots(&db, &scope).map(Some) } else { Ok(None) });
                        let frames = match result { Ok(Some(frames)) => frames, _ => break };
                        previous.retain(|turn, _| frames.iter().any(|(current, _)| current == turn));
                        for (turn, frame) in frames { if previous.get(&turn) != Some(&frame) { previous.insert(turn, frame.clone()); yield Ok(frame); } }
                    }
                }
            }
        };
        let mut response = Response::new(Body::from_stream(stream));
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/event-stream"),
        );
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache, no-transform"),
        );
        response
            .headers_mut()
            .insert("x-accel-buffering", HeaderValue::from_static("no"));
        Ok(response)
    }
}
