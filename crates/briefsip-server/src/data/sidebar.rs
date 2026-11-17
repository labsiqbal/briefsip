use super::*;
use regex::Regex;
pub fn read(db: &Connection, q: &[(String, String)]) -> Result<Value> {
    if !q.is_empty() {
        return Err(error(400, "Invalid sidebar parameters."));
    }
    let row = one(db, "SELECT revision,sections FROM sidebar WHERE id=1", [])?
        .ok_or_else(Failure::storage)?;
    Ok(json!({"revision":row["revision"],"sections":json(&row["sections"])?}))
}
pub fn save(db: &Connection, v: &Value, q: &[(String, String)]) -> Result<Value> {
    if !q.is_empty()
        || !closed(v, &["id", "revision", "sections"])
        || !integer(&v["revision"], 0, 9_007_199_254_740_991)
    {
        return Err(error(400, "Invalid sidebar request."));
    }
    let sections = v["sections"]
        .as_array()
        .filter(|v| v.len() <= 100)
        .ok_or_else(|| error(400, "Sidebar limit is 100 sections."))?;
    let mut ids = std::collections::HashSet::new();
    let mut agents = std::collections::HashSet::new();
    let mut normalized = Vec::new();
    for section in sections {
        let name = section["name"].as_str().unwrap_or("");
        let id = string(section, "id");
        let valid_id = id.len() == 36
            && id.bytes().enumerate().all(|(i, b)| {
                if [8, 13, 18, 23].contains(&i) {
                    b == b'-'
                } else {
                    b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
                }
            });
        if !closed(section, &["id", "name", "agents"])
            || !valid_id
            || !ids.insert(id)
            || name.trim().is_empty()
            || name.encode_utf16().count() > 80
            || name.chars().any(|c| c < ' ' || c == '\u{7f}')
            || section["agents"].as_array().is_none_or(|a| a.len() > 1000)
        {
            return Err(error(400, "Invalid sidebar section."));
        }
        for a in section["agents"].as_array().ok_or_else(Failure::storage)? {
            let id = a.as_str().unwrap_or("");
            if !uuid(id) || id != id.to_ascii_lowercase() || !agents.insert(id) {
                return Err(error(400, "Agent can only belong to one section."));
            }
        }
        normalized.push(json!({"id":id,"name":name.trim(),"agents":section["agents"]}));
    }
    let request = json!({"revision":v["revision"],"sections":normalized});
    if let Some(old) = receipt(
        db,
        "sidebar_commands",
        string(v, "id"),
        &request,
        "ID was already used for a different change.",
    )? {
        return Ok(old);
    }
    if read(db, &[])?["revision"] != v["revision"] {
        return Err(error(409, "Sidebar changed. Reload before saving."));
    }
    for id in agents {
        if !exists(db, "SELECT 1 FROM agents WHERE id=?", [id])? {
            return Err(error(404, "Sidebar agent not found."));
        }
    }
    let revision = v["revision"].as_i64().ok_or_else(Failure::storage)? + 1;
    let result = json!({"revision":revision,"sections":normalized});
    db.execute(
        "UPDATE sidebar SET revision=?,sections=? WHERE id=1",
        rusqlite::params![revision, json!(normalized).to_string()],
    )?;
    save_receipt(db, "sidebar_commands", string(v, "id"), &request, &result)?;
    Ok(result)
}
pub fn summary(
    state: &AppState,
    db: &Connection,
    q: &[(String, String)],
    h: &HeaderMap,
) -> Result<Value> {
    if !q.is_empty() {
        return Err(error(400, "Invalid sidebar summary parameters."));
    }
    if h.contains_key("origin") && !origin(state, h) {
        return Err(error(403, "Origin is not allowed."));
    }
    let secrets = providers::accounts(state)?
        .into_iter()
        .filter_map(|a| a.key)
        .collect::<Vec<_>>();
    let pattern=Regex::new(r#"(?i)\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]+=*|(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?[^\s,"'}]+)"#).map_err(|_|Failure::storage())?;
    let redact = |v: &str| {
        let mut text = v.to_owned();
        for key in &secrets {
            if !key.is_empty() {
                text = text.replace(key, "[redacted]");
            }
        }
        let text = pattern.replace_all(&text, "[redacted]");
        text.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(180)
            .collect::<String>()
    };
    let local=all(db,"SELECT agents.id AS agent,substr(t.reply,1,8192) AS reply,substr(t.text,1,8192) AS text,t.created,CASE WHEN EXISTS(SELECT 1 FROM turns WHERE agent=agents.id AND channel IS NULL AND status='running') THEN 'running' ELSE 'idle' END AS status FROM agents LEFT JOIN turns t ON t.seq=(SELECT seq FROM turns WHERE agent=agents.id AND channel IS NULL ORDER BY seq DESC LIMIT 1) ORDER BY agents.rowid LIMIT 500",[])?;
    let mut summaries=local.into_iter().map(|r|json!({"agent":r["agent"],"preview":redact(if string(&r,"reply").is_empty(){string(&r,"text")}else{string(&r,"reply")}),"time":r["created"],"status":r["status"]})).collect::<Vec<_>>();
    if table(db, "paired_machines")? {
        for r in all(db,"SELECT machine,agent,substr(reply,1,8192) AS reply,substr(text,1,8192) AS text,created,status FROM remote_agent_calls AS calls WHERE delivery IS NULL AND EXISTS(SELECT 1 FROM paired_machines WHERE environment_id=calls.machine AND state='paired') AND id=(SELECT id FROM remote_agent_calls AS latest WHERE latest.delivery IS NULL AND latest.machine=calls.machine AND latest.agent=calls.agent ORDER BY created DESC,id DESC LIMIT 1) ORDER BY machine,agent LIMIT 500",[])?{summaries.push(json!({"agent":format!("{}@{}",string(&r,"agent"),string(&r,"machine")),"preview":redact(if string(&r,"reply").is_empty(){string(&r,"text")}else{string(&r,"reply")}),"time":iso(db,r["created"].as_i64().unwrap_or(0))?,"status":r["status"]}));}
    }
    Ok(json!({"summaries":summaries}))
}
