use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalBridge {
    pub origin: String,
    pub token: String,
    pub clerk: bool,
    pub mail: bool,
    pub webhook: bool,
}
impl CanonicalBridge {
    pub(crate) fn call(&self, operation: &str, value: &Value) -> Result<Value> {
        use std::io::{Read, Write};
        let url =
            crate::connectors::config::loopback(&self.origin).map_err(|_| Failure::storage())?;
        let address =
            std::net::SocketAddr::from(([127, 0, 0, 1], url.port().ok_or_else(Failure::storage)?));
        let mut socket =
            std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_secs(5))
                .map_err(|_| Failure::storage())?;
        socket
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .map_err(|_| Failure::storage())?;
        socket
            .set_write_timeout(Some(std::time::Duration::from_secs(5)))
            .map_err(|_| Failure::storage())?;
        let body = value.to_string();
        write!(socket, "POST /{operation} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",self.origin.trim_start_matches("http://"),self.token,body.len(),body).map_err(|_|Failure::storage())?;
        let mut raw = String::new();
        socket
            .take(65537)
            .read_to_string(&mut raw)
            .map_err(|_| Failure::storage())?;
        if raw.len() > 65536 || !raw.starts_with("HTTP/1.1 200 ") {
            return Err(Failure::storage());
        }
        let (_, body) = raw.split_once("\r\n\r\n").ok_or_else(Failure::storage)?;
        serde_json::from_str::<Value>(body)
            .map_err(|_| Failure::storage())?
            .get("value")
            .cloned()
            .ok_or_else(Failure::storage)
    }
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub test_canonical_bridge: Option<CanonicalBridge>,
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
    fn service(&self, name: &str, mail: bool) -> Result<String> {
        let installation = self
            .installation_id
            .as_ref()
            .ok_or_else(|| unavailable(mail))?;
        Ok(format!(
            "briefsip/server/{installation}{}",
            if name.starts_with("routine-webhook/") {
                "/routine-webhooks"
            } else {
                ""
            }
        ))
    }
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
        if let Some(bridge) = &self.test_canonical_bridge {
            if std::env::var("BRIEFSIP_TEST_SERVER").as_deref() != Ok("rust") {
                return Err("Canonical fixture requires Rust test mode".into());
            }
            crate::connectors::config::loopback(&bridge.origin)?;
            if bridge.token.len() != 64 || !bridge.token.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err("Invalid canonical fixture token".into());
            }
        }
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
    pub(crate) fn read(&self, name: &str, mail: bool) -> Result<Option<String>> {
        if let Some(bridge) = &self.test_canonical_bridge {
            if bridge.mail && name.starts_with("mail-") {
                return bridge
                    .call("mail-key", &json!({"name":name}))
                    .map(|v| v.as_str().map(str::to_owned))
                    .map_err(|_| unavailable(true));
            }
        }
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
        let entry =
            keyring::Entry::new(&self.service(name, mail)?, name).map_err(|_| unavailable(mail))?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(unavailable(mail)),
        }
    }
    pub(crate) fn write(&self, name: &str, value: &str, mail: bool) -> Result<()> {
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
        keyring::Entry::new(&self.service(name, mail)?, name)
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
