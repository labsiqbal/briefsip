use super::*;
use crate::config::WorkspaceConfig;
use axum::{http::header, response::IntoResponse};
use std::{collections::HashSet, path::PathBuf};
struct Scope {
    kind: String,
    id: String,
    agent: Option<String>,
    project: Option<String>,
    workspace: Option<WorkspaceConfig>,
}
fn table(db: &Connection, name: &str) -> Result<bool> {
    Ok(one(
        db,
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?",
        [name],
    )?
    .is_some())
}
fn condition(kind: &str) -> &'static str {
    match kind {
        "agents" => "t.agent=? AND t.channel IS NULL AND t.thread IS NULL",
        "channels" => "t.channel=?",
        _ => "t.thread=?",
    }
}
fn scope(state: &AppState, kind: &str, id: &str) -> Result<Scope> {
    let db = state.database.lock().map_err(|_| Failure::storage())?;
    let db = &db.connection;
    scope_db(state, db, kind, id, None)
}
fn scope_db(
    state: &AppState,
    db: &Connection,
    kind: &str,
    id: &str,
    turn_agent: Option<&str>,
) -> Result<Scope> {
    let current = context(db, kind, id)?;
    let mut agent = if kind == "agents" {
        Some(id.to_owned())
    } else if kind == "threads" {
        Some(text(&current, "agent").to_owned())
    } else {
        turn_agent.map(str::to_owned)
    };
    let project = if kind == "threads" && table(db, "local_project_threads")? {
        one(
            db,
            "SELECT project,folder FROM local_project_threads WHERE thread=?",
            [id],
        )?
    } else if kind == "channels"
        && rows(db, "PRAGMA table_info(channels)", [])?
            .iter()
            .any(|r| r["name"] == "project")
    {
        one(
            db,
            "SELECT project FROM channels WHERE id=? AND project IS NOT NULL",
            [id],
        )?
    } else {
        None
    };
    let mut workspace = None;
    if let Some(project) = &project {
        let p = text(project, "project");
        let current = one(
            db,
            "SELECT id,archived FROM local_projects WHERE id=? AND deleted=0",
            [p],
        )?
        .ok_or_else(|| error(404, "Project not found."))?;
        let members = rows(
            db,
            "SELECT agent,write FROM local_project_members WHERE project=? ORDER BY rowid",
            [p],
        )?;
        if kind == "channels" && agent.is_none() {
            let channel = rows(
                db,
                "SELECT agent FROM channel_members WHERE channel=?",
                [id],
            )?;
            agent = members
                .iter()
                .find(|m| channel.iter().any(|c| c["agent"] == m["agent"]))
                .map(|m| text(m, "agent").to_owned());
        }
        if let Some(agent) = &agent {
            let member = members
                .iter()
                .find(|m| m["agent"] == *agent)
                .ok_or_else(|| error(403, "Agent is not a project member."))?;
            if current["archived"] != 1 {
                let folders=rows(db,"SELECT directory FROM local_project_folders WHERE project=? ORDER BY directory",[p])?;
                if !folders.is_empty() {
                    let folder = project
                        .get("folder")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| text(&folders[0], "directory"));
                    if !folders.iter().any(|f| f["directory"] == folder) {
                        return Err(error(403, "Folder is not in this project."));
                    }
                    let directory = PathBuf::from(folder);
                    workspace::open_directory(&directory).map_err(|_|error(400,"Panel content could not be read. Check the path, permissions and supported file size, then reload."))?;
                    workspace = Some(WorkspaceConfig {
                        agent: agent.clone(),
                        directory,
                        write: member["write"] == 1,
                    });
                }
            }
        }
    } else if kind != "channels" {
        if let Some(agent) = &agent {
            workspace = crate::data::agent_folders::effective(state, db, agent).ok();
        }
    }
    Ok(Scope {
        kind: kind.to_owned(),
        id: id.to_owned(),
        agent,
        project: project.map(|p| text(&p, "project").to_owned()),
        workspace,
    })
}
pub(super) fn binding_for_turn(
    state: &AppState,
    agent: &str,
    turn: &str,
) -> Result<Option<WorkspaceConfig>> {
    let db = state.database.lock().map_err(|_| Failure::storage())?;
    let row = one(
        &db.connection,
        "SELECT agent,channel,thread FROM turns WHERE id=?",
        [turn],
    )?;
    if let Some(row) = row {
        if row["agent"] != agent {
            return Err(error(404, "Checkpoint not found."));
        }
        if let Some(thread) = row["thread"].as_str() {
            return Ok(scope_db(state, &db.connection, "threads", thread, Some(agent))?.workspace);
        }
        if let Some(channel) = row["channel"].as_str() {
            return Ok(
                scope_db(state, &db.connection, "channels", channel, Some(agent))?.workspace,
            );
        }
    }
    crate::data::agent_folders::effective(state, &db.connection, agent).map(Some)
}
fn outputs(db: &Connection, scope: &Scope) -> Result<HashSet<String>> {
    let mut result = HashSet::new();
    let turn_rows = rows(
        db,
        &format!(
            "SELECT t.id FROM turns t WHERE {} ORDER BY t.seq DESC",
            condition(&scope.kind)
        ),
        [&scope.id],
    )?;
    for turn in turn_rows {
        let mut queue = vec![text(&turn, "id").to_owned()];
        let mut seen = HashSet::new();
        while let Some(turn) = queue.pop() {
            if !seen.insert(turn.clone()) {
                continue;
            }
            for source in ["generated_files", "mcp_files", "image_generations"] {
                if table(db, source)? {
                    for file in rows(
                        db,
                        &format!("SELECT file FROM {source} WHERE turn=? AND file IS NOT NULL"),
                        [&turn],
                    )? {
                        result.insert(text(&file, "file").to_owned());
                    }
                }
            }
            if table(db, "agent_requests")? && table(db, "agent_deliveries")? {
                for row in rows(db,"SELECT child.id FROM agent_requests r JOIN agent_deliveries d ON d.request=r.id JOIN turns child ON child.id=d.turn JOIN threads th ON th.id=child.thread AND th.deleted=0 WHERE r.turn=? AND r.expects_reply=1",[&turn])?{queue.push(text(&row,"id").to_owned());}
            }
        }
    }
    Ok(result)
}
pub fn authorize_file(
    state: &AppState,
    db: &Connection,
    kind: &str,
    id: &str,
    file: &str,
    deleted: bool,
) -> Result<String> {
    let scope = scope_db(state, db, kind, id, None)?;
    let row = one(
        db,
        if deleted {
            "SELECT scope FROM files WHERE id=?"
        } else {
            "SELECT scope FROM files WHERE id=? AND deleted=0"
        },
        [file],
    )?
    .ok_or_else(|| error(404, "File not found in this conversation."))?;
    if row["scope"] != format!("{kind}:{id}") && !outputs(db, &scope)?.contains(file) {
        return Err(error(404, "File not found in this conversation."));
    }
    Ok(text(&row, "scope").to_owned())
}
fn files(db: &Connection, scope: &Scope, before: i64, html: bool) -> Result<Vec<Value>> {
    let shared = json!(outputs(db, scope)?.into_iter().collect::<Vec<_>>()).to_string();
    let name = if html {
        " AND (lower(name) LIKE '%.html' OR lower(name) LIKE '%.htm')"
    } else {
        ""
    };
    let mut stmt=db.prepare(&format!("SELECT seq,id,name,length(bytes),substr(bytes,1,24) FROM files WHERE deleted=0 AND seq<? AND (scope=? OR id IN(SELECT value FROM json_each(?))){name} ORDER BY seq DESC {}",if html{""}else{"LIMIT 100"}))?;
    let result=stmt.query_map(rusqlite::params![before,format!("{}:{}",scope.kind,scope.id),shared],|r|Ok(json!({"seq":r.get::<_,i64>(0)?,"id":r.get::<_,String>(1)?,"name":r.get::<_,String>(2)?,"size":r.get::<_,i64>(3)?,"image":attachments::image_type(&r.get::<_,Vec<u8>>(4)?).is_some()})))?.collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(result)
}
fn sites(db: &Connection, scope: &Scope) -> Result<Vec<Value>> {
    if !table(db, "flow_tool_calls")? {
        return Ok(Vec::new());
    }
    rows(db,&format!("SELECT DISTINCT s.id,s.name,s.revision FROM local_sites s JOIN flow_tool_calls f ON json_extract(f.result,'$.id')=s.id JOIN turns t ON t.id=f.turn WHERE {} AND json_extract(f.call,'$.function.name')='publish_site' AND s.agent=t.agent AND s.deleted=0 ORDER BY s.id",condition(&scope.kind)),[&scope.id])
}
fn check_scope(state: &AppState, original: &Scope) -> Result<()> {
    let current = scope(state, &original.kind, &original.id)?;
    if current.workspace.as_ref().map(|w| &w.directory)
        != original.workspace.as_ref().map(|w| &w.directory)
    {
        return Err(error(
            409,
            "Conversation workspace changed. Reload the panel.",
        ));
    }
    Ok(())
}
pub async fn handle(state: &AppState, req: Request, parts: &[&str]) -> Result<Response> {
    if req.headers().contains_key(header::AUTHORIZATION)
        || req.headers().contains_key(header::ORIGIN)
            && !crate::allowed(state, crate::text_header(req.headers(), "origin"))
    {
        return Err(error(
            403,
            "Conversation panel requires the local owner in Briefsip.",
        ));
    }
    if req.method() != Method::GET {
        return Err(error(405, "Use GET for panel reads."));
    }
    if !valid_id(parts[2]) {
        return Err(error(404, "Conversation not found."));
    }
    let kind = parts[1];
    let id = parts[2];
    let section = parts.get(4).copied();
    let operation = parts.get(5).copied();
    let scope = scope(state, kind, id)?;
    let q = query(&req);
    let allowed = match section {
        None | Some("sites") => vec![],
        Some("files") => {
            if operation.is_some() {
                vec!["preview", "metadata"]
            } else {
                vec!["before"]
            }
        }
        Some("git") => {
            if operation == Some("diff") {
                vec!["path"]
            } else {
                vec![]
            }
        }
        _ => match operation {
            Some("entries") => vec!["path", "after"],
            Some("download") => vec!["path"],
            _ => vec!["path", "offset", "digest", "preview"],
        },
    };
    if !query_keys(&q, &allowed) {
        return Err(error(400, "Invalid panel parameters."));
    }
    if section.is_none() {
        let db = state.database.lock().map_err(|_| Failure::storage())?;
        let workspace=scope.workspace.as_ref().map(|w|json!({"name":w.directory.file_name().map(|s|s.to_string_lossy()),"project":scope.project}));
        let mut result = json!({"workspace":workspace,"computer":if kind=="channels" {Value::Null}else{json!(scope.agent)},"sites":sites(&db.connection,&scope)?,"previews":files(&db.connection,&scope,9007199254740991,true)?});
        if scope.project.is_none() {
            if let Some(w) = result["workspace"].as_object_mut() {
                w.remove("project");
            }
        }
        return Ok(json_response(200, result));
    }
    if section == Some("files") {
        let file = {
            let db = state.database.lock().map_err(|_| Failure::storage())?;
            if operation.is_none() {
                let before = parameter(&q, "before")
                    .unwrap_or("9007199254740991")
                    .parse::<i64>()
                    .ok()
                    .filter(|n| (1..=9007199254740991).contains(n))
                    .ok_or_else(|| error(400, "Invalid file list position."))?;
                return Ok(json_response(
                    200,
                    json!(files(&db.connection, &scope, before, false)?),
                ));
            }
            let file = operation.ok_or_else(Failure::storage)?;
            if !valid_id(file) {
                return Err(error(404, "File not found."));
            }
            let source = authorize_file(state, &db.connection, kind, id, file, false)?;
            attachments::file(&db.connection, file, &source)?
        };
        let result = attachments::read(state, file, &q).await?;
        check_scope(state, &scope)?;
        {
            let db = state.database.lock().map_err(|_| Failure::storage())?;
            authorize_file(
                state,
                &db.connection,
                kind,
                id,
                operation.unwrap_or(""),
                false,
            )?;
        }
        return Ok(result);
    }
    if section == Some("sites") {
        let db = state.database.lock().map_err(|_| Failure::storage())?;
        let site = operation
            .filter(|site| {
                sites(&db.connection, &scope).is_ok_and(|s| s.iter().any(|s| s["id"] == *site))
            })
            .ok_or_else(|| error(404, "Site not found in this conversation."))?;
        let row = one(
            &db.connection,
            "SELECT html FROM local_sites WHERE id=? AND deleted=0",
            [site],
        )?
        .ok_or_else(|| error(404, "Site not found in this conversation."))?;
        let mut response = preview::render(text(&row, "html").to_owned(), false);
        response.headers_mut().remove(header::CONTENT_DISPOSITION);
        return Ok(response);
    }
    if section == Some("git") {
        if operation.is_some_and(|op| op != "diff") {
            return Err(error(404, "Panel operation not found."));
        }
        let mut result = if operation == Some("diff") {
            let binding = scope.workspace.as_ref().ok_or_else(|| {
                error(
                    403,
                    "Agent workspace is not connected by the host owner yet.",
                )
            })?;
            git::diff(binding, parameter(&q, "path")).await?
        } else {
            git::status(scope.workspace.as_ref()).await?
        };
        check_scope(state, &scope)?;
        if result.get("isRepo").is_some() {
            let mut filtered = json!({"isRepo":result["isRepo"]});
            for key in ["branch", "changedFiles"] {
                if let Some(v) = result.get(key) {
                    filtered[key] = v.clone();
                }
            }
            result = filtered;
        }
        return Ok(json_response(200, result));
    }
    let binding = scope
        .workspace
        .as_ref()
        .ok_or_else(|| error(403, "This conversation has no connected workspace."))?;
    if !operation.is_some_and(|op| ["entries", "file", "download"].contains(&op)) {
        return Err(error(404, "Workspace operation not found."));
    }
    let args: Vec<_> = q.iter().filter(|(k, _)| k != "preview").cloned().collect();
    let op = operation.unwrap_or("");
    let preview = parameter(&q, "preview");
    if op == "entries" || op == "file" && preview.is_none() {
        return workspace::response(&binding.directory, op == "entries", &args);
    }
    let (name, bytes) =
        workspace::download(&binding.directory, parameter(&args, "path").unwrap_or(""))?;
    let response = match preview {
        Some("html" | "render") => {
            let html = preview::html(&name, &bytes)?;
            if preview == Some("html") {
                json_response(200, json!({"html":html}))
            } else {
                let mut response = preview::render(html, false);
                response.headers_mut().remove(header::CONTENT_DISPOSITION);
                response
            }
        }
        Some("image") => {
            let mime = attachments::image_type(&bytes)
                .ok_or_else(|| error(415, "Image preview supports PNG, JPEG and WebP."))?;
            (
                [
                    (header::CONTENT_TYPE, mime),
                    (header::CONTENT_DISPOSITION, "inline"),
                ],
                bytes,
            )
                .into_response()
        }
        Some("text") => {
            if !bytes.starts_with(b"%PDF-") {
                check_scope(state, &scope)?;
                return workspace::response(&binding.directory, false, &args);
            }
            let result = json!({"text":preview::extract_pdf(&bytes).await?,"source":"pdf-text"});
            check_scope(state, &scope)?;
            json_response(200, result)
        }
        Some(_) => return Err(error(400, "Unknown preview type.")),
        None => attachments::download(&name, bytes),
    };
    Ok(response)
}
