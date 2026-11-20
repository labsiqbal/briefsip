use crate::{files, Result};
use std::{
    collections::{BTreeMap, HashSet},
    env,
    ffi::{OsStr, OsString},
    fs::{self, File},
    io::ErrorKind,
    os::unix::fs::symlink,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

pub const LEGACY_PRODUCT: &str = "briefsip";
pub const DATABASE: &str = "minarbot.sqlite";
pub const LEGACY_DATABASE: &str = "briefsip.sqlite";
const DATABASE_MARKER: &str = ".minarbot-database-v1";

pub fn sidecar(database: &Path, suffix: &str) -> PathBuf {
    let modern = exact_sidecar(database, suffix);
    if suffix.is_empty() {
        return modern;
    }
    if database.file_name().is_some_and(|name| name == DATABASE) {
        let legacy_database = database.with_file_name(LEGACY_DATABASE);
        let legacy = exact_sidecar(&legacy_database, suffix);
        if fs::symlink_metadata(&legacy).is_ok()
            || (suffix.ends_with("-key") && !modern.exists() && legacy_database.exists())
        {
            return legacy;
        }
    }
    modern
}

/// SQLite journals and leases use the actual database name. Key mirrors need both names.
pub fn exact_sidecar(database: &Path, suffix: &str) -> PathBuf {
    let mut path = database.as_os_str().to_owned();
    path.push(suffix);
    path.into()
}

fn old_env_name(key: &OsStr) -> Option<String> {
    Some(format!(
        "BRIEFSIP_{}",
        key.to_str()?.strip_prefix("MINARBOT_")?
    ))
}

fn deprecated(key: &str) {
    static LOGGED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);
    if LOGGED
        .lock()
        .is_ok_and(|mut names| names.insert(key.to_owned()))
    {
        eprintln!(
            "[minarbot] {key} is deprecated. Use MINARBOT_{}.",
            &key["BRIEFSIP_".len()..]
        );
    }
}

fn lookup(key: &OsStr, get: impl Fn(&OsStr) -> Option<OsString>) -> Option<OsString> {
    get(key).or_else(|| {
        let old = old_env_name(key)?;
        let value = get(OsStr::new(&old))?;
        deprecated(&old);
        Some(value)
    })
}

pub fn var_os(key: impl AsRef<OsStr>) -> Option<OsString> {
    lookup(key.as_ref(), |key| env::var_os(key))
}

pub fn var(key: impl AsRef<OsStr>) -> std::result::Result<String, env::VarError> {
    var_os(key)
        .ok_or(env::VarError::NotPresent)?
        .into_string()
        .map_err(env::VarError::NotUnicode)
}

pub fn child_env<'a>(
    env: impl IntoIterator<Item = (&'a String, &'a String)>,
) -> BTreeMap<String, String> {
    let mut pairs = BTreeMap::new();
    let mut modern = Vec::new();
    for (key, value) in env {
        pairs.insert(key.clone(), value.clone());
        if let Some(suffix) = key.strip_prefix("BRIEFSIP_") {
            modern.push(format!("MINARBOT_{suffix}"));
        } else if key.starts_with("MINARBOT_") {
            modern.push(key.clone());
        }
    }
    for key in modern {
        let Some(old) = old_env_name(OsStr::new(&key)) else {
            continue;
        };
        if let Some(value) = pairs.get(&key).cloned() {
            pairs.insert(old, value);
        } else if let Some(value) = pairs.get(&old).cloned() {
            deprecated(&old);
            pairs.insert(key, value);
        }
    }
    pairs
}

pub fn config_path(path: &Path) -> PathBuf {
    if !path.exists() {
        if let Some(parent) = path
            .parent()
            .filter(|parent| parent.ends_with(".config/minarbot"))
        {
            if let Some(name) = path.file_name() {
                let old = parent.with_file_name(LEGACY_PRODUCT).join(name);
                if old.is_file() {
                    return old;
                }
            }
        }
    }
    path.to_owned()
}

pub fn default_releases(home: &Path) -> PathBuf {
    let modern = home.join(".local/share/minarbot/releases");
    let legacy = home
        .join(".local/share")
        .join(LEGACY_PRODUCT)
        .join("releases");
    if !modern.exists() && legacy.is_dir() {
        legacy
    } else {
        modern
    }
}

pub fn server_binary(release: &Path) -> PathBuf {
    let path = release.join("bin/minarbot-server");
    if path.is_file() {
        path
    } else {
        release.join("bin/briefsip-server")
    }
}

pub fn database_path(data: &Path) -> PathBuf {
    let old = data.join(LEGACY_DATABASE);
    if fs::symlink_metadata(&old).is_ok_and(|metadata| metadata.is_file()) {
        old
    } else {
        data.join(DATABASE)
    }
}

