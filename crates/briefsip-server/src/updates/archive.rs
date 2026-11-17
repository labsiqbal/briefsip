use super::{error, release, Result};
use flate2::read::MultiGzDecoder;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::Duration,
};
const LIMIT: u64 = 1024 * 1024 * 1024;
const EXPANDED: u64 = 2 * LIMIT;
pub struct Temporary(pub PathBuf);
impl Temporary {
    fn new(root: &Path, prefix: &str) -> Result<Self> {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(root)
            .map_err(|_| error(500, "Could not prepare release."))?;
        let path = root.join(format!(".{prefix}-{}", uuid::Uuid::new_v4()));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .map_err(|_| error(500, "Could not prepare release."))?;
        Ok(Self(path))
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
pub struct Archive {
    pub directory: Temporary,
    pub file: PathBuf,
    pub sha256: String,
}
fn hash(file: &Path) -> Result<String> {
    let mut file = File::open(file).map_err(|_| error(500, "Could not read release."))?;
    let mut hash = Sha256::new();
    let mut bytes = [0; 65536];
    loop {
        let n = file
            .read(&mut bytes)
            .map_err(|_| error(500, "Could not read release."))?;
        if n == 0 {
            break;
        }
        hash.update(&bytes[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn preflight(path: &Path, total: &mut u64, entries: &mut usize) -> Result<()> {
    for entry in fs::read_dir(path).map_err(|_| error(500, "Could not read release."))? {
        let entry = entry.map_err(|_| error(500, "Could not read release."))?;
        let s = fs::symlink_metadata(entry.path())
            .map_err(|_| error(500, "Could not read release."))?;
        *entries += 1;
        if *entries > 100000 {
            return Err(error(500, "Release exceeds file count limit."));
        }
        if s.is_dir() {
            preflight(&entry.path(), total, entries)?;
        } else if s.is_file() {
            *total += s.len();
            if *total > EXPANDED {
                return Err(error(500, "Expanded release exceeds size limit."));
            }
        } else {
            return Err(error(500, "Unsupported release entry."));
        }
    }
    Ok(())
}
pub async fn create(root: &Path, id: &str) -> Result<Archive> {
    release::verify(root, id)?;
    preflight(&root.join(id), &mut 0, &mut 0)?;
    let directory = Temporary::new(root, "archive")?;
    let file = directory.0.join("release.tar.gz");
    let mut child = tokio::process::Command::new("tar")
        .args(["--format=ustar", "-czf"])
        .arg(&file)
        .arg("-C")
        .arg(root.join(id))
        .arg(".")
        .kill_on_drop(true)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| error(500, "Could not package release."))?;
    let status = tokio::time::timeout(Duration::from_secs(120), child.wait())
        .await
        .map_err(|_| error(500, "Could not package release."))?
        .map_err(|_| error(500, "Could not package release."))?;
    if !status.success() {
        return Err(error(500, "Could not package release."));
    }
    if fs::metadata(&file)
        .map_err(|_| error(500, "Could not read release."))?
        .len()
        > LIMIT
    {
        return Err(error(500, "Release exceeds download limit."));
    }
    let sha256 = hash(&file)?;
    Ok(Archive {
        directory,
        file,
        sha256,
    })
}
fn number(bytes: &[u8]) -> Result<u64> {
    let text = text(bytes)?.trim();
    if text.is_empty() || !text.bytes().all(|b| (b'0'..=b'7').contains(&b)) {
        return Err(error(502, "Invalid tar number."));
    }
    u64::from_str_radix(text, 8).map_err(|_| error(502, "Invalid tar number."))
}
fn text(bytes: &[u8]) -> Result<&str> {
    std::str::from_utf8(bytes.split(|b| *b == 0).next().unwrap_or_default())
        .map_err(|_| error(502, "Unsafe tar entry."))
}
fn extract(archive: &Path, destination: &Path) -> Result<()> {
    let file = File::open(archive).map_err(|_| error(502, "Could not read peer release."))?;
    let mut stream = MultiGzDecoder::new(file).take(EXPANDED + 1);
    let mut total = 0;
    let mut entries = 0;
    let mut ended = false;
    let mut seen = HashSet::new();
    loop {
        let mut header = [0; 512];
        let n = stream
            .read(&mut header[..1])
            .map_err(|_| error(502, "Invalid tar archive."))?;
        if n == 0 {
            if !ended {
                return Err(error(502, "Truncated tar archive."));
            }
            break;
        }
        stream
            .read_exact(&mut header[1..])
            .map_err(|_| error(502, "Truncated tar archive."))?;
        total += 512;
        if total > EXPANDED {
            return Err(error(502, "Expanded release exceeds size limit."));
        }
        if header.iter().all(|b| *b == 0) {
            ended = true;
            continue;
        }
        entries += 1;
        if ended || entries > 100000 {
            return Err(error(502, "Invalid tar trailer or file count."));
        }
        let checksum: u64 = header
            .iter()
            .enumerate()
            .map(|(i, b)| {
                if (148..156).contains(&i) {
                    32
                } else {
                    u64::from(*b)
                }
            })
            .sum();
        if checksum != number(&header[148..156])? {
            return Err(error(502, "Invalid tar header checksum."));
        }
        let prefix = text(&header[345..500])?;
        let raw = if prefix.is_empty() {
            text(&header[..100])?.to_owned()
        } else {
            format!("{prefix}/{}", text(&header[..100])?)
        };
        let name = raw.strip_prefix("./").unwrap_or(&raw);
        let name = name.strip_suffix('/').unwrap_or(name);
        let kind = header[156];
        let size = number(&header[124..136])?;
        let mode = number(&header[100..108])?;
        if raw == "./" && kind == b'5' {
            continue;
        }
        if name.is_empty()
            || name.starts_with('/')
            || name.chars().any(|c| c == '\\' || c.is_control())
            || name
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
            || !seen.insert(name.to_owned())
            || ![0, b'0', b'5'].contains(&kind)
            || kind == b'5' && size != 0
            || size > EXPANDED - total
        {
            return Err(error(502, "Unsafe tar entry."));
        }
        let path = destination.join(name);
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(if kind == b'5' {
                &path
            } else {
                path.parent()
                    .ok_or_else(|| error(502, "Unsafe tar entry."))?
            })
            .map_err(|_| error(502, "Unsafe tar entry."))?;
        if kind != b'5' {
            let mut out = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(if mode & 0o111 != 0 { 0o700 } else { 0o600 })
                .open(&path)
                .map_err(|_| error(502, "Unsafe tar entry."))?;
            let mut left = size;
            let mut bytes = [0; 65536];
            while left > 0 {
                let n = left.min(bytes.len() as u64) as usize;
                stream
                    .read_exact(&mut bytes[..n])
                    .map_err(|_| error(502, "Truncated tar archive."))?;
                out.write_all(&bytes[..n])
                    .map_err(|_| error(502, "Could not save peer release."))?;
                left -= n as u64;
            }
            out.sync_all()
                .map_err(|_| error(502, "Could not save peer release."))?;
        }
        let padding = (512 - size % 512) % 512;
        let mut bytes = [0; 512];
        stream
            .read_exact(&mut bytes[..padding as usize])
            .map_err(|_| error(502, "Truncated tar archive."))?;
        total += size + padding;
        if total > EXPANDED {
            return Err(error(502, "Expanded release exceeds size limit."));
        }
    }
    Ok(())
}
pub async fn receive(
    mut response: reqwest::Response,
    root: &Path,
    id: &str,
    expected: &str,
    authorize: impl FnOnce() -> Result<()>,
) -> Result<serde_json::Value> {
    if !release::id(id)
        || expected.len() != 64
        || !expected
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || response
            .headers()
            .get("x-briefsip-sha256")
            .and_then(|v| v.to_str().ok())
            != Some(expected)
        || response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            != Some("application/gzip")
        || response.content_length().is_some_and(|n| n > LIMIT)
    {
        return Err(error(502, "Invalid peer release metadata."));
    }
    let directory = Temporary::new(root, "download")?;
    let archive = directory.0.join("release.tar.gz");
    let stage = directory.0.join(id);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&archive)
        .map_err(|_| error(502, "Could not save peer release."))?;
    let mut total = 0;
    let mut hash = Sha256::new();
    while let Some(bytes) = response.chunk().await.map_err(|_| {
        error(
            502,
            "Peer release download failed integrity, permission, time or size checks.",
        )
    })? {
        total += bytes.len() as u64;
        if total > LIMIT {
            return Err(error(502, "Release exceeds download limit."));
        }
        hash.update(&bytes);
        file.write_all(&bytes)
            .map_err(|_| error(502, "Could not save peer release."))?;
    }
    file.sync_all()
        .map_err(|_| error(502, "Could not save peer release."))?;
    drop(file);
    if format!("{:x}", hash.finalize()) != expected {
        return Err(error(502, "Release SHA-256 mismatch."));
    }
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&stage)
        .map_err(|_| error(502, "Could not save peer release."))?;
    extract(&archive, &stage)?;
    let info = release::verify(&directory.0, id)?;
    authorize()?;
    fs::rename(stage, root.join(id)).map_err(|_| error(502, "Could not publish peer release."))?;
    briefsip_launcher::files::sync_dir(root)
        .map_err(|_| error(502, "Could not publish peer release."))?;
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tar(name: &str, kind: u8, bytes: &[u8]) -> Vec<u8> {
        let mut header = [0u8; 512];
        header[..name.len()].copy_from_slice(name.as_bytes());
        header[100..108].copy_from_slice(b"0000600\0");
        header[124..136].copy_from_slice(format!("{:011o}\0", bytes.len()).as_bytes());
        header[148..156].fill(b' ');
        header[156] = kind;
        let sum: usize = header.iter().map(|b| *b as usize).sum();
        header[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
        let mut out = header.to_vec();
        out.extend(bytes);
        out.resize(512 + bytes.len().div_ceil(512) * 512, 0);
        out.extend([0; 1024]);
        out
    }
    fn check(bytes: &[u8]) -> Result<bool> {
        let root = std::env::temp_dir().join(format!("briefsip-tar-test-{}", uuid::Uuid::new_v4()));
        let directory = Temporary::new(&root, "test")?;
        let file = directory.0.join("archive.gz");
        let mut gzip = flate2::write::GzEncoder::new(
            File::create(&file).map_err(|_| error(500, "Fixture failed."))?,
            flate2::Compression::default(),
        );
        gzip.write_all(bytes)
            .map_err(|_| error(500, "Fixture failed."))?;
        gzip.finish().map_err(|_| error(500, "Fixture failed."))?;
        let stage = directory.0.join("stage");
        fs::create_dir(&stage).map_err(|_| error(500, "Fixture failed."))?;
        let result = extract(&file, &stage).is_ok();
        drop(directory);
        let _ = fs::remove_dir_all(root);
        Ok(result)
    }
    #[test]
    fn strict_ustar_rejects_links_traversal_duplicates_and_truncation() -> Result<()> {
        assert!(check(&tar("./bin/server", b'0', b"native"))?);
        for (name, kind) in [
            ("../outside", b'0'),
            ("/outside", b'0'),
            ("dir/../outside", b'0'),
            ("symlink", b'2'),
            ("hardlink", b'1'),
            ("device", b'3'),
            ("bad\\path", b'0'),
        ] {
            assert!(!check(&tar(name, kind, b""))?, "{name}");
        }
        let mut repeated = tar("file", b'0', b"x");
        repeated.truncate(1024);
        repeated.extend(tar("file", b'0', b"y"));
        assert!(!check(&repeated)?);
        assert!(!check(&tar("file", b'0', b"x")[..514])?);
        let mut checksum = tar("file", b'0', b"x");
        checksum[0] ^= 1;
        assert!(!check(&checksum)?);
        Ok(())
    }
}
