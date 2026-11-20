use crate::db::Result;
use rustix::fs::{self, Mode, OFlags};
use std::{
    ffi::OsStr,
    fs::File,
    io::{self, Read, Write},
    os::unix::fs::MetadataExt,
    path::Path,
};
use uuid::Uuid;

pub fn open_directory(path: &Path) -> io::Result<File> {
    if path == Path::new("/") {
        File::open(path)
    } else {
        crate::files::workspace::open_directory(path)
    }
}

pub fn directory_at(parent: &File, name: impl AsRef<Path>) -> std::io::Result<File> {
    Ok(fs::openat(
        parent,
        name.as_ref(),
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?
    .into())
}

pub fn file_at(parent: &File, name: &OsStr) -> std::io::Result<File> {
    Ok(fs::openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?
    .into())
}

pub fn private(file: &File) -> bool {
    file.metadata()
        .is_ok_and(|m| m.uid() == rustix::process::getuid().as_raw() && m.mode() & 0o077 == 0)
}

pub fn bounded_read(file: File, limit: usize) -> io::Result<Vec<u8>> {
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Unsupported file. Expected a regular file without links.",
        ));
    }
    if metadata.len() > limit as u64 {
        return Err(io::Error::new(
            io::ErrorKind::FileTooLarge,
            "File exceeds the size limit.",
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::FileTooLarge,
            "File exceeds the size limit.",
        ));
    }
    Ok(bytes)
}

pub fn publish(parent: &File, name: &OsStr, bytes: &[u8]) -> Result<()> {
    let temporary = format!(".minarbot-{}.tmp", Uuid::new_v4());
    let mut file = File::from(fs::openat(
        parent,
        temporary.as_str(),
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::RUSR | Mode::WUSR,
    )?);
    let result = (|| -> Result<()> {
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::linkat(
            parent,
            temporary.as_str(),
            parent,
            name,
            fs::AtFlags::empty(),
        )?;
        Ok(())
    })();
    let cleanup = fs::unlinkat(parent, temporary.as_str(), fs::AtFlags::empty());
    parent.sync_all()?;
    result?;
    cleanup?;
    Ok(())
}
