use super::*;
fn visible(row: &Value) -> Value {
    json!({"id":row["id"],"name":row["name"],"url":row["url"],"enabled":row["enabled"],"revision":row["revision"],"hasToken":!string(row,"token").is_empty()})
}
fn scoped(db: &Connection, id: &str, project: &str) -> Result<Value> {
    one(db,"SELECT c.* FROM mcp_connections c LEFT JOIN mcp_projects p ON p.connection=c.id WHERE c.id=? AND coalesce(p.project,'')=?",[id,project])?.ok_or_else(||error(404,"MCP connection not found."))
}
fn detail(db: &Connection, id: &str, agent: &str, project: &str) -> Result<Value> {
    let row = scoped(db, id, project)?;
    if !agent.is_empty() {
        data::agents::read(db, agent)?;
        member(db, project, agent)?;
    }
    let mut result = visible(&row);
    result["tools"] = data::json(&row["tools"])?;
    let grant = one(
        db,
        "SELECT * FROM mcp_grants WHERE agent=? AND connection=?",
        [agent, id],
    )?;
    result["grant"] = match grant {
        Some(v) => json!({"revision":v["revision"],"tools":data::json(&v["tools"])?}),
        None => json!({"revision":0,"tools":[]}),
    };
    Ok(result)
}
pub fn member(db: &Connection, project: &str, agent: &str) -> Result<()> {
    if !project.is_empty()&&!data::exists(db,"SELECT 1 FROM local_projects p JOIN local_project_members m ON m.project=p.id WHERE p.id=? AND m.agent=? AND p.archived=0 AND p.deleted=0",[project,agent])?{return Err(error(403,"Agent is not an active project member."));}
    Ok(())
}
pub(super) fn redact(value: &Value, token: &str) -> Value {
    if token.is_empty() {
        return value.clone();
    }
    match value {
        Value::String(s) => json!(s.replace(token, "[REDACTED]")),
        Value::Array(a) => json!(a.iter().map(|v| redact(v, token)).collect::<Vec<_>>()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, v)| (k.replace(token, "[REDACTED]"), redact(v, token)))
                .collect(),
        ),
        v => v.clone(),
    }
}
pub(super) fn clean_tools(value: &Value, token: &str) -> Result<Value> {
    let mut tools = value.as_array().cloned().ok_or_else(Failure::storage)?;
    for tool in &mut tools {
        let o = tool.as_object_mut().ok_or_else(Failure::storage)?;
        let description = o.shift_remove("description");
        let title = o.shift_remove("title");
        if !token.is_empty() && o.values().any(|v| collision(v, token, false)) {
            return Err(error(400,"Token conflicts with a tool name or schema. Use a different token before testing the connection."));
        }
        if let Some(d) = description {
            o.insert("description".into(), redact(&d, token));
        }
        if let Some(t) = title {
            o.insert("title".into(), redact(&t, token));
        }
    }
    Ok(json!(tools))
}
fn collision(v: &Value, token: &str, dictionary: bool) -> bool {
    match v {
        Value::String(s) => s.contains(token),
        Value::Array(a) => a.iter().any(|v| collision(v, token, false)),
        Value::Object(o) => o.iter().any(|(k, v)| {
            dictionary && k.contains(token)
                || collision(
                    v,
                    token,
                    [
                        "properties",
                        "patternProperties",
                        "$defs",
                        "definitions",
                        "dependentRequired",
                        "dependentSchemas",
                        "_meta",
                    ]
                    .contains(&k.as_str()),
                )
        }),
        _ => false,
    }
}
fn config(v: &Value) -> Result<(String, String, String)> {
    let name = field(v, "name", 80)?;
    let token = v["token"]
        .as_str()
        .filter(|t| {
            t.len() <= 4096
                && t.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._~+/-=".contains(&b))
        })
        .ok_or_else(|| error(400, "Invalid MCP name, URL, or Bearer token."))?;
    let address = string(v, "url");
    let url = url::Url::parse(address).map_err(|_| error(400, "Invalid MCP URL."))?;
    if address.len() > 2000
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https"
            || url.scheme() == "http"
                && ["127.0.0.1", "[::1]", "localhost"].contains(&url.host_str().unwrap_or("")))
    {
        return Err(error(400,"Use HTTPS or loopback HTTP without userinfo, a query, or a fragment. Enter the token separately."));
    }
    Ok((name, url.to_string(), token.into()))
}
pub async fn route(state: &AppState, request: Request) -> Result<Response> {
    let path = request.uri().path().to_owned();
    let query = data::query(&request);
    let get = request.method() == Method::GET;
    if !get
        && (!data::origin(state, request.headers())
            || request.headers().contains_key("authorization"))
    {
        return Err(error(403, "Request must originate from Minarbot."));
    }
    let v = if get {
        json!({})
    } else {
        let bytes = axum::body::to_bytes(request.into_body(), 64000)
            .await
            .map_err(|_| error(413, "Request is too large."))?;
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| error(400, "Invalid JSON."))?;
        if !uuid(string(&v, "id")) {
            return Err(error(400, "Invalid request ID."));
        }
        v
    };
    let parts = path.split('/').skip(1).collect::<Vec<_>>();
    let mut p = parts.as_slice();
    let mut project = "";
    if let ["api", "projects", id, rest @ ..] = p {
        project = id;
        p = rest;
    } else {
        p = p
            .strip_prefix(&["api"])
            .ok_or_else(|| error(404, "Route not found."))?;
    }
    if p == ["mcp", "test"] && !get {
        return test(state, &v, project)
            .await
            .map(|v| crate::json_response(200, v));
    }
    let guard = state.database.lock().map_err(|_| Failure::storage())?;
    let db = &guard.connection;
    let value = transaction(db, || {
        let request = json!({"path":path,"value":v});
        if !get {
            if let Some(old) = data::receipt(
                db,
                "mcp_commands",
                string(&v, "id"),
                &request,
                "ID was already used for a different change.",
            )? {
                return Ok(old);
            }
        }
        let result = match p {
            ["mcp"] if get => {
                let after = data::param(&query, "after").unwrap_or("");
                if !after.is_empty() && !uuid(after) {
                    return Err(error(400, "Invalid connection position."));
                }
                let rows=all(db,"SELECT c.* FROM mcp_connections c LEFT JOIN mcp_projects p ON p.connection=c.id WHERE c.id>? AND coalesce(p.project,'')=? ORDER BY c.id LIMIT 21",[after,project])?;
                json!({"items":rows.iter().take(20).map(visible).collect::<Vec<_>>(),"next_after":rows.get(20).and_then(|_|rows.get(19)).map(|r|r["id"].clone())})
            }
            ["mcp"] => {
                if !closed(&v, &["id", "test"]) {
                    return Err(error(400, "Unknown MCP field."));
                }
                let t=one(db,"SELECT t.* FROM mcp_tests t LEFT JOIN mcp_test_projects p ON p.test=t.id WHERE t.id=? AND expires>=? AND coalesce(p.project,'')=?",params![string(&v,"test"),state.config.now(),project])?.ok_or_else(||error(409,"MCP test expired or was lost after restart. Test again before saving."))?;
                if t["connection"].is_string() {
                    return Err(error(
                        400,
                        "This test result can only update the original connection.",
                    ));
                }
                db.execute(
                    "INSERT INTO mcp_connections VALUES(?,?,?,?,?,1,1)",
                    params![
                        string(&v, "id"),
                        t["name"].as_str(),
                        t["url"].as_str(),
                        t["token"].as_str(),
                        t["tools"].as_str()
                    ],
                )?;
                if !project.is_empty() {
                    db.execute(
                        "INSERT INTO mcp_projects VALUES(?,?)",
                        [string(&v, "id"), project],
                    )?;
                }
                visible(&scoped(db, string(&v, "id"), project)?)
            }
            ["mcp", id] if get => {
                detail(db, id, data::param(&query, "agent").unwrap_or(""), project)?
            }
            ["mcp", id] => {
                let row = scoped(db, id, project)?;
                let tested = v.get("test").is_some();
                if !closed(
                    &v,
                    if tested {
                        &["id", "revision", "test"]
                    } else {
                        &["id", "revision", "enabled"]
                    },
                ) || !v["revision"].is_i64()
                    || !tested && !v["enabled"].is_boolean()
                {
                    return Err(error(400, "Invalid connection change."));
                }
                if row["revision"] != v["revision"] {
                    return Err(error(409, "Connection changed. Reload."));
                }
                if tested {
                    let t=one(db,"SELECT * FROM mcp_tests WHERE id=? AND connection=? AND revision=? AND expires>=?",params![v["test"].as_str(),id,row["revision"].as_i64(),state.config.now()])?.ok_or_else(||error(409,"Test result does not match or has expired. Test this connection again."))?;
                    db.execute("UPDATE mcp_connections SET name=?,token=?,tools=?,revision=revision+1 WHERE id=?",params![t["name"].as_str(),t["token"].as_str(),t["tools"].as_str(),id])?;
                    db.execute(
                        "UPDATE mcp_grants SET tools='[]',revision=revision+1 WHERE connection=?",
                        [id],
                    )?;
                } else {
                    db.execute(
                        "UPDATE mcp_connections SET enabled=?,revision=revision+1 WHERE id=?",
                        params![i64::from(v["enabled"] == true), id],
                    )?;
                }
                visible(&scoped(db, id, project)?)
            }
            ["mcp", id, "remove"] => {
                scoped(db, id, project)?;
                db.execute("DELETE FROM mcp_grants WHERE connection=?", [id])?;
                db.execute("DELETE FROM mcp_projects WHERE connection=?", [id])?;
                db.execute("DELETE FROM mcp_connections WHERE id=?", [id])?;
                json!({"deleted":true})
            }
            ["agents", agent, "mcp", id] => {
                if !closed(&v, &["id", "revision", "connectionRevision", "tools"]) {
                    return Err(error(400, "Unknown MCP field."));
                }
                let d = detail(db, id, agent, project)?;
                if d["grant"]["revision"] != v["revision"]
                    || d["revision"] != v["connectionRevision"]
                {
                    return Err(error(409, "Permissions or connection changed. Reload."));
                }
                let names = v["tools"]
                    .as_array()
                    .filter(|a| a.len() <= 64)
                    .ok_or_else(|| error(400, "Choose access from the tested catalog."))?;
                let mut seen = std::collections::HashSet::new();
                for name in names {
                    if !name.is_string()
                        || !seen.insert(name.to_string())
                        || !d["tools"]
                            .as_array()
                            .is_some_and(|a| a.iter().any(|t| t["name"] == *name))
                    {
                        return Err(error(400, "Choose access from the tested catalog."));
                    }
                }
                let revision = d["grant"]["revision"].as_i64().unwrap_or(0) + 1;
                db.execute("INSERT INTO mcp_grants VALUES(?,?,?,?) ON CONFLICT(agent,connection) DO UPDATE SET tools=excluded.tools,revision=excluded.revision",params![agent,id,revision,v["tools"].to_string()])?;
                json!({"revision":revision,"tools":v["tools"]})
            }
            _ => return Err(error(404, "Route not found.")),
        };
        if !get {
            data::save_receipt(db, "mcp_commands", string(&v, "id"), &request, &result)?;
        }
        Ok(result)
    })?;
    Ok(crate::json_response(200, value))
}
async fn test(state: &AppState, v: &Value, project: &str) -> Result<Value> {
    let mut input = v.clone();
    let target = {
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        if v["connection"].is_string() {
            let t = scoped(&guard.connection, string(v, "connection"), project)?;
            if t["revision"] != v["revision"] {
                return Err(error(409, "Connection changed. Reload before testing."));
            }
            input["url"] = t["url"].clone();
            if v.get("token").is_none() {
                input["token"] = json!(client::decrypt(
                    state,
                    string(&t, "token"),
                    string(&t, "url")
                )?);
            }
            Some(t)
        } else {
            None
        }
    };
    if !closed(
        v,
        if target.is_some() {
            &["id", "connection", "revision", "name", "token"]
        } else {
            &["id", "name", "url", "token"]
        },
    ) {
        return Err(error(400, "Unknown MCP field."));
    }
    let (name, url, token) = config(&input)?;
    let digest=registry::hash(&json!({"input":{"name":name,"url":url,"token":token},"project":project,"connection":v["connection"],"revision":v["revision"]}).to_string());
    {
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        if let Some(t) = one(
            &guard.connection,
            "SELECT * FROM mcp_tests WHERE id=?",
            [string(v, "id")],
        )? {
            if t["digest"] != digest {
                return Err(error(
                    409,
                    "Test ID was already used for a different connection.",
                ));
            }
            return Ok(
                json!({"id":t["id"],"name":t["name"],"url":t["url"],"tools":data::json(&t["tools"])?,"expires":t["expires"]}),
            );
        }
    }
    let mut session = client::Session::open(&url, &token).await?;
    let catalogue = session.catalogue(false).await;
    session.close().await;
    let tools = clean_tools(&catalogue?, &token)?;
    let expires = state.config.now() + 600000;
    let cipher = client::encrypt(state, &token, &url)?;
    let guard = state.database.lock().map_err(|_| Failure::storage())?;
    let db = &guard.connection;
    if let Some(t) = target {
        if scoped(db, string(&t, "id"), project)?["revision"] != t["revision"] {
            return Err(error(
                409,
                "Connection changed during the test. Reload and test again.",
            ));
        }
    }
    db.execute(
        "INSERT INTO mcp_tests VALUES(?,?,?,?,?,?,?,?,?)",
        params![
            string(v, "id"),
            digest,
            name,
            url,
            cipher,
            tools.to_string(),
            expires,
            v["connection"].as_str(),
            v["revision"].as_i64()
        ],
    )?;
    if !project.is_empty() {
        db.execute(
            "INSERT INTO mcp_test_projects VALUES(?,?)",
            [string(v, "id"), project],
        )?;
    }
    Ok(json!({"id":v["id"],"name":name,"url":url,"tools":tools,"expires":expires}))
}
