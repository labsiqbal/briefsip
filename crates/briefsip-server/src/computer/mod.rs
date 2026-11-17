#[allow(dead_code)]
mod actions;
#[allow(dead_code)]
pub mod machines;
pub mod options;
mod proxy;

use crate::{local_error, web::Failure, AppState};
use axum::{
    extract::{Request, State},
    response::Response,
    routing::any,
    Router,
};

use serde_json::Value;

pub type Result<T> = std::result::Result<T, Failure>;
pub fn initialize(db: &rusqlite::Connection) -> crate::db::Result<()> {
    machines::initialize(db)
}

fn transaction<T>(
    db: &rusqlite::Connection,
    work: impl FnOnce(&rusqlite::Connection) -> Result<T>,
) -> Result<T> {
    let tx = rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Immediate)?;
    let result = work(&tx)?;
    tx.commit()?;
    Ok(result)
}

fn error(status: u16, message: impl Into<String>) -> Failure {
    Failure::new(status, "computer_error", message)
}
async fn body(request: Request, limit: usize) -> Result<Value> {
    let bytes = axum::body::to_bytes(request.into_body(), limit)
        .await
        .map_err(|_| error(413, "Payload exceeds the limit."))?;
    serde_json::from_slice(&bytes).map_err(|_| error(400, "Invalid JSON."))
}
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/environment", any(entry))
        .route("/api/machines", any(entry))
        .route("/api/machines/remove", any(entry))
        .route("/api/machines/reciprocal", any(entry))
        .route("/api/machines/agent-messaging", any(entry))
        .route("/api/pairing-codes", any(entry))
        .route("/api/pairing/redeem", any(entry))
        .route("/api/peer/agents", any(entry))
        .route("/api/peer/unpair", any(entry))
        .route("/api/mcp-server/peer-tokens", any(entry))
}
async fn entry(State(state): State<AppState>, request: Request) -> Response {
    let path = request.uri().path().to_owned();
    let transport = [
        "/api/environment",
        "/api/pairing/redeem",
        "/api/machines/reciprocal",
        "/api/peer/agents",
        "/api/peer/unpair",
    ]
    .contains(&path.as_str());
    let result = async {
        if state.auth.is_some() {
            return Err(error(404, "Route is not available yet."));
        }
        let host = crate::text_header(request.headers(), "host").unwrap_or("");
        if (!transport
            && format!("http://{host}") != state.origin
            && !state
                .config
                .allowed_origins
                .contains(&format!("https://{host}")))
            || crate::text_header(request.headers(), "sec-fetch-site") == Some("cross-site")
                && path != "/api/environment"
        {
            return Err(error(
                403,
                "Access is only allowed through the local Briefsip address.",
            ));
        }
        if crate::updates::pending(&state) && path != "/api/environment" {
            return Err(error(503, "Update is being verified. Retry after restart."));
        }
        if crate::text_header(request.headers(), "authorization")
            .is_some_and(|v| v.starts_with("Bearer bsi_"))
        {
            return Err(error(401, "Unauthorized request."));
        }
        machines::handle(&state, request).await
    }
    .await;
    let mut response = result.unwrap_or_else(|e| local_error(e.status, &e.message));
    crate::security_headers(&mut response);
    response
}
pub fn maintenance(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let interval = state
            .config
            .computer
            .machines
            .as_ref()
            .and_then(|m| m.health_interval_ms)
            .unwrap_or(30000)
            .max(1);
        let mut timer = tokio::time::interval_at(
            tokio::time::Instant::now() + std::time::Duration::from_millis(interval),
            std::time::Duration::from_millis(interval),
        );
        loop {
            timer.tick().await;
            if !crate::updates::pending(&state) {
                let _ = machines::health(&state).await;
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_commit_rolls_back_and_allows_next_command() -> Result<()> {
        let db = rusqlite::Connection::open_in_memory()?;
        db.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE parents(id INTEGER PRIMARY KEY); CREATE TABLE children(parent INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED);")?;
        assert!(transaction(&db, |db| {
            db.execute("INSERT INTO children VALUES(1)", [])?;
            Ok(())
        })
        .is_err());
        assert!(db.is_autocommit());
        assert_eq!(
            db.query_row("SELECT count(*) FROM children", [], |r| r.get::<_, i64>(0))?,
            0
        );
        transaction(&db, |db| {
            db.execute("INSERT INTO parents VALUES(1)", [])?;
            db.execute("INSERT INTO children VALUES(1)", [])?;
            Ok(())
        })?;
        assert_eq!(
            db.query_row("SELECT count(*) FROM children", [], |r| r.get::<_, i64>(0))?,
            1
        );
        Ok(())
    }
}
