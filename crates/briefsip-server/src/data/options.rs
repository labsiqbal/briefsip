use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub script_token: Option<String>,
    pub installation_id: Option<String>,
    pub mail_from: Option<String>,
    pub mail_origin: Option<String>,
    pub test_keyring: Option<HashMap<String, String>>,
    #[serde(default)]
    pub test_keyring_locked: bool,
    #[serde(skip)]
    stored: Arc<Mutex<HashMap<String, String>>>,
}
pub(super) fn unavailable(mail: bool) -> Failure {
    let mut error = if mail {
        Failure::new(
            503,
            "mail_key_unavailable",
            "Mail key is not available yet.",
        )
    } else {
        Failure::new(
            503,
            "keystore_unavailable",
            "Sync key is not configured yet.",
        )
    };
    error.retryable = true;
    error
}
impl Options {
    pub fn environment() -> Self {
        Self {
            script_token: std::env::var("BRIEFSIP_SCRIPT_TOKEN").ok(),
            installation_id: std::env::var("BRIEFSIP_INSTALLATION_ID").ok(),
            mail_from: std::env::var("BRIEFSIP_MAIL_FROM").ok(),
            mail_origin: std::env::var("BRIEFSIP_ORIGIN").ok(),
            ..Self::default()
        }
    }
    pub fn validate(&self) -> crate::db::Result<()> {
        if self.script_token.as_ref().is_some_and(|s| {
            !(32..=256).contains(&s.len())
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        }) {
            return Err("BRIEFSIP_SCRIPT_TOKEN must be 32..256 URL-safe characters".into());
        }
        if self.installation_id.as_ref().is_some_and(|s| !uuid(s)) {
            return Err("Server installation ID must be UUID v4".into());
        }
        Ok(())
    }
    fn read(&self, name: &str, mail: bool) -> Result<Option<String>> {
        if self.test_keyring_locked {
            return Err(unavailable(mail));
        }
        if let Some(stub) = &self.test_keyring {
            let saved = self.stored.lock().map_err(|_| unavailable(mail))?;
            return Ok(saved.get(name).or_else(|| stub.get(name)).cloned());
        }
        if std::env::var("BRIEFSIP_TEST_SERVER").as_deref() == Ok("rust") {
            return Err(unavailable(mail));
        }
        let installation = self
            .installation_id
            .as_ref()
            .ok_or_else(|| unavailable(mail))?;
        let entry = keyring::Entry::new(&format!("briefsip/server/{installation}"), name)
            .map_err(|_| unavailable(mail))?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(unavailable(mail)),
        }
    }
    fn write(&self, name: &str, value: &str, mail: bool) -> Result<()> {
        if self.test_keyring_locked {
            return Err(unavailable(mail));
        }
        if self.test_keyring.is_some() {
            self.stored
                .lock()
                .map_err(|_| unavailable(mail))?
                .insert(name.into(), value.into());
            return Ok(());
        }
        if std::env::var("BRIEFSIP_TEST_SERVER").as_deref() == Ok("rust") {
            return Err(unavailable(mail));
        }
        let installation = self
            .installation_id
            .as_ref()
            .ok_or_else(|| unavailable(mail))?;
        keyring::Entry::new(&format!("briefsip/server/{installation}"), name)
            .and_then(|entry| entry.set_password(value))
            .map_err(|_| unavailable(mail))
    }
    pub(crate) fn key(&self, name: &str, mail: bool) -> Result<Vec<u8>> {
        let encoded = self.read(name, mail)?.ok_or_else(|| unavailable(mail))?;
        B64.decode(&encoded)
            .ok()
            .filter(|b| b.len() == 32 && B64.encode(b) == encoded)
            .ok_or_else(|| unavailable(mail))
    }
    pub(super) fn sync_key(&self) -> Result<Vec<u8>> {
        if self.read("sync-hmac/v1", false)?.is_none() {
            let mut key = [0; 32];
            getrandom::getrandom(&mut key).map_err(|_| unavailable(false))?;
            let encoded = B64.encode(key);
            self.write("sync-hmac/v1", &encoded, false)?;
            if self.read("sync-hmac/v1", false)?.as_deref() != Some(&encoded) {
                return Err(unavailable(false));
            }
        }
        self.key("sync-hmac/v1", false)
    }
    pub(super) fn mail(&self) -> Result<(String, Vec<u8>, Vec<u8>)> {
        let id = self
            .read("mail-aead/active", true)?
            .filter(|s| uuid(s))
            .ok_or_else(|| unavailable(true))?;
        Ok((
            id.clone(),
            self.key(&format!("mail-aead/{id}"), true)?,
            self.key("mail-lookup/v1", true)?,
        ))
    }
}
