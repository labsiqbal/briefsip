use crate::{
    connectors::runner,
    data::{closed, string},
    operator_file::{bounded_read, directory_at, file_at, private},
};
use serde_json::{json, Map, Value};
use std::{
    ffi::OsStr,
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use uuid::Uuid;

struct Error(u8, String);
type Result<T> = std::result::Result<T, Error>;

impl Error {
    fn args(message: &str) -> Self {
        Self(2, message.into())
    }
    fn invalid() -> Self {
        Self(1, "Invalid script response.".into())
    }
    fn timeout() -> Self {
        Self(4, "Wait timed out; task was not cancelled.".into())
    }
}

fn uuid(value: &str, lowercase: bool) -> bool {
    crate::web::id(value).is_some_and(|normalized| !lowercase || value == normalized)
}

fn positive(value: Option<&String>, max: u64) -> Option<u64> {
    let value = value?;
    if value.starts_with('0') || !value.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    value.parse().ok().filter(|n| (1..=max).contains(n))
}

#[derive(serde::Deserialize)]
struct Discovery {
    url: String,
    token: String,
}

fn connection(directory: &Path) -> crate::db::Result<Discovery> {
    let dir = directory_at(&File::open(".")?, directory)?;
    let file = file_at(&dir, OsStr::new("connection.json"))?;
    if !private(&dir) || !private(&file) {
        return Err("Private script discovery is required.".into());
    }
    let value: Discovery = serde_json::from_slice(&bounded_read(file, 4096)?)?;
    let url = url::Url::parse(&value.url)?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.origin().ascii_serialization() != value.url
        || !(32..=256).contains(&value.token.len())
        || !value
            .token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err("Invalid script discovery.".into());
    }
    Ok(value)
}

struct Requester {
    client: reqwest::Client,
    directory: PathBuf,
    deadline: Instant,
    command: String,
}

impl Requester {
    fn transport(&self) -> Error {
        let message = match self.command.as_str() {
            "cancel" => "Cancellation is not confirmed yet. Check status or repeat cancel with the same task ID.",
            "answer" => "Response is not confirmed yet. Repeat answer with the same --id, text, and options; task was not cancelled.",
            _ => "Response is not confirmed yet. Use the same ID to retry; task was not cancelled.",
        };
        Error(
            if Instant::now() >= self.deadline {
                4
            } else {
                5
            },
            message.into(),
        )
    }

