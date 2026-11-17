use serde::Deserialize;
use std::{env, path::PathBuf};

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub releases_dir: Option<PathBuf>,
    pub launcher_socket: Option<PathBuf>,
    #[serde(skip)]
    pub trial: Option<String>,
}
impl Options {
    pub fn environment() -> crate::db::Result<Self> {
        let trial = env::var("BRIEFSIP_UPDATE_TRIAL").ok();
        if trial
            .as_deref()
            .is_some_and(|id| crate::web::id(id).is_none())
        {
            return Err("Invalid update trial ID.".into());
        }
        Ok(Self {
            releases_dir: env::var_os("BRIEFSIP_RELEASES_DIR").map(PathBuf::from),
            launcher_socket: env::var_os("BRIEFSIP_LAUNCHER_SOCKET").map(PathBuf::from),
            trial,
        })
    }
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default)]
    pub updates: Options,
}
impl Config {
    pub fn environment() -> crate::db::Result<Self> {
        Ok(Self {
            updates: Options::environment()?,
        })
    }
    pub fn options(&self) -> &Options {
        &self.updates
    }
}
