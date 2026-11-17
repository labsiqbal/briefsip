use serde::Deserialize;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub script_directory: Option<PathBuf>,
    #[serde(skip)]
    pub discovery: Arc<Mutex<Option<super::scripts::Discovery>>>,
}
impl Options {
    pub fn environment() -> Self {
        Self {
            script_directory: std::env::var_os("BRIEFSIP_SCRIPT_DIRECTORY").map(PathBuf::from),
            ..Self::default()
        }
    }
}
pub fn configure(config: &mut crate::config::Config) -> crate::db::Result<()> {
    use base64::Engine;
    if let Some(path) = &config.automation.script_directory {
        if !path.is_absolute() {
            return Err("Script discovery directory must be absolute".into());
        }
        if config.remaining_data.script_token.is_none() {
            let mut bytes = [0; 32];
            getrandom::getrandom(&mut bytes).map_err(|_| "Could not create script token")?;
            config.remaining_data.script_token =
                Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes));
        }
    }
    Ok(())
}
