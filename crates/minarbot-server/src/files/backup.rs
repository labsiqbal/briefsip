use super::*;
use axum::response::IntoResponse;
use std::{
    fs::{self, OpenOptions},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
static BUSY: AtomicBool = AtomicBool::new(false);
struct Snapshot {
    directory: PathBuf,
}
impl Drop for Snapshot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
        BUSY.store(false, Ordering::Release);
    }
}
pub async fn handle(state: &AppState, req: Request) -> Result<Response> {
    if req.method() != Method::POST {
        return Err(error(404, "Route not found."));
    }
    mutation(state, &req)?;
    let input = body(req, 64000).await?;
    if !input.is_object() {
        return Err(error(400, "JSON object is required."));
    }
    if !valid_id(text(&input, "id")) {
        return Err(error(400, "Invalid request ID."));
    }
    if !keys(&input, &["id", "confirmed"]) || input["confirmed"] != true {
        return Err(error(
            400,
            "Confirmation is required for sensitive backup data.",
        ));
    }
    if BUSY.swap(true, Ordering::AcqRel) {
        return Err(error(
            409,
            "Backup is being created. Try again after it finishes.",
        ));
    }
    let snapshot = Snapshot {
        directory: std::env::temp_dir().join(format!("minarbot-backup-{}", uuid::Uuid::new_v4())),
    };
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&snapshot.directory)
        .map_err(|_| Failure::storage())?;
    let file = snapshot.directory.join("minarbot.sqlite");
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&file)
        .map_err(|_| Failure::storage())?;
    {
        let db = state.database.lock().map_err(|_| Failure::storage())?;
        db.connection
            .backup(rusqlite::DatabaseName::Main, &file, None)?;
        let backup = Connection::open(&file)?;
        backup.execute_batch("CREATE TABLE IF NOT EXISTS minarbot_backup(format TEXT NOT NULL,version INTEGER NOT NULL,created TEXT NOT NULL) STRICT;DELETE FROM minarbot_backup;")?;
        backup.execute(
            "INSERT INTO minarbot_backup VALUES('minarbot-workspace',1,?)",
            [timestamp(&backup, state.config.now())?],
        )?;
    }
    let bytes = fs::read(&file).map_err(|_| Failure::storage())?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/vnd.sqlite3"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"minarbot-workspace.sqlite\"",
            ),
        ],
        bytes,
    )
        .into_response())
}
