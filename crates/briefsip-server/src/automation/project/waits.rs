use super::*;
use crate::{
    computer::devices,
    db::{canonical, digest},
};
use uuid::Uuid;

fn invalid() -> Failure {
    Failure::new(
        409,
        "wait_invalid",
        "Workflow wait scope is no longer active.",
    )
}

pub(super) fn reserve(s: &Scope, run: &Value, node: &Value, seq: i64) -> Result<()> {
    let db = s.db;
    let key = canonical(&json!(["workflow", run["id"], seq]));
    if exists(
        db,
        "SELECT 1 FROM wait_provisions WHERE target_key=? AND secret_generation=1",
        [&key],
    )? {
        return Ok(());
    }
    let (_, device) = s.device(string(run, "agent"))?;
    let authority = one(
        db,
        "SELECT generation FROM authority_state WHERE id=1 AND serving_state='active'",
        [],
    )?
    .ok_or_else(invalid)?;
    let mut body = json!({"v":1,"provisionId":Uuid::new_v4().to_string(),"waitKey":key,"projectId":s.project,"agentId":run["agent"],"sourceDeviceId":device["id"],"sourceDeviceGeneration":device["generation"],"authorityGeneration":authority["generation"],"secretGeneration":1,"event":node["event"],"deadline":s.state.config.now()+node["timeoutSeconds"].as_i64().ok_or_else(invalid)?*1000,"target":{"kind":"workflow","runId":run["id"],"seq":seq,"nodeId":node["id"],"expectedRunRevision":run["revision"]}});
    let payload = digest(&canonical(&json!(["briefsip-wait-provision-v1", body])));
    body["payloadDigest"] = json!(payload);
    db.execute("INSERT INTO wait_provisions(id,project,agent,source_device,source_generation,authority_generation,target_key,secret_generation,payload_digest,request_json,deadline,state) VALUES(?,?,?,?,?,?,?,1,?,?,?,'pending')",
        params![body["provisionId"].as_str(),s.project,run["agent"].as_str(),device["id"].as_str(),device["generation"].as_i64(),authority["generation"].as_str(),key,payload,canonical(&json!({"provision":body})),body["deadline"].as_i64()])?;
    Ok(())
}

fn run_identity(db: &Connection, run: &str) -> Result<Value> {
    one(db,"SELECT s.project,c.actor,r.workflow FROM workflow_runs r JOIN receipts c ON c.request_id=r.id JOIN record_scopes s ON s.table_name='workflow_runs' AND s.key_json=json_array(r.id) AND s.root_kind='workflow' AND s.root_id=r.workflow AND s.project=c.project WHERE r.id=?",[run])?.ok_or_else(missing)
}

fn reservation_target(s: &Scope, provision: &Value) -> Result<(Value, Value, Value)> {
    let target = &provision["target"];
    let run_id = string(target, "runId");
    let (run, workflow) = workflows::run_root(s, run_id)?;
    let (_, device) = s.device(string(&run, "agent"))?;
    let graph = data::json(&run["graph"])?;
    let node = graph["nodes"]
        .as_array()
        .and_then(|nodes| nodes.iter().find(|node| node["id"] == target["nodeId"]))
        .cloned()
        .ok_or_else(invalid)?;
    if run["status"] != "ready"
        || run["revision"] != target["expectedRunRevision"]
        || run["steps"].as_i64().unwrap_or(0) + 1 != target["seq"].as_i64().ok_or_else(invalid)?
        || run["cursor"] != target["nodeId"]
        || node["kind"] != "wait"
        || node["event"] != provision["event"]
        || device["id"] != provision["sourceDeviceId"]
        || device["generation"] != provision["sourceDeviceGeneration"]
        || run["agent"] != provision["agentId"]
        || workflow["deleted"] != 0
    {
        return Err(invalid());
    }
    let mapping = s.scope("workflow_runs", json!([run_id]), string(&run, "workflow"))?;
    Ok((run, node, mapping))
}

fn result_or_denied<T>(result: Result<T>) -> Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if [403, 404, 409].contains(&error.status) => Ok(None),
        Err(error) => Err(error),
    }
}

fn receipt(
    db: &Connection,
    account: &str,
    project: &str,
    scope: &str,
    result: Value,
) -> Result<Value> {
    let r = &result["receipt"];
    db.execute(
        "INSERT INTO receipts VALUES(?,?,?,?,?,?,?,?)",
        params![
            r["requestId"].as_str(),
            account,
            project,
            scope,
            r["payloadDigest"].as_str(),
            r["status"].as_i64(),
            canonical(&result),
            r["committedAt"].as_i64()
        ],
    )?;
    Ok(result)
}

