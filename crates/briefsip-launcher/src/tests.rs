use crate::{backup, config::parse_env, files::*, Result};
use rusqlite::Connection;
use std::{fs, path::Path};

#[test]
fn literal_env_matches_node_parse_env() {
    let source = "# ignored\r\nexport A=one\nA=last # tail\nEMPTY=\n=x\nS='literal # value'\nD=\"one\\ntwo\\rthree\"\nB=`back\nline`\nBAD-KEY=$(touch /never)\nUNFINISHED=\"quote\nNEXT=yes\n";
    let expected = [
        ("A", "last"),
        ("EMPTY", ""),
        ("S", "literal # value"),
        ("D", "one\ntwo\\rthree"),
        ("B", "back\nline"),
        ("BAD-KEY", "$(touch /never)"),
        ("UNFINISHED", "\"quote"),
        ("NEXT", "yes"),
    ];
    assert_eq!(
        parse_env(source),
        expected
            .into_iter()
            .map(|(k, v)| (k.into(), v.into()))
            .collect()
    );
}
#[test]
fn release_ids_match_node_pattern() {
    for id in [
        "1.0.0-12345678",
        "01.0.1-pre.1--abcdef12",
        "1.2.3-dev-0123456789012345678901234567890123456789",
    ] {
        assert!(release_id(id), "{id}");
    }
    for id in [
        "1.0-12345678",
        "1.0.0-ABCDEF12",
        "1.0.0-1234567",
        "1.0.0-/../-12345678",
        "١.0.0-12345678",
        "1.0.0-12345678\n",
    ] {
        assert!(!release_id(id), "{id}");
    }
}
fn temporary(check: impl FnOnce(&Path) -> Result<()>) -> Result<()> {
    let dir = std::env::temp_dir().join(format!("briefsip-launcher-test-{}", uuid::Uuid::new_v4()));
    mkdir(&dir)?;
    let result = check(&dir);
    fs::remove_dir_all(dir)?;
    result
}
#[test]
fn canonical_snapshot_preserves_authority_and_is_immutable() -> Result<()> {
    temporary(|dir| {
        let source = dir.join("db.sqlite");
        let target = dir.join("snapshot/briefsip.sqlite");
        let db = Connection::open(&source)?;
        db.execute_batch("CREATE TABLE schema_migrations(version INTEGER); INSERT INTO schema_migrations VALUES(6);
            CREATE TABLE authority_state(id INTEGER,generation TEXT); INSERT INTO authority_state VALUES(1,'generation-one');
            CREATE TABLE accounts(id TEXT PRIMARY KEY); INSERT INTO accounts VALUES('owner');
            CREATE TABLE projects(account TEXT); INSERT INTO projects VALUES('owner');
            CREATE TABLE briefsip_backup_authority(generation TEXT NOT NULL) STRICT;
            INSERT INTO briefsip_backup_authority VALUES('legacy-generation');")?;
        drop(db);
        backup::run("snapshot", &source, &target)?;
        let snapshot = Connection::open(&target)?;
        let marker = snapshot.query_row("SELECT format,version FROM briefsip_backup", [], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        assert_eq!(marker, ("briefsip-canonical-v6".into(), 6));
        let authority = snapshot.query_row(
            "SELECT generation,owner_account FROM briefsip_backup_authority",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )?;
        assert_eq!(authority, ("generation-one".into(), "owner".into()));
        drop(snapshot);
        let bytes = fs::read(&target)?;
        let db = Connection::open(&source)?;
        db.execute("UPDATE authority_state SET generation='damaged'", [])?;
        drop(db);
        backup::run("snapshot", &source, &target)?;
        assert_eq!(fs::read(&target)?, bytes);
        backup::run("restore", &source, &target)?;
        let restored = Connection::open(&source)?;
        assert_eq!(
            restored.query_row("SELECT generation FROM authority_state", [], |r| r
                .get::<_, String>(0))?,
            "generation-one"
        );
        Ok(())
    })
}
#[test]
fn invalid_restore_and_missing_canonical_owner_preserve_source() -> Result<()> {
    temporary(|dir| {
        let source = dir.join("db.sqlite");
        let target = dir.join("snapshot.sqlite");
        let db = Connection::open(&source)?;
        db.execute_batch("CREATE TABLE data(value TEXT); INSERT INTO data VALUES('intact');")?;
        drop(db);
        let before = fs::read(&source)?;
        fs::write(&target, b"invalid snapshot")?;
        assert!(backup::run("restore", &source, &target).is_err());
        assert_eq!(fs::read(&source)?, before);
        let db = Connection::open(&source)?;
        db.execute_batch("CREATE TABLE schema_migrations(version INTEGER); INSERT INTO schema_migrations VALUES(6);
            CREATE TABLE authority_state(id INTEGER,generation TEXT); INSERT INTO authority_state VALUES(1,'g');
            CREATE TABLE accounts(id TEXT PRIMARY KEY); CREATE TABLE projects(account TEXT); INSERT INTO projects VALUES('a'),('b');")?;
        drop(db);
        fs::remove_file(&target)?;
        assert!(backup::run("snapshot", &source, &target).is_err());
        assert!(!target.exists());
        Ok(())
    })
}
