mod config;
pub(crate) mod images;
pub(crate) mod transcription;
use crate::data::{closed, error, exists, iso, one, string, transaction, uuid};
use crate::turns::{execution, tools};
use crate::{data, web::Failure, AppState};
use axum::{extract::Request, http::Method, response::Response};
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::watch;
type Result<T> = std::result::Result<T, Failure>;
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub image_provider: Option<config::Provider>,
    pub transcription_provider: Option<config::Provider>,
}
impl Options {
    pub fn environment() -> crate::db::Result<Self> {
        let read = |prefix: &str| -> crate::db::Result<Option<config::Provider>> {
            match (
                minarbot_launcher::rename_migration::var(format!("MINARBOT_{prefix}_BASE_URL")),
                minarbot_launcher::rename_migration::var(format!("MINARBOT_{prefix}_MODEL")),
            ) {
                (Err(_), Err(_)) => Ok(None),
                (Ok(base_url), Ok(model)) => Ok(Some(config::Provider {
                    base_url,
                    model,
                    api_key: minarbot_launcher::rename_migration::var(format!(
                        "MINARBOT_{prefix}_API_KEY"
                    ))
                    .ok(),
                })),
                _ => Err("Media provider requires base URL and model".into()),
            }
        };
        Ok(Self {
            image_provider: read("IMAGE")?,
            transcription_provider: read("TRANSCRIPTION")?,
        })
    }
    pub fn validate(&self) -> crate::db::Result<()> {
        for config in [&self.image_provider, &self.transcription_provider]
            .into_iter()
            .flatten()
        {
            config.endpoint("")?;
        }
        Ok(())
    }
}