    async fn request(&self, path: &str, body: Option<Value>) -> Result<Value> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(Error::timeout());
        }
        let connection = connection(&self.directory)
            .map_err(|_| Error(5, "Script discovery is unavailable or unsafe.".into()))?;
        let mut request = self
            .client
            .request(
                if body.is_some() {
                    reqwest::Method::POST
                } else {
                    reqwest::Method::GET
                },
                format!("{}{path}", connection.url),
            )
            .bearer_auth(connection.token)
            .header("Content-Type", "application/json")
            .timeout(remaining.min(Duration::from_secs(15)));
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|_| self.transport())?;
        let status = response.status();
        if status.is_redirection() {
            return Err(self.transport());
        }
        let bytes = runner::bytes(response, 2 * 1024 * 1024)
            .await
            .map_err(|_| self.transport())?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| self.transport())?;
        if !status.is_success() {
            return Err(Error(
                1,
                value["error"].as_str().unwrap_or("Request denied.").into(),
            ));
        }
        Ok(value)
    }

    async fn pages(&self, path: &str, key: &str) -> Result<Vec<Value>> {
        let mut rows = Vec::new();
        let mut after = String::new();
        loop {
            let page = self.request(&format!("{path}{after}"), None).await?;
            rows.extend(
                page[key]
                    .as_array()
                    .ok_or_else(Error::invalid)?
                    .iter()
                    .cloned(),
            );
            let cursor = string(&page, "next_after");
            if cursor.is_empty() {
                return Ok(rows);
            }
            let next = format!("?after={}", runner::encode(cursor));
            if next == after {
                return Err(Error::invalid());
            }
            after = next;
        }
    }

    async fn poll(
        &self,
        path: &str,
        workflow: bool,
        wait: bool,
        initial: Option<Value>,
    ) -> Result<(u8, Value)> {
        let mut next = initial;
        loop {
            let response = match next.take() {
                Some(turn) => Ok(turn),
                None => self.request(path, None).await.and_then(|value| {
                    if workflow {
                        Ok(value)
                    } else {
                        value
                            .get(0)
                            .cloned()
                            .ok_or_else(|| Error(1, "Task not found.".into()))
                    }
                }),
            };
            match response {
                Ok(turn) => {
                    let code = match string(&turn, "status") {
                        "done" => Some(0),
                        "failed" | "cancelled" => Some(1),
                        "interrupted" if !workflow => Some(1),
                        "approval" if workflow => Some(3),
                        _ if !workflow
                            && (turn["paused"] == true
                                || turn["paused"] == 1
                                || turn["questions"].as_array().is_some_and(|questions| {
                                    questions
                                        .iter()
                                        .any(|q| q.get("answer").is_some_and(Value::is_null))
                                })) =>
                        {
                            Some(3)
                        }
                        _ => None,
                    };
                    if !wait || code.is_some() {
                        return Ok((code.unwrap_or(0), turn));
                    }
                }
                Err(Error(5, _)) if wait => {}
                Err(error) => return Err(error),
            }
            tokio::time::sleep(
                Duration::from_millis(500)
                    .min(self.deadline.saturating_duration_since(Instant::now())),
            )
            .await;
        }
    }
}

#[derive(Default)]
struct Command {
    name: String,
    selector: String,
    id: Option<String>,
    routine: Option<String>,
    request_id: Option<String>,
    question: Option<String>,
    thread: Option<String>,
    text: String,
    body: Option<Value>,
    revision: Option<u64>,
    accepted: bool,
    acknowledge_uncertain: bool,
    wait: bool,
    seconds: u64,
}