fn metadata(path: &Path) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn link_is(path: &Path, target: &OsStr) -> bool {
    fs::read_link(path).is_ok_and(|link| link.as_os_str() == target)
}

// An exchange keeps the old path usable across every interruption, including
// crashes between creating the staged symlink and exchanging the entries.
pub fn move_with_alias(old: &Path, new: &Path, directory: bool) -> Result<()> {
    let parent = old.parent().ok_or("Invalid migration path.")?;
    let name = new.file_name().ok_or("Invalid migration name.")?;
    let Some(source) = metadata(old)? else {
        return Ok(());
    };
    if source.file_type().is_symlink() {
        if new.exists() && fs::canonicalize(old)? == fs::canonicalize(new)? {
            return Ok(());
        }
        return Err("Legacy migration path is an unexpected symlink.".into());
    }
    if !(if directory {
        source.is_dir()
    } else {
        source.is_file()
    }) {
        return Err("Legacy migration path has an unexpected file type.".into());
    }
    if metadata(new)?.is_none() {
        symlink(name, new)?;
        files::sync_dir(parent)?;
    }
    if !link_is(new, name) {
        return Err("Both legacy and Minarbot paths exist. Migration would overwrite data.".into());
    }
    let dir = File::open(parent)?;
    nix::fcntl::renameat2(
        &dir,
        old,
        &dir,
        new,
        nix::fcntl::RenameFlags::RENAME_EXCHANGE,
    )?;
    dir.sync_all()?;
    Ok(())
}

fn checkpoint(path: &Path) -> Result<()> {
    let connection =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    connection.execute_batch("PRAGMA synchronous=FULL")?;
    let busy: i64 =
        connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))?;
    if busy != 0 {
        return Err("SQLite WAL is busy. Migration will retry at next start.".into());
    }
    drop(connection);
    File::open(path)?.sync_all()?;
    Ok(())
}

pub fn migrate_database(data: &Path) -> Result<()> {
    let old = data.join(LEGACY_DATABASE);
    let new = data.join(DATABASE);
    let Some(old_metadata) = metadata(&old)? else {
        return Ok(());
    };
    if old_metadata.file_type().is_symlink()
        && new.is_file()
        && fs::canonicalize(&old)? == fs::canonicalize(&new)?
    {
        return Ok(());
    }
    let _old_guard = files::lease(
        &exact_sidecar(&old, ".server-lock.sqlite"),
        "Legacy database is in use.",
    )?;
    let _new_guard = files::lease(
        &exact_sidecar(&new, ".server-lock.sqlite"),
        "Minarbot database is in use.",
    )?;
    if link_is(&old, OsStr::new(DATABASE)) && new.is_file() {
        return Ok(());
    }
    files::private_file(&old)?;
    let marker = data.join(DATABASE_MARKER);
    let restored = metadata(&new)?.is_some_and(|metadata| metadata.is_file());
    if restored && !marker.is_file() {
        return Err("Both database names exist without a migration marker.".into());
    }
    checkpoint(&old)?;
    if !restored {
        files::durable(&marker, b"prepared\n")?;
        move_with_alias(&old, &new, false)?;
    } else {
        // The old launcher restores by replacing its path, including when it was an alias.
        // Keep the restored file live at that path until an identical copy is durable.
        let staged = data.join(".minarbot-database-copy-v1");
        files::remove(&staged)?;
        fs::copy(&old, &staged)?;
        File::open(&staged)?.sync_all()?;
        for suffix in ["-wal", "-shm", "-journal"] {
            files::remove(&exact_sidecar(&new, suffix))?;
        }
        fs::rename(&staged, &new)?;
        files::sync_dir(data)?;
        symlink(DATABASE, &staged)?;
        fs::rename(&staged, &old)?;
        files::sync_dir(data)?;
    }
    files::durable(&marker, b"moved\n")
}

pub fn backup_input(data: &Path, id: &str) -> PathBuf {
    database_path(&data.join(".updates").join(id))
}

pub fn backup_format(format: &str, version: i64) -> bool {
    matches!(
        (format, version),
        ("minarbot-workspace" | "briefsip-workspace", 1)
            | ("minarbot-canonical-v6" | "briefsip-canonical-v6", 6)
    )
}

pub fn backup_table(db: &rusqlite::Connection) -> rusqlite::Result<&'static str> {
    Ok(
        if db
            .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='minarbot_backup'")?
            .exists([])?
        {
            "minarbot_backup"
        } else {
            "briefsip_backup"
        },
    )
}

