use serde::Deserialize;
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub hub_link: Option<Options>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub origin: String,
    pub hub_signing_public_key: String,
    #[serde(default)]
    pub development: bool,
    #[allow(dead_code)]
    pub reconnect_ms: Option<u64>,
}
impl Config {
    pub fn environment() -> crate::db::Result<Self> {
        Ok(Self {
            hub_link: std::env::var("BRIEFSIP_HUB_ORIGIN")
                .ok()
                .map(|origin| {
                    Ok::<_, Box<dyn std::error::Error + Send + Sync>>(Options {
                        origin,
                        hub_signing_public_key: std::env::var("BRIEFSIP_HUB_SIGNING_PUBLIC_KEY")?,
                        development: false,
                        reconnect_ms: None,
                    })
                })
                .transpose()?,
        })
    }
    pub fn validate(&self) -> crate::db::Result<()> {
        use base64::Engine;
        if let Some(o) = &self.hub_link {
            crate::config::trusted_origin(&o.origin, o.development)
                .map_err(|_| "Node hub origin must be configured HTTPS.")?;
            let key = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(&o.hub_signing_public_key)?;
            if key.len() != 44
                || !key.starts_with(&[
                    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0,
                ])
            {
                return Err("Invalid Ed25519 hub signing public key.".into());
            }
        }
        Ok(())
    }
}
