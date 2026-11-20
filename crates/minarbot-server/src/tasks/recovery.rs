use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use subtle::ConstantTimeEq;

fn invalid() -> Failure {
    fail(403, "recovery_session_invalid", "Invalid recovery session.")
}
fn changed(message: &str) -> Failure {
    fail(409, "recovery_conflict", message)
}
fn provenance() -> Failure {
    fail(
        403,
        "recovery_provenance_invalid",
        "Recovery action does not match the original source.",
    )
}
fn owner(db: &Connection, account: &str, task_id: &str, recovery: bool) -> Result<Value> {
    let t = task(db, task_id)?;
    if recovery {
        if !exists(db,"SELECT 1 FROM projects p JOIN project_members m ON m.project=p.id AND m.account=p.account WHERE p.id=? AND p.account=? AND p.deleted=0 AND m.deleted=0 AND m.role='owner'",[string(&t,"project"),account])? {
            return Err(fail(403,"owner_required","Only the project owner can recover tasks."));
        }
    } else {
        authority::member(db, account, string(&t, "project"), true)?;
    }
    Ok(t)
}
fn descriptor(db: &Connection, account: &str, device: &str, generation: i64) -> Result<Value> {
    if !exists(
        db,
        "SELECT 1 FROM devices WHERE id=? AND account=?",
        [device, account],
    )? {
        return Err(fail(404, "resource_not_found", "Device not found."));
    }
    let row = one(db,"SELECT result_json FROM receipts WHERE actor=? AND scope IN('device_enrollment','device_enrollment_evidence') AND json_extract(result_json,'$.data.deviceId')=? AND json_extract(result_json,'$.data.generation')=? ORDER BY created LIMIT 1",params![account,device,generation])?.ok_or_else(||fail(404,"resource_not_found","Device not found."))?;
    let result = data::json(&row["result_json"])?;
    let d = &result["data"]["descriptor"];
    devices::verify(
        &d["signingPublicKey"],
        &json!([
            "briefsip-device-descriptor-v1",
            d["accountId"],
            d["installationId"],
            d["deviceId"],
            d["authorityGeneration"],
            d["deviceGeneration"],
            d["keyRevision"],
            d["zone"],
            d["zoneRevision"],
            d["signingPublicKey"],
            d["encryptionPublicKey"]
        ]),
        &d["signature"],
    )?;
    Ok(d.clone())
}
pub fn session(
    db: &Connection,
    account: &str,
    task_id: &str,
    v: &Value,
    now: i64,
) -> Result<Value> {
    fields(
        v,
        &[
            "requestId",
            "expectedAuthorityGeneration",
            "sourceDeviceId",
            "sourceDeviceGeneration",
        ],
    )?;
    let request = id(&v["requestId"])?;
    let generation = id(&v["expectedAuthorityGeneration"])?;
    let device = id(&v["sourceDeviceId"])?;
    let source_generation = revision(&v["sourceDeviceGeneration"], 1)?;
    let scope = format!("tasks:recovery-session:{task_id}");
    let pd = digest(
        &json!(["briefsip-recovery-session-v1",task_id,{"requestId":request,"authorityGeneration":generation,"sourceDeviceId":device,"sourceDeviceGeneration":source_generation}]),
    );
    let t = owner(db, account, task_id, false)?;
    if !exists(
        db,
        "SELECT 1 FROM authority_state WHERE id=1 AND serving_state='active' AND generation=?",
        [&generation],
    )? {
        return Err(fail(409, "authority_stale", "Recovery authority changed."));
    }
    let source = one(
        db,
        "SELECT generation,status FROM devices WHERE id=? AND account=?",
        [&device, account],
    )?
    .filter(|_| t["home_device"] == device)
    .ok_or_else(|| {
        fail(
            403,
            "recovery_scope_denied",
            "Recovery source is outside the scope.",
        )
    })?;
    if source["generation"] == source_generation && source["status"] != "revoked"
        || n(&source, "generation") < source_generation
    {
        return Err(fail(
            409,
            "recovery_source_current",
            "Source is not revoked or replaced yet.",
        ));
    }
    let d = descriptor(db, account, &device, source_generation)?;
    if !exists(db,"SELECT 1 FROM task_actions WHERE task=? AND authority_generation=? AND device_generation=? AND committed_at IS NOT NULL LIMIT 1",params![task_id,string(&d,"authorityGeneration"),source_generation])? {
        return Err(fail(409,"recovery_evidence_missing","Original source action is unavailable."));
    }
    if let Some(old) = replay(
        db,
        account,
        string(&t, "project"),
        &request,
        &scope,
        &pd,
        true,
    )? {
        return Ok(old);
    }
    db.execute("DELETE FROM recovery_evidence_sessions WHERE rowid IN(SELECT rowid FROM recovery_evidence_sessions WHERE expires_at<=? ORDER BY expires_at LIMIT 1000)",[now])?;
    db.execute(
        "UPDATE recovery_evidence_sessions SET revoked=1 WHERE task=? AND source_device=?",
        [task_id, &device],
    )?;
    let counts=one(db,"SELECT count(*) total,coalesce(sum(owner_account=?),0) owner FROM recovery_evidence_sessions WHERE revoked=0 AND expires_at>?",params![account,now])?.ok_or_else(Failure::storage)?;
    if n(&counts, "owner") >= 32 || n(&counts, "total") >= 4096 {
        let mut e = fail(429, "server_capacity", "Recovery session is full.");
        e.retryable = true;
        e.details = Some(json!({"retryAfterMs":1000}));
        return Err(e);
    }
    let mut bytes = [0; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| Failure::storage())?;
    let secret = B64.encode(bytes);
    let recovery = uuid::Uuid::new_v4().to_string();
    let expires = now + 900000;
    let mut result = Save {
        account,
        task: &t,
        request: &request,
        scope: &scope,
        payload: &pd,
        now,
    }
    .save(
        db,
        task_id,
        n(&t, "revision"),
        201,
        json!({"recoveryGeneration":recovery,"expiresAt":expires}),
        None,
    )?;
    db.execute(
        "INSERT INTO recovery_evidence_sessions VALUES(?,?,?,?,?,?,?,?,?,0)",
        params![
            hash(&secret),
            request,
            recovery,
            generation,
            account,
            task_id,
            device,
            source_generation,
            expires
        ],
    )?;
    result["data"]["session"] = json!(secret);
    Ok(result)
}
pub(super) fn journal_body(
    authority: &Value,
    device: &Value,
    generation: &Value,
    e: &Value,
) -> Value {
    json!([
        "briefsip-journal-entry-v1",
        authority,
        device,
        generation,
        e["taskId"],
        e["actionId"],
        e["sequence"],
        e["executorGeneration"],
        e["actionKind"],
        e["payloadDigest"],
        e["intentDigest"],
        e["bindingId"],
        e["bindingRevision"],
        e["grantRevision"],
        e["state"],
        e["effectStatus"],
        e["resultDigest"],
        e["resultRef"],
        e["journalSequence"]
    ])
}
pub(super) fn stop_body(s: &Value) -> Value {
    let children = s["children"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| json!([c["processId"], c["processStart"], c["processGroupId"]]))
        .collect::<Vec<_>>();
    json!([
        "briefsip-stop-evidence-v1",
        s["sourceAuthority"],
        s["taskId"],
        s["actionId"],
        s["sourceDeviceId"],
        s["sourceDeviceGeneration"],
        s["executorGeneration"],
        s["bootId"],
        s["processId"],
        s["processStart"],
        s["lockId"],
        s["observationBootId"],
        s["observation"],
        children,
        s["observedAt"],
        s["journalDigest"]
    ])
}
pub(super) fn parse_entry(e: &Value) -> Result<()> {
    fields(
        e,
        &[
            "taskId",
            "actionId",
            "sequence",
            "executorGeneration",
            "actionKind",
            "payloadDigest",
            "intentDigest",
            "bindingId",
            "bindingRevision",
            "grantRevision",
            "state",
            "effectStatus",
            "resultDigest",
            "resultRef",
            "journalSequence",
            "signature",
        ],
    )?;
    if ![
        "provider",
        "canonical",
        "resource",
        "read",
        "compute",
        "local",
        "browser",
    ]
    .contains(&string(e, "actionKind"))
        || ![
            "prepared",
            "committed",
            "in_flight",
            "reported",
            "acknowledged",
            "not_sent",
            "uncertain",
        ]
        .contains(&string(e, "state"))
        || !["none", "known", "unknown"].contains(&string(e, "effectStatus"))
    {
        return Err(fail(400, "invalid_journal_entry", "Invalid journal entry."));
    }
    for key in ["taskId", "actionId"] {
        id(&e[key])?;
    }
    for key in ["sequence", "journalSequence"] {
        revision(&e[key], 0)?;
    }
    for key in ["executorGeneration", "grantRevision"] {
        revision(&e[key], 1)?;
    }
    for key in ["payloadDigest", "intentDigest"] {
        hex(&e[key], key)?;
    }
    if let Some(v) = e.get("bindingId") {
        id(v)?;
    }
    if let Some(v) = e.get("bindingRevision") {
        revision(v, 1)?;
    }
    if let Some(v) = e.get("resultDigest") {
        hex(v, "resultDigest")?;
    }
    if let Some(r) = e.get("resultRef") {
        fields(
            r,
            &["v", "taskId", "actionId", "digest", "size", "encoding"],
        )?;
        id(&r["taskId"])?;
        id(&r["actionId"])?;
        hex(&r["digest"], "digest")?;
        revision(&r["size"], 1)?;
        if r["v"] != 1 || r["encoding"] != "canonical-json-v1" {
            return Err(fail(
                400,
                "invalid_journal_entry",
                "Invalid journal result reference.",
            ));
        }
    }
    devices::decode(&e["signature"], 64)?;
    Ok(())
}
pub(super) fn parse_stop(s: &Value) -> Result<()> {
    fields(
        s,
        &[
            "v",
            "sourceAuthority",
            "taskId",
            "actionId",
            "sourceDeviceId",
            "sourceDeviceGeneration",
            "executorGeneration",
            "bootId",
            "processId",
            "processStart",
            "lockId",
            "observationBootId",
            "observation",
            "children",
            "observedAt",
            "journalDigest",
            "signature",
        ],
    )?;
    let children = s["children"]
        .as_array()
        .filter(|c| c.len() <= 64)
        .ok_or_else(|| fail(400, "invalid_stop_evidence", "Invalid stop evidence."))?;
    if s["v"] != 1 || !["process_exited", "boot_changed"].contains(&string(s, "observation")) {
        return Err(fail(400, "invalid_stop_evidence", "Invalid stop evidence."));
    }
    let start = |v: &Value| -> Result<u128> {
        v.as_str()
            .filter(|s| !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| fail(400, "invalid_stop_evidence", "Invalid process start."))
    };
    let mut prior = None;
    let mut seen = std::collections::HashSet::new();
    for c in children {
        fields(c, &["processId", "processStart", "processGroupId"])?;
        let key = (
            revision(&c["processGroupId"], 1)?,
            revision(&c["processId"], 1)?,
            start(&c["processStart"])?,
        );
        if prior.is_some_and(|p| p > key) || !seen.insert(canonical(c)) {
            return Err(fail(
                400,
                "invalid_stop_evidence",
                "Child manifest must be unique and sorted.",
            ));
        }
        prior = Some(key);
    }
    for key in [
        "sourceAuthority",
        "taskId",
        "actionId",
        "sourceDeviceId",
        "bootId",
        "lockId",
        "observationBootId",
    ] {
        id(&s[key])?;
    }
    for key in ["sourceDeviceGeneration", "executorGeneration", "processId"] {
        revision(&s[key], 1)?;
    }
    start(&s["processStart"])?;
    revision(&s["observedAt"], 0)?;
    hex(&s["journalDigest"], "journalDigest")?;
    devices::decode(&s["signature"], 64)?;
    Ok(())
}
fn envelope(e: &Value) -> Result<()> {
    fields(
        e,
        &[
            "v",
            "sourceAuthority",
            "sourceDeviceId",
            "sourceDeviceGeneration",
            "watermark",
            "entries",
            "stopEvidence",
        ],
    )?;
    let entries = e["entries"]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 8)
        .ok_or_else(|| {
            fail(
                400,
                "invalid_recovery_envelope",
                "Invalid recovery envelope.",
            )
        })?;
    let stops = e["stopEvidence"].as_array().ok_or_else(|| {
        fail(
            400,
            "invalid_recovery_envelope",
            "Invalid recovery envelope.",
        )
    })?;
    if e["v"] != 1 {
        return Err(fail(
            400,
            "invalid_recovery_envelope",
            "Invalid recovery envelope.",
        ));
    }
    let mut prior = None;
    for entry in entries {
        parse_entry(entry)?;
        let key = (string(entry, "taskId"), string(entry, "actionId"));
        if prior.is_some_and(|p| p >= key) {
            return Err(fail(
                400,
                "invalid_recovery_envelope",
                "Recovery entries must be unique and sorted.",
            ));
        }
        prior = Some(key);
    }
    let mut seen = std::collections::HashSet::new();
    for s in stops {
        parse_stop(s)?;
        if !seen.insert((string(s, "taskId"), string(s, "actionId"))) {
            return Err(fail(
                400,
                "invalid_recovery_envelope",
                "Recovery stop evidence must be unique.",
            ));
        }
    }
    id(&e["sourceAuthority"])?;
    id(&e["sourceDeviceId"])?;
    revision(&e["sourceDeviceGeneration"], 1)?;
    let watermark = revision(&e["watermark"], 0)?;
    if canonical(e).len() > 65536 {
        return Err(fail(
            413,
            "payload_too_large",
            "Recovery envelope exceeds the limit.",
        ));
    }
    let stop_keys = stops
        .iter()
        .map(|s| json!([s["taskId"], s["actionId"]]))
        .collect::<Vec<_>>();
    let expected = entries
        .iter()
        .filter(|s| s["state"] == "not_sent")
        .map(|s| json!([s["taskId"], s["actionId"]]))
        .collect::<Vec<_>>();
    if stop_keys != expected {
        return Err(fail(
            400,
            "invalid_recovery_envelope",
            "Stop evidence does not match the entry.",
        ));
    }
    for entry in entries {
        if n(entry, "journalSequence") > watermark
            || entry.get("bindingId").is_some() != entry.get("bindingRevision").is_some()
        {
            return Err(fail(
                400,
                "invalid_journal_entry",
                "Journal provenance is incomplete.",
            ));
        }
        let known = matches!(string(entry, "state"), "reported" | "acknowledged");
        let r = &entry["resultRef"];
        if if known {
            entry["effectStatus"] != "known"
                || r.is_null()
                || r["taskId"] != entry["taskId"]
                || r["actionId"] != entry["actionId"]
                || r["digest"] != entry["resultDigest"]
                || n(r, "size") > 8388608
        } else {
            entry.get("resultRef").is_some() || entry.get("resultDigest").is_some()
        } {
            return Err(fail(
                400,
                "invalid_journal_entry",
                "Journal result does not match the state.",
            ));
        }
        if entry["state"] == "not_sent" && entry["effectStatus"] != "none"
            || entry["state"] == "uncertain" && entry["effectStatus"] != "unknown"
        {
            return Err(fail(
                400,
                "invalid_journal_entry",
                "Journal effect status does not match.",
            ));
        }
    }
    Ok(())
}
pub(super) fn envelope_body(generation: &str, request: &str, e: &Value) -> Value {
    let entries = e["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|v| {
            json!([
                v["taskId"],
                v["actionId"],
                v["sequence"],
                v["executorGeneration"],
                v["actionKind"],
                v["payloadDigest"],
                v["intentDigest"],
                v["bindingId"],
                v["bindingRevision"],
                v["grantRevision"],
                v["state"],
                v["effectStatus"],
                v["resultDigest"],
                v["resultRef"],
                v["journalSequence"],
                v["signature"]
            ])
        })
        .collect::<Vec<_>>();
    let stops = e["stopEvidence"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| {
            json!([
                s["taskId"],
                s["actionId"],
                s["journalDigest"],
                s["signature"]
            ])
        })
        .collect::<Vec<_>>();
    json!([
        "briefsip-recovery-envelope-v1",
        generation,
        request,
        e["sourceAuthority"],
        e["sourceDeviceId"],
        e["sourceDeviceGeneration"],
        e["watermark"],
        entries,
        stops
    ])
}
pub(super) fn verify_stop(
    key: &Value,
    e: &Value,
    s: &Value,
    action: &Value,
    lock: &Value,
    source: (&Value, &Value, &Value),
    now: i64,
) -> Result<()> {
    let (authority, device, generation) = source;
    let bytes = journal_body(authority, device, generation, e).to_string();
    if s["sourceAuthority"] != *authority
        || s["sourceDeviceId"] != *device
        || s["sourceDeviceGeneration"] != *generation
        || s["taskId"] != e["taskId"]
        || s["actionId"] != e["actionId"]
        || s["executorGeneration"] != e["executorGeneration"]
        || ["bootId", "processId", "processStart", "lockId"]
            .iter()
            .any(|k| s[k] != lock[k])
        || s["journalDigest"] != hash(&bytes)
        || n(s, "observedAt") > now + 60000
        || n(s, "observedAt") + 60000 < n(action, "committed_at")
        || if s["observation"] == "boot_changed" {
            s["observationBootId"] == s["bootId"]
        } else {
            s["observationBootId"] != s["bootId"]
        }
    {
        return Err(fail(
            403,
            "stop_evidence_invalid",
            "Recovery stop evidence does not match.",
        ));
    }
    devices::verify(key, &stop_body(s), &s["signature"]).map_err(|_| {
        fail(
            403,
            "stop_evidence_invalid",
            "Recovery stop evidence does not match.",
        )
    })
}
fn restore(db: &Connection, actor: &Actor, proof: &str, generation: &str, now: i64) -> Result<()> {
    let denied = || {
        fail(
            403,
            "recovery_session_invalid",
            "Recovery evidence is invalid or expired.",
        )
    };
    if !data::table(db, "minarbot_backup_authority")? {
        return Err(denied());
    }
    let recorded = all(
        db,
        "SELECT owner_account FROM minarbot_backup_authority",
        [],
    )?;
    if recorded.len()!=1 || recorded[0]["owner_account"]!=actor.account || !exists(db,"SELECT 1 FROM accounts a JOIN projects p ON p.account=a.id JOIN project_members m ON m.project=p.id AND m.account=a.id WHERE a.id=? AND a.clerk_sub=? AND a.blocked=0 AND p.deleted=0 AND m.deleted=0 AND m.role='owner'",[&actor.account,&actor.subject])? { return Err(denied()); }
    let a = one(
        db,
        "SELECT * FROM authority_state WHERE id=1 AND serving_state='read_only_recovery'",
        [],
    )?
    .ok_or_else(denied)?;
    let issuer = one(
        db,
        "SELECT issuer FROM accounts WHERE id=?",
        [&actor.account],
    )?
    .ok_or_else(denied)?;
    let pd = digest(&json!([
        "briefsip-restore-session-v1",
        actor.account,
        issuer["issuer"],
        actor.subject,
        proof
    ]));
    if devices::decode(&json!(proof), 32).is_err()
        || a["generation"] != generation
        || n(&a, "recovery_expires_at") <= now
        || !bool::from(
            pd.as_bytes()
                .ct_eq(string(&a, "recovery_session_hash").as_bytes()),
        )
    {
        return Err(denied());
    }
    Ok(())
}
pub fn ingest(
    db: &Connection,
    actor: &Actor,
    task_id: &str,
    v: &Value,
    proof: &str,
    content: bool,
    now: i64,
) -> Result<Value> {
    fields(
        v,
        if content {
            &[
                "requestId",
                "recoveryGeneration",
                "envelope",
                "signature",
                "resultContent",
            ]
        } else {
            &["requestId", "recoveryGeneration", "envelope", "signature"]
        },
    )?;
    if canonical(v).len()>if content{8388608}else{65536} || canonical(&json!({"requestId":v["requestId"],"recoveryGeneration":v["recoveryGeneration"],"envelope":v["envelope"],"signature":v["signature"]})).len()>65536 { return Err(fail(413,"payload_too_large","Recovery evidence exceeds the limit.")); }
    let request = id(&v["requestId"])?;
    let generation = id(&v["recoveryGeneration"])?;
    let e = &v["envelope"];
    envelope(e)?;
    let entries = e["entries"].as_array().ok_or_else(Failure::storage)?;
    let stops = e["stopEvidence"].as_array().ok_or_else(Failure::storage)?;
    let encoded = v.get("resultContent").map(canonical);
    if content
        && (entries.len() != 1
            || !matches!(string(&entries[0], "state"), "reported" | "acknowledged")
            || encoded.is_none())
    {
        return Err(fail(
            400,
            "result_missing",
            "Recovery requires one complete result.",
        ));
    }
    let scope = format!(
        "tasks:recovery-{}:{task_id}",
        if content { "results" } else { "import" }
    );
    let ed = digest(e);
    let pd = digest(&json!([
        "briefsip-recovery-import-v1",
        generation,
        ed,
        v["signature"],
        encoded.as_ref().map(|s| hash(s))
    ]));
    let a = one(db, "SELECT * FROM authority_state WHERE id=1", [])?.ok_or_else(invalid)?;
    let recovery = a["serving_state"] == "read_only_recovery";
    if recovery {
        restore(db, actor, proof, &generation, now)?;
    }
    let t = one(db, "SELECT * FROM tasks WHERE id=?", [task_id])?;
    if t.is_none() && !recovery {
        return Err(missing());
    }
    let t = t
        .map(|_| owner(db, &actor.account, task_id, recovery))
        .transpose()?;
    if devices::decode(&json!(proof), 32).is_err() {
        return Err(invalid());
    }
    let session=one(db,"SELECT * FROM recovery_evidence_sessions WHERE id_hash=? AND recovery_generation=? AND owner_account=? AND task=? AND source_device=? AND source_generation=? AND revoked=0 AND expires_at>?",params![hash(proof),generation,actor.account,task_id,string(e,"sourceDeviceId"),n(e,"sourceDeviceGeneration"),now])?;
    if !recovery
        && (a["serving_state"] != "active"
            || session
                .as_ref()
                .is_none_or(|s| s["authority_generation"] != a["generation"]))
        || t.as_ref()
            .is_some_and(|t| t["home_device"] != e["sourceDeviceId"])
    {
        return Err(invalid());
    }
    let d = descriptor(
        db,
        &actor.account,
        string(e, "sourceDeviceId"),
        n(e, "sourceDeviceGeneration"),
    )?;
    let key = &d["signingPublicKey"];
    if d["authorityGeneration"] != e["sourceAuthority"]
        || devices::verify(
            key,
            &envelope_body(&generation, &request, e),
            &v["signature"],
        )
        .is_err()
    {
        return Err(fail(
            403,
            "recovery_signature_invalid",
            "Invalid recovery signature.",
        ));
    }
    let mut actions = Vec::new();
    for entry in entries {
        if entry["taskId"] != task_id
            || devices::verify(
                key,
                &journal_body(
                    &e["sourceAuthority"],
                    &e["sourceDeviceId"],
                    &e["sourceDeviceGeneration"],
                    entry,
                ),
                &entry["signature"],
            )
            .is_err()
        {
            return Err(fail(
                403,
                "recovery_signature_invalid",
                "Recovery journal does not match.",
            ));
        }
        actions.push(one(
            db,
            "SELECT * FROM task_actions WHERE id=?",
            [string(entry, "actionId")],
        )?);
    }
    for s in stops {
        if s["taskId"] != task_id || devices::verify(key, &stop_body(s), &s["signature"]).is_err() {
            return Err(fail(
                403,
                "recovery_signature_invalid",
                "Recovery stop does not match.",
            ));
        }
    }
    let quarantined = actions.iter().any(Option::is_none);
    if quarantined && !recovery {
        return Err(provenance());
    }
    for (entry, action) in entries.iter().zip(&actions) {
        if action.as_ref().is_some_and(|a| {
            a["task"] != task_id
                || a["authority_generation"] != e["sourceAuthority"]
                || a["device_generation"] != e["sourceDeviceGeneration"]
                || a["executor_generation"] != entry["executorGeneration"]
        }) {
            return Err(provenance());
        }
    }
    if content && quarantined {
        return Err(fail(
            404,
            "resource_not_found",
            "Quarantined result cannot be published.",
        ));
    }
    let receipt_task = if quarantined {
        json!({"project":null})
    } else {
        t.clone().unwrap_or_else(|| json!({"project":null}))
    };
    if let Some(old) = one(db, "SELECT * FROM receipts WHERE request_id=?", [&request])? {
        if old["actor"] != actor.account
            || old["project"] != receipt_task["project"]
            || old["scope"] != scope
            || old["payload_digest"] != pd
        {
            return Err(changed("Recovery request changed."));
        }
        let mut r = data::json(&old["result_json"])?;
        r["status"] = json!(200);
        return Ok(r);
    }
    let latest=one(db,"SELECT max(watermark) watermark FROM recovery_imports WHERE recovery_generation=? AND source_device=? AND source_authority=?",[&generation,string(e,"sourceDeviceId"),string(e,"sourceAuthority")])?.ok_or_else(Failure::storage)?;
    let batch=one(db,"SELECT envelope_digest FROM recovery_imports WHERE recovery_generation=? AND source_device=? AND source_authority=? AND watermark=?",params![generation,string(e,"sourceDeviceId"),string(e,"sourceAuthority"),n(e,"watermark")])?;
    let completing = content && batch.as_ref().is_some_and(|b| b["envelope_digest"] == ed);
    if !latest["watermark"].is_null() && n(e, "watermark") <= n(&latest, "watermark") && !completing
    {
        return Err(changed("Recovery watermark did not advance."));
    }
    let mut updates = Vec::new();
    for (entry, action) in entries.iter().zip(&actions) {
        let Some(action) = action else {
            continue;
        };
        let prepare=one(db,"SELECT result_json FROM receipts WHERE scope=? AND json_extract(result_json,'$.receipt.recordId')=?",[format!("tasks:prepare:{task_id}"),string(entry,"actionId").to_owned()])?.map(|r|data::json(&r["result_json"])).transpose()?;
        if prepare
            .as_ref()
            .is_none_or(|p| p["input"]["payloadDigest"] != entry["payloadDigest"])
            || [
                ("sequence", "sequence"),
                ("action_kind", "actionKind"),
                ("intent_digest", "intentDigest"),
                ("binding_id", "bindingId"),
                ("binding_revision", "bindingRevision"),
                ("grant_revision", "grantRevision"),
            ]
            .iter()
            .any(|(a, b)| action[a] != entry[b])
        {
            return Err(provenance());
        }
        let prior = one(
            db,
            "SELECT payload_json FROM task_reports WHERE action=?",
            [string(entry, "actionId")],
        )?
        .map(|r| data::json(&r["payload_json"]))
        .transpose()?
        .unwrap_or(Value::Null);
        let saved = one(
            db,
            "SELECT digest,content_json FROM task_results WHERE action=?",
            [string(entry, "actionId")],
        )?;
        let known = matches!(string(entry, "state"), "reported" | "acknowledged");
        if known && action["committed_at"].is_null() {
            return Err(fail(
                403,
                "recovery_provenance_invalid",
                "Recovery result requires a committed action.",
            ));
        }
        if saved
            .as_ref()
            .is_some_and(|s| !known || s["digest"] != entry["resultDigest"])
            || !prior["resultDigest"].is_null() && prior["resultDigest"] != entry["resultDigest"]
            || prior["state"] == "not_sent" && entry["state"] != "not_sent"
        {
            return Err(changed("Final evidence cannot be changed."));
        }
        if saved.as_ref().is_some_and(|s| {
            string(s, "content_json").len() as i64 != n(&entry["resultRef"], "size")
        }) {
            return Err(fail(
                409,
                "result_digest_mismatch",
                "Recovery result size does not match.",
            ));
        }
        if !prior["journalSequence"].is_null()
            && n(entry, "journalSequence") < n(&prior, "journalSequence")
            && !completing
        {
            return Err(changed("Recovery journal moved backwards."));
        }
        if let Some(s) = stops.iter().find(|s| s["actionId"] == entry["actionId"]) {
            let lock=one(db,"SELECT lock_proof_json FROM execution_owners WHERE task=? AND authority_generation=? AND device_generation=? AND executor_generation=?",params![task_id,string(e,"sourceAuthority"),n(e,"sourceDeviceGeneration"),n(entry,"executorGeneration")])?.map(|r|data::json(&r["lock_proof_json"])).transpose()?.ok_or_else(||fail(403,"stop_evidence_invalid","Recovery stop evidence does not match."))?;
            verify_stop(
                key,
                entry,
                s,
                action,
                &lock,
                (
                    &e["sourceAuthority"],
                    &e["sourceDeviceId"],
                    &e["sourceDeviceGeneration"],
                ),
                now,
            )?;
        }
        if let Some(encoded) = encoded.as_ref().filter(|_| content) {
            if hash(encoded) != entry["resultDigest"]
                || encoded.len() as i64 != n(&entry["resultRef"], "size")
                || saved
                    .as_ref()
                    .is_some_and(|s| s["content_json"] != *encoded)
            {
                return Err(fail(
                    409,
                    "result_digest_mismatch",
                    "Recovery result content does not match.",
                ));
            }
            if entry["actionKind"] == "canonical" && saved.is_none() {
                return Err(fail(
                    409,
                    "canonical_result_required",
                    "Canonical result must come from the tool RPC.",
                ));
            }
        }
        let report = if n(&prior, "journalSequence") > n(entry, "journalSequence") {
            prior
        } else {
            entry.clone()
        };
        updates.push((
            entry,
            report,
            known,
            known && (saved.is_some() || content),
            saved.is_some(),
        ));
    }
    let missing = updates
        .iter()
        .any(|(_, _, known, published, _)| *known && !*published);
    let uncertain = updates
        .iter()
        .any(|(e, _, known, _, _)| !*known && e["state"] != "not_sent");
    let rev = t
        .as_ref()
        .map(|t| n(t, "revision") + i64::from(!updates.is_empty()))
        .unwrap_or(1);
    let mut value = json!({"taskId":task_id,"watermark":e["watermark"],"state":if quarantined{"quarantined"}else if missing{"result_missing"}else{"recovered"},"dispatchable":false,"importedActionIds":updates.iter().map(|(e,..)|e["actionId"].clone()).collect::<Vec<_>>(),"quarantinedActionIds":entries.iter().zip(&actions).filter(|(_,a)|a.is_none()).map(|(e,_)|e["actionId"].clone()).collect::<Vec<_>>()});
    if content {
        value["actionId"] = entries[0]["actionId"].clone();
        value["resultRef"] = entries[0]["resultRef"].clone();
    }
    let result = Save {
        account: &actor.account,
        task: &receipt_task,
        request: &request,
        scope: &scope,
        payload: &pd,
        now,
    }
    .save(
        db,
        if content {
            string(&entries[0], "actionId")
        } else {
            task_id
        },
        rev,
        200,
        value,
        None,
    )?;
    if batch.is_none() {
        db.execute(
            "INSERT INTO recovery_imports VALUES(?,?,?,?,?,?,?)",
            params![
                request,
                string(e, "sourceDeviceId"),
                string(e, "sourceAuthority"),
                n(e, "watermark"),
                generation,
                ed,
                e.to_string()
            ],
        )?;
    }
    for (entry, action) in entries.iter().zip(&actions) {
        if action.is_none() {
            db.execute("INSERT INTO recovery_quarantine VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",params![request,actor.account,task_id,string(entry,"actionId"),string(e,"sourceDeviceId"),string(e,"sourceAuthority"),generation,n(e,"watermark"),ed,json!({"requestId":request,"recoveryGeneration":generation,"envelope":e,"signature":v["signature"]}).to_string(),"post_backup_unknown",now])?;
        }
    }
    for (entry, mut report, known, published, saved) in updates {
        if content && !saved {
            let encoded = encoded.as_ref().ok_or_else(Failure::storage)?;
            db.execute(
                "INSERT INTO task_results VALUES(?,?,?,?,?,?,?)",
                params![
                    string(entry, "actionId"),
                    task_id,
                    string(entry, "resultDigest"),
                    encoded.len() as i64,
                    "canonical-json-v1",
                    encoded,
                    now
                ],
            )?;
        }
        let state = if published {
            "acknowledged"
        } else if entry["state"] == "not_sent" {
            "not_sent"
        } else if known {
            "reported"
        } else {
            "uncertain"
        };
        report["v"] = json!(1);
        report["resultMissing"] = json!(known && !published);
        db.execute("INSERT INTO task_reports VALUES(?,?,?,?,?,?,?) ON CONFLICT(action) DO UPDATE SET report_digest=excluded.report_digest,journal_sequence=excluded.journal_sequence,payload_json=excluded.payload_json,result_ref=excluded.result_ref,receipt_id=excluded.receipt_id",params![string(entry,"actionId"),ed,string(e,"sourceDeviceId"),n(&report,"journalSequence"),canonical(&report),if published{Some(string(entry,"actionId"))}else{None},request])?;
        db.execute("UPDATE task_actions SET state=?,effect_status=?,result_digest=?,uncertain_reason=? WHERE id=?",params![state,if known{"known"}else if state=="not_sent"{"none"}else{"unknown"},if known{Some(string(entry,"resultDigest"))}else{None},if state=="uncertain"{Some("Recovery evidence has not resolved the outcome yet.")}else{None},string(entry,"actionId")])?;
    }
    if let Some(t) = t.filter(|_| rev > 0 && entries.iter().zip(&actions).any(|(_, a)| a.is_some()))
    {
        db.execute("UPDATE tasks SET state=CASE WHEN ?=1 AND state NOT IN('completed','failed','cancelled','transferred','paused') THEN 'uncertain' ELSE state END,revision=? WHERE id=?",params![i64::from(uncertain),rev,task_id])?;
        if !recovery {
            observe(db, &t, now)?;
        }
    }
    Ok(result)
}
