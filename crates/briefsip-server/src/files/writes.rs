use super::*;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
};

fn invalid() -> Failure {
    error(400, "Invalid workspace path")
}
fn path(value: &str, max: usize) -> Result<&str> {
    if value.is_empty()
        || value.encode_utf16().count() > max
        || value
            .chars()
            .any(|c| c <= '\x1f' || c == '\x7f' || c == '\\')
        || value
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err(invalid());
    }
    Ok(value)
}
fn parent(root: &Path, relative: &str, max: usize) -> Result<(File, String)> {
    path(relative, max)?;
    let (parent, name) = relative.rsplit_once('/').unwrap_or(("", relative));
    Ok((
        workspace::open_directory(&if parent.is_empty() {
            root.to_path_buf()
        } else {
            root.join(parent)
        })
        .map_err(|_| invalid())?,
        name.to_owned(),
    ))
}
fn location(fd: &File, name: &str) -> PathBuf {
    PathBuf::from(format!("/proc/self/fd/{}/{name}", fd.as_raw_fd()))
}
fn io<T>(value: std::io::Result<T>) -> Result<T> {
    value.map_err(|_| error(400, "Workspace operation failed."))
}
fn digest(args: &Value) -> Result<&str> {
    args["digest"]
        .as_str()
        .filter(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .ok_or_else(|| error(400, "Invalid workspace deletion"))
}
fn text_file(args: &Value) -> Result<&str> {
    args["text"]
        .as_str()
        .filter(|s| {
            s.len() <= 32768
                && s.encode_utf16().count() <= 32768
                && !s.chars().any(|c| {
                    c <= '\x08' || c == '\x0b' || c == '\x0c' || ('\x0e'..='\x1f').contains(&c)
                })
        })
        .ok_or_else(|| error(400, "Invalid workspace file"))
}
fn publish(root: &Path, relative: &str, bytes: &[u8]) -> Result<Value> {
    let (fd, name) = parent(root, relative, 2048)?;
    let staged = location(&fd, &format!(".briefsip-{}.tmp", uuid::Uuid::new_v4()));
    let mut output = io(OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(0x20000)
        .open(&staged))?;
    let result = (|| {
        io(output.write_all(bytes))?;
        io(output.sync_all())?;
        io(fs::hard_link(&staged, location(&fd, &name)))?;
        Ok(
            json!({"path":relative,"digest":format!("{:x}",Sha256::digest(bytes)),"size":bytes.len()}),
        )
    })();
    drop(output);
    let cleanup = io(fs::remove_file(&staged)).and_then(|_| io(fd.sync_all()));
    match result {
        Err(e) => Err(e),
        Ok(v) => {
            cleanup?;
            Ok(v)
        }
    }
}
pub fn publish_generated(
    db: &Connection,
    binding: &crate::config::WorkspaceConfig,
    name: &str,
    text: &str,
    previous: Option<&str>,
) -> Result<()> {
    if !binding.write {
        return Err(error(403, "Workspace does not have write permission."));
    }
    let root = &binding.directory;
    let (fd, filename) = parent(root, name, 2048)?;
    match fs::symlink_metadata(location(&fd, &filename)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            publish(root, name, text.as_bytes())?;
        }
        Ok(meta) if meta.is_file() => {
            let bytes = workspace::read_bytes(&fd, &filename, 32768)?;
            if bytes == text.as_bytes() {
                return Ok(());
            }
            let digest = format!("{:x}", Sha256::digest(&bytes));
            if previous != Some(digest.as_str()) {
                return Err(error(409, "File already exists. Read it before editing."));
            }
            let replaced = perform(
                db,
                root,
                &binding.agent,
                "replace_workspace_file",
                &json!({"path":name,"text":text,"digest":digest}),
            )?;
            if replaced["replaced"] != true {
                return Err(error(409, text_result_error(&replaced)));
            }
        }
        _ => {
            return Err(error(
                409,
                "Workspace destination is unavailable or is not a regular file.",
            ))
        }
    }
    Ok(())
}

