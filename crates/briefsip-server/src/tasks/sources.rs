use super::*;
pub fn root(db: &Connection, t: &Value) -> Result<Value> {
    one(db,"SELECT root_kind,root_id FROM record_scopes WHERE table_name='turns' AND key_json=? AND project=?",[json!([t["logical_turn"]]).to_string(),string(t,"project").to_owned()])?.ok_or_else(Failure::storage)
}
fn rows(db: &Connection, sql: &str, p: impl rusqlite::Params) -> Result<Vec<Value>> {
    let rows = all(db, sql, p)?;
    if canonical(&json!(rows)).len() > 8388608 {
        return Err(fail(
            413,
            "context_too_large",
            "Context source exceeds the limit.",
        ));
    }
    Ok(rows)
}
pub fn get(db: &Connection, t: &Value, current: &Value) -> Result<Value> {
    let root = root(db, t)?;
    let project = string(t, "project");
    let account = string(t, "initiator_account");
    let turn = string(t, "logical_turn");
    let agent = string(t, "agent");
    let position = if data::table(db, "queue_positions")? {
        "coalesce((SELECT position FROM queue_positions WHERE turn=t.id),t.seq)"
    } else {
        "t.seq"
    };
    let pos: i64 = db.query_row(
        &format!("SELECT {position} FROM turns t WHERE id=?"),
        [turn],
        |r| r.get(0),
    )?;
    let mut history=rows(db,&format!("SELECT t.id,t.agent agentId,t.text,t.reply,t.revision,s.account authorAccountId FROM turns t JOIN record_scopes s ON s.table_name='turns' AND s.key_json=json_array(t.id) WHERE s.project=? AND s.root_kind=? AND s.root_id=? AND (s.visibility='project' OR s.account=?) AND t.status='done' AND {position}<? ORDER BY {position} DESC LIMIT 40"),params![project,string(&root,"root_kind"),string(&root,"root_id"),account,pos])?;
    history.reverse();
    let channel=one(db,"WITH RECURSIVE a AS(SELECT id,parent,channel FROM turns WHERE id=? UNION SELECT t.id,t.parent,t.channel FROM turns t JOIN a ON t.id=a.parent) SELECT channel FROM a WHERE channel IS NOT NULL LIMIT 1",[turn])?.and_then(|r|r["channel"].as_str().map(str::to_owned));
    let memory = if data::table(db, "memories")? {
        rows(db,"SELECT m.id,m.text,m.essential,m.revision,m.removed,m.scope FROM memories m JOIN record_scopes s ON s.table_name='memories' AND s.key_json=json_array(m.scope,m.id) WHERE s.project=? AND s.root_kind=? AND s.root_id=? AND (s.visibility='project' OR s.account=?) AND m.removed=0 ORDER BY m.scope,m.id LIMIT 129",[project,if channel.is_some(){"channel"}else{"agent"},channel.as_deref().unwrap_or(agent),account])?
    } else {
        vec![]
    };
    let skills = if data::table(db, "agent_skills")? && data::table(db, "skill_versions")? {
        rows(db,"SELECT v.*,i.revision installation_revision FROM agent_skills i JOIN skill_versions v ON v.skill=i.skill AND v.revision=i.version JOIN agent_authority h ON h.agent=i.agent WHERE i.agent=? AND i.enabled=1 AND i.removed=0 AND EXISTS(SELECT 1 FROM record_scopes s JOIN projects p ON p.id=s.project WHERE s.table_name='skills' AND s.key_json=json_array(i.skill) AND s.account=h.owner_account AND p.account=h.owner_account) AND EXISTS(SELECT 1 FROM record_scopes s JOIN projects p ON p.id=s.project WHERE s.table_name='skill_versions' AND s.key_json=json_array(v.skill,v.revision) AND s.account=h.owner_account AND p.account=h.owner_account) AND EXISTS(SELECT 1 FROM record_scopes s JOIN projects p ON p.id=s.project WHERE s.table_name='agent_skills' AND s.key_json=json_array(i.agent,i.skill) AND s.account=h.owner_account AND p.account=h.owner_account) ORDER BY i.skill",[agent])?
    } else {
        vec![]
    };
    let payload = data::json(&t["payload_json"])?;
    let recipients = if payload["kind"] == "channel" {
        rows(db,"SELECT c.agent FROM channel_members c JOIN agent_projects p ON p.agent=c.agent AND p.project=? AND p.deleted=0 JOIN agent_authority h ON h.agent=c.agent JOIN projects project ON project.id=p.project AND project.account=h.owner_account JOIN devices d ON d.id=h.home_device AND d.account=h.owner_account AND d.status NOT IN('blocked','revoked') JOIN installations i ON i.id=d.installation AND i.revoked=0 JOIN project_members m ON m.project=p.project AND m.account=? AND m.deleted=0 WHERE c.channel=? AND c.agent<>? AND (m.role='owner' OR EXISTS(SELECT 1 FROM collaborator_agents a WHERE a.project=p.project AND a.agent=c.agent AND a.account=m.account AND a.enabled=1)) ORDER BY c.agent",[project,account,string(&payload,"channelId"),agent])?.into_iter().map(|r|r["agent"].clone()).collect::<Vec<_>>()
    } else {
        vec![]
    };
    let channel_context = if payload["kind"] == "channel" {
        let room = one(
            db,
            "SELECT name,instructions,lead FROM channels WHERE id=?",
            [string(&payload, "channelId")],
        )?
        .ok_or_else(Failure::storage)?;
        let visible = if data::table(db, "agent_visibility")? {
            " AND NOT EXISTS(SELECT 1 FROM agent_visibility v WHERE v.agent=a.id AND v.hidden=1)"
        } else {
            ""
        };
        let members=rows(db,&format!("SELECT a.id,a.name || CASE WHEN a.role='' THEN '' ELSE ' - ' || a.role END AS name FROM channel_members c JOIN agents a ON a.id=c.agent JOIN agent_projects p ON p.agent=a.id AND p.project=? AND p.deleted=0 JOIN agent_authority h ON h.agent=a.id JOIN projects project ON project.id=p.project AND project.account=h.owner_account JOIN project_members m ON m.project=p.project AND m.account=? AND m.deleted=0 WHERE c.channel=? AND (m.role='owner' OR EXISTS(SELECT 1 FROM collaborator_agents ca WHERE ca.project=p.project AND ca.account=m.account AND ca.agent=a.id AND ca.enabled=1)){visible} ORDER BY a.name,a.id"),[project,account,string(&payload,"channelId")])?;
        Some(
            json!({"name":room["name"],"instructions":room["instructions"],"members":members.iter().map(|m|m["name"].clone()).collect::<Vec<_>>(),"lead":members.iter().find(|m|m["id"]==room["lead"]).map(|m|m["name"].clone()).unwrap_or(json!("No lead"))}),
        )
    } else {
        None
    };
    let mut questions = Vec::new();
    for id in std::iter::once(turn).chain(history.iter().map(|h| string(h, "id"))) {
        for mut q in rows(
            db,
            "SELECT id,prompt,choices,answer FROM questions WHERE turn=? ORDER BY rowid",
            [id],
        )? {
            q["choices"] = data::json(&q["choices"])?;
            questions.push(q);
        }
    }
    let mut revisions = current["sourceRevisions"]
        .as_array()
        .cloned()
        .ok_or_else(Failure::storage)?;
    for h in &history {
        revisions.push(json!({"kind":"history","id":h["id"],"revision":h["revision"]}));
    }
    for m in &memory {
        revisions.push(json!({"kind":"memory","id":json!([m["scope"],m["id"]]).to_string(),"revision":m["revision"]}));
    }
    for s in &skills {
        revisions.push(json!({"kind":"skillVersion","id":s["skill"],"revision":s["revision"]}));
        revisions.push(
            json!({"kind":"agentSkill","id":s["skill"],"revision":s["installation_revision"]}),
        );
    }
    for q in &questions {
        revisions.push(
            json!({"kind":"question","id":q["id"],"revision":if q["answer"].is_null(){1}else{2}}),
        );
    }
    let avatar = one(
        db,
        "SELECT revision FROM agent_avatars WHERE agent=?",
        [agent],
    )?
    .map(|r| n(&r, "revision"))
    .unwrap_or(0);
    revisions.push(json!({"kind":"avatar","id":agent,"revision":avatar}));
    let compaction = compaction(db, t, &root, pos)?;
    if let Some(c) = &compaction {
        revisions.push(json!({"kind":"compaction","id":c["version"],"revision":c["through"]}));
    }
    let evidence = evidence(db, t)?;
    revisions.push(json!({"kind":"executionEvidence","id":digest(&evidence),"revision":1}));
    revisions.push(json!({"kind":"toolRecipients","id":digest(&json!(recipients)),"revision":1}));
    if let Some(c) = &channel_context {
        revisions.push(json!({"kind":"channelContext","id":digest(c),"revision":1}));
    }
    authority::sort(&mut revisions);
    Ok(
        json!({"history":history,"memory":memory,"skills":skills,"compaction":compaction,"evidence":evidence,"questions":questions,"recipients":recipients,"channel":channel_context,"sourceRevisions":revisions,"avatarRevision":avatar,"channelContext":channel.is_some()}),
    )
}
fn compaction(db: &Connection, t: &Value, root: &Value, pos: i64) -> Result<Option<Value>> {
    if !data::table(db, "compactions")? || !data::table(db, "compaction_sources")? {
        return Ok(None);
    }
    let row=one(db,"SELECT c.scope,c.version,c.through,c.summary FROM compactions c JOIN record_scopes s ON s.table_name='compactions' AND s.key_json=json_array(c.scope) WHERE s.project=? AND s.root_kind=? AND s.root_id=? AND (s.visibility='project' OR s.account=?) AND c.through<?",params![string(t,"project"),string(root,"root_kind"),string(root,"root_id"),string(t,"initiator_account"),pos])?;
    let Some(mut row) = row else { return Ok(None) };
    if exists(db,"SELECT 1 FROM compaction_sources c LEFT JOIN turns t ON t.seq=c.seq LEFT JOIN record_scopes s ON s.table_name='turns' AND s.key_json=json_array(t.id) WHERE c.scope=? AND (t.seq IS NULL OR t.revision<>c.revision OR t.status<>c.status OR s.project IS NOT ? OR s.root_kind IS NOT ? OR s.root_id IS NOT ? OR (s.visibility<>'project' AND s.account<>?)) LIMIT 1",[string(&row,"scope"),string(t,"project"),string(root,"root_kind"),string(root,"root_id"),string(t,"initiator_account")])?{return Ok(None)}
    row.as_object_mut()
        .ok_or_else(Failure::storage)?
        .remove("scope");
    Ok(Some(row))
}
fn evidence(db: &Connection, t: &Value) -> Result<Value> {
    let ids = if data::table(db, "coordination")? {
        rows(db,"WITH RECURSIVE scope(id) AS(SELECT ? UNION SELECT c.child FROM coordination c JOIN scope p ON p.id=c.turn JOIN record_scopes s ON s.table_name='turns' AND s.key_json=json_array(c.child) AND s.project=? WHERE c.child IS NOT NULL AND (s.visibility='project' OR s.account=?)) SELECT id FROM scope LIMIT 129",[string(t,"logical_turn"),string(t,"project"),string(t,"initiator_account")])?
    } else {
        vec![json!({"id":t["logical_turn"]})]
    };
    if ids.len() > 128 {
        return Err(fail(
            413,
            "context_too_large",
            "Coordination exceeds the context limit.",
        ));
    }
    let ids = json!(ids.iter().map(|r| r["id"].clone()).collect::<Vec<_>>()).to_string();
    let mut coordination = Vec::new();
    if data::table(db, "coordination")? {
        for r in rows(db,"SELECT c.turn,c.owner,c.target,c.kind,c.prompt,c.call,c.child,t.status childStatus,t.reply childReply,t.error childError FROM coordination c LEFT JOIN turns t ON t.id=c.child AND t.id IN(SELECT value FROM json_each(?)) WHERE c.turn IN(SELECT value FROM json_each(?)) AND (c.child IS NULL OR t.id IS NOT NULL) ORDER BY c.seq",[&ids,&ids])?{let mut row=json!({"turnId":r["turn"],"ownerId":r["owner"],"targetId":r["target"],"kind":r["kind"],"prompt":r["prompt"],"call":data::json(&r["call"])?});if !r["childStatus"].is_null(){row["child"]=json!({"turnId":r["child"],"status":r["childStatus"],"reply":r["childReply"],"error":r["childError"]});}coordination.push(row);}
    }
    coordination.extend(messages(db, t)?);
    let mut journal = Vec::new();
    if data::table(db, "flow_tool_calls")? {
        for r in rows(db,"SELECT turn,call_id,call,result,after_output,after_action FROM flow_tool_calls WHERE turn IN(SELECT value FROM json_each(?)) ORDER BY seq",[&ids])?{journal.push(json!({"kind":"flow_tool","turnId":r["turn"],"callId":r["call_id"],"call":data::json(&r["call"] )?,"result":data::json(&r["result"] )?,"afterOutput":r["after_output"],"afterAction":r["after_action"]}));}
    }
    let mut artifacts = Vec::new();
    for table in ["generated_files", "mcp_files", "image_generations"] {
        if !data::table(db, table)? || !data::table(db, "files")? {
            continue;
        }
        let sql=format!("SELECT DISTINCT f.id,f.name,f.digest,length(f.bytes) size FROM {table} o JOIN files f ON f.id=o.file JOIN record_scopes s ON s.table_name='files' AND s.key_json=json_array(f.id) AND s.project=? AND (s.visibility='project' OR s.account=?) WHERE o.turn IN(SELECT value FROM json_each(?)) ORDER BY f.seq");
        for r in rows(
            db,
            &sql,
            [string(t, "project"), string(t, "initiator_account"), &ids],
        )? {
            if !artifacts.iter().any(|a: &Value| a["id"] == r["id"]) {
                artifacts.push(r);
            }
        }
    }
    if data::table(db, "generated_files")? && data::table(db, "files")? {
        for r in rows(db,"SELECT turn,call_id,call,after_action,file,row_number() OVER(PARTITION BY turn ORDER BY seq)-1 output_index FROM generated_files WHERE turn IN(SELECT value FROM json_each(?)) ORDER BY seq",[&ids])? {
            if let Some(file)=artifacts.iter().find(|a|a["id"]==r["file"]) {
                let call=data::json(&r["call"])?;
                journal.push(json!({"kind":"generated_output","turnId":r["turn"],"callId":r["call_id"],"functionName":call["function"]["name"],"callDigest":hash(string(&r,"call")),"argumentsOmitted":true,"afterAction":r["after_action"],"outputIndex":r["output_index"],"result":{"fileRef":file}}));
            }
        }
    }
    for r in rows(db,"WITH RECURSIVE chain(id,depth) AS(SELECT id,0 FROM tasks WHERE logical_turn=? AND predecessor_task IS NULL UNION ALL SELECT t.id,c.depth+1 FROM tasks t JOIN chain c ON t.predecessor_task=c.id) SELECT r.task,r.action,r.digest,r.size,r.encoding,r.content_json,a.sequence FROM chain c JOIN task_results r ON r.task=c.id JOIN task_actions a ON a.id=r.action ORDER BY c.depth,a.sequence",[string(t,"logical_turn")])? {
        journal.push(json!({"kind":"task_result","taskId":r["task"],"actionId":r["action"],"sequence":r["sequence"],"resultRef":{"v":1,"taskId":r["task"],"actionId":r["action"],"digest":r["digest"],"size":r["size"],"encoding":r["encoding"]},"result":data::json(&r["content_json"])?}));
    }
    Ok(json!({"coordination":coordination,"toolJournal":journal,"artifacts":artifacts}))
}
pub fn assets(db: &Connection, t: &Value, skills: &Value) -> Result<Vec<Value>> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let mut assets = Vec::new();
    if !data::table(db, "skill_files")? {
        return Ok(assets);
    }
    for skill in skills.as_array().ok_or_else(Failure::storage)? {
        if let Some(r)=one(db,"SELECT f.files FROM skill_files f JOIN record_scopes s ON s.table_name='skill_files' AND s.key_json=json_array(f.skill,f.revision) JOIN projects p ON p.id=s.project JOIN agent_authority h ON h.agent=? AND h.owner_account=s.account AND h.owner_account=p.account WHERE f.skill=? AND f.revision=?",params![string(t,"agent"),string(skill,"skill"),n(skill,"revision")])? {
   let files=data::json(&r["files"])?;
   for f in files.as_array().ok_or_else(Failure::storage)? {
    let bytes=if f["encoding"]=="base64" {STANDARD.decode(string(f,"content")).map_err(|_|Failure::storage())?}else{string(f,"content").as_bytes().to_vec()};
    use sha2::{Digest,Sha256};let digest=Sha256::digest(&bytes).iter().map(|b|format!("{b:02x}")).collect::<String>();
    assets.push(json!({"skillId":skill["skill"],"skillRevision":skill["revision"],"installationRevision":skill["installation_revision"],"source":f["path"],"digest":digest,"size":bytes.len()}));
   }
  }
    }
    Ok(assets)
}
pub fn messages(db: &Connection, t: &Value) -> Result<Vec<Value>> {
    if !data::table(db, "agent_requests")? {
        return Ok(vec![]);
    }
    let project = string(t, "project");
    let account = string(t, "initiator_account");
    let turn = string(t, "logical_turn");
    if exists(db, "SELECT 1 FROM agent_requests r WHERE r.turn=? AND NOT EXISTS(SELECT 1 FROM record_scopes s JOIN tasks source ON source.id=s.root_id AND source.logical_turn=r.turn AND source.project=s.project AND source.initiator_account=? WHERE s.table_name='agent_requests' AND s.key_json=json_array(r.id) AND s.root_kind='task' AND s.project=? AND (s.visibility='project' OR s.account=?)) LIMIT 1", [turn, account, project, account])? {
        return Err(fail(403, "record_scope_missing", "Teammate request scope is unavailable."));
    }
    let mut output = Vec::new();
    for request in rows(db, "SELECT r.* FROM agent_requests r JOIN record_scopes s ON s.table_name='agent_requests' AND s.key_json=json_array(r.id) JOIN tasks source ON source.id=s.root_id AND source.logical_turn=r.turn AND source.project=s.project AND source.initiator_account=? WHERE r.turn=? AND s.project=? AND (s.visibility='project' OR s.account=?) ORDER BY r.rowid", [account, turn, project, account])? {
        let deliveries = rows(db, "SELECT d.turn,t.agent,t.thread,t.reply,t.error,t.paused,t.status,a.name,k.state FROM agent_deliveries d JOIN turns t ON t.id=d.turn JOIN agents a ON a.id=t.agent JOIN tasks k ON k.logical_turn=t.id AND k.project=? AND k.initiator_account=? AND NOT EXISTS(SELECT 1 FROM tasks next WHERE next.predecessor_task=k.id) WHERE d.request=? ORDER BY t.seq", [project, account, string(&request,"id")])?;
        if deliveries.is_empty() {
            return Err(fail(403, "record_scope_missing", "Delivery scope is unavailable."));
        }
        let mut replies = Vec::new();
        for row in deliveries {
            let key = json!([row["turn"]]).to_string();
            if !exists(db,"SELECT 1 FROM record_scopes WHERE table_name='turns' AND key_json=? AND project=? AND (visibility='project' OR account=?)",[&key,project,account])? || !exists(db,"SELECT 1 FROM record_scopes WHERE table_name='agent_deliveries' AND key_json=? AND project=? AND root_kind='task' AND root_id=? AND (visibility='project' OR account=?)",[&key,project,string(&row,"turn"),account])? {
                return Err(fail(403, "record_scope_missing", "Delivery scope is unavailable."));
            }
            let status = match string(&row,"state") {
                "completed" => "done", "cancelled" => "cancelled", "failed" => "failed", "uncertain" => "interrupted", _ => string(&row,"status")
            };
            replies.push(json!({"id":row["turn"],"agent":row["agent"],"thread":row["thread"],"name":row["name"],"status":status,"paused":if row["state"]=="cancelled"{json!(0)}else{row["paused"].clone()},"reply":if request["expects_reply"]==1&&!row["reply"].is_null(){json!(String::from_utf16_lossy(&string(&row,"reply").encode_utf16().take(16000).collect::<Vec<_>>()))}else{Value::Null},"error":row["error"],"truncated":string(&row,"reply").encode_utf16().count()>16000}));
        }
        output.push(json!({"kind":"agent_message","request":request["id"],"expects_reply":request["expects_reply"]==1,"replies":replies}));
    }
    Ok(output)
}
pub fn waiting_agents(db: &Connection, task: &Value) -> Result<()> {
    if messages(db, task)?.iter().any(|m| {
        m["expects_reply"] == true
            && m["replies"].as_array().is_some_and(|rs| {
                rs.iter().any(|r| {
                    !["done", "failed", "interrupted", "cancelled"].contains(&string(r, "status"))
                        || r["paused"] == 1
                })
            })
    }) {
        let mut error = fail(409, "waiting_agents", "Waiting for teammate results.");
        error.retryable = true;
        return Err(error);
    }
    Ok(())
}
