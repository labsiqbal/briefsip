use crate::db::Result;
use rusqlite::{Connection, OptionalExtension};

fn columns(db: &Connection, table: &str) -> Result<Vec<String>> {
    let mut statement = db.prepare("SELECT name FROM pragma_table_info(?)")?;
    let rows = statement.query_map([table], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub(super) fn initialize(db: &mut Connection) -> Result<()> {
    if db.query_row(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name IN ('agents','accounts','schema_migrations')",
        [],
        |_| Ok(()),
    ).optional()?.is_some() {
        return Err("Canonical database cannot be used as a device database".into());
    }
    db.execute_batch(
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000",
    )?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let version: u32 = tx.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if !matches!(version, 0 | 2 | 3) {
        return Err("Unsupported device database version".into());
    }
    if version == 0 {
        tx.execute_batch(include_str!("v2.sql"))?;
    }
    if version <= 2 {
        tx.execute_batch(include_str!("v3.sql"))?;
        tx.pragma_update(None, "user_version", 3)?;
    }
    for (table, column, definition) in [
        ("device_journal", "uncertain_reason", "TEXT"),
        (
            "device_outbox",
            "report_json",
            "TEXT CHECK(report_json IS NULL OR json_valid(report_json))",
        ),
        (
            "device_wait_secrets",
            "ack_json",
            "TEXT CHECK(ack_json IS NULL OR json_valid(ack_json))",
        ),
        (
            "device_wait_secrets",
            "cleanup_pending",
            "INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_pending IN(0,1))",
        ),
    ] {
        let columns = columns(&tx, table)?;
        if !columns.is_empty() && !columns.iter().any(|c| c == column) {
            tx.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {definition}"
            ))?;
        }
    }
    tx.execute_batch(include_str!("supplemental.sql"))?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_schema_stays_separate_and_idempotent() -> Result<()> {
        let mut db = Connection::open_in_memory()?;
        initialize(&mut db)?;
        initialize(&mut db)?;
        assert_eq!(
            db.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))?,
            3
        );
        for table in [
            "device_state",
            "device_resource_bindings",
            "device_provider_bindings",
            "device_journal",
            "device_outbox",
            "device_wait_secrets",
        ] {
            assert!(!columns(&db, table)?.is_empty(), "{table}");
        }
        assert!(columns(&db, "projects")?.is_empty());
        Ok(())
    }

    #[test]
    fn upgrades_v2_without_rewriting_device_state() -> Result<()> {
        let mut db = Connection::open_in_memory()?;
        db.execute_batch(include_str!("v2.sql"))?;
        db.pragma_update(None, "user_version", 2)?;
        db.execute(
            "INSERT INTO device_state VALUES (1,'host','authority',8,4,5,'[]')",
            [],
        )?;
        initialize(&mut db)?;
        initialize(&mut db)?;
        assert_eq!(
            db.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))?,
            3
        );
        assert_eq!(
            db.query_row(
                "SELECT device_generation,journal_sequence FROM device_state",
                [],
                |r| Ok((r.get::<_, u32>(0)?, r.get::<_, u32>(1)?))
            )?,
            (8, 5)
        );
        assert!(columns(&db, "device_wait_secrets")?.contains(&"ack_json".to_owned()));
        Ok(())
    }

    #[test]
    fn rejects_canonical_and_unknown_versions() -> Result<()> {
        let mut db = Connection::open_in_memory()?;
        db.execute_batch("CREATE TABLE schema_migrations(version INTEGER)")?;
        assert!(
            initialize(&mut db).is_err_and(|err| err.to_string().contains("Canonical database"))
        );
        db.execute_batch("DROP TABLE schema_migrations; PRAGMA user_version=4")?;
        assert!(
            initialize(&mut db).is_err_and(|err| err.to_string().contains("Unsupported device"))
        );
        Ok(())
    }
}
