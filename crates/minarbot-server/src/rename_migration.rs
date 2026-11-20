use crate::{config::Config, db::Result};
use minarbot_launcher::{
    files,
    rename_migration::{self as layout, DATABASE, LEGACY_DATABASE, LEGACY_PRODUCT},
};
use std::{
    env, fs,
    path::{Path, PathBuf},
};

pub use layout::{exact_sidecar, sidecar};

const OLD_UNIT: &str = "briefsip.service";
const UNIT: &str = "minarbot.service";
const MARKER: &str = ".minarbot-rename-v1";

pub fn checkpoint_id(reference: &str) -> Option<&str> {
    reference
        .strip_prefix("refs/minarbot/checkpoints/")
        .or_else(|| reference.strip_prefix("refs/briefsip/checkpoints/"))
}

pub fn workspace_recovery_id(directory: &str) -> Option<&str> {
    directory
        .strip_prefix(".minarbot-removed-")
        .or_else(|| directory.strip_prefix(".briefsip-removed-"))
}

fn boxed(error: Box<dyn std::error::Error>) -> Box<dyn std::error::Error + Send + Sync> {
    error.to_string().into()
}

struct Layout {
    home: PathBuf,
    legacy_share: PathBuf,
    share: PathBuf,
    legacy_config: PathBuf,
    config: PathBuf,
}
impl Layout {
    fn new(home: PathBuf) -> Self {
        Self {
            legacy_share: home.join(".local/share").join(LEGACY_PRODUCT),
            share: home.join(".local/share/minarbot"),
            legacy_config: home.join(".config").join(LEGACY_PRODUCT),
            config: home.join(".config/minarbot"),
            home,
        }
    }

    fn path(&self, path: &Path) -> PathBuf {
        for (old, new) in [
            (&self.legacy_share, &self.share),
            (&self.legacy_config, &self.config),
        ] {
            if let Ok(tail) = path.strip_prefix(old) {
                return new.join(tail);
            }
        }
        path.to_owned()
    }

    fn migrate(&self, checkpoint: impl Fn(&str) -> Result<()>) -> Result<()> {
        let _lease = files::lease(
            &self.home.join(".local/share/.minarbot-rename-lock.sqlite"),
            "Another process is migrating the installation.",
        )
        .map_err(boxed)?;
        for (old, new, phase) in [
            (&self.legacy_share, &self.share, "data-root"),
            (&self.legacy_config, &self.config, "config-root"),
        ] {
            layout::move_with_alias(old, new, true).map_err(boxed)?;
            if self.share.is_dir() {
                files::durable(&self.share.join(MARKER), phase.as_bytes()).map_err(boxed)?;
            }
            checkpoint(phase)?;
        }
        let file = self.config.join("launcher.json");
        if file.exists() {
            files::private_file(&file).map_err(boxed)?;
            let mut config = files::json(&file).map_err(boxed)?;
            let mut changed = false;
            for field in ["dataDir", "releasesDir", "envFile"] {
                if let Some(value) = config[field].as_str() {
                    let path = self.path(Path::new(value));
                    if path != Path::new(value) {
                        config[field] = serde_json::to_value(path)?;
                        changed = true;
                    }
                }
            }
            if changed {
                files::durable(&file, &serde_json::to_vec_pretty(&config)?).map_err(boxed)?;
            }
        }
        if self.share.is_dir() {
            files::durable(&self.share.join(MARKER), b"launcher-config").map_err(boxed)?;
        }
        checkpoint("launcher-config")?;
        let units = self.home.join(".config/systemd/user");
        let old_unit = units.join(OLD_UNIT);
        let unit = units.join(UNIT);
        if old_unit.is_file() && !unit.exists() {
            // The old start command can boot either release from current. The
            // bridge ships the legacy launcher name as a copy of the new binary.
            let source = fs::read_to_string(&old_unit)?
                .replace(".local/share/briefsip", ".local/share/minarbot")
                .replace(".config/briefsip", ".config/minarbot")
                .replace("Description=Briefsip", "Description=Minarbot")
                .replace(
                    "[Unit]",
                    "[Unit]\nConflicts=briefsip.service\nAfter=briefsip.service",
                );
            files::durable(&unit, source.as_bytes()).map_err(boxed)?;
        }
        if self.share.is_dir() {
            files::durable(&self.share.join(MARKER), b"unit-staged").map_err(boxed)?;
        }
        checkpoint("unit-staged")
    }
}

