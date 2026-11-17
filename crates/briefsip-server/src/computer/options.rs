use serde::Deserialize;
use std::{env, path::PathBuf};

#[allow(dead_code)]
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub desktop: Option<DesktopOptions>,
    pub machines: Option<MachineOptions>,
    pub test_computer_bridge: Option<TestBridge>,
}
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
pub struct DesktopOptions {
    pub data_dir: Option<PathBuf>,
    pub enabled: Option<bool>,
    pub max: Option<usize>,
    pub idle_ms: Option<i64>,
    pub lease_dir: Option<PathBuf>,
    pub geometry: Option<String>,
    pub test_only_proxy_target: Option<super::proxy::TestTarget>,
}
impl Options {
    pub fn environment() -> crate::db::Result<Self> {
        let desktop = DesktopOptions {
            enabled: Some(env::var("BRIEFSIP_AGENT_DESKTOP").as_deref() == Ok("1")),
            max: env::var("BRIEFSIP_AGENT_DESKTOP_MAX")
                .ok()
                .map(|v| v.parse())
                .transpose()?,
            idle_ms: env::var("BRIEFSIP_AGENT_DESKTOP_IDLE_MS")
                .ok()
                .map(|v| v.parse())
                .transpose()?,
            geometry: env::var("BRIEFSIP_AGENT_DESKTOP_GEOMETRY").ok(),
            ..Default::default()
        };
        Ok(Self {
            desktop: Some(desktop),
            ..Default::default()
        })
    }
    pub fn validate(&self) -> crate::db::Result<()> {
        if let Some(bridge) = &self.test_computer_bridge {
            let url = url::Url::parse(&bridge.origin)?;
            if env::var("BRIEFSIP_TEST_SERVER").as_deref() != Ok("rust")
                || url.scheme() != "http"
                || url.host_str() != Some("127.0.0.1")
                || url.origin().ascii_serialization() != bridge.origin
                || bridge.token.len() != 64
            {
                return Err("Invalid test computer bridge".into());
            }
        }
        let d = self.desktop.clone().unwrap_or_default();
        if !(1..=16).contains(&d.max.unwrap_or(2))
            || !(1000..=86400000).contains(&d.idle_ms.unwrap_or(900000))
        {
            return Err("Desktop limits: max 1..16; idle timeout 1000..86400000 ms.".into());
        }
        dimensions(d.geometry.as_deref().unwrap_or("1280x800"))?;
        if let Some(target) = &d.test_only_proxy_target {
            if env::var("BRIEFSIP_TEST_SERVER").as_deref() != Ok("rust") || !target.valid() {
                return Err("Invalid test-only proxy fixture.".into());
            }
        }
        Ok(())
    }
}
pub fn dimensions(value: &str) -> crate::db::Result<(u32, u32)> {
    let (w, h) = value.split_once('x').unwrap_or(("", ""));
    let width = w.parse::<u32>().unwrap_or(0);
    let height = h.parse::<u32>().unwrap_or(0);
    if w.len() != 4
        || !(3..=4).contains(&h.len())
        || !(1024..=1920).contains(&width)
        || !(640..=1200).contains(&height)
    {
        return Err("Desktop geometry: width 1024..1920; height 640..1200.".into());
    }
    Ok((width, height))
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MachineOptions {
    pub health_interval_ms: Option<u64>,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestBridge {
    pub origin: String,
    pub token: String,
}
