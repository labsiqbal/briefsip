use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use sha2::{Digest, Sha256};
use std::time::Duration;

fn invalid(message: &str) -> Failure {
    Failure::new(400, "invalid_mail_envelope", message)
}
fn decode(value: &Value) -> Result<Vec<u8>> {
    let encoded = value
        .as_str()
        .ok_or_else(|| invalid("Invalid mail envelope."))?;
    B64.decode(encoded)
        .ok()
        .filter(|bytes| B64.encode(bytes) == encoded)
        .ok_or_else(|| invalid("Invalid mail envelope."))
}
fn open(row: &Value, ciphertext: &[u8], key: &[u8]) -> Result<Vec<u8>> {
    if ciphertext.len() > 512 * 1024 {
        return Err(invalid("Invalid mail envelope."));
    }
    let v: Value =
        serde_json::from_slice(ciphertext).map_err(|_| invalid("Invalid mail envelope."))?;
    if !closed(&v, &["v", "alg", "keyId", "nonce", "ciphertext", "tag"])
        || v["v"] != 1
        || v["alg"] != "AES-256-GCM"
        || !uuid(string(&v, "keyId"))
    {
        return Err(invalid("Invalid envelope version or algorithm."));
    }
    let nonce: [u8; 12] = decode(&v["nonce"])?
        .try_into()
        .map_err(|_| invalid("Invalid envelope size."))?;
    let tag = decode(&v["tag"])?;
    if tag.len() != 16 {
        return Err(invalid("Invalid envelope size."));
    }
    let mut bytes = decode(&v["ciphertext"])?;
    bytes.extend_from_slice(&tag);
    let key = UnboundKey::new(&AES_256_GCM, key)
        .map_err(|_| Failure::new(503, "mail_key_unavailable", "Mail key is unavailable."))?;
    let aad = json!([
        "briefsip-mail-outbox-v1",
        row["id"],
        row["revision"],
        row["authority_generation"],
        row["email_hash"]
    ])
    .to_string();
    let plain = LessSafeKey::new(key)
        .open_in_place(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(aad.as_bytes()),
            &mut bytes,
        )
        .map_err(|_| {
            Failure::new(
                400,
                "mail_auth_failed",
                "Mail envelope failed verification.",
            )
        })?
        .to_vec();
    let payload: Value =
        serde_json::from_slice(&plain).map_err(|_| invalid("Invalid mail content."))?;
    if !closed(&payload, &["to", "from", "subject", "text", "html"]) {
        return Err(invalid("Invalid mail content."));
    }
    for name in ["to", "from", "subject", "text", "html"] {
        if name == "html" && payload.get(name).is_none() {
            continue;
        }
        let text = payload[name]
            .as_str()
            .ok_or_else(|| invalid("Invalid mail payload."))?;
        let content = ["text", "html"].contains(&name);
        let max = if name == "html" {
            256 * 1024
        } else if name == "text" {
            128 * 1024
        } else {
            320
        };
        if name != "html" && text.is_empty()
            || text.encode_utf16().count() > max
            || text
                .chars()
                .any(|c| c == '\u{7f}' || c < ' ' && (!content || !matches!(c, '\t' | '\r' | '\n')))
        {
            return Err(invalid("Invalid mail payload."));
        }
    }
    if format!("{:x}", Sha256::digest(&plain)) != row["payload_digest"] {
        return Err(Failure::new(
            409,
            "mail_payload_conflict",
            "Mail digest does not match.",
        ));
    }
    Ok(plain)
}
fn changed(db: &Connection, row: &Value, now: i64) -> Result<()> {
    crate::data::append_mutation(
        db,
        string(row, "project"),
        "invitations:mail",
        string(row, "id"),
        &json!({}),
        now,
    )
}
fn prepare(state: &AppState, id: &str) -> Result<Option<(Value, Vec<u8>)>> {
    let guard = state.database.lock().map_err(|_| Failure::storage())?;
    let db = &guard.connection;
    transaction(db, || {
        let now = state.config.now();
        let Some(row) = one(db,"SELECT o.id,o.revision,o.state,o.first_attempt,o.next_attempt,o.attempts,o.payload_digest,i.project,i.authority_generation,i.email_hash,i.expires_at,i.state AS invitation_state FROM mail_outbox o JOIN invitations i ON i.id=o.id WHERE o.id=?",[id])? else { return Ok(None); };
        let n = |key| row[key].as_i64().unwrap_or(0);
        if !["queued", "sending", "unknown"].contains(&string(&row, "state"))
            || n("next_attempt") > now
        {
            return Ok(None);
        }
        let generation = one(
            db,
            "SELECT generation FROM authority_state WHERE id=1 AND serving_state='active'",
            [],
        )?;
        let owner = exists(db,"SELECT 1 FROM projects p JOIN accounts a ON a.id=p.account JOIN project_members m ON m.project=p.id AND m.account=a.id WHERE p.id=? AND p.deleted=0 AND a.blocked=0 AND m.deleted=0 AND m.role='owner'",[string(&row,"project")])?;
        let state_name = if generation
            .as_ref()
            .is_none_or(|v| v["generation"] != row["authority_generation"])
            || !owner
            || !["pending_delivery", "sent"].contains(&string(&row, "invitation_state"))
        {
            Some("revoked")
        } else if n("expires_at") <= now {
            Some("expired")
        } else if !row["first_attempt"].is_null() && now - n("first_attempt") >= 23 * 3600000
            || n("attempts") >= 8
        {
            Some("delivery_unknown")
        } else {
            None
        };
        if let Some(status) = state_name {
            db.execute("UPDATE invitations SET state=CASE WHEN state='accepted' THEN state ELSE ? END,revision=revision+1 WHERE id=?",[status,id])?;
            db.execute(
                "UPDATE mail_outbox SET state=?,ciphertext=X'',next_attempt=NULL WHERE id=?",
                [
                    if status == "delivery_unknown" {
                        "unknown"
                    } else {
                        "revoked"
                    },
                    id,
                ],
            )?;
            changed(db, &row, now)?;
            return Ok(None);
        }
        let ciphertext: Vec<u8> =
            db.query_row("SELECT ciphertext FROM mail_outbox WHERE id=?", [id], |r| {
                r.get(0)
            })?;
        let envelope: Value =
            serde_json::from_slice(&ciphertext).map_err(|_| invalid("Invalid mail envelope."))?;
        let key_id = envelope["keyId"]
            .as_str()
            .filter(|s| uuid(s))
            .ok_or_else(|| invalid("Invalid keyId."))?;
        let key = state
            .config
            .remaining_data
            .key(&format!("mail-aead/{key_id}"), true)?;
        let plaintext = open(&row, &ciphertext, &key)?;
        db.execute("UPDATE mail_outbox SET state='sending',first_attempt=coalesce(first_attempt,?),next_attempt=?,attempts=attempts+1 WHERE id=?",params![now,now+15000,id])?;
        Ok(Some((row, plaintext)))
    })
}
pub async fn deliver(state: &AppState, id: &str) -> Result<()> {
    if crate::turns::pending(state) {
        return Ok(());
    }
    let Some(api_key) = state
        .config
        .connectors
        .mail_api_key
        .as_ref()
        .filter(|s| !s.is_empty())
    else {
        return Ok(());
    };
    let Some((row, plaintext)) = prepare(state, id)? else {
        return Ok(());
    };
    let request = async {
        let response = super::runner::http()
            .map_err(|_| Failure::storage())?
            .post(
                state
                    .config
                    .connectors
                    .mail_endpoint
                    .as_deref()
                    .unwrap_or("https://api.resend.com/emails"),
            )
            .bearer_auth(api_key)
            .header("Content-Type", "application/json")
            .header(
                "Idempotency-Key",
                format!("briefsip-invite/{id}/{}", row["revision"]),
            )
            .body(plaintext)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|_| Failure::storage())?;
        let status = response.status();
        let raw = super::runner::bytes(response, 65536).await?;
        let value: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
        if status.is_success() {
            let remote = string(&value, "id");
            if !closed(&value, &["id"]) || remote.is_empty() || remote.encode_utf16().count() > 200
            {
                return Err(Failure::storage());
            }
            Ok(("sent", Some(remote.to_owned())))
        } else if status.is_client_error()
            && ![408, 429].contains(&status.as_u16())
            && !(status.as_u16() == 409 && value["name"] == "concurrent_idempotent_requests")
        {
            Ok(("failed", None))
        } else {
            Ok(("unknown", None))
        }
    }
    .await
    .unwrap_or(("unknown", None));
    let guard = state.database.lock().map_err(|_| Failure::storage())?;
    let db = &guard.connection;
    transaction(db, || {
        let Some(current) = one(db,"SELECT o.state,i.state AS invitation_state,i.authority_generation FROM mail_outbox o JOIN invitations i ON i.id=o.id WHERE o.id=?",[id])? else { return Ok(()); };
        let generation = one(
            db,
            "SELECT generation FROM authority_state WHERE id=1 AND serving_state='active'",
            [],
        )?;
        if current["state"] != "sending"
            || generation
                .as_ref()
                .is_none_or(|g| g["generation"] != current["authority_generation"])
            || ["accepted", "revoked", "expired"].contains(&string(&current, "invitation_state"))
        {
            return Ok(());
        }
        let now = state.config.now();
        if request.0 == "unknown" {
            let attempts = row["attempts"].as_u64().unwrap_or(0).min(4) as usize;
            let mut jitter = [0u8];
            getrandom::getrandom(&mut jitter).map_err(|_| Failure::storage())?;
            db.execute(
                "UPDATE mail_outbox SET state='unknown',next_attempt=? WHERE id=?",
                params![
                    now + [1000, 5000, 30000, 120000, 600000][attempts] + i64::from(jitter[0]),
                    id
                ],
            )?;
        } else {
            db.execute(
                "UPDATE invitations SET state=?,revision=revision+1 WHERE id=?",
                [request.0, id],
            )?;
            db.execute("UPDATE mail_outbox SET state=?,remote_id=?,ciphertext=X'',next_attempt=NULL WHERE id=?",params![request.0,request.1,id])?;
            changed(db, &row, now)?;
        }
        Ok(())
    })
}
pub fn start(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if state.auth.is_none()
            || state
                .config
                .connectors
                .mail_api_key
                .as_ref()
                .is_none_or(String::is_empty)
        {
            return;
        }
        let mut timer = tokio::time::interval(Duration::from_secs(1));
        loop {
            timer.tick().await;
            if crate::turns::pending(&state) {
                continue;
            }
            let rows=state.database.lock().map_err(|_| Failure::storage()).and_then(|guard| all(&guard.connection,"SELECT id FROM mail_outbox WHERE state IN('queued','sending','unknown') AND (next_attempt IS NULL OR next_attempt<=?) ORDER BY id LIMIT 4",[state.config.now()]));
            if let Ok(rows) = rows {
                futures_util::future::join_all(
                    rows.iter().map(|row| deliver(&state, string(row, "id"))),
                )
                .await;
            }
        }
    })
}
