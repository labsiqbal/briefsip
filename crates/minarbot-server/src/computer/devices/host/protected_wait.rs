use super::*;
use axum::http::{HeaderMap, HeaderValue};
use ring::{aead, hkdf};
use std::time::Instant;

const CHUNK: usize = 24_576;

fn invalid() -> Failure {
    fail(409, "wait_invalid", "Wait binding does not match.")
}

fn valid_secret(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn validate_provision(value: &Value) -> Result<()> {
    fields(
        value,
        &[
            "v",
            "provisionId",
            "waitKey",
            "projectId",
            "agentId",
            "sourceDeviceId",
            "sourceDeviceGeneration",
            "authorityGeneration",
            "secretGeneration",
            "event",
            "deadline",
            "target",
            "payloadDigest",
        ],
    )?;
    for key in [
        "provisionId",
        "projectId",
        "agentId",
        "sourceDeviceId",
        "authorityGeneration",
    ] {
        if value[key] != id(&value[key])? {
            return Err(invalid());
        }
    }
    for key in ["sourceDeviceGeneration", "secretGeneration", "deadline"] {
        revision(&value[key], 1)?;
    }
    if value["v"] != 1
        || value["event"]
            .as_str()
            .is_none_or(|s| s.trim().is_empty() || s.encode_utf16().count() > 256)
    {
        return Err(invalid());
    }
    let t = &value["target"];
    let key = match text(t, "kind") {
        "turn" => {
            fields(t, &["kind", "taskId", "actionId", "toolCallId"])?;
            id(&t["taskId"])?;
            id(&t["actionId"])?;
            let call = text(t, "toolCallId");
            if call.is_empty()
                || call.encode_utf16().count() > 200
                || call.bytes().any(|b| b < 32 || b == 127)
            {
                return Err(invalid());
            }
            text(value, "provisionId").to_owned()
        }
        "workflow" => {
            fields(
                t,
                &["kind", "runId", "seq", "nodeId", "expectedRunRevision"],
            )?;
            let run = id(&t["runId"])?;
            let seq = revision(&t["seq"], 1)?;
            revision(&t["expectedRunRevision"], 1)?;
            let node = text(t, "nodeId");
            if node.is_empty()
                || node.len() > 64
                || !node
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            {
                return Err(invalid());
            }
            json!(["workflow", run, seq]).to_string()
        }
        _ => return Err(invalid()),
    };
    let mut body = value.clone();
    body.as_object_mut()
        .ok_or_else(invalid)?
        .remove("payloadDigest");
    if value["waitKey"] != key
        || value["payloadDigest"] != digest(&json!(["minarbot-wait-provision-v1", body]))
    {
        return Err(invalid());
    }
    Ok(())
}

fn provision_active(host: &Host, value: &Value) -> Result<bool> {
    let d = host.identity.descriptor.as_ref().ok_or_else(invalid)?;
    if value["sourceDeviceId"] != host.identity.device_id
        || value["sourceDeviceGeneration"] != d["deviceGeneration"]
        || value["authorityGeneration"] != d["authorityGeneration"]
    {
        return Ok(false);
    }
    let current = one(
        &host.db,
        "SELECT device_id,device_generation,authority_generation FROM device_state WHERE id=1",
        [],
    )?;
    Ok(current.is_some_and(|row| {
        row["device_id"] == value["sourceDeviceId"]
            && row["device_generation"] == value["sourceDeviceGeneration"]
            && row["authority_generation"] == value["authorityGeneration"]
    }))
}

fn store_secret(host: &Host, reference: &str, deadline: i64) -> Result<()> {
    let expired = || fail(409, "wait_expired", "Wait provision has expired.");
    if now() >= deadline {
        return Err(expired());
    }
    let service = host.secret_service();
    let secret = match host.keys.read(&service, reference)? {
        Some(secret) if valid_secret(&secret) => secret,
        Some(_) => return Err(keys::unavailable()),
        None => {
            let secret: String = keys::entropy::<32>()?
                .into_iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            keys::stage(&*host.keys, &service, reference, &secret)?;
            secret
        }
    };
    if host.keys.read(&service, reference)?.as_deref() != Some(&secret) {
        return Err(keys::unavailable());
    }
    if now() >= deadline {
        return Err(expired());
    }
    Ok(())
}

pub(super) fn provision(host: &Host, value: &Value, stale: bool) -> Result<()> {
    validate_provision(value)?;
    let active = provision_active(host, value)?;
    if !active && !stale {
        return Err(invalid());
    }
    let key = text(value, "waitKey");
    let pid = text(value, "provisionId");
    let generation = revision(&value["secretGeneration"], 1)?;
    let deadline = revision(&value["deadline"], 1)?;
    let encoded = db::canonical(value);
    let previous = one(&host.db, "SELECT * FROM device_wait_secrets WHERE provision_id=? OR (wait_key=? AND secret_generation=?)", params![pid,key,generation])?;
    if previous
        .as_ref()
        .is_some_and(|row| row["provision_json"] != encoded)
    {
        return Err(fail(
            409,
            "payload_conflict",
            "Wait generation already uses a different payload.",
        ));
    }
    if previous
        .as_ref()
        .is_some_and(|row| !row["result_json"].is_null())
    {
        return Ok(());
    }
    let reference = format!("event-wait/{key}/{generation}");
    let request =
        previous.map_or_else(request_id, |row| text(&row, "result_request_id").to_owned());
    host.db.execute("INSERT OR IGNORE INTO device_wait_secrets (wait_key,kind,key_reference,secret_generation,deadline,closed,provision_id,payload_digest,provision_json,result_request_id,result_json,state) VALUES (?,?,?,?,?,0,?,?,?,?,NULL,'staging')",
        params![key,text(&value["target"],"kind"),reference,generation,deadline,pid,text(value,"payloadDigest"),encoded,request])?;
    let mut result = json!({"requestId":request,"provisionId":pid,"payloadDigest":value["payloadDigest"],"waitKey":key,
        "secretGeneration":generation,"sourceDeviceGeneration":value["sourceDeviceGeneration"]});
    let outcome = if active {
        store_secret(host, &reference, deadline)
    } else {
        Err(invalid())
    };
    match outcome {
        Ok(()) => {
            result["state"] = "ready".into();
            result["secretRef"] = json!([key, generation]).to_string().into();
        }
        Err(err) => {
            result["state"] = "failed".into();
            result["errorCode"] = match err.code {
                "wait_expired" | "wait_invalid" => err.code,
                _ => "keystore_unavailable",
            }
            .into();
        }
    }
    host.db.execute("UPDATE device_wait_secrets SET result_json=?,state=? WHERE provision_id=? AND state='staging'",
        params![db::canonical(&result),text(&result,"state"),pid])?;
    Ok(())
}

fn stored_wait(host: &Host, request: &Value) -> Result<Value> {
    let row = one(&host.db, "SELECT * FROM device_wait_secrets WHERE wait_key=? AND secret_generation=? AND state IN('ready','acknowledged') AND closed=0",
        params![text(request,"waitKey"),revision(&request["secretGeneration"],1)?])?.ok_or_else(invalid)?;
    let provision = crate::web::parse_json(text(&row, "provision_json").as_bytes())?;
    validate_provision(&provision)?;
    if !provision_active(host, &provision)?
        || provision["sourceDeviceGeneration"] != request["deviceGeneration"]
        || provision["authorityGeneration"] != request["authorityGeneration"]
        || provision["sourceDeviceId"] != request["sourceDeviceId"]
    {
        return Err(invalid());
    }
    Ok(row)
}

fn read_secret(host: &Host, row: &Value) -> Result<String> {
    host.keys
        .read(&host.secret_service(), text(row, "key_reference"))?
        .filter(|s| valid_secret(s))
        .ok_or_else(keys::unavailable)
}

fn reveal(host: &Host, request: &Value) -> Result<Value> {
    let time = now();
    let expires = revision(&request["expiresAt"], 1)?;
    if expires <= time || expires > time + 60_000 {
        return Err(invalid());
    }
    let row = stored_wait(host, request)?;
    if row["deadline"].as_i64().unwrap_or(0) <= time {
        return Err(invalid());
    }
    let secret = read_secret(host, &row)?;
    seal(
        request,
        &secret,
        &host.key(&host.identity.encryption_ref, true, false)?,
    )
}

fn acknowledge(host: &Host, result: &Value, response: &Value) -> Result<()> {
    let ack = &response["data"];
    let receipt = &response["receipt"];
    let descriptor = host.identity.descriptor.as_ref().ok_or_else(invalid)?;
    fields(ack, &["provisionId", "state", "receipt"])?;
    if receipt["requestId"] != result["requestId"]
        || receipt["recordId"] != result["provisionId"]
        || receipt["actorId"] != descriptor["accountId"]
        || receipt["payloadDigest"] != digest(&json!(["minarbot-wait-secret-result-v1", result]))
        || ack["provisionId"] != result["provisionId"]
        || !matches!(text(ack, "state"), "activated" | "closed")
        || (ack["state"] == "activated" && result["state"] != "ready")
    {
        return Err(fail(
            502,
            "receipt_mismatch",
            "Wait provision ACK does not match.",
        ));
    }
    let id = text(ack, "provisionId");
    let canonical = db::canonical(ack);
    let closed = i64::from(ack["state"] == "closed");
    let updated = host.db.execute("UPDATE device_wait_secrets SET state='acknowledged',closed=?,cleanup_pending=?,ack_json=? WHERE provision_id=? AND state<>'acknowledged'",
        params![closed,closed,canonical,id])?;
    if updated == 0
        && one(
            &host.db,
            "SELECT 1 FROM device_wait_secrets WHERE provision_id=? AND ack_json=?",
            params![id, canonical],
        )?
        .is_none()
    {
        return Err(fail(
            409,
            "wait_result_conflict",
            "Wait provision ACK changed.",
        ));
    }
    Ok(())
}

fn cleanup(host: &Host) -> Result<()> {
    for row in rows(&host.db, "SELECT provision_id,key_reference FROM device_wait_secrets WHERE closed=1 AND cleanup_pending=1 LIMIT 40", [])? {
        let service = host.secret_service();
        let reference = text(&row, "key_reference");
        if keys::remove_verified(&*host.keys, &service, reference) {
            host.db.execute("UPDATE device_wait_secrets SET cleanup_pending=0 WHERE provision_id=? AND closed=1", [text(&row,"provision_id")])?;
        }
    }
    Ok(())
}

fn resume_staging(host: &Host) -> Result<()> {
    let rows = rows(&host.db, "SELECT provision_json FROM device_wait_secrets WHERE state='staging' ORDER BY (json_extract(provision_json,'$.sourceDeviceGeneration')=? AND json_extract(provision_json,'$.authorityGeneration')=?) DESC,rowid LIMIT 40",
        params![host.identity.descriptor.as_ref().map_or(0, |d| d["deviceGeneration"].as_i64().unwrap_or(0)),
            text(host.identity.descriptor.as_ref().unwrap_or(&Value::Null), "authorityGeneration")])?;
    for row in rows {
        provision(
            host,
            &crate::web::parse_json(text(&row, "provision_json").as_bytes())?,
            true,
        )?;
    }
    Ok(())
}

fn event(host: &Host, request: &Value, bytes: &[u8]) -> Result<Value> {
    let row = stored_wait(host, request)?;
    let secret = read_secret(host, &row)?;
    let mut headers = HeaderMap::new();
    for h in ["x-minarbot-time", "x-minarbot-id", "x-minarbot-signature"] {
        headers.insert(
            h,
            HeaderValue::from_str(text(&request["headers"], h)).map_err(|_| invalid())?,
        );
    }
    let current = now();
    let accepted = request.get("accepted");
    let verify_at = if accepted.is_some() {
        text(&request["headers"], "x-minarbot-time")
            .parse::<i64>()
            .map_err(|_| invalid())?
            * 1000
    } else {
        current
    };
    let result =
        crate::turns::waits::event(bytes, &headers, &secret, verify_at).map_err(|err| {
            fail(
                err.status,
                if err.status == 401 {
                    "event_signature_invalid"
                } else {
                    "event_invalid"
                },
                &err.message,
            )
        })?;
    let saved = crate::web::parse_json(text(&row, "provision_json").as_bytes())?;
    let conflict = fail(
        409,
        "event_conflict",
        "Event does not match the active wait.",
    );
    if let Some(accepted) = accepted {
        if result["id"] != accepted["id"] || result["digest"] != accepted["digest"] {
            return Err(conflict);
        }
    } else if result["event"] != saved["event"]
        || row["deadline"].as_i64().unwrap_or_default() <= current
    {
        return Err(conflict);
    }
    let event_time = if accepted.is_some() {
        serde_json::from_slice::<Value>(bytes)
            .map_err(|_| invalid())?
            .get("eventTime")
            .cloned()
            .unwrap_or(json!(current))
    } else {
        result["eventTime"].clone()
    };
    Ok(json!({"id":result["id"],"digest":result["digest"],"eventTime":event_time}))
}

fn seal(request: &Value, secret: &str, private: &keys::Private) -> Result<Value> {
    let shared = private.agree(&request["ephemeralPublicKey"])?;
    let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, text(request, "requestId").as_bytes());
    let info = [b"minarbot-wait-reveal-v1".as_slice()];
    let key = salt.extract(&shared);
    let key = key
        .expand(&info, &aead::AES_256_GCM)
        .map_err(|_| keys::unavailable())?;
    let mut bytes = [0; 32];
    key.fill(&mut bytes).map_err(|_| keys::unavailable())?;
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, &bytes).map_err(|_| keys::unavailable())?,
    );
    let iv = keys::entropy::<12>()?;
    let aad = json!([
        request["requestId"],
        request["waitKey"],
        request["ownerAccountId"],
        request["deviceGeneration"],
        request["secretGeneration"],
        request["expiresAt"]
    ])
    .to_string();
    let mut content = secret.as_bytes().to_vec();
    let tag = key
        .seal_in_place_separate_tag(
            aead::Nonce::assume_unique_for_key(iv),
            aead::Aad::from(aad.as_bytes()),
            &mut content,
        )
        .map_err(|_| keys::unavailable())?;
    Ok(
        json!({"requestId":request["requestId"],"waitKey":request["waitKey"],"sourceDeviceId":request["sourceDeviceId"],"deviceGeneration":request["deviceGeneration"],
        "secretGeneration":request["secretGeneration"],"expiresAt":request["expiresAt"],"iv":B64.encode(iv),"ciphertext":B64.encode(content),"tag":B64.encode(tag.as_ref())}),
    )
}

