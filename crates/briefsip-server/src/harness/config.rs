use serde::Deserialize;
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Instant};
use tokio::sync::Mutex;

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub harness: Option<Value>,
    pub test_harness_bridge: Option<Bridge>,
    pub test_pdf_bridge: Option<Bridge>,
    #[serde(skip)]
    pub test_mode: bool,
    #[serde(skip)]
    pub environment: HashMap<String, String>,
    #[serde(skip)]
    pub cache: Arc<Mutex<Option<(Instant, Value)>>>,
    #[serde(skip)]
    pub revocations: Arc<std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>>,
    #[serde(skip)]
    pub stopping_processes: Arc<std::sync::Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    #[serde(skip)]
    pub homes: Arc<Mutex<HashMap<String, super::store::Home>>>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bridge {
    pub origin: String,
    pub token: String,
}