pub(crate) fn activate(
    state: &AppState,
    db: &Connection,
    provision: &Value,
    result: &Value,
    pending: bool,
) -> Result<Value> {
    let target = &provision["target"];
    let id = string(target, "runId");
    let project = string(provision, "projectId");
    let admission = one(
        db,
        "SELECT actor FROM receipts WHERE request_id=? AND project=?",
        [id, project],
    )?
    .ok_or_else(invalid)?;
    let account = string(&admission, "actor");
    let s = Scope {
        state,
        db,
        account,
        project,
        kind: "Workflow",
    };
    let current = result_or_denied(reservation_target(&s, provision))?;
    let now = state.config.now();
    let expired = provision["deadline"].as_i64().unwrap_or(0) <= now;
    let active = pending && current.is_some() && result["state"] == "ready" && !expired;
    let reason = if expired {
        "wait_expired"
    } else if result["state"] == "failed" {
        string(result, "errorCode")
    } else {
        "wait_invalid"
    };
    let seq = target["seq"].as_i64().ok_or_else(invalid)?;
    if pending {
        if let Some((run,node,mapping)) = current {
            db.execute("INSERT INTO workflow_steps(run,seq,node,status,settings,detail) VALUES(?,?,?,?,?,?)",params![id,seq,target["nodeId"].as_str(),if active {"waiting"} else {"failed"},canonical(&node),(!active).then_some(reason)])?;
            let root = string(&run,"workflow");
            s.map("workflow_steps",json!([id,seq]),root,&mapping)?;
            if active {
                let secret_ref = canonical(&json!([provision["waitKey"],provision["secretGeneration"]]));
                if result["secretRef"] != secret_ref {
                    return Err(invalid());
                }
                db.execute("INSERT INTO workflow_waits(run,seq,event,secret_ref,secret_generation,source_device_id,deadline,status) VALUES(?,?,?,?,?,?,?,'waiting')",params![id,seq,provision["event"].as_str(),secret_ref,provision["secretGeneration"].as_i64(),provision["sourceDeviceId"].as_str(),provision["deadline"].as_i64()])?;
                s.map("workflow_waits",json!([id,seq]),root,&mapping)?;
            }
            db.execute("UPDATE workflow_runs SET steps=?,status=?,error=?,revision=revision+1 WHERE id=? AND revision=?",params![seq,if active {"waiting"}else{"failed"},(!active).then_some(reason),id,target["expectedRunRevision"].as_i64()])?;
            s.observe("workflow_run",id)?;
        } else if db.execute("UPDATE workflow_runs SET status='failed',error=?,revision=revision+1 WHERE id=? AND revision=? AND status='ready'",params![reason,id,target["expectedRunRevision"].as_i64()])? != 0 {
            s.observe("workflow_run",id)?;
        }
    }
    let run =
        one(db, "SELECT revision FROM workflow_runs WHERE id=?", [id])?.ok_or_else(invalid)?;
    let outcome = if active { "activated" } else { "closed" };
    let receipt = receipt(
        db,
        account,
        project,
        &format!("workflow-wait-activation:{id}"),
        json!({"status":200,"data":{"run":id,"seq":seq,"state":outcome},"receipt":{"requestId":provision["provisionId"],"actorId":account,"projectId":project,"payloadDigest":provision["payloadDigest"],"status":200,"recordId":id,"recordRevision":run["revision"],"committedAt":now}}),
    )?;
    Ok(json!({"state":outcome,"receipt":receipt["receipt"]}))
}

