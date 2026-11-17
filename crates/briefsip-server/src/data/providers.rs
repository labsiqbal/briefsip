use super::*;
use serde::Deserialize;
use std::{collections::BTreeSet, time::Duration};

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct Options {
    #[serde(rename = "baseURL")]
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub default_model: Option<String>,
    pub provider: Option<String>,
    #[serde(default, deserialize_with = "account_values")]
    accounts: Option<Value>,
    #[serde(skip)]
    validated_accounts: Vec<Account>,
    pub timeout: Option<u64>,
    pub concurrency: Option<Value>,
    pub project_root: Option<String>,
    pub harness: Option<Value>,
    pub stream: Option<bool>,
    pub stream_termination: Option<String>,
    pub max_tokens: Option<Value>,
}
fn account_values<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> std::result::Result<Option<Value>, D::Error> {
    Value::deserialize(input).map(Some)
}
#[derive(Clone)]
pub struct Account {
    pub id: String,
    pub name: String,
    pub family: String,
    pub base: String,
    pub key: Option<String>,
    pub model: String,
    pub stream: bool,
    pub termination: String,
    pub max_tokens: u64,
}
fn family(v: Option<&str>) -> crate::db::Result<String> {
    match v.unwrap_or("openai-compatible") {
        s @ ("openai-compatible" | "anthropic" | "gemini") => Ok(s.to_owned()),
        _ => Err("BRIEFSIP_PROVIDER must be openai-compatible, anthropic or gemini".into()),
    }
}
pub fn address(base: &str) -> crate::db::Result<url::Url> {
    let url = url::Url::parse(&format!("{}/models",base.strip_suffix('/').unwrap_or(base)))
        .map_err(|_| "Invalid provider address. Use HTTPS or loopback HTTP without credentials or a query in the URL.")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https"
            || url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
    {
        return Err("Invalid provider address. Use HTTPS or loopback HTTP without credentials or a query in the URL.".into());
    }
    Ok(url)
}
impl Options {
    pub fn environment() -> crate::db::Result<Self> {
        use std::env;
        let provider = env::var("BRIEFSIP_PROVIDER").ok();
        let family = provider.as_deref().unwrap_or("openai-compatible");
        let prefix = match family {
            "anthropic" => "ANTHROPIC",
            "gemini" => "GEMINI",
            _ => "OPENAI",
        };
        let parsed = |key: &str| -> crate::db::Result<Option<Value>> {
            env::var(key)
                .ok()
                .map(|s| {
                    if s.len() > 65536 {
                        return Err(format!("{key} exceeds 64 KiB").into());
                    }
                    serde_json::from_str(&s).map_err(|_| format!("Invalid {key} JSON").into())
                })
                .transpose()
        };
        Ok(Self {
            base_url: env::var(format!("{prefix}_BASE_URL")).ok(),
            api_key: env::var(format!("{prefix}_API_KEY")).ok(),
            default_model: env::var(format!("{prefix}_MODEL")).ok(),
            provider,
            accounts: match env::var("BRIEFSIP_PROVIDER_ACCOUNTS") {
                Ok(raw) if raw.len() > 65536 => {
                    return Err("Provider account configuration exceeds 64 KiB".into())
                }
                Ok(raw) => Some(
                    serde_json::from_str(&raw)
                        .map_err(|_| "Provider account configuration must be valid JSON")?,
                ),
                Err(env::VarError::NotPresent) => None,
                Err(_) => return Err("Provider account configuration must be valid JSON".into()),
            },
            project_root: env::var("BRIEFSIP_PROJECT_ROOT").ok(),
            concurrency: parsed("BRIEFSIP_CONCURRENCY")?,
            stream: Some(env::var("BRIEFSIP_STREAM").as_deref() == Ok("1")),
            stream_termination: env::var("BRIEFSIP_STREAM_TERMINATION").ok(),
            max_tokens: parsed("BRIEFSIP_MAX_TOKENS")?,
            ..Self::default()
        })
    }
    pub fn validate(&mut self) -> crate::db::Result<()> {
        self.validated_accounts = self.parse_accounts()?;
        self.accounts = None;

        if self
            .concurrency
            .as_ref()
            .is_some_and(|v| !integer(v, 1, 32))
        {
            return Err("BRIEFSIP_CONCURRENCY must be 1..32".into());
        }
        if self
            .max_tokens
            .as_ref()
            .is_some_and(|v| !integer(v, 1, 64000))
        {
            return Err("BRIEFSIP_MAX_TOKENS must be 1..64000".into());
        }
        if self
            .stream_termination
            .as_ref()
            .is_some_and(|s| !["marker", "finish-reason"].contains(&s.as_str()))
        {
            return Err("BRIEFSIP_STREAM_TERMINATION must be marker or finish-reason".into());
        }
        if self.provider.as_deref().unwrap_or("openai-compatible") != "openai-compatible"
            && self.stream_termination.as_deref() == Some("finish-reason")
        {
            return Err(
                "finish-reason termination is only supported for OpenAI-compatible streams".into(),
            );
        }
        Ok(())
    }
    fn parse_accounts(&self) -> crate::db::Result<Vec<Account>> {
        let mut out = vec![Account {
            id: String::new(),
            name: "Default server".into(),
            family: family(self.provider.as_deref())?,
            base: self.base_url.clone().unwrap_or_default(),
            key: self.api_key.clone(),
            model: self.default_model.clone().unwrap_or_default(),
            stream: self.stream.unwrap_or(false),
            termination: self
                .stream_termination
                .clone()
                .unwrap_or_else(|| "marker".into()),
            max_tokens: self
                .max_tokens
                .as_ref()
                .and_then(Value::as_u64)
                .unwrap_or(4096),
        }];
        if let Some(base) = &self.base_url {
            address(base)?;
        }
        let Some(values) = &self.accounts else {
            return Ok(out);
        };
        let values = values
            .as_array()
            .filter(|v| v.len() <= 32)
            .ok_or("Provider accounts must be an array of at most 32 entries")?;
        let mut ids = BTreeSet::new();
        for v in values {
            if !closed(
                v,
                &[
                    "id",
                    "name",
                    "provider",
                    "baseURL",
                    "apiKey",
                    "defaultModel",
                    "stream",
                    "streamTermination",
                    "maxTokens",
                ],
            ) {
                return Err("Invalid provider account".into());
            }
            let id = string(v, "id");
            if id.is_empty()
                || id.len() > 64
                || !id
                    .bytes()
                    .next()
                    .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
                || !ids.insert(id)
            {
                return Err("Invalid or duplicate provider account ID".into());
            }
            let name = v["name"]
                .as_str()
                .filter(|s| {
                    !s.trim().is_empty()
                        && s.encode_utf16().count() <= 80
                        && !s.chars().any(|c| c < ' ' || c == '\u{7f}')
                })
                .ok_or("Invalid provider account name")?;
            let base = v["baseURL"]
                .as_str()
                .filter(|s| s.encode_utf16().count() <= 2048)
                .ok_or("Invalid provider account URL")?;
            address(base).map_err(|_| "Invalid provider account URL")?;
            for (key, max) in [("apiKey", 8192), ("defaultModel", 160)] {
                if v.get(key).is_some_and(|v| {
                    v.as_str().is_none_or(|s| {
                        s.encode_utf16().count() > max
                            || s.chars().any(|c| c < ' ' || c == '\u{7f}')
                    })
                }) {
                    return Err(format!("Invalid provider account {key}").into());
                }
            }
            if v.get("provider").is_some_and(|v| !v.is_string()) {
                return Err(
                    "BRIEFSIP_PROVIDER must be openai-compatible, anthropic or gemini".into(),
                );
            }
            if v.get("streamTermination").is_some_and(|v| !v.is_string()) {
                return Err("BRIEFSIP_STREAM_TERMINATION must be marker or finish-reason".into());
            }
            let family = family(v.get("provider").and_then(Value::as_str))?;
            let termination = v
                .get("streamTermination")
                .and_then(Value::as_str)
                .unwrap_or("marker");
            if !["marker", "finish-reason"].contains(&termination) {
                return Err("BRIEFSIP_STREAM_TERMINATION must be marker or finish-reason".into());
            }
            if family != "openai-compatible" && termination != "marker" {
                return Err("finish-reason termination requires OpenAI-compatible provider".into());
            }
            if v.get("stream").is_some_and(|v| !v.is_boolean()) {
                return Err("Invalid provider account streaming".into());
            }
            if v.get("maxTokens").is_some_and(|v| !integer(v, 1, 64000)) {
                return Err("Invalid provider account token limit".into());
            }
            out.push(Account {
                id: id.into(),
                name: name.trim().into(),
                family,
                base: base.into(),
                key: v["apiKey"].as_str().map(str::to_owned),
                model: string(v, "defaultModel").into(),
                stream: v["stream"].as_bool().unwrap_or(false),
                termination: termination.into(),
                max_tokens: v["maxTokens"].as_u64().unwrap_or(4096),
            });
        }
        Ok(out)
    }
}
pub fn accounts(state: &AppState) -> Result<Vec<Account>> {
    Ok(state.config.data.validated_accounts.clone())
}
pub fn list(state: &AppState) -> Result<Value> {
    Ok(json!(accounts(state)?.into_iter().map(|a| {let host=url::Url::parse(&a.base).ok().map(|u|match u.port(){Some(p)=>format!("{}:{p}",u.host_str().unwrap_or("")),None=>u.host_str().unwrap_or("").into()}).unwrap_or_default();json!({"id":a.id,"name":a.name,"provider":a.family,"host":host,"configured":!a.base.is_empty(),"defaultModel":a.model})}).collect::<Vec<_>>()))
}
const INVALID: &str =
    "The provider returned an invalid model catalog. Check the /models endpoint response.";
