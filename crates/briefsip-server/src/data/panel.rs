use super::*;

pub struct Context {
    pub agent: Option<String>,
    pub project: Option<String>,
    pub workspace: Option<(String, bool)>,
}
pub fn context(state: &AppState, db: &Connection, kind: &str, id: &str) -> Result<Context> {
    if !uuid(id) {
        return Err(error(404, "Conversation not found."));
    }
    let row = match kind {
        "agents" => one(db, "SELECT id FROM agents WHERE id=?", [id])?,
        "threads" => one(
            db,
            "SELECT id,agent FROM threads WHERE id=? AND deleted=0",
            [id],
        )?,
        "channels" => one(db, "SELECT id,project,lead FROM channels WHERE id=?", [id])?,
        _ => None,
    }
    .ok_or_else(|| error(404, "Conversation not found."))?;
    let project_context = if kind == "threads" {
        one(
            db,
            "SELECT project,folder FROM local_project_threads WHERE thread=?",
            [id],
        )?
    } else if kind == "channels" && row["project"].is_string() {
        Some(json!({"project":row["project"]}))
    } else {
        None
    };
    let mut agent = if kind == "agents" {
        Some(id.to_owned())
    } else if kind == "threads" {
        Some(string(&row, "agent").to_owned())
    } else {
        None
    };
    let mut workspace = None;
    let project = if let Some(context) = project_context {
        let project = projects::read(db, string(&context, "project"))?;
        let members = project["members"].as_array().ok_or_else(Failure::storage)?;
        if kind == "channels" {
            let channel_members = all(
                db,
                "SELECT agent FROM channel_members WHERE channel=?",
                [id],
            )?;
            agent = members
                .iter()
                .find(|m| channel_members.iter().any(|c| c["agent"] == m["agent"]))
                .map(|m| string(m, "agent").to_owned());
        }
        if let Some(agent) = &agent {
            let member = members
                .iter()
                .find(|m| m["agent"] == *agent)
                .ok_or_else(|| error(403, "Agent is not a project member."))?;
            if project["archived"] != true {
                let folders = project["folders"].as_array().ok_or_else(Failure::storage)?;
                if !folders.is_empty() {
                    let folder = context
                        .get("folder")
                        .filter(|v| v.is_string())
                        .or_else(|| folders.first())
                        .ok_or_else(Failure::storage)?;
                    if !folders.contains(folder) {
                        return Err(error(403, "Folder is not in this project."));
                    }
                    let path = folders::validate(state, folder, false, true)?;
                    workspace =
                        Some((path.to_string_lossy().into_owned(), member["write"] == true));
                }
            }
        }
        Some(string(&project, "id").to_owned())
    } else {
        None
    };
    if project.is_none() {
        if let Some(agent) = &agent {
            if let Ok(binding) = agent_folders::effective(state, db, agent) {
                workspace = Some((
                    binding.directory.to_string_lossy().into_owned(),
                    binding.write,
                ));
            }
        }
    }
    Ok(Context {
        agent,
        project,
        workspace,
    })
}
fn shared(db: &Connection, kind: &str, id: &str) -> Result<Vec<String>> {
    let mut ids = Vec::new();
    if !table(db, "files")? {
        return Ok(ids);
    }
    for turn in all(
        db,
        &format!("SELECT id FROM turns WHERE {}", conversations::clause(kind)),
        [id],
    )? {
        for delivery in all(db,"SELECT d.turn FROM agent_requests r JOIN agent_deliveries d ON d.request=r.id WHERE r.turn=? AND r.expects_reply=1",[string(&turn,"id")])? {
            for file in history::requested(db,string(&delivery,"turn"))?.as_array().ok_or_else(Failure::storage)? {ids.push(string(file,"id").to_owned());}
        }
        for capture in all(
            db,
            "SELECT snapshot FROM agent_reply_claims WHERE consumer=? ORDER BY rowid",
            [string(&turn, "id")],
        )? {
            let snapshot = json(&capture["snapshot"])?;
            let available = history::requested(db, string(&snapshot, "id"))?;
            if let Some(files) = snapshot["generatedFiles"].as_array() {
                for f in files {
                    if available
                        .as_array()
                        .is_some_and(|a| a.iter().any(|v| v["id"] == f["id"]))
                    {
                        ids.push(string(f, "id").to_owned());
                    }
                }
            }
        }
    }
    Ok(ids)
}
pub fn files(db: &Connection, kind: &str, id: &str, before: i64, html: bool) -> Result<Value> {
    if !table(db, "files")? {
        return Ok(json!([]));
    }
    let mut files=all(db,&format!("SELECT seq,id,name,length(bytes) AS size,hex(substr(bytes,1,24)) AS header FROM files WHERE deleted=0 AND seq<? AND(scope=? OR id IN(SELECT value FROM json_each(?))) {} ORDER BY seq DESC {}",if html{"AND(lower(name) LIKE '%.html' OR lower(name) LIKE '%.htm')"}else{""},if html{""}else{"LIMIT 100"}),rusqlite::params![before,format!("{kind}:{id}"),json!(shared(db,kind,id)?).to_string()])?;
    for file in &mut files {
        let header = string(file, "header");
        let image = super::image_header(header);
        file.as_object_mut()
            .ok_or_else(Failure::storage)?
            .remove("header");
        file["image"] = json!(image);
    }
    Ok(json!(files))
}
pub fn read(state: &AppState, db: &Connection, kind: &str, id: &str) -> Result<Value> {
    let scope = context(state, db, kind, id)?;
    let workspace = scope
        .workspace
        .map(|(directory, _)| {
            let name = directory.rsplit('/').next().unwrap_or("");
            if let Some(project) = scope.project {
                json!({"name":name,"project":project})
            } else {
                json!({"name":name})
            }
        })
        .unwrap_or(Value::Null);
    let condition = match kind {
        "agents" => "t.agent=? AND t.channel IS NULL AND t.thread IS NULL",
        "threads" => "t.thread=?",
        _ => "t.channel=?",
    };
    let sites = if table(db, "local_sites")? && table(db, "flow_tool_calls")? {
        all(db,&format!("SELECT DISTINCT s.id,s.name,s.revision FROM local_sites s JOIN flow_tool_calls f ON json_extract(f.result,'$.id')=s.id JOIN turns t ON t.id=f.turn WHERE {condition} AND json_extract(f.call,'$.function.name')='publish_site' AND s.agent=t.agent AND s.deleted=0 ORDER BY s.id"),[id])?
    } else {
        Vec::new()
    };
    Ok(
        json!({"workspace":workspace,"computer":if kind=="channels" {Value::Null} else {json!(scope.agent)},"sites":sites,"previews":files(db,kind,id,9_007_199_254_740_991,true)?}),
    )
}