fn text_result_error(result: &Value) -> String {
    let message = text(result, "error");
    let recovery = text(result, "recoveryPath");
    format!("{message} Recovery file: {recovery}")
}

fn remove(root: &Path, args: &Value) -> Result<Value> {
    if !keys(args, &["path", "digest"]) {
        return Err(error(400, "Invalid workspace deletion"));
    }
    let relative = text(args, "path");
    let expected = digest(args)?;
    let (fd, name) = parent(root, relative, 2048)?;
    let bytes = workspace::read_bytes(&fd, &name, 10 * 1024 * 1024)?;
    if format!("{:x}", Sha256::digest(bytes)) != expected {
        return Err(error(
            409,
            "File changed since it was read. Removal cancelled.",
        ));
    }
    let recovery = format!(".briefsip-removed-{}", uuid::Uuid::new_v4());
    let recovery_path = relative
        .rsplit_once('/')
        .map(|(p, _)| format!("{p}/{recovery}/file"))
        .unwrap_or_else(|| format!("{recovery}/file"));
    let directory = location(&fd, &recovery);
    io(fs::DirBuilder::new().mode(0o700).create(&directory))?;
    let saved = io(OpenOptions::new()
        .read(true)
        .custom_flags(0x20000 | 0x10000)
        .open(&directory))?;
    io(fd.sync_all())?;
    let moved = (|| {
        io(fs::rename(location(&fd, &name), location(&saved, "file")))?;
        io(saved.sync_all())?;
        io(fd.sync_all())?;
        let bytes = workspace::read_bytes(&saved, "file", 10 * 1024 * 1024)?;
        if format!("{:x}", Sha256::digest(bytes)) != expected {
            return Err(error(409, "File changed during removal"));
        }
        Ok(json!({"path":relative,"removed":true,"digest":expected,"recoveryPath":recovery_path}))
    })();
    Ok(moved.unwrap_or_else(|_:Failure|json!({"path":relative,"uncertain":true,"recoveryPath":recovery_path,"error":"Removal did not confirm success. Inspect the original and recovery paths before retrying. Recovery content was not erased."})))
}
fn restore(root: &Path, args: &Value) -> Result<Value> {
    if !keys(args, &["path", "recoveryPath", "digest"]) {
        return Err(error(400, "Invalid workspace recovery"));
    }
    path(text(args, "path"), 2048)?;
    let source = path(text(args, "recoveryPath"), 4096)?;
    let parts: Vec<_> = source.split('/').collect();
    if parts.last() != Some(&"file")
        || !parts
            .get(parts.len().saturating_sub(2))
            .is_some_and(|p| p.strip_prefix(".briefsip-removed-").is_some_and(valid_id))
    {
        return Err(error(400, "Invalid workspace recovery path"));
    }
    let (fd, name) = parent(root, source, 4096)?;
    let bytes = workspace::read_bytes(&fd, &name, 10 * 1024 * 1024)?;
    if format!("{:x}", Sha256::digest(&bytes)) != digest(args)? {
        return Err(error(409, "Recovery file changed; restoration refused"));
    }
    let mut result = publish(root, text(args, "path"), &bytes)?;
    result["restored"] = json!(true);
    result["recoveryPath"] = json!(source);
    Ok(result)
}
pub fn perform(
    db: &Connection,
    root: &Path,
    agent: &str,
    name: &str,
    args: &Value,
) -> Result<Value> {
    match name {
        "create_workspace_file" => {
            if !keys(args, &["path", "text"]) {
                return Err(error(400, "Invalid workspace file"));
            }
            publish(root, text(args, "path"), text_file(args)?.as_bytes())
        }
        "create_workspace_directory" => {
            if !keys(args, &["path"]) {
                return Err(error(400, "Invalid workspace directory"));
            }
            let (fd, name) = parent(root, text(args, "path"), 2048)?;
            io(fs::DirBuilder::new()
                .mode(0o700)
                .create(location(&fd, &name)))?;
            io(fd.sync_all())?;
            Ok(json!({"path":args["path"],"kind":"directory"}))
        }
        "delete_workspace_file" => remove(root, args),
        "restore_workspace_file" => restore(root, args),
        "replace_workspace_file" => {
            if !keys(args, &["path", "digest", "text"]) {
                return Err(error(400, "Invalid workspace replacement"));
            }
            let content = text_file(args)?;
            path(text(args, "path"), 2048)?;
            digest(args)?;
            let removed = remove(root, &json!({"path":args["path"],"digest":args["digest"]}))?;
            if removed["removed"] != true {
                return Ok(removed);
            }
            Ok(
                match publish(root, text(args, "path"), content.as_bytes()) {
                    Ok(mut result) => {
                        result["replaced"] = json!(true);
                        result["previousDigest"] = args["digest"].clone();
                        result["recoveryPath"] = removed["recoveryPath"].clone();
                        result
                    }
                    Err(_) => {
                        json!({"path":args["path"],"uncertain":true,"recoveryPath":removed["recoveryPath"],"error":"Replacement did not confirm publication. Inspect the original path and recovery bytes before retrying."})
                    }
                },
            )
        }
        "copy_skill_file" => {
            if !keys(args, &["id", "source", "path"])
                || args["id"].as_str().is_none_or(|v| v.len() > 36)
                || args["source"]
                    .as_str()
                    .is_none_or(|v| v.encode_utf16().count() > 240)
            {
                return Err(error(400, "Invalid skill file copy"));
            }
            path(text(args, "path"), 2048)?;
            let row=one(db,"SELECT f.files FROM agent_skills a JOIN skill_files f ON f.skill=a.skill AND f.revision=a.version WHERE a.agent=? AND a.skill=? AND a.enabled=1 AND a.removed=0",[agent,text(args,"id")])?.ok_or_else(||error(404,"Enabled installed skill file not found"))?;
            let files: Value =
                serde_json::from_str(text(&row, "files")).map_err(|_| Failure::storage())?;
            let parsed = skills::parse_files(&files)?;
            let file = parsed["files"]
                .as_array()
                .and_then(|files| files.iter().find(|f| f["path"] == args["source"]))
                .ok_or_else(|| error(404, "Enabled installed skill file not found"))?;
            let bytes = if file["encoding"] == "base64" {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD
                    .decode(text(file, "content"))
                    .map_err(|_| Failure::storage())?
            } else {
                text(file, "content").as_bytes().to_vec()
            };
            if bytes.len() > 2 * 1024 * 1024 {
                return Err(error(400, "Invalid workspace asset"));
            }
            publish(root, text(args, "path"), &bytes)
        }
        _ => Err(error(400, "Workspace tool is unavailable.")),
    }
}

