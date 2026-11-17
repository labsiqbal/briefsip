use serde::Deserialize;
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Provider {
    #[serde(rename = "baseURL")]
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
}
impl Provider {
    pub fn endpoint(&self, path: &str) -> crate::db::Result<url::Url> {
        let url = url::Url::parse(&self.base_url)?;
        if !["http", "https"].contains(&url.scheme())
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("Invalid provider URL".into());
        }
        if self.model.trim().is_empty()
            || self.model.encode_utf16().count() > 160
            || self.model.chars().any(char::is_control)
            || self
                .api_key
                .as_ref()
                .is_some_and(|v| v.contains(['\r', '\n']))
        {
            return Err("Invalid media provider".into());
        }
        Ok(url::Url::parse(&format!(
            "{}{path}",
            self.base_url.trim_end_matches('/')
        ))?)
    }
}
