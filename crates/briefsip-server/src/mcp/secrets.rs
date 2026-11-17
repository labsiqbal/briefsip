use super::*;
pub fn project(state: &AppState, db: &Connection, project: Option<&str>) -> Result<Vec<String>> {
    let mut values = Vec::new();
    if data::exists(
        db,
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_environment_redactions'",
        [],
    )? {
        for row in all(db,"SELECT project,name,ciphertext FROM project_environment_redactions WHERE (? IS NULL OR project=?)",[project,project])?{
            values.push(client::decrypt_with(state,string(&row,"ciphertext"),&format!("{}:{}",string(&row,"project"),string(&row,"name")),"project-env-key")?);
        }
    }
    values.retain(|v| !v.is_empty());
    values.sort_by_key(|s| std::cmp::Reverse(s.len()));
    Ok(values)
}
pub fn reflected(bytes: &[u8], secret: &str) -> bool {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let encodings = [
        secret.as_bytes().to_vec(),
        secret.encode_utf16().flat_map(u16::to_le_bytes).collect(),
        secret.encode_utf16().flat_map(u16::to_be_bytes).collect(),
        STANDARD.encode(secret).into_bytes(),
    ];
    encodings
        .iter()
        .any(|s| !s.is_empty() && bytes.windows(s.len()).any(|w| w == s))
}
