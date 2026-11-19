use super::{error, string, AppState, Failure, PeerError, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(super) fn initialize(db: &Connection) -> crate::db::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS update_fan_out_attempts(
            id TEXT NOT NULL REFERENCES update_commands(id),
            machine TEXT NOT NULL,
            release TEXT NOT NULL,
            version TEXT NOT NULL,
            state TEXT NOT NULL,
            bytes INTEGER NOT NULL DEFAULT 0,
            total INTEGER,
            started INTEGER NOT NULL,
            finished INTEGER,
            error_code TEXT,
            error_message TEXT,
            PRIMARY KEY(id, machine)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS update_fan_out_by_machine
            ON update_fan_out_attempts(machine, started DESC);",
    )?;
    db.execute(
        "UPDATE update_fan_out_attempts
         SET state='interrupted', finished=?, error_code='peer_connection_lost',
             error_message='Sending server restarted during fan-out.'
         WHERE finished IS NULL",
        [crate::config::now()],
    )?;
    Ok(())
}

pub(super) fn record(
    state: &AppState,
    id: &str,
    digest: &str,
    uncertain: &Value,
    release: &Value,
    machines: &[&str],
) -> Result<bool> {
    let mut db = state.database.lock().map_err(|_| Failure::storage())?;
    let tx = db.connection.transaction()?;
    if tx.execute(
        "INSERT INTO update_commands VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
        params![id, digest, uncertain.to_string()],
    )? == 0
    {
        return Ok(false);
    }
    let now = state.config.now();
    for machine in machines {
        tx.execute(
            "INSERT INTO update_fan_out_attempts(id,machine,release,version,state,started)
             VALUES(?,?,?,?,'queued',?)",
            params![
                id,
                machine,
                string(release, "id"),
                string(release, "version"),
                now
            ],
        )?;
    }
    tx.commit()?;
    Ok(true)
}

pub(super) fn set_total(state: &AppState, id: &str, total: u64) -> Result<()> {
    let db = state.database.lock().map_err(|_| Failure::storage())?;
    db.connection.execute(
        "UPDATE update_fan_out_attempts SET total=? WHERE id=?",
        params![total, id],
    )?;
    Ok(())
}

pub(super) fn start(state: &AppState, id: &str, machine: &str) -> Result<()> {
    let db = state.database.lock().map_err(|_| Failure::storage())?;
    if db.connection.execute(
        "UPDATE update_fan_out_attempts SET state='requesting'
         WHERE id=? AND machine=? AND NOT EXISTS(
             SELECT 1 FROM update_fan_out_attempts
             WHERE machine=? AND state IN('requesting','transferring')
         )",
        params![id, machine, machine],
    )? == 0
    {
        return Err(error(409, "Another update is already running."));
    }
    Ok(())
}

pub(super) fn active(state: &AppState, machine: &str, release: &str) -> Result<Option<String>> {
    let db = state.database.lock().map_err(|_| Failure::storage())?;
    Ok(db
        .connection
        .query_row(
            "SELECT id FROM update_fan_out_attempts
         WHERE machine=? AND release=? AND state IN('requesting','transferring')",
            params![machine, release],
            |row| row.get(0),
        )
        .optional()?)
}

pub(super) fn progress(state: &AppState, id: &str, machine: &str, bytes: u64) -> Result<()> {
    let db = state.database.lock().map_err(|_| Failure::storage())?;
    db.connection.execute(
        "UPDATE update_fan_out_attempts SET state='transferring', bytes=max(bytes, min(?,total))
         WHERE id=? AND machine=? AND state IN('requesting','transferring')",
        params![bytes, id, machine],
    )?;
    Ok(())
}

pub(super) fn finish(
    state: &AppState,
    id: &str,
    machine: &str,
    failure: Option<&Failure>,
) -> Result<()> {
    let db = state.database.lock().map_err(|_| Failure::storage())?;
    db.connection.execute(
        "UPDATE update_fan_out_attempts SET state=?, finished=?, error_code=?, error_message=?
         WHERE id=? AND machine=?",
        params![
            match failure {
                Some(f) if f.code == PeerError::Unconfirmed.code() => "interrupted",
                Some(_) => "failed",
                None => "accepted",
            },
            state.config.now(),
            failure.map(|f| f.code),
            failure.map(|f| &f.message),
            id,
            machine,
        ],
    )?;
    Ok(())
}

pub(super) fn latest(state: &AppState, machine: &str) -> Result<Option<Value>> {
    let db = state.database.lock().map_err(|_| Failure::storage())?;
    Ok(db.connection.query_row(
        "SELECT id,release,version,state,bytes,total,started,finished,error_code,error_message
         FROM update_fan_out_attempts WHERE machine=? ORDER BY started DESC,rowid DESC LIMIT 1",
        [machine],
        |r| {
            let code: Option<String> = r.get(8)?;
            let message: Option<String> = r.get(9)?;
            Ok(json!({
                "id":r.get::<_, String>(0)?, "releaseId":r.get::<_, String>(1)?,
                "version":r.get::<_, String>(2)?, "state":r.get::<_, String>(3)?,
                "bytesTransferred":r.get::<_, u64>(4)?, "totalBytes":r.get::<_, Option<u64>>(5)?,
                "startedAt":r.get::<_, i64>(6)?, "finishedAt":r.get::<_, Option<i64>>(7)?,
                "error":code.map(|code| json!({"code":code,"message":message.unwrap_or_default()})),
            }))
        },
    ).optional()?)
}
