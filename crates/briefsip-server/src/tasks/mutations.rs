use super::*;
pub fn run(
    db: &Connection,
    p: &Principal,
    task: &Value,
    v: &Value,
    token: &str,
    now: i64,
) -> Result<Value> {
    fields(
        v,
        &[
            "requestId",
            "actionId",
            "ownership",
            "toolCall",
            "payloadDigest",
            "expectedRevision",
            "fileInput",
        ],
    )?;
    if v.get("fileInput").is_some() {
        return Err(fail(
            422,
            "capability_missing",
            "Canonical file input is not available yet.",
        ));
    }
    let request = id(&v["requestId"])?;
    let action_id = id(&v["actionId"])?;
    authority::ownership(&v["ownership"])?;
    revision(&v["expectedRevision"], 1)?;
    let call = &v["toolCall"];
    fields(call, &["id", "function"])?;
    let function = &call["function"];
    fields(function, &["name", "arguments"])?;
    if !call["id"].as_str().is_some_and(|s| {
        !s.is_empty()
            && s.encode_utf16().count() <= 200
            && !s.chars().any(|c| c < ' ' || c == '\u{7f}')
    }) || !function["name"]
        .as_str()
        .is_some_and(|s| !s.is_empty() && s.encode_utf16().count() <= 160)
        || function["arguments"]
            .as_str()
            .is_none_or(|s| s.encode_utf16().count() > 20000)
    {
        return Err(fail(400, "invalid_tool_call", "Invalid tool call."));
    }
    let name = string(function, "name");
    let allowed = context::tool_fields(name)
        .ok_or_else(|| fail(422, "capability_missing", "Canonical tool is unavailable."))?;
    let args: Value = serde_json::from_str(string(function, "arguments"))
        .map_err(|_| fail(400, "invalid_tool_call", "Tool arguments must be JSON."))?;
    fields(&args, allowed)?;
    let recipient = if name == "transfer_task" {
        let recipient = id(&args["recipient"])?;
        if text(&args["task"], 16000, "task").is_err() {
            return Err(fail(400, "invalid_tool_call", "Invalid task transfer."));
        }
        Some(recipient)
    } else {
        None
    };
    let pd = hex(&v["payloadDigest"], "payloadDigest")?;
    if pd
        != digest(&json!([
            "briefsip-canonical-tool-v1",
            call,
            v["expectedRevision"],
            null
        ]))
    {
        return Err(fail(
            409,
            "payload_digest_mismatch",
            "Canonical tool digest does not match.",
        ));
    }
    authority::owner(db, p, task, &v["ownership"], token, true, now)?;
    let current = authority::dispatch(db, task)?;
    let scope = format!("tasks:context-mutations:{}", string(task, "id"));
    if let Some(old) = replay(
        db,
        &p.account,
        string(task, "project"),
        &request,
        &scope,
        &pd,
        false,
    )? {
        if old["data"]["actionId"] != action_id {
            return Err(fail(
                409,
                "payload_conflict",
                "Canonical request was already used by a different action.",
            ));
        }
        return Ok(old);
    }
    if matches!(name, "no_update" | "report_failure")
        && (!data::table(db, "routine_steps")?
            || !exists(
                db,
                "SELECT 1 FROM routine_steps WHERE turn=?",
                [string(task, "logical_turn")],
            )?)
    {
        return Err(fail(
            403,
            "execution_denied",
            "Routine outcome is only available for an active routine step.",
        ));
    }
    let setup = exists(
        db,
        "SELECT 1 FROM turns WHERE id=? AND profile_setup=1",
        [string(task, "logical_turn")],
    )?;
    if setup && !matches!(name, "edit_profile" | "ask_user") {
        return Err(fail(
            403,
            "execution_denied",
            "Agent setup can only change the profile or ask for clarification.",
        ));
    }
    let payload = data::json(&task["payload_json"])?;
    if name == "transfer_task" && payload["kind"] != "channel" {
        return Err(fail(
            403,
            "execution_denied",
            "Transfer tool is only available in channels.",
        ));
    }
    let channel = one(db,"WITH RECURSIVE a AS(SELECT id,parent,channel FROM turns WHERE id=? UNION SELECT t.id,t.parent,t.channel FROM turns t JOIN a ON t.id=a.parent) SELECT channel FROM a WHERE channel IS NOT NULL LIMIT 1",[string(task,"logical_turn")])?;
    if context::private(name) && channel.is_some() {
        return Err(fail(
            403,
            "execution_denied",
            "Tool is only available in private conversations.",
        ));
    }
    if matches!(name,"send_message"|"list_agents"|"interrupt_agent") && exists(db,"SELECT 1 FROM agent_deliveries d JOIN agent_requests r ON r.id=d.request WHERE d.turn=? AND r.expects_reply=0",[string(task,"logical_turn")])? {return Err(fail(403,"execution_denied","No-reply notices must not send work."));}
    authority::owner(db, p, task, &v["ownership"], token, false, now)?;
    if task["revision"] != v["expectedRevision"] {
        return Err(stale());
    }
    authority::runnable(db, task)?;
    let action = one(db,"SELECT * FROM task_actions WHERE id=? AND task=? AND action_kind='canonical' AND state='committed'",[&action_id,string(task,"id")])?.filter(|a|a["executor_generation"]==v["ownership"]["executorGeneration"]&&a["device_generation"]==v["ownership"]["deviceGeneration"]&&a["authority_generation"]==v["ownership"]["authorityGeneration"]).ok_or_else(||fail(409,"action_conflict","Canonical action is not ready."))?;
    let prepared = one(db,"SELECT result_json FROM receipts WHERE scope=? AND json_extract(result_json,'$.receipt.recordId')=?",[format!("tasks:prepare:{}",string(task,"id")),action_id.clone()])?.map(|r|data::json(&r["result_json"])).transpose()?.ok_or_else(||fail(409,"action_conflict","Tool digest is not bound to the prepare action."))?;
    let input = &prepared["input"];
    if input["payloadDigest"] != pd {
        return Err(fail(
            409,
            "action_conflict",
            "Tool digest is not bound to the prepare action.",
        ));
    }
    let mut previous = task.clone();
    previous["revision"] = input["expectedTaskRevision"].clone();
    context::fresh(
        db,
        &previous,
        &current,
        string(&action, "context_snapshot_id"),
        string(&action, "context_digest"),
    )?;
    if !data::json(&current["participation"]["capabilities_json"])?["tools"]
        .as_array()
        .is_some_and(|ts| ts.contains(&json!(name)))
    {
        return Err(fail(
            403,
            "execution_denied",
            "Tool capability was revoked.",
        ));
    }
    if action["grant_revision"] != current["assignment"] {
        return Err(fail(409, "stale_revision", "Assignment changed."));
    }
    if !matches!(
        name,
        "transfer_task"
            | "ask_user"
            | "edit_profile"
            | "read_provider_settings"
            | "set_avatar"
            | "search_memory"
            | "remember_memory"
            | "select_memory"
    ) {
        return Err(fail(
            422,
            "capability_missing",
            "Canonical tool is unavailable.",
        ));
    }
    if matches!(name, "search_memory" | "remember_memory" | "select_memory")
        && !data::table(db, "memories")?
    {
        return Err(fail(
            422,
            "capability_missing",
            "Canonical memory is not available yet.",
        ));
    }
    let result = if name == "transfer_task" {
        let mut paused = task.clone();
        paused["state"] = json!("paused");
        db.execute(
            "UPDATE tasks SET state='paused',revision=revision+1 WHERE id=?",
            [string(task, "id")],
        )?;
        db.execute(
            "UPDATE turns SET paused=1,revision=revision+1 WHERE id=?",
            [string(task, "logical_turn")],
        )?;
        db.execute(
            "UPDATE task_actions SET state='acknowledged',effect_status='known' WHERE id=?",
            [&action_id],
        )?;
        let result = human::transfer(
            db,
            &paused,
            recipient.as_deref().ok_or_else(Failure::storage)?,
            Some(string(&args, "task")),
            now,
        )?;
        json!({"logicalTurnId":result["logicalTurnId"],"previousTaskId":result["previousTaskId"],"taskId":result["taskId"],"homeDeviceId":result["homeDeviceId"],"state":result["state"],"revision":result["revision"]})
    } else {
        db.execute_batch("SAVEPOINT canonical_tool")?;
        let result = tool(db, task, &current, call, &args, &action, setup);
        let result = match result {
            Ok(result) => {
                db.execute_batch("RELEASE canonical_tool")?;
                result
            }
            Err(error) if error.status < 500 && error.code != "record_scope_missing" => {
                db.execute_batch("ROLLBACK TO canonical_tool; RELEASE canonical_tool")?;
                json!({"error":error.message,"status":error.status})
            }
            Err(error) => {
                db.execute_batch("ROLLBACK TO canonical_tool; RELEASE canonical_tool")?;
                return Err(error);
            }
        };
        db.execute(
            "UPDATE tasks SET revision=revision+1 WHERE id=?",
            [string(task, "id")],
        )?;
        result
    };
    let encoded = canonical(&result);
    let rd = hash(&encoded);
    let result_ref = json!({"v":1,"taskId":task["id"],"actionId":action_id,"digest":rd,"size":encoded.len(),"encoding":"canonical-json-v1"});
    db.execute("INSERT INTO task_results(action,task,digest,size,encoding,content_json,created) VALUES(?,?,?,?,'canonical-json-v1',?,?)",params![action_id,string(task,"id"),rd,encoded.len(),encoded,now])?;
    db.execute("UPDATE task_actions SET state='acknowledged',result_digest=?,effect_status='known',uncertain_reason=NULL WHERE id=?",params![rd,action_id])?;
    let report = json!({"v":1,"taskId":task["id"],"actionId":action_id,"payloadDigest":pd,"state":"reported","effectStatus":"known","resultDigest":rd,"resultRef":result_ref});
    let report_digest = digest(&json!([
        "briefsip-canonical-tool-v1",
        task["id"],
        action_id,
        pd,
        rd
    ]));

    observe(db, task, now)?;
    let mut data = json!({"actionId":action_id,"resultRef":result_ref,"resultContent":result});
    if name == "transfer_task" {
        data["successor"] = result;
    }
    let result = Save {
        account: &p.account,
        task,
        request: &request,
        scope: &scope,
        payload: &pd,
        now,
    }
    .save(
        db,
        &action_id,
        n(task, "revision") + if name == "transfer_task" { 2 } else { 1 },
        200,
        data,
        None,
    )?;
    db.execute("INSERT INTO task_reports(action,report_digest,device,journal_sequence,payload_json,result_ref,receipt_id) VALUES(?,?,?,?,?,?,?)",params![action_id,report_digest,p.device,n(input,"journalSequence"),canonical(&report),action_id,request])?;
    Ok(result)
}
fn tool(
    db: &Connection,
    task: &Value,
    current: &Value,
    call: &Value,
    args: &Value,
    action: &Value,
    setup: bool,
) -> Result<Value> {
    let agent = string(task, "agent");
    let turn = string(task, "logical_turn");
    match string(&call["function"], "name") {
        "edit_profile" => {
            let revision = revision(&args["revision"], 1)?;
            if setup && (args.get("name").is_none() || args.get("instructions").is_none()) {
                return Err(fail(
                    400,
                    "invalid_profile",
                    "Profile setup must save the name and instructions together.",
                ));
            }
            if revision == 9007199254740991
                || ["name", "role", "instructions"]
                    .iter()
                    .all(|k| args.get(k).is_none())
            {
                return Err(fail(400, "invalid_profile", "Invalid profile change."));
            }
            let name = args
                .get("name")
                .map(|v| text(v, 80, "name").map(|s| s.trim().to_owned()))
                .transpose()?;
            let instructions = args
                .get("instructions")
                .map(|v| text(v, 8000, "instructions").map(|s| s.trim().to_owned()))
                .transpose()?;
            let role = args
                .get("role")
                .map(|v| {
                    v.as_str()
                        .filter(|s| {
                            s.trim().encode_utf16().count() <= 60 && !s.chars().any(|c|c.is_control()||matches!(c,'\u{2028}'|'\u{2029}'))
                        })
                        .map(str::trim)
                        .ok_or_else(|| fail(400, "invalid_profile", "Role must be a single line of up to 60 characters without control characters."))
                })
                .transpose()?;
            if current["participation"]["agent_revision"] != revision {
                return Err(fail(
                    409,
                    "stale_revision",
                    "Profile changed. Ask the user for guidance before changing it again.",
                ));
            }
            db.execute("UPDATE agents SET name=coalesce(?,name),role=coalesce(?,role),instructions=coalesce(?,instructions),revision=revision+1 WHERE id=? AND revision=?",params![name,role,instructions,agent,revision])?;
            one(
                db,
                "SELECT name,role,instructions,revision FROM agents WHERE id=?",
                [agent],
            )?
            .ok_or_else(Failure::storage)
        }
        "ask_user" => {
            let invalid = || fail(400, "invalid_question", "Invalid question or choices.");
            let prompt = args["question"]
                .as_str()
                .filter(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 2000)
                .ok_or_else(invalid)?;
            let choices = args["choices"]
                .as_array()
                .filter(|c| c.len() <= 8)
                .ok_or_else(invalid)?;
            let mut clean = Vec::new();
            for c in choices {
                let c = c
                    .as_str()
                    .filter(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 200)
                    .ok_or_else(invalid)?
                    .trim();
                if clean.contains(&c) {
                    return Err(invalid());
                }
                clean.push(c);
            }
            if exists(
                db,
                "SELECT 1 FROM questions WHERE turn=? AND (answer IS NULL OR call_id=?)",
                [turn, string(call, "id")],
            )? || db.query_row("SELECT count(*) FROM questions WHERE turn=?", [turn], |r| {
                r.get::<_, i64>(0)
            })? >= 8
            {
                return Err(fail(
                    409,
                    "question_limit",
                    "Task question limit reached or question ID was already used.",
                ));
            }
            let id = uuid::Uuid::new_v4().to_string();
            let count = if data::table(db, "generated_files")? {
                db.query_row(
                    "SELECT count(*) FROM generated_files WHERE turn=?",
                    [turn],
                    |r| r.get::<_, i64>(0),
                )?
            } else {
                0
            };
            db.execute(
                "INSERT INTO questions VALUES(?,?,?,?,?,?,NULL,?,?)",
                params![
                    id,
                    turn,
                    string(call, "id"),
                    canonical(call),
                    prompt.trim(),
                    canonical(&json!(clean)),
                    count,
                    n(action, "sequence")
                ],
            )?;
            let root = sources::root(db, task)?;
            let payload = data::json(&task["payload_json"])?;
            db.execute(
                "INSERT INTO record_scopes VALUES('questions',?,?,?,?,?,?)",
                params![
                    json!([id]).to_string(),
                    string(task, "initiator_account"),
                    string(task, "project"),
                    if payload["kind"] == "channel" {
                        "project"
                    } else {
                        "owner"
                    },
                    string(&root, "root_kind"),
                    string(&root, "root_id")
                ],
            )?;
            db.execute(
                "UPDATE tasks SET state='paused' WHERE id=?",
                [string(task, "id")],
            )?;
            db.execute("UPDATE turns SET status='queued',paused=1,revision=revision+1,error=NULL WHERE id=?",[turn])?;
            Ok(json!({"id":id,"prompt":prompt.trim(),"choices":clean,"answer":null}))
        }
        "read_provider_settings" => {
            let profile = one(
                db,
                "SELECT revision,model,backup_model FROM agents WHERE id=?",
                [agent],
            )?
            .ok_or_else(Failure::storage)?;
            let binding = if current["participation"]["provider_binding"].is_null() {
                None
            } else {
                one(db,"SELECT provider_account_id,readiness FROM provider_bindings WHERE id=? AND device=? AND owner_account=?",[string(&current["participation"],"provider_binding"),string(task,"home_device"),string(&current["member"],"account")])?
            };
            if !current["participation"]["provider_binding"].is_null() && binding.is_none() {
                return Err(fail(
                    409,
                    "binding_stale",
                    "Provider binding is unavailable.",
                ));
            }
            Ok(
                json!({"revision":profile["revision"],"providerAccount":binding.as_ref().map(|b|string(b,"provider_account_id")).unwrap_or(""),"model":profile["model"],"backupModel":profile["backup_model"],"configured":binding.as_ref().is_some_and(|b|b["readiness"]=="ready")}),
            )
        }
        name @ ("search_memory" | "remember_memory" | "select_memory") => {
            if !data::table(db, "memories")? {
                return Err(fail(
                    422,
                    "capability_missing",
                    "Canonical memory is not available yet.",
                ));
            }
            let channel = authority::ancestors(db, task)?
                .into_iter()
                .find_map(|r| r["channel"].as_str().map(str::to_owned));
            let kind = if channel.is_some() {
                "channel"
            } else {
                "agent"
            };
            let root = channel.as_deref().unwrap_or(agent);
            let visibility = if channel.is_some() {
                "project"
            } else {
                "owner"
            };
            let scope = format!(
                "project:{}/{}:{root}{}",
                string(task, "project"),
                if channel.is_some() {
                    "channels"
                } else {
                    "agents"
                },
                if channel.is_some() {
                    String::new()
                } else {
                    format!("/human:{}", string(task, "initiator_account"))
                }
            );
            if exists(db,"SELECT 1 FROM memories m WHERE m.scope=? AND NOT EXISTS(SELECT 1 FROM record_scopes s WHERE s.table_name='memories' AND s.key_json=json_array(m.scope,m.id) AND s.project=? AND s.root_kind=? AND s.root_id=? AND s.visibility=? AND (?=1 OR s.account=?)) LIMIT 1",params![scope,string(task,"project"),kind,root,visibility,i64::from(channel.is_some()),string(task,"initiator_account")])? {return Err(fail(403,"record_scope_missing","Memory does not have a verified scope yet."));}
            let result = crate::turns::canonical_memory(db, &scope, name, args)?;
            if name == "remember_memory" && result["id"].is_string() {
                db.execute(
                    "INSERT OR IGNORE INTO record_scopes VALUES('memories',?,?,?,?,?,?)",
                    params![
                        json!([scope, result["id"]]).to_string(),
                        string(task, "initiator_account"),
                        string(task, "project"),
                        visibility,
                        kind,
                        root
                    ],
                )?;
            }
            Ok(result)
        }
        "set_avatar" => {
            if !data::integer(&args["revision"], 0, 9007199254740990) {
                return Err(fail(400, "invalid_avatar", "Invalid avatar revision."));
            }
            if args["image"] != Value::Null || args.get("image").is_none() {
                id(&args["image"])?;
                return Err(fail(
                    422,
                    "capability_missing",
                    "Canonical file input is not available yet.",
                ));
            }
            let current = one(
                db,
                "SELECT revision FROM agent_avatars WHERE agent=?",
                [agent],
            )?
            .map(|r| n(&r, "revision"))
            .unwrap_or(0);
            if args["revision"] != current {
                return Err(fail(
                    409,
                    "stale_revision",
                    "Avatar changed. Ask the user for guidance before changing it again.",
                ));
            }
            db.execute("INSERT INTO agent_avatars(agent,revision,image) VALUES(?,?,NULL) ON CONFLICT(agent) DO UPDATE SET revision=excluded.revision,image=NULL",params![agent,current+1])?;
            Ok(json!({"revision":current+1,"present":false}))
        }
        _ => Err(fail(
            422,
            "capability_missing",
            "Canonical tool is unavailable.",
        )),
    }
}