pub fn initialize(db: &Connection) -> crate::db::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS flow_tool_calls(seq INTEGER PRIMARY KEY AUTOINCREMENT,turn TEXT NOT NULL REFERENCES turns(id),call_id TEXT NOT NULL,call TEXT NOT NULL,result TEXT NOT NULL,after_output INTEGER NOT NULL,after_action INTEGER,UNIQUE(turn,call_id)) STRICT;")?;
    let columns =
        crate::files::rows(db, "PRAGMA table_info(flow_tool_calls)", []).map_err(|e| e.message)?;
    if !columns.iter().any(|row| row["name"] == "after_action") {
        db.execute(
            "ALTER TABLE flow_tool_calls ADD COLUMN after_action INTEGER",
            [],
        )?;
    }
    db.execute_batch("CREATE TABLE IF NOT EXISTS workspace_writes(turn TEXT NOT NULL REFERENCES turns(id),call_id TEXT NOT NULL,call TEXT NOT NULL,after_output INTEGER NOT NULL,after_action INTEGER NOT NULL,PRIMARY KEY(turn,call_id)) STRICT;
        INSERT INTO flow_tool_calls(turn,call_id,call,result,after_output,after_action)
        SELECT turn,call_id,call,'{\"uncertain\":true,\"error\":\"Workspace operation was interrupted. Ask the host owner to inspect the requested path, sibling .briefsip-removed-* recovery directories and orphan .briefsip-*.tmp staging links before any new write; no automatic replay occurred.\"}',after_output,after_action
        FROM workspace_writes w WHERE NOT EXISTS (SELECT 1 FROM flow_tool_calls f WHERE f.turn=w.turn AND f.call_id=w.call_id);")?;
    Ok(())
}
pub fn execute(
    db: &Connection,
    binding: &crate::config::WorkspaceConfig,
    turn: &str,
    call: &Value,
    after_action: i64,
) -> Result<Value> {
    if !binding.write {
        return Err(error(403, "Workspace does not have write permission."));
    }
    let row = one(db, "SELECT agent,status FROM turns WHERE id=?", [turn])?
        .ok_or_else(|| error(409, "Task has stopped."))?;
    if row["agent"] != binding.agent || row["status"] != "running" {
        return Err(error(409, "Task has stopped."));
    }
    let call_id = text(call, "id");
    if call_id.is_empty() || call_id.encode_utf16().count() > 200 {
        return Err(error(400, "Invalid tool call ID."));
    }
    if one(
        db,
        "SELECT 1 FROM workspace_writes WHERE turn=? AND call_id=?",
        [turn, call_id],
    )?
    .is_some()
    {
        return Err(error(409, "Workspace write already attempted"));
    }
    let args: Value = serde_json::from_str(text(&call["function"], "arguments"))
        .map_err(|_| error(400, "Invalid JSON."))?;
    let name = text(&call["function"], "name");
    if !args.is_object() {
        return Err(error(400, "Invalid workspace arguments."));
    }
    let count: i64 = db.query_row(
        "SELECT count(*) FROM generated_files WHERE turn=?",
        [turn],
        |r| r.get(0),
    )?;
    db.execute(
        "INSERT INTO workspace_writes VALUES(?,?,?,?,?)",
        rusqlite::params![turn, call_id, call.to_string(), count, after_action],
    )?;
    let result=perform(db,&binding.directory,&binding.agent,name,&args).unwrap_or_else(|_|json!({"uncertain":true,"error":if name=="delete_workspace_file" {"Removal did not confirm success. Inspect the original path and sibling .briefsip-removed-* recovery directories before retrying."}else{"Workspace operation did not confirm success. Existing files are never replaced. Ask the host owner to inspect the requested path and orphan .briefsip-*.tmp staging links before trying again."}}));
    db.execute("INSERT INTO flow_tool_calls(turn,call_id,call,result,after_output,after_action) VALUES(?,?,?,?,?,?)",rusqlite::params![turn,call_id,call.to_string(),result.to_string(),count,after_action])?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removal_and_restore_result_loss_preserve_recovery_and_never_replay() -> crate::db::Result<()>
    {
        use rusqlite::OptionalExtension;
        for operation in ["delete_workspace_file", "restore_workspace_file"] {
            let root =
                std::env::temp_dir().join(format!("briefsip-rust-writes-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root)?;
            let result = (|| -> crate::db::Result<()> {
                let db = Connection::open_in_memory()?;
                db.execute_batch(
                    "CREATE TABLE turns(id TEXT PRIMARY KEY,agent TEXT,status TEXT);
                    INSERT INTO turns VALUES ('turn','agent','running');
                    CREATE TABLE generated_files(turn TEXT);",
                )?;
                initialize(&db)?;
                let binding = crate::config::WorkspaceConfig {
                    agent: "agent".into(),
                    directory: root.clone(),
                    write: true,
                    managed: false,
                };
                let path = root.join("file");
                fs::write(&path, b"KEEP")?;
                let mut args =
                    json!({"path":"file","digest":format!("{:x}", Sha256::digest(b"KEEP"))});
                if operation == "restore_workspace_file" {
                    let removed = remove(&root, &args).map_err(|e| e.message)?;
                    assert_eq!(removed["removed"], true);
                    args["recoveryPath"] = removed["recoveryPath"].clone();
                }
                let call = json!({"id":"fixture","type":"function","function":{"name":operation,"arguments":args.to_string()}});
                db.execute_batch(
                    "CREATE TRIGGER lose_result BEFORE INSERT ON flow_tool_calls
                    BEGIN SELECT RAISE(ABORT,'lost result'); END;",
                )?;
                assert!(execute(&db, &binding, "turn", &call, 0).is_err());
                assert_eq!(path.exists(), operation == "restore_workspace_file");
                if path.exists() {
                    assert_eq!(fs::read(&path)?, b"KEEP");
                }
                let recovery = fs::read_dir(&root)?
                    .filter_map(|entry| entry.ok())
                    .find(|entry| {
                        entry
                            .file_name()
                            .to_string_lossy()
                            .starts_with(".briefsip-removed-")
                    })
                    .ok_or("Recovery directory missing")?
                    .path()
                    .join("file");
                assert_eq!(fs::read(&recovery)?, b"KEEP");
                assert_eq!(
                    db.query_row("SELECT result FROM flow_tool_calls", [], |row| row
                        .get::<_, String>(0))
                        .optional()?,
                    None
                );
                fs::write(&path, b"NEW")?;
                db.execute_batch("DROP TRIGGER lose_result")?;
                initialize(&db)?;
                initialize(&db)?;
                let receipt: String = db.query_row(
                    "SELECT result FROM flow_tool_calls WHERE call_id='fixture'",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(serde_json::from_str::<Value>(&receipt)?["uncertain"], true);
                assert_eq!(
                    db.query_row("SELECT count(*) FROM flow_tool_calls", [], |row| row
                        .get::<_, i64>(0))?,
                    1
                );
                let retry = execute(&db, &binding, "turn", &call, 0);
                assert!(retry.is_err_and(|e| e.message.contains("already attempted")));
                assert_eq!(fs::read(&path)?, b"NEW");
                assert_eq!(fs::read(recovery)?, b"KEEP");
                Ok(())
            })();
            fs::remove_dir_all(root)?;
            result?;
        }
        Ok(())
    }

    #[test]
    fn writes_preserve_recovery_bytes_and_never_overwrite_or_follow_links() -> crate::db::Result<()>
    {
        let root =
            std::env::temp_dir().join(format!("briefsip-rust-writes-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root)?;
        let db = Connection::open_in_memory()?;
        let run = |name, args| perform(&db, &root, "", name, &args).map_err(|e| e.message);
        let result = (|| -> crate::db::Result<()> {
            let created = run(
                "create_workspace_file",
                json!({"path":"note","text":"original"}),
            )?;
            assert!(run(
                "create_workspace_file",
                json!({"path":"note","text":"overwrite"})
            )
            .is_err());
            assert!(run(
                "delete_workspace_file",
                json!({"path":"note","digest":"0".repeat(64)})
            )
            .is_err());
            let replaced = run(
                "replace_workspace_file",
                json!({"path":"note","digest":created["digest"],"text":"next"}),
            )?;
            assert_eq!(
                fs::read(root.join(text(&replaced, "recoveryPath")))?,
                b"original"
            );
            let restored = run(
                "restore_workspace_file",
                json!({"path":"copy","digest":created["digest"],"recoveryPath":replaced["recoveryPath"]}),
            )?;
            assert_eq!(restored["restored"], true);
            assert_eq!(fs::read(root.join("copy"))?, b"original");
            assert!(run("restore_workspace_file",json!({"path":"copy","digest":created["digest"],"recoveryPath":replaced["recoveryPath"]})).is_err());
            for p in ["../escape", "/tmp/escape", "note/../escape", "note/"] {
                assert!(run("create_workspace_file", json!({"path":p,"text":"bad"})).is_err());
            }
            std::os::unix::fs::symlink("copy", root.join("link"))?;
            assert!(run(
                "delete_workspace_file",
                json!({"path":"link","digest":created["digest"]})
            )
            .is_err());
            fs::hard_link(root.join("copy"), root.join("hard"))?;
            assert!(run(
                "delete_workspace_file",
                json!({"path":"hard","digest":created["digest"]})
            )
            .is_err());
            Ok(())
        })();
        fs::remove_dir_all(root)?;
        result
    }
}