struct Assembly {
    job: String,
    digest: String,
    bytes: Vec<u8>,
    started: Instant,
}

pub(super) struct Stream {
    assembly: Option<Assembly>,
}

impl Stream {
    pub(super) fn new() -> Self {
        Self { assembly: None }
    }

    pub(super) async fn resume(&mut self, host: &mut Host, token: &str) -> Result<()> {
        let pending = one(&host.db, "SELECT 1 FROM device_wait_secrets WHERE state<>'acknowledged' OR cleanup_pending=1 LIMIT 1", [])?;
        if pending.is_none() {
            return Ok(());
        }
        host.acquire_executor()?;
        resume_staging(host)?;
        for row in rows(
            &host.db,
            "SELECT w.result_json FROM device_wait_secrets w JOIN device_state s ON s.id=1
            WHERE w.state IN('ready','failed') AND s.device_id=?
             AND json_extract(w.provision_json,'$.sourceDeviceGeneration')=s.device_generation
             AND json_extract(w.provision_json,'$.authorityGeneration')=s.authority_generation
            ORDER BY w.rowid LIMIT 40",
            [&host.identity.device_id],
        )? {
            let result = crate::web::parse_json(text(&row, "result_json").as_bytes())?;
            let response = host.post("wait-secret-results", token, &result).await?;
            acknowledge(host, &result, &response)?;
        }
        cleanup(host)
    }

