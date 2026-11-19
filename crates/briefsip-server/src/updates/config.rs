use serde::Deserialize;
use std::{env, path::PathBuf};

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub releases_dir: Option<PathBuf>,
    pub launcher_socket: Option<PathBuf>,
    pub test_peer_update_timeout_ms: Option<u64>,
    pub test_release_base_url: Option<String>,
    pub test_release_public_key: Option<String>,
    #[serde(skip)]
    pub trial: Option<String>,
    #[serde(skip)]
    pub(super) github: Option<std::sync::Arc<super::github::Feed>>,
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
            ..Self::default()
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
    pub fn validate(&mut self, test_mode: bool) -> crate::db::Result<()> {
        let options = &mut self.updates;
        let (base, key) = (
            options.test_release_base_url.as_deref(),
            options.test_release_public_key.as_deref(),
        );
        if !test_mode && (base.is_some() || key.is_some()) || base.is_none() && key.is_some() {
            return Err(
                "Test release settings require --test-config and a fixture base URL.".into(),
            );
        }
        if options.releases_dir.is_some() && (!test_mode || base.is_some()) {
            options.github = Some(std::sync::Arc::new(super::github::Feed::new(base, key)?));
        }
        Ok(())
    }
    pub fn options(&self) -> &Options {
        &self.updates
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_fixture_requires_test_config_and_loopback() -> crate::db::Result<()> {
        let mut config: Config = serde_json::from_value(serde_json::json!({"updates":{
            "releasesDir":"/tmp/release-fixture",
            "testReleaseBaseUrl":"http://127.0.0.1:9000/releases",
            "testReleasePublicKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
        }}))?;
        assert!(config.validate(false).is_err());
        config.validate(true)?;
        assert!(config.options().github.is_some());
        config.updates.test_release_base_url = Some("http://example.test/releases".into());
        assert!(config.validate(true).is_err());
        Ok(())
    }
}
