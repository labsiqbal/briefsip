#![allow(clippy::too_many_arguments, clippy::match_like_matches_macro)]
use super::*;
use crate::data::{exists, param};
mod routines;
mod runtime;
mod scheduler;
mod webhooks;
mod workflows;

fn missing() -> Failure {
    Failure::new(404, "resource_not_found", "Resource not found.")
}
fn maintenance_transaction<T>(db: &Connection, work: impl FnOnce() -> Result<T>) -> Result<T> {
    let tx = rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Deferred)?;
    let before: i64 = db.query_row("SELECT total_changes()", [], |row| row.get(0))?;
    let result = work()?;
    let after: i64 = db.query_row("SELECT total_changes()", [], |row| row.get(0))?;
    if after == before {
        tx.rollback()?;
    } else {
        tx.commit()?;
    }
    Ok(result)
}
pub fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch(include_str!("project.sql"))?;
    Ok(())
}
fn fields(v: &Value, keys: &[&str]) -> Result<()> {
    if let Some(key) = v
        .as_object()
        .and_then(|m| m.keys().find(|k| !keys.contains(&k.as_str())))
    {
        return Err(Failure::new(
            400,
            "unknown_field",
            format!("Field {key} is unknown."),
        ));
    }
    Ok(())
}
fn id(v: &Value) -> Result<String> {
    v.as_str()
        .and_then(crate::web::id)
        .ok_or_else(|| Failure::new(400, "invalid_id", "ID must be a UUID v4."))
}
fn revision(v: &Value) -> Result<i64> {
    v.as_i64()
        .filter(|n| (0..=9007199254740991).contains(n))
        .ok_or_else(|| {
            Failure::new(
                400,
                "invalid_revision",
                "Revision must be a nonnegative safe integer.",
            )
        })
}
fn label(v: &Value) -> Result<String> {
    v.as_str()
        .filter(|s| {
            !s.trim().is_empty()
                && s.encode_utf16().count() <= 80
                && !s.chars().any(|c| c < ' ' || c == '\u{7f}')
        })
        .map(|s| s.trim().to_owned())
        .ok_or_else(|| Failure::new(400, "invalid_label", "name is invalid."))
}
fn command(v: &Value) -> Result<(String, i64)> {
    let request = id(&v["requestId"])?;
    if id(&v["id"])? != request {
        return Err(Failure::new(
            400,
            "request_id_mismatch",
            "Command IDs must match.",
        ));
    }
    Ok((request, revision(&v["revision"])?))
}
fn page(mut rows: Vec<Value>, key: &str) -> Value {
    let next = if rows.len() > 20 {
        json!(rows[19][key]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| rows[19][key].to_string()))
    } else {
        Value::Null
    };
    rows.truncate(20);
    json!({"items":rows,"nextCursor":next})
}
fn before(
    q: &[(String, String)],
    key: &str,
    default: i64,
    fail: impl Fn() -> Failure,
) -> Result<i64> {
    if q.iter().any(|(k, _)| k != key) || q.len() > 1 {
        return Err(fail());
    }
    match param(q, key) {
        None => Ok(default),
        Some(raw) => raw
            .parse::<i64>()
            .ok()
            .filter(|n| *n > 0 && *n <= 9007199254740991 && n.to_string() == raw)
            .ok_or_else(fail),
    }
}
struct Scope<'a> {
    state: &'a AppState,
    db: &'a Connection,
    account: &'a str,
    project: &'a str,
    kind: &'a str,
}
impl Scope<'_> {
    fn missing(&self) -> Failure {
        Failure::new(
            404,
            "resource_not_found",
            format!("{} not found.", self.kind),
        )
    }
    fn member(&self) -> Result<Value> {
        crate::data::access::active(self.db)?;
        one(self.db,"SELECT p.*,m.role,m.grant_revision FROM projects p JOIN project_members m ON m.project=p.id JOIN accounts a ON a.id=m.account AND a.blocked=0 JOIN accounts o ON o.id=p.account AND o.blocked=0 WHERE p.id=? AND m.account=? AND p.deleted=0 AND m.deleted=0",[self.project,self.account])?.ok_or_else(||self.missing())
    }
    fn home(&self, agent: &str) -> Result<Value> {
        let m = self.member()?;
        let mut row=one(self.db,"SELECT a.revision AS agent_revision,p.revision AS participation_revision,p.capabilities_json,h.home_device,h.revision AS home_revision,h.provider_binding FROM agent_projects p JOIN agents a ON a.id=p.agent JOIN agent_authority h ON h.agent=a.id WHERE p.project=? AND p.agent=? AND p.deleted=0 AND h.owner_account=?",params![self.project,agent,m["account"].as_str()])?.ok_or_else(||self.missing())?;
        if !exists(self.db,"SELECT 1 FROM record_scopes WHERE table_name='agents' AND key_json=? AND account=? AND root_kind='agent' AND root_id=?",params![json!([agent]).to_string(),m["account"].as_str(),agent])? { return Err(self.missing()); }
        row["assignment"] = if m["role"] == "owner" {
            m["grant_revision"].clone()
        } else {
            one(self.db,"SELECT revision FROM collaborator_agents WHERE project=? AND account=? AND agent=? AND enabled=1",[self.project,self.account,agent])?.ok_or_else(||self.missing())?["revision"].clone()
        };
        Ok(row)
    }
    fn device(&self, agent: &str) -> Result<(Value, Value)> {
        let home = self.home(agent)?;
        let m = self.member()?;
        let device=one(self.db,"SELECT d.* FROM devices d JOIN installations i ON i.id=d.installation AND i.account=d.account WHERE d.id=? AND d.account=? AND i.revoked=0 AND d.status NOT IN('revoked','blocked')",params![home["home_device"].as_str(),m["account"].as_str()])?.ok_or_else(||self.missing())?;
        if !data::json(&device["capabilities_json"])?
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == "execution"))
        {
            return Err(self.missing());
        }
        Ok((home, device))
    }
    fn scope(&self, table: &str, key: Value, root: &str) -> Result<Value> {
        one(self.db,"SELECT * FROM record_scopes WHERE table_name=? AND key_json=? AND project=? AND root_kind=? AND root_id=? AND (visibility='project' OR account=?)",params![table,crate::db::canonical(&key),self.project,if self.kind=="Routine" {"agent"} else {"workflow"},root,self.account])?.ok_or_else(||self.missing())
    }
    fn map(&self, table: &str, key: Value, root: &str, parent: &Value) -> Result<()> {
        self.db.execute(
            "INSERT INTO record_scopes VALUES(?,?,?,?,?,?,?)",
            params![
                table,
                crate::db::canonical(&key),
                parent["account"].as_str().unwrap_or(self.account),
                self.project,
                parent["visibility"].as_str().unwrap_or("project"),
                if self.kind == "Routine" {
                    "agent"
                } else {
                    "workflow"
                },
                root
            ],
        )?;
        Ok(())
    }
    fn digest(&self, path: &str, v: &Value) -> String {
        crate::db::digest(&crate::db::canonical(&json!([
            "briefsip-retained-command-v1",
            self.account,
            self.project,
            "POST",
            path,
            v
        ])))
    }
    fn replay(&self, path: &str, request: &str, digest: &str) -> Result<Option<Value>> {
        let Some(row) = one(
            self.db,
            "SELECT * FROM receipts WHERE request_id=?",
            [request],
        )?
        else {
            return Ok(None);
        };
        if row["actor"] != self.account || row["project"] != self.project {
            return Err(self.missing());
        }
        if row["scope"] != format!("retained:{path}") || row["payload_digest"] != digest {
            return Err(Failure::new(
                409,
                "payload_conflict",
                "A different command uses the same ID.",
            ));
        }
        let mut saved = data::json(&row["result_json"])?;
        saved["status"] = json!(200);
        Ok(Some(saved))
    }
    fn save(
        &self,
        path: &str,
        request: &str,
        digest: &str,
        status: u16,
        record: &str,
        rev: i64,
        data: Value,
    ) -> Result<Value> {
        let now = self.state.config.now();
        let receipt = json!({"requestId":request,"actorId":self.account,"projectId":self.project,"payloadDigest":digest,"status":status,"recordId":record,"recordRevision":rev,"committedAt":now});
        let saved = json!({"status":status,"data":data,"receipt":receipt});
        self.db.execute(
            "INSERT INTO receipts VALUES(?,?,?,?,?,?,?,?)",
            params![
                request,
                self.account,
                self.project,
                format!("retained:{path}"),
                digest,
                status,
                crate::db::canonical(&saved),
                now
            ],
        )?;
        Ok(saved)
    }
    fn observe(&self, kind: &str, record: &str) -> Result<()> {
        crate::data::sync::append_record(
            self.db,
            self.project,
            kind,
            record,
            None,
            self.state.config.now(),
        )
    }
}
fn envelope(saved: Value) -> Result<Response> {
    Ok(crate::json_response(
        saved["status"].as_u64().ok_or_else(Failure::storage)? as u16,
        json!({"ok":true,"data":saved["data"],"revision":saved["receipt"]["recordRevision"],"receipt":saved["receipt"]}),
    ))
}
fn read_response(data: Value) -> Response {
    crate::json_response(200, json!({"ok":true,"data":data}))
}

