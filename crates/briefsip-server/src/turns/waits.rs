use super::*;
use ring::hmac;
use sha2::{Digest, Sha256};

pub fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS turn_waits(id TEXT PRIMARY KEY,turn TEXT NOT NULL REFERENCES turns(id),call_id TEXT NOT NULL,call TEXT NOT NULL,event TEXT NOT NULL,secret TEXT NOT NULL,deadline INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN('waiting','received','expired','closed')),delivery TEXT,digest TEXT,result TEXT,after_output INTEGER NOT NULL,after_action INTEGER NOT NULL,UNIQUE(turn,call_id)) STRICT; CREATE INDEX IF NOT EXISTS turn_waits_pending ON turn_waits(turn,status);")?;
    journal(db)
}
fn journal(db: &Connection) -> Result<()> {
    if !exists(db,"SELECT 1 FROM turn_waits w WHERE w.status IN('expired','closed') AND NOT EXISTS(SELECT 1 FROM flow_tool_calls f WHERE f.turn=w.turn AND f.call_id=w.call_id)",[])? { return Ok(()); }
    db.execute_batch("INSERT INTO flow_tool_calls(turn,call_id,call,result,after_output,after_action) SELECT w.turn,w.call_id,w.call,json_object('status',w.status,'error',CASE w.status WHEN 'expired' THEN 'Event wait expired without receiving an event.' ELSE 'Event wait closed by workspace restore; its connection is no longer valid.' END),w.after_output,w.after_action FROM turn_waits w WHERE w.status IN('expired','closed') AND NOT EXISTS(SELECT 1 FROM flow_tool_calls f WHERE f.turn=w.turn AND f.call_id=w.call_id) ORDER BY w.rowid;")?;
    Ok(())
}
pub fn expire(db: &Connection, now: i64) -> Result<()> {
    for wait in all(db,"SELECT w.id,w.turn FROM turn_waits w JOIN turns t ON t.id=w.turn WHERE w.status='waiting' AND w.deadline<=? AND t.status='queued'",[now])? {
        db.execute("UPDATE turn_waits SET status='expired' WHERE id=?",[string(&wait,"id")])?;
        db.execute("UPDATE turns SET status='failed',revision=revision+1,error='Event wait timed out.' WHERE id=?",[string(&wait,"turn")])?;
    }
    journal(db)
}
pub fn request(
    state: &AppState,
    db: &Connection,
    turn: &Value,
    call: &Value,
    args: &Value,
) -> Result<Value> {
    if !closed(args, &["event", "timeoutSeconds"])
        || !args["event"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 256)
        || !integer(&args["timeoutSeconds"], 1, 604800)
    {
        return Err(error(400, "Invalid event name or wait limit."));
    }
    let id = string(turn, "id");
    if db.query_row("SELECT count(*) FROM turn_waits WHERE turn=?", [id], |r| {
        r.get::<_, i64>(0)
    })? >= 8
        || exists(
            db,
            "SELECT 1 FROM turn_waits WHERE turn=? AND(status='waiting' OR call_id=?)",
            [id, string(call, "id")],
        )?
    {
        return Err(error(409, "Invalid wait limit or task event ID."));
    }
    let mut secret = [0u8; 32];
    getrandom::getrandom(&mut secret).map_err(|_| Failure::storage())?;
    db.execute("INSERT INTO turn_waits(id,turn,call_id,call,event,secret,deadline,status,after_output,after_action) VALUES(?,?,?,?,?,?,?,'waiting',(SELECT count(*) FROM generated_files WHERE turn=?),(SELECT count(*) FROM coordination WHERE turn=?))",params![uuid::Uuid::new_v4().to_string(),id,string(call,"id"),call.to_string(),string(args,"event"),hex(&secret),state.config.now()+args["timeoutSeconds"].as_i64().ok_or_else(Failure::storage)?*1000,id,id])?;
    db.execute(
        "UPDATE turns SET status='queued',revision=revision+1,error=NULL WHERE id=?",
        [id],
    )?;
    Ok(Value::Null)
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub(crate) fn event(
    body: &[u8],
    headers: &axum::http::HeaderMap,
    secret: &str,
    now: i64,
) -> Result<Value> {
    if ["x-briefsip-time", "x-briefsip-id", "x-briefsip-signature"]
        .iter()
        .any(|name| headers.get_all(*name).iter().count() != 1)
    {
        return Err(error(401, "Invalid webhook identity, time, or signature."));
    }
    let time = crate::text_header(headers, "x-briefsip-time").unwrap_or("");
    let id = crate::text_header(headers, "x-briefsip-id").unwrap_or("");
    let signature = crate::text_header(headers, "x-briefsip-signature").unwrap_or("");
    if time.is_empty()
        || time.len() > 12
        || !time.bytes().all(|b| b.is_ascii_digit())
        || id.is_empty()
        || id.len() > 200
        || !id.as_bytes()[0].is_ascii_alphanumeric()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
        || signature.len() != 64
        || !signature
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(error(401, "Invalid webhook identity, time, or signature."));
    }
    let provided = (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&signature[i..i + 2], 16).map_err(|_| Failure::storage()))
        .collect::<Result<Vec<_>>>()?;
    let mut signed = format!("{time}\n{id}\n").into_bytes();
    signed.extend_from_slice(body);
    hmac::verify(
        &hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes()),
        &signed,
        &provided,
    )
    .map_err(|_| error(401, "Webhook signature does not match."))?;
    if (now as f64 / 1000.0 - time.parse::<f64>().map_err(|_| Failure::storage())?).abs() > 300.0 {
        return Err(error(401, "Webhook timestamp has expired."));
    }
    let value: Value =
        serde_json::from_slice(body).map_err(|_| error(400, "Event must be valid UTF-8 JSON."))?;
    if !closed(&value, &["event", "eventTime", "payload"])
        || !value["event"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 256)
        || value
            .get("eventTime")
            .is_some_and(|v| !integer(v, 1, 253370764799999))
    {
        return Err(error(400, "Invalid webhook event content."));
    }
    Ok(
        json!({"id":id,"digest":hex(&Sha256::digest(body)),"event":value["event"],"eventTime":value.get("eventTime").cloned().unwrap_or(json!(now)),"payload":value.get("payload").cloned().unwrap_or(Value::Null)}),
    )
}
pub async fn local(state: &AppState, request: Request) -> Result<Response> {
    let id = request
        .uri()
        .path()
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_owned();
    if !uuid(&id) || request.uri().query().is_some() {
        return Err(error(400, "Invalid event request ID."));
    }
    if request.method() == Method::GET {
        if request.headers().contains_key("origin") && !data::origin(state, request.headers()) {
            return Err(error(403, "Origin is not allowed."));
        }
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        let mut wait=one(&guard.connection,"SELECT w.event,w.secret,w.deadline FROM turn_waits w JOIN turns t ON t.id=w.turn LEFT JOIN channels c ON c.id=t.channel LEFT JOIN threads th ON th.id=t.thread WHERE w.id=? AND w.status='waiting' AND t.status='queued' AND w.deadline>? AND coalesce(c.archived,0)=0 AND coalesce(th.archived,0)=0 AND coalesce(th.deleted,0)=0",params![id,state.config.now()])?.ok_or_else(||error(404,"Task is no longer waiting for an event."))?;
        wait["url"] = json!(format!("{}/api/turn-waits/{id}", state.origin));
        return Ok(crate::json_response(200, wait));
    }
    if request.method() != Method::POST {
        return Err(error(405, "Use POST for writes."));
    }
    if request.headers().contains_key("origin")
        || crate::text_header(request.headers(), "content-type")
            .unwrap_or("")
            .split(';')
            .next()
            != Some("application/json")
    {
        return Err(error(
            403,
            "Send signed events from the server integration.",
        ));
    }
    let headers = request.headers().clone();
    let body = axum::body::to_bytes(request.into_body(), 64 * 1024)
        .await
        .map_err(|_| error(413, "Request is too large."))?;
    let guard = state.database.lock().map_err(|_| Failure::storage())?;
    let db = &guard.connection;
    let result = transaction(db, || {
        let wait = one(db, "SELECT * FROM turn_waits WHERE id=?", [&id])?
            .ok_or_else(|| error(404, "Event request not found."))?;
        let event = event(&body, &headers, string(&wait, "secret"), state.config.now())?;
        if !wait["delivery"].is_null() {
            if wait["delivery"] != event["id"] || wait["digest"] != event["digest"] {
                return Err(error(409, "Request already received another event."));
            }
            return data::json(&wait["result"]);
        }
        let turn = one(
            db,
            "SELECT * FROM turns WHERE id=?",
            [string(&wait, "turn")],
        )?
        .ok_or_else(Failure::storage)?;
        if wait["status"] != "waiting"
            || turn["status"] != "queued"
            || wait["deadline"].as_i64().unwrap_or(0) <= state.config.now()
            || event["event"] != wait["event"]
        {
            return Err(error(409, "Task is not waiting for this event."));
        }
        if exists(
            db,
            "SELECT 1 FROM channels WHERE id=? AND archived=1",
            [turn["channel"].as_str().unwrap_or("")],
        )? || exists(
            db,
            "SELECT 1 FROM threads WHERE id=? AND(archived=1 OR deleted=1)",
            [turn["thread"].as_str().unwrap_or("")],
        )? {
            return Err(error(409, "Event conversation is inactive."));
        }
        let result = json!({"id":id,"turn":wait["turn"],"delivery":event["id"],"accepted":true});
        db.execute(
            "UPDATE turn_waits SET status='received',delivery=?,digest=?,result=? WHERE id=?",
            params![
                string(&event, "id"),
                string(&event, "digest"),
                result.to_string(),
                id
            ],
        )?;
        db.execute("INSERT INTO flow_tool_calls(turn,call_id,call,result,after_output,after_action) VALUES(?,?,?,?,?,?)",params![string(&wait,"turn"),string(&wait,"call_id"),string(&wait,"call"),json!({"event":event["event"],"eventTime":event["eventTime"],"payload":event["payload"]}).to_string(),wait["after_output"].as_i64(),wait["after_action"].as_i64()])?;
        db.execute(
            "UPDATE turns SET revision=revision+1 WHERE id=?",
            [string(&wait, "turn")],
        )?;
        Ok(result)
    })?;
    state.turns.wake.notify_one();
    Ok(crate::json_response(200, result))
}

