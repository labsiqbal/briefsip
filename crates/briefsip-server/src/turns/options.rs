use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub agent_limits: Option<Value>,
    pub image_provider: Option<MediaProvider>,
    pub transcription_provider: Option<MediaProvider>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaProvider {
    #[serde(rename = "baseURL")]
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
}
impl MediaProvider {
    pub fn endpoint(&self, path: &str) -> crate::db::Result<url::Url> {
        let url = url::Url::parse(&self.base_url)?;
        if !["http", "https"].contains(&url.scheme())
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("Invalid provider URL".into());
        }
        if self.model.trim().is_empty()
            || self.model.encode_utf16().count() > 160
            || self.model.chars().any(char::is_control)
            || self
                .api_key
                .as_ref()
                .is_some_and(|v| v.contains(['\r', '\n']))
        {
            return Err("Invalid media provider".into());
        }
        Ok(url::Url::parse(&format!(
            "{}{path}",
            self.base_url.trim_end_matches('/')
        ))?)
    }
}
impl Options {
    pub fn environment() -> crate::db::Result<Self> {
        let read = |prefix: &str| -> crate::db::Result<Option<MediaProvider>> {
            match (
                std::env::var(format!("BRIEFSIP_{prefix}_BASE_URL")),
                std::env::var(format!("BRIEFSIP_{prefix}_MODEL")),
            ) {
                (Err(_), Err(_)) => Ok(None),
                (Ok(base_url), Ok(model)) => Ok(Some(MediaProvider {
                    base_url,
                    model,
                    api_key: std::env::var(format!("BRIEFSIP_{prefix}_API_KEY")).ok(),
                })),
                _ => Err("Media provider requires base URL and model".into()),
            }
        };
        Ok(Self {
            agent_limits: None,
            image_provider: read("IMAGE")?,
            transcription_provider: read("TRANSCRIPTION")?,
        })
    }
    pub fn limit(&self, name: &str, default: i64) -> i64 {
        self.agent_limits
            .as_ref()
            .and_then(|v| v[name].as_i64())
            .unwrap_or(default)
    }
    pub fn validate(&self) -> crate::db::Result<()> {
        if self.agent_limits.as_ref().is_some_and(|v| {
            v.as_object().is_none_or(|v| {
                v.iter().any(|(k, v)| {
                    ![
                        "rate",
                        "rateWindowMs",
                        "cooldownMs",
                        "depth",
                        "concurrentChildren",
                    ]
                    .contains(&k.as_str())
                        || v.as_i64()
                            .is_none_or(|v| v < 1 || v > 9_007_199_254_740_991)
                })
            })
        }) {
            return Err("Invalid agent loop limits: use positive integers.".into());
        }
        for config in [&self.image_provider, &self.transcription_provider]
            .into_iter()
            .flatten()
        {
            config.endpoint("")?;
        }
        Ok(())
    }
}