pub fn feature(path: &str) -> bool {
    let p = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
    match p.as_slice() {
        ["api", "projects", _, rest @ ..] | ["api", rest @ ..] => match rest {
            ["routines" | "workflows" | "workflow-runs" | "workflow-notifications", ..] => true,
            ["agents", _, "routines" | "workflows", ..] => true,
            _ => false,
        },
        _ => false,
    }
}
pub fn valid(path: &str) -> bool {
    let p = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
    matches!(
        p.as_slice(),
        [
            "api",
            "projects",
            _,
            "routines" | "workflows" | "workflow-notifications"
        ] | [
            "api",
            "projects",
            _,
            "routines" | "workflows" | "workflow-runs",
            _
        ] | [
            "api",
            "projects",
            _,
            "routines",
            _,
            "edit" | "flow" | "runs" | "run" | "webhook" | "webhook-events"
        ] | [
            "api",
            "projects",
            _,
            "workflows",
            _,
            "versions" | "edit" | "restore" | "delete" | "run" | "runs" | "schedule"
        ] | [
            "api",
            "projects",
            _,
            "workflow-runs",
            _,
            "approve" | "cancel" | "retry"
        ] | ["api", "projects", _, "workflow-notifications", _, "read"]
            | ["api", "projects", _, "agents", _, "routines" | "workflows"]
            | [
                "api",
                "projects",
                _,
                "agents",
                _,
                "routines",
                "calendar.ics"
            ]
    )
}
pub fn route(
    state: &AppState,
    path: &str,
    method: &Method,
    v: &Value,
    account: &str,
    q: &[(String, String)],
    headers: &HeaderMap,
) -> Result<Option<Response>> {
    if !feature(path) {
        return Ok(None);
    }
    if !valid(path)
        || headers.contains_key("x-briefsip-project")
        || headers.contains_key("x-briefsip-project-id")
        || v.get("projectId").is_some()
    {
        return Err(missing());
    }
    let p = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
    if !uuid(p[2]) || p.get(4).is_some_and(|id| !uuid(id)) {
        return Err(missing());
    }
    if *method != Method::GET && (*method != Method::POST || !q.is_empty()) {
        return Err(missing());
    }
    let guard = state.database.lock().map_err(|_| Failure::storage())?;
    let db = &guard.connection;
    transaction(db, || {
        initialize(db)?;
        let s = Scope {
            state,
            db,
            account,
            project: p[2],
            kind: if p.contains(&"routines") {
                "Routine"
            } else {
                "Workflow"
            },
        };
        s.member()?;
        if s.kind == "Routine" {
            routines::route(&s, path, &p, method, q, v).map(Some)
        } else {
            workflows::route(&s, path, &p, method, q, v).map(Some)
        }
    })
}

