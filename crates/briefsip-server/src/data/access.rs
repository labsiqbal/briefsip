use super::*;

fn missing() -> Failure {
    Failure::new(404, "resource_not_found", "Resource not found.")
}
fn stale() -> Failure {
    Failure::new(
        409,
        "stale_revision",
        "Data changed. Load the latest revision.",
    )
}
fn conflict() -> Failure {
    Failure::new(
        409,
        "payload_conflict",
        "Request ID was already used for different content.",
    )
}
fn fields(v: &Value, keys: &[&str]) -> Result<()> {
    let object = v
        .as_object()
        .ok_or_else(|| Failure::new(400, "invalid_object", "Request must be a JSON object."))?;
    for key in object.keys() {
        if !keys.contains(&key.as_str()) {
            return Err(Failure::new(
                400,
                "unknown_field",
                format!("Field {key} is unknown."),
            ));
        }
    }
    Ok(())
}
pub(super) fn id(v: &Value) -> Result<String> {
    v.as_str()
        .and_then(crate::web::id)
        .ok_or_else(|| Failure::new(400, "invalid_id", "ID must be a UUID v4."))
}
fn revision(v: &Value) -> Result<i64> {
    if !integer(v, 0, 9_007_199_254_740_991) {
        return Err(Failure::new(
            400,
            "invalid_revision",
            "Revision must be a nonnegative safe integer.",
        ));
    }
    let n = v.as_i64().ok_or_else(Failure::storage)?;
    if n == 0 {
        return Err(Failure::new(
            400,
            "invalid_revision",
            "Revision must be greater than zero.",
        ));
    }
    Ok(n)
}
fn label(v: &Value) -> Result<String> {
    v.as_str()
        .filter(|s| {
            !s.trim().is_empty()
                && s.encode_utf16().count() <= 200
                && !s.chars().any(|c| c < ' ' || c == '\u{7f}')
        })
        .map(|s| s.trim().to_owned())
        .ok_or_else(|| Failure::new(400, "invalid_label", "Label is invalid."))
}
pub(super) fn active(db: &Connection) -> Result<()> {
    if !exists(
        db,
        "SELECT 1 FROM authority_state WHERE id=1 AND serving_state='active'",
        [],
    )? {
        let mut e = Failure::new(503, "authority_unavailable", "Authority is not active yet.");
        e.retryable = true;
        return Err(e);
    }
    Ok(())
}
fn member(db: &Connection, account: &str, project: &str, owner: bool) -> Result<Value> {
    active(db)?;
    let row=one(db,"SELECT p.*,m.role,m.grant_revision FROM projects p JOIN project_members m ON m.project=p.id WHERE p.id=? AND m.account=? AND p.deleted=0 AND m.deleted=0",[project,account])?.ok_or_else(missing)?;
    if owner && (row["account"] != account || row["role"] != "owner") {
        return Err(Failure::new(
            403,
            "owner_required",
            "Only the owner can perform this action.",
        ));
    }
    Ok(row)
}
fn replay(
    db: &Connection,
    account: &str,
    request: &str,
    project: &str,
    scope: &str,
    digest: &str,
) -> Result<Option<Value>> {
    let Some(row) = one(db, "SELECT * FROM receipts WHERE request_id=?", [request])? else {
        return Ok(None);
    };
    if row["actor"] != account || row["project"] != project {
        return Err(Failure::new(
            403,
            "receipt_denied",
            "Receipt is outside the account's access.",
        ));
    }
    if row["scope"] != scope || row["payload_digest"] != digest {
        return Err(conflict());
    }
    let mut result = json(&row["result_json"])?;
    result["status"] = json!(200);
    Ok(Some(result))
}
struct Commit<'a> {
    account: &'a str,
    project: &'a str,
    scope: &'a str,
    command: &'a Value,
    digest: &'a str,
}
impl Commit<'_> {
    fn save(
        &self,
        db: &Connection,
        now: i64,
        status: u16,
        record: &str,
        rev: i64,
        data: Value,
    ) -> Result<Value> {
        let request = string(self.command, "requestId");
        let receipt = json!({"requestId":request,"actorId":self.account,"projectId":self.project,"payloadDigest":self.digest,"status":status,"recordId":record,"recordRevision":rev,"committedAt":now});
        let result = json!({"data":data,"receipt":receipt,"status":status});
        db.execute(
            "INSERT INTO receipts VALUES(?,?,?,?,?,?,?,?)",
            rusqlite::params![
                request,
                self.account,
                self.project,
                self.scope,
                self.digest,
                status,
                result.to_string(),
                now
            ],
        )?;
        super::sync::append_mutation(db, self.project, self.scope, record, &result["data"], now)?;
        Ok(result)
    }
}
fn envelope(result: Value) -> Result<Response> {
    let status = result["status"].as_u64().ok_or_else(Failure::storage)? as u16;
    Ok(json_response(
        status,
        json!({"ok":true,"data":result["data"],"revision":result["receipt"]["recordRevision"],"receipt":result["receipt"]}),
    ))
}
pub(super) fn digest(v: Value) -> String {
    crate::db::digest(&crate::db::canonical(&v))
}

