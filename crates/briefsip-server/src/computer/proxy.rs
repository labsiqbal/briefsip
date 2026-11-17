use serde::Deserialize;
#[derive(Clone, Deserialize)]
pub struct TestTarget {
    pub hostname: String,
    pub port: u16,
    pub https_port: Option<u16>,
}
impl TestTarget {
    pub fn valid(&self) -> bool {
        self.hostname.ends_with(".test")
            && self.port > 0
            && self.https_port.map(|p| p > 0).unwrap_or(true)
    }
}
