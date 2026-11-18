use super::*;
use crate::{
    data::{agents, exists},
    harness::{
        process::{self, Process},
        snapshot::{redact, Snapshot},
    },
    turns,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};

// Codex caps each additionalContext value at 4,000 UTF-8 bytes.
fn additional_context(text: &str) -> Value {
    const MAX_BYTES: usize = 4000;
    let mut context = serde_json::Map::new();
    let mut chunk = String::new();
    let mut save = |chunk: &mut String| {
        let key = format!("briefsip_{:03}", context.len() + 1);
        context.insert(
            key,
            json!({"kind":"application","value":std::mem::take(chunk)}),
        );
    };
    for block in text.split_inclusive("\n\n") {
        if !chunk.is_empty() && chunk.len() + block.len() > MAX_BYTES {
            save(&mut chunk);
        }
        let mut rest = block;
        while rest.len() > MAX_BYTES {
            let (head, tail) = rest.split_at(rest.floor_char_boundary(MAX_BYTES));
            chunk.push_str(head);
            save(&mut chunk);
            rest = tail;
        }
        chunk.push_str(rest);
    }
    if !chunk.is_empty() {
        save(&mut chunk);
    }
    Value::Object(context)
}

pub struct Home {
    pub path: PathBuf,
    pub environment: HashMap<String, String>,
    pub fingerprint: String,
}
impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
fn private(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| Failure::storage())?;
    file.write_all(bytes).map_err(|_| Failure::storage())
}
fn home(
    runtime: &str,
    account: &data::providers::Account,
    model: &str,
    fingerprint: String,
) -> Result<Home> {
    let path = std::env::temp_dir().join(format!("briefsip-session-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&path).map_err(|_| Failure::storage())?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
        .map_err(|_| Failure::storage())?;
    let mut h = Home {
        path: path.clone(),
        environment: HashMap::from([
            ("HOME".into(), path.to_string_lossy().into_owned()),
            (
                "XDG_CONFIG_HOME".into(),
                path.join(".config").to_string_lossy().into_owned(),
            ),
            (
                "XDG_CACHE_HOME".into(),
                path.join(".cache").to_string_lossy().into_owned(),
            ),
            (
                "XDG_DATA_HOME".into(),
                path.join(".local/share").to_string_lossy().into_owned(),
            ),
        ]),
        fingerprint,
    };
    if runtime == "codex" {
        if account.family != "openai-compatible" || account.base.is_empty() {
            return Err(error(
                502,
                "Codex requires an OpenAI-compatible provider in Settings.",
            ));
        }
        data::providers::address(&account.base)
            .map_err(|_| error(502, "Invalid Codex provider URL."))?;
        let codex = path.join(".codex");
        std::fs::create_dir_all(codex.join("rules")).map_err(|_| Failure::storage())?;
        h.environment
            .insert("CODEX_HOME".into(), codex.to_string_lossy().into_owned());
        h.environment.insert(
            "BRIEFSIP_PROVIDER_KEY".into(),
            account
                .key
                .clone()
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "briefsip-no-key".into()),
        );
        private(&codex.join("config.toml"),format!("model = {}\nmodel_provider = \"briefsip\"\n[model_providers.briefsip]\nname = \"Briefsip provider\"\nbase_url = {}\nwire_api = \"responses\"\nenv_key = \"BRIEFSIP_PROVIDER_KEY\"\nrequires_openai_auth = false\nsupports_websockets = false\n",json!(model),json!(account.base.trim_end_matches('/'))).as_bytes())?;
        let mut rules = [
            "rm", "rmdir", "shred", "dd", "mkfs", "sudo", "su", "mount", "umount", "chmod",
            "chown", "kill", "pkill", "killall",
        ]
        .iter()
        .map(|s| vec![*s])
        .collect::<Vec<_>>();
        rules.extend([
            vec!["git", "push"],
            vec!["git", "reset"],
            vec!["git", "clean"],
            vec!["npm", "publish"],
            vec!["npm", "unpublish"],
            vec!["npm", "login"],
        ]);
        private(
            &codex.join("rules/default.rules"),
            rules
                .iter()
                .map(|v| format!("prefix_rule(pattern={}, decision=\"prompt\")", json!(v)))
                .collect::<Vec<_>>()
                .join("\n")
                .as_bytes(),
        )?;
    } else if runtime == "claude" && !account.base.is_empty() {
        h.environment.insert(
            "ANTHROPIC_BASE_URL".into(),
            account
                .base
                .trim_end_matches('/')
                .trim_end_matches("/v1")
                .into(),
        );
        h.environment.insert(
            "ANTHROPIC_API_KEY".into(),
            account
                .key
                .clone()
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "briefsip-no-key".into()),
        );
        h.environment.insert(
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(),
            "1".into(),
        );
    }
    Ok(h)
}
fn command_prefix(command: &str) -> Option<&str> {
    (command.len() <= 512
        && command.split(' ').all(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b))
        }))
    .then_some(command)
}
pub async fn approve(
    state: &AppState,
    turn_id: &str,
    kind: &str,
    command: Option<&str>,
    description: &str,
    input: &Value,
    token: &str,
) -> Result<bool> {
    let id = uuid::Uuid::new_v4().to_string();
    let mut changes = state.events.subscribe();
    {
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        let db = &guard.connection;
        let turn = one(
            db,
            "SELECT * FROM turns WHERE id=? AND status='running'",
            [turn_id],
        )?
        .ok_or_else(|| error(409, "Task has stopped."))?;
        let profile = agents::read(db, string(&turn, "agent"))?;
        let binding = turns::harness::workspace(state, db, &turn)?
            .ok_or_else(|| error(403, "Shell requires a workspace."))?;
        if !binding.write && turns::harness::restricted(db, &turn)? {
            return Ok(false);
        }
        let secrets = data::providers::accounts(state)?
            .into_iter()
            .filter_map(|a| a.key)
            .chain(std::iter::once(token.into()))
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();
        let prefix = command
            .filter(|_| kind == "command")
            .filter(|c| !secrets.iter().any(|s| c.contains(s)))
            .and_then(command_prefix);
        if !turns::harness::peer(db, turn_id)? {
            if let Some(prefix) = prefix {
                for row in all(db,"SELECT prefix FROM harness_policies WHERE agent=? AND runtime=? AND workspace=?",rusqlite::params![turn["agent"].as_str(),profile["runtime"].as_str(),binding.directory.to_str()])?{let saved=string(&row,"prefix");if prefix==saved||prefix.starts_with(&format!("{saved} ")){return Ok(true);}}
            }
        }
        let clean = |v: &str| {
            redact(
                &if token.is_empty() {
                    v.to_owned()
                } else {
                    v.replace(token, "[redacted]")
                },
                &secrets,
                false,
            )
        };
        let serialized = clean(&input.to_string());
        if serialized.len() > 32000 {
            return Err(error(502, "Harness approval arguments exceed 32 KiB."));
        }
        db.execute("INSERT INTO harness_approvals(id,turn,agent,runtime,workspace,kind,description,command,prefix,input,state) VALUES(?,?,?,?,?,?,?,?,?,?,'approval')",rusqlite::params![id,turn_id,turn["agent"].as_str(),profile["runtime"].as_str(),binding.directory.to_str(),kind,clean(description),command.map(clean),prefix,serialized])?;
    }
    loop {
        {
            let guard = state.database.lock().map_err(|_| Failure::storage())?;
            let row = one(
                &guard.connection,
                "SELECT state,decision FROM harness_approvals WHERE id=?",
                [&id],
            )?
            .ok_or_else(Failure::storage)?;
            if row["state"] == "decided" {
                return Ok(row["decision"] != "deny");
            }
            if row["state"] != "approval"
                || !exists(
                    &guard.connection,
                    "SELECT 1 FROM turns WHERE id=? AND status='running'",
                    [turn_id],
                )?
            {
                return Err(error(
                    409,
                    "Harness approval expired because this turn stopped.",
                ));
            }
        }
        tokio::select! {_=changes.recv()=>(),_=tokio::time::sleep(Duration::from_millis(100))=>()}
    }
}
struct Lease {
    state: AppState,
    id: String,
    external: bool,
}
impl Drop for Lease {
    fn drop(&mut self) {
        crate::mcp::revoke_session(&self.state, &self.id);
        let state = self.state.clone();
        let id = self.id.clone();
        let external = self.external;
        if external {
            let tasks = self.state.config.harness.revocations.clone();
            let task = tokio::spawn(async move {
                let _ = bridge(&state, "revoke", json!({"id":id})).await;
            });
            if let Ok(mut tasks) = tasks.lock() {
                tasks.push(task);
            };
        }
    }
}
async fn bridge(state: &AppState, operation: &str, args: Value) -> Result<Value> {
    let bridge = state
        .config
        .harness
        .test_harness_bridge
        .as_ref()
        .ok_or_else(Failure::storage)?;
    let value: Value = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| Failure::storage())?
        .post(&bridge.origin)
        .bearer_auth(&bridge.token)
        .json(&json!({"operation":operation,"args":args}))
        .send()
        .await
        .map_err(|_| error(502, "Harness fixture bridge unavailable."))?
        .json()
        .await
        .map_err(|_| Failure::storage())?;
    if value.get("error").is_some() {
        return Err(error(502, "Harness fixture bridge failed."));
    }
    Ok(value["value"].clone())
}
fn save_session(
    state: &AppState,
    agent: &str,
    conversation: &str,
    runtime: &str,
    workspace: &Path,
    id: &str,
) -> Result<()> {
    if id.is_empty() || id.len() > 256 {
        return Err(error(502, "Harness session identifier is invalid."));
    }
    let db = state.database.lock().map_err(|_| Failure::storage())?;
    db.connection.execute("INSERT INTO harness_sessions VALUES(?,?,?,?,?) ON CONFLICT(agent,conversation,runtime,workspace) DO UPDATE SET session=excluded.session",rusqlite::params![agent,conversation,runtime,workspace.to_str(),id])?;
    Ok(())
}
fn reminder(
    state: &AppState,
    turn: &Value,
    profile: &Value,
    phase: &str,
) -> Result<Option<String>> {
    if phase != "answer" {
        return Ok(None);
    }
    let db = state.database.lock().map_err(|_| Failure::storage())?;
    turns::harness::reminder(&db.connection, turn, profile)
}
fn tool(
    state: &AppState,
    turn: &str,
    snapshot: &mut Snapshot,
    id: &str,
    name: &str,
    status: &str,
) -> Result<()> {
    let db = state.database.lock().map_err(|_| Failure::storage())?;
    db.connection.execute("INSERT INTO harness_steps VALUES(?,?,?,?) ON CONFLICT(turn,id) DO UPDATE SET name=excluded.name,state=excluded.state",rusqlite::params![turn,id,name,status])?;
    drop(db);
    snapshot.tool(id, name, status)
}
async fn rpc(process: &mut Process, seq: &mut i64, method: &str, params: Value) -> Result<Value> {
    *seq += 1;
    let id = *seq;
    process
        .send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
        .await?;
    tokio::time::timeout(Duration::from_secs(15),async{loop{let value=process.next().await?;if value["id"]==id{if value.get("error").is_some(){return Err(error(502,"Harness rejected a protocol request. Check host login, version and session; no automatic replay."));}return Ok(value["result"].clone());}}}).await.map_err(|_|error(502,format!("Coding harness timed out during {method}. No automatic replay.")))?
}
pub(super) fn acp_args(runtime: &str, path: &Path) -> Vec<String> {
    match runtime {
        "hermes" if path.file_name().is_some_and(|v| v == "hermes-acp") => vec![],
        "grok" => vec![
            "--permission-mode".into(),
            "default".into(),
            "agent".into(),
            "stdio".into(),
        ],
        "gemini" => vec!["--experimental-acp".into()],
        "kiro" => vec![
            "acp".into(),
            "--agent-engine=v3".into(),
            "--auth-method=cli".into(),
        ],
        _ => vec!["acp".into()],
    }
}
#[allow(clippy::too_many_arguments)]
async fn execute(
    state: &AppState,
    turn: &Value,
    profile: &Value,
    runtime: &str,
    model: &str,
    messages: &[Value],
    phase: &str,
    call: i64,
    token: &str,
    env: HashMap<String, String>,
    saved: Option<String>,
    binding: &crate::config::WorkspaceConfig,
    secrets: Vec<String>,
) -> Result<String> {
    let executable = super::executable(state, runtime).ok_or_else(|| {
        error(
            503,
            "Coding runtime requires an installed executable on PATH.",
        )
    })?;
    let workspace = &binding.directory;
    let mcp_url = crate::mcp::url(state);
    let native_model = if ["codex", "claude"].contains(&runtime) {
        model.to_owned()
    } else {
        let db = state.database.lock().map_err(|_| Failure::storage())?;
        one(
            &db.connection,
            "SELECT model FROM harness_models WHERE agent=? AND runtime=?",
            [string(turn, "agent"), runtime],
        )?
        .map(|v| string(&v, "model").to_owned())
        .unwrap_or_default()
    };
    let instructions = {
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        turns::harness::instructions(state, &guard.connection, turn, runtime, &native_model)?
    };
    let mut prompt = messages
        .iter()
        .map(|v| {
            format!(
                "{}: {}",
                string(v, "role"),
                v["content"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| v["content"].to_string())
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    prompt = format!(
        "{}\n\n{prompt}",
        if saved.is_some() {
            "Continuing the saved harness conversation. The Briefsip transcript below is reference context; follow its latest user request."
        } else {
            "Briefsip owns tasks and approvals. Use the briefsip MCP server for agent communication and delegation."
        }
    );
    if messages
        .iter()
        .any(|v| v["role"] == "system" && string(v, "content").contains("Interrupted task context"))
    {
        prompt = format!("Harness restart context. Never replay uncertain operations.\n\n{prompt}");
    }
    if prompt.len() > 2 * 1024 * 1024 {
        return Err(error(
            502,
            "Coding harness context exceeds 2 MiB. Start a new conversation.",
        ));
    }
    let mut session = saved
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut args = if runtime == "codex" {
        vec!["app-server".into()]
    } else if runtime == "claude" {
        let shim = std::env::current_exe().map_err(|_| Failure::storage())?;
        let mut args=vec!["--print".into(),"--output-format".into(),"stream-json".into(),"--input-format".into(),"stream-json".into(),"--verbose".into(),"--include-partial-messages".into(),"--permission-prompt-tool".into(),"stdio".into(),"--permission-mode".into(),"default".into(),"--setting-sources".into(),"".into(),"--strict-mcp-config".into(),"--append-system-prompt".into(),format!("{instructions}\nUse briefsip run_shell for workspace commands. Native Bash requires approval. run_shell provides a separate workspace sandbox without host credentials or network. Discover tools needed for the task together; reuse loaded tools and their receipts."),"--mcp-config".into(),json!({"mcpServers":{"briefsip":{"type":"stdio","command":shim,"args":["--mcp-stdio"]}}}).to_string()];
        args.extend([
            if saved.is_some() {
                "--resume".into()
            } else {
                "--session-id".into()
            },
            session.clone(),
        ]);
        if !native_model.is_empty() {
            args.extend(["--model".into(), native_model.clone()]);
        }
        args
    } else {
        acp_args(runtime, &executable)
    };
    let extension_home = if runtime == "pi" {
        Some(process::ProbeHome::new().map_err(|_| Failure::storage())?)
    } else {
        None
    };
    if runtime == "pi" {
        args = vec![
            "--mode".into(),
            "rpc".into(),
            "--offline".into(),
            "--no-extensions".into(),
            "--no-skills".into(),
            "--no-prompt-templates".into(),
            "--no-themes".into(),
            "--no-context-files".into(),
            "--no-mcp".into(),
            "--no-approve".into(),
            "--no-session".into(),
        ];
        let extension = extension_home
            .as_ref()
            .ok_or_else(Failure::storage)?
            .0
            .join("briefsip-pi.mjs");
        std::fs::write(
            &extension,
            include_str!("../../../../app/t3/pi-harness-extension.mjs"),
        )
        .map_err(|_| Failure::storage())?;
        args.extend([
            "--extension".into(),
            extension.to_string_lossy().into_owned(),
            "--append-system-prompt".into(),
            instructions.clone(),
        ]);
    }
    let mut process = Process::launch(&executable, &args, workspace, &env)?;
    let mut seq = 0;
    if runtime == "codex" {
        rpc(&mut process,&mut seq,"initialize",json!({"clientInfo":{"name":"briefsip","title":"Briefsip","version":"0.1.0"},"capabilities":{"experimentalApi":true}})).await?;
        process.send(json!({"method":"initialized"})).await?;
        let environment = {
            let guard = state.database.lock().map_err(|_| Failure::storage())?;
            data::environment::values(
                state,
                &guard.connection,
                string(turn, "id"),
                string(turn, "agent"),
            )?
        };
        let mut params = json!({"cwd":workspace,"approvalPolicy":"on-request","sandbox":if binding.write{"workspace-write"}else{"read-only"},"config":{"mcp_servers":{"briefsip":{"url":mcp_url,"bearer_token_env_var":"BRIEFSIP_MCP_TOKEN"}},"approvals_reviewer":"user","shell_environment_policy.inherit":"none","shell_environment_policy.set":{"PATH":super::path(state),"LANG":"C.UTF-8","HOME":workspace},"shell_environment_policy.exclude":["BRIEFSIP_PROVIDER_KEY","BRIEFSIP_MCP_TOKEN","ANTHROPIC_API_KEY"]}});
        for (name, value) in environment {
            params["config"]["shell_environment_policy.set"][name] = json!(value);
        }
        if !native_model.is_empty() {
            params["model"] = json!(native_model);
        }
        if let Some(id) = &saved {
            params["threadId"] = json!(id);
        }
        let response = rpc(
            &mut process,
            &mut seq,
            if saved.is_some() {
                "thread/resume"
            } else {
                "thread/start"
            },
            params,
        )
        .await?;
        session = string(&response["thread"], "id").into();
    } else if runtime == "claude" {
        process.send(json!({"type":"control_request","request_id":"init","request":{"subtype":"initialize","hooks":{"PreToolUse":[{"hookCallbackIds":["approval"],"onFailure":"block"}],"Stop":[{"hookCallbackIds":["stop"]}]}}})).await?;
        loop {
            let value = process.next().await?;
            if value["type"] == "control_response"
                && (value["response"]["subtype"] != "success"
                    || value["response"]["response"]["hook_on_failure_supported"] != true)
            {
                return Err(error(502,"Claude Code lacks fail-closed permission hooks. Update the host executable before using this runtime."));
            }
            if value["type"] == "control_response" && value["response"]["request_id"] == "init" {
                break;
            }
        }
    } else if runtime == "pi" {
        process.send(json!({"id":1,"type":"get_state"})).await?;
        if process.next().await?["success"] != true {
            return Err(process::stopped());
        }
        process.send(json!({"id":2,"type":"get_commands"})).await?;
        if process.next().await?["success"] != true {
            return Err(process::stopped());
        }
        if !native_model.is_empty() {
            process
                .send(json!({"id":3,"type":"get_available_models"}))
                .await?;
            let models = process.next().await?;
            let model = models["data"]["models"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|m| format!("{}/{}", string(m, "provider"), string(m, "id")) == native_model)
                .ok_or_else(|| error(502, "Selected Pi model is unavailable."))?;
            process.send(json!({"id":4,"type":"set_model","provider":model["provider"],"modelId":model["id"]})).await?;
            if process.next().await?["success"] != true {
                return Err(process::stopped());
            }
        }
    } else {
        let init=rpc(&mut process,&mut seq,"initialize",json!({"protocolVersion":1,"clientInfo":{"name":"briefsip","version":"0.1.0"},"clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true},"terminal":false}})).await?;
        if init["protocolVersion"] != 1 {
            return Err(error(
                502,
                "Harness does not support ACP protocol version 1.",
            ));
        }
        if runtime == "antigravity"
            && init["authMethods"]
                .as_array()
                .is_some_and(|v| v.iter().any(|v| v["id"] == "oauth-personal"))
        {
            rpc(
                &mut process,
                &mut seq,
                "authenticate",
                json!({"methodId":"oauth-personal"}),
            )
            .await?;
        }
        let mut params = json!({"cwd":workspace,"mcpServers":[{"type":"http","name":"briefsip","url":mcp_url,"headers":[{"name":"Authorization","value":format!("Bearer {token}")}]}]});
        if let Some(id) = &saved {
            params["sessionId"] = json!(id);
        }
        let setup = rpc(
            &mut process,
            &mut seq,
            if saved.is_some() {
                "session/load"
            } else {
                "session/new"
            },
            params,
        )
        .await?;
        session = saved
            .clone()
            .unwrap_or_else(|| string(&setup, "sessionId").into());
        let models = setup["models"]["availableModels"]
            .as_array()
            .unwrap_or(&Vec::new())
            .iter()
            .map(|v| json!({"id":v["modelId"],"label":v["name"]}))
            .collect::<Vec<_>>();
        {
            let db = state.database.lock().map_err(|_| Failure::storage())?;
            db.connection.execute("INSERT INTO harness_catalog VALUES(?,?) ON CONFLICT(runtime) DO UPDATE SET models=excluded.models",[runtime,json!(models).to_string().as_str()])?;
        }
        if setup["modes"]["availableModes"]
            .as_array()
            .is_some_and(|v| v.iter().any(|v| v["id"] == "default"))
        {
            rpc(
                &mut process,
                &mut seq,
                "session/set_mode",
                json!({"sessionId":session,"modeId":"default"}),
            )
            .await?;
        } else {
            return Err(error(502, "Harness has no supervised permission mode."));
        }
        if !native_model.is_empty() {
            rpc(
                &mut process,
                &mut seq,
                "session/set_model",
                json!({"sessionId":session,"modelId":native_model}),
            )
            .await?;
        }
    }
    let conversation = turn["channel"]
        .as_str()
        .or(turn["thread"].as_str())
        .unwrap_or("direct");
    if runtime != "pi" {
        save_session(
            state,
            string(turn, "agent"),
            conversation,
            runtime,
            workspace,
            &session,
        )?;
    }
    let native_secrets = secrets.clone();
    let mut snapshot = Snapshot::new(state, call, string(turn, "id"), secrets);
    let mut usage = [None, None];
    let mut acp_segment = 0;
    let mut claude_message = String::new();
    let mut claude_tools = HashMap::<String, (String, Option<String>)>::new();
    for pass in 0..2 {
        let prompt_id;
        if runtime == "codex" {
            let context = additional_context(&instructions);
            let result=rpc(&mut process,&mut seq,"turn/start",json!({"threadId":session,"additionalContext":context,"input":[{"type":"text","text":prompt}],"cwd":workspace,"approvalPolicy":"on-request","sandboxPolicy":if binding.write{json!({"type":"workspaceWrite","writableRoots":[workspace],"networkAccess":false,"excludeTmpdirEnvVar":true,"excludeSlashTmp":true})}else{json!({"type":"readOnly"})}})).await?;
            if !result["turn"]["id"].is_string() {
                return Err(process::stopped());
            }
            prompt_id = Value::Null;
        } else if runtime == "claude" {
            process
                .send(json!({"type":"user","message":{"role":"user","content":prompt}}))
                .await?;
            prompt_id = Value::Null;
        } else if runtime == "pi" {
            process
                .send(json!({"id":2+pass,"type":"prompt","message":prompt}))
                .await?;
            prompt_id = json!(2 + pass);
        } else {
            seq += 1;
            prompt_id = json!(seq);
            acp_segment += 1;
            process.send(json!({"jsonrpc":"2.0","id":seq,"method":"session/prompt","params":{"sessionId":session,"prompt":[{"type":"text","text":format!("<briefsip_context>\n{instructions}\n</briefsip_context>")},{"type":"text","text":prompt}]}})).await?;
        }
        let mut pass_usage = [None, None];
        loop {
            let value = tokio::select! {value=process.next()=>value?,_=tokio::time::sleep(Duration::from_millis(40))=>{snapshot.flush()?;continue;}};
            if runtime == "codex" {
                let method = string(&value, "method");
                let p = &value["params"];
                if value.get("id").is_some() && value.get("method").is_some() {
                    if ![
                        "mcpServer/elicitation/request",
                        "item/commandExecution/requestApproval",
                        "item/fileChange/requestApproval",
                        "item/permissions/requestApproval",
                    ]
                    .contains(&method)
                    {
                        process.send(json!({"id":value["id"],"error":{"code":-32601,"message":"Request unavailable in this Briefsip session."}})).await?;
                        continue;
                    }
                    let result = if method == "mcpServer/elicitation/request" {
                        if p["threadId"] == session {
                            super::protocol::elicitation(p)
                        } else {
                            json!({"action":"decline"})
                        }
                    } else {
                        if p["threadId"] != session {
                            process.send(json!({"id":value["id"],"error":{"code":-32601,"message":"Unsupported approval request."}})).await?;
                            continue;
                        }
                        let kind = if method.contains("permissions") {
                            if p["permissions"]["network"].is_null() {
                                "file"
                            } else {
                                "network"
                            }
                        } else if method.contains("fileChange") {
                            "file"
                        } else {
                            "command"
                        };
                        let allow = approve(
                            state,
                            string(turn, "id"),
                            kind,
                            p["command"].as_str(),
                            p["reason"].as_str().unwrap_or("Allow harness tool?"),
                            p,
                            token,
                        )
                        .await?;
                        if method.contains("permissions") {
                            json!({"permissions":if allow{p["permissions"].clone()}else{json!({})},"scope":"turn"})
                        } else {
                            json!({"decision":if allow{"accept"}else{"decline"}})
                        }
                    };
                    process
                        .send(json!({"id":value["id"],"result":result}))
                        .await?;
                    continue;
                }
                if p["threadId"].as_str().is_some_and(|id| id != session) {
                    continue;
                }
                if method == "item/agentMessage/delta" {
                    snapshot.text(string(p, "delta"), p["itemId"].as_str(), false)?;
                }
                if method == "item/completed" && p["item"]["type"] == "agentMessage" {
                    snapshot.text(string(&p["item"], "text"), p["item"]["id"].as_str(), true)?;
                }
                if ["item/started", "item/completed"].contains(&method)
                    && p["item"]["type"]
                        .as_str()
                        .is_some_and(|v| !["agentMessage", "reasoning", "plan"].contains(&v))
                {
                    let item = &p["item"];
                    tool(
                        state,
                        string(turn, "id"),
                        &mut snapshot,
                        string(item, "id"),
                        item["command"]
                            .as_str()
                            .or(item["tool"].as_str())
                            .unwrap_or(string(item, "type")),
                        if method == "item/started" {
                            "running"
                        } else {
                            item["status"].as_str().unwrap_or("completed")
                        },
                    )?;
                }
                if method == "item/completed" && p["item"]["type"] == "commandExecution" {
                    let item = &p["item"];
                    if item.get("exitCode").is_some() {
                        let guard = state.database.lock().map_err(|_| Failure::storage())?;
                        turns::harness::command(
                            &guard.connection,
                            string(turn, "id"),
                            string(item, "id"),
                            &redact(string(item, "command"), &native_secrets, false),
                            &redact(string(item, "aggregatedOutput"), &native_secrets, false),
                            item["exitCode"].as_i64(),
                            false,
                        )?;
                    }
                }
                if method == "thread/tokenUsage/updated" {
                    pass_usage = [
                        p["tokenUsage"]["last"]["inputTokens"].as_i64(),
                        p["tokenUsage"]["last"]["outputTokens"].as_i64(),
                    ];
                }
                if method == "turn/completed" {
                    if p["turn"]["status"] != "completed" {
                        return Err(process::stopped());
                    }
                    break;
                }
                if method == "error" && p["willRetry"] != true {
                    return Err(process::stopped());
                }
            } else if runtime == "claude" {
                match string(&value, "type") {
                    "control_request" => {
                        let req = &value["request"];
                        let input = &req["input"];
                        let result = if input["hook_event_name"] == "Stop" {
                            reminder(state, turn, profile, phase)?
                                .map(|reason| json!({"decision":"block","reason":reason}))
                                .unwrap_or(json!({}))
                        } else if req["subtype"] == "hook_callback"
                            || req["subtype"] == "can_use_tool"
                        {
                            let name = input["tool_name"]
                                .as_str()
                                .or(req["tool_name"].as_str())
                                .unwrap_or("");
                            let args = input
                                .get("tool_input")
                                .or(req.get("input"))
                                .cloned()
                                .unwrap_or(json!({}));
                            let path = args["file_path"].as_str().or(args["path"].as_str());
                            let read = ["Read", "Glob", "Grep", "LS"].contains(&name);
                            let write =
                                ["Write", "Edit", "MultiEdit", "NotebookEdit"].contains(&name);
                            let glob_outside = name == "Glob"
                                && args["pattern"].as_str().is_some_and(|p| {
                                    Path::new(p).is_absolute() || p.split('/').any(|c| c == "..")
                                });
                            let allowed = name.starts_with("mcp__briefsip__")
                                || ["ToolSearch", "TodoWrite"].contains(&name)
                                || (read || write && binding.write)
                                    && !glob_outside
                                    && path
                                        .or(if read { Some(".") } else { None })
                                        .is_some_and(|p| inside(workspace, p));
                            let allow = if allowed {
                                true
                            } else {
                                approve(
                                    state,
                                    string(turn, "id"),
                                    if name == "Bash" {
                                        "command"
                                    } else if read || write {
                                        "file"
                                    } else if ["WebFetch", "WebSearch"].contains(&name) {
                                        "network"
                                    } else {
                                        "tool"
                                    },
                                    args["command"].as_str(),
                                    &format!("Claude Code: {name}"),
                                    &args,
                                    token,
                                )
                                .await?
                            };
                            if req["subtype"] == "can_use_tool" {
                                if allow {
                                    json!({"behavior":"allow","updatedInput":args})
                                } else {
                                    json!({"behavior":"deny","message":"Not allowed in Briefsip."})
                                }
                            } else {
                                json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":if allow{"allow"}else{"deny"},"permissionDecisionReason":if allow{"Allowed by Briefsip."}else{"Not allowed in Briefsip."}}})
                            }
                        } else {
                            json!({})
                        };
                        process.send(json!({"type":"control_response","response":{"subtype":"success","request_id":value["request_id"],"response":result}})).await?;
                    }
                    "stream_event" => {
                        let event = &value["event"];
                        if event["type"] == "message_start" {
                            claude_message = string(&event["message"], "id").into();
                        }
                        if event["type"] == "content_block_delta"
                            && event["delta"]["type"] == "text_delta"
                        {
                            let id = (!claude_message.is_empty())
                                .then(|| format!("{}:{}", claude_message, event["index"]));
                            snapshot.text(string(&event["delta"], "text"), id.as_deref(), false)?;
                        }
                    }
                    "assistant" => {
                        if let Some(content) = value["message"]["content"].as_array() {
                            for (index, block) in content.iter().enumerate() {
                                if block["type"] == "text" {
                                    let id = format!("{}:{index}", string(&value["message"], "id"));
                                    snapshot.text(string(block, "text"), Some(&id), true)?;
                                }
                                if block["type"] == "tool_use" {
                                    claude_tools.insert(
                                        string(block, "id").into(),
                                        (
                                            string(block, "name").into(),
                                            (block["name"] == "Bash").then(|| {
                                                string(&block["input"], "command").to_owned()
                                            }),
                                        ),
                                    );
                                    tool(
                                        state,
                                        string(turn, "id"),
                                        &mut snapshot,
                                        string(block, "id"),
                                        string(block, "name"),
                                        "running",
                                    )?;
                                }
                            }
                        }
                        claude_message.clear();
                    }
                    "user" => {
                        if let Some(content) = value["message"]["content"].as_array() {
                            for block in content {
                                if block["type"] == "tool_result" {
                                    let Some((name, command)) =
                                        claude_tools.remove(string(block, "tool_use_id"))
                                    else {
                                        continue;
                                    };
                                    tool(
                                        state,
                                        string(turn, "id"),
                                        &mut snapshot,
                                        string(block, "tool_use_id"),
                                        &name,
                                        if block["is_error"] == true {
                                            "failed"
                                        } else {
                                            "completed"
                                        },
                                    )?;
                                    if let Some(command) = command
                                        .or_else(|| (name == "Read").then(|| "cat file".into()))
                                    {
                                        let guard = state
                                            .database
                                            .lock()
                                            .map_err(|_| Failure::storage())?;
                                        let output = block["content"]
                                            .as_str()
                                            .map(str::to_owned)
                                            .unwrap_or_else(|| block["content"].to_string());
                                        turns::harness::command(
                                            &guard.connection,
                                            string(turn, "id"),
                                            string(block, "tool_use_id"),
                                            &redact(&command, &native_secrets, false),
                                            &redact(&output, &native_secrets, false),
                                            Some(if block["is_error"] == true { 1 } else { 0 }),
                                            false,
                                        )?;
                                    }
                                }
                            }
                        }
                    }
                    "result" => {
                        if value["subtype"] != "success" || value["is_error"] == true {
                            return Err(process::stopped());
                        }
                        pass_usage = [
                            value["usage"]["input_tokens"].as_i64(),
                            value["usage"]["output_tokens"].as_i64(),
                        ];
                        break;
                    }
                    _ => (),
                }
            } else if runtime == "pi" {
                if value["type"] == "extension_error" {
                    return Err(error(502, "Pi permission extension failed."));
                }
                if value["type"] == "message_update"
                    && value["assistantMessageEvent"]["type"] == "text_delta"
                {
                    snapshot.text(
                        string(&value["assistantMessageEvent"], "delta"),
                        None,
                        false,
                    )?;
                }
                if value["type"] == "extension_ui_request" {
                    let allow = if value["method"] == "confirm"
                        && value["title"] == "Briefsip tool approval"
                    {
                        let args: Value = serde_json::from_str(string(&value, "message"))
                            .map_err(|_| process::stopped())?;
                        approve(
                            state,
                            string(turn, "id"),
                            match string(&args, "toolName") {
                                "bash" | "powershell" => "command",
                                "read" | "write" | "edit" | "grep" | "find" | "ls" => "file",
                                _ => "tool",
                            },
                            args["input"]["command"].as_str(),
                            "Pi: tool approval",
                            &args,
                            token,
                        )
                        .await?
                    } else {
                        false
                    };
                    process.send(json!({"type":"extension_ui_response","id":value["id"],"confirmed":allow,"cancelled":!allow})).await?;
                }
                if value["type"] == "message_end" && value["message"]["role"] == "assistant" {
                    let message = &value["message"];
                    if matches!(message["stopReason"].as_str(), Some("error" | "aborted")) {
                        return Err(process::stopped());
                    }
                    if let Some(content) = message["content"].as_array() {
                        for block in content {
                            if block["type"] == "text" {
                                snapshot.text(string(block, "text"), None, true)?;
                            }
                        }
                    }
                    pass_usage = [
                        message["usage"]["input"].as_i64(),
                        message["usage"]["output"].as_i64(),
                    ];
                }
                if matches!(
                    value["type"].as_str(),
                    Some("tool_execution_start" | "tool_execution_update" | "tool_execution_end")
                ) {
                    tool(
                        state,
                        string(turn, "id"),
                        &mut snapshot,
                        string(&value, "toolCallId"),
                        string(&value, "toolName"),
                        if value["type"] == "tool_execution_end" {
                            if value["isError"] == true {
                                "failed"
                            } else {
                                "completed"
                            }
                        } else {
                            "running"
                        },
                    )?;
                }
                if value["type"] == "agent_end" {
                    break;
                }
            } else {
                if value["id"] == prompt_id {
                    if value["result"]["stopReason"] != "end_turn" {
                        return Err(process::stopped());
                    }
                    break;
                }
                let p = &value["params"];
                if value.get("id").is_some() {
                    if p["sessionId"] != session {
                        process.send(json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32602,"message":"Request unavailable in this Briefsip session."}})).await?;
                        continue;
                    }
                    if value["method"] == "fs/read_text_file"
                        || value["method"] == "fs/write_text_file"
                    {
                        let result = super::fs::request(
                            state,
                            turn,
                            binding,
                            value["method"] == "fs/write_text_file",
                            p,
                            token,
                        )
                        .await;
                        let reply = match result {
                            Ok(v) => json!({"jsonrpc":"2.0","id":value["id"],"result":v}),
                            Err(_) => {
                                json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32602,"message":"Request unavailable in this Briefsip session."}})
                            }
                        };
                        process.send(reply).await?;
                        continue;
                    }
                    if value["method"] != "session/request_permission" {
                        process.send(json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32601,"message":"Request unavailable in this Briefsip session."}})).await?;
                        continue;
                    }
                    let result = if value["method"] == "session/request_permission" {
                        let input = &p["toolCall"];
                        let allow = approve(
                            state,
                            string(turn, "id"),
                            if input["kind"] == "execute" {
                                "command"
                            } else if input["kind"] == "fetch" {
                                "network"
                            } else {
                                "file"
                            },
                            input["rawInput"]["command"].as_str(),
                            input["title"].as_str().unwrap_or("Allow harness tool?"),
                            input,
                            token,
                        )
                        .await?;
                        let option = p["options"].as_array().and_then(|opts| {
                            opts.iter().find(|o| {
                                o["kind"] == if allow { "allow_once" } else { "reject_once" }
                            })
                        });
                        option.map(|o|json!({"outcome":{"outcome":"selected","optionId":o["optionId"]}})).unwrap_or(json!({"outcome":{"outcome":"cancelled"}}))
                    } else {
                        json!({})
                    };
                    process
                        .send(json!({"jsonrpc":"2.0","id":value["id"],"result":result}))
                        .await?;
                    continue;
                }
                if value["method"] != "session/update" || p["sessionId"] != session {
                    continue;
                }
                let update = &p["update"];
                if update["sessionUpdate"] == "agent_message_chunk"
                    && update["content"]["type"] == "text"
                {
                    snapshot.text(
                        string(&update["content"], "text"),
                        Some(&format!("acp-{acp_segment}")),
                        false,
                    )?;
                }
                if ["tool_call", "tool_call_update"].contains(&string(update, "sessionUpdate")) {
                    if update["sessionUpdate"] == "tool_call" {
                        acp_segment += 1;
                    }
                    tool(
                        state,
                        string(turn, "id"),
                        &mut snapshot,
                        string(update, "toolCallId"),
                        update["title"].as_str().unwrap_or("Tool"),
                        update["status"].as_str().unwrap_or("pending"),
                    )?;
                }
            }
        }
        usage = if pass == 0 {
            pass_usage
        } else {
            [
                usage[0].zip(pass_usage[0]).map(|(a, b)| a + b),
                usage[1].zip(pass_usage[1]).map(|(a, b)| a + b),
            ]
        };
        if pass == 0 {
            if let Some(reason) = reminder(state, turn, profile, phase)? {
                snapshot.tool("verification-reminder", "Verify result", "requested")?;
                prompt = reason;
                continue;
            }
        }
        break;
    }
    let reply = snapshot.finish()?;
    let db = state.database.lock().map_err(|_| Failure::storage())?;
    db.connection.execute("UPDATE provider_calls SET status='received',finished=?,input_tokens=?,output_tokens=?,total_tokens=? WHERE seq=?",rusqlite::params![data::iso(&db.connection,state.config.now())?,usage[0],usage[1],usage[0].zip(usage[1]).map(|(a,b)|a+b),call])?;
    Ok(reply)
}
pub fn inside(workspace: &Path, path: &str) -> bool {
    if path.is_empty() || path.contains('\0') {
        return false;
    }
    let Ok(root) = workspace.canonicalize() else {
        return false;
    };
    let target = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        root.join(path)
    };
    if target
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return false;
    }
    let mut current = target.as_path();
    while !current.exists() {
        let Some(parent) = current.parent() else {
            return false;
        };
        current = parent;
    }
    target.starts_with(&root) && current.canonicalize().is_ok_and(|p| p.starts_with(&root))
}
pub async fn run(
    state: &AppState,
    turn_id: &str,
    model: &str,
    messages: &[Value],
    phase: &str,
) -> Result<String> {
    let (turn, profile, binding, account) = {
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        let db = &guard.connection;
        let turn = one(
            db,
            "SELECT * FROM turns WHERE id=? AND status IN('queued','running') AND paused=0",
            [turn_id],
        )?
        .ok_or_else(|| error(409, "Task has stopped."))?;
        let profile = agents::read(db, string(&turn, "agent"))?;
        let binding = turns::harness::workspace(state, db, &turn)?
            .ok_or_else(|| error(403, "Coding harness requires a host workspace folder."))?;
        let account = data::providers::accounts(state)?
            .into_iter()
            .find(|v| v.id == string(&profile, "provider_account"))
            .ok_or_else(|| {
                error(
                    503,
                    "The selected provider account is not configured. Check Settings > Providers.",
                )
            })?;
        (turn, profile, binding, account)
    };
    let runtime = string(&profile, "runtime");
    let conversation = turn["channel"]
        .as_str()
        .or(turn["thread"].as_str())
        .unwrap_or("direct");
    let key = json!([turn["agent"], conversation, runtime, binding.directory]).to_string();
    let fingerprint = json!([
        account.id,
        account.base,
        format!(
            "{:x}",
            Sha256::digest(account.key.as_deref().unwrap_or("").as_bytes())
        ),
        model
    ])
    .to_string();
    let project_environment = {
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        data::environment::values(state, &guard.connection, turn_id, string(&turn, "agent"))?
    };
    let mut env = state.config.harness.environment.clone();
    env.extend(project_environment.clone());
    let same_home;
    {
        let mut homes = state.config.harness.homes.lock().await;
        same_home = homes
            .get(&key)
            .is_some_and(|h| h.fingerprint == fingerprint);
        if ["codex", "claude"].contains(&runtime) {
            if !same_home {
                homes.remove(&key);
                homes.insert(key.clone(), home(runtime, &account, model, fingerprint)?);
            }
            env.extend(
                homes
                    .get(&key)
                    .ok_or_else(Failure::storage)?
                    .environment
                    .clone(),
            );
        }
    }
    let saved = {
        let db = state.database.lock().map_err(|_| Failure::storage())?;
        if exists(
            &db.connection,
            "SELECT 1 FROM dispatch_links WHERE target_turn=? AND mode='restart'",
            [turn_id],
        )? {
            None
        } else if !["codex", "claude"].contains(&runtime) || same_home {
            one(&db.connection,"SELECT session FROM harness_sessions WHERE agent=? AND conversation=? AND runtime=? AND workspace=?",rusqlite::params![turn["agent"].as_str(),conversation,runtime,binding.directory.to_str()])?.map(|v|string(&v,"session").to_owned())
        } else {
            None
        }
    };
    let call = {
        let db = state.database.lock().map_err(|_| Failure::storage())?;
        db.connection.execute("UPDATE turns SET status='running',started_at=coalesce(started_at,?) WHERE id=? AND status IN('queued','running') AND paused=0",rusqlite::params![data::iso(&db.connection,state.config.now())?,turn_id])?;
        db.connection.execute("INSERT INTO provider_calls(turn,agent,model,origin,purpose,phase,family,account,status,created) VALUES(?,?,?,'local-harness',?,? ,?,'','pending',?)",rusqlite::params![turn_id,turn["agent"].as_str(),label(runtime),if phase=="routing"{"routing"}else{"completion"},phase,runtime,data::iso(&db.connection,state.config.now())?])?;
        state.events.turn(&db.connection, turn_id)?;
        db.connection.last_insert_rowid()
    };
    let external = if state.config.harness.test_harness_bridge.is_some() {
        bridge(
            state,
            "mint",
            json!({"agent":turn["agent"],"turn":turn_id,"scopes":["orchestration"],"ttlMs":120000}),
        )
        .await?
    } else {
        Value::Null
    };
    let (id, token) = if external.is_null() {
        crate::mcp::mint_session(state, string(&turn, "agent"), turn_id)?
    } else {
        (
            string(&external, "id").to_owned(),
            string(&external, "token").to_owned(),
        )
    };
    if id.is_empty() || token.is_empty() || token.len() > 4096 {
        return Err(error(
            502,
            "Briefsip MCP issuer returned an invalid session.",
        ));
    }
    let mut lease = Lease {
        state: state.clone(),
        id,
        external: !external.is_null(),
    };
    env.insert("BRIEFSIP_MCP_TOKEN".into(), token.clone());
    env.insert("BRIEFSIP_MCP_URL".into(), crate::mcp::url(state));
    if runtime == "hermes" {
        env.extend(process::HERMES_ENV.map(|(key, value)| (key.into(), value.into())));
    }
    let mut secrets = vec![token.clone(), account.key.unwrap_or_default()];
    {
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        secrets.extend(crate::mcp::secrets::project(
            state,
            &guard.connection,
            None,
        )?);
    }
    let result = tokio::time::timeout(Duration::from_millis(state.config.data.timeout.unwrap_or(120000)), execute(
        state, &turn, &profile, runtime, model, messages, phase, call, &token, env, saved,
        &binding, secrets,
    )).await.map_err(|_|error(502,"Coding harness timed out. Check workspace changes before retrying; this turn was not replayed."))?;
    if lease.external {
        bridge(state, "revoke", json!({"id":lease.id})).await?;
        lease.external = false;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_home_keeps_credentials_out_of_private_config() -> crate::db::Result<()> {
        let mut account = data::providers::Account {
            id: "router".into(),
            name: "Router".into(),
            family: "openai-compatible".into(),
            base: "http://127.0.0.1:20128/v1".into(),
            key: Some("synthetic-secret".into()),
            model: "cx/gpt-6.1-sol".into(),
            stream: false,
            termination: String::new(),
            max_tokens: 0,
            source: "environment",
        };
        let session = home("codex", &account, &account.model, String::new())
            .map_err(|failure| failure.message)?;
        let codex = Path::new(&session.environment["CODEX_HOME"]);
        let config = codex.join("config.toml");
        let text = std::fs::read_to_string(&config)?;
        assert!(text.contains("model = \"cx/gpt-6.1-sol\""));
        assert!(text.contains("base_url = \"http://127.0.0.1:20128/v1\""));
        assert!(text.contains("env_key = \"BRIEFSIP_PROVIDER_KEY\""));
        assert!(!text.contains("synthetic-secret"));
        assert_eq!(
            session.environment["BRIEFSIP_PROVIDER_KEY"],
            "synthetic-secret"
        );
        assert_eq!(
            std::fs::metadata(config)?.permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&session.path)?.permissions().mode() & 0o777,
            0o700
        );
        assert!(std::fs::read_to_string(codex.join("rules/default.rules"))?
            .contains("pattern=[\"rm\"], decision=\"prompt\""));
        let path = session.path.clone();
        drop(session);
        assert!(!path.exists());
        account.base = "https://user:password@example.test/v1".into();
        assert!(home("codex", &account, "x", String::new()).is_err());
        account.base = "https://example.test/v1".into();
        account.family = "anthropic".into();
        assert!(home("codex", &account, "x", String::new()).is_err());
        Ok(())
    }

    #[test]
    fn codex_context_chunks_preserve_multibyte_text() -> Result<()> {
        let text = format!("Header.\n\n{}\n\nFinal paragraph.", "🧪".repeat(3000));
        let context = additional_context(&text);
        let entries = context.as_object().ok_or_else(Failure::storage)?;
        assert_eq!(entries["briefsip_001"]["value"], "Header.\n\n");
        let mut joined = String::new();
        for entry in entries.values() {
            assert_eq!(entry["kind"], "application");
            let chunk = entry["value"].as_str().ok_or_else(Failure::storage)?;
            assert!(chunk.len() <= 4000);
            joined.push_str(chunk);
        }
        assert_eq!(joined, text);
        assert_eq!(additional_context(""), json!({}));
        Ok(())
    }
}
