use super::*;
use sha2::{Digest, Sha256};

pub fn workspace(
    state: &AppState,
    _db: &Connection,
    turn: &Value,
) -> Result<Option<crate::config::WorkspaceConfig>> {
    Ok(state
        .config
        .workspaces
        .iter()
        .find(|w| w.agent == string(turn, "agent"))
        .cloned())
}
pub fn offered(state: &AppState, db: &Connection, turn: &Value) -> Result<Vec<Value>> {
    let mut specs: Vec<Value> =
        serde_json::from_str(include_str!("tool-specs.json")).map_err(|_| Failure::storage())?;
    let private = turn["channel"].is_null();
    let bound = workspace(state, db, turn)?.is_some() && private;
    specs.retain(|t| match string(&t["function"], "name") {
        "read_history" | "read_message" | "read_attachment" | "create_text_file"
        | "open_file_in_panel" | "ask_user" | "select_memory" | "remember_memory"
        | "search_memory" | "verify_result" => true,
        "generate_image" => state.config.turns.image_provider.is_some(),
        "list_agents" | "send_message" | "delegate_task" | "task_status" | "wait_task"
        | "cancel_task" => super::messaging::allowed(db, string(turn, "id")).unwrap_or(false),
        "read_provider_settings"
        | "edit_profile"
        | "list_skills"
        | "read_skill"
        | "read_skill_file"
        | "list_sites"
        | "publish_site"
        | "delete_site"
        | "set_avatar" => private,
        "run_shell"
        | "list_workspace"
        | "inspect_workspace_file"
        | "read_workspace_file"
        | "create_workspace_file"
        | "create_workspace_directory"
        | "copy_skill_file" => bound,
        _ => false,
    });
    if !private {
        specs.retain(|t| t["function"]["name"] != "delegate_task");
        specs.extend(super::coordination::tools(db, turn)?);
    }
    if private {
        specs.push(json!({"type":"function","function":{"name":"list_provider_accounts","description":"List your configured provider account choices without credentials or endpoint paths. Returns account ID, display name, provider family, origin and default model. Use set_provider_account only after the user requests a switch.","parameters":{"type":"object","properties":{},"additionalProperties":false}}}));
        specs.push(json!({"type":"function","function":{"name":"set_provider_model","description":"Change your own primary or backup model only when the user requests it. Supply current revision from read_provider_settings. Current execution keeps its model.","parameters":{"type":"object","properties":{"revision":{"type":"integer","minimum":1},"model":{"type":"string","maxLength":160},"backupModel":{"type":"string","maxLength":160}},"required":["revision"],"additionalProperties":false}}}));
    }
    if private
        && state.computer.enabled
        && exists(
            db,
            "SELECT 1 FROM agent_computers WHERE agent=? AND enabled=1",
            [string(turn, "agent")],
        )?
    {
        specs.extend(
            crate::computer::actions::tools(state.computer.width, state.computer.height)
                .as_array()
                .ok_or_else(Failure::storage)?
                .iter()
                .cloned(),
        );
    }
    if turn["profile_setup"] == 1 {
        specs.retain(|t| ["edit_profile", "ask_user"].contains(&string(&t["function"], "name")));
    }
    Ok(specs)
}
pub async fn run(state: &AppState, turn: &Value, call: &Value) -> Result<Value> {
    if pending(state) {
        return Err(error(503, "Update trial is pending."));
    }
    let args: Value = serde_json::from_str(string(&call["function"], "arguments"))
        .map_err(|_| error(400, "Tool arguments must be valid JSON."))?;
    if !args.is_object() {
        return Err(error(400, "Tool arguments must be a JSON object."));
    }
    let name = string(&call["function"], "name");
    if name == "generate_image" {
        return super::media::generate(state, turn, call, &args).await;
    }
    if name == "run_shell" {
        return super::shell::run(state, turn, call, args).await;
    }
    if name.starts_with("computer_") {
        if !turn["channel"].is_null() {
            return Err(error(
                403,
                "Computer tools are only available in a private agent conversation.",
            ));
        }
        let (outputs, actions) = {
            let guard = state.database.lock().map_err(|_| Failure::storage())?;
            let db = &guard.connection;
            (
                db.query_row(
                    "SELECT count(*) FROM generated_files WHERE turn=?",
                    [string(turn, "id")],
                    |r| r.get::<_, i64>(0),
                )?,
                db.query_row(
                    "SELECT count(*) FROM coordination WHERE turn=?",
                    [string(turn, "id")],
                    |r| r.get::<_, i64>(0),
                )?,
            )
        };
        let outcome = crate::computer::control::action(
            state,
            string(turn, "agent"),
            string(turn, "id"),
            call,
            &args,
            outputs,
            actions,
        )
        .await?;
        return Ok(outcome.result);
    }
    let guard = state.database.lock().map_err(|_| Failure::storage())?;
    let db = &guard.connection;
    let result = transaction(db, || {
        if !exists(
            db,
            "SELECT 1 FROM turns WHERE id=? AND status='running'",
            [string(turn, "id")],
        )? {
            return Err(error(409, "Task has stopped."));
        }
        let result = dispatch(state, db, turn, call, &args)?;
        if ![
            "delegate_task",
            "transfer_task",
            "send_message",
            "wait_task",
            "read_history",
            "read_message",
            "search_memory",
            "list_provider_accounts",
            "read_provider_settings",
            "list_skills",
            "read_skill",
            "read_skill_file",
            "ask_user",
        ]
        .contains(&name)
        {
            journal(db, turn, call, &result)?;
        }
        Ok(result)
    });
    if result
        .as_ref()
        .is_err_and(|e| e.status == 429 && e.message == "Agent message rate limit reached.")
    {
        db.execute("INSERT INTO agent_message_cooldowns(agent,until) VALUES(?,?) ON CONFLICT(agent) DO UPDATE SET until=excluded.until",params![string(turn,"agent"),state.config.now()+state.config.turns.limit("cooldownMs",600000)])?;
    }
    result
}
pub fn journal(db: &Connection, turn: &Value, call: &Value, result: &Value) -> Result<()> {
    if exists(db,"SELECT 1 FROM flow_tool_calls WHERE turn=? AND call_id=? UNION ALL SELECT 1 FROM generated_files WHERE turn=? AND call_id=?",[string(turn,"id"),string(call,"id"),string(turn,"id"),string(call,"id")])? {return Ok(());}
    db.execute("INSERT INTO flow_tool_calls(turn,call_id,call,result,after_output,after_action) VALUES (?,?,?,?,(SELECT count(*) FROM generated_files WHERE turn=?),(SELECT count(*) FROM coordination WHERE turn=?))",params![turn["id"].as_str(),call["id"].as_str(),call.to_string(),result.to_string(),turn["id"].as_str(),turn["id"].as_str()])?;
    Ok(())
}
fn dispatch(
    state: &AppState,
    db: &Connection,
    turn: &Value,
    call: &Value,
    args: &Value,
) -> Result<Value> {
    let name = string(&call["function"], "name");
    let agent = string(turn, "agent");
    match name {
        "read_history" | "read_message" | "read_attachment" => {
            super::history::read(db, turn, name, args)
        }
        "search_memory" | "remember_memory" | "select_memory" => {
            super::memory::run(db, turn, name, args)
        }
        "create_text_file" => file_tool(state, db, turn, call, args),
        "open_file_in_panel" => {
            if !closed(args, &["id"]) || !uuid(string(args, "id")) {
                return Err(error(400, "Invalid file ID."));
            }
            let Some(file) = super::history::readable_file(db, turn, string(args, "id"))? else {
                return Ok(json!({"error":"File not found in this conversation."}));
            };
            Ok(
                json!({"id":file.meta["id"],"name":file.meta["name"],"size":file.bytes.len(),"url":format!("/api/{}/files/{}",execution::scope(turn).replace(':',"/"),string(args,"id")),"openedAt":iso(db,state.config.now())?}),
            )
        }
        "read_provider_settings" => {
            if !closed(args, &[]) {
                return Err(error(
                    400,
                    "Reading provider settings does not accept arguments.",
                ));
            }
            let a = data::agents::read(db, agent)?;
            let configured = data::providers::accounts(state)?
                .iter()
                .any(|x| x.id == a["provider_account"] && !x.base.is_empty());
            Ok(
                json!({"revision":a["revision"],"providerAccount":a["provider_account"],"model":a["model"],"backupModel":a["backup_model"],"configured":configured}),
            )
        }
        "list_provider_accounts" => {
            if !closed(args, &[]) {
                return Err(error(400, "Invalid provider account request."));
            }
            Ok(json!(data::providers::accounts(state)?.into_iter().map(|a|json!({"id":a.id,"name":a.name,"provider":a.family,"origin":url::Url::parse(&a.base).map(|u|u.origin().ascii_serialization()).ok(),"defaultModel":a.model,"configured":!a.base.is_empty()})).collect::<Vec<_>>()))
        }
        "set_provider_model" => {
            if !closed(args, &["revision", "model", "backupModel"])
                || !integer(&args["revision"], 1, 9_007_199_254_740_991)
                || args.get("model").is_none() && args.get("backupModel").is_none()
            {
                return Err(error(400, "Invalid model change."));
            }
            let a = data::agents::read(db, agent)?;
            if a["revision"] != args["revision"] {
                return Err(error(
                    409,
                    "Profile changed. Ask the user for guidance before changing it again.",
                ));
            }
            let model = if args.get("model").is_some() {
                field(args, "model", 160)?
            } else {
                string(&a, "model").into()
            };
            if model.chars().any(char::is_control) {
                return Err(error(400, "Invalid model."));
            }
            let backup = if let Some(b) = args.get("backupModel") {
                b.as_str()
                    .filter(|b| b.encode_utf16().count() <= 160 && !b.chars().any(char::is_control))
                    .ok_or_else(|| {
                        error(
                            400,
                            "Fallback model is invalid or matches the primary model.",
                        )
                    })?
                    .trim()
            } else {
                string(&a, "backup_model")
            };
            if backup == model {
                return Err(error(
                    400,
                    "Fallback model is invalid or matches the primary model.",
                ));
            }
            db.execute(
                "UPDATE agents SET model=?,backup_model=?,revision=revision+1 WHERE id=?",
                params![model, backup, agent],
            )?;
            Ok(
                json!({"revision":a["revision"].as_i64().unwrap_or(0)+1,"model":model,"backupModel":backup,"providerAccount":a["provider_account"]}),
            )
        }
        "ask_user" => {
            if !closed(args, &["question", "choices"]) {
                return Err(error(400, "Invalid question or choices."));
            }
            let prompt = field(args, "question", 2000)
                .map_err(|_| error(400, "Invalid question or choices."))?;
            let choices = args["choices"]
                .as_array()
                .filter(|a| a.len() <= 8)
                .ok_or_else(|| error(400, "Invalid question or choices."))?;
            let mut seen = std::collections::HashSet::new();
            let mut clean = Vec::new();
            for c in choices {
                let c = c
                    .as_str()
                    .filter(|s| {
                        !s.trim().is_empty()
                            && s.encode_utf16().count() <= 200
                            && seen.insert(s.trim())
                    })
                    .ok_or_else(|| error(400, "Invalid question or choices."))?;
                clean.push(c.trim());
            }
            if one(
                db,
                "SELECT count(*) AS n FROM questions WHERE turn=?",
                [string(turn, "id")],
            )?
            .is_some_and(|v| v["n"].as_i64().unwrap_or(0) >= 8)
                || exists(
                    db,
                    "SELECT 1 FROM questions WHERE turn=? AND answer IS NULL",
                    [string(turn, "id")],
                )?
            {
                return Err(error(
                    409,
                    "Task question limit reached or an answer is still pending.",
                ));
            }
            db.execute("INSERT INTO questions VALUES (?,?,?,?,?,?,NULL,(SELECT count(*) FROM generated_files WHERE turn=?),(SELECT count(*) FROM coordination WHERE turn=?))",params![uuid::Uuid::new_v4().to_string(),turn["id"].as_str(),call["id"].as_str(),call.to_string(),prompt,json!(clean).to_string(),turn["id"].as_str(),turn["id"].as_str()])?;
            db.execute("UPDATE turns SET status='queued',paused=1,revision=revision+1,error=NULL WHERE id=?",[string(turn,"id")])?;
            Ok(Value::Null)
        }
        "transfer_task" => super::coordination::execute(state, db, turn, call, args),
        "delegate_task" if args.get("agent").is_none() && !turn["channel"].is_null() => {
            super::coordination::execute(state, db, turn, call, args)
        }
        "list_agents" | "send_message" | "delegate_task" | "task_status" | "wait_task"
        | "cancel_task" => super::messaging::run(state, db, turn, call, args),
        "verify_result" => super::verification::review(db, turn, args),
        "edit_profile" | "set_avatar" | "list_sites" | "publish_site" | "delete_site" => {
            super::profile::execute(state, db, turn, name, args)
        }
        "list_workspace" | "read_workspace_file" | "inspect_workspace_file" => {
            let binding = workspace(state, db, turn)?.ok_or_else(|| {
                error(
                    403,
                    "Workspace access is not granted for this conversation.",
                )
            })?;
            let params = args
                .as_object()
                .ok_or_else(Failure::storage)?
                .iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        v.as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| v.to_string()),
                    )
                })
                .collect::<Vec<_>>();
            crate::files::workspace::read(&binding.directory, name == "list_workspace", &params)
        }
        "list_skills" | "read_skill" | "read_skill_file" => skill(db, agent, name, args),
        _ => Err(error(501, "Tool is not ported in this lane.")),
    }
}
fn skill(db: &Connection, agent: &str, name: &str, args: &Value) -> Result<Value> {
    let listing = name == "list_skills";
    let key = if listing { "after" } else { "id" };
    let file = name == "read_skill_file";
    if !closed(
        args,
        if file {
            &["id", "path", "offset"]
        } else {
            std::slice::from_ref(&key)
        },
    ) || (!listing || args.get(key).is_some()) && !uuid(string(args, key))
        || file
            && (args["path"].as_str().is_none_or(|s| s.len() > 240)
                || args
                    .get("offset")
                    .is_some_and(|v| !integer(v, 0, 9_007_199_254_740_991)))
    {
        return Err(error(400, "Invalid skill request."));
    }
    if listing {
        let mut rows=all(db,"SELECT a.skill AS id,a.version,v.name,v.description FROM agent_skills a JOIN skill_versions v ON v.skill=a.skill AND v.revision=a.version WHERE a.agent=? AND a.enabled=1 AND a.removed=0 AND a.skill>? ORDER BY a.skill LIMIT 11",[agent,string(args,key)])?;
        let next = if rows.len() > 10 {
            rows.get(9).map(|r| r["id"].clone())
        } else {
            None
        };
        rows.truncate(10);
        return Ok(json!({"items":rows,"next_after":next}));
    }
    let Some(mut row)=one(db,"SELECT a.skill AS id,a.version,v.name,v.description,v.content FROM agent_skills a JOIN skill_versions v ON v.skill=a.skill AND v.revision=a.version WHERE a.agent=? AND a.enabled=1 AND a.removed=0 AND a.skill=?",[agent,string(args,key)])? else{return Ok(json!({"error":"Enabled installed skill not found."}));};
    let files = one(
        db,
        "SELECT files FROM skill_files WHERE skill=? AND revision=?",
        params![string(args, key), row["version"].as_i64()],
    )?
    .map(|r| data::json(&r["files"]))
    .transpose()?
    .unwrap_or(json!([]));
    let files = files.as_array().ok_or_else(Failure::storage)?;
    if !file {
        row["files"] = json!(files
            .iter()
            .map(|f| if f["encoding"].is_null() {
                json!({"path":f["path"],"characters":string(f,"content").encode_utf16().count()})
            } else {
                json!({"path":f["path"],"binary":true})
            })
            .collect::<Vec<_>>());
        return Ok(row);
    }
    let Some(f) = files.iter().find(|f| f["path"] == args["path"]) else {
        return Ok(json!({"error":"File not found in installed skill."}));
    };
    if f.get("encoding").is_some() {
        return Ok(
            json!({"error":"Binary skill asset cannot be read as text. Export the skill package from the library to use its original bytes.","path":f["path"],"binary":true}),
        );
    }
    let offset = args["offset"].as_u64().unwrap_or(0) as usize;
    Ok(
        json!({"id":args["id"],"version":row["version"],"path":f["path"],"content":super::history::slice(string(f,"content"),offset,8000),"next_offset":if string(f,"content").encode_utf16().count()>offset+8000 {Some(offset+8000)}else{None}}),
    )
}
fn file_tool(
    state: &AppState,
    db: &Connection,
    turn: &Value,
    call: &Value,
    args: &Value,
) -> Result<Value> {
    let name =
        field(args, "name", 200).map_err(|_| error(400, "Invalid text file name or content."))?;
    let text = args["text"]
        .as_str()
        .filter(|s| {
            s.encode_utf16().count() <= 16000
                && !s
                    .chars()
                    .any(|c| matches!(c,'\x00'..='\x08'|'\x0b'..='\x0c'|'\x0e'..='\x1f'))
        })
        .ok_or_else(|| error(400, "Invalid text file name or content."))?;
    if !closed(args, &["name", "text"])
        || name
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
        || [".", ".."].contains(&name.as_str())
    {
        return Err(error(400, "Invalid text file name or content."));
    }
    if text.len() > 32768 {
        return Err(error(413, "Text file limit is 32 KiB."));
    }
    let scope = execution::scope(turn);
    let existing = one(
        db,
        "SELECT id FROM files WHERE scope=? AND name=? AND deleted=0 ORDER BY seq DESC LIMIT 1",
        params![scope, name],
    )?;
    let id = existing
        .as_ref()
        .map(|r| string(r, "id").to_owned())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if one(
        db,
        "SELECT count(DISTINCT file) AS n FROM generated_files WHERE turn=?",
        [string(turn, "id")],
    )?
    .is_some_and(|r| r["n"].as_i64().unwrap_or(0) >= 8)
        && !exists(
            db,
            "SELECT 1 FROM generated_files WHERE turn=? AND file=?",
            [string(turn, "id"), &id],
        )?
    {
        return Err(error(429, "Task file limit reached."));
    }
    let digest = format!("{:x}", Sha256::digest(text.as_bytes()));
    if existing.is_some() {
        crate::files::preview::forget(db, &id)?;
        db.execute(
            "UPDATE files SET bytes=?,digest=? WHERE id=?",
            params![text.as_bytes(), digest, id],
        )?;
    } else {
        db.execute(
            "INSERT INTO files(id,scope,name,digest,bytes,created) VALUES(?,?,?,?,?,?)",
            params![
                id,
                scope,
                name,
                digest,
                text.as_bytes(),
                iso(db, state.config.now())?
            ],
        )?;
    }
    db.execute("INSERT INTO generated_files(turn,file,call_id,call,after_action) VALUES(?,?,?,?,(SELECT count(*) FROM coordination WHERE turn=?))",params![turn["id"].as_str(),id,call["id"].as_str(),call.to_string(),turn["id"].as_str()])?;
    Ok(
        json!({"id":id,"name":name,"size":text.len(),"url":format!("/api/{}/files/{id}",scope.replace(':',"/"))}),
    )
}