    fn assemble(&mut self, job: &Value, request: &Value) -> Result<Option<Vec<u8>>> {
        let offset = revision(&job["offset"], 0)? as usize;
        let total = revision(&request["byteLength"], 1)? as usize;
        if offset >= total || !offset.is_multiple_of(CHUNK) {
            return Err(invalid());
        }
        let chunk = decode(&job["chunk"], (total - offset).min(CHUNK))?;
        let id = text(job, "jobId");
        let digest = text(job, "payloadDigest");
        if offset == 0 {
            if self
                .assembly
                .as_ref()
                .is_some_and(|a| a.started.elapsed() < Duration::from_secs(5))
            {
                return Err(invalid());
            }
            self.assembly = Some(Assembly {
                job: id.into(),
                digest: digest.into(),
                bytes: Vec::with_capacity(total),
                started: Instant::now(),
            });
        }
        let partial = self
            .assembly
            .as_mut()
            .filter(|a| {
                a.job == id
                    && a.digest == digest
                    && a.bytes.len() == offset
                    && a.started.elapsed() < Duration::from_secs(5)
            })
            .ok_or_else(invalid)?;
        partial.bytes.extend(chunk);
        if partial.bytes.len() < total {
            return Ok(None);
        }
        let bytes = self.assembly.take().ok_or_else(invalid)?.bytes;
        if request["bodyDigest"] != byte_digest(&bytes) {
            return Err(invalid());
        }
        Ok(Some(bytes))
    }

