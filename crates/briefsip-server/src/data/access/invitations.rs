use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use ring::{aead, hmac};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

fn limited(key: String, limit: usize, spend: bool, now: i64) -> Result<()> {
    static BUCKETS: OnceLock<Mutex<HashMap<String, (i64, usize)>>> = OnceLock::new();
    let mut buckets = BUCKETS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| Failure::storage())?;
    buckets.retain(|_, (until, _)| *until > now);
    let bucket = buckets.get(&key).copied();
    if bucket.is_some_and(|(_, count)| count >= limit) || bucket.is_none() && buckets.len() >= 8192
    {
        let mut e = Failure::new(429, "rate_limited", "Too many attempts. Try again later.");
        e.retryable = true;
        e.details = Some(json!({"retryAfterMs":bucket.map_or(60000,|(until,_)|until-now)}));
        return Err(e);
    }
    if spend {
        buckets.insert(
            key,
            (
                bucket.map_or(now + 60000, |(until, _)| until),
                bucket.map_or(1, |(_, count)| count + 1),
            ),
        );
    }
    Ok(())
}
fn generation(db: &Connection) -> Result<String> {
    active(db)?;
    Ok(string(
        &one(db, "SELECT generation FROM authority_state WHERE id=1", [])?
            .ok_or_else(Failure::storage)?,
        "generation",
    )
    .into())
}
fn assignments(db: &Connection, project: &str, expected: &Value, entries: &Value) -> Result<()> {
    if one(
        db,
        "SELECT revision FROM projects WHERE id=? AND deleted=0",
        [project],
    )?
    .is_none_or(|r| r["revision"] != *expected)
    {
        return Err(stale());
    }
    for a in entries.as_array().ok_or_else(Failure::storage)? {
        let row = agent(db, project, string(a, "agentId"))?;
        if row["agent_revision"] != a["expectedAgentRevision"]
            || row["participation_revision"] != a["expectedParticipationRevision"]
        {
            return Err(stale());
        }
    }
    Ok(())
}
fn parse(v: &Value) -> Result<Value> {
    fields(
        v,
        &[
            "requestId",
            "email",
            "agentAssignments",
            "expiresAt",
            "expectedProjectRevision",
        ],
    )?;
    let mut entries = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for a in v["agentAssignments"].as_array().ok_or_else(|| {
        Failure::new(
            400,
            "invalid_assignments",
            "agentAssignments must be an array.",
        )
    })? {
        fields(
            a,
            &[
                "agentId",
                "expectedAgentRevision",
                "expectedParticipationRevision",
                "enabled",
                "respond",
            ],
        )?;
        let aid = id(&a["agentId"])?;
        if !seen.insert(aid.clone()) {
            return Err(Failure::new(
                400,
                "duplicate_agent",
                "Duplicate agent assignment.",
            ));
        }
        let mut entry = json!({"agentId":aid,"expectedAgentRevision":revision(&a["expectedAgentRevision"])?,"expectedParticipationRevision":revision(&a["expectedParticipationRevision"])?});
        for k in ["enabled", "respond"] {
            if a.get(k).is_some_and(|v| !v.is_boolean()) {
                return Err(Failure::new(400, "invalid_flag", "Flag must be a boolean."));
            }
            entry[k] = json!(a[k].as_bool().unwrap_or(true));
        }
        entries.push(entry);
    }
    entries.sort_by(|a, b| string(a, "agentId").cmp(string(b, "agentId")));
    if !integer(&v["expiresAt"], 0, 9_007_199_254_740_991) {
        return Err(Failure::new(
            400,
            "invalid_time",
            "Time must be a nonnegative epoch timestamp in milliseconds.",
        ));
    }
    Ok(
        json!({"requestId":id(&v["requestId"])?,"email":normalize_email(&v["email"])?,"agentAssignments":entries,"expiresAt":v["expiresAt"],"expectedProjectRevision":revision(&v["expectedProjectRevision"])?}),
    )
}
fn lookup(email: &str, key: &[u8]) -> String {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), email.as_bytes())
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn equal(a: &str, b: &str) -> bool {
    use subtle::ConstantTimeEq;
    a.as_bytes().ct_eq(b.as_bytes()).into()
}
fn encrypt(
    invitation: &str,
    generation: &str,
    email_hash: &str,
    payload: &Value,
    key_id: &str,
    key: &[u8],
) -> Result<(Vec<u8>, String)> {
    let mut nonce = [0; 12];
    getrandom::getrandom(&mut nonce).map_err(|_| Failure::storage())?;
    let aad = json!([
        "briefsip-mail-outbox-v1",
        invitation,
        1,
        generation,
        email_hash
    ])
    .to_string();
    let plain = payload.to_string();
    let mut bytes = plain.as_bytes().to_vec();
    let key = aead::UnboundKey::new(&aead::AES_256_GCM, key)
        .map_err(|_| super::super::options::unavailable(true))?;
    let tag = aead::LessSafeKey::new(key)
        .seal_in_place_separate_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(aad.as_bytes()),
            &mut bytes,
        )
        .map_err(|_| Failure::storage())?;
    let envelope = json!({"v":1,"alg":"AES-256-GCM","keyId":key_id,"nonce":B64.encode(nonce),"ciphertext":B64.encode(bytes),"tag":B64.encode(tag.as_ref())});
    Ok((
        envelope.to_string().into_bytes(),
        digest_bytes(plain.as_bytes()),
    ))
}
pub(super) fn create(
    state: &AppState,
    db: &Connection,
    account: &str,
    project: &str,
    v: &Value,
) -> Result<Value> {
    let command = parse(v)?;
    let request = string(&command, "requestId");
    let scope = format!("invitations:create:{project}");
    let hash = digest(json!(["briefsip-invitation-create-v1", project, command]));
    transaction(db, || {
        member(db, account, project, true)?;
        if let Some(old) = replay(db, account, request, project, &scope, &hash)? {
            return Ok(old);
        }
        let now = state.config.now();
        limited(format!("invite:{account}"), 10, true, now)?;
        let expiry = command["expiresAt"].as_i64().ok_or_else(Failure::storage)?;
        if expiry <= now || expiry > now + 86400000 {
            return Err(Failure::new(
                400,
                "invalid_expiry",
                "Invitation must expire within 24 hours.",
            ));
        }
        assignments(
            db,
            project,
            &command["expectedProjectRevision"],
            &command["agentAssignments"],
        )?;
        let config = &state.config.remaining_data;
        let (key_id, key, lookup_key) = config.mail()?;
        let generation = generation(db)?;
        let email_hash = lookup(string(&command, "email"), &lookup_key);
        if let Some(expired)=one(db,"SELECT id FROM invitations WHERE project=? AND email_hash=? AND state IN('pending_delivery','sent') AND expires_at<=?",rusqlite::params![project,email_hash,now])? {
            db.execute("UPDATE invitations SET state='expired',revision=revision+1 WHERE id=?",[string(&expired,"id")])?;
            db.execute("UPDATE mail_outbox SET state='revoked',ciphertext=X'' WHERE id=?",[string(&expired,"id")])?;
            super::super::sync::append_mutation(db, project, "invitations:expire", string(&expired,"id"), &json!({}), now)?;
        }
        if exists(db,"SELECT 1 FROM invitations WHERE project=? AND email_hash=? AND state IN('pending_delivery','sent')",[project,&email_hash])? { return Err(Failure::new(409,"invitation_exists","An active invitation already exists.")); }
        let mut token = [0; 32];
        getrandom::getrandom(&mut token).map_err(|_| Failure::storage())?;
        let agents=command["agentAssignments"].as_array().ok_or_else(Failure::storage)?.iter().map(|a|json!({"agentId":a["agentId"],"agentRevision":a["expectedAgentRevision"],"participationRevision":a["expectedParticipationRevision"],"enabled":a["enabled"],"respond":a["respond"]})).collect::<Vec<_>>();
        let snapshot =
            json!({"v":1,"projectRevision":command["expectedProjectRevision"],"agents":agents});
        let from = config
            .mail_from
            .as_deref()
            .ok_or_else(|| super::super::options::unavailable(true))?;
        let origin = config
            .mail_origin
            .as_deref()
            .or_else(|| state.config.auth.as_ref().map(|a| a.origin.as_str()))
            .ok_or_else(|| super::super::options::unavailable(true))?;
        let payload = json!({"to":command["email"],"from":from,"subject":"Briefsip project invitation","text":format!("Open {origin}/invitations/{request}#{} to join the Briefsip project.",B64.encode(token))});
        let (envelope, payload_digest) =
            encrypt(request, &generation, &email_hash, &payload, &key_id, &key)?;
        db.execute(
            "INSERT INTO invitations VALUES(?,?,?,?,NULL,'pending_delivery',?,?,?,NULL,1)",
            rusqlite::params![
                request,
                project,
                generation,
                email_hash,
                digest_bytes(&token),
                crate::db::canonical(&snapshot),
                expiry
            ],
        )?;
        db.execute(
            "INSERT INTO mail_outbox VALUES(?,1,?,'queued',NULL,NULL,0,NULL,?)",
            rusqlite::params![request, envelope, payload_digest],
        )?;
        Commit{account,project,scope:&scope,command:&command,digest:&hash}.save(db,now,201,request,1,json!({"invitationId":request,"state":"pending_delivery","expiresAt":expiry,"revision":1}))
    })
}
pub(super) fn revoke(
    state: &AppState,
    db: &Connection,
    account: &str,
    invitation: &str,
    v: &Value,
) -> Result<Value> {
    fields(v, &["requestId", "expectedRevision"])?;
    let request = id(&v["requestId"])?;
    let expected = revision(&v["expectedRevision"])?;
    let command = json!({"requestId":request,"expectedRevision":expected});
    let scope = format!("invitations:revoke:{invitation}");
    let hash = digest(json!([
        "briefsip-invitation-revoke-v1",
        invitation,
        command
    ]));
    transaction(db, || {
        let row =
            one(db, "SELECT * FROM invitations WHERE id=?", [invitation])?.ok_or_else(missing)?;
        let project = string(&row, "project");
        member(db, account, project, true)?;
        if let Some(old) = replay(db, account, &request, project, &scope, &hash)? {
            return Ok(old);
        }
        if row["authority_generation"] != generation(db)? {
            return Err(missing());
        }
        if row["revision"] != expected {
            return Err(stale());
        }
        if row["state"] == "accepted" {
            return Err(Failure::new(
                409,
                "invitation_consumed",
                "Revoke access through member controls.",
            ));
        }
        db.execute(
            "UPDATE invitations SET state='revoked',revision=revision+1 WHERE id=?",
            [invitation],
        )?;
        db.execute(
            "UPDATE mail_outbox SET state='revoked',ciphertext=X'' WHERE id=?",
            [invitation],
        )?;
        Commit {
            account,
            project,
            scope: &scope,
            command: &command,
            digest: &hash,
        }
        .save(
            db,
            state.config.now(),
            200,
            invitation,
            expected + 1,
            json!({"invitationId":invitation,"state":"revoked","revision":expected+1}),
        )
    })
}
pub async fn accept(
    state: &AppState,
    actor: &crate::auth::Actor,
    invitation: &str,
    v: &Value,
) -> Result<Response> {
    fields(v, &["requestId", "mailboxProof", "expectedRevision"])?;
    let request = id(&v["requestId"])?;
    let expected = revision(&v["expectedRevision"])?;
    let proof = string(v, "mailboxProof");
    if proof.len() != 43
        || !proof
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(Failure::new(
            400,
            "invalid_mailbox_proof",
            "Invalid mailbox proof.",
        ));
    }
    let token = B64
        .decode(proof)
        .ok()
        .filter(|b| b.len() == 32 && B64.encode(b) == proof)
        .ok_or_else(|| {
            Failure::new(
                400,
                "invalid_mailbox_proof",
                "Mailbox proof is not canonical.",
            )
        })?;
    let token_digest = digest_bytes(&token);
    let hash = digest(json!([
        "briefsip-invitation-accept-v1",
        invitation,
        request,
        token_digest,
        expected
    ]));
    let scope = format!("invitations:accept:{invitation}");
    let account = &actor.account;
    let auth = state.auth.as_ref().ok_or_else(Failure::storage)?;
    auth.require_current(&state.database, actor, state.config.now())?;
    {
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        let db = &guard.connection;
        let generation = generation(db)?;
        if exists(db, "SELECT 1 FROM receipts WHERE request_id=?", [&request])? {
            let row = one(
                db,
                "SELECT project,authority_generation FROM invitations WHERE id=?",
                [invitation],
            )?
            .filter(|r| r["authority_generation"] == generation)
            .ok_or_else(missing)?;
            let project = string(&row, "project");
            member(db, account, project, false)?;
            if let Some(old) = replay(db, account, &request, project, &scope, &hash)? {
                return envelope(old);
            }
        }
    }
    let now = state.config.now();
    limited(format!("invite:{account}"), 10, true, now)?;
    limited(format!("proof:{invitation}"), 5, false, now)?;
    let mailboxes = auth.verified_mailboxes(&state.database, actor, now).await?;
    auth.require_current(&state.database, actor, state.config.now())?;
    let guard = state.database.lock().map_err(|_| Failure::storage())?;
    let db = &guard.connection;
    envelope(transaction(db, || {
        let generation = generation(db)?;
        let row = one(db, "SELECT * FROM invitations WHERE id=?", [invitation])?
            .filter(|r| r["authority_generation"] == generation)
            .ok_or_else(missing)?;
        let now = state.config.now();
        let project = string(&row, "project");
        let failed = || {
            limited(format!("proof:{invitation}"), 5, true, now)?;
            Err(missing())
        };
        if !equal(&token_digest, string(&row, "token_digest")) {
            return failed();
        }
        let (_, _, lookup_key) = state.config.remaining_data.mail()?;
        if !mailboxes
            .iter()
            .any(|email| equal(&lookup(email, &lookup_key), string(&row, "email_hash")))
        {
            return failed();
        }
        if exists(db, "SELECT 1 FROM receipts WHERE request_id=?", [&request])? {
            member(db, account, project, false)?;
            if let Some(old) = replay(db, account, &request, project, &scope, &hash)? {
                return Ok(old);
            }
        }
        match string(&row, "state") {
            "accepted" => {
                return Err(Failure::new(
                    409,
                    "invitation_consumed",
                    "Invitation was already used.",
                ))
            }
            "revoked" | "delivery_unknown" | "failed" => return Err(missing()),
            _ => {}
        }
        if row["expires_at"].as_i64().unwrap_or(0) <= now || row["state"] == "expired" {
            return Err(Failure::new(
                410,
                "invitation_expired",
                "Invitation has expired.",
            ));
        }
        if row["revision"] != expected {
            return Err(stale());
        }
        let snapshot = json(&row["assignments_json"])?;
        if !exists(db,"SELECT 1 FROM projects p JOIN project_members m ON m.project=p.id AND m.account=p.account JOIN accounts a ON a.id=m.account WHERE p.id=? AND p.deleted=0 AND m.role='owner' AND m.deleted=0 AND a.blocked=0",[project])? { return Err(missing()); }
        let entries=snapshot["agents"].as_array().ok_or_else(Failure::storage)?.iter().map(|a|json!({"agentId":a["agentId"],"expectedAgentRevision":a["agentRevision"],"expectedParticipationRevision":a["participationRevision"]})).collect::<Vec<_>>();
        assignments(db, project, &snapshot["projectRevision"], &json!(entries))?;
        let current = one(
            db,
            "SELECT * FROM project_members WHERE project=? AND account=?",
            [project, account],
        )?;
        if current.as_ref().is_some_and(|r| r["deleted"] == 0) {
            return Err(Failure::new(
                409,
                "member_exists",
                "Account is already a project member.",
            ));
        }
        let grant = current
            .as_ref()
            .and_then(|r| r["grant_revision"].as_i64())
            .unwrap_or(0)
            + 1;
        db.execute("INSERT INTO project_members VALUES(?,?,'member',?,0) ON CONFLICT(project,account) DO UPDATE SET deleted=0,grant_revision=excluded.grant_revision",rusqlite::params![project,account,grant])?;
        let mut selected = snapshot["agents"]
            .as_array()
            .ok_or_else(Failure::storage)?
            .iter()
            .map(|a| (string(a, "agentId").to_owned(), a.clone()))
            .collect::<std::collections::BTreeMap<_, _>>();
        for old in all(
            db,
            "SELECT agent FROM collaborator_agents WHERE project=? AND account=?",
            [project, account],
        )? {
            let aid = string(&old, "agent");
            let next = selected.remove(aid).unwrap_or(Value::Null);
            db.execute("UPDATE collaborator_agents SET enabled=?,revision=revision+1 WHERE project=? AND account=? AND agent=?",rusqlite::params![i64::from(next["enabled"]==true),project,account,aid])?;
            if !exists(
                db,
                "SELECT 1 FROM response_policies WHERE project=? AND account=? AND agent=?",
                [project, account, aid],
            )? {
                return Err(Failure::new(
                    409,
                    "policy_missing",
                    "Owner must fix the response policy.",
                ));
            }
            db.execute("UPDATE response_policies SET respond=?,revision=revision+1 WHERE project=? AND account=? AND agent=?",rusqlite::params![i64::from(next["respond"]==true),project,account,aid])?;
        }
        for (aid, next) in selected {
            db.execute(
                "INSERT INTO collaborator_agents VALUES(?,?,?,?,1)",
                rusqlite::params![project, account, aid, i64::from(next["enabled"] == true)],
            )?;
            db.execute(
                "INSERT INTO response_policies VALUES(?,?,?,?,1)",
                rusqlite::params![project, account, aid, i64::from(next["respond"] == true)],
            )?;
        }
        db.execute("UPDATE invitations SET state='accepted',used_at=?,target_clerk_sub=?,revision=revision+1 WHERE id=?",rusqlite::params![now,actor.subject,invitation])?;
        db.execute(
            "UPDATE mail_outbox SET state='revoked',ciphertext=X'' WHERE id=?",
            [invitation],
        )?;
        Commit {
            account,
            project,
            scope: &scope,
            command: v,
            digest: &hash,
        }
        .save(
            db,
            now,
            200,
            invitation,
            expected + 1,
            json!({"membershipId":json!([project,account]).to_string(),"grantRevision":grant}),
        )
    })?)
}
