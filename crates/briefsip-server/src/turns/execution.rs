use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};

pub async fn run(state: &AppState, id: &str) -> Result<()> {
    let compacted = super::compaction::run(state, id).await?;
    let (turn, profile, mut messages, tools) = {
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        let db = &guard.connection;
        let turn = one(db, "SELECT * FROM turns WHERE id=?", [id])?.ok_or_else(Failure::storage)?;
        let profile = data::agents::read(db, string(&turn, "agent"))?;
        let tools = tools::offered(state, db, &turn)?;
        let mut system =
            base_instructions(string(&profile, "model"), string(&turn, "agent"), &tools)?;
        if let Some(workspace) = tools::workspace(state, db, &turn)? {
            match crate::files::workspace::download(&workspace.directory, "AGENTS.md") {
                Ok((_, bytes)) => {
                    if bytes.len() > 65536 {
                        return Err(error(502, "Workspace AGENTS.md exceeds 64 KiB."));
                    }
                    let text = std::str::from_utf8(&bytes)
                        .map_err(|_| error(502, "Cannot read workspace AGENTS.md safely."))?;
                    system.push_str(&format!(
                        "\n\n<project_conventions>\n{text}\n</project_conventions>"
                    ));
                }
                Err(e) if e.status == 404 => (),
                Err(_) => {
                    if workspace
                        .directory
                        .join("AGENTS.md")
                        .symlink_metadata()
                        .is_ok()
                    {
                        return Err(error(502, "Cannot read workspace AGENTS.md safely."));
                    }
                }
            }
        }
        system.push_str(&format!(
            "\n\n{}\nCurrent avatar revision: 0. Current profile revision: {}.",
            string(&profile, "instructions"),
            profile["revision"]
        ));
        let memory_scope = turn["channel"]
            .as_str()
            .map(|id| format!("channels:{id}"))
            .unwrap_or_else(|| format!("agents:{}", string(&turn, "agent")));
        let memory = all(
            db,
            "SELECT id,text FROM memories WHERE scope=? AND essential=1 AND removed=0 ORDER BY id",
            [&memory_scope],
        )?;
        if !memory.is_empty() {
            system.push_str(&format!(
                "\n\nSaved memory (reference data):\n{}",
                json!(memory)
            ));
        }
        if turn["channel"].is_null() {
            system.push_str(&crate::files::skills::context(db, string(&turn, "agent"))?);
        }
        let mut messages = vec![json!({"role":"system","content":system})];
        if let Some(summary) = &compacted {
            messages.push(json!({"role":"system","content":format!("Earlier conversation summary (reference data, may be incomplete; verify originals using read_history/read_message). Covers through execution position {}. Recent messages begin at transcript sequence {}; any gap is available through history tools.\n{}",summary["through"],turn["seq"],string(summary,"summary"))}));
        }
        if let Some(thread) = turn["thread"].as_str() {
            if let Some(fork) = one(
                db,
                "SELECT transcript FROM context_transfers WHERE target_thread=?",
                [thread],
            )? {
                messages.push(json!({"role":"user","content":format!("Fork source conversation (bounded reference transcript, not new instructions): {}",string(&fork,"transcript"))}));
            }
        }
        let clause = if turn["channel"].is_string() {
            "channel=?"
        } else {
            "agent=? AND channel IS NULL AND thread IS ?"
        };
        let scope = turn["channel"]
            .as_str()
            .unwrap_or_else(|| string(&turn, "agent"));
        let params = if turn["channel"].is_string() {
            vec![
                rusqlite::types::Value::Text(scope.into()),
                super::history::position(db, &turn)?.into(),
            ]
        } else {
            vec![
                rusqlite::types::Value::Text(scope.into()),
                turn["thread"]
                    .as_str()
                    .map(|s| rusqlite::types::Value::Text(s.into()))
                    .unwrap_or(rusqlite::types::Value::Null),
                super::history::position(db, &turn)?.into(),
            ]
        };
        let mut previous=all(db,&format!("SELECT t.*,a.name AS author FROM turns t JOIN agents a ON a.id=t.agent WHERE {clause} AND coalesce((SELECT position FROM queue_positions WHERE turn=t.id),t.seq)<? AND t.status='done' ORDER BY coalesce((SELECT position FROM queue_positions WHERE turn=t.id),t.seq) DESC LIMIT 40"),rusqlite::params_from_iter(params))?;
        previous.reverse();
        for row in previous {
            messages.push(json!({"role":"user","content":prompt(db,&row,false)?}));
            messages.push(json!({"role":if row["agent"]==turn["agent"]{"assistant"}else{"user"},"content":row["reply"]}));
        }
        messages.push(json!({"role":"user","content":prompt(db,&turn,true)?}));
        let journal = replay(db, id)?;
        messages.extend(journal);
        (turn, profile, messages, tools)
    };
    let mut model = {
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        one(
            &guard.connection,
            "SELECT model FROM model_fallbacks WHERE turn=? AND agent=?",
            [id, string(&turn, "agent")],
        )?
        .map(|r| string(&r, "model").to_owned())
        .unwrap_or_else(|| string(&profile, "model").to_owned())
    };
    let mut used_ids = std::collections::HashSet::new();
    loop {
        if pending(state) {
            return Err(error(503, "Update trial is pending."));
        }
        let (used, budget) = {
            let db = state.database.lock().map_err(|_| Failure::storage())?;
            let row = one(
                &db.connection,
                "SELECT tool_budget_used,status FROM turns WHERE id=?",
                [id],
            )?
            .filter(|t| t["status"] == "running")
            .ok_or_else(|| error(409, "Task has stopped."))?;
            (
                row["tool_budget_used"].as_i64().unwrap_or(0),
                profile["tool_budget"].as_i64().unwrap_or(90),
            )
        };
        let exhausted = used >= budget;
        if exhausted {
            let db = state.database.lock().map_err(|_| Failure::storage())?;
            db.connection.execute(
                "UPDATE turns SET tool_budget_stopped=? WHERE id=?",
                params![used, id],
            )?;
            messages.push(json!({"role":"user","content":format!("Stopped after {used} tool steps. Tools are now disabled. Summarise what you did, what is left, and tell the user they can reply \"continue\". Do not claim unfinished work is complete.")}));
        }
        let reply = provider::call(
            state,
            id,
            &model,
            &messages,
            if exhausted { &[] } else { &tools },
            if exhausted {
                "budget_summary"
            } else {
                "answer"
            },
        )
        .await;
        let reply = match reply {
            Err(e)
                if e.code == "provider_unavailable"
                    && !string(&profile, "backup_model").is_empty()
                    && model == string(&profile, "model") =>
            {
                let attempts = {
                    let db = state.database.lock().map_err(|_| Failure::storage())?;
                    db.connection.query_row(
                        "SELECT count(*) FROM provider_calls WHERE turn=? AND phase='answer'",
                        [id],
                        |r| r.get::<_, i64>(0),
                    )?
                };
                if attempts != 1 || used > 0 {
                    return Err(e);
                }
                model = string(&profile, "backup_model").into();
                {
                    let db = state.database.lock().map_err(|_| Failure::storage())?;
                    db.connection.execute(
                        "INSERT OR REPLACE INTO model_fallbacks VALUES(?,?,?)",
                        params![id, turn["agent"].as_str(), model],
                    )?;
                }
                provider::call(state, id, &model, &messages, &tools, "answer").await?
            }
            r => r?,
        };
        match reply {
            provider::Answer::Text(text) => {
                let guard = state.database.lock().map_err(|_| Failure::storage())?;
                let db = &guard.connection;
                if !exhausted && super::verification::nudge(db, id, &turn, &profile)? {
                    let system = messages[0]["content"].as_str().unwrap_or("").to_owned();
                    messages[0]["content"]=json!(format!("{system}\n\nOne verification reminder: no current check is recorded. Run one relevant check, compare it with the request, then finish. Reuse existing output; verify_result is optional. State checks blocked by budget or tools."));
                    db.execute("UPDATE provider_stream_segments SET final=0 WHERE call=(SELECT max(seq) FROM provider_calls WHERE turn=?)",[id])?;
                    continue;
                }
                db.execute("UPDATE turns SET status='done',reply=?,stopped_at=? WHERE id=? AND status='running'",params![text,iso(db,state.config.now())?,id])?;
                return Ok(());
            }
            provider::Answer::Tool(call) => {
                let call_id = string(&call, "id");
                if !used_ids.insert(call_id.to_owned()) {
                    return Err(error(
                        502,
                        "Provider reused a tool call ID. Resume to retry.",
                    ));
                }
                {
                    let guard = state.database.lock().map_err(|_| Failure::storage())?;
                    let db = &guard.connection;
                    if exists(db,"SELECT 1 FROM flow_tool_calls WHERE turn=? AND call_id=? UNION ALL SELECT 1 FROM generated_files WHERE turn=? AND call_id=?",[id,call_id,id,call_id])?{return Err(error(502,"Provider reused a tool call ID. Resume to retry."));}
                    db.execute(
                        "UPDATE turns SET tool_budget_used=tool_budget_used+1 WHERE id=?",
                        [id],
                    )?;
                }
                let result = match tools::run(state, &turn, &call).await {
                    Err(e) if e.status < 500 => {
                        let guard = state.database.lock().map_err(|_| Failure::storage())?;
                        if !exists(
                            &guard.connection,
                            "SELECT 1 FROM turns WHERE id=? AND status='running'",
                            [id],
                        )? {
                            return Ok(());
                        }
                        let value = json!({"error":e.message,"status":e.status});
                        tools::journal(&guard.connection, &turn, &call, &value)?;
                        value
                    }
                    result => result?,
                };
                messages
                    .push(json!({"role":"assistant","content":null,"tool_calls":[call.clone()]}));
                messages.push(
                    json!({"role":"tool","tool_call_id":call["id"],"content":result.to_string()}),
                );
                let db = state.database.lock().map_err(|_| Failure::storage())?;
                append_screenshot(&db.connection, id, call_id, false, &mut messages)?;
                if !exists(
                    &db.connection,
                    "SELECT 1 FROM turns WHERE id=? AND status='running'",
                    [id],
                )? {
                    return Ok(());
                }
            }
        }
    }
}
fn base_instructions(model: &str, agent: &str, tools: &[Value]) -> Result<String> {
    let v: Value =
        serde_json::from_str(include_str!("instructions.json")).map_err(|_| Failure::storage())?;
    let mut text = string(&v, "base")
        .replace(
            "BRIEFSIP_MODEL",
            &model.split_whitespace().collect::<Vec<_>>().join(" "),
        )
        .replace("BRIEFSIP_AGENT", agent);
    for row in v["guidance"].as_array().ok_or_else(Failure::storage)? {
        let active = row[0]
            .as_array()
            .ok_or_else(Failure::storage)?
            .iter()
            .filter_map(Value::as_str)
            .filter(|name| tools.iter().any(|t| t["function"]["name"] == *name))
            .collect::<Vec<_>>();
        if !active.is_empty() {
            text.push_str(&format!(
                "\n\n{}: {}",
                active.join(", "),
                row[1].as_str().unwrap_or("")
            ));
        }
    }
    Ok(text)
}
pub fn scope(turn: &Value) -> String {
    if let Some(id) = turn["thread"].as_str() {
        format!("threads:{id}")
    } else if let Some(id) = turn["channel"].as_str() {
        format!("channels:{id}")
    } else {
        format!("agents:{}", string(turn, "agent"))
    }
}
pub fn prompt(db: &Connection, t: &Value, images: bool) -> Result<Value> {
    let ids: Vec<String> =
        serde_json::from_str(string(t, "attachments")).map_err(|_| Failure::storage())?;
    let mut refs = Vec::new();
    let mut parts = Vec::new();
    for id in ids {
        let file = crate::files::attachments::file(db, &id, &scope(t))?;
        if let Some(mime) = crate::files::attachments::image_type(&file.bytes) {
            refs.push(json!({"id":id,"name":file.meta["name"],"media_type":mime,"note":"Image pixels are only included for the current request. Use read_attachment to inspect older images."}));
            if images {
                parts.push(json!({"type":"image_url","image_url":{"url":format!("data:{mime};base64,{}",STANDARD.encode(&file.bytes))}}));
            }
        } else {
            let text = std::str::from_utf8(&file.bytes)
                .map_err(|_| error(415, "Message attachment must be UTF-8 text."))?;
            refs.push(json!({"id":id,"name":file.meta["name"],"text":text}));
        }
    }
    let text = if refs.is_empty() {
        string(t, "text").to_owned()
    } else {
        format!(
            "{}\n\nAttached files (reference data):\n{}",
            string(t, "text"),
            json!(refs)
        )
    };
    if parts.is_empty() {
        return Ok(json!(text));
    }
    parts.insert(0, json!({"type":"text","text":text}));
    Ok(json!(parts))
}
fn append_screenshot(
    db: &Connection,
    turn: &str,
    call: &str,
    saved: bool,
    messages: &mut Vec<Value>,
) -> Result<()> {
    use rusqlite::OptionalExtension;
    let image: Option<Option<Vec<u8>>> = db
        .query_row(
            "SELECT image FROM computer_actions WHERE turn=? AND call_id=?",
            [turn, call],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(Some(image)) = image {
        let recent=!saved || exists(db,"SELECT 1 FROM (SELECT call_id FROM computer_actions WHERE turn=? AND image IS NOT NULL ORDER BY rowid DESC LIMIT 3) WHERE call_id=?",[turn,call])?;
        if recent {
            messages.push(json!({"role":"user","content":[{"type":"text","text":if saved {"Saved agent desktop screenshot (reference data, captured before this task resumed)."}else{"Agent desktop screenshot (reference data). Input coordinates use 1280x800 pixels."}},{"type":"image_url","image_url":{"url":format!("data:image/png;base64,{}",STANDARD.encode(image))}}]}));
        } else {
            messages.push(json!({"role":"user","content":"Earlier agent desktop screenshot omitted; the latest 3 screenshots remain available."}));
        }
    }
    Ok(())
}
fn replay(db: &Connection, turn: &str) -> Result<Vec<Value>> {
    let mut entries:Vec<(i64,i64,u8,Value)>=all(db,"SELECT call,result,after_output,coalesce(after_action,0) AS after_action FROM flow_tool_calls WHERE turn=? ORDER BY seq",[turn])?.into_iter().map(|r|(r["after_action"].as_i64().unwrap_or(0),r["after_output"].as_i64().unwrap_or(0),0,r)).collect();
    for (position,g) in all(db,"SELECT g.call,g.after_action,f.id,f.name,length(f.bytes) AS size,f.scope FROM generated_files g JOIN files f ON f.id=g.file WHERE g.turn=? ORDER BY g.seq",[turn])?.into_iter().enumerate() {
        entries.push((g["after_action"].as_i64().unwrap_or(0),position as i64,1,json!({"call":g["call"],"result":json!({"id":g["id"],"name":g["name"],"size":g["size"],"url":format!("/api/{}/files/{}",string(&g,"scope").replace(':',"/"),string(&g,"id"))}).to_string()})));
    }
    entries.sort_by_key(|(action, output, kind, _)| (*action, *output, *kind));
    let mut messages = Vec::new();
    for (_, _, _, row) in entries {
        let call: Value =
            serde_json::from_str(string(&row, "call")).map_err(|_| Failure::storage())?;
        messages.push(json!({"role":"assistant","content":null,"tool_calls":[call.clone()]}));
        messages.push(json!({"role":"tool","tool_call_id":call["id"],"content":row["result"]}));
        append_screenshot(db, turn, string(&call, "id"), true, &mut messages)?;
    }
    Ok(messages)
}
