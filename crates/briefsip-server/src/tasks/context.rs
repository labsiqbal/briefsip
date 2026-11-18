use super::*;
pub fn fresh(
    db: &Connection,
    task: &Value,
    current: &Value,
    snapshot: &str,
    digest_value: &str,
) -> Result<Value> {
    let row = one(
        db,
        "SELECT * FROM task_context_snapshots WHERE task=? AND snapshot_id=? AND context_digest=?",
        [string(task, "id"), snapshot, digest_value],
    )?
    .ok_or_else(|| fail(409, "context_stale", "Context changed. Get a new snapshot."))?;
    let authority: Value = one(db, "SELECT generation FROM authority_state WHERE id=1", [])?
        .ok_or_else(Failure::storage)?;
    if row["authority_generation"] != authority["generation"]
        || row["project_revision"] != current["member"]["revision"]
        || row["agent_revision"] != current["participation"]["agent_revision"]
        || row["assignment_revision"] != current["assignment"]
        || row["capability_revision"] != current["participation"]["capability_revision"]
        || data::json(&row["snapshot_json"])?.get("taskRevision") != task.get("revision")
        || data::json(&row["snapshot_json"])?["sourceRevisions"]
            != sources::get(db, task, current)?["sourceRevisions"]
    {
        return Err(fail(
            409,
            "context_stale",
            "Context changed. Get a new snapshot.",
        ));
    }
    Ok(row)
}
pub fn snapshot(
    db: &Connection,
    p: &Principal,
    task: &Value,
    v: &Value,
    now: i64,
) -> Result<Value> {
    fields(v, &["requestId", "ownership", "expectedTaskRevision"])?;
    let request = id(&v["requestId"])?;
    let scope = format!("tasks:context:{}", string(task, "id"));
    let pd = digest(&json!(["briefsip-task-context-v1", task["id"], v]));
    if let Some(old) = replay(
        db,
        &p.account,
        string(task, "project"),
        &request,
        &scope,
        &pd,
        false,
    )? {
        let mut old = old;
        let saved = one(
            db,
            "SELECT snapshot_json FROM task_context_snapshots WHERE task=? AND snapshot_id=?",
            [
                string(task, "id"),
                string(&old["data"]["snapshotRef"], "snapshotId"),
            ],
        )?
        .ok_or_else(Failure::storage)?;
        old["data"]["snapshot"] = data::json(&saved["snapshot_json"])?;
        return Ok(old);
    }
    authority::ownership(&v["ownership"])?;
    if terminal(task) || task["state"] == "uncertain" {
        return Err(fail(409, "task_not_runnable", "Task cannot be resumed."));
    }
    if data::table(db, "turn_waits")?
        && exists(
            db,
            "SELECT 1 FROM turn_waits WHERE turn=? AND status='waiting'",
            [string(task, "logical_turn")],
        )?
    {
        let mut error = fail(409, "event_pending", "Task is waiting for an event.");
        error.retryable = true;
        return Err(error);
    }
    sources::waiting_agents(db, task)?;
    if authority::unresolved(db, string(task, "id"))? {
        return Err(fail(
            409,
            "outcome_unresolved",
            "Previous action is not reconciled yet.",
        ));
    }
    if task["revision"] != v["expectedTaskRevision"] {
        return Err(stale());
    }
    let current = authority::dispatch(db, task)?;
    let payload = data::json(&task["payload_json"])?;
    let source = sources::get(db, task, &current)?;
    let memories = source["memory"]
        .as_array()
        .ok_or_else(Failure::storage)?
        .iter()
        .filter(|r| r["essential"] == 1)
        .map(|r| json!({"id":r["id"],"text":r["text"],"revision":r["revision"]}))
        .collect::<Vec<_>>();
    let skills = source["skills"].as_array().ok_or_else(Failure::storage)?.iter()
        .map(|r| json!({"id":r["skill"],"revision":r["revision"],"name":r["name"],"description":r["description"],"content":r["content"],"installationRevision":r["installation_revision"]})).collect::<Vec<_>>();
    if source["memory"].as_array().is_some_and(|r| r.len() > 128)
        || canonical(&json!(memories)).len() > 8192
        || canonical(&json!(skills)).len() > 65536
    {
        return Err(fail(
            413,
            "context_too_large",
            "Memory or skill context exceeds the limit.",
        ));
    }
    let mut profile = one(db,"SELECT json_extract(snapshot_json,'$.profile') profile FROM task_context_snapshots WHERE task=? ORDER BY context_revision LIMIT 1",[string(task,"id")])?
        .map(|r| data::json(&r["profile"])).transpose()?.unwrap_or_else(|| json!({"name":current["participation"]["name"],"role":current["participation"]["role"],"model":current["participation"]["model"],"instructions":current["participation"]["instructions"],"revision":current["participation"]["agent_revision"]}));
    if let Some(step) = one(
        db,
        "SELECT model FROM workflow_steps WHERE turn=? AND model IS NOT NULL",
        [string(task, "logical_turn")],
    )? {
        profile["model"] = step["model"].clone();
    }
    profile["avatarRevision"] = source["avatarRevision"].clone();
    let mut conversation = json!({"kind":payload["kind"],"message":payload["message"],"history":source["history"],"questions":source["questions"],"compaction":source["compaction"]});
    if !source["channel"].is_null() {
        conversation["channel"] = source["channel"].clone();
    }
    let snap = json!({"v":1,"taskId":task["id"],"projectId":task["project"],"agentId":task["agent"],"homeDeviceId":task["home_device"],"taskRevision":task["revision"],"authorityGeneration":p.authority,"admission":{"logicalTurnId":task["logical_turn"],"predecessorTaskId":task["predecessor_task"],"initiatorAccountId":task["initiator_account"],"payload":payload,"payloadDigest":task["payload_digest"],"assignmentRevision":task["assignment_revision"],"capabilityRevision":task["capability_revision"],"capabilityDigest":task["capability_digest"],"capabilitySnapshot":data::json(&task["capability_snapshot_json"])?,"providerBindingId":task["provider_binding_id"],"providerBindingRevision":task["provider_binding_revision"],"providerBindingOwner":task["provider_binding_owner"]},"profile":profile,"projectRules":current["participation"]["rules"],"conversation":conversation,"memories":memories,"skills":skills,"tools":tools(db,task,&current,&source)?,"coordination":source["evidence"]["coordination"],"toolJournal":source["evidence"]["toolJournal"],"artifacts":source["evidence"]["artifacts"],"skillAssets":sources::assets(db,task,&source["skills"])?,"sourceRevisions":source["sourceRevisions"]});
    let encoded = canonical(&snap);
    let cd = hash(&encoded);
    let snapshot_id = uuid::Uuid::new_v4().to_string();
    let rev: i64 = db.query_row(
        "SELECT coalesce(max(context_revision),0)+1 FROM task_context_snapshots WHERE task=?",
        [string(task, "id")],
        |r| r.get(0),
    )?;
    let value = json!({"snapshotRef":{"v":1,"taskId":task["id"],"snapshotId":snapshot_id,"revision":rev,"digest":cd},"snapshot":snap});
    if canonical(&value).len() > 8387584 {
        return Err(fail(413, "context_too_large", "Context exceeds the limit."));
    }
    let mut result = Save {
        account: &p.account,
        task,
        request: &request,
        scope: &scope,
        payload: &pd,
        now,
    }
    .save(
        db,
        &snapshot_id,
        rev,
        200,
        json!({"snapshotRef":value["snapshotRef"]}),
        None,
    )?;
    result["data"]["snapshot"] = snap.clone();
    db.execute(
        "INSERT INTO task_context_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        params![
            string(task, "id"),
            rev,
            snapshot_id,
            p.authority,
            n(&current["member"], "revision"),
            n(&current["participation"], "agent_revision"),
            n(&current, "assignment"),
            n(&current["participation"], "capability_revision"),
            cd,
            encoded,
            request,
            now
        ],
    )?;
    Ok(result)
}
pub(super) fn tool_fields(name: &str) -> Option<&'static [&'static str]> {
    Some(match name {
        "transfer_task" => &["recipient", "task"],
        "read_history" => &["before"],
        "read_message" => &["id", "offset"],
        "list_skills" | "list_routines" | "list_agents" | "list_sites" | "list_data_tables" => {
            &["after"]
        }
        "read_skill" | "read_routine" => &["id"],
        "read_skill_file" => &["id", "path", "offset"],
        "set_routine_flow" => &["id", "revision", "links"],
        "read_provider_settings" => &[],
        "no_update" | "report_failure" => &["reason"],
        "send_message" => &["recipients", "text", "expects_reply"],
        "interrupt_agent" => &["recipient", "reason"],
        "edit_profile" => &["revision", "name", "role", "instructions"],
        "ask_user" => &["question", "choices"],
        "wait_for_event" => &["event", "timeoutSeconds"],
        "delete_site" => &["site", "revision"],
        "set_avatar" => &["image", "revision"],
        "query_data" => &["sql", "parameters"],
        "search_memory" => &["query", "after"],
        "remember_memory" => &["id", "revision", "text"],
        "select_memory" => &["items"],
        _ => return None,
    })
}
pub(super) fn private(name: &str) -> bool {
    matches!(
        name,
        "list_skills"
            | "read_skill"
            | "read_skill_file"
            | "list_routines"
            | "read_routine"
            | "set_routine_flow"
            | "read_provider_settings"
            | "edit_profile"
            | "interrupt_agent"
            | "list_sites"
            | "delete_site"
            | "set_avatar"
    )
}
fn tools(db: &Connection, task: &Value, current: &Value, source: &Value) -> Result<Vec<Value>> {
    let capabilities = data::json(&current["participation"]["capabilities_json"])?;
    let mut tools: Vec<Value> = serde_json::from_str(include_str!("../turns/tool-specs.json"))
        .map_err(|_| Failure::storage())?;
    let payload = data::json(&task["payload_json"])?;
    let setup = exists(
        db,
        "SELECT 1 FROM turns WHERE id=? AND profile_setup=1",
        [string(task, "logical_turn")],
    )?;
    let routine = exists(db, "SELECT 1 FROM routine_steps s JOIN routine_occurrences o ON o.id=s.occurrence WHERE s.turn=? AND s.state='queued' AND o.state='admitted'", [string(task,"logical_turn")])?;
    if routine {
        for name in ["no_update", "report_failure"] {
            tools.push(json!({"type":"function","function":{"name":name,"description":"Finish this routine with a reason.","parameters":{"type":"object","properties":{"reason":{"type":"string","maxLength":2000}},"required":["reason"],"additionalProperties":false}}}));
        }
    }
    let model_only = exists(
        db,
        "SELECT 1 FROM workflow_steps WHERE turn=? AND model IS NOT NULL",
        [string(task, "logical_turn")],
    )?;
    let messaging = crate::turns::messaging::allowed(db, string(task, "logical_turn"))?;
    tools.retain(|t| {
        let name = string(&t["function"], "name");
        !model_only
            && tool_fields(name).is_some()
            && (messaging || !matches!(name, "send_message" | "list_agents" | "interrupt_agent"))
            && capabilities["tools"]
                .as_array()
                .is_some_and(|c| c.contains(&json!(name)))
            && (!setup || matches!(name, "ask_user" | "edit_profile"))
            && (source["channelContext"] != true || !private(name))
            && (routine || !matches!(name, "no_update" | "report_failure"))
            && (name != "delegate_task" && name != "transfer_task"
                || payload["kind"] == "channel"
                    && source["recipients"]
                        .as_array()
                        .is_some_and(|r| !r.is_empty()))
    });
    for tool in &mut tools {
        let name = string(&tool["function"], "name").to_owned();
        if setup && name == "edit_profile" {
            tool["function"]["parameters"]["required"] =
                json!(["revision", "name", "instructions"]);
        }
        if matches!(name.as_str(), "list_data_tables" | "query_data") {
            tool["function"]["description"] = json!(format!(
                "Data is shared only within this project. {}",
                string(&tool["function"], "description")
            ));
        }
    }
    if payload["kind"] == "channel"
        && source["recipients"]
            .as_array()
            .is_some_and(|r| !r.is_empty())
        && capabilities["tools"]
            .as_array()
            .is_some_and(|r| r.contains(&json!("transfer_task")))
    {
        tools.push(json!({"type":"function","function":{"name":"transfer_task","description":"Transfer this task to another teammate, who becomes owner and completes it.","parameters":{"type":"object","properties":{"recipient":{"type":"string","enum":source["recipients"]},"task":{"type":"string","maxLength":16000}},"required":["recipient","task"],"additionalProperties":false}}}));
    }
    Ok(tools)
}