#[cfg(test)]
mod tests {
    use super::*;
    const SECRET: &str = "synthetic-webhook-secret";
    const NOW: i64 = 1794320000000;
    const ID: &str = "event:123";

    fn signed_headers(body: &[u8], timestamp: i64, id: &str) -> Result<axum::http::HeaderMap> {
        let time = timestamp.to_string();
        let mut signed = format!("{time}\n{id}\n").into_bytes();
        signed.extend_from_slice(body);
        let signature = hex(hmac::sign(
            &hmac::Key::new(hmac::HMAC_SHA256, SECRET.as_bytes()),
            &signed,
        )
        .as_ref());
        let mut headers = axum::http::HeaderMap::new();
        for (name, value) in [
            ("x-briefsip-time", time.as_str()),
            ("x-briefsip-id", id),
            ("x-briefsip-signature", signature.as_str()),
        ] {
            headers.insert(name, value.parse().map_err(|_| Failure::storage())?);
        }
        Ok(headers)
    }

    #[test]
    fn signed_events_validate_identity_and_payload() -> Result<()> {
        let body = br#"{"event":"report.ready","payload":{"count":4}}"#;
        let headers = signed_headers(body, NOW / 1000, ID)?;
        let accepted = event(body, &headers, SECRET, NOW)?;
        assert_eq!(accepted["id"], ID);
        assert_eq!(accepted["eventTime"], NOW);
        assert_eq!(accepted["payload"], json!({"count":4}));
        for offset in [-300, 300] {
            let headers = signed_headers(body, NOW / 1000 + offset, ID)?;
            assert_eq!(
                event(body, &headers, SECRET, NOW)?["digest"],
                accepted["digest"]
            );
        }
        for offset in [-301, 301] {
            let headers = signed_headers(body, NOW / 1000 + offset, ID)?;
            assert_eq!(event(body, &headers, SECRET, NOW).unwrap_err().status, 401);
        }

        assert_eq!(
            event(body, &headers, "wrong-secret", NOW)
                .unwrap_err()
                .status,
            401
        );
        let mut changed = body.to_vec();
        changed.push(b' ');
        assert_eq!(
            event(&changed, &headers, SECRET, NOW).unwrap_err().status,
            401
        );
        let mut changed = headers.clone();
        changed.insert(
            "x-briefsip-id",
            axum::http::HeaderValue::from_static("different"),
        );
        assert_eq!(event(body, &changed, SECRET, NOW).unwrap_err().status, 401);
        let mut duplicated = headers;
        duplicated.append("x-briefsip-time", axum::http::HeaderValue::from_static("1"));
        assert_eq!(
            event(body, &duplicated, SECRET, NOW).unwrap_err().status,
            401
        );
        let invalid_id = signed_headers(body, NOW / 1000, "bad/id")?;
        assert_eq!(
            event(body, &invalid_id, SECRET, NOW).unwrap_err().status,
            401
        );

        for invalid in [
            &[0xff][..],
            b"{",
            b"[]",
            br#"{"event":""}"#,
            br#"{"event":"x","eventTime":0}"#,
            br#"{"event":"x","unexpected":1}"#,
            br#"{"event":"x","payload":1e999}"#,
        ] {
            let headers = signed_headers(invalid, NOW / 1000, ID)?;
            assert_eq!(
                event(invalid, &headers, SECRET, NOW).unwrap_err().status,
                400
            );
        }
        Ok(())
    }
}
