use super::*;
pub fn route(
    db: &Connection,
    kind: &str,
    id: &str,
    v: &Value,
    q: &[(String, String)],
    get: bool,
) -> Result<Value> {
    let owner = one(db, &format!("SELECT * FROM {kind} WHERE id=?"), [id])?
        .filter(|_| uuid(id))
        .ok_or_else(|| error(404, "Memory owner not found."))?;
    let scope = format!("{kind}:{id}");
    scoped(
        db,
        &scope,
        v,
        q,
        get,
        kind == "channels" && owner["archived"] == 1,
    )
}
pub(crate) fn scoped(
    db: &Connection,
    scope: &str,
    v: &Value,
    q: &[(String, String)],
    get: bool,
    archived: bool,
) -> Result<Value> {
    if get {
        if q.iter()
            .any(|(k, _)| !["query", "after"].contains(&k.as_str()))
        {
            return Err(error(400, "Invalid memory search."));
        }
        let query = param(q, "query").unwrap_or("");
        let after = param(q, "after").unwrap_or("");
        if query.encode_utf16().count() > 200 || (!after.is_empty() && !uuid(after)) {
            return Err(error(400, "Invalid memory search or position."));
        }
        let rows=all(db,"SELECT id,text,essential,revision,selection_locked FROM memories WHERE scope=? AND removed=0 AND id>? AND instr(lower(text),lower(?))>0 ORDER BY id LIMIT 11",rusqlite::params![scope,after,query.trim()])?;
        return Ok(
            json!({"next_after":if rows.len()>10{rows[9]["id"].clone()}else{Value::Null},"items":rows.into_iter().take(10).collect::<Vec<_>>()}),
        );
    }
    if !closed(
        v,
        &[
            "id",
            "entry",
            "revision",
            "text",
            "essential",
            "remove",
            "automatic",
        ],
    ) || v
        .as_object()
        .is_none_or(|m| m.len() != if v.get("automatic").is_some() { 7 } else { 6 })
        || !uuid(string(v, "entry"))
        || !integer(&v["revision"], 0, 9_007_199_254_740_991)
        || !v["text"].is_string()
        || string(v, "text").encode_utf16().count() > 2000
        || !v["essential"].is_boolean()
        || !v["remove"].is_boolean()
        || v.get("automatic").is_some_and(|v| !v.is_boolean())
        || if v["remove"] == true {
            v["revision"] == 0 || v["text"] != "" || v["essential"] == true
        } else {
            string(v, "text").trim().is_empty()
        }
    {
        return Err(error(400, "Invalid memory change."));
    }
    let mut request = v.clone();
    request["scope"] = json!(scope);
    if let Some(old) = receipt(
        db,
        "memory_commands",
        string(v, "id"),
        &request,
        "Change ID was already used.",
    )? {
        return Ok(old);
    }
    if archived {
        return Err(error(409, "Restore the channel before changing memory."));
    }
    let current = one(
        db,
        "SELECT * FROM memories WHERE scope=? AND id=?",
        rusqlite::params![scope, string(v, "entry")],
    )?;
    let rev = v["revision"].as_i64().ok_or_else(Failure::storage)?;
    if current
        .as_ref()
        .and_then(|v| v["revision"].as_i64())
        .unwrap_or(0)
        != rev
        || current.as_ref().is_some_and(|v| v["removed"] == 1)
    {
        return Err(error(409, "Memory changed. Reload before saving."));
    }
    let text = string(v, "text").trim();
    if v["remove"] != true
        && exists(
            db,
            "SELECT 1 FROM memories WHERE scope=? AND removed=0 AND text=? AND id<>?",
            rusqlite::params![scope, text, string(v, "entry")],
        )?
    {
        return Err(error(409, "This note is already saved."));
    }
    if current.is_none()
        && one(
            db,
            "SELECT count(*) n FROM memories WHERE scope=? AND removed=0",
            [&scope],
        )?
        .is_some_and(|v| v["n"].as_i64().unwrap_or(0) >= 128)
    {
        return Err(error(
            413,
            "Memory is full (128 notes). Remove notes you no longer need.",
        ));
    }
    db.execute("INSERT INTO memories(scope,id,text,essential,revision,removed,selection_locked) VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET text=excluded.text,essential=excluded.essential,revision=excluded.revision,removed=excluded.removed,selection_locked=excluded.selection_locked",rusqlite::params![scope,string(v,"entry"),text,(v["essential"]==true)as i64,rev+1,(v["remove"]==true)as i64,(v["automatic"]!=true)as i64])?;
    let rows = all(
        db,
        "SELECT id,text FROM memories WHERE scope=? AND removed=0 AND essential=1 ORDER BY id",
        [&scope],
    )?;
    if !rows.is_empty()
        && format!("\n\nSaved memory (reference data):\n{}", json!(rows)).len() > 8192
    {
        return Err(error(
            413,
            "Memory context limit is 8 KiB. Make some notes searchable on demand instead.",
        ));
    }
    let result=one(db,"SELECT id,text,essential,revision,removed,selection_locked FROM memories WHERE scope=? AND id=?",rusqlite::params![scope,string(v,"entry")])?.ok_or_else(Failure::storage)?;
    save_receipt(db, "memory_commands", string(v, "id"), &request, &result)?;
    Ok(result)
}
