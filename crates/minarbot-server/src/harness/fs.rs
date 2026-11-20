use super::*;
pub async fn request(
    state: &AppState,
    turn: &Value,
    binding: &crate::config::WorkspaceConfig,
    write: bool,
    p: &Value,
    token: &str,
) -> Result<Value> {
    let root = &binding.directory;
    let path = string(p, "path");
    if !store::inside(root, path) {
        return Err(error(403, "Workspace path is unavailable."));
    }
    let path = if std::path::Path::new(path).is_absolute() {
        std::path::Path::new(path)
            .strip_prefix(root)
            .ok()
            .and_then(|p| p.to_str())
            .ok_or_else(|| error(403, "Workspace path is unavailable."))?
    } else {
        path
    };
    if !write {
        let (_, bytes) = crate::files::workspace::download(root, path)?;
        if bytes.len() > 1024 * 1024 {
            return Err(error(413, "File exceeds 1 MiB."));
        }
        let line = p
            .get("line")
            .map(|v| v.as_u64().filter(|n| *n >= 1))
            .unwrap_or(Some(1))
            .ok_or_else(|| error(400, "Invalid line offset."))?;
        let limit = p
            .get("limit")
            .map(|v| v.as_u64().filter(|n| *n >= 1))
            .unwrap_or(Some(u64::MAX))
            .ok_or_else(|| error(400, "Invalid line limit."))?;
        return Ok(
            json!({"content":String::from_utf8_lossy(&bytes).split('\n').skip(usize::try_from(line-1).unwrap_or(usize::MAX)).take(usize::try_from(limit).unwrap_or(usize::MAX)).collect::<Vec<_>>().join("\n")}),
        );
    }
    let content = p["content"]
        .as_str()
        .filter(|s| s.len() <= 32768)
        .ok_or_else(|| error(400, "Invalid file content."))?;
    if !binding.write
        || !approve(
            state,
            string(turn, "id"),
            "file",
            None,
            &format!("Write {path}"),
            p,
            token,
        )
        .await?
    {
        return Err(error(403, "Workspace write was not allowed."));
    }
    let mut args = json!({"path":path,"text":content});
    let name = match crate::files::workspace::download(root, path) {
        Ok((_, bytes)) => {
            args["digest"] = json!(crate::mcp::hash_bytes(&bytes));
            "replace_workspace_file"
        }
        Err(_) => "create_workspace_file",
    };
    let result = crate::turns::harness::tool(
        state,
        string(turn, "id"),
        name,
        &args,
        &uuid::Uuid::new_v4().to_string(),
    )
    .await?;
    if result["uncertain"] == true || result["error"].is_string() {
        return Err(error(
            502,
            "Workspace write is uncertain. Inspect recovery bytes before retrying.",
        ));
    }
    Ok(json!({}))
}
