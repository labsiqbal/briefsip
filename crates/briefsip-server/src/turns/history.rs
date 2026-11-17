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
    let generated=exists(db,&format!("SELECT 1 FROM generated_files g JOIN turns t ON t.id=g.turn WHERE {clause} AND coalesce((SELECT position FROM queue_positions WHERE turn=t.id),t.seq)<=? AND file=?"),rusqlite::params_from_iter(params))?;
    if !sent && !generated {
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