mod grants;
mod invitations;
pub(crate) use invitations::accept;

fn agent(db: &Connection, project: &str, agent: &str) -> Result<Value> {
    if !exists(db,"SELECT 1 FROM record_scopes s JOIN projects p ON p.account=s.account WHERE s.table_name='agents' AND s.key_json=? AND p.id=? AND s.root_kind='agent' AND s.root_id=?",rusqlite::params![json!([agent]).to_string(),project,agent])? {return Err(missing());}
    if !exists(db,"SELECT 1 FROM agent_authority a JOIN projects p ON p.account=a.owner_account WHERE p.id=? AND a.agent=?",[project,agent])? {return Err(missing());}
    one(db,"SELECT a.revision AS agent_revision,p.revision AS participation_revision,p.capabilities_json FROM agent_projects p JOIN agents a ON a.id=p.agent WHERE p.project=? AND p.agent=? AND p.deleted=0",[project,agent])?.ok_or_else(missing)
}
fn member_edit(
    state: &AppState,
    db: &Connection,
    account: &str,
    project: &str,
    target: &str,
    v: &Value,
) -> Result<Value> {
    fields(
        v,
        &[
            "requestId",
            "expectedRevision",
            "deleted",
            "agentAssignments",
        ],
    )?;
    let request = id(&v["requestId"])?;
    let expected = revision(&v["expectedRevision"])?;
    let mut command = json!({"requestId":request,"expectedRevision":expected});
    if v["deleted"] == true && v.get("agentAssignments").is_none() {
        command["deleted"] = json!(true);
    } else {
        if v.get("deleted").is_some() || !v["agentAssignments"].is_array() {
            return Err(Failure::new(
                400,
                "invalid_member_edit",
                "Choose revoke or edit assignment.",
            ));
        }
        let mut seen = std::collections::HashSet::new();
        let mut entries = Vec::new();
        for entry in v["agentAssignments"]
            .as_array()
            .ok_or_else(Failure::storage)?
        {
            fields(
                entry,
                &[
                    "agentId",
                    "expectedAgentRevision",
                    "expectedParticipationRevision",
                    "expectedAssignmentRevision",
                    "enabled",
                ],
            )?;
            let agent = id(&entry["agentId"])?;
            if !seen.insert(agent.clone()) {
                return Err(Failure::new(
                    400,
                    "duplicate_agent",
                    "Duplicate agent assignment.",
                ));
            }
            if !entry["enabled"].is_boolean() {
                return Err(Failure::new(
                    400,
                    "invalid_flag",
                    "enabled must be a boolean.",
                ));
            }
            if !integer(
                &entry["expectedAssignmentRevision"],
                0,
                9_007_199_254_740_991,
            ) {
                return Err(Failure::new(
                    400,
                    "invalid_revision",
                    "Revision must be a nonnegative safe integer.",
                ));
            }
            entries.push(json!({"agentId":agent,"expectedAgentRevision":revision(&entry["expectedAgentRevision"])?,"expectedParticipationRevision":revision(&entry["expectedParticipationRevision"])?,"expectedAssignmentRevision":entry["expectedAssignmentRevision"],"enabled":entry["enabled"]}));
        }
        entries.sort_by(|a, b| string(a, "agentId").cmp(string(b, "agentId")));
        command["agentAssignments"] = json!(entries);
    }
    let scope = format!("members:edit:{project}:{target}");
    let hash = digest(json!(["briefsip-member-edit-v1", project, target, command]));
    transaction(db, || {
        let owner = member(db, account, project, true)?;
        if let Some(prior) = replay(db, account, &request, project, &scope, &hash)? {
            return Ok(prior);
        }
        if owner["account"] == target {
            return Err(Failure::new(
                403,
                "owner_immutable",
                "Owner access cannot be revoked through member controls.",
            ));
        }
        let row=one(db,"SELECT * FROM project_members WHERE project=? AND account=? AND role='member' AND deleted=0",[project,target])?.ok_or_else(missing)?;
        if row["grant_revision"] != expected {
            return Err(stale());
        }
        if command["deleted"] == true {
            db.execute("UPDATE project_members SET deleted=1,grant_revision=grant_revision+1 WHERE project=? AND account=?",[project,target])?;
            db.execute("UPDATE collaborator_agents SET enabled=0,revision=revision+1 WHERE project=? AND account=?",[project,target])?;
        } else {
            for entry in command["agentAssignments"]
                .as_array()
                .ok_or_else(Failure::storage)?
            {
                let aid = string(entry, "agentId");
                let a = agent(db, project, aid)?;
                if a["agent_revision"] != entry["expectedAgentRevision"]
                    || a["participation_revision"] != entry["expectedParticipationRevision"]
                {
                    return Err(stale());
                }
                let current=one(db,"SELECT revision FROM collaborator_agents WHERE project=? AND account=? AND agent=?",[project,target,aid])?;
                if current
                    .as_ref()
                    .map(|v| v["revision"].clone())
                    .unwrap_or(json!(0))
                    != entry["expectedAssignmentRevision"]
                {
                    return Err(stale());
                }
                let enabled = i64::from(entry["enabled"] == true);
                if current.is_some() {
                    db.execute("UPDATE collaborator_agents SET enabled=?,revision=revision+1 WHERE project=? AND account=? AND agent=?",rusqlite::params![enabled,project,target,aid])?;
                } else {
                    db.execute(
                        "INSERT INTO collaborator_agents VALUES(?,?,?,?,1)",
                        rusqlite::params![project, target, aid, enabled],
                    )?;
                    db.execute(
                        "INSERT INTO response_policies VALUES(?,?,?,1,1)",
                        [project, target, aid],
                    )?;
                }
            }
            db.execute("UPDATE project_members SET grant_revision=grant_revision+1 WHERE project=? AND account=?",[project,target])?;
        }
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
            target,
            expected + 1,
            json!({"membershipId":json!([project,target]).to_string(),"grantRevision":expected+1}),
        )
    })
}
fn policy(
    state: &AppState,
    db: &Connection,
    account: &str,
    project: &str,
    aid: &str,
    v: &Value,
) -> Result<Value> {
    fields(
        v,
        &["requestId", "accountId", "expectedRevision", "respond"],
    )?;
    if !v["respond"].is_boolean() {
        return Err(Failure::new(
            400,
            "invalid_flag",
            "respond must be a boolean.",
        ));
    }
    let request = id(&v["requestId"])?;
    let target = id(&v["accountId"])?;
    let expected = revision(&v["expectedRevision"])?;
    let command = json!({"requestId":request,"accountId":target,"expectedRevision":expected,"respond":v["respond"]});
    let scope = format!("response-policy:{project}:{aid}:{target}");
    let hash = digest(json!([
        "briefsip-response-policy-v1",
        project,
        aid,
        command
    ]));
    transaction(db, || {
        member(db, account, project, true)?;
        agent(db, project, aid)?;
        if let Some(prior) = replay(db, account, &request, project, &scope, &hash)? {
            return Ok(prior);
        }
        if !exists(
            db,
            "SELECT 1 FROM project_members WHERE project=? AND account=? AND deleted=0",
            [project, target.as_str()],
        )? || !exists(
            db,
            "SELECT 1 FROM collaborator_agents WHERE project=? AND account=? AND agent=?",
            [project, target.as_str(), aid],
        )? {
            return Err(missing());
        }
        let row = one(
            db,
            "SELECT * FROM response_policies WHERE project=? AND account=? AND agent=?",
            [project, target.as_str(), aid],
        )?
        .ok_or_else(|| {
            Failure::new(409, "policy_missing", "Owner must fix the response policy.")
        })?;
        if row["revision"] != expected {
            return Err(stale());
        }
        db.execute("UPDATE response_policies SET respond=?,revision=revision+1 WHERE project=? AND account=? AND agent=?",rusqlite::params![i64::from(v["respond"]==true),project,target,aid])?;
        Commit{account,project,scope:&scope,command:&command,digest:&hash}.save(db,state.config.now(),200,aid,expected+1,json!({"projectId":project,"accountId":target,"agentId":aid,"respond":v["respond"],"revision":expected+1}))
    })
}