pub fn normalize_backup_tables(db: &rusqlite::Connection) -> rusqlite::Result<()> {
    for (old, new) in [
        ("briefsip_backup", "minarbot_backup"),
        ("briefsip_backup_authority", "minarbot_backup_authority"),
    ] {
        let exists = |name: &str| {
            db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?")?
                .exists([name])
        };
        if !exists(new)? && exists(old)? {
            db.execute_batch(&format!("ALTER TABLE {old} RENAME TO {new}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_prefers_new_values_and_exports_both_names() -> Result<()> {
        let key = "MINARBOT_RENAME_CHECK".to_owned();
        let old = old_env_name(OsStr::new(&key)).ok_or("Missing alias")?;
        let mut env = BTreeMap::from([(old.clone(), "legacy".to_owned())]);
        let read = |env: &BTreeMap<String, String>| {
            lookup(key.as_ref(), |name| {
                env.get(name.to_str()?).map(OsString::from)
            })
        };
        assert_eq!(read(&env).as_deref(), Some(OsStr::new("legacy")));
        assert_eq!(child_env(&env).get(&key), env.get(&old));
        env.insert(key.clone(), String::new());
        assert_eq!(read(&env).as_deref(), Some(OsStr::new("")));
        assert_eq!(child_env(&env).get(&old), env.get(&key));
        Ok(())
    }
}

#[cfg(test)]
mod database_tests {
    use super::*;

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn resumes_database_exchange_and_legacy_snapshot_restore() -> Result<()> {
        let scratch = Scratch(env::temp_dir().join(format!("mb-{}", uuid::Uuid::new_v4())));
        files::mkdir(&scratch.0)?;
        let old = scratch.0.join(LEGACY_DATABASE);
        let new = scratch.0.join(DATABASE);
        let value = |path: &Path| -> Result<String> {
            Ok(rusqlite::Connection::open(path)?.query_row(
                "SELECT value FROM sample",
                [],
                |row| row.get(0),
            )?)
        };
        let build = |path: &Path, value: &str| -> Result<()> {
            let db = rusqlite::Connection::open(path)?;
            db.execute_batch("CREATE TABLE sample(value TEXT NOT NULL)")?;
            db.execute("INSERT INTO sample VALUES(?)", [value])?;
            Ok(())
        };
        let base = scratch.0.join("base.sqlite");
        build(&old, "original")?;
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&old, fs::Permissions::from_mode(0o600))?;
        fs::copy(&old, &base)?;
        let connection = rusqlite::Connection::open(&old)?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE sample SET value='wal';",
        )?;
        let wal = exact_sidecar(&old, "-wal");
        let shm = exact_sidecar(&old, "-shm");
        let saved_wal = fs::read(&wal)?;
        let saved_shm = fs::read(&shm)?;
        drop(connection);
        fs::copy(&base, &old)?;
        fs::write(wal, saved_wal)?;
        fs::write(shm, saved_shm)?;

        // Simulate interruption after preparing the symlink and before the exchange.
        files::durable(&scratch.0.join(DATABASE_MARKER), b"prepared\n")?;
        symlink(DATABASE, &new)?;
        migrate_database(&scratch.0)?;
        assert_eq!(value(&new)?, "wal");
        assert_eq!(value(&old)?, "wal");
        assert_eq!(fs::canonicalize(&old)?, new);
        migrate_database(&scratch.0)?;

        // 0.13.13 restores by atomically replacing the old pathname.
        fs::rename(&base, &old)?;
        assert_eq!(value(&old)?, "original");
        migrate_database(&scratch.0)?;
        migrate_database(&scratch.0)?;
        assert_eq!(value(&new)?, "original");
        assert_eq!(value(&old)?, "original");
        Ok(())
    }

    #[test]
    fn accepts_both_generations_of_backup_markers() -> Result<()> {
        let db = rusqlite::Connection::open_in_memory()?;
        db.execute_batch("CREATE TABLE briefsip_backup(format TEXT,version INTEGER); INSERT INTO briefsip_backup VALUES('briefsip-workspace',1);")?;
        assert_eq!(backup_table(&db)?, "briefsip_backup");
        normalize_backup_tables(&db)?;
        normalize_backup_tables(&db)?;
        assert_eq!(backup_table(&db)?, "minarbot_backup");
        let (format, version): (String, i64) =
            db.query_row("SELECT format,version FROM minarbot_backup", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?;
        assert!(backup_format(&format, version));
        assert!(backup_format("minarbot-workspace", 1));
        assert!(backup_format("briefsip-canonical-v6", 6));
        assert!(backup_format("minarbot-canonical-v6", 6));
        assert!(!backup_format("minarbot-canonical-v6", 1));
        Ok(())
    }
}