pub(super) fn maintain(state: &AppState, db: &Connection) -> Result<()> {
    if !exists(
        db,
        "SELECT 1 FROM authority_state WHERE id=1 AND serving_state='active'",
        [],
    )? {
        return Ok(());
    }
    let now = state.config.now();
    for row in all(db,"SELECT * FROM wait_provisions WHERE state='pending' AND json_extract(request_json,'$.provision.target.kind')='workflow' AND deadline<=? ORDER BY deadline,id LIMIT 40",[now])? {
        maintenance_transaction(db,|| {
            let provision = data::json(&row["request_json"])?["provision"].clone();
            activate(state,db,&provision,&json!({"state":"failed","errorCode":"wait_expired"}),true)?;
            db.execute("UPDATE wait_provisions SET state='closed' WHERE id=?",[string(&row,"id")])?;
            Ok(())
        })?;
    }
    for row in all(db,"SELECT w.*,r.status run_status,r.steps,s.project FROM workflow_waits w JOIN workflow_runs r ON r.id=w.run JOIN record_scopes s ON s.table_name='workflow_runs' AND s.key_json=json_array(r.id) WHERE w.status='waiting' AND (w.deadline<=? OR r.status<>'waiting' OR r.steps<>w.seq) ORDER BY w.deadline,w.run,w.seq LIMIT 40",[now])? {
        maintenance_transaction(db,|| {
            let run = string(&row,"run");
            let seq = row["seq"].as_i64().ok_or_else(Failure::storage)?;
            let expired = row["run_status"]=="waiting" && row["steps"]==seq;
            db.execute("UPDATE workflow_waits SET status=? WHERE run=? AND seq=?",params![if expired {"expired"}else{"closed"},run,seq])?;
            db.execute("UPDATE wait_provisions SET state='closed' WHERE target_key=json_array('workflow',?,?) AND state='activated'",params![run,seq])?;
            if expired {
                db.execute("UPDATE workflow_steps SET status='failed',detail='wait_expired' WHERE run=? AND seq=? AND status='waiting'",params![run,seq])?;
                db.execute("UPDATE workflow_runs SET status='failed',error='wait_expired',revision=revision+1 WHERE id=?",[run])?;
                crate::data::sync::append_record(db,string(&row,"project"),"workflow_run",run,None,now)?;
            }
            Ok(())
        })?;
    }
    Ok(())
}

pub(crate) fn read(
    state: &AppState,
    db: &Connection,
    account: &str,
    run: &str,
    seq: i64,
) -> Result<Value> {
    let info = run_identity(db, run)?;
    let project = string(&info, "project");
    let root = string(&info, "workflow");
    let wait=one(db,"SELECT w.*,r.status run_status,r.steps,r.version FROM workflow_waits w JOIN workflow_runs r ON r.id=w.run WHERE w.run=? AND w.seq=?",params![run,seq])?.ok_or_else(missing)?;
    let s = Scope {
        state,
        db,
        account,
        project,
        kind: "Workflow",
    };
    if exists(
        db,
        "SELECT 1 FROM authority_state WHERE id=1 AND serving_state='read_only_recovery'",
        [],
    )? {
        if !exists(db,"SELECT 1 FROM projects p JOIN project_members m ON m.project=p.id AND m.account=p.account WHERE p.id=? AND p.account=? AND p.deleted=0 AND m.deleted=0 AND m.role='owner'",[project,account])? {
            return Err(missing());
        }
        for (table, key) in [
            ("workflow_runs", json!([run])),
            ("workflows", json!([root])),
            ("workflow_versions", json!([root, wait["version"]])),
        ] {
            s.scope(table, key, root)?;
        }
    } else {
        workflows::run_root(&s, run)?;
    }
    s.scope("workflow_waits", json!([run, seq]), root)?;
    s.scope("workflow_steps", json!([run, seq]), root)?;
    Ok(wait)
}

pub(crate) struct Active {
    pub wait: Value,
    pub run: Value,
    pub provision: Value,
    pub device: Value,
    pub fingerprint: String,
    pub next: Value,
}