pub fn prepare(config: &mut Config) -> Result<Option<PathBuf>> {
    if config.harness.test_mode {
        return Ok(None);
    }
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute());
    let mut handoff = None;
    if let Some(home) = home {
        let layout = Layout::new(home);
        let managed = config.database.starts_with(&layout.legacy_share)
            || config.database.starts_with(&layout.share);
        if managed && layout.legacy_share.exists() {
            layout.migrate(|_| Ok(()))?;
            config.database = layout.path(&config.database);
            // Keep the control socket spelling inherited from the active launcher.
            handoff = Some(layout.home);
        }
    }
    if matches!(
        config.database.file_name().and_then(|name| name.to_str()),
        Some(DATABASE | LEGACY_DATABASE)
    ) {
        let directory = config.database.parent().ok_or("Invalid data directory.")?;
        layout::migrate_database(directory).map_err(boxed)?;
        let legacy_database = directory.join(LEGACY_DATABASE);
        let modern_database = directory.join(DATABASE);
        for suffix in [".mcp-key", ".project-env-key", ".provider-key"] {
            let legacy = sidecar(&legacy_database, suffix);
            if legacy.exists() {
                let bytes = read_file_key(&legacy)?;
                sync_file_key(&modern_database, &legacy, suffix, &bytes)?;
            }
        }
        config.database = modern_database;
    }
    Ok(handoff)
}

pub async fn handoff(home: &Path, data: &Path, release: &str, trial: bool) -> Result<()> {
    let Ok(invocation) = env::var("INVOCATION_ID") else {
        return Ok(());
    };
    let units = home.join(".config/systemd/user");
    if !units.join(UNIT).is_file() {
        return Ok(());
    }
    let output = tokio::process::Command::new("systemctl")
        .args([
            "--user",
            "show",
            OLD_UNIT,
            "-p",
            "InvocationID",
            "-p",
            "FragmentPath",
        ])
        .output()
        .await?;
    let properties = String::from_utf8(output.stdout)?;
    if !output.status.success()
        || !properties
            .lines()
            .any(|line| line.strip_prefix("InvocationID=") == Some(&invocation))
        || !properties.lines().any(|line| {
            line.strip_prefix("FragmentPath=")
                .is_some_and(|path| Path::new(path) == units.join(OLD_UNIT))
        })
    {
        return Ok(());
    }
    if trial {
        // Let the running launcher commit its own trial before systemd stops it.
        loop {
            let state = files::json(&data.join("update-state.json"))
                .ok()
                .map(|state| {
                    (
                        state["lastAttempt"]["status"]
                            .as_str()
                            .unwrap_or_default()
                            .to_owned(),
                        state["current"].as_str().unwrap_or_default().to_owned(),
                    )
                });
            match state {
                Some((status, current)) if status == "done" && current == release => break,
                Some((status, _))
                    if matches!(status.as_str(), "rolled-back" | "failed" | "restoring") =>
                {
                    return Ok(())
                }
                _ => tokio::time::sleep(std::time::Duration::from_millis(200)).await,
            }
        }
    }
    let status = tokio::process::Command::new("systemd-run")
        .args(["--user", "--quiet", "--collect", "--unit=minarbot-rename-handoff", "/bin/sh", "-c",
            "systemctl --user daemon-reload && systemctl --user enable minarbot.service && systemctl --user disable briefsip.service && systemctl --user start minarbot.service || { systemctl --user disable minarbot.service; systemctl --user enable --now briefsip.service; exit 1; }"])
        .status()
        .await?;
    if !status.success() {
        return Err("Could not schedule Minarbot service handoff.".into());
    }
    Ok(())
}

