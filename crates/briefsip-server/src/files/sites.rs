use super::*;
use sha2::{Digest, Sha256};

fn read(db: &Connection, agent: &str, id: &str) -> Result<Value> {
    one(db,"SELECT id,agent,name,source,revision,deleted,updated FROM local_sites WHERE id=? AND agent=?",[id,agent])?.ok_or_else(||error(404,"Site not found for this agent."))
}
fn command(v: &Value) -> Result<Value> {
    if !v.is_object() {
        return Err(error(400, "Invalid site change."));
    }
    let site = v.get("site");
    if !keys(v, &["id", "site", "revision", "name", "source", "delete"])
        || !valid_id(text(v, "id"))
        || site.is_some_and(|s| !s.as_str().is_some_and(valid_id))
        || if site.is_none() {
            v.get("revision").is_some() || v.get("delete").is_some()
        } else {
            !v["revision"]
                .as_i64()
                .is_some_and(|n| (1..=9007199254740991).contains(&n))
        }
        || v.get("delete").is_some_and(|d| d != true)
    {
        return Err(error(400, "Invalid site identity or revision."));
    }
    let mut result = json!({"id":v["id"]});
    if site.is_some() {
        result["site"] = v["site"].clone();
        result["revision"] = v["revision"].clone();
    }
    if v["delete"] == true {
        if v.get("name").is_some() || v.get("source").is_some() {
            return Err(error(400, "Deletion does not accept site content."));
        }
        result["delete"] = json!(true);
        return Ok(result);
    }
    let name = text(v, "name");
    let source = text(v, "source");
    if name.trim().is_empty()
        || name.encode_utf16().count() > 80
        || name.chars().any(|c| c <= '\x1f' || c == '\x7f')
        || source.trim().is_empty()
        || source.len() > 262144
    {
        return Err(error(
            400,
            "Name is required, up to 80 characters. HTML limit is 256 KiB.",
        ));
    }
    result["name"] = json!(name.trim());
    result["source"] = json!(source);
    Ok(result)
}
pub fn save(db: &Connection, agent: &str, v: &Value, now: i64) -> Result<Value> {
    let v = command(v)?;
    let digest = format!("{:x}", Sha256::digest(v.to_string().as_bytes()));
    let request = text(&v, "id");
    if let Some(prior) = one(
        db,
        "SELECT agent,digest,site FROM site_commands WHERE id=?",
        [request],
    )? {
        if prior["agent"] != agent || prior["digest"] != digest {
            return Err(error(
                409,
                "Change ID was already used for another request.",
            ));
        }
        return read(db, agent, text(&prior, "site"));
    }
    let id = v.get("site").and_then(Value::as_str).unwrap_or(request);
    let updated = timestamp(db, now)?;
    if v.get("site").is_some() {
        let current = read(db, agent, id)?;
        if current["deleted"] == 1 {
            return Err(error(410, "Site was deleted."));
        }
        if current["revision"] != v["revision"] {
            return Err(error(409, "Site changed. Reload before saving."));
        }
        if v["delete"] == true {
            db.execute("UPDATE local_sites SET deleted=1,source='',html='',revision=revision+1,updated=? WHERE id=?",[&updated,id])?;
        } else {
            let html = preview::html("site.html", text(&v, "source").as_bytes())?;
            db.execute("UPDATE local_sites SET name=?,source=?,html=?,revision=revision+1,updated=? WHERE id=?",[text(&v,"name"),text(&v,"source"),&html,&updated,id])?;
        }
    } else {
        if one(db, "SELECT id FROM local_sites WHERE id=?", [id])?.is_some() {
            return Err(error(409, "Site ID was already used."));
        }
        let html = preview::html("site.html", text(&v, "source").as_bytes())?;
        db.execute("INSERT INTO local_sites(id,agent,name,source,html,revision,updated) VALUES(?,?,?,?,?,1,?)",[id,agent,text(&v,"name"),text(&v,"source"),&html,&updated])?;
    }
    db.execute(
        "INSERT INTO site_commands VALUES(?,?,?,?)",
        [request, agent, &digest, id],
    )?;
    read(db, agent, id)
}
pub async fn handle(state: &AppState, req: Request, parts: &[&str]) -> Result<Response> {
    origin(state, &req)?;
    if parts[0] == "sites" {
        if req.method() != Method::GET {
            return Err(error(405, "Method not allowed."));
        }
        let db = state.database.lock().map_err(|_| Failure::storage())?;
        let site = one(
            &db.connection,
            "SELECT html FROM local_sites WHERE id=? AND deleted=0",
            [parts[1]],
        )?
        .ok_or_else(|| error(404, "Site not found."))?;
        return Ok(preview::render(text(&site, "html").to_owned(), true));
    }
    let agent = parts[2];
    let site = parts.get(4).copied();
    {
        let db = state.database.lock().map_err(|_| Failure::storage())?;
        if !valid_id(agent)
            || one(&db.connection, "SELECT id FROM agents WHERE id=?", [agent])?.is_none()
        {
            return Err(error(404, "Agent not found."));
        }
    }
    if req.method() == Method::GET {
        let db = state.database.lock().map_err(|_| Failure::storage())?;
        if let Some(site) = site {
            return Ok(json_response(200, read(&db.connection, agent, site)?));
        }
        let q = query(&req);
        let after = parameter(&q, "after").unwrap_or("");
        if q.iter().any(|(k, _)| k != "after") || !after.is_empty() && !valid_id(after) {
            return Err(error(400, "Invalid site list position."));
        }
        let rows=rows(&db.connection,"SELECT id,name,revision,updated FROM local_sites WHERE agent=? AND deleted=0 AND id>? ORDER BY id LIMIT 21",[agent,after])?;
        return Ok(json_response(200, paginate(rows, "sites", "id")));
    }
    if req.method() != Method::POST || site.is_some() {
        return Err(error(405, "Method not allowed."));
    }
    mutation(state, &req)?;
    let v = body(req, 1600000).await?;
    let mut db = state.database.lock().map_err(|_| Failure::storage())?;
    Ok(json_response(
        200,
        transaction(&mut db.connection, |db| {
            save(db, agent, &v, state.config.now())
        })?,
    ))
}
