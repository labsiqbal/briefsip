static FAILURES: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, u32)>>,
> = std::sync::OnceLock::new();
use super::*;
use crate::mcp::validate::valid;
use crate::turns::{harness, messaging};
use axum::{extract::Request, http::Method, response::Response};
use serde_json::{json, Value};
static REQUESTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(16);

fn tools() -> Value {
    json!([
    {"name":"list_agents","description":"List available local agents.","inputSchema":{"type":"object","properties":{"after":{"type":"string","maxLength":400}},"additionalProperties":false}},
    {"name":"send_message","description":"Queue an isolated message.","inputSchema":{"type":"object","properties":{"requestId":{"type":"string"},"recipient":{"type":"string","minLength":1,"maxLength":400},"text":{"type":"string","minLength":1,"maxLength":16000,"pattern":"\\S"},"metadata":{"type":"object","properties":{"depth":{"type":"integer","minimum":0,"maximum":100}},"required":["depth"],"additionalProperties":false}},"required":["requestId","recipient","text"],"additionalProperties":false}},
    {"name":"get_message_status","description":"Read delivery status.","inputSchema":{"type":"object","properties":{"requestId":{"type":"string"}},"required":["requestId"],"additionalProperties":false}},
    {"name":"cancel_message","description":"Cancel delivery.","inputSchema":{"type":"object","properties":{"requestId":{"type":"string"}},"required":["requestId"],"additionalProperties":false}},
    {"name":"read_history","description":"Read bounded history.","inputSchema":{"type":"object","properties":{"before":{"type":"integer","minimum":1},"limit":{"type":"integer","minimum":1,"maximum":50}},"additionalProperties":false}}
    ])
}
fn allowed(row: &Value, scope: &str) -> bool {
    data::json(&row["scopes"])
        .ok()
        .and_then(|v| v.as_array().cloned())
        .is_some_and(|a| a.iter().any(|v| v == scope))
}
fn declarations(state: &AppState, caller: &Value) -> Result<Vec<Value>> {
    let mut setup = false;
    let mut specs = tools().as_array().cloned().unwrap_or_default();
    for t in &mut specs {
        t["scope"] = json!(match string(t, "name") {
            "list_agents" => "agents:read",
            "read_history" => "history:read",
            _ => "agents:message",
        });
    }
    if caller["kind"] == "session" && caller["turn"].is_string() {
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        let db = &guard.connection;
        let turn = one(
            db,
            "SELECT * FROM turns WHERE id=? AND status='running'",
            [caller["turn"].as_str()],
        )?
        .ok_or_else(|| error(403, "MCP authorization failed."))?;
        setup = harness::setup(db, &turn)?;
        for spec in harness::specs(state, db, &turn)? {
            let f = &spec["function"];
            let name = string(f, "name");
            if ["list_agents", "send_message", "read_history"].contains(&name) {
                continue;
            }
            let scope = if name.starts_with("computer_") {
                if name == "computer_screenshot" {
                    "computer:read"
                } else {
                    "computer:run"
                }
            } else {
                "orchestration"
            };
            specs.push(json!({"name":name,"description":f["description"],"inputSchema":f["parameters"],"scope":scope,"native":true}));
        }
    }
    let feature_names: Vec<String> =
        serde_json::from_str::<Vec<Value>>(include_str!("feature-tools.json"))
            .map_err(|_| Failure::storage())?
            .iter()
            .map(|t| string(t, "name").to_owned())
            .collect();
    specs.retain(|t| !feature_names.iter().any(|n| t["name"] == *n));
    specs.extend(
        serde_json::from_str::<Vec<Value>>(include_str!("feature-tools.json"))
            .map_err(|_| Failure::storage())?,
    );
    specs.retain(|t| {
        allowed(caller, string(t, "scope"))
            && (!setup || ["edit_profile", "ask_user"].contains(&string(t, "name")))
    });
    Ok(specs)
}
fn public_tools(specs: &[Value]) -> Vec<Value> {
    specs.iter().map(|s|json!({"name":s["name"],"description":s["description"],"inputSchema":s["inputSchema"]})).collect()
}
pub async fn rpc(state: &AppState, request: Request) -> Result<Response> {
    let bearer = crate::text_header(request.headers(), "authorization")
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("")
        .to_owned();
    let failures = FAILURES.get_or_init(Default::default);
    let throttled = {
        let mut map = failures.lock().map_err(|_| Failure::storage())?;
        map.retain(|_, v| v.0.elapsed() < std::time::Duration::from_secs(60));
        map.get(&state.origin).is_some_and(|v| v.1 >= 10)
    };
    if throttled {
        let mut response = crate::local_error(401, "MCP authorization failed.");
        response
            .headers_mut()
            .insert("retry-after", axum::http::HeaderValue::from_static("60"));
        return Ok(response);
    }
    let _caller = match registry::verify(state, &bearer) {
        Ok(v) => v,
        Err(e) => {
            let mut map = failures.lock().map_err(|_| Failure::storage())?;
            if map.len() >= 1024 {
                map.clear();
            }
            let v = map
                .entry(state.origin.clone())
                .or_insert((std::time::Instant::now(), 0));
            v.1 += 1;
            return Err(e);
        }
    };
    if request.method() != Method::POST {
        return Err(error(405, "Use POST for MCP requests."));
    }
    if crate::text_header(request.headers(), "content-type")
        .unwrap_or("")
        .split(';')
        .next()
        != Some("application/json")
    {
        return Err(error(415, "Use Content-Type application/json."));
    }
    let _permit = REQUESTS
        .try_acquire()
        .map_err(|_| error(429, "MCP request limit reached. Try again later."))?;
    let bytes = axum::body::to_bytes(request.into_body(), 64000)
        .await
        .map_err(|_| error(413, "MCP request exceeds 64 KB."))?;
    let caller = registry::verify(state, &bearer)?;
    let body: Value =
        serde_json::from_slice(&bytes).map_err(|_| error(400, "Invalid MCP request."))?;
    if body["jsonrpc"] != "2.0" || !body["method"].is_string() {
        return Err(error(400, "Invalid MCP request."));
    }
    let method = string(&body, "method");
    if method == "notifications/initialized" {
        return Ok(crate::json_response(202, Value::Null));
    }
    if method == "initialize" {
        return Ok(crate::json_response(
            200,
            json!({"jsonrpc":"2.0","id":body["id"],"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"briefsip","version":"0.1.0"}}}),
        ));
    }
    if method == "tools/list" {
        return Ok(crate::json_response(
            200,
            json!({"jsonrpc":"2.0","id":body["id"],"result":{"tools":public_tools(&declarations(state,&caller)?)}}),
        ));
    }
    if method != "tools/call" {
        return Ok(crate::json_response(
            200,
            if method == "ping" {
                json!({"jsonrpc":"2.0","id":body["id"],"result":{}})
            } else {
                json!({"jsonrpc":"2.0","id":body["id"],"error":{"code":-32601,"message":"Method not found"}})
            },
        ));
    }
    let params = &body["params"];
    let name = string(params, "name");
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let decl = declarations(state, &caller)?
        .into_iter()
        .find(|t| t["name"] == name)
        .ok_or_else(|| error(403, "MCP authorization failed."))?;
    if decl["scope"].is_string()
        && decl["native"] != true
        && ![
            "list_agents",
            "send_message",
            "read_history",
            "get_message_status",
            "cancel_message",
        ]
        .contains(&name)
    {
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        features::authorize(state, &guard.connection, &caller, name, &args)?;
    }
    if !valid(&decl["inputSchema"], &args) {
        return Err(error(400, "Invalid MCP tool call."));
    }
    if decl["native"] == true {
        let result = harness::tool(
            state,
            string(&caller, "turn"),
            name,
            &args,
            &uuid::Uuid::new_v4().to_string(),
        )
        .await;
        if let Err(e) = &result {
            if e.status == 403 {
                return Err(error(403, "MCP authorization failed."));
            }
        }
        let result = result.and_then(|v| {
            if v["error"].is_string() {
                Err(error(400, string(&v, "error")))
            } else {
                Ok(v)
            }
        });
        return Ok(reply(&body["id"], result));
    }
    if ![
        "list_agents",
        "send_message",
        "read_history",
        "get_message_status",
        "cancel_message",
    ]
    .contains(&name)
    {
        let result = features::run(state, &caller, name, &args).await;
        if result
            .as_ref()
            .is_err_and(|e| e.status == 403 && e.message == "MCP authorization failed.")
        {
            return Err(error(403, "MCP authorization failed."));
        }
        return Ok(reply(&body["id"], result));
    }
    let guard = state.database.lock().map_err(|_| Failure::storage())?;
    let db = &guard.connection;
    if name == "send_message" {
        if let Some(row) = one(
            db,
            "SELECT digest FROM mcp_server_messages WHERE caller=? AND request_id=?",
            [string(&caller, "id"), string(&args, "requestId")],
        )? {
            if row["digest"] != registry::hash(&send_digest(&args).to_string()) {
                return Err(error(409, "ID was already used for a different message."));
            }
        }
    }
    let result = (|| {
        let value = match name {
            "list_agents" => {
                let mut rows = messaging::roster(
                    db,
                    &json!({"id":caller["turn"],"agent":caller["agent"]}),
                    string(&args, "after"),
                )?;
                for row in &mut rows {
                    if !string(row, "id").contains('@') {
                        row["model"] = data::agents::read(db, string(row, "id"))?["model"].clone();
                    }
                }
                json!({"agents":rows.iter().take(10).collect::<Vec<_>>(),"next_after":if rows.len()>10 {rows[9]["id"].clone()}else{Value::Null}})
            }
            "read_history" => {
                if caller["kind"] == "peer" {
                    let limit = args["limit"].as_i64().unwrap_or(5);
                    let before = args["before"].as_i64().unwrap_or(i64::MAX);
                    let mut rows=all(db,"SELECT t.id,t.seq,t.agent,t.text,t.reply,t.status,t.created FROM mcp_server_messages m JOIN turns t ON t.id=m.turn WHERE m.caller=? AND t.seq<? ORDER BY t.seq DESC LIMIT ?",params![string(&caller,"id"),before,limit+1])?;
                    let next = if rows.len() > limit as usize {
                        rows.get(limit as usize - 1).map(|r| r["seq"].clone())
                    } else {
                        None
                    };
                    rows.truncate(limit as usize);
                    return Ok(json!({"messages":rows,"next_before":next}));
                }
                let turn = caller["turn"].as_str().unwrap_or("");
                let row = one(db, "SELECT * FROM turns WHERE id=?", [turn])?
                    .ok_or_else(|| error(403, "MCP authorization failed."))?;
                harness::history(db, &row, &args)?
            }
            "get_message_status" => {
                let row=one(db,"SELECT t.* FROM mcp_server_messages m JOIN turns t ON t.id=m.turn WHERE m.caller=? AND m.request_id=?",[caller["id"].as_str().unwrap_or(""),string(&args,"requestId")])?.ok_or_else(||error(404,"Message not found."))?;
                json!({"requestId":args["requestId"],"status":row["status"],"reply":row["reply"],"error":row["error"]})
            }
            "cancel_message" => {
                let row = one(
                    db,
                    "SELECT turn FROM mcp_server_messages WHERE caller=? AND request_id=?",
                    [
                        caller["id"].as_str().unwrap_or(""),
                        string(&args, "requestId"),
                    ],
                )?
                .ok_or_else(|| error(404, "Message not found."))?;
                crate::turns::messaging::cancel(
                    db,
                    &[string(&row, "turn").to_owned()],
                    "Cancelled by peer.",
                )?;
                json!({"requestId":args["requestId"],"status":"cancelled"})
            }
            "send_message" => send(state, db, &caller, &args)?,
            _ => json!({}),
        };
        Ok(value)
    })();
    Ok(reply(&body["id"], result))
}
fn reply(id: &Value, result: Result<Value>) -> Response {
    let value = match result {
        Ok(value) => {
            let content = value["content"]
                .as_array()
                .cloned()
                .unwrap_or_else(|| vec![json!({"type":"text","text":value.to_string()})]);
            json!({"content":content,"structuredContent":value})
        }

        Err(e) => {
            json!({"isError":true,"content":[{"type":"text","text":json!({"error":e.message,"status":e.status}).to_string()}]})
        }
    };
    crate::json_response(200, json!({"jsonrpc":"2.0","id":id,"result":value}))
}
fn send_digest(args: &Value) -> Value {
    let mut value = json!({"recipient":args["recipient"],"text":args["text"]});
    if let Some(metadata) = args.get("metadata") {
        value["metadata"] = metadata.clone();
    }
    value
}
fn send(state: &AppState, db: &Connection, caller: &Value, args: &Value) -> Result<Value> {
    let request_id = string(args, "requestId");
    if !uuid(request_id) {
        return Err(error(400, "Invalid message request ID."));
    }
    let digest = registry::hash(&send_digest(args).to_string());
    if caller["kind"] == "peer" {
        if !crate::computer::remote::messaging_allowed(db, string(caller, "id"))? {
            return Err(error(403, "Agent messaging is disabled for this peer."));
        }
        let depth = args["metadata"]["depth"].as_i64().unwrap_or(1);
        if depth > state.config.turns.limit("depth", 3) {
            return Err(error(409, "Remote delegation depth limit reached."));
        }
    }
    if let Some(row) = one(
        db,
        "SELECT * FROM mcp_server_messages WHERE caller=? AND request_id=?",
        [string(caller, "id"), request_id],
    )? {
        if row["digest"] != digest {
            return Err(error(409, "ID was already used for a different message."));
        }
        return data::json(&row["result"]);
    }
    let recipient = field(args, "recipient", 400)?;
    let text = field(args, "text", 16000)?;
    if caller["kind"] == "peer" {
        crate::computer::remote::enforce_peer_rate(
            db,
            string(caller, "id"),
            state.config.now(),
            &state.config.turns.agent_limits.clone().unwrap_or(json!({})),
        )?;
    }
    if caller["kind"] == "session" && caller["turn"].is_string() {
        return transaction(db, || {
            let delivery = harness::message(state, db, caller, args)?;
            let result = json!({"requestId":request_id,"turn":delivery["id"],"thread":delivery["thread"],"status":"queued"});
            db.execute(
                "INSERT INTO mcp_server_messages VALUES(?,?,?,?,?)",
                params![
                    string(caller, "id"),
                    request_id,
                    digest,
                    delivery["id"].as_str(),
                    result.to_string()
                ],
            )?;
            Ok(result)
        });
    }
    data::agents::read(db, &recipient)?;
    if data::agents::hidden(db, &recipient)? {
        return Err(error(
            409,
            "Recipient is unavailable or message is invalid.",
        ));
    }
    let thread = uuid::Uuid::new_v4().to_string();
    let turn = uuid::Uuid::new_v4().to_string();
    let sender = if caller["kind"] == "peer" {
        string(caller, "name").to_owned()
    } else {
        string(&data::agents::read(db, string(caller, "agent"))?, "name").to_owned()
    };
    let result = json!({"requestId":request_id,"thread":thread,"turn":turn,"status":"queued"});
    transaction(db, || {
        db.execute(
            "INSERT INTO threads(id,agent,name) VALUES(?,?,'Agent delivery')",
            [&thread, &recipient],
        )?;
        db.execute(
            "INSERT INTO delivery_conversations(thread,sender,machine,activity) VALUES(?,?,NULL,?)",
            params![thread, sender, state.config.now()],
        )?;
        db.execute("INSERT INTO turns(id,agent,thread,text,status,created,origin,message_depth) VALUES(?,?,?,?,'queued',?,?,?)",params![turn,recipient,thread,text,data::iso(db,state.config.now())?,format!("{}:{}",string(caller,"kind"),sender),args["metadata"]["depth"].as_i64().unwrap_or(1)])?;
        db.execute(
            "INSERT INTO mcp_server_messages VALUES(?,?,?,?,?)",
            params![
                string(caller, "id"),
                request_id,
                digest,
                turn,
                result.to_string()
            ],
        )?;
        Ok(result)
    })
}