fn read_file_key(path: &Path) -> Result<[u8; 32]> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags((rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32)
        .open(path)?;
    if !crate::operator_file::private(&file) {
        return Err("Invalid private encryption key file.".into());
    }
    crate::operator_file::bounded_read(file, 32)?
        .try_into()
        .map_err(|_| "Invalid encryption key length.".into())
}

pub fn sync_file_key(database: &Path, source: &Path, suffix: &str, bytes: &[u8; 32]) -> Result<()> {
    let modern = exact_sidecar(database, suffix);
    if modern != source {
        mirror_file_key(&modern, bytes)?;
    }
    Ok(())
}

fn mirror_file_key(path: &Path, bytes: &[u8; 32]) -> Result<()> {
    if !path.exists() {
        let parent = path
            .parent()
            .ok_or("Invalid encryption key directory.")?
            .canonicalize()?;
        let directory = crate::operator_file::open_directory(&parent)?;
        let name = path.file_name().ok_or("Invalid encryption key path.")?;
        let publish = crate::operator_file::publish(&directory, name, bytes);
        if !path.exists() {
            publish?;
        }
    }
    if &read_file_key(path)? != bytes {
        return Err("Legacy and Minarbot encryption keys differ.".into());
    }
    Ok(())
}

pub fn legacy_service(service: &str) -> Option<String> {
    Some(format!(
        "{LEGACY_PRODUCT}/{}",
        service.strip_prefix("minarbot/")?
    ))
}

pub async fn read_bridged_key<
    E,
    F: std::future::Future<Output = std::result::Result<Option<String>, E>>,
>(
    service: &str,
    read: impl Fn(String) -> F,
) -> std::result::Result<Option<String>, E> {
    let current = read(service.to_owned()).await;
    if matches!(current, Ok(Some(_))) {
        return current;
    }
    if let Some(legacy) = legacy_service(service) {
        let old = read(legacy).await;
        if matches!(old, Ok(Some(_))) || current.is_ok() {
            return old;
        }
    }
    current
}

pub fn read_key(
    service: &str,
    name: &str,
    read: impl Fn(&str, &str) -> keyring::Result<Option<String>>,
    write: impl Fn(&str, &str, &str) -> keyring::Result<()>,
) -> keyring::Result<Option<String>> {
    let current = read(service, name)?;
    let Some(old) = legacy_service(service) else {
        return Ok(current);
    };
    let Some(legacy) = read(&old, name)? else {
        return Ok(current);
    };
    if current.as_ref() != Some(&legacy) {
        write(service, name, &legacy)?;
        if read(service, name)?.as_ref() != Some(&legacy) {
            return Err(keyring::Error::NoEntry);
        }
    }
    // The legacy name is still the source of truth after a 0.13.13 rollback.
    Ok(Some(legacy))
}

