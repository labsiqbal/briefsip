use super::{
    executable, mise_environment, path,
    process::{ProbeHome, Process},
    store, Result,
};
use crate::{
    data::{error, logins, providers, string},
    operator_file,
    web::Failure,
    AppState,
};
use futures_util::{stream, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    ffi::OsStr,
    future::Future,
    path::Path,
    sync::Arc,
    time::Duration,
};
use tokio::{
    sync::{Mutex, OnceCell},
    time::{timeout, timeout_at, Instant},
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const CACHE_AGE: Duration = Duration::from_secs(300);
const MAX_PAGES: usize = 20;
const MAX_MODELS: usize = 10_000;

type Slot = Arc<OnceCell<(Instant, Result<Value>)>>;

#[derive(Clone, Default)]
pub(super) struct Cache(Arc<Mutex<HashMap<(String, String), Slot>>>);

impl Cache {
    async fn get(
        &self,
        runtime: &str,
        binding: &str,
        probe: impl Future<Output = Result<Value>>,
    ) -> Result<Value> {
        let slot = {
            let mut slots = self.0.lock().await;
            slots.retain(|_, slot| {
                slot.get()
                    .is_none_or(|(at, result)| result.is_ok() && at.elapsed() < CACHE_AGE)
            });
            slots
                .entry((runtime.into(), binding.into()))
                .or_default()
                .clone()
        };
        slot.get_or_init(|| async {
            let result = probe.await;
            (Instant::now(), result)
        })
        .await
        .1
        .clone()
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub(crate) struct Model {
    id: String,
    label: String,
    #[serde(rename = "default", skip_serializing_if = "Option::is_none")]
    preferred: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    group: Option<String>,
}

impl Model {
    pub(crate) fn new(id: &str, label: &str, preferred: bool) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            preferred: preferred.then_some(true),
            group: None,
        }
    }
}

pub(crate) fn response(catalog: Vec<Model>) -> Value {
    let mut seen = BTreeSet::new();
    let models = catalog
        .iter()
        .filter_map(|model| seen.insert(&model.id).then_some(&model.id))
        .collect::<Vec<_>>();
    json!({"models": models, "catalog": catalog})
}

pub(crate) async fn models(state: &AppState, runtime: &str, binding: &str) -> Result<Value> {
    let executable = executable(state, runtime)
        .ok_or_else(|| error(503, "The selected engine is unavailable on this host."))?;
    let login = if binding == logins::DEVICE {
        None
    } else {
        let db = state.database.lock().map_err(|_| Failure::storage())?;
        let profile = logins::bound(&db.connection, binding)?;
        if let Some(reason) = logins::blocked_reason(runtime, profile.as_ref()) {
            return Err(error(503, reason));
        }
        profile
    };
    state
        .config
        .harness
        .model_catalog
        .get(runtime, binding, async {
            let deadline = Instant::now() + PROBE_TIMEOUT;
            let (mut catalog, config) = if let Some(profile) = login {
                login_models(state, &executable, runtime, &profile, deadline).await?
            } else {
                device_models(&executable, runtime, path(state), deadline).await?
            };
            if let Some(config) = config {
                catalog.extend(custom_models(&config, deadline).await);
            }
            Ok(response(catalog))
        })
        .await
}

fn launch_error(runtime: &str) -> Failure {
    error(
        502,
        format!(
            "{} model discovery failed. Check the engine installation and sign-in.",
            super::label(runtime)
        ),
    )
}

async fn device_models(
    executable: &Path,
    runtime: &str,
    hydrated_path: String,
    deadline: Instant,
) -> Result<(Vec<Model>, Option<Vec<u8>>)> {
    let scratch = ProbeHome::new().map_err(|_| launch_error(runtime))?;
    let (_, mut env) = logins::device_process_environment(runtime, hydrated_path)
        .ok_or_else(|| error(503, "This machine's engine folder could not be found."))?;
    mise_environment(executable, &mut env);
    env.insert("TMPDIR".into(), scratch.0.to_string_lossy().into_owned());

    // Run against the engine's own folder, as a device turn does. The engine
    // may refresh its sign-in while listing models; OpenAI rotates refresh
    // tokens, so a copy or a read-only view would lose the rotated token and
    // sign the CLI out on this machine.
    let config = env.get("CODEX_HOME").and_then(|folder| {
        let folder = Path::new(folder).canonicalize().ok()?;
        let directory = operator_file::open_directory(&folder).ok()?;
        let file = operator_file::file_at(&directory, OsStr::new("config.toml")).ok()?;
        operator_file::bounded_read(file, 1024 * 1024).ok()
    });
    let process = Process::launch(executable, &args(runtime), &scratch.0, &env)
        .map_err(|_| launch_error(runtime))?;
    Ok((
        probe_process(
            process,
            runtime,
            deadline.saturating_duration_since(Instant::now()),
        )
        .await?,
        config,
    ))
}

async fn login_models(
    state: &AppState,
    executable: &Path,
    runtime: &str,
    profile: &Value,
    deadline: Instant,
) -> Result<(Vec<Model>, Option<Vec<u8>>)> {
    let credentials = logins::credentials(state, profile)?.ok_or_else(|| {
        error(
            503,
            "Engine login credentials are missing. Check sign-in in Settings > Engines.",
        )
    })?;
    let scratch = ProbeHome::new().map_err(|_| launch_error(runtime))?;
    let home = store::home(
        &scratch.0,
        runtime,
        None,
        Some((string(profile, "id"), &credentials)),
        None,
        "",
        String::new(),
    )
    .map_err(|_| launch_error(runtime))?;
    let config = if runtime == "codex" {
        logins::codex_config(state, profile)
    } else {
        None
    };
    let mut env = state.config.harness.environment.clone();
    env.extend(home.environment.clone());
    env.insert("TMPDIR".into(), scratch.0.to_string_lossy().into_owned());
    mise_environment(executable, &mut env);
    let process = Process::launch(executable, &args(runtime), &scratch.0, &env)
        .map_err(|_| launch_error(runtime))?;
    Ok((
        probe_process(
            process,
            runtime,
            deadline.saturating_duration_since(Instant::now()),
        )
        .await?,
        config,
    ))
}

fn args(runtime: &str) -> Vec<String> {
    if runtime == "codex" {
        vec!["app-server".into()]
    } else {
        [
            "--print",
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--verbose",
            "--setting-sources",
            "",
            "--strict-mcp-config",
            "--no-session-persistence",
        ]
        .map(str::to_owned)
        .into()
    }
}

async fn probe_process(
    mut process: Process,
    runtime: &str,
    budget: Duration,
) -> Result<Vec<Model>> {
    timeout(budget, async move {
        if runtime == "codex" {
            codex_models(&mut process).await
        } else {
            claude_models(&mut process).await
        }
    })
    .await
    .map_err(|_| {
        error(
            502,
            format!(
                "{} model discovery timed out. Check the engine and try again.",
                super::label(runtime)
            ),
        )
    })?
}

async fn codex_models(process: &mut Process) -> Result<Vec<Model>> {
    let mut seq = 0;
    store::rpc(
        process,
        &mut seq,
        "initialize",
        json!({"clientInfo":{"name":"minarbot","version":"0.1.0"}}),
    )
    .await
    .map_err(|_| launch_error("codex"))?;
    process
        .send(json!({"jsonrpc":"2.0","method":"initialized"}))
        .await
        .map_err(|_| launch_error("codex"))?;
    let mut catalog = Vec::new();
    let mut cursors = BTreeSet::new();
    let mut params = json!({});
    for _ in 0..MAX_PAGES {
        let result = store::rpc(process, &mut seq, "model/list", params)
            .await
            .map_err(|_| launch_error("codex"))?;
        let (models, cursor) = codex_page(&result)?;
        catalog.extend(models);
        if catalog.len() > MAX_MODELS {
            break;
        }
        let Some(cursor) = cursor else {
            process.close_stdin();
            return Ok(catalog);
        };
        if !cursors.insert(cursor.to_owned()) {
            break;
        }
        params = json!({"cursor":cursor});
    }
    Err(error(
        502,
        "Codex model catalog exceeded its pagination limit.",
    ))
}

async fn claude_models(process: &mut Process) -> Result<Vec<Model>> {
    process.send(json!({"type":"control_request","request_id":"init","request":{"subtype":"initialize"}}))
        .await.map_err(|_| launch_error("claude"))?;
    process.close_stdin();
    loop {
        let value = process.next().await.map_err(|_| launch_error("claude"))?;
        if value["type"] == "control_response" && value["response"]["request_id"] == "init" {
            return claude_catalog(&value["response"]);
        }
    }
}

fn model_rows<'a>(value: &'a Value, runtime: &str) -> Result<&'a Vec<Value>> {
    value
        .as_array()
        .filter(|rows| rows.len() <= MAX_MODELS)
        .ok_or_else(|| {
            error(
                502,
                format!(
                    "{} returned an invalid model catalog.",
                    super::label(runtime)
                ),
            )
        })
}

