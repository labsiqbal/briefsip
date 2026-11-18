use super::*;

fn slice(value: &Value, offset: usize, limit: usize) -> String {
    String::from_utf16_lossy(
        &value
            .as_str()
            .unwrap_or("")
            .encode_utf16()
            .skip(offset)
            .take(limit)
            .collect::<Vec<_>>(),
    )
}
pub fn history(db: &Connection, task: &Value, name: &str, args: &Value) -> Result<Value> {
    if name == "read_history"
        && args
            .get("before")
            .is_some_and(|v| !data::integer(v, 1, 9007199254740991))
    {
        return Err(fail(400, "invalid_history", "Invalid history position."));
    }
    if name == "read_message"
        && (id(&args["id"]).is_err()
            || args
                .get("offset")
                .is_some_and(|v| !data::integer(v, 0, 9007199254740991)))
    {
        return Err(fail(
            400,
            "invalid_message",
            "Invalid message ID or position.",
        ));
    }
    let root = sources::root(db, task)?;
    let position = "coalesce((SELECT position FROM queue_positions WHERE turn=t.id),t.seq)";
    let pos: i64 = db.query_row(
        &format!("SELECT {position} FROM turns t WHERE id=?"),
        [string(task, "logical_turn")],
        |r| r.get(0),
    )?;
    let query = format!("FROM turns t JOIN record_scopes s ON s.table_name='turns' AND s.key_json=json_array(t.id) WHERE s.project=? AND s.root_kind=? AND s.root_id=? AND (s.visibility='project' OR s.account=?) AND {position}<?");
    if name == "read_history" {
        let mut rows = all(db, &format!("SELECT t.id,t.seq,t.agent,t.text,t.reply,t.status,t.created {query} AND t.seq<? ORDER BY t.seq DESC LIMIT 6"), params![string(task,"project"),string(&root,"root_kind"),string(&root,"root_id"),string(task,"initiator_account"),pos,args["before"].as_i64().unwrap_or(9007199254740991)])?;
        let next = if rows.len() > 5 {
            rows[4]["seq"].clone()
        } else {
            Value::Null
        };
        rows.truncate(5);
        for row in &mut rows {
            row["truncated"] = json!(
                string(row, "text").encode_utf16().count() > 500
                    || string(row, "reply").encode_utf16().count() > 500
            );
            row["text"] = json!(slice(&row["text"], 0, 500));
            if !row["reply"].is_null() {
                row["reply"] = json!(slice(&row["reply"], 0, 500));
            }
        }
        return Ok(json!({"messages":rows,"next_before":next}));
    }
    let Some(mut row) = one(db, &format!("SELECT t.id,t.seq,t.agent,t.text,t.reply,t.status,t.created,t.attachments {query} AND t.id=?"), params![string(task,"project"),string(&root,"root_kind"),string(&root,"root_id"),string(task,"initiator_account"),pos,string(args,"id")])? else {
        return Ok(json!({"error":"Message not found in this conversation before the current request."}));
    };
    let offset = args["offset"].as_u64().unwrap_or(0) as usize;
    let length = string(&row, "text")
        .encode_utf16()
        .count()
        .max(string(&row, "reply").encode_utf16().count());
    let attachments = all(db,"SELECT f.id,f.name,length(f.bytes) size FROM json_each(?) j JOIN files f ON f.id=j.value JOIN record_scopes s ON s.table_name='files' AND s.key_json=json_array(f.id) WHERE s.project=? AND s.root_kind=? AND s.root_id=? AND (s.visibility='project' OR s.account=?) ORDER BY j.key",params![string(&row,"attachments"),string(task,"project"),string(&root,"root_kind"),string(&root,"root_id"),string(task,"initiator_account")])?;
    let generated = all(db,"SELECT f.id,f.name,f.digest,length(f.bytes) size FROM generated_files o JOIN files f ON f.id=o.file JOIN record_scopes s ON s.table_name='files' AND s.key_json=json_array(f.id) WHERE o.turn=? AND s.project=? AND s.root_kind=? AND s.root_id=? AND (s.visibility='project' OR s.account=?) ORDER BY o.seq",params![string(&row,"id"),string(task,"project"),string(&root,"root_kind"),string(&root,"root_id"),string(task,"initiator_account")])?;
    let mut questions = all(
        db,
        "SELECT id,prompt,choices,answer FROM questions WHERE turn=? ORDER BY rowid",
        [string(&row, "id")],
    )?;
    for question in &mut questions {
        question["choices"] = data::json(&question["choices"])?;
    }
    row["text"] = json!(slice(&row["text"], offset, 8000));
    row["reply"] = json!(slice(&row["reply"], offset, 8000));
    row["attachments"] = json!(attachments);
    row["generatedFiles"] = json!(generated);
    row["questions"] = json!(questions);
    row["offset"] = json!(offset);
    row["next_offset"] = if length > offset.saturating_add(8000) {
        json!(offset + 8000)
    } else {
        Value::Null
    };
    Ok(row)
}