impl Command {
    fn parse(args: &[String]) -> Result<Self> {
        let mut args = args.iter();
        let name = args.next().map(String::as_str).unwrap_or("");
        let (resource, limit, need_revision, operation) = match name {
            "list" | "provider" | "models" | "routines" | "threads" | "workflows" | "approvals" => (false, 0, false, false),
            "provider-save" => (false, 16_000, false, true),
            "run" => (false, 16_000, false, false),
            "thread" => (false, 80, false, false),
            "status" | "cancel" | "routine-runs" | "workflow-status" | "workflow-schedule" | "workflow-webhook" => (true, 0, false, false),
            "answer" => (true, 4000, false, true),
            "routine-run" | "workflow-run" => (true, 16_000, true, true),
            "workflow-cancel" | "workflow-retry" | "approve" => (true, 0, true, true),
            "workflow-schedule-save" => (true, 128_000, false, true),
            "workflow-webhook-save" => (true, 16_000, false, true),
            _ => return Err(Error::args("Use script list, provider, provider-save, models, routines, routine-runs, routine-run, threads, thread, workflows, approvals, workflow-run/status/cancel/retry/schedule/schedule-save/webhook/webhook-save, approve, run, status, cancel, or answer.")),
        };
        let mut command = Self {
            name: name.into(),
            seconds: 1800,
            ..Self::default()
        };
        if name != "list" {
            command.selector = args
                .next()
                .filter(|v| !v.is_empty())
                .ok_or_else(|| Error::args("Agent is required."))?
                .clone();
        }
        if resource {
            let lowercase = !matches!(name, "status" | "cancel" | "answer");
            command.id = Some(
                args.next()
                    .filter(|v| uuid(v, lowercase))
                    .ok_or_else(|| {
                        Error::args(if lowercase {
                            "Resource ID must be a lowercase UUIDv4."
                        } else {
                            "ID must be a UUIDv4."
                        })
                    })?
                    .clone(),
            );
        }
        if need_revision {
            command.revision = Some(
                positive(args.next(), 9_007_199_254_740_991)
                    .ok_or_else(|| Error::args("Positive revision is required."))?,
            );
        }
        if name == "approve" {
            command.accepted = match args.next().map(String::as_str) {
                Some("yes") => true,
                Some("no") => false,
                _ => {
                    return Err(Error::args(
                        "Positive revision and yes or no decision are required.",
                    ))
                }
            };
        }
        if name == "answer" {
            command.question = Some(
                args.next()
                    .filter(|v| uuid(v, false))
                    .ok_or_else(|| {
                        Error::args("Question ID and answer --id must be UUIDv4 values.")
                    })?
                    .clone(),
            );
        }
        let text = if limit > 0 { args.next() } else { None };
        let polls = matches!(
            name,
            "run" | "status" | "answer" | "routine-run" | "workflow-run"
        );
        while let Some(flag) = args.next() {
            match flag.as_str() {
                "--wait" if polls && !command.wait => command.wait = true,
                "--timeout" if polls => {
                    command.seconds = positive(args.next(), 86_400)
                        .ok_or_else(|| Error::args("Timeout must be 1 to 86400 seconds."))?;
                }
                "--thread"
                    if matches!(name, "run" | "status" | "cancel" | "answer")
                        && command.thread.is_none() =>
                {
                    command.thread = Some(
                        args.next()
                            .filter(|v| uuid(v, true))
                            .ok_or_else(|| {
                                Error::args("Side conversation ID must be a lowercase UUIDv4.")
                            })?
                            .clone(),
                    );
                }
                "--acknowledge-uncertain" if name == "answer" && !command.acknowledge_uncertain => {
                    command.acknowledge_uncertain = true
                }
                "--id" if operation && command.request_id.is_none() => {
                    command.request_id = Some(
                        args.next()
                            .filter(|v| uuid(v, name == "workflow-run"))
                            .ok_or_else(|| Error::args("Operation --id must be a UUIDv4."))?
                            .clone(),
                    );
                }
                "--id" if matches!(name, "run" | "thread") && command.id.is_none() => {
                    command.id = Some(
                        args.next()
                            .filter(|v| uuid(v, name == "thread"))
                            .ok_or_else(|| Error::args("ID must be a UUIDv4."))?
                            .clone(),
                    );
                }
                _ => return Err(Error::args("Invalid arguments.")),
            }
        }
        if operation && command.request_id.is_none() {
            return Err(Error::args("Operation --id must be a UUIDv4."));
        }
        if limit > 0 {
            let mut stdin = Vec::new();
            let text = match text.map(String::as_str) {
                Some("-") => {
                    io::stdin()
                        .take((limit * 3 + 1) as u64)
                        .read_to_end(&mut stdin)
                        .map_err(|_| Error::args("Unable to read text from stdin."))?;
                    String::from_utf8_lossy(&stdin).into_owned()
                }
                Some(text) => text.to_owned(),
                None => String::new(),
            };
            if text.trim().is_empty() || text.encode_utf16().count() > limit {
                return Err(Error(
                    2,
                    format!("Text must contain 1 to {limit} characters."),
                ));
            }
            command.text = text;
        }
        if matches!(name, "run" | "thread") && command.id.is_none() {
            command.id = Some(Uuid::new_v4().to_string());
        }
        if name == "routine-run" {
            command.routine = command.id.take();
        }
        let fields: &[&str] = match name {
            "provider-save" => &["revision", "model", "backupModel", "providerAccount"],
            "workflow-webhook-save" => &["revision", "enabled", "rotate", "remove", "route"],
            "workflow-schedule-save" => {
                &["revision", "nextAt", "intervalSeconds", "input", "enabled"]
            }
            _ => return Ok(command),
        };
        let mut body: Value = serde_json::from_str(&command.text)
            .map_err(|_| Error::args("Settings must be valid JSON."))?;
        if !closed(&body, fields) {
            return Err(Error::args("Invalid settings field."));
        }
        body["id"] = json!(command.request_id);
        command.body = Some(body);
        Ok(command)
    }