fn model(row: &Value, key: &str, preferred: bool, runtime: &str) -> Result<Model> {
    let id = row[key]
        .as_str()
        .filter(|id| providers::valid_model_id(id))
        .ok_or_else(|| {
            error(
                502,
                format!("{} returned an invalid model ID.", super::label(runtime)),
            )
        })?;
    let label = row["displayName"]
        .as_str()
        .filter(|label| {
            !label.is_empty()
                && label.chars().count() <= 160
                && !label.chars().any(char::is_control)
        })
        .unwrap_or(id);
    Ok(Model::new(id, label, preferred))
}

fn codex_page(result: &Value) -> Result<(Vec<Model>, Option<&str>)> {
    let models = model_rows(&result["data"], "codex")?
        .iter()
        .filter(|row| row["hidden"] != true)
        .map(|row| model(row, "id", row["isDefault"] == true, "codex"))
        .collect::<Result<Vec<_>>>()?;
    let cursor = match &result["nextCursor"] {
        Value::Null => None,
        Value::String(cursor) if cursor.is_empty() => None,
        Value::String(cursor) if cursor.len() <= 2000 => Some(cursor.as_str()),
        _ => {
            return Err(error(
                502,
                "Codex returned an invalid model catalog cursor.",
            ))
        }
    };
    Ok((models, cursor))
}