pub fn skill(
    db: &Connection,
    task: &Value,
    current: &Value,
    name: &str,
    args: &Value,
) -> Result<Value> {
    let listing = name == "list_skills";
    if (!listing && id(&args["id"]).is_err())
        || (listing && args.get("after").is_some_and(|v| id(v).is_err()))
    {
        return Err(fail(400, "invalid_skill", "Invalid skill ID."));
    }
    if name == "read_skill_file"
        && (args["path"]
            .as_str()
            .is_none_or(|p| p.encode_utf16().count() > 240)
            || args
                .get("offset")
                .is_some_and(|v| !data::integer(v, 0, 9007199254740991)))
    {
        return Err(fail(
            400,
            "invalid_skill",
            "Invalid skill file path or position.",
        ));
    }
    let source = sources::get(db, task, current)?;
    let installed = source["skills"].as_array().ok_or_else(Failure::storage)?;
    if listing {
        let rows = installed
            .iter()
            .filter(|row| string(row, "skill") > string(args, "after"))
            .collect::<Vec<_>>();
        return Ok(
            json!({"items":rows.iter().take(10).map(|r|json!({"id":r["skill"],"version":r["revision"],"name":r["name"],"description":r["description"]})).collect::<Vec<_>>(),"next_after":if rows.len()>10 { rows[9]["skill"].clone() } else { Value::Null }}),
        );
    }
    let Some(skill) = installed.iter().find(|r| r["skill"] == args["id"]) else {
        return Ok(json!({"error":"Enabled installed skill not found."}));
    };
    let files = one(db,"SELECT f.files FROM skill_files f JOIN record_scopes s ON s.table_name='skill_files' AND s.key_json=json_array(f.skill,f.revision) JOIN projects p ON p.id=s.project JOIN agent_authority h ON h.agent=? AND h.owner_account=s.account AND h.owner_account=p.account WHERE f.skill=? AND f.revision=?",params![string(task,"agent"),string(skill,"skill"),n(skill,"revision")])?.map(|r|data::json(&r["files"])).transpose()?.unwrap_or(json!([]));
    let files = files.as_array().ok_or_else(Failure::storage)?;
    if name == "read_skill" {
        return Ok(
            json!({"id":skill["skill"],"version":skill["revision"],"name":skill["name"],"description":skill["description"],"content":skill["content"],"files":files.iter().map(|f|if f.get("encoding").is_some() {json!({"path":f["path"],"binary":true})}else{json!({"path":f["path"],"characters":string(f,"content").encode_utf16().count()})}).collect::<Vec<_>>()}),
        );
    }
    let Some(file) = files.iter().find(|f| f["path"] == args["path"]) else {
        return Ok(json!({"error":"File not found in installed skill."}));
    };
    if file.get("encoding").is_some() {
        return Ok(
            json!({"error":"Binary skill asset cannot be read as text. Export the skill package from the library to use its original bytes.","path":file["path"],"binary":true}),
        );
    }
    let offset = args["offset"].as_u64().unwrap_or(0) as usize;
    Ok(
        json!({"id":skill["skill"],"version":skill["revision"],"path":file["path"],"content":slice(&file["content"],offset,8000),"next_offset":if offset.saturating_add(8000)<string(file,"content").encode_utf16().count(){json!(offset+8000)}else{Value::Null}}),
    )
}
