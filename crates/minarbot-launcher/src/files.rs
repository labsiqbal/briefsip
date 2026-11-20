use crate::Result;
use nix::unistd::getuid;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};
use uuid::Uuid;

pub fn sidecar(database: &Path, suffix: &str) -> PathBuf {
    let mut path = database.as_os_str().to_owned();
    path.push(suffix);
    path.into()
}

pub fn release_id(value: &str) -> bool {
    let Some((version, hash)) = value.rsplit_once('-') else {
        return false;
    };
    if !(8..=40).contains(&hash.len())
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return false;
    }
    let (base, prerelease) = version
        .split_once('-')
        .map_or((version, None), |(v, p)| (v, Some(p)));
    let parts: Vec<_> = base.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && prerelease.is_none_or(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        })
}
pub fn private_file(path: &Path) -> Result<()> {
    let s = fs::symlink_metadata(path)?;
    if !s.is_file() || s.nlink() != 1 || s.uid() != getuid().as_raw() || s.mode() & 0o077 != 0 {
        return Err(
            "Launcher configuration and secrets must be private files owned by this user.".into(),
        );
    }
    Ok(())
}
pub fn mkdir(path: &Path) -> Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    Ok(())
}
pub fn sync_dir(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}
pub fn durable(path: &Path, bytes: &[u8]) -> Result<()> {
    let temporary = path.with_file_name(format!(
        "{}.tmp-{}",
        path.file_name()
            .ok_or("Invalid file path")?
            .to_string_lossy(),
        Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        sync_dir(path.parent().ok_or("Invalid file path")?)
    })();
    let _ = fs::remove_file(temporary);
    result
}
pub fn remove(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
pub fn absolute(path: &Path) -> Result<PathBuf> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut result = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            _ => result.push(part),
        }
    }
    Ok(result)
}
pub fn json(path: &Path) -> Result<Value> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
pub fn path_for(releases: &Path, id: &str) -> Result<PathBuf> {
    if !release_id(id) {
        return Err("Invalid release ID.".into());
    }
    let path = releases.join(id);
    if fs::symlink_metadata(&path)?.file_type().is_symlink()
        || fs::canonicalize(&path)? != fs::canonicalize(releases)?.join(id)
    {
        return Err("Release escapes local directory.".into());
    }
    Ok(path)
}
pub fn manifest(path: &Path) -> Result<BTreeMap<String, String>> {
    fn walk(root: &Path, dir: &Path, files: &mut BTreeMap<String, String>) -> Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let s = fs::symlink_metadata(&path)?;
            let key = path
                .strip_prefix(root)?
                .to_str()
                .ok_or("Invalid release filename")?
                .to_owned();
            if s.is_dir() {
                walk(root, &path, files)?;
            } else if key == "release.json" && s.is_file() {
                continue;
            } else if s.is_file() {
                let mut file = File::open(path)?;
                let mut digest = Sha256::new();
                let mut bytes = [0; 65536];
                loop {
                    let n = file.read(&mut bytes)?;
                    if n == 0 {
                        break;
                    }
                    digest.update(&bytes[..n]);
                }
                files.insert(key, format!("{:x}", digest.finalize()));
            } else {
                return Err("Unsupported release file.".into());
            }
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    walk(path, path, &mut files)?;
    Ok(files)
}
pub fn verify(releases: &Path, id: &str) -> Result<Value> {
    let path = path_for(releases, id)?;
    let info = json(&path.join("release.json"))?;
    if info["id"] != id
        || json(&path.join("package.json"))?["version"] != info["version"]
        || serde_json::to_value(manifest(&path)?)? != info["files"]
    {
        return Err("Release SHA-256 manifest mismatch.".into());
    }
    Ok(info)
}
pub fn selection(releases: &Path, name: &str) -> Result<Option<String>> {
    let path = releases.join(name);
    let s = match fs::symlink_metadata(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if !s.file_type().is_symlink() {
        return Err("Release selection must be a symlink.".into());
    }
    let target = fs::canonicalize(path)?;
    let id = target
        .file_name()
        .and_then(|p| p.to_str())
        .ok_or("Invalid release symlink.")?;
    if target != path_for(releases, id)? {
        return Err("Invalid release symlink.".into());
    }
    Ok(Some(id.into()))
}
pub fn select(releases: &Path, name: &str, id: &str) -> Result<()> {
    path_for(releases, id)?;
    let temp = releases.join(format!("{name}.tmp-{}", Uuid::new_v4()));
    let result = (|| {
        std::os::unix::fs::symlink(id, &temp)?;
        fs::rename(&temp, releases.join(name))?;
        sync_dir(releases)
    })();
    let _ = fs::remove_file(temp);
    result
}
pub fn lease(path: &Path, message: &'static str) -> Result<rusqlite::Connection> {
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
    {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.into()),
    }
    private_file(path)?;
    let db = rusqlite::Connection::open(path)?;
    db.execute_batch("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE")
        .map_err(|_| message)?;
    Ok(db)
}