fn claude_catalog(response: &Value) -> Result<Vec<Model>> {
    if response["subtype"] != "success" {
        return Err(launch_error("claude"));
    }
    model_rows(&response["response"]["models"], "claude")?
        .iter()
        .map(|row| model(row, "value", row["value"] == "default", "claude"))
        .collect()
}

fn codex_providers(
    config: &[u8],
    key_for: impl Fn(&str) -> Option<String>,
) -> Vec<(String, providers::Account)> {
    let Some(document) = std::str::from_utf8(config)
        .ok()
        .and_then(|raw| toml_edit::Document::parse(raw).ok())
    else {
        return Vec::new();
    };
    document
        .get("model_providers")
        .and_then(|item| item.as_table_like())
        .into_iter()
        .flat_map(|providers| providers.iter())
        .filter_map(|(name, value)| {
            let table = value.as_table_like()?;
            let base = table.get("base_url")?.as_str()?;
            let key = table
                .get("env_key")
                .and_then(|value| value.as_str())
                .and_then(&key_for)
                .filter(|value| !value.is_empty());
            Some((
                name.to_owned(),
                providers::Account {
                    id: name.into(),
                    name: name.into(),
                    family: "openai-compatible".into(),
                    base: base.into(),
                    key,
                    model: String::new(),
                    stream: false,
                    termination: String::new(),
                    max_tokens: 0,
                    source: "codex",
                },
            ))
        })
        .collect()
}

async fn custom_models(config: &[u8], deadline: Instant) -> Vec<Model> {
    let providers = codex_providers(config, |name| std::env::var(name).ok());
    let mut requests = stream::iter(providers)
        .map(|(group, account)| async move { (group, providers::discover(&account, true).await) })
        .buffer_unordered(8);
    let mut groups = BTreeMap::new();
    while let Ok(Some((group, result))) = timeout_at(deadline, requests.next()).await {
        if let Ok(ids) = result {
            groups.insert(group, ids);
        }
    }
    groups
        .into_iter()
        .flat_map(|(group, ids)| {
            ids.into_iter().map(move |id| {
                let mut model = Model::new(&id, &id, false);
                model.group = Some(group.clone());
                model
            })
        })
        .collect()
}

#[cfg(test)]
mod tests;