pub fn system_read(service: &str, name: &str) -> keyring::Result<Option<String>> {
    match keyring::Entry::new(service, name)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn system_write(service: &str, name: &str, value: &str) -> keyring::Result<()> {
    keyring::Entry::new(service, name)?.set_password(value)
}

pub fn read_system_key(service: &str, name: &str) -> keyring::Result<Option<String>> {
    read_key(service, name, system_read, system_write)
}

pub fn write_system_key(service: &str, name: &str, value: &str) -> keyring::Result<()> {
    if let Some(old) = legacy_service(service) {
        system_write(&old, name, value)?;
        if system_read(&old, name)?.as_deref() != Some(value) {
            return Err(keyring::Error::NoEntry);
        }
    }
    system_write(service, name, value)?;
    if system_read(service, name)?.as_deref() != Some(value) {
        return Err(keyring::Error::NoEntry);
    }
    Ok(())
}

pub fn remove_system_key(service: &str, name: &str) -> keyring::Result<()> {
    let remove = |service| match keyring::Entry::new(service, name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error),
    };
    remove(service)?;
    if let Some(old) = legacy_service(service) {
        remove(&old)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::BTreeMap};

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn prepares_database_with_legacy_sidecars_and_preserves_rollback_paths() -> Result<()> {
        let scratch = Scratch(env::temp_dir().join(format!("mb-{}", uuid::Uuid::new_v4())));
        files::mkdir(&scratch.0).map_err(boxed)?;
        let legacy = scratch.0.join(LEGACY_DATABASE);
        let modern = scratch.0.join(DATABASE);
        drop(rusqlite::Connection::open(&legacy)?);
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&legacy, fs::Permissions::from_mode(0o600))?;
        let keys = [
            (".peer-key", [1; 32], false),
            (".composio-key", [2; 32], false),
            (".mcp-key", [3; 32], true),
            (".project-env-key", [4; 32], true),
            (".provider-key", [5; 32], true),
        ];
        for (suffix, bytes, _) in keys {
            let path = scratch.0.join(format!("{LEGACY_DATABASE}{suffix}"));
            files::durable(&path, &bytes).map_err(boxed)?;
        }
        let directories = [
            (".host", "identity.json"),
            (".harness-homes", "engine-login"),
        ];
        for (suffix, name) in directories {
            let path = scratch.0.join(format!("{LEGACY_DATABASE}{suffix}"));
            files::mkdir(&path).map_err(boxed)?;
            files::durable(&path.join(name), name.as_bytes()).map_err(boxed)?;
        }
        let mut config: Config = serde_json::from_value(serde_json::json!({"database": modern}))?;
        prepare(&mut config)?;
        prepare(&mut config)?;
        assert_eq!(config.database, modern);
        assert_eq!(legacy.canonicalize()?, modern);
        let _homes = crate::harness::config::prepare_homes(&config.database)?;
        for (suffix, bytes, mirrored) in keys {
            let old_path = scratch.0.join(format!("{LEGACY_DATABASE}{suffix}"));
            let new_path = scratch.0.join(format!("{DATABASE}{suffix}"));
            assert_eq!(sidecar(&config.database, suffix), old_path);
            assert_eq!(read_file_key(&old_path)?, bytes);
            if mirrored {
                assert_eq!(read_file_key(&new_path)?, bytes);
            } else {
                assert!(!new_path.exists());
            }
        }
        for (suffix, name) in directories {
            let old_path = scratch.0.join(format!("{LEGACY_DATABASE}{suffix}"));
            assert_eq!(sidecar(&config.database, suffix), old_path);
            let directory = crate::operator_file::open_directory(&old_path)?;
            let file = crate::operator_file::file_at(&directory, std::ffi::OsStr::new(name))?;
            assert_eq!(
                crate::operator_file::bounded_read(file, 32)?,
                name.as_bytes()
            );
            assert!(!scratch.0.join(format!("{DATABASE}{suffix}")).exists());
        }
        let missing = ".unused-key";
        let old_key = scratch.0.join("briefsip.sqlite.unused-key");
        let new_key = scratch.0.join("minarbot.sqlite.unused-key");
        assert_eq!(sidecar(&modern, missing), old_key);
        files::durable(&new_key, &[6; 32]).map_err(boxed)?;
        assert_eq!(sidecar(&modern, missing), new_key);
        let live = rusqlite::Connection::open(&modern)?;
        live.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE sample(id INTEGER);")?;
        fs::write(scratch.0.join("briefsip.sqlite-wal"), b"stale")?;
        let wal = exact_sidecar(&config.database, "-wal");
        assert_eq!(wal, scratch.0.join("minarbot.sqlite-wal"));
        assert!(fs::metadata(wal)?.len() > b"stale".len() as u64);
        Ok(())
    }

    #[test]
    fn resumes_each_layout_step_with_legacy_paths_intact() -> Result<()> {
        for interrupted in ["data-root", "config-root", "launcher-config", "unit-staged"] {
            let scratch = Scratch(env::temp_dir().join(format!("mb-{}", uuid::Uuid::new_v4())));
            let layout = Layout::new(scratch.0.clone());
            let data = layout.legacy_share.join("data");
            let releases = layout.legacy_share.join("releases");
            let units = layout.home.join(".config/systemd/user");
            for path in [&data, &releases, &layout.legacy_config, &units] {
                files::mkdir(path).map_err(boxed)?;
            }
            files::durable(&data.join("keep"), b"saved").map_err(boxed)?;
            let launcher = serde_json::json!({"dataDir":data,"releasesDir":releases,"envFile":layout.legacy_config.join("launcher.env"),"port":4317});
            files::durable(
                &layout.legacy_config.join("launcher.json"),
                &serde_json::to_vec(&launcher)?,
            )
            .map_err(boxed)?;
            files::durable(&units.join(OLD_UNIT), b"[Unit]\nDescription=Briefsip\n[Service]\nExecStart=%h/.local/share/briefsip/releases/current/bin/briefsip-launcher\n").map_err(boxed)?;
            assert!(layout
                .migrate(|phase| {
                    if phase == interrupted {
                        Err("simulated crash".into())
                    } else {
                        Ok(())
                    }
                })
                .is_err());
            assert_eq!(fs::read(data.join("keep"))?, b"saved");
            assert!(layout.legacy_config.join("launcher.json").is_file());
            layout.migrate(|_| Ok(()))?;
            layout.migrate(|_| Ok(()))?;
            let converted = files::json(&layout.config.join("launcher.json")).map_err(boxed)?;
            assert_eq!(
                converted["dataDir"],
                serde_json::to_value(layout.share.join("data"))?
            );
            assert_eq!(
                converted["releasesDir"],
                serde_json::to_value(layout.share.join("releases"))?
            );
            assert_eq!(
                converted["envFile"],
                serde_json::to_value(layout.config.join("launcher.env"))?
            );
            assert_eq!(fs::canonicalize(&data)?, layout.share.join("data"));
            assert!(units.join(OLD_UNIT).is_file());
            assert!(fs::read_to_string(units.join(UNIT))?.contains("Conflicts=briefsip.service"));
        }
        Ok(())
    }

    #[tokio::test]
    async fn bridge_reads_old_key_from_a_remote_legacy_namespace() -> Result<()> {
        let service = "minarbot/installation/fixture";
        let legacy_only = |service: String| async move {
            if service == "briefsip/installation/fixture" {
                Ok(Some("retained-key".to_owned()))
            } else {
                Err("legacy bridge rejects unknown namespace")
            }
        };
        assert_eq!(
            read_bridged_key(service, legacy_only).await?.as_deref(),
            Some("retained-key")
        );
        Ok(())
    }

    #[test]
    fn legacy_key_copy_is_verified_and_kept_for_rollback() -> Result<()> {
        let modern = "minarbot/installation/fixture";
        let legacy = "briefsip/installation/fixture";
        let keys = RefCell::new(BTreeMap::from([(
            legacy.to_owned(),
            "fixture-key".to_owned(),
        )]));
        let read = |service: &str, _: &str| Ok(keys.borrow().get(service).cloned());
        assert!(read_key(modern, "signing", read, |_, _, _| Ok(())).is_err());
        let write = |service: &str, _: &str, value: &str| {
            keys.borrow_mut()
                .insert(service.to_owned(), value.to_owned());
            Ok(())
        };
        for _ in 0..2 {
            assert_eq!(
                read_key(modern, "signing", read, write)?.as_deref(),
                Some("fixture-key")
            );
        }
        assert_eq!(read(legacy, "signing")?, read(modern, "signing")?);
        keys.borrow_mut()
            .insert(legacy.to_owned(), "after-rollback".to_owned());
        assert_eq!(
            read_key(modern, "signing", read, write)?.as_deref(),
            Some("after-rollback")
        );
        assert_eq!(read(legacy, "signing")?, read(modern, "signing")?);
        Ok(())
    }
}