    fn result(&self, code: u8, fields: Value) -> Value {
        let mut result = fields.as_object().cloned().unwrap_or_else(Map::new);
        result.insert("exitCode".into(), json!(code));
        for (key, value) in [
            ("id", &self.id),
            ("routine", &self.routine),
            ("requestId", &self.request_id),
            ("question", &self.question),
            ("thread", &self.thread),
        ] {
            if let Some(value) = value {
                result.insert(key.into(), json!(value));
            }
        }
        Value::Object(result)
    }

    async fn execute(&mut self, http: &Requester) -> Result<(u8, Value)> {
        let agents = http.pages("/api/scripts/agents", "agents").await?;
        if self.name == "list" {
            return Ok((0, json!({"agents":agents})));
        }
        let selected = self.selector.to_lowercase();
        let exact = agents
            .iter()
            .find(|agent| string(agent, "id").to_lowercase() == selected);
        let agent = if let Some(agent) = exact {
            agent
        } else {
            let mut matches = agents.iter().filter(|agent| {
                !uuid(&self.selector, false) && string(agent, "name").to_lowercase() == selected
            });
            let first = matches
                .next()
                .ok_or_else(|| Error(5, "Authorized agent not found.".into()))?;
            if matches.next().is_some() {
                return Err(Error::args("Agent name is ambiguous; use its ID."));
            }
            first
        };
        let agent_id = string(agent, "id");
        if !uuid(agent_id, false) {
            return Err(Error::invalid());
        }
        let base = format!("/api/scripts/agents/{agent_id}");
        let id = self.id.as_deref().unwrap_or("");
        let name = self.name.as_str();
        let (field, value) = match name {
            "provider" | "provider-save" => {
                let value = http
                    .request(&format!("{base}/provider"), self.body.take())
                    .await?;
                if name == "provider-save" {
                    self.id = Some(agent_id.into());
                }
                ("provider", value)
            }
            "models" => return Ok((0, http.request(&format!("{base}/models"), None).await?)),
            "threads" => (
                "threads",
                http.request(&format!("{base}/threads"), None).await?,
            ),
            "thread" => (
                "conversation",
                http.request(
                    &format!("{base}/threads"),
                    Some(json!({"id":id,"name":self.text})),
                )
                .await?,
            ),
            "workflows" | "approvals" => (
                name,
                json!(http.pages(&format!("{base}/{name}"), name).await?),
            ),
            "workflow-webhook"
            | "workflow-webhook-save"
            | "workflow-schedule"
            | "workflow-schedule-save" => {
                let field = if name.contains("webhook") {
                    "webhook"
                } else {
                    "schedule"
                };
                (
                    field,
                    http.request(&format!("{base}/workflows/{id}/{field}"), self.body.take())
                        .await?,
                )
            }
            "approve" | "workflow-retry" | "workflow-cancel" => {
                let action = name.strip_prefix("workflow-").unwrap_or(name);
                let mut body = json!({"id":self.request_id,"revision":self.revision});
                if name == "approve" {
                    body["accepted"] = json!(self.accepted);
                }
                (
                    "decision",
                    http.request(&format!("{base}/workflow-runs/{id}/{action}"), Some(body))
                        .await?,
                )
            }
            "workflow-status" | "workflow-run" => {
                if name == "workflow-run" {
                    let receipt = http.request(&format!("{base}/workflows/{id}/run"), Some(json!({"id":self.request_id,"revision":self.revision,"input":self.text}))).await?;
                    self.id = Some(receipt_id(&receipt, "id", true)?);
                    if !self.wait {
                        return Ok((0, json!({})));
                    }
                }
                let id = self.id.as_deref().unwrap_or("");
                let (code, turn) = http
                    .poll(&format!("{base}/workflow-runs/{id}"), true, self.wait, None)
                    .await?;
                return Ok((code, json!({"turn":turn})));
            }
            "routines" | "routine-runs" | "routine-run" => {
                let routines = http.request(&format!("{base}/routines"), None).await?;
                if name == "routines" {
                    return Ok((0, json!({"routines":routines})));
                }
                let routine = self.routine.as_deref().unwrap_or(id);
                if !routines
                    .as_array()
                    .is_some_and(|rows| rows.iter().any(|row| row["id"] == routine))
                {
                    return Err(Error(1, "Routine not found for this agent.".into()));
                }
                if name == "routine-runs" {
                    return Ok((
                        0,
                        json!({"runs":http.request(&format!("/api/scripts/routines/{routine}/runs"), None).await?}),
                    ));
                }
                let receipt = http.request(&format!("/api/scripts/routines/{routine}/run"), Some(json!({"id":self.request_id,"revision":self.revision,"payload":self.text}))).await?;
                self.id = Some(receipt_id(&receipt, "turn", false)?);
                self.thread = Some(receipt_id(&receipt, "thread", true)?);
                if !self.wait {
                    return Ok((0, json!({})));
                }
                return self.turn(http, &base).await;
            }
            _ => return self.turn(http, &base).await,
        };
        Ok((0, json!({field:value})))
    }