    pub(super) async fn handle(
        &mut self,
        host: &mut Host,
        token: &str,
        connection: i64,
        frame: &Value,
    ) -> Result<()> {
        let job = &frame["body"];
        let event = match text(frame, "kind") {
            "wait.provision.v1" => {
                host.acquire_executor()?;
                provision(host, job, false)?;
                return self.resume(host, token).await;
            }
            "wait.event.v1" => true,
            "wait.reveal.v1" => false,
            _ => {
                return Err(fail(
                    426,
                    "protocol_unsupported",
                    "Unsupported stream frame.",
                ))
            }
        };
        let request = &job["request"];
        waits::validate_host_request(request, event)?;
        fields(
            job,
            if event {
                &["jobId", "request", "payloadDigest", "offset", "chunk"]
            } else {
                &["jobId", "request", "payloadDigest"]
            },
        )?;
        let request_id = id(&job["jobId"])?;
        let descriptor = host.identity.descriptor.as_ref().ok_or_else(invalid)?;
        let label = if event {
            "minarbot-wait-event-v1"
        } else {
            "minarbot-wait-reveal-v1"
        };
        let payload_digest = digest(&json!([label, request]));
        if job["payloadDigest"] != payload_digest
            || request["connectionGeneration"] != connection
            || request["sourceDeviceId"] != host.identity.device_id
            || request["deviceGeneration"] != descriptor["deviceGeneration"]
            || request["authorityGeneration"] != descriptor["authorityGeneration"]
            || !event && request["ownerAccountId"] != descriptor["accountId"]
        {
            return Err(invalid());
        }
        let result = if event {
            let Some(bytes) = self.assemble(job, request)? else {
                return Ok(());
            };
            host.acquire_executor()
                .and_then(|()| self::event(host, request, &bytes))
        } else {
            host.acquire_executor().and_then(|()| reveal(host, request))
        };
        let mut body = json!({"requestId":request_id,"payloadDigest":payload_digest});
        match result {
            Ok(result) => body["result"] = result,
            Err(err) => {
                body["errorCode"] = match err.code {
                    "wait_invalid"
                    | "event_invalid"
                    | "event_conflict"
                    | "event_signature_invalid" => err.code,
                    _ => "keystore_unavailable",
                }
                .into()
            }
        }
        let _ = host
            .post(
                if event {
                    "wait-event-results"
                } else {
                    "wait-reveal-results"
                },
                token,
                &body,
            )
            .await;
        Ok(())
    }
}

#[cfg(test)]
#[path = "protected_wait_tests.rs"]
mod tests;
