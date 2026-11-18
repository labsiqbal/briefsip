use crate::{
    auth::Actor,
    data::{one, string, table, transaction},
    db::{self, canonical, digest},
    web::Failure,
    AppState,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    fs::{self, DirBuilder},
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Path, PathBuf},
};
use subtle::ConstantTimeEq;
use uuid::Uuid;

struct Staging(PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn random_proof() -> db::Result<String> {
    let mut bytes = [0; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| "Unable to generate recovery proof.")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn read_only(source: &Path, target: &Path) -> db::Result<Value> {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut path = target.as_os_str().to_owned();
        path.push(suffix);
        match fs::symlink_metadata(path) {
            Ok(_) => {
                return Err("Restore target must be a new database without companion files.".into())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let directory = parent.join(format!(".briefsip-restore-{}", Uuid::new_v4()));
    DirBuilder::new().mode(0o700).create(&directory)?;
    let staging = Staging(directory);
    let staged = staging.0.join("backup.sqlite");
    fs::copy(source, &staged)?;
    fs::set_permissions(&staged, fs::Permissions::from_mode(0o600))?;
    let connection = Connection::open(&staged)?;
    connection.execute_batch(
        "PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE;",
    )?;
    let manifest = connection.query_row(
        "SELECT format,version,(SELECT count(*) FROM briefsip_backup) FROM briefsip_backup",
        [],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        },
    )?;
    let schema: i64 = connection.query_row(
        "SELECT coalesce(max(version),0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    if manifest != ("briefsip-canonical-v6".to_owned(), 6, 1)
        || !(1..=db::SCHEMA_VERSION).contains(&schema)
    {
        return Err("Unsupported canonical backup format.".into());
    }
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if integrity != "ok" || connection.prepare("PRAGMA foreign_key_check")?.exists([])? {
        return Err("Invalid backup integrity.".into());
    }
    let marker: bool = connection.query_row("SELECT count(*)=1 AND min(generation)=(SELECT generation FROM authority_state WHERE id=1) FROM briefsip_backup_authority", [], |row| row.get(0))?;
    if !marker {
        return Err("Canonical backup authority mismatch.".into());
    }
    let now = crate::config::now();
    db::migrate(&connection, now, db::SCHEMA_VERSION)?;
    let generation = Uuid::new_v4().to_string();
    let bootstrap = random_proof()?;
    let expires = now + 900_000;
    let tx = connection.unchecked_transaction()?;
    let mut columns = tx.prepare("PRAGMA table_info(briefsip_backup_authority)")?;
    let marker_columns = columns
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(columns);
    if !marker_columns.iter().any(|name| name == "owner_account") {
        tx.execute_batch("ALTER TABLE briefsip_backup_authority ADD COLUMN owner_account TEXT REFERENCES accounts(id)")?;
    }
    tx.execute_batch("UPDATE briefsip_backup_authority SET owner_account=(SELECT min(account) FROM projects HAVING count(DISTINCT account)=1) WHERE owner_account IS NULL;")?;
    tx.execute("UPDATE authority_state SET generation=?,serving_state='read_only_recovery',recovery_session_hash=?,recovery_expires_at=?,revision=revision+1 WHERE id=1", params![generation,digest(&bootstrap),expires])?;
    tx.execute_batch(include_str!("restore.sql"))?;
    for (name, sql) in [
        ("provider_calls", "UPDATE provider_calls SET status='interrupted' WHERE status='pending'"),
        ("routines", "UPDATE routines SET enabled=0,revision=revision+1"),
        ("routine_occurrences", "UPDATE routine_occurrences SET state='blocked' WHERE state IN('pending','admitted')"),
        ("script_permissions", "UPDATE script_permissions SET enabled=0,revision=revision+1"),
        ("workflow_schedules", "UPDATE workflow_schedules SET enabled=0,revision=revision+1"),
        ("schedules", "UPDATE schedules SET enabled=0,revision=revision+1; UPDATE occurrences SET state='blocked' WHERE state='pending'"),
        ("workflow_webhooks", "UPDATE workflow_webhooks SET enabled=0,revision=revision+1"),
        ("workflow_runs", "UPDATE workflow_runs SET status='failed',revision=revision+1,error='Disaster restore requires review.' WHERE status IN('ready','waiting','approval')"),
        ("workflow_steps", "UPDATE workflow_steps SET status='failed',detail='Disaster restore requires review.' WHERE status IN('waiting','approval')"),
        ("flow_steps", "UPDATE flow_steps SET status='failed',result='Disaster restore requires review.' WHERE status IN('waiting','queued')"),
        ("turn_waits", "UPDATE turn_waits SET status='closed' WHERE status='waiting'"),
        ("workflow_waits", "UPDATE workflow_waits SET status='closed' WHERE status='waiting'"),
        ("wait_provisions", "UPDATE wait_provisions SET state='closed' WHERE state IN('pending','activated')"),
        ("mcp_connections", "UPDATE mcp_connections SET enabled=0,revision=revision+1"),
        ("mcp_tests", "DELETE FROM mcp_tests"),
    ] {
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name=? AND type='table')", [name], |row| row.get::<_, bool>(0))? {
            tx.execute_batch(sql)?;
        }
    }
    tx.commit()?;
    drop(connection);
    fs::File::open(&staged)?.sync_all()?;
    fs::hard_link(staged, target)?;
    drop(staging);
    fs::File::open(parent)?.sync_all()?;
    Ok(json!({"bootstrap":bootstrap,"recoveryGeneration":generation,"expiresAt":expires}))
}

pub fn reconcile(state: &AppState, actor: &Actor, body: &Value) -> Result<Value, Failure> {
    let denied = || {
        Failure::new(
            403,
            "recovery_session_invalid",
            "Recovery evidence is invalid or expired.",
        )
    };
    if !crate::data::closed(body, &["requestId", "bootstrap"]) {
        return Err(Failure::new(
            400,
            "invalid_request",
            "Invalid recovery request.",
        ));
    }
    let bootstrap = string(body, "bootstrap");
    crate::computer::devices::decode(&json!(bootstrap), 32).map_err(|_| denied())?;
    let now = state.config.now();
    state
        .auth
        .as_ref()
        .ok_or_else(denied)?
        .require_current(&state.database, actor, now)?;
    let guard = state.database.lock().map_err(|_| Failure::storage())?;
    let db = &guard.connection;
    transaction(db, || {
        if !table(db, "briefsip_backup_authority")? {
            return Err(denied());
        }
        let proof = one(db, "SELECT a.generation,a.recovery_session_hash,owner.issuer FROM authority_state a JOIN accounts owner ON owner.id=? WHERE a.id=1 AND a.serving_state='read_only_recovery' AND a.recovery_expires_at>? AND owner.clerk_sub=? AND owner.blocked=0 AND (SELECT count(*) FROM briefsip_backup_authority)=1 AND owner.id=(SELECT owner_account FROM briefsip_backup_authority) AND EXISTS(SELECT 1 FROM projects p JOIN project_members m ON m.project=p.id AND m.account=owner.id WHERE p.account=owner.id AND p.deleted=0 AND m.deleted=0 AND m.role='owner')", params![actor.account,now,actor.subject])?.ok_or_else(denied)?;
        if !bool::from(
            digest(bootstrap)
                .as_bytes()
                .ct_eq(string(&proof, "recovery_session_hash").as_bytes()),
        ) {
            return Err(denied());
        }
        let session = random_proof().map_err(|_| Failure::storage())?;
        let hash = digest(&canonical(&json!([
            "briefsip-restore-session-v1",
            actor.account,
            proof["issuer"],
            actor.subject,
            session
        ])));
        let expires = now + 900_000;
        db.execute("UPDATE authority_state SET recovery_session_hash=?,recovery_expires_at=?,revision=revision+1 WHERE id=1", params![hash,expires])?;
        Ok(json!({"session":session,"recoveryGeneration":proof["generation"],"expiresAt":expires}))
    })
}