pub fn route(
    state: &AppState,
    path: &str,
    method: &Method,
    v: &Value,
    account: &str,
) -> Result<Option<Response>> {
    let parts = path.split('/').skip(1).collect::<Vec<_>>();
    if !matches!(
        parts.as_slice(),
        ["api", "agents"]
            | ["api", "projects"]
            | ["api", "projects", _]
            | ["api", "projects", _, "invitations"]
            | ["api", "invitations", _, "revoke"]
            | ["api", "projects", _, "members", _]
            | ["api", "projects", _, "agents", _]
            | [
                "api",
                "projects",
                _,
                "agents",
                _,
                "response-policy" | "rules" | "capabilities"
            ]
    ) {
        return Ok(None);
    }
    let guard = state.database.lock().map_err(|_| Failure::storage())?;
    let db = &guard.connection;
    active(db)?;
    if *method == Method::POST
        && parts.len() == 4
        && parts[1] == "projects"
        && parts[3] == "invitations"
    {
        return Ok(Some(envelope(invitations::create(
            state,
            db,
            account,
            &id(&json!(parts[2]))?,
            v,
        )?)?));
    }
    if *method == Method::POST
        && parts.len() == 4
        && parts[1] == "invitations"
        && parts[3] == "revoke"
    {
        return Ok(Some(envelope(invitations::revoke(
            state,
            db,
            account,
            &id(&json!(parts[2]))?,
            v,
        )?)?));
    }
    if parts.as_slice() == ["api", "agents"] && *method == Method::POST {
        let result = grants::create(state, db, account, v)?;
        state.events.publish(path.to_owned());
        return Ok(Some(envelope(result)?));
    }
    if parts.len() == 5 && parts[1] == "projects" && parts[3] == "agents" && *method == Method::PUT
    {
        let project = id(&json!(parts[2]))?;
        let agent = id(&json!(parts[4]))?;
        let result = grants::edit(state, db, account, &project, &agent, "", v)?;
        state.events.publish(path.to_owned());
        return Ok(Some(envelope(result)?));
    }
    if parts.len() == 6
        && parts[1] == "projects"
        && parts[3] == "agents"
        && ["rules", "capabilities"].contains(&parts[5])
        && *method == Method::PUT
    {
        let project = id(&json!(parts[2]))?;
        let agent = id(&json!(parts[4]))?;
        let result = grants::edit(state, db, account, &project, &agent, parts[5], v)?;
        state.events.publish(path.to_owned());
        return Ok(Some(envelope(result)?));
    }
    if parts.as_slice() == ["api", "projects"] && *method == Method::GET {
        return Ok(Some(json_response(
            200,
            json!({"ok":true,"data":all(db,"SELECT p.id,p.name,p.private,p.revision,m.role,m.grant_revision FROM projects p JOIN project_members m ON m.project=p.id WHERE m.account=? AND p.deleted=0 AND m.deleted=0 ORDER BY p.id",[account])?}),
        )));
    }
    if parts.len() == 2 && *method == Method::POST {
        fields(v, &["requestId", "id", "name"])?;
        let project = id(&v["id"])?;
        let request = id(&v["requestId"])?;
        let name = label(&v["name"])?;
        let command = json!({"requestId":request,"id":project,"name":name});
        let scope = format!("projects:create:{project}");
        let hash = digest(json!(["briefsip-project-create-v1", command]));
        let result = transaction(db, || {
            if let Some(old) = one(
                db,
                "SELECT actor,project FROM receipts WHERE request_id=?",
                [&request],
            )? {
                if old["actor"] != account || old["project"].is_null() {
                    return Err(Failure::new(
                        403,
                        "receipt_denied",
                        "Receipt is outside the account's access.",
                    ));
                }
                member(db, account, string(&old, "project"), true)?;
                if old["project"] != project {
                    return Err(conflict());
                }
                return replay(db, account, &request, &project, &scope, &hash)?
                    .ok_or_else(Failure::storage);
            }
            if exists(db, "SELECT 1 FROM projects WHERE id=?", [&project])? {
                return Err(Failure::new(
                    409,
                    "project_exists",
                    "Project ID was already used.",
                ));
            }
            db.execute(
                "INSERT INTO projects VALUES(?,?,?,0,0,1)",
                rusqlite::params![project, account, name],
            )?;
            db.execute(
                "INSERT INTO project_members VALUES(?,?,'owner',1,0)",
                rusqlite::params![project, account],
            )?;
            Commit {
                account,
                project: &project,
                scope: &scope,
                command: &command,
                digest: &hash,
            }
            .save(
                db,
                state.config.now(),
                201,
                &project,
                1,
                json!({"projectId":project,"name":name,"private":false,"revision":1}),
            )
        })?;
        state.events.publish(path.to_owned());
        return Ok(Some(envelope(result)?));
    }
    if parts.len() == 5 && parts[3] == "members" {
        let project = id(&json!(parts[2]))?;
        let target = id(&json!(parts[4]))?;
        if *method == Method::GET {
            member(db, account, &project, true)?;
            let row=one(db,"SELECT project,account,role,grant_revision,deleted FROM project_members WHERE project=? AND account=?",[project.as_str(),target.as_str()])?.ok_or_else(||Failure::new(404,"resource_not_found","Member not found."))?;
            return Ok(Some(json_response(200, json!({"ok":true,"data":row}))));
        }
        if *method == Method::PATCH {
            return Ok(Some(envelope(member_edit(
                state, db, account, &project, &target, v,
            )?)?));
        }
        return Ok(None);
    }
    if parts.len() == 6
        && parts[3] == "agents"
        && parts[5] == "response-policy"
        && *method == Method::PUT
    {
        return Ok(Some(envelope(policy(
            state,
            db,
            account,
            &id(&json!(parts[2]))?,
            &id(&json!(parts[4]))?,
            v,
        )?)?));
    }
    if parts.len() != 3 {
        return Ok(None);
    }
    let project = id(&json!(parts[2]))
        .map_err(|_| Failure::new(400, "invalid_id", "Route ID must be a UUID v4."))?;
    if *method == Method::GET {
        return Ok(Some(json_response(
            200,
            json!({"ok":true,"data":member(db,account,&project,false)?}),
        )));
    }
    if *method == Method::PATCH {
        fields(v, &["requestId", "expectedRevision", "name", "deleted"])?;
        if v.get("name").is_none() && v.get("deleted").is_none() {
            return Err(Failure::new(
                400,
                "invalid_project_edit",
                "Project change is empty.",
            ));
        }
        if v.get("deleted").is_some_and(|v| !v.is_boolean()) {
            return Err(Failure::new(
                400,
                "invalid_flag",
                "deleted must be a boolean.",
            ));
        }
        let request = id(&v["requestId"])?;
        let expected = revision(&v["expectedRevision"])?;
        let mut command = json!({"requestId":request,"expectedRevision":expected});
        if let Some(name) = v.get("name") {
            command["name"] = json!(label(name)?);
        }
        if let Some(deleted) = v.get("deleted") {
            command["deleted"] = deleted.clone();
        }
        let scope = format!("projects:edit:{project}");
        let hash = digest(json!(["briefsip-project-edit-v1", project, command]));
        let result = transaction(db, || {
            let row = member(db, account, &project, true)?;
            if let Some(prior) = replay(db, account, &request, &project, &scope, &hash)? {
                return Ok(prior);
            }
            if row["revision"] != expected {
                return Err(stale());
            }
            let name = command.get("name").unwrap_or(&row["name"]);
            let deleted = command["deleted"] == true;
            db.execute(
                "UPDATE projects SET name=?,deleted=?,revision=revision+1 WHERE id=?",
                rusqlite::params![name.as_str(), i64::from(deleted), project],
            )?;
            Commit {
                account,
                project: &project,
                scope: &scope,
                command: &command,
                digest: &hash,
            }
            .save(
                db,
                state.config.now(),
                200,
                &project,
                expected + 1,
                json!({"projectId":project,"name":name,"deleted":deleted,"revision":expected+1}),
            )
        })?;
        state.events.publish(path.to_owned());
        return Ok(Some(envelope(result)?));
    }
    Ok(None)
}
