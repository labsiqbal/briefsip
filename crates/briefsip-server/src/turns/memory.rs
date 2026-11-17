use super::*;

pub fn run(db: &Connection, turn: &Value, name: &str, args: &Value) -> Result<Value> {
    let (kind, owner) = if let Some(channel) = turn["channel"].as_str() {
        ("channels", channel)
    } else {
        ("agents", string(turn, "agent"))
    };
    let scope = format!("{kind}:{owner}");
    if name == "search_memory" {
        if !closed(args, &["query", "after"]) {
            return Err(error(400, "Invalid memory search."));
        }
        let mut q = Vec::new();
        for key in ["query", "after"] {
            if let Some(v) = args.get(key) {
                q.push((
                    key.to_owned(),
                    v.as_str()
                        .ok_or_else(|| error(400, "Invalid memory search or position."))?
                        .to_owned(),
                ));
            }
        }
        return data::memory::route(db, kind, owner, &json!({}), &q, true);
    }
    if name == "remember_memory" {
        let editing = args.get("id").is_some() || args.get("revision").is_some();
        if !closed(args, &["id", "revision", "text"])
            || editing
                && (!uuid(string(args, "id"))
                    || !integer(&args["revision"], 1, 9_007_199_254_740_991))
        {
            return Err(error(400, "Invalid agent memory change."));
        }
        let old = if editing {
            one(
                db,
                "SELECT * FROM memories WHERE scope=? AND id=? AND removed=0",
                [&scope, string(args, "id")],
            )?
        } else {
            None
        };
        if editing && old.is_none() {
            return Err(error(404, "Memory note not found in this conversation."));
        }
        return data::memory::route(
            db,
            kind,
            owner,
            &json!({"id":uuid::Uuid::new_v4().to_string(),"entry":if editing{string(args,"id").to_owned()}else{uuid::Uuid::new_v4().to_string()},"revision":if editing{args["revision"].clone()}else{json!(0)},"text":args["text"],"essential":old.as_ref().is_some_and(|r|r["essential"]==1),"remove":false,"automatic":old.as_ref().is_none_or(|r|r["selection_locked"]==0)}),
            &[],
            false,
        );
    }
    let items = args["items"]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 128)
        .ok_or_else(|| error(400, "Invalid memory selection."))?;
    if !closed(args, &["items"]) {
        return Err(error(400, "Invalid memory selection."));
    }
    let mut seen = std::collections::HashSet::new();
    for item in items {
        if !closed(item, &["id", "revision", "essential"])
            || !uuid(string(item, "id"))
            || !seen.insert(string(item, "id"))
            || !integer(&item["revision"], 1, 9_007_199_254_740_991)
            || !item["essential"].is_boolean()
        {
            return Err(error(400, "Invalid memory selection."));
        }
        let current = one(
            db,
            "SELECT revision,selection_locked FROM memories WHERE scope=? AND id=? AND removed=0",
            [&scope, string(item, "id")],
        )?
        .ok_or_else(|| error(404, "Memory note not found in this conversation."))?;
        if current["selection_locked"] == 1 || current["revision"] != item["revision"] {
            return Err(error(
                409,
                "Selection is locked by the user or the memory revision changed.",
            ));
        }
    }
    let mut output = Vec::new();
    for item in items {
        db.execute(
            "UPDATE memories SET essential=?,revision=revision+1 WHERE scope=? AND id=?",
            params![
                i64::from(item["essential"] == true),
                scope,
                item["id"].as_str()
            ],
        )?;
        output.push(one(db,"SELECT id,essential,revision,selection_locked FROM memories WHERE scope=? AND id=?",[&scope,string(item,"id")])?.ok_or_else(Failure::storage)?);
    }
    let notes = all(
        db,
        "SELECT id,text FROM memories WHERE scope=? AND removed=0 AND essential=1 ORDER BY id",
        [&scope],
    )?;
    if format!("\n\nSaved memory (reference data):\n{}", json!(notes)).len() > 8192 {
        return Err(error(
            413,
            "Memory context limit is 8 KiB. Select fewer notes.",
        ));
    }
    Ok(json!({"items":output}))
}