pub fn maintain(state: &AppState) -> Result<()> {
    runtime::maintain(state)
}

pub async fn event(
    state: &AppState,
    request: Request,
    request_id: &mut String,
) -> Result<Option<Response>> {
    let path = request.uri().path().to_owned();
    let p = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
    if !matches!(
        p.as_slice(),
        ["api", "projects", _, "routines", _, "webhook-events"]
    ) {
        return Ok(None);
    }
    *request_id = uuid::Uuid::new_v4().to_string();
    let _capacity = crate::data::limits::reserve(&path, request.method())?;
    if request.method() != Method::POST {
        return Err(Failure::new(
            405,
            "method_not_allowed",
            "Use POST for events.",
        ));
    }
    if request.uri().query().is_some() {
        return Err(Failure::new(400, "invalid_route", "Invalid event route."));
    }
    if request.headers().contains_key("origin") {
        return Err(Failure::new(
            403,
            "origin_denied",
            "Send events from the server integration.",
        ));
    }
    let media = crate::text_header(request.headers(), "content-type")
        .unwrap_or("")
        .to_ascii_lowercase();
    if media != "application/json"
        && !media.split_once(';').is_some_and(|(m, p)| {
            m.trim_end() == "application/json" && p.trim_start() == "charset=utf-8"
        })
    {
        return Err(Failure::new(
            415,
            "unsupported_media_type",
            "Use Content-Type application/json.",
        ));
    }
    if request.headers().contains_key("x-briefsip-project")
        || request.headers().contains_key("x-briefsip-project-id")
    {
        return Err(missing());
    }
    let headers = request.headers().clone();
    let bytes = axum::body::to_bytes(request.into_body(), 65536)
        .await
        .map_err(|_| Failure::new(413, "payload_too_large", "Event exceeds 64 KiB."))?;
    if !uuid(p[2]) || !uuid(p[4]) {
        return Err(Failure::new(400, "invalid_id", "ID must be a UUID v4."));
    }
    webhooks::event(state, p[2], p[4], &headers, &bytes).map(Some)
}