pub(crate) fn active(
    state: &AppState,
    db: &Connection,
    run_id: &str,
    seq: i64,
    reveal: Option<(&str, i64)>,
) -> Result<Active> {
    let wait=one(db,"SELECT w.*,p.request_json FROM workflow_waits w JOIN wait_provisions p ON p.target_key=json_array('workflow',w.run,w.seq) AND p.secret_generation=w.secret_generation AND p.state='activated' WHERE w.run=? AND w.seq=?",params![run_id,seq])?.ok_or_else(missing)?;
    let identity = run_identity(db, run_id)?;
    let project = string(&identity, "project");
    if let Some((actor, expected)) = reveal {
        read(state, db, actor, run_id, seq)?;
        let viewer = Scope {
            state,
            db,
            account: actor,
            project,
            kind: "Workflow",
        };
        if viewer.member()?["role"] != "owner" {
            return Err(Failure::new(
                403,
                "owner_required",
                "Only the owner can perform this action.",
            ));
        }
        if wait["secret_generation"] != expected || !wait["delivery"].is_null() {
            return Err(invalid());
        }
    }
    let s = Scope {
        state,
        db,
        account: string(&identity, "actor"),
        project,
        kind: "Workflow",
    };
    let (run, workflow) = workflows::run_root(&s, run_id)?;
    let root = string(&workflow, "id");
    let mappings = [
        s.scope("workflow_waits", json!([run_id, seq]), root)?,
        s.scope("workflow_steps", json!([run_id, seq]), root)?,
        s.scope("workflow_runs", json!([run_id]), root)?,
    ];
    let step = one(
        db,
        "SELECT * FROM workflow_steps WHERE run=? AND seq=?",
        params![run_id, seq],
    )?
    .ok_or_else(invalid)?;
    let graph = data::json(&run["graph"])?;
    let node = graph["nodes"]
        .as_array()
        .and_then(|nodes| nodes.iter().find(|node| node["id"] == step["node"]))
        .ok_or_else(invalid)?;
    let (home, device) = s.device(string(&run, "agent"))?;
    let provision = data::json(&wait["request_json"])?["provision"].clone();
    let generation = one(
        db,
        "SELECT generation FROM authority_state WHERE id=1 AND serving_state='active'",
        [],
    )?
    .ok_or_else(invalid)?;
    if provision["target"]["kind"] != "workflow"
        || provision["target"]["runId"] != run_id
        || provision["target"]["seq"] != seq
        || node["kind"] != "wait"
        || node["id"] != provision["target"]["nodeId"]
        || node["event"] != wait["event"]
        || wait["event"] != provision["event"]
        || provision["projectId"] != project
        || provision["agentId"] != run["agent"]
        || wait["secret_ref"]
            != canonical(&json!([
                provision["waitKey"],
                provision["secretGeneration"]
            ]))
        || wait["secret_generation"] != provision["secretGeneration"]
        || wait["deadline"] != provision["deadline"]
        || wait["source_device_id"] != device["id"]
        || device["id"] != provision["sourceDeviceId"]
        || device["generation"] != provision["sourceDeviceGeneration"]
        || generation["generation"] != provision["authorityGeneration"]
        || reveal.is_some_and(|(actor, _)| device["account"] != actor)
    {
        return Err(invalid());
    }
    let now = state.config.now();
    if if wait["delivery"].is_null() {
        wait["status"] != "waiting"
            || wait["deadline"].as_i64().unwrap_or(0) <= now
            || run["status"] != "waiting"
            || run["steps"] != seq
            || run["cursor"] != node["id"]
            || step["status"] != "waiting"
    } else {
        wait["status"] != "received"
    } {
        return Err(invalid());
    }
    if !devices::waits::connection(
        db,
        string(&device, "id"),
        device["generation"].as_i64().unwrap_or(0),
        now,
    ) {
        return Err(crate::tasks::waits::offline());
    }
    let revision = one(
        db,
        "SELECT revision FROM sync_scope_revisions WHERE project=?",
        [project],
    )?;
    let fingerprint = digest(&canonical(&json!([
        run_id,
        run["revision"],
        step,
        mappings,
        s.member()?,
        home,
        device["generation"],
        device["connection_generation"],
        provision["payloadDigest"],
        wait["status"],
        wait["delivery"],
        wait["digest"],
        revision
    ])));
    Ok(Active {
        wait,
        run,
        provision,
        device,
        fingerprint,
        next: node["next"].clone(),
    })
}

pub(crate) fn deliver(
    state: &AppState,
    db: &Connection,
    current: &Active,
    verified: &Value,
    event: &Value,
) -> Result<Value> {
    let now = state.config.now();
    let id = string(&current.run, "id");
    let seq = current.wait["seq"].as_i64().ok_or_else(invalid)?;
    let project = string(&current.provision, "projectId");
    let account = string(&current.device, "account");
    let request = Uuid::new_v4().to_string();
    let revision = current.run["revision"].as_i64().ok_or_else(invalid)? + 1;
    let result = receipt(
        db,
        account,
        project,
        &format!("workflow-wait-event:{id}:{seq}"),
        json!({"status":200,"data":{"run":id,"step":seq,"delivery":verified["id"],"accepted":true},"receipt":{"requestId":request,"actorId":account,"projectId":project,"payloadDigest":digest(&canonical(&json!(["briefsip-workflow-event-v1",id,seq,verified["id"],verified["digest"]]))),"status":200,"recordId":id,"recordRevision":revision,"committedAt":now}}),
    )?;
    db.execute("UPDATE workflow_waits SET status='received',delivery=?,digest=?,result=? WHERE run=? AND seq=?",params![verified["id"].as_str(),verified["digest"].as_str(),canonical(&result),id,seq])?;
    db.execute(
        "UPDATE workflow_steps SET status='done',detail=? WHERE run=? AND seq=?",
        params![
            format!("Event received: {}", string(event, "event")),
            id,
            seq
        ],
    )?;
    db.execute(
        "UPDATE workflow_runs SET last=?,cursor=?,status='ready',revision=? WHERE id=?",
        params![canonical(event), current.next.as_str(), revision, id],
    )?;
    crate::data::sync::append_record(db, project, "workflow_run", id, None, now)?;
    Ok(result)
}
