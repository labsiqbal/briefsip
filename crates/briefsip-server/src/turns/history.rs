use super::*;

pub fn slice(s: &str, offset: usize, length: usize) -> String {
    String::from_utf16_lossy(
        &s.encode_utf16()
            .skip(offset)
            .take(length)
            .collect::<Vec<_>>(),
    )
}
fn scope(turn: &Value) -> (&'static str, Vec<rusqlite::types::Value>) {
    if let Some(channel) = turn["channel"].as_str() {
        ("channel=?", vec![channel.to_owned().into()])
    } else {
        (
            "agent=? AND channel IS NULL AND thread IS ?",
            vec![
                string(turn, "agent").to_owned().into(),
                turn["thread"]
                    .as_str()
                    .map(|s| s.to_owned().into())
                    .unwrap_or(rusqlite::types::Value::Null),
            ],
        )
    }
}
pub fn position(db: &Connection, turn: &Value) -> Result<i64> {
    Ok(db.query_row("SELECT coalesce((SELECT position FROM queue_positions WHERE turn=t.id),seq) FROM turns t WHERE id=?",[string(turn,"id")],|r|r.get(0))?)
}
pub fn context_position(db: &Connection, turn: &Value) -> Result<i64> {
    match one(
        db,
        "SELECT t.* FROM turns t JOIN room_turns r ON r.root=t.id WHERE r.turn=?",
        [string(turn, "id")],
    )? {
        Some(root) => position(db, &root),
        None => position(db, turn),
    }
}
pub fn requested_files(db: &Connection, turn: &str) -> Result<Vec<Value>> {
    let mut files = all(db,"WITH RECURSIVE results(id) AS(SELECT t.id FROM turns t JOIN threads th ON th.id=t.thread AND th.deleted=0 WHERE t.id=? UNION SELECT t.id FROM results JOIN agent_requests r ON r.turn=results.id AND r.expects_reply=1 JOIN agent_deliveries d ON d.request=r.id JOIN turns t ON t.id=d.turn JOIN threads th ON th.id=t.thread AND th.deleted=0) SELECT DISTINCT f.id,f.name,length(f.bytes) AS size,substr(f.scope,9) AS thread,f.deleted FROM(SELECT turn,file FROM generated_files UNION ALL SELECT turn,file FROM mcp_files UNION ALL SELECT turn,file FROM image_generations WHERE file IS NOT NULL) outputs JOIN files f ON f.id=outputs.file WHERE outputs.turn IN(SELECT id FROM results) AND f.scope LIKE 'threads:%' ORDER BY f.seq",[turn])?;
    for file in &mut files {
        if file["deleted"] == 1 {
            file["deleted"] = json!(true);
        } else if let Some(file) = file.as_object_mut() {
            file.remove("deleted");
        }
    }
    Ok(files)
}
pub fn readable_file(
    db: &Connection,
    turn: &Value,
    id: &str,
) -> Result<Option<crate::files::attachments::File>> {
    let (clause, mut params) = scope(turn);
    params.extend([position(db, turn)?.into(), id.to_owned().into()]);
    let sent=exists(db,&format!("SELECT 1 FROM turns t JOIN json_each(t.attachments) attachment WHERE {clause} AND coalesce((SELECT position FROM queue_positions WHERE turn=t.id),seq)<=? AND attachment.value=?"),rusqlite::params_from_iter(params))?;
    let (clause, mut params) = scope(turn);
    params.extend([position(db, turn)?.into(), id.to_owned().into()]);
    let generated=exists(db,&format!("SELECT 1 FROM (SELECT turn,file FROM generated_files UNION ALL SELECT turn,file FROM mcp_files) g JOIN turns t ON t.id=g.turn WHERE {clause} AND coalesce((SELECT position FROM queue_positions WHERE turn=t.id),t.seq)<=? AND file=?"),rusqlite::params_from_iter(params))?;
    let (clause, mut params) = scope(turn);
    params.extend([position(db, turn)?.into(), id.to_owned().into()]);
    let image=exists(db,&format!("SELECT 1 FROM image_generations g JOIN turns t ON t.id=g.turn WHERE {clause} AND coalesce((SELECT position FROM queue_positions WHERE turn=t.id),t.seq)<=? AND file=?"),rusqlite::params_from_iter(params))?;
    if !sent && !generated && !image {
        for row in all(
            db,
            "SELECT delivery,snapshot FROM agent_reply_claims WHERE consumer=?",
            [string(turn, "id")],
        )? {
            let reply = data::json(&row["snapshot"])?;
            if reply["generatedFiles"]
                .as_array()
                .is_some_and(|files| files.iter().any(|file| file["id"] == id))
                && requested_files(db, string(&row, "delivery"))?
                    .iter()
                    .any(|file| file["id"] == id && file["deleted"] != true)
            {
                if let Some(source) = one(db, "SELECT scope FROM files WHERE id=?", [id])? {
                    return crate::files::attachments::file(db, id, string(&source, "scope"))
                        .map(Some);
                }
            }
        }
        for reply in all(db,"SELECT reply.value FROM flow_tool_calls c,json_each(c.result,'$.replies') reply WHERE c.turn=? AND json_extract(c.call,'$.function.name')='send_message'",[string(turn,"id")])? {
            let reply = data::json(&reply["value"])?;
            if reply["generatedFiles"].as_array().is_some_and(|files| files.iter().any(|file| file["id"]==id)) && requested_files(db,string(&reply,"id"))?.iter().any(|file| file["id"]==id && file["deleted"]!=true) {
                if let Some(source) = one(db,"SELECT scope FROM files WHERE id=?",[id])? {
                    return crate::files::attachments::file(db,id,string(&source,"scope")).map(Some);
                }
            }
        }
        return Ok(None);
    }
    match crate::files::attachments::file(db, id, &execution::scope(turn)) {
        Ok(f) => Ok(Some(f)),
        Err(e) if e.status == 404 => Ok(None),
        Err(e) => Err(e),
    }
}
pub fn read(db: &Connection, turn: &Value, name: &str, args: &Value) -> Result<Value> {
    let (clause, mut params) = scope(turn);
    let position = position(db, turn)?;
    if name == "read_history" {
        let before = args
            .get("before")
            .cloned()
            .unwrap_or(json!(9_007_199_254_740_991i64));
        if !closed(args, &["before"]) || !integer(&before, 1, 9_007_199_254_740_991) {
            return Err(error(400, "Invalid history position."));
        }
        params.extend([
            before.as_i64().ok_or_else(Failure::storage)?.into(),
            position.into(),
        ]);
        let mut rows=all(db,&format!("SELECT id,seq,agent,text,reply,status,created FROM turns t WHERE {clause} AND seq<? AND coalesce((SELECT position FROM queue_positions WHERE turn=t.id),seq)<? ORDER BY seq DESC LIMIT 6"),rusqlite::params_from_iter(params))?;
        let next = if rows.len() > 5 {
            rows.get(4).map(|r| r["seq"].clone())
        } else {
            None
        };
        rows.truncate(5);
        for row in &mut rows {
            row["truncated"] = json!(
                string(row, "text").encode_utf16().count() > 500
                    || string(row, "reply").encode_utf16().count() > 500
            );
            row["text"] = json!(slice(string(row, "text"), 0, 500));
            if !row["reply"].is_null() {
                row["reply"] = json!(slice(string(row, "reply"), 0, 500));
            }
        }
        return Ok(json!({"messages":rows,"next_before":next}));
    }
    let offset = args.get("offset").cloned().unwrap_or(json!(0));
    if !closed(args, &["id", "offset"])
        || !uuid(string(args, "id"))
        || !integer(&offset, 0, 9_007_199_254_740_991)
    {
        return Err(error(400, "Invalid message ID or position."));
    }
    let offset = offset.as_u64().unwrap_or(0) as usize;
    if name == "read_attachment" {
        let Some(file) = readable_file(db, turn, string(args, "id"))? else {
            return Ok(
                json!({"error":"Attachment not found in sent messages in this conversation."}),
            );
        };
        if let Some(mime) = crate::files::attachments::image_type(&file.bytes) {
            return Ok(if offset > 0 {
                json!({"error":"Image offset must be zero."})
            } else {
                json!({"id":args["id"],"name":file.meta["name"],"media_type":mime,"note":"Image pixels follow this tool result in a user message."})
            });
        }
        if let Some(format) = super::transcription::audio(&file.bytes) {
            return Ok(
                json!({"id":args["id"],"name":file.meta["name"],"text":"","source":"audio","format":format,"note":"Audio file attached. Its contents have not been transcribed. Ask the user to transcribe it through the file preview before interpreting it."}),
            );
        }
        let text = std::str::from_utf8(&file.bytes)
            .map_err(|_| error(415, "Message attachment must be UTF-8 text."))?;
        return Ok(
            json!({"id":args["id"],"name":file.meta["name"],"text":slice(text,offset,8000),"offset":offset,"next_offset":if text.encode_utf16().count()>offset+8000 {Some(offset+8000)}else{None}}),
        );
    }
    params.extend([string(args, "id").to_owned().into(), position.into()]);
    let Some(mut row)=one(db,&format!("SELECT id,seq,agent,text,reply,status,created,attachments FROM turns t WHERE {clause} AND id=? AND coalesce((SELECT position FROM queue_positions WHERE turn=t.id),seq)<?"),rusqlite::params_from_iter(params))? else{return Ok(json!({"error":"Message not found in this conversation before the current request."}));};
    let length = string(&row, "text")
        .encode_utf16()
        .count()
        .max(string(&row, "reply").encode_utf16().count());
    row["text"] = json!(slice(string(&row, "text"), offset, 8000));
    row["reply"] = json!(slice(string(&row, "reply"), offset, 8000));
    row["offset"] = json!(offset);
    row["next_offset"] = json!(if length > offset + 8000 {
        Some(offset + 8000)
    } else {
        None
    });
    row["attachments"] = json!([]);
    row["generatedFiles"] = json!([]);
    row["approvals"] = json!([]);
    row["harnessApprovals"] = json!([]);
    row["questions"] = json!([]);
    Ok(row)
}
