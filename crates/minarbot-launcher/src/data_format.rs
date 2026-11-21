//! Identifies SQLite files that hold data in the current Minarbot format.
use rusqlite::Connection;

/// SQLite `application_id` stamped on every Minarbot database ("MNR1").
pub const APPLICATION_ID: i64 = 0x4d4e5231;
/// `minarbot_backup` format and version of a workspace backup.
pub const WORKSPACE_BACKUP: (&str, i64) = ("minarbot-workspace", 1);
/// `minarbot_backup` format and version of a canonical backup.
pub const CANONICAL_BACKUP: (&str, i64) = ("minarbot-canonical-v6", 6);
/// Shown when a database lacks the marker. Without it the file could come from
/// Minarbot 0.14.0 or earlier, or from another program, so the message names both.
pub const UNMARKED: &str = "This database does not carry the Minarbot data marker. It was made by Minarbot 0.14.0 or earlier, or by another program. Install fresh: https://github.com/labsiqbal/minarbot#install";

pub fn is_marked(db: &Connection) -> rusqlite::Result<bool> {
    let id: i64 = db.pragma_query_value(None, "application_id", |row| row.get(0))?;
    Ok(id == APPLICATION_ID)
}

pub fn mark(db: &Connection) -> rusqlite::Result<()> {
    db.pragma_update(None, "application_id", APPLICATION_ID)
}

pub fn is_backup(format: &str, version: i64) -> bool {
    [WORKSPACE_BACKUP, CANONICAL_BACKUP].contains(&(format, version))
}
