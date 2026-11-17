use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use ring::hmac;
use rusqlite::{named_params, OpenFlags};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};
const PAGE_BYTES: usize = 256 * 1024;
const HORIZON: i64 = 90 * 86400000;
fn resync() -> Failure {
    let mut e = Failure::new(410, "resync_required", "Reload the project snapshot.");
    e.retryable = true;
    e
}
fn invalid() -> Failure {
    Failure::new(400, "invalid_sync_cursor", "Invalid sync cursor.")
}
fn denied() -> Failure {
    Failure::new(403, "sync_scope_denied", "Project scope is unavailable.")
}
fn capacity() -> Failure {
    let mut e = Failure::new(429, "server_capacity", "Snapshot capacity is full.");
    e.retryable = true;
    e
}
fn head(db: &Connection, account: &str, project: &str, table: &str) -> Result<i64> {
    Ok(one(
        db,
        &format!("SELECT event_position FROM {table} WHERE account=? AND project=?"),
        [account, project],
    )?
    .and_then(|r| r["event_position"].as_i64())
    .unwrap_or(0))
}
fn scope(db: &Connection, account: &str, project: &str) -> Result<Value> {
    access::active(db)?;
    let row=one(db,"SELECT p.deleted,p.private,m.role,m.deleted AS revoked,m.grant_revision,a.revision,s.generation,(SELECT coalesce(sum(revision),0) FROM collaborator_agents WHERE account=m.account AND project=m.project) AS assignments,(SELECT count(*) FROM collaborator_agents WHERE account=m.account AND project=m.project) AS assignment_count,(SELECT revision FROM sync_scope_revisions WHERE project=p.id) AS scope_revision FROM projects p JOIN project_members m ON m.project=p.id JOIN accounts a ON a.id=m.account CROSS JOIN authority_state s WHERE p.id=? AND m.account=? AND s.id=1",[project,account])?.ok_or_else(denied)?;
    let generation = access::digest(json!([
        "briefsip-sync-authorization-v1",
        row["role"],
        row["grant_revision"],
        row["revision"],
        row["assignments"],
        row["assignment_count"],
        row["private"],
        row["deleted"],
        row["revoked"],
        row["scope_revision"]
    ]));
    Ok(
        json!({"accountId":account,"projectId":project,"authorityGeneration":row["generation"],"authorizationGeneration":generation}),
    )
}
fn encode(options: &options::Options, mut value: Value) -> Result<String> {
    value["v"] = json!(1);
    let body = B64.encode(crate::db::canonical(&value));
    let signature = hmac::sign(
        &hmac::Key::new(hmac::HMAC_SHA256, &options.sync_key()?),
        body.as_bytes(),
    );
    Ok(format!("{body}.{}", B64.encode(signature.as_ref())))
}
fn cursor(options: &options::Options, scope: &Value, position: i64, now: i64) -> Result<String> {
    let mut value = scope.clone();
    value["position"] = json!(position);
    value["issuedAt"] = json!(now);
    encode(options, value)
}
fn decode(
    options: &options::Options,
    token: &str,
    page: bool,
    scope: &Value,
    now: i64,
) -> Result<Value> {
    if token.len() > 4096 {
        return Err(invalid());
    }
    let (body, signature) = token.split_once('.').ok_or_else(invalid)?;
    let signature = B64
        .decode(signature)
        .ok()
        .filter(|bytes| bytes.len() == 32 && B64.encode(bytes) == signature)
        .ok_or_else(invalid)?;
    hmac::verify(
        &hmac::Key::new(hmac::HMAC_SHA256, &options.sync_key()?),
        body.as_bytes(),
        &signature,
    )
    .map_err(|_| invalid())?;
    let bytes = B64
        .decode(body)
        .ok()
        .filter(|b| B64.encode(b) == body)
        .ok_or_else(invalid)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let keys = if page {
        vec![
            "v",
            "authorityGeneration",
            "accountId",
            "projectId",
            "authorizationGeneration",
            "snapshotId",
            "pageNumber",
            "expiresAt",
        ]
    } else {
        vec![
            "v",
            "authorityGeneration",
            "accountId",
            "projectId",
            "authorizationGeneration",
            "position",
            "issuedAt",
        ]
    };
    if !closed(&value, &keys)
        || value["v"] != 1
        || !string(&value, "authorizationGeneration")
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        || string(&value, "authorizationGeneration").len() != 64
    {
        return Err(invalid());
    }
    for key in ["accountId", "projectId", "authorityGeneration"]
        .into_iter()
        .chain(page.then_some("snapshotId"))
    {
        if crate::web::id(string(&value, key)).as_deref() != Some(string(&value, key)) {
            return Err(invalid());
        }
    }
    for key in if page {
        ["pageNumber", "expiresAt"]
    } else {
        ["position", "issuedAt"]
    } {
        if !integer(&value[key], 0, 9_007_199_254_740_991) {
            return Err(invalid());
        }
    }
    if value["accountId"] != scope["accountId"] || value["projectId"] != scope["projectId"] {
        return Err(Failure::new(
            403,
            "sync_cursor_scope",
            "Cursor belongs to another scope.",
        ));
    }
    if value["authorityGeneration"] != scope["authorityGeneration"]
        || value["authorizationGeneration"] != scope["authorizationGeneration"]
    {
        return Err(resync());
    }
    if !page {
        let issued = value["issuedAt"].as_i64().ok_or_else(invalid)?;
        if issued > now {
            return Err(invalid());
        }
        if issued < now - HORIZON {
            return Err(resync());
        }
    }
    Ok(value)
}
fn response(scope: &Value, high: i64, floor: i64) -> Value {
    json!({"v":1,"mode":"delta","authorityGeneration":scope["authorityGeneration"],"projectId":scope["projectId"],"snapshotId":null,"snapshotHash":null,"highWaterPosition":high,"page":{"events":[],"pageNumber":0},"nextPage":null,"nextCursor":null,"retentionFloor":floor})
}
fn event(row: &Value, position: i64, at: i64) -> Result<Value> {
    Ok(
        json!({"position":position,"recordKind":row["kind"],"recordId":row["id"],"revision":row["revision"],"operation":row["operation"],"body":json(&row["body"])?,"committedAt":at}),
    )
}
struct Snapshot {
    scope: Value,
    id: String,
    reader: Option<Connection>,
    high: i64,
    started: i64,
    expires: i64,
    wal: u64,
    after_kind: String,
    after_id: String,
    hash: sha2::Sha256,
    count: usize,
    order: u64,
    last_page: i64,
    cache: Option<Value>,
}
fn snapshots() -> &'static Mutex<HashMap<String, Snapshot>> {
    static STORE: OnceLock<Mutex<HashMap<String, Snapshot>>> = OnceLock::new();
    STORE.get_or_init(Default::default)
}
fn wal_size(state: &AppState) -> u64 {
    std::fs::metadata(format!("{}-wal", state.config.database.display()))
        .map(|m| m.len())
        .unwrap_or(0)
}
fn visible(db: &Connection, scope: &Value, events: &[Value]) -> Result<()> {
    let records = super::sync_projection::records(db)?;
    for e in events {
        if [
            "task",
            "device",
            "workflow",
            "workflow_run",
            "workflow_notification",
            "workflow_schedule",
            "workflow_schedule_occurrence",
            "routine",
            "routine_flow",
            "routine_occurrence",
        ]
        .contains(&string(e, "recordKind"))
        {
            let found = all(
                db,
                &format!("{records}SELECT 1 FROM records WHERE kind=$kind AND id=$id"),
                named_params! {"$account":string(scope,"accountId"),"$project":string(scope,"projectId"),"$kind":string(e,"recordKind"),"$id":string(e,"recordId")},
            )?;
            if found.is_empty() {
                return Err(resync());
            }
        }
    }
    Ok(())
}
fn snapshot_page(
    state: &AppState,
    snapshot: &mut Snapshot,
    page: i64,
    floor: i64,
) -> Result<Value> {
    use sha2::Digest;
    if snapshot.last_page == page {
        if let Some(cache) = &snapshot.cache {
            return Ok(cache.clone());
        }
    }
    if page != snapshot.last_page + 1 {
        return Err(Failure::new(
            409,
            "sync_page_conflict",
            "Invalid snapshot page order.",
        ));
    }
    let reader = snapshot
        .reader
        .as_ref()
        .ok_or_else(|| Failure::new(409, "sync_page_conflict", "Invalid snapshot page order."))?;
    let records = super::sync_projection::records(reader)?;
    let mut statement = reader.prepare(&format!("{records}SELECT kind,id,revision,operation,body FROM records WHERE kind>$kind OR(kind=$kind AND id>$id) ORDER BY kind COLLATE BINARY,id COLLATE BINARY LIMIT 501"))?;
    let mut rows = statement.query(named_params!{"$account":string(&snapshot.scope,"accountId"),"$project":string(&snapshot.scope,"projectId"),"$kind":snapshot.after_kind,"$id":snapshot.after_id})?;
    let mut result = response(&snapshot.scope, snapshot.high, floor);
    result["mode"] = json!("snapshot");
    result["snapshotId"] = json!(snapshot.id);
    result["page"]["pageNumber"] = json!(page);
    let mut events = Vec::new();
    let mut bytes = 0;
    let mut more = false;
    while let Some(row) = rows.next()? {
        let row = json!({"kind":row.get::<_,String>(0)?,"id":row.get::<_,String>(1)?,"revision":row.get::<_,i64>(2)?,"operation":row.get::<_,String>(3)?,"body":row.get::<_,String>(4)?});
        let item = event(&row, snapshot.high, snapshot.started)?;
        let encoded = crate::db::canonical(&item);
        let size = encoded.len();
        if size > PAGE_BYTES - 8192 {
            return Err(Failure::new(
                413,
                "sync_record_too_large",
                "Sync record exceeds the page limit.",
            ));
        }
        if events.len() >= 500 || bytes + size > PAGE_BYTES - 8192 {
            more = true;
            break;
        }
        if snapshot.count > 0 {
            snapshot.hash.update(",");
        }
        snapshot.hash.update(encoded);
        snapshot.count += 1;
        snapshot.after_kind = string(&item, "recordKind").into();
        snapshot.after_id = string(&item, "recordId").into();
        events.push(item);
        bytes += size + 1;
    }
    drop(rows);
    drop(statement);
    result["page"]["events"] = json!(events);
    if more {
        let mut token = snapshot.scope.clone();
        token["snapshotId"] = json!(snapshot.id);
        token["pageNumber"] = json!(page + 1);
        token["expiresAt"] = json!(snapshot.expires);
        result["nextPage"] = json!(encode(&state.config.remaining_data, token)?);
    } else {
        snapshot.hash.update("]");
        result["snapshotHash"] = json!(format!("{:x}", snapshot.hash.clone().finalize()));
        result["nextCursor"] = json!(cursor(
            &state.config.remaining_data,
            &snapshot.scope,
            snapshot.high,
            state.config.now()
        )?);
        snapshot.reader = None;
    }
    if json!({"ok":true,"data":result}).to_string().len() > PAGE_BYTES {
        return Err(Failure::storage());
    }
    snapshot.last_page = page;
    snapshot.cache = Some(result.clone());
    Ok(result)
}
pub(super) fn read(state: &AppState, account: &str, q: &[(String, String)]) -> Result<Response> {
    let guard = state.database.lock().map_err(|_| Failure::storage())?;
    transaction(&guard.connection, || {
        read_locked(state, &guard.connection, account, q)
    })
}
fn read_locked(
    state: &AppState,
    db: &Connection,
    account: &str,
    q: &[(String, String)],
) -> Result<Response> {
    let parameter_error = || Failure::new(400, "invalid_sync_route", "Invalid sync parameters.");
    if !crate::files::query_keys(q, &["projectId", "cursor", "page"])
        || param(q, "projectId").is_none()
    {
        return Err(parameter_error());
    }
    let project = access::id(&json!(param(q, "projectId")))?;
    let now = state.config.now();
    let options = &state.config.remaining_data;
    if !exists(db,"SELECT 1 FROM projects p JOIN project_members m ON m.project=p.id WHERE p.id=? AND m.account=? AND p.deleted=0 AND m.deleted=0",[project.as_str(),account])? {
        snapshots().lock().map_err(|_|Failure::storage())?.retain(|_,s|s.scope["accountId"]!=account || s.scope["projectId"]!=project);
        return Err(denied());
    }
    let scope = match scope(db, account, &project) {
        Ok(scope) => scope,
        Err(e) => {
            snapshots()
                .lock()
                .map_err(|_| Failure::storage())?
                .retain(|_, s| s.scope["accountId"] != account || s.scope["projectId"] != project);
            return Err(e);
        }
    };
    let mut snapshots = snapshots().lock().map_err(|_| Failure::storage())?;
    let wal = wal_size(state);
    let floor = head(db, account, &project, "retention_floors")?;
    snapshots.retain(|_, s| {
        s.expires > now
            && (s.reader.is_none() || wal.saturating_sub(s.wal) <= 32 * 1024 * 1024)
            && (s.scope["accountId"] != account
                || s.scope["projectId"] != project
                || s.high >= floor)
    });
    if param(q, "cursor").is_some() && param(q, "page").is_some() {
        return Err(invalid());
    }
    let decode = |token: &str, page, snapshots: &mut HashMap<String, Snapshot>| {
        let result = decode(options, token, page, &scope, now);
        if result.as_ref().is_err_and(|e| e.code == "resync_required") {
            snapshots
                .retain(|_, s| s.scope["accountId"] != account || s.scope["projectId"] != project);
        }
        result
    };
    if let Some(token) = param(q, "cursor") {
        let value = decode(token, false, &mut snapshots)?;
        let position = value["position"].as_i64().ok_or_else(invalid)?;
        let high = head(db, account, &project, "sync_heads")?;
        if position < floor || position > high {
            return Err(resync());
        }
        let mut result = response(&scope, high, floor);
        let mut previous = position;
        let mut bytes = 0;
        let mut events = Vec::new();
        let mut more = false;
        for row in all(db,"SELECT position,previous_position,record_kind AS kind,record_id AS id,revision,operation,body_json AS body,committed_at FROM sync_events WHERE account=? AND project=? AND position>? ORDER BY position LIMIT 501",rusqlite::params![account,project,position])? {
            if row["previous_position"]!=previous { return Err(resync()); }
            let next=row["position"].as_i64().ok_or_else(Failure::storage)?;let item=event(&row,next,row["committed_at"].as_i64().ok_or_else(Failure::storage)?)?;let size=crate::db::canonical(&item).len();
            if size>PAGE_BYTES-8192 { return Err(Failure::storage()); }
            if events.len()>=500 || bytes+size>PAGE_BYTES-8192 { more=true;break; }
            previous=next;bytes+=size+1;events.push(item);
        }
        if !more && previous != high {
            return Err(resync());
        }
        visible(db, &scope, &events)?;
        result["page"]["events"] = json!(events);
        result["nextCursor"] = json!(cursor(options, &scope, previous, now)?);
        return Ok(json_response(200, json!({"ok":true,"data":result})));
    }
    let (snapshot_id, page) = if let Some(token) = param(q, "page") {
        let value = decode(token, true, &mut snapshots)?;
        let sid = string(&value, "snapshotId").to_owned();
        let snapshot = snapshots
            .get(&sid)
            .filter(|s| s.expires == value["expiresAt"].as_i64().unwrap_or(0))
            .ok_or_else(resync)?;
        if snapshot.scope != scope {
            return Err(resync());
        }
        (sid, value["pageNumber"].as_i64().ok_or_else(invalid)?)
    } else {
        use sha2::Digest;
        options.sync_key()?;
        if snapshots.values().filter(|s| s.reader.is_some()).count() >= 8
            || snapshots
                .values()
                .filter(|s| s.reader.is_some() && s.scope["projectId"] == project)
                .count()
                >= 2
        {
            return Err(capacity());
        }
        while snapshots.len() >= 8 {
            let key = snapshots
                .iter()
                .filter(|(_, s)| s.reader.is_none())
                .min_by_key(|(_, s)| s.order)
                .map(|(k, _)| k.clone())
                .ok_or_else(capacity)?;
            snapshots.remove(&key);
        }
        let reader =
            Connection::open_with_flags(&state.config.database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        reader.execute_batch("PRAGMA query_only=ON; BEGIN")?;
        let high = head(&reader, account, &project, "sync_heads")?;
        if self::scope(&reader, account, &project)? != scope {
            return Err(resync());
        }
        let sid = uuid::Uuid::new_v4().to_string();
        let mut hash = sha2::Sha256::new();
        hash.update("[");
        static ORDER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        snapshots.insert(
            sid.clone(),
            Snapshot {
                scope: scope.clone(),
                id: sid.clone(),
                reader: Some(reader),
                high,
                started: now,
                expires: now + 60000,
                wal,
                after_kind: String::new(),
                after_id: String::new(),
                hash,
                count: 0,
                order: ORDER.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                last_page: -1,
                cache: None,
            },
        );
        (sid, 0)
    };
    let result = (|| {
        let snapshot = snapshots.get_mut(&snapshot_id).ok_or_else(resync)?;
        let result = snapshot_page(state, snapshot, page, floor)?;
        visible(
            db,
            &scope,
            result["page"]["events"]
                .as_array()
                .ok_or_else(Failure::storage)?,
        )?;
        Ok(result)
    })();
    match result {
        Ok(result) => Ok(json_response(200, json!({"ok":true,"data":result}))),
        Err(e) => {
            snapshots.remove(&snapshot_id);
            Err(e)
        }
    }
}
pub(super) fn maintain(state: &AppState) -> Result<()> {
    let guard = state.database.lock().map_err(|_| Failure::storage())?;
    let db = &guard.connection;
    let now = state.config.now();
    transaction(db, || {
        for row in all(db, "SELECT position,account,project FROM sync_events WHERE committed_at<? ORDER BY position LIMIT 500", [now - HORIZON])? {
            db.execute("INSERT INTO retention_floors VALUES(?,?,?,?) ON CONFLICT(account,project) DO UPDATE SET event_position=max(event_position,excluded.event_position),updated_at=max(updated_at,excluded.updated_at)", rusqlite::params![row["account"].as_str(),row["project"].as_str(),row["position"].as_i64(),now])?;
            db.execute("DELETE FROM sync_events WHERE position=?", [row["position"].as_i64()])?;
        }
        Ok(())
    })?;
    let mut snapshots = snapshots().lock().map_err(|_| Failure::storage())?;
    let wal = wal_size(state);
    let mut expired = Vec::new();
    for (key, snapshot) in snapshots.iter() {
        if snapshot.expires <= now
            || snapshot.reader.is_some() && wal.saturating_sub(snapshot.wal) > 32 * 1024 * 1024
            || head(
                db,
                string(&snapshot.scope, "accountId"),
                string(&snapshot.scope, "projectId"),
                "retention_floors",
            )? > snapshot.high
        {
            expired.push(key.clone());
        }
    }
    for key in expired {
        snapshots.remove(&key);
    }
    Ok(())
}
pub(crate) fn append_mutation(
    db: &Connection,
    project: &str,
    mutation: &str,
    record: &str,
    body: &Value,
    now: i64,
) -> Result<()> {
    let records = super::sync_projection::records(db)?;
    let mut changes: Vec<(String, String)> = Vec::new();
    let kind = mutation.split(':').next().unwrap_or("");
    match kind {
        "projects" => changes.push(("project".into(), project.into())),
        "agents" => {
            changes.push(("agent".into(), record.into()));
            if mutation.starts_with("agents:create:") {
                changes.push(("task".into(), record.into()));
            }
        }
        "response-policy" => changes.push((
            "response_policy".into(),
            json!([project, body["accountId"], body["agentId"]]).to_string(),
        )),
        "invitations" => changes.push(("invitation".into(), record.into())),
        _ => {}
    }
    if mutation.starts_with("agents:participation:") {
        for row in all(
            db,
            "SELECT account FROM collaborator_agents WHERE project=? AND agent=? ORDER BY account",
            [project, record],
        )? {
            for k in ["assignment", "response_policy"] {
                changes.push((
                    k.into(),
                    json!([project, row["account"], record]).to_string(),
                ));
            }
        }
    }
    let membership = if kind == "members" {
        Some(record.to_owned())
    } else {
        body["membershipId"]
            .as_str()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .and_then(|v| v[1].as_str().map(str::to_owned))
    };
    if let Some(member) = membership {
        changes.push(("member".into(), json!([project, member]).to_string()));
        for row in all(
            db,
            "SELECT agent FROM collaborator_agents WHERE project=? AND account=? ORDER BY agent",
            [project, &member],
        )? {
            for k in ["assignment", "response_policy"] {
                changes.push((k.into(), json!([project, member, row["agent"]]).to_string()));
            }
        }
    }
    for viewer in all(
        db,
        "SELECT account FROM project_members WHERE project=? AND deleted=0 ORDER BY account",
        [project],
    )? {
        let account = string(&viewer, "account");
        let scope = scope(db, account, project)?;
        for (kind, id) in &changes {
            let row=all(db,&format!("{records}SELECT kind,id,revision,operation,body FROM records WHERE kind=$kind AND id=$id"),named_params!{"$account":account,"$project":project,"$kind":kind,"$id":id})?.into_iter().next();
            if let Some(row) = row {
                if string(&row, "body").len() > PAGE_BYTES - 10000 {
                    return Err(Failure::new(
                        413,
                        "sync_record_too_large",
                        "Sync record exceeds the page limit.",
                    ));
                }
                db.execute("INSERT INTO sync_events(account,project,authorization_generation,previous_position,record_kind,record_id,revision,operation,body_json,committed_at) VALUES(?,?,?,?,?,?,?,?,?,?)",rusqlite::params![account,project,string(&scope,"authorizationGeneration"),head(db,account,project,"sync_heads")?,kind,id,row["revision"].as_i64(),row["operation"].as_str(),row["body"].as_str(),now])?;
                db.execute("INSERT INTO sync_heads VALUES(?,?,?) ON CONFLICT(account,project) DO UPDATE SET event_position=excluded.event_position",rusqlite::params![account,project,db.last_insert_rowid()])?;
            }
        }
    }
    Ok(())
}

pub(crate) fn append_record(
    db: &Connection,
    project: &str,
    kind: &str,
    id: &str,
    reader: Option<&str>,
    now: i64,
) -> Result<()> {
    if db.is_autocommit() {
        return Err(Failure::storage());
    }
    let records = super::sync_projection::records(db)?;
    for viewer in all(
        db,
        "SELECT account FROM project_members WHERE project=? AND deleted=0 AND (? IS NULL OR account=?) ORDER BY account",
        rusqlite::params![project, reader, reader],
    )? {
        let account = string(&viewer, "account");
        let scope = scope(db, account, project)?;
        let row = all(
            db,
            &format!(
                "{records}SELECT revision,operation,body FROM records WHERE kind=$kind AND id=$id"
            ),
            named_params! {"$account":account,"$project":project,"$kind":kind,"$id":id},
        )?
        .into_iter()
        .next();
        if let Some(row) = row {
            if string(&row, "body").len() > PAGE_BYTES - 10000 {
                return Err(Failure::new(
                    413,
                    "sync_record_too_large",
                    "Sync record exceeds the page limit.",
                ));
            }
            db.execute("INSERT INTO sync_events(account,project,authorization_generation,previous_position,record_kind,record_id,revision,operation,body_json,committed_at) VALUES(?,?,?,?,?,?,?,?,?,?)", rusqlite::params![account,project,string(&scope,"authorizationGeneration"),head(db,account,project,"sync_heads")?,kind,id,row["revision"].as_i64(),row["operation"].as_str(),row["body"].as_str(),now])?;
            db.execute("INSERT INTO sync_heads VALUES(?,?,?) ON CONFLICT(account,project) DO UPDATE SET event_position=excluded.event_position", rusqlite::params![account,project,db.last_insert_rowid()])?;
        }
    }
    Ok(())
}

pub(crate) fn append_device(db: &Connection, device: &str, now: i64) -> Result<()> {
    for row in all(db, "SELECT id FROM projects WHERE account=(SELECT account FROM devices WHERE id=?) AND deleted=0 ORDER BY id", [device])? {
        append_record(db, string(&row, "id"), "device", device, None, now)?;
    }
    Ok(())
}
