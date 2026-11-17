use super::*;
use sha2::{Digest, Sha256};

pub fn expire(db: &Connection) -> Result<()> {
    let expired = all(
        db,
        "SELECT turn FROM queue_edits WHERE state='held' AND expires_at<=unixepoch('subsec')*1000",
        [],
    )?;
    for row in expired {
        db.execute(
            "UPDATE queue_edits SET state='cancelled' WHERE turn=? AND state='held'",
            [string(&row, "turn")],
        )?;
        db.execute(
            "UPDATE turns SET revision=revision+1 WHERE id=?",
            [string(&row, "turn")],
        )?;
    }
    Ok(())
}
fn clause(kind: &str) -> &'static str {
    match kind {
        "threads" => "thread=?",
        "channels" => "channel=?",
        _ => "agent=? AND thread IS NULL AND channel IS NULL",
    }
}
pub fn editing(db: &Connection, turn: &str) -> Result<bool> {
    exists(db,"SELECT 1 FROM queue_edits WHERE turn=? AND state='held' AND expires_at>unixepoch('subsec')*1000",[turn])
}
fn editable(db: &Connection, row: &Value) -> Result<bool> {
    let id = string(row, "id");
    Ok(row["dispatch_mode"]!="steer" && row["status"]=="queued" && row["parent"].is_null() && row["waiting_for"].is_null()
        && !exists(db,"SELECT 1 FROM provider_calls WHERE turn=? UNION ALL SELECT 1 FROM agent_deliveries WHERE turn=?",[id,id])?
        && !["routine_runs","flow_steps","workflow_steps"].iter().any(|table| data::table(db,table).unwrap_or(false) && exists(db,&format!("SELECT 1 FROM {table} WHERE turn=?"),[id]).unwrap_or(true)))
}
pub fn read(
    db: &Connection,
    path: &str,
    kind: &str,
    owner: &str,
    q: &[(String, String)],
) -> Result<Value> {
    let after = q.iter().find(|(k, _)| k == "after").map(|(_, v)| v);
    let snapshot = q
        .iter()
        .find(|(k, _)| k == "snapshot")
        .map(|(_, v)| v.as_str());
    let cursor = if let Some(after) = after {
        if after.starts_with('0')
            || !after.bytes().all(|b| b.is_ascii_digit())
            || snapshot.is_none_or(|s| {
                s.len() != 64
                    || !s
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
        {
            return Err(error(400, "Invalid queue cursor."));
        }
        after
            .parse::<i64>()
            .ok()
            .filter(|v| *v > 0 && *v <= 9_007_199_254_740_991)
            .ok_or_else(|| error(400, "Invalid queue cursor."))?
    } else {
        0
    };
    let metadata=all(db,&format!("SELECT id,agent,revision,coalesce((SELECT position FROM queue_positions WHERE turn=t.id),seq) AS position FROM turns t WHERE {} AND status='queued' ORDER BY position,seq",clause(kind)),[owner])?;
    // Object order matches Node's queue snapshot digest.
    let canonical = metadata
        .iter()
        .map(|m| {
            format!(
                "{{\"id\":{},\"agent\":{},\"revision\":{},\"position\":{}}}",
                m["id"], m["agent"], m["revision"], m["position"]
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let version = format!(
        "{:x}",
        Sha256::digest(format!(
            "{{\"scope\":{},\"metadata\":[{}]}}",
            json!(path),
            canonical
        ))
    );
    if after.is_some() && snapshot != Some(version.as_str()) {
        return Err(error(409, "Queue changed. Reload the first page."));
    }
    let mut rows=all(db,&format!("SELECT id,agent,text,revision,paused,seq,coalesce((SELECT position FROM queue_positions WHERE turn=t.id),seq) AS position FROM turns t WHERE {} AND status='queued' AND coalesce((SELECT position FROM queue_positions WHERE turn=t.id),seq)>? ORDER BY position,seq LIMIT 101",clause(kind)),params![owner,cursor])?;
    let more = rows.len() > 100;
    rows.truncate(100);
    for row in &mut rows {
        let index = metadata
            .iter()
            .position(|m| m["id"] == row["id"])
            .ok_or_else(Failure::storage)?;
        let neighbor = |m: Option<&Value>| -> Result<Value> {
            match m {
                Some(m) => Ok(
                    json!({"id":m["id"],"agent":m["agent"],"revision":m["revision"],"editing":editing(db,string(m,"id"))?}),
                ),
                None => Ok(Value::Null),
            }
        };
        row["editing"] = json!(editing(db, string(row, "id"))?);
        row["previous"] = neighbor(
            metadata[..index]
                .iter()
                .rev()
                .find(|m| m["agent"] == row["agent"]),
        )?;
        row["next"] = neighbor(
            metadata[index + 1..]
                .iter()
                .find(|m| m["agent"] == row["agent"]),
        )?;
    }
    let next = if more {
        rows.last().map(|r| r["position"].clone())
    } else {
        None
    };
    Ok(json!({"turns":rows,"more":more,"next_after":next,"snapshot":version}))
}
pub fn reorder(db: &Connection, path: &str, kind: &str, owner: &str, v: &Value) -> Result<Value> {
    if !uuid(string(v, "target"))
        || !uuid(string(v, "other"))
        || v["target"] == v["other"]
        || !integer(&v["revision"], 1, 9_007_199_254_740_991)
        || !integer(&v["otherRevision"], 1, 9_007_199_254_740_991)
        || !closed(v, &["id", "target", "other", "revision", "otherRevision"])
    {
        return Err(error(400, "Invalid queue order."));
    }
    let request = json!({"path":path,"target":v["target"],"other":v["other"],"revision":v["revision"],"otherRevision":v["otherRevision"]});
    if let Some(prior) = data::receipt(
        db,
        "queue_order_commands",
        string(v, "id"),
        &request,
        "ID was already used for a different order.",
    )? {
        return Ok(prior);
    }
    let rows=all(db,&format!("SELECT *,coalesce((SELECT position FROM queue_positions WHERE turn=t.id),seq) AS position FROM turns t WHERE {} AND id IN (?,?)",clause(kind)),[owner,string(v,"target"),string(v,"other")])?;
    if rows.len() != 2 {
        return Err(error(404, "Message not found in this queue."));
    }
    let a = rows
        .iter()
        .find(|r| r["id"] == v["target"])
        .ok_or_else(Failure::storage)?;
    let b = rows
        .iter()
        .find(|r| r["id"] == v["other"])
        .ok_or_else(Failure::storage)?;
    if a["agent"] != b["agent"]
        || a["thread"] != b["thread"]
        || a["revision"] != v["revision"]
        || b["revision"] != v["otherRevision"]
    {
        return Err(error(
            409,
            "Queue changed or uses different workers. Reload.",
        ));
    }
    for row in &rows {
        if !editable(db, row)? {
            return Err(error(
                409,
                "Only user messages that have not started can be reordered.",
            ));
        }
    }
    let low = a["position"]
        .as_i64()
        .unwrap_or(0)
        .min(b["position"].as_i64().unwrap_or(0));
    let high = a["position"]
        .as_i64()
        .unwrap_or(0)
        .max(b["position"].as_i64().unwrap_or(0));
    if exists(db,"SELECT 1 FROM turns t JOIN queue_edits e ON e.turn=t.id WHERE e.state='held' AND t.agent=? AND t.thread IS ? AND coalesce((SELECT position FROM queue_positions WHERE turn=t.id),seq) BETWEEN ? AND ?",params![a["agent"].as_str(),a["thread"].as_str(),low,high])? {return Err(error(409,"Finish editing the message before moving the queue past it."));}
    for (row, position) in [(a, &b["position"]), (b, &a["position"])] {
        db.execute("INSERT INTO queue_positions VALUES (?,?) ON CONFLICT(turn) DO UPDATE SET position=excluded.position",params![row["id"].as_str(),position.as_i64()])?;
        db.execute(
            "UPDATE turns SET revision=revision+1 WHERE id=?",
            [string(row, "id")],
        )?;
    }
    let result = json!({"reordered":true});
    data::save_receipt(
        db,
        "queue_order_commands",
        string(v, "id"),
        &request,
        &result,
    )?;
    Ok(result)
}
#[allow(clippy::too_many_arguments)]
pub fn edit(
    _state: &AppState,
    db: &Connection,
    path: &str,
    kind: &str,
    owner: &str,
    turn_id: &str,
    v: &Value,
) -> Result<Value> {
    expire(db)?;
    let t = admission::scoped(
        db,
        kind,
        owner,
        turn_id,
        "Message not found in this conversation.",
    )?;
    let action = string(v, "action");
    if !uuid(string(v, "editor"))
        || !["hold", "renew", "save", "cancel"].contains(&action)
        || !integer(&v["revision"], 1, 9_007_199_254_740_991)
        || !closed(v, &["id", "editor", "action", "revision", "text", "files"])
    {
        return Err(error(400, "Invalid queue edit request."));
    }
    if action != "save" && (v.get("text").is_some() || v.get("files").is_some()) {
        return Err(error(400, "Message content is only accepted when saving."));
    }
    let mut request = json!({"path":path,"id":v["id"],"editor":v["editor"],"revision":v["revision"],"action":action});
    if action == "save" {
        for k in ["text", "files"] {
            if let Some(value) = v.get(k) {
                request[k] = value.clone();
            }
        }
    }
    if let Some(prior) = data::receipt(
        db,
        "queue_edit_commands",
        string(v, "id"),
        &request,
        "ID was already used for a different change.",
    )? {
        return Ok(prior);
    }
    let edit = one(
        db,
        "SELECT * FROM queue_edits WHERE editor=?",
        [string(v, "editor")],
    )?;
    let cancelled = action == "cancel"
        && edit
            .as_ref()
            .is_some_and(|e| e["turn"] == turn_id && e["state"] == "cancelled");
    if !cancelled && t["revision"] != v["revision"] {
        return Err(error(409, "Message changed. Load the latest status."));
    }
    if !cancelled && !editable(db, &t)? {
        return Err(error(
            409,
            "Only user messages that have not started can be edited.",
        ));
    }
    let validate = |files: &Value| -> Result<()> {
        let archived = if kind == "threads" {
            exists(
                db,
                "SELECT 1 FROM threads WHERE id=? AND (archived=1 OR deleted=1)",
                [owner],
            )?
        } else if kind == "channels" {
            exists(
                db,
                "SELECT 1 FROM channels WHERE id=? AND archived=1",
                [owner],
            )?
        } else {
            false
        };
        if data::agents::hidden(db, string(&t, "agent"))? || archived {
            return Err(error(
                409,
                "Restore the agent and conversation before editing.",
            ));
        }
        admission::validate_files(db, files, &format!("{kind}:{owner}"))
    };
    if !cancelled {
        if action == "hold" {
            if edit.is_some() || editing(db, turn_id)? {
                return Err(error(
                    409,
                    "Message is being edited or was already edited with this identity.",
                ));
            }
            validate(&data::json(&t["attachments"])?)?;
            db.execute("INSERT INTO queue_edits(editor,turn,state,original,expires_at) VALUES (?,?,'held',?,unixepoch('subsec')*1000+30000)",params![v["editor"].as_str(),turn_id,t.to_string()])?;
        } else {
            if !edit
                .as_ref()
                .is_some_and(|e| e["turn"] == turn_id && e["state"] == "held")
            {
                return Err(error(
                    409,
                    "This edit is complete or belongs to another editor.",
                ));
            }
            if action == "renew" {
                db.execute("UPDATE queue_edits SET expires_at=unixepoch('subsec')*1000+30000 WHERE editor=?",[string(v,"editor")])?;
            } else {
                if action == "save" {
                    let text = v["text"]
                        .as_str()
                        .ok_or_else(|| error(400, "Invalid message content or attachments."))?;
                    let files = admission::files(v)
                        .map_err(|_| error(400, "Invalid message content or attachments."))?;
                    if v.get("files").is_none()
                        || text.encode_utf16().count() > 16000
                        || text.trim().is_empty() && files.as_array().is_none_or(Vec::is_empty)
                    {
                        return Err(error(400, "Invalid message content or attachments."));
                    }
                    validate(&files)?;
                    db.execute(
                        "UPDATE turns SET text=?,attachments=? WHERE id=?",
                        params![text.trim(), files.to_string(), turn_id],
                    )?;
                }
                db.execute(
                    "UPDATE queue_edits SET state=? WHERE editor=?",
                    [
                        if action == "save" {
                            "saved"
                        } else {
                            "cancelled"
                        },
                        string(v, "editor"),
                    ],
                )?;
            }
        }
        if action != "renew" {
            db.execute("UPDATE turns SET revision=revision+1 WHERE id=?", [turn_id])?;
        }
    }
    let updated = one(
        db,
        "SELECT revision,text,attachments FROM turns WHERE id=?",
        [turn_id],
    )?
    .ok_or_else(Failure::storage)?;
    let result = json!({"revision":updated["revision"],"editing":editing(db,turn_id)?,"text":updated["text"],"files":data::json(&updated["attachments"])?});
    data::save_receipt(
        db,
        "queue_edit_commands",
        string(v, "id"),
        &request,
        &result,
    )?;
    Ok(result)
}