const TIMEOUT: &str = "Model discovery timed out. Check the provider and try again.";
pub async fn models(state: &AppState, q: &[(String, String)]) -> Result<Value> {
    let account_id = param(q, "account").unwrap_or("");
    let account=accounts(state)?.into_iter().find(|a|a.id==account_id).ok_or_else(||error(503,"The selected provider account is missing. Choose another account or update server configuration."))?;
    if account.base.is_empty() {
        return Err(error(
            503,
            if account_id.is_empty() {
                "The default provider account is not configured. Check server configuration before trying model discovery."
            } else {
                "The selected provider account is not configured. Check server configuration or choose another account."
            },
        ));
    }
    let operation = discover(account);
    let result = tokio::time::timeout(
        Duration::from_millis(state.config.data.timeout.unwrap_or(15000).min(15000)),
        operation,
    )
    .await
    .map_err(|_| error(502, TIMEOUT))??;
    Ok(json!({"models":result}))
}
async fn discover(a: Account) -> Result<Vec<String>> {
    let mut url = address(&a.base).map_err(|_| error(502, INVALID))?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Failure::storage())?;
    let mut models = BTreeSet::new();
    let mut cursors = BTreeSet::new();
    let mut size = 0;
    for _ in 0..100 {
        let mut req = client.get(url.clone());
        if a.family == "anthropic" {
            req = req.header("anthropic-version", "2023-06-01");
        }
        if let Some(key) = &a.key {
            req = match a.family.as_str() {
                "gemini" => req.header("x-goog-api-key", key),
                "anthropic" => req.header("x-api-key", key),
                _ => req.bearer_auth(key),
            };
        }
        let mut response = req.send().await.map_err(|_| {
            error(
                502,
                "The model catalog host is unreachable. Check the provider URL and network.",
            )
        })?;
        let status = response.status().as_u16();
        let message=match status {300..=399=>Some("The model catalog redirected unexpectedly. Check the provider URL and /models endpoint."),401=>Some("The provider rejected the API key. Check the server's provider configuration."),403=>Some("The provider denied access to the model catalog. Check the API key permissions."),408=>Some(TIMEOUT),429=>Some("The provider rate limit blocked model discovery. Wait for quota to reset and try again."),500..=599=>Some("The provider is unavailable for model discovery. Check provider status and try again."),200..=299=>None,_=>Some(INVALID)};
        if let Some(m) = message {
            return Err(error(502, m));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| error(502, INVALID))? {
            size += chunk.len();
            if size > 2 * 1024 * 1024 {
                return Err(error(502, INVALID));
            }
            bytes.extend_from_slice(&chunk);
        }
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| error(502, INVALID))?;
        if a.key.as_ref().is_some_and(|k| {
            !k.is_empty()
                && v.to_string()
                    .contains(&json!(k).to_string()[1..json!(k).to_string().len() - 1])
        }) {
            return Err(error(502, INVALID));
        }
        let rows = v[if a.family == "gemini" {
            "models"
        } else {
            "data"
        }]
        .as_array()
        .filter(|r| r.len() <= 10000)
        .ok_or_else(|| error(502, INVALID))?;
        for row in rows {
            if a.family == "gemini" {
                let name = row["name"]
                    .as_str()
                    .and_then(|s| s.strip_prefix("models/"))
                    .filter(|s| {
                        !s.is_empty()
                            && s.len() <= 151
                            && s.as_bytes()[0].is_ascii_alphanumeric()
                            && s.bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
                    })
                    .ok_or_else(|| error(502, INVALID))?;
                let methods = row["supportedGenerationMethods"]
                    .as_array()
                    .ok_or_else(|| error(502, INVALID))?;
                if methods.iter().any(|v| v == "generateContent") {
                    models.insert(name.to_owned());
                }
            } else {
                let id = row["id"]
                    .as_str()
                    .filter(|s| {
                        !s.is_empty()
                            && s.trim() == *s
                            && s.encode_utf16().count() <= 160
                            && !s.chars().any(|c| c < ' ' || c == '\u{7f}')
                    })
                    .ok_or_else(|| error(502, INVALID))?;
                models.insert(id.to_owned());
            }
        }
        if models.len() > 10000 {
            return Err(error(502, INVALID));
        }
        let cursor = if a.family == "gemini" {
            if v.get("nextPageToken").is_none() {
                return Ok(models.into_iter().collect());
            }
            v["nextPageToken"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 2000)
                .ok_or_else(|| error(502, INVALID))?
        } else if a.family == "anthropic" {
            let more = v["has_more"].as_bool().ok_or_else(|| error(502, INVALID))?;
            if !more {
                return Ok(models.into_iter().collect());
            }
            v["last_id"]
                .as_str()
                .filter(|s| rows.last().is_some_and(|r| r["id"] == *s))
                .ok_or_else(|| error(502, INVALID))?
        } else {
            return Ok(models.into_iter().collect());
        };
        if !cursors.insert(cursor.to_owned()) {
            return Err(error(502, INVALID));
        }
        url.query_pairs_mut().clear().append_pair(
            if a.family == "gemini" {
                "pageToken"
            } else {
                "after_id"
            },
            cursor,
        );
    }
    Err(error(502, INVALID))
}
pub fn usage(db: &Connection, q: &[(String, String)]) -> Result<Value> {
    let cursor = param(q, "before");
    let before = cursor
        .map(str::parse::<i64>)
        .transpose()
        .ok()
        .flatten()
        .unwrap_or(9_007_199_254_740_991);
    if q.iter().any(|(k, _)| k != "before")
        || cursor.is_some_and(|s| {
            s.is_empty()
                || s.starts_with('0')
                || !s.bytes().all(|b| b.is_ascii_digit())
                || s.parse::<i64>().is_err()
        })
        || before > 9_007_199_254_740_991
    {
        return Err(error(400, "Invalid usage position."));
    }
    let calls=all(db,"SELECT provider_calls.*,agents.name AS agent_name FROM provider_calls JOIN agents ON agents.id=provider_calls.agent WHERE seq<? ORDER BY seq DESC LIMIT 51",[before])?;
    let summary=one(db,"SELECT count(*) AS calls,count(*) FILTER(WHERE status='pending') AS pending,count(*) FILTER(WHERE status='failed') AS failed,count(*) FILTER(WHERE status='interrupted') AS interrupted,CAST(sum(input_tokens) AS TEXT) AS input_tokens,CAST(sum(output_tokens) AS TEXT) AS output_tokens,CAST(sum(total_tokens) AS TEXT) AS total_tokens,count(*) FILTER(WHERE input_tokens IS NULL) AS unknown_input,count(*) FILTER(WHERE output_tokens IS NULL) AS unknown_output,count(*) FILTER(WHERE total_tokens IS NULL) AS unknown_total FROM provider_calls",[])?.ok_or_else(Failure::storage)?;
    let transcription = if table(db, "transcriptions")? {
        one(db,"SELECT count(*) AS calls,count(*) FILTER(WHERE status='pending') AS pending,count(*) FILTER(WHERE status='uncertain') AS uncertain,count(*) FILTER(WHERE status='cancelled') AS cancelled,count(*) FILTER(WHERE usage IS NULL OR usage='null') AS unknown,CAST(sum(json_extract(usage,'$.input_tokens')) AS TEXT) AS input_tokens,CAST(sum(json_extract(usage,'$.output_tokens')) AS TEXT) AS output_tokens,CAST(sum(json_extract(usage,'$.total_tokens')) AS TEXT) AS total_tokens,sum(json_extract(usage,'$.seconds')) AS seconds FROM transcriptions",[])? .unwrap_or(json!({"calls":0,"pending":0,"uncertain":0,"cancelled":0,"unknown":0,"input_tokens":null,"output_tokens":null,"total_tokens":null,"seconds":null}))
    } else {
        json!({"calls":0,"pending":0,"uncertain":0,"cancelled":0,"unknown":0,"input_tokens":null,"output_tokens":null,"total_tokens":null,"seconds":null})
    };
    Ok(
        json!({"summary":summary,"next_before":if calls.len()>50{calls[49]["seq"].clone()}else{Value::Null},"calls":calls.into_iter().take(50).collect::<Vec<_>>(),"transcription":transcription}),
    )
}