    async fn turn(&self, http: &Requester, base: &str) -> Result<(u8, Value)> {
        let id = self.id.as_deref().unwrap_or("");
        let path = match &self.thread {
            Some(thread) => format!("{base}/threads/{thread}/turns"),
            None => format!("{base}/turns"),
        };
        let initial = match self.name.as_str() {
            "cancel" => {
                let turn = http
                    .request(&format!("{path}/{id}/cancel"), Some(json!({"id":id})))
                    .await?;
                return Ok((
                    u8::from(turn["status"] != "cancelled"),
                    json!({"turn":turn}),
                ));
            }
            "answer" => {
                let question = self.question.as_deref().unwrap_or("");
                let answer = http.request(&format!("{path}/{id}/questions/{question}/answer"), Some(json!({"id":self.request_id,"text":self.text,"acknowledgeUncertain":self.acknowledge_uncertain}))).await?;
                if !self.wait {
                    return Ok((0, json!({"answer":answer})));
                }
                None
            }
            "run" => {
                let receipt = http
                    .request(&path, Some(json!({"id":id,"text":self.text})))
                    .await?;
                (!self.wait).then_some(receipt)
            }
            _ => None,
        };
        let (code, turn) = http
            .poll(&format!("{path}?focus={id}"), false, self.wait, initial)
            .await?;
        Ok((code, json!({"turn":turn})))
    }
}

fn receipt_id(value: &Value, field: &str, lowercase: bool) -> Result<String> {
    let id = string(value, field);
    uuid(id, lowercase)
        .then(|| id.to_owned())
        .ok_or_else(Error::invalid)
}

pub async fn run(args: &[String]) -> Value {
    let Some(directory) = std::env::var_os("MINARBOT_SCRIPT_DIRECTORY").filter(|v| !v.is_empty())
    else {
        return json!({"exitCode":5,"error":"Set MINARBOT_SCRIPT_DIRECTORY to the server discovery directory."});
    };
    let mut command = match Command::parse(args) {
        Ok(command) => command,
        Err(Error(code, message)) => return json!({"exitCode":code,"error":message}),
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .build();
    let Ok(client) = client else {
        return command.result(5, json!({"error":"Unable to initialize script transport."}));
    };
    let http = Requester {
        client,
        directory: directory.into(),
        deadline: Instant::now() + Duration::from_secs(command.seconds),
        command: command.name.clone(),
    };
    match command.execute(&http).await {
        Ok((code, fields)) => command.result(code, fields),
        Err(Error(code, message)) => command.result(code, json!({"error":message})),
    }
}
