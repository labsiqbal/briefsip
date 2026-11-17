use super::Result;
use crate::{
    files::{keys, one, text},
    web::Failure,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};
fn failure(status: u16, code: &'static str, message: &str) -> Failure {
    Failure::new(status, code, message)
}
fn id(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|v| crate::web::id(v).is_some())
        .ok_or_else(|| failure(400, "invalid_id", "Invalid ID."))
}
fn revision(value: &Value, minimum: i64) -> Result<i64> {
    value
        .as_i64()
        .filter(|v| (minimum..=9007199254740991).contains(v))
        .ok_or_else(|| failure(400, "invalid_revision", "Invalid revision."))
}
pub fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS device_resource_bindings(binding_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, write INTEGER NOT NULL CHECK(write IN(0,1)), revision INTEGER NOT NULL CHECK(revision>0), deleted INTEGER NOT NULL CHECK(deleted IN(0,1))) STRICT;")?;
    Ok(())
}
pub fn save(db: &mut Connection, value: &Value) -> Result<Value> {
    if !keys(
        value,
        &[
            "bindingId",
            "projectId",
            "directory",
            "write",
            "expectedRevision",
        ],
    ) {
        return Err(failure(400, "invalid_object", "Invalid object fields."));
    }
    let binding = id(&value["bindingId"])?;
    let project = id(&value["projectId"])?;
    let expected = revision(&value["expectedRevision"], 0)?;
    let raw = value["directory"]
        .as_str()
        .filter(|v| {
            !v.is_empty()
                && v.encode_utf16().count() <= 4096
                && !v.contains('\0')
                && Path::new(v).is_absolute()
        })
        .ok_or_else(|| failure(400, "invalid_local_binding", "Invalid local binding."))?;
    let write = value["write"]
        .as_bool()
        .ok_or_else(|| failure(400, "invalid_local_binding", "Invalid local binding."))?;
    let mut directory = PathBuf::new();
    for component in Path::new(raw).components() {
        match component {
            Component::ParentDir => {
                directory.pop();
            }
            Component::CurDir => {}
            part => directory.push(part.as_os_str()),
        }
    }
    let metadata = fs::symlink_metadata(&directory).map_err(|_| {
        failure(
            400,
            "invalid_local_binding",
            "Use a local directory without symlinks.",
        )
    })?;
    if !metadata.is_dir()
        || metadata.is_symlink()
        || fs::canonicalize(&directory).ok().as_ref() != Some(&directory)
    {
        return Err(failure(
            400,
            "invalid_local_binding",
            "Use a local directory without symlinks.",
        ));
    }
    let tx = db.transaction()?;
    let current = one(
        &tx,
        "SELECT * FROM device_resource_bindings WHERE binding_id=?",
        [binding],
    )?;
    if current.as_ref().is_some_and(|v| v["project_id"] != project) {
        return Err(failure(
            409,
            "binding_project_conflict",
            "Project binding cannot be replaced.",
        ));
    }
    if current
        .as_ref()
        .and_then(|v| v["revision"].as_i64())
        .unwrap_or(0)
        != expected
    {
        return Err(failure(
            409,
            "stale_revision",
            "Binding changed. Load the latest revision.",
        ));
    }
    tx.execute("INSERT INTO device_resource_bindings VALUES(?,?,?,?,?,0) ON CONFLICT(binding_id) DO UPDATE SET directory=excluded.directory,write=excluded.write,revision=excluded.revision,deleted=0",params![binding,project,directory.to_string_lossy(),write as i64,expected+1])?;
    tx.commit()?;
    Ok(json!({"bindingId":binding,"projectId":project,"write":write,"revision":expected+1}))
}
pub fn load(db: &Connection, binding: &str, project: &str, expected: i64) -> Result<Value> {
    id(&json!(binding))?;
    id(&json!(project))?;
    revision(&json!(expected), 1)?;
    let row=one(db,"SELECT * FROM device_resource_bindings WHERE binding_id=? AND project_id=? AND revision=? AND deleted=0",params![binding,project,expected])?.ok_or_else(||failure(404,"resource_not_found","Local binding not found."))?;
    Ok(
        json!({"directory":text(&row,"directory"),"write":row["write"]==1,"revision":row["revision"]}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_revision_and_symlink_fences() -> Result<()> {
        let mut db = Connection::open_in_memory()?;
        initialize(&db)?;
        let directory =
            std::env::temp_dir().join(format!("briefsip-resource-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).map_err(|_| Failure::storage())?;
        let binding = uuid::Uuid::new_v4().to_string();
        let project = uuid::Uuid::new_v4().to_string();
        let mut value = json!({"bindingId":binding,"projectId":project,"directory":directory,"write":true,"expectedRevision":0});
        assert_eq!(save(&mut db, &value)?["revision"], 1);
        assert_eq!(load(&db, &binding, &project, 1)?["write"], true);
        assert_eq!(
            save(&mut db, &value).err().map(|e| e.code),
            Some("stale_revision")
        );
        value["expectedRevision"] = 1.into();
        value["projectId"] = uuid::Uuid::new_v4().to_string().into();
        assert_eq!(
            save(&mut db, &value).err().map(|e| e.code),
            Some("binding_project_conflict")
        );
        value["projectId"] = project.into();
        let link = directory.join("link");
        std::os::unix::fs::symlink(&directory, &link).map_err(|_| Failure::storage())?;
        value["directory"] = link.to_string_lossy().as_ref().into();
        assert_eq!(
            save(&mut db, &value).err().map(|e| e.code),
            Some("invalid_local_binding")
        );
        fs::remove_dir_all(directory).map_err(|_| Failure::storage())?;
        Ok(())
    }
}
