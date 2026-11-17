use super::{error, Result};
use crate::{
    files::{one, rows, text},
    web::Failure,
    AppState,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    time::Duration,
};

const SCOPES: [&str; 3] = ["agents:read", "agents:message", "history:read"];
fn hash(v: &Value) -> String {
    digest(v.to_string().as_bytes())
}
fn digest(v: &[u8]) -> String {
    format!("{:x}", Sha256::digest(v))
}
fn random<const N: usize>() -> Result<[u8; N]> {
    let mut v = [0; N];
    getrandom::getrandom(&mut v).map_err(|_| Failure::storage())?;
    Ok(v)
}
fn fields(v: &Value, keys: &[&str]) -> Result<()> {
    if !crate::files::keys(v, keys) {
        return Err(error(400, "Invalid machine request."));
    }
    Ok(())
}
fn field(v: &Value, max: usize) -> Result<String> {
    let s = v
        .as_str()
        .filter(|s| {
            !s.trim().is_empty()
                && s.encode_utf16().count() <= max
                && !s.chars().any(|c| c < ' ' || c == '\u{7f}')
        })
        .ok_or_else(|| error(400, "Invalid machine field."))?;
    Ok(s.trim().into())
}
fn request_id(v: &Value) -> Result<String> {
    v.as_str()
        .filter(|v| crate::web::id(v).is_some())
        .map(str::to_owned)
        .ok_or_else(|| error(400, "Invalid request ID."))
}
fn credential(v: &Value) -> Result<String> {
    v.as_str()
        .filter(|s| (16..=4096).contains(&s.len()) && token_syntax(s))
        .map(str::to_owned)
        .ok_or_else(|| error(400, "Invalid peer credential."))
}
fn token_syntax(s: &str) -> bool {
    !s.is_empty()
        && s.trim_end_matches('=')
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._~+/-".contains(&b))
}
fn invalid() -> Failure {
    error(400, "Pairing request is invalid or expired.")
}
fn code(v: &Value) -> Result<String> {
    let s = v.as_str().unwrap_or("").to_ascii_uppercase();
    if s.len() != 12
        || !s
            .bytes()
            .all(|b| b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ".contains(&b))
    {
        return Err(invalid());
    }
    Ok(s)
}
pub fn machine_origin(v: &str) -> Result<String> {
    if v.len() > 2048 || v.trim() != v {
        return Err(error(400, "Invalid machine origin."));
    }
    let u = url::Url::parse(v).map_err(|_| error(400, "Invalid machine origin."))?;
    if !(u.scheme() == "https"
        || u.scheme() == "http"
            && matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
        || !u.username().is_empty()
        || u.password().is_some()
        || u.path() != "/"
        || u.query().is_some()
        || u.fragment().is_some()
        || v.contains(['?', '#', '\\'])
        || u.origin().ascii_serialization() != v.strip_suffix('/').unwrap_or(v)
    {
        return Err(error(
            400,
            "Use an HTTPS origin without credentials, a path, query, or fragment.",
        ));
    }
    Ok(u.origin().ascii_serialization())
}
fn descriptor(v: &Value) -> Result<Value> {
    fields(v, &["id", "name", "version", "origin"])?;
    Ok(
        json!({"id":request_id(&v["id"])?,"name":field(&v["name"],120)?,"version":field(&v["version"],64)?,"origin":machine_origin(text(v,"origin"))?}),
    )
}
pub fn initialize(db: &Connection) -> crate::db::Result<()> {
    db.execute_batch(include_str!("machines.sql"))?;
    let name = fs::read_to_string("/proc/sys/kernel/hostname")
        .unwrap_or_else(|_| "Briefsip machine".into())
        .trim()
        .chars()
        .take(120)
        .collect::<String>();
    db.execute(
        "INSERT OR IGNORE INTO environment_identity VALUES(1,?,?)",
        params![uuid::Uuid::new_v4().to_string(), name],
    )?;
    Ok(())
}
fn with_db<T>(s: &AppState, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    let g = s.database.lock().map_err(|_| Failure::storage())?;
    f(&g.connection)
}
fn tx<T>(s: &AppState, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    with_db(s, |db| super::transaction(db, f))
}
fn row(s: &AppState, id: &str) -> Result<Value> {
    with_db(s, |db| {
        one(
            db,
            "SELECT * FROM paired_machines WHERE environment_id=?",
            [id],
        )
    })?
    .ok_or_else(|| error(404, "Paired machine not found."))
}
pub fn version() -> String {
    crate::updates::version()
}
pub fn environment(s: &AppState) -> Result<Value> {
    let mut v = with_db(s, |db| {
        one(
            db,
            "SELECT environment_id AS id,name FROM environment_identity WHERE singleton=1",
            [],
        )
    })?
    .ok_or_else(Failure::storage)?;
    v["version"] = version().into();
    v["origin"] = machine_origin(&s.origin)?.into();
    Ok(v)
}
fn visible(s: &AppState, r: &Value) -> Result<Value> {
    let cached: Value = serde_json::from_str(text(r, "agents")).map_err(|_| Failure::storage())?;
    let allowed = with_db(s, |db| {
        one(
            db,
            "SELECT allowed FROM machine_update_policy WHERE environment_id=?",
            [text(r, "environment_id")],
        )
    })?
    .is_some_and(|v| v["allowed"] == 1);
    let mut v = json!({"id":r["environment_id"],"environmentId":r["environment_id"],"name":r["name"],"origin":r["origin"],"status":r["status"],"version":r["version"],"lastSeen":r["last_seen"],"agentCount":cached.as_array().map_or(0,|a|a.len()),"agents":cached,"pairingState":r["state"],"allowAgentMessaging":r["allow_agent_messaging"]==1,"allowUpdates":allowed});
    if let Some(policy) = with_db(s, |db| {
        one(
            db,
            "SELECT allowed FROM computer_peer_messaging WHERE token_id=?",
            [text(r, "local_token_id")],
        )
    })? {
        v["remoteAgentMessaging"] = json!(policy["allowed"] == 1);
    }
    Ok(v)
}
pub fn list(s: &AppState) -> Result<Vec<Value>> {
    with_db(s, |db| {
        rows(
            db,
            "SELECT * FROM paired_machines ORDER BY name,environment_id",
            [],
        )
    })?
    .iter()
    .map(|r| visible(s, r))
    .collect()
}
fn key(s: &AppState, create: bool) -> Result<Vec<u8>> {
    let mut p = s.config.database.as_os_str().to_owned();
    p.push(".peer-key");
    let path = std::path::PathBuf::from(p);
    if create {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(mut f) => f
                .write_all(&random::<32>()?)
                .map_err(|_| Failure::storage())?,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(Failure::storage()),
        }
    }
    let mut f = OpenOptions::new()
        .read(true)
        .custom_flags(0o400000)
        .open(path)
        .map_err(|_| {
            error(
                409,
                "Machine key is unavailable. Unpair and pair this machine again.",
            )
        })?;
    let m = f.metadata().map_err(|_| Failure::storage())?;
    if !m.is_file() || m.permissions().mode() & 0o77 != 0 || m.len() != 32 {
        return Err(error(
            409,
            "Machine key is unavailable. Unpair and pair this machine again.",
        ));
    }
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes).map_err(|_| Failure::storage())?;
    Ok(bytes)
}
fn crypt(s: &AppState, value: &str, aad: &str, encrypt: bool) -> Result<String> {
    let bytes = key(s, encrypt)?;
    let key =
        LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &bytes).map_err(|_| Failure::storage())?);
    if encrypt {
        let iv = random::<12>()?;
        let mut data = value.as_bytes().to_vec();
        key.seal_in_place_append_tag(
            Nonce::assume_unique_for_key(iv),
            Aad::from(aad.as_bytes()),
            &mut data,
        )
        .map_err(|_| Failure::storage())?;
        Ok(STANDARD.encode([iv.as_slice(), &data].concat()))
    } else {
        let mut data = STANDARD.decode(value).map_err(|_| {
            error(
                409,
                "Machine key is unavailable. Unpair and pair this machine again.",
            )
        })?;
        if data.len() < 28 {
            return Err(error(
                409,
                "Machine key is unavailable. Unpair and pair this machine again.",
            ));
        }
        let iv: [u8; 12] = data[..12].try_into().map_err(|_| Failure::storage())?;
        let plain = key
            .open_in_place(
                Nonce::assume_unique_for_key(iv),
                Aad::from(aad.as_bytes()),
                &mut data[12..],
            )
            .map_err(|_| {
                error(
                    409,
                    "Machine key is unavailable. Unpair and pair this machine again.",
                )
            })?;
        String::from_utf8(plain.to_vec()).map_err(|_| Failure::storage())
    }
}
pub async fn bridge(s: &AppState, operation: &str, args: Value) -> Result<Value> {
    let b = s
        .config
        .computer
        .test_computer_bridge
        .as_ref()
        .ok_or_else(Failure::storage)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| Failure::storage())?;
    let value: Value = client
        .post(&b.origin)
        .bearer_auth(&b.token)
        .json(&json!({"operation":operation,"args":args}))
        .send()
        .await
        .map_err(|_| Failure::storage())?
        .json()
        .await
        .map_err(|_| Failure::storage())?;
    if let Some(e) = value.get("error") {
        return Err(error(
            e["status"].as_u64().unwrap_or(503) as u16,
            text(e, "message"),
        ));
    }
    Ok(value["value"].clone())
}
async fn now(s: &AppState) -> Result<i64> {
    if s.config.computer.test_computer_bridge.is_some() {
        let v = bridge(s, "clock", json!({})).await?;
        Ok(v.as_i64().unwrap_or_else(|| s.config.now()))
    } else {
        Ok(s.config.now())
    }
}
async fn issue(s: &AppState, name: &str) -> Result<Value> {
    if s.config.computer.test_computer_bridge.is_some() {
        let v = bridge(s, "issue", json!({"name":name,"scopes":SCOPES})).await?;
        if !v.is_null() {
            return Ok(v);
        }
    }
    let token = URL_SAFE_NO_PAD.encode(random::<32>()?);
    let id = uuid::Uuid::new_v4().to_string();
    let scopes = json!(["agents:message", "agents:read", "history:read"]).to_string();
    with_db(s, |db| {
        db.execute("INSERT INTO mcp_server_tokens(id,token_hash,kind,name,scopes,created,request_digest) VALUES(?,?,'peer',?,?,?,?)",params![id,digest(token.as_bytes()),name,scopes,s.config.now(),digest(json!({"name":name,"scopes":SCOPES}).to_string().as_bytes())])?;
        Ok(())
    })?;
    Ok(json!({"id":id,"token":token}))
}
async fn revoke(s: &AppState, id: &str) -> Result<()> {
    with_db(s, |db| {
        db.execute("INSERT OR IGNORE INTO peer_revocations VALUES(?)", [id])?;
        Ok(())
    })?;
    if s.config.computer.test_computer_bridge.is_some() {
        bridge(s, "revoke", json!({"id":id})).await?;
    }
    with_db(s, |db| {
        db.execute(
            "UPDATE mcp_server_tokens SET revoked=coalesce(revoked,?) WHERE id=?",
            params![s.config.now(), id],
        )?;
        db.execute("DELETE FROM peer_revocations WHERE token_id=?", [id])?;
        Ok(())
    })
}
async fn authorize(s: &AppState, header: Option<&str>) -> Result<Value> {
    let token = header
        .and_then(|h| h.strip_prefix("Bearer "))
        .filter(|s| s.len() <= 4096 && token_syntax(s))
        .ok_or_else(|| error(401, "Unauthorized peer request."))?;
    let mut auth = if s.config.computer.test_computer_bridge.is_some() {
        bridge(s, "verify", json!({"token":token}))
            .await
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    if auth.is_null() {
        auth=with_db(s,|db|one(db,"SELECT id,scopes FROM mcp_server_tokens WHERE token_hash=? AND revoked IS NULL AND (expires IS NULL OR expires>?)",params![digest(token.as_bytes()),s.config.now()]))?.unwrap_or(Value::Null);
        if let Some(raw) = auth["scopes"].as_str() {
            auth["scopes"] = serde_json::from_str(raw).unwrap_or(Value::Null);
        }
    }
    if !auth["scopes"]
        .as_array()
        .is_some_and(|v| v.contains(&json!("agents:read")))
        || with_db(s, |db| {
            one(
                db,
                "SELECT 1 FROM peer_revocations WHERE token_id=?",
                [text(&auth, "id")],
            )
        })?
        .is_some()
    {
        return Err(error(401, "Unauthorized peer request."));
    }
    auth["token"] = token.into();
    Ok(auth)
}
fn no_secrets(value: &Value, tokens: &[&str]) -> Result<()> {
    let raw = value.to_string();
    if tokens.iter().any(|t| !t.is_empty() && raw.contains(t)) {
        return Err(error(
            502,
            "Remote response conflicts with peer credentials.",
        ));
    }
    Ok(())
}
async fn remote(
    origin: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&Value>,
) -> Result<Value> {
    let operation = async {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(if path == "/api/peer/updates/apply" {
                120
            } else {
                10
            }))
            .build()
            .map_err(|_| Failure::storage())?;
        let mut req = if let Some(body) = body {
            client.post(format!("{origin}{path}")).json(body)
        } else {
            client.get(format!("{origin}{path}"))
        };
        if let Some(token) = token {
            req = req.bearer_auth(token);
        }
        if path == "/api/peer/agents" {
            req = req.header("X-Briefsip-Messaging-Policy", "1");
        }
        let mut response = req.send().await.map_err(|_| {
            error(
                502,
                "Remote machine is unavailable or exceeded its time, size, or JSON limits.",
            )
        })?;
        if !response.status().is_success() {
            return Err(error(
                if [401, 403].contains(&response.status().as_u16()) {
                    401
                } else {
                    502
                },
                "Remote machine rejected the request.",
            ));
        }
        if response.url().origin().ascii_serialization() != origin
            || response.content_length().is_some_and(|n| n > 128 * 1024)
            || !response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.starts_with("application/json"))
        {
            return Err(error(
                502,
                "Remote machine is unavailable or exceeded its time, size, or JSON limits.",
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| Failure::storage())? {
            if bytes.len() + chunk.len() > 128 * 1024 {
                return Err(error(
                    502,
                    "Remote machine is unavailable or exceeded its time, size, or JSON limits.",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| {
            error(
                502,
                "Remote machine is unavailable or exceeded its time, size, or JSON limits.",
            )
        })
    };
    tokio::time::timeout(
        Duration::from_secs(if path == "/api/peer/updates/apply" {
            120
        } else {
            10
        }),
        operation,
    )
    .await
    .map_err(|_| {
        error(
            502,
            "Remote machine is unavailable or exceeded its time, size, or JSON limits.",
        )
    })?
}
fn agents(value: &Value) -> Result<Value> {
    fields(value, &["agents", "messagingAllowed"])?;
    if value
        .get("messagingAllowed")
        .is_some_and(|v| !v.is_boolean())
    {
        return Err(error(502, "Invalid remote messaging policy."));
    }
    let list = value["agents"]
        .as_array()
        .filter(|v| v.len() <= 500)
        .ok_or_else(|| error(502, "Invalid remote agent list."))?;
    let mut result = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for a in list {
        fields(a, &["id", "name", "role", "model", "status"])?;
        let id = request_id(&a["id"])?;
        if !ids.insert(id.clone()) {
            return Err(error(502, "Invalid remote agent list."));
        }
        result.push(json!({"id":id,"name":field(&a["name"],200)?,"role":text(a,"role").chars().filter(|c|!c.is_control() && *c!='\u{2028}'&&*c!='\u{2029}').collect::<String>().trim().chars().take(60).collect::<String>(),"model":a["model"].as_str().filter(|s|s.len()<=200).unwrap_or(""),"status":field(&a["status"],32)?}));
    }
    Ok(json!(result))
}
fn prior(s: &AppState, id: &str, fingerprint: &str) -> Result<Option<Value>> {
    let v = with_db(s, |db| {
        one(db, "SELECT * FROM machine_commands WHERE id=?", [id])
    })?;
    if let Some(v) = &v {
        if v["request"] != fingerprint {
            return Err(error(409, "Request ID was already used."));
        }
    }
    Ok(v)
}
fn receipt(
    s: &AppState,
    id: &str,
    digest: &str,
    machine: Option<&str>,
    result: &Value,
) -> Result<()> {
    with_db(s, |db| {
        db.execute(
            "INSERT INTO machine_commands VALUES(?,?,?,?)",
            params![id, digest, machine, result.to_string()],
        )?;
        Ok(())
    })
}
async fn confirm(s: &AppState, r: &Value) -> Result<Value> {
    if r["state"] == "paired" {
        return visible(s, r);
    }
    let origin = text(r, "origin");
    let token = crypt(s, text(r, "token"), origin, false)?;
    let back = crypt(
        s,
        text(r, "return_token"),
        &format!("{origin}:return"),
        false,
    )?;
    remote(
        origin,
        "/api/machines/reciprocal",
        Some(&token),
        Some(&json!({"environment":environment(s)?,"token":back})),
    )
    .await?;
    with_db(s, |db| {
        db.execute(
            "UPDATE paired_machines SET state='paired' WHERE environment_id=? AND local_token_id=?",
            params![r["environment_id"].as_str(), r["local_token_id"].as_str()],
        )?;
        Ok(())
    })?;
    visible(s, &row(s, text(r, "environment_id"))?)
}
async fn add(s: &AppState, v: &Value) -> Result<Value> {
    fields(v, &["id", "origin", "code"])?;
    let id = request_id(&v["id"])?;
    let origin = machine_origin(text(v, "origin"))?;
    let code = code(&v["code"]).map_err(|_| error(400, "Enter the 12-character pairing code."))?;
    let fingerprint = hash(&json!({"origin":origin,"code":code}));
    if let Some(prior) = prior(s, &id, &fingerprint)? {
        let r = row(s, text(&prior, "environment_id")).map_err(|_| {
            error(
                409,
                "Pairing result is uncertain. Check both machines, then create a new code.",
            )
        })?;
        return confirm(s, &r).await;
    }
    if environment(s)?["origin"] == origin
        || with_db(s, |db| {
            one(
                db,
                "SELECT 1 FROM paired_machines WHERE origin=?",
                [&origin],
            )
        })?
        .is_some()
    {
        return Err(error(409, "Machine is already paired or is this machine."));
    }
    receipt(s, &id, &fingerprint, None, &Value::Null)?;
    let response = remote(
        &origin,
        "/api/pairing/redeem",
        None,
        Some(&json!({"code":code,"returnPairing":environment(s)?})),
    )
    .await?;
    fields(&response, &["environment", "token"])?;
    let peer = descriptor(&response["environment"])?;
    let token = credential(&response["token"])?;
    if peer["id"] == environment(s)?["id"] || peer["origin"] != origin {
        return Err(error(
            502,
            "Remote machine identity does not match its origin.",
        ));
    }
    no_secrets(&peer, &[&token])?;
    if row(s, text(&peer, "id")).is_ok() {
        return Err(error(409, "This environment is already paired."));
    }
    let issued = issue(s, &format!("Briefsip: {}", text(&peer, "name"))).await?;
    let result = (|| {
        let back = credential(&issued["token"])?;
        no_secrets(&peer, &[&back])?;
        let enc = crypt(s, &token, &origin, true)?;
        let enc_back = crypt(s, &back, &format!("{origin}:return"), true)?;
        tx(s, |db| {
            db.execute(
                "INSERT INTO paired_machines VALUES(?,?,?,?,?,?,'pending','offline',?,NULL,'[]',1)",
                params![
                    text(&peer, "id"),
                    text(&peer, "name"),
                    origin,
                    enc,
                    text(&issued, "id"),
                    enc_back,
                    text(&peer, "version")
                ],
            )?;
            db.execute(
                "UPDATE machine_commands SET environment_id=? WHERE id=?",
                params![text(&peer, "id"), id],
            )?;
            Ok(())
        })
    })();
    if result.is_err() {
        let _ = revoke(s, text(&issued, "id")).await;
        let _ = remote(&origin, "/api/peer/unpair", Some(&token), Some(&json!({}))).await;
        return Err(error(
            503,
            "Pairing could not be saved. Create a new code and try again.",
        ));
    }
    confirm(s, &row(s, text(&peer, "id"))?).await.map_err(|_| {
        error(
            409,
            "Return pairing is not confirmed. Retry the same request or unpair this machine.",
        )
    })?;
    check_machine(s, &row(s, text(&peer, "id"))?).await?;
    visible(s, &row(s, text(&peer, "id"))?)
}
async fn redeem(s: &AppState, v: &Value) -> Result<Value> {
    let (peer, code) = (|| {
        fields(v, &["code", "returnPairing"])?;
        let c = code(&v["code"])?;
        let p = descriptor(&v["returnPairing"])?;
        if p["id"] == environment(s)?["id"] || p["origin"] == s.origin {
            return Err(invalid());
        }
        Ok((p, c))
    })()
    .map_err(|_| invalid())?;
    let now = now(s).await?;
    tx(s, |db| {
        let changed = db.execute(
            "UPDATE pairing_codes SET used=1 WHERE digest=? AND expires>? AND used=0",
            params![hash(&json!(code)), now],
        )?;
        if changed!=1 || one(db,"SELECT 1 FROM paired_machines WHERE environment_id=? UNION ALL SELECT 1 FROM peer_pairing_pending WHERE environment_id=?",params![text(&peer,"id"),text(&peer,"id")])?.is_some(){return Err(invalid());}
        Ok(())
    })?;
    let issued = issue(s, &format!("Briefsip: {}", text(&peer, "name")))
        .await
        .map_err(|_| {
            error(
                503,
                "Peer token service is unavailable. Create a new code and try again.",
            )
        })?;
    with_db(s, |db| {
        db.execute(
            "INSERT INTO peer_pairing_pending VALUES(?,?,?,?,?,?)",
            params![
                text(&issued, "id"),
                text(&peer, "id"),
                text(&peer, "name"),
                text(&peer, "origin"),
                text(&peer, "version"),
                now + 600000
            ],
        )?;
        Ok(())
    })?;
    Ok(json!({"environment":environment(s)?,"token":issued["token"]}))
}
async fn reciprocal(s: &AppState, v: &Value, header: Option<&str>) -> Result<Value> {
    let auth = authorize(s, header).await?;
    fields(v, &["environment", "token"])?;
    let peer = descriptor(&v["environment"])?;
    let token = credential(&v["token"])?;
    let origin = text(&peer, "origin");
    let pending = with_db(s, |db| {
        one(
            db,
            "SELECT * FROM peer_pairing_pending WHERE token_id=? AND expires>?",
            params![text(&auth, "id"), s.config.now()],
        )
    })?;
    let Some(pending) = pending else {
        if let Ok(r) = row(s, text(&peer, "id")) {
            if r["local_token_id"] == auth["id"]
                && r["origin"] == peer["origin"]
                && crypt(s, text(&r, "token"), origin, false)? == token
            {
                return Ok(json!({"ok":true}));
            }
        }
        return Err(error(401, "Unauthorized peer request."));
    };
    if pending["environment_id"] != peer["id"] || pending["origin"] != peer["origin"] {
        return Err(error(401, "Unauthorized peer request."));
    }
    let check = descriptor(&remote(origin, "/api/environment", None, None).await?)?;
    if check["id"] != peer["id"] || check["origin"] != peer["origin"] {
        return Err(error(401, "Remote machine identity changed."));
    }
    let cached = agents(&remote(origin, "/api/peer/agents", Some(&token), None).await?)?;
    no_secrets(
        &json!({"peer":peer,"cached":cached}),
        &[&token, text(&auth, "token")],
    )?;
    let enc = crypt(s, &token, origin, true)?;
    let back = crypt(s, text(&auth, "token"), &format!("{origin}:return"), true)?;
    tx(s, |db| {
        if one(
            db,
            "SELECT 1 FROM peer_pairing_pending WHERE token_id=? AND expires>?",
            params![text(&auth, "id"), s.config.now()],
        )?
        .is_none()
        {
            return Err(error(401, "Unauthorized peer request."));
        }
        db.execute(
            "INSERT INTO paired_machines VALUES(?,?,?,?,?,?,'paired','online',?,?,?,1)",
            params![
                text(&peer, "id"),
                text(&peer, "name"),
                origin,
                enc,
                text(&auth, "id"),
                back,
                text(&peer, "version"),
                s.config.now(),
                cached.to_string()
            ],
        )?;
        db.execute(
            "DELETE FROM peer_pairing_pending WHERE token_id=?",
            [text(&auth, "id")],
        )?;
        Ok(json!({"ok":true}))
    })
}
async fn peer_agents(s: &AppState, header: Option<&str>, policy: bool) -> Result<Value> {
    let auth = authorize(s, header).await?;
    if with_db(s,|db|one(db,"SELECT 1 FROM paired_machines WHERE local_token_id=? UNION ALL SELECT 1 FROM peer_pairing_pending WHERE token_id=? AND expires>?",params![text(&auth,"id"),text(&auth,"id"),s.config.now()]))?.is_none(){return Err(error(401,"Unauthorized peer request."));}
    let roster = with_db(s, |db| {
        rows(db,"SELECT id,name,role,model,CASE WHEN EXISTS(SELECT 1 FROM turns t WHERE t.agent=agents.id AND t.status IN('queued','running') AND t.paused=0) THEN 'working' ELSE 'idle' END AS status FROM agents ORDER BY rowid",[])
    })?;
    let mut result = json!({"agents":roster});
    if policy {
        let allowed = with_db(s, |db| {
            one(
                db,
                "SELECT allow_agent_messaging FROM paired_machines WHERE local_token_id=?",
                [text(&auth, "id")],
            )
        })?
        .is_none_or(|r| r["allow_agent_messaging"] != 0);
        result["messagingAllowed"] = json!(
            allowed
                && auth["scopes"]
                    .as_array()
                    .is_some_and(|a| a.contains(&json!("agents:message")))
        );
    }
    no_secrets(&result, &[text(&auth, "token")])?;
    Ok(result)
}
pub fn set_updates(s: &AppState, v: &Value) -> Result<Value> {
    fields(v, &["id", "environmentId", "allowed"])?;
    let id = request_id(&v["id"])?;
    let machine = request_id(&v["environmentId"])?;
    let allowed = v["allowed"]
        .as_bool()
        .ok_or_else(|| error(400, "Update setting is invalid."))?;
    let fingerprint = hash(&json!({"updatePolicy":machine,"allowed":allowed}));
    if let Some(old) = prior(s, &id, &fingerprint)? {
        return serde_json::from_str(text(&old, "result")).map_err(|_| Failure::storage());
    }
    let r = row(s, &machine)?;
    if r["state"] != "paired" {
        return Err(error(404, "Paired machine not found."));
    }
    tx(s, |db| {
        let token = one(
            db,
            "SELECT scopes FROM mcp_server_tokens WHERE id=? AND kind='peer' AND revoked IS NULL",
            [text(&r, "local_token_id")],
        )?
        .ok_or_else(|| error(409, "Pair this machine again before enabling updates."))?;
        let mut scopes: Vec<String> =
            serde_json::from_str(text(&token, "scopes")).map_err(|_| Failure::storage())?;
        scopes.retain(|v| v != "machine:update");
        if allowed {
            scopes.push("machine:update".into());
        }
        scopes.sort();
        db.execute(
            "UPDATE mcp_server_tokens SET scopes=? WHERE id=?",
            params![json!(scopes).to_string(), text(&r, "local_token_id")],
        )?;
        db.execute("INSERT INTO machine_update_policy VALUES(?,?) ON CONFLICT(environment_id) DO UPDATE SET allowed=excluded.allowed",params![machine,allowed as i64])?;
        Ok(())
    })?;
    let value = visible(s, &r)?;
    receipt(s, &id, &fingerprint, Some(&machine), &value)?;
    Ok(value)
}
pub async fn authorize_update(s: &AppState, header: Option<&str>) -> Result<String> {
    let auth = authorize(s, header).await?;
    let r = with_db(s, |db| {
        one(
            db,
            "SELECT * FROM paired_machines WHERE local_token_id=? AND state='paired'",
            [text(&auth, "id")],
        )
    })?;
    if let Some(r) = r {
        if auth["scopes"]
            .as_array()
            .is_some_and(|a| a.contains(&json!("machine:update")))
            && visible(s, &r)?["allowUpdates"] == true
        {
            return Ok(text(&r, "environment_id").into());
        }
    }
    Err(error(
        403,
        "Machine updates require permission from both owners in Settings > Machines.",
    ))
}
fn update_peer(s: &AppState, machine: &str) -> Result<Value> {
    let r = row(s, machine)?;
    if r["state"] != "paired"
        || visible(s, &r)?["allowUpdates"] != true
        || !matches!(text(&r, "status"), "online" | "version-mismatch")
    {
        return Err(error(
            403,
            "Machine must be online and updates must be enabled by both owners.",
        ));
    }
    Ok(r)
}
pub async fn update_remote(
    s: &AppState,
    machine: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value> {
    let r = update_peer(s, machine)?;
    let origin = text(&r, "origin");
    let peer = descriptor(&remote(origin, "/api/environment", None, None).await?)?;
    if peer["id"] != r["environment_id"] || peer["origin"] != r["origin"] {
        return Err(error(401, "Remote machine identity changed."));
    }
    let token = crypt(s, text(&r, "token"), origin, false)?;
    let value = remote(origin, path, Some(&token), body).await?;
    no_secrets(
        &value,
        &[
            &token,
            &crypt(
                s,
                text(&r, "return_token"),
                &format!("{origin}:return"),
                false,
            )?,
        ],
    )?;
    Ok(value)
}
pub async fn download_release(
    s: &AppState,
    machine: &str,
    path: &str,
) -> Result<reqwest::Response> {
    let r = update_peer(s, machine)?;
    if !path
        .strip_prefix("/api/updates/releases/")
        .is_some_and(|v| {
            !v.is_empty()
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
        })
    {
        return Err(error(400, "Invalid release path."));
    }
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| Failure::storage())?
        .get(format!("{}{path}", text(&r, "origin")))
        .bearer_auth(crypt(s, text(&r, "token"), text(&r, "origin"), false)?)
        .send()
        .await
        .map_err(|_| {
            error(
                502,
                "Peer release download failed integrity, permission, time or size checks.",
            )
        })
}
async fn check_machine(s: &AppState, r: &Value) -> Result<()> {
    let result=async{let origin=text(r,"origin");let peer=descriptor(&remote(origin,"/api/environment",None,None).await?)?;if peer["id"]!=r["environment_id"] || peer["origin"]!=r["origin"]{return Err(error(401,"Remote machine identity changed."));}let token=crypt(s,text(r,"token"),origin,false)?;let roster=remote(origin,"/api/peer/agents",Some(&token),None).await?;let cached=agents(&roster)?;no_secrets(&json!({"peer":peer,"cached":cached}),&[&token,&crypt(s,text(r,"return_token"),&format!("{origin}:return"),false)?])?;
        with_db(s,|db|{db.execute("UPDATE paired_machines SET name=?,version=?,last_seen=?,agents=? WHERE environment_id=? AND local_token_id=?",params![text(&peer,"name"),text(&peer,"version"),s.config.now(),cached.to_string(),text(r,"environment_id"),text(r,"local_token_id")])?;if let Some(allowed)=roster["messagingAllowed"].as_bool(){db.execute("INSERT INTO computer_peer_messaging VALUES(?,?) ON CONFLICT(token_id) DO UPDATE SET allowed=excluded.allowed",params![text(r,"local_token_id"),allowed as i64])?;}else{db.execute("DELETE FROM computer_peer_messaging WHERE token_id=?",[text(r,"local_token_id")])?;}Ok(())})?;Ok::<_,Failure>(())}.await;
    let status = match result {
        Ok(()) => "online",
        Err(e) if [401, 409].contains(&e.status) => "unauthorized",
        _ => "offline",
    };
    with_db(s, |db| {
        db.execute(
            "UPDATE paired_machines SET status=? WHERE environment_id=? AND local_token_id=?",
            params![status, text(r, "environment_id"), text(r, "local_token_id")],
        )?;
        Ok(())
    })
}
pub async fn health(s: &AppState) -> Result<()> {
    let now = now(s).await?;
    let expired = with_db(s, |db| {
        rows(
            db,
            "SELECT token_id FROM peer_pairing_pending WHERE expires<=?",
            [now],
        )
    })?;
    for r in expired {
        with_db(s, |db| {
            db.execute(
                "DELETE FROM peer_pairing_pending WHERE token_id=?",
                [text(&r, "token_id")],
            )?;
            Ok(())
        })?;
        let _ = revoke(s, text(&r, "token_id")).await;
    }
    let revoked = with_db(s, |db| {
        rows(db, "SELECT token_id FROM peer_revocations", [])
    })?;
    for r in revoked {
        let _ = revoke(s, text(&r, "token_id")).await;
    }
    for r in with_db(s, |db| {
        rows(db, "SELECT * FROM paired_machines WHERE state='paired'", [])
    })? {
        check_machine(s, &r).await?;
    }
    Ok(())
}
async fn unpair(s: &AppState, v: &Value) -> Result<Value> {
    fields(v, &["id", "environmentId"])?;
    let id = request_id(&v["id"])?;
    let machine = request_id(&v["environmentId"])?;
    let fp = hash(&json!({"unpair":machine}));
    if prior(s, &id, &fp)?.is_some() {
        return Ok(json!({"ok":true}));
    }
    let r = row(s, &machine).ok();
    tx(s, |db| {
        db.execute(
            "DELETE FROM paired_machines WHERE environment_id=?",
            [&machine],
        )?;
        db.execute(
            "DELETE FROM machine_update_policy WHERE environment_id=?",
            [&machine],
        )?;
        if let Some(r) = &r {
            db.execute(
                "INSERT OR IGNORE INTO peer_revocations VALUES(?)",
                [text(r, "local_token_id")],
            )?;
        }
        db.execute(
            "INSERT INTO machine_commands VALUES(?,?,NULL,'{\"ok\":true}')",
            params![id, fp],
        )?;
        Ok(())
    })?;
    if let Some(r) = r {
        let _ = revoke(s, text(&r, "local_token_id")).await;
        if let Ok(token) = crypt(s, text(&r, "token"), text(&r, "origin"), false) {
            let _ = remote(
                text(&r, "origin"),
                "/api/peer/unpair",
                Some(&token),
                Some(&json!({})),
            )
            .await;
        }
    }
    Ok(json!({"ok":true}))
}
async fn unpair_remote(s: &AppState, v: &Value, header: Option<&str>) -> Result<Value> {
    fields(v, &[])?;
    let auth = authorize(s, header).await?;
    let id = text(&auth, "id");
    let r=with_db(s,|db|one(db,"SELECT environment_id FROM paired_machines WHERE local_token_id=? UNION ALL SELECT environment_id FROM peer_pairing_pending WHERE token_id=?",params![id,id]))?.ok_or_else(||error(401,"Unauthorized peer request."))?;
    tx(s, |db| {
        db.execute(
            "DELETE FROM paired_machines WHERE environment_id=?",
            [text(&r, "environment_id")],
        )?;
        db.execute("DELETE FROM peer_pairing_pending WHERE token_id=?", [id])?;
        db.execute(
            "DELETE FROM machine_update_policy WHERE environment_id=?",
            [text(&r, "environment_id")],
        )?;
        db.execute("INSERT OR IGNORE INTO peer_revocations VALUES(?)", [id])?;
        Ok(())
    })?;
    let _ = revoke(s, id).await;
    Ok(json!({"ok":true}))
}

pub async fn handle(
    s: &AppState,
    request: axum::extract::Request,
) -> Result<axum::response::Response> {
    use axum::http::Method;
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    let auth = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    if request.uri().query().is_some() {
        return Err(error(400, "Machine routes do not accept query parameters."));
    }
    if method == Method::GET {
        let value = match path.as_str() {
            "/api/environment" => environment(s)?,
            "/api/machines" => {
                if s.config
                    .computer
                    .test_computer_bridge
                    .as_ref()
                    .is_some_and(|b| {
                        request
                            .headers()
                            .get("x-briefsip-test-refresh")
                            .and_then(|v| v.to_str().ok())
                            == Some(b.token.as_str())
                    })
                {
                    health(s).await?;
                }
                json!({"machines":list(s)?})
            }
            "/api/peer/agents" => {
                peer_agents(
                    s,
                    auth.as_deref(),
                    request
                        .headers()
                        .get("x-briefsip-messaging-policy")
                        .and_then(|v| v.to_str().ok())
                        == Some("1"),
                )
                .await?
            }
            "/api/mcp-server/peer-tokens" => with_db(s, |db| {
                Ok(
                    json!({"items":rows(db,"SELECT id,name,scopes,created,last_used AS lastUsed,revoked FROM mcp_server_tokens WHERE kind='peer' ORDER BY created DESC,id",[])?.into_iter().map(|mut r|{r["scopes"]=serde_json::from_str(text(&r,"scopes")).unwrap_or(Value::Null);r}).collect::<Vec<_>>()}),
                )
            })?,
            _ => return Err(error(405, "Method not allowed.")),
        };
        return Ok(crate::json_response(200, value));
    }
    if method != Method::POST {
        return Err(error(405, "Method not allowed."));
    }
    let transport = [
        "/api/pairing/redeem",
        "/api/machines/reciprocal",
        "/api/peer/unpair",
    ]
    .contains(&path.as_str());
    if path == "/api/pairing/redeem" {
        let now = now(s).await?;
        tx(s, |db| {
            let bucket = now / 60000;
            db.execute(
                "DELETE FROM pairing_rate_limit WHERE bucket<?",
                [bucket - 1],
            )?;
            let count: i64 = db.query_row(
                "SELECT coalesce(sum(attempts),0) FROM pairing_rate_limit",
                [],
                |r| r.get(0),
            )?;
            if count >= 12 {
                return Err(error(
                    429,
                    "Too many pairing attempts. Try again in two minutes.",
                ));
            }
            db.execute("INSERT INTO pairing_rate_limit VALUES(?,1) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1",[bucket])?;
            Ok(())
        })?;
    }
    if transport {
        if request.headers().contains_key("origin")
            || request.headers().contains_key("sec-fetch-site")
            || request
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .split(';')
                .next()
                != Some("application/json")
        {
            return Err(invalid());
        }
    } else {
        crate::files::mutation(s, &request)?;
    }
    let value = super::body(request, 8192)
        .await
        .map_err(|e| if transport { invalid() } else { e })?;
    let result = match path.as_str() {
        "/api/environment" => {
            fields(&value, &["id", "name"])?;
            let id = request_id(&value["id"])?;
            let name = field(&value["name"], 120)?;
            let fp = hash(&json!({"name":name}));
            if let Some(old) = prior(s, &id, &fp)? {
                serde_json::from_str(text(&old, "result")).map_err(|_| Failure::storage())?
            } else {
                with_db(s, |db| {
                    db.execute(
                        "UPDATE environment_identity SET name=? WHERE singleton=1",
                        [name],
                    )?;
                    Ok(())
                })?;
                let v = environment(s)?;
                receipt(s, &id, &fp, None, &v)?;
                v
            }
        }
        "/api/pairing-codes" => {
            fields(&value, &["id"])?;
            let id = request_id(&value["id"])?;
            let mut code = String::new();
            while code.len() < 12 {
                for b in random::<12>()? {
                    if b < 248 {
                        code.push(b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ"[(b as usize) % 31] as char);
                        if code.len() == 12 {
                            break;
                        }
                    }
                }
            }
            let now = now(s).await?;
            let expires = now + 600000;
            tx(s, |db| {
                if one(db, "SELECT 1 FROM pairing_codes WHERE id=?", [&id])?.is_some() {
                    return Err(error(
                        409,
                        "This code was already shown. Create a new pairing code.",
                    ));
                }
                let count: i64 = db.query_row(
                    "SELECT count(*) FROM pairing_codes WHERE used=0 AND expires>?",
                    [now],
                    |r| r.get(0),
                )?;
                if count >= 5 {
                    return Err(error(
                        429,
                        "Five pairing codes are active. Wait for one to expire.",
                    ));
                }
                db.execute(
                    "INSERT INTO pairing_codes VALUES(?,?,?,0)",
                    params![id, hash(&json!(code)), expires],
                )?;
                Ok(())
            })?;
            json!({"code":code,"expiresAt":expires})
        }
        "/api/machines" => add(s, &value).await?,
        "/api/pairing/redeem" => redeem(s, &value).await?,
        "/api/machines/reciprocal" => reciprocal(s, &value, auth.as_deref()).await?,
        "/api/machines/remove" => unpair(s, &value).await?,
        "/api/peer/unpair" => unpair_remote(s, &value, auth.as_deref()).await?,
        "/api/machines/updates" => set_updates(s, &value)?,
        "/api/machines/agent-messaging" => {
            fields(&value, &["id", "environmentId", "allowed"])?;
            let id = request_id(&value["id"])?;
            let machine = request_id(&value["environmentId"])?;
            let allowed = value["allowed"]
                .as_bool()
                .ok_or_else(|| error(400, "Agent messaging setting is invalid."))?;
            let fp = hash(&json!({"machine":machine,"allowed":allowed}));
            if let Some(old) = prior(s, &id, &fp)? {
                serde_json::from_str(text(&old, "result")).map_err(|_| Failure::storage())?
            } else {
                let r = row(s, &machine)?;
                with_db(s, |db| {
                    db.execute(
                        "UPDATE paired_machines SET allow_agent_messaging=? WHERE environment_id=?",
                        params![allowed as i64, machine],
                    )?;
                    if !allowed {
                        db.execute("UPDATE turns SET status='cancelled',paused=0,revision=revision+1,error='Peer agent messaging was disabled by the host owner.' WHERE id IN(SELECT turn FROM mcp_server_messages WHERE caller=?) AND status NOT IN('done','cancelled')",[text(&r,"local_token_id")])?;
                    }
                    Ok(())
                })?;
                let v = visible(s, &row(s, &machine)?)?;
                receipt(s, &id, &fp, Some(&machine), &v)?;
                v
            }
        }
        _ => return Err(error(404, "Route not found.")),
    };
    Ok(crate::json_response(200, result))
}

pub fn ensure_updates_allowed(state: &AppState, machine: &str) -> Result<()> {
    update_peer(state, machine).map(|_| ())
}
