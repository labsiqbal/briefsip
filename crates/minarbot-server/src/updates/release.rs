use crate::web::Failure;
use serde_json::{json, Value};
use std::{fs, path::Path};

fn err(status: u16, message: impl Into<String>) -> Failure {
    Failure::new(status, "invalid_request", message)
}
pub fn version(value: &str) -> bool {
    regex::Regex::new(r"^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$").is_ok_and(|re| re.is_match(value))
}
pub fn id(value: &str) -> bool {
    minarbot_launcher::files::release_id(value)
}
pub fn info(root: &Path, id: &str) -> Result<Value, Failure> {
    if !self::id(id) {
        return Err(err(400, "Invalid release ID."));
    }
    let value = minarbot_launcher::files::json(&root.join(id).join("release.json"))
        .map_err(|e| err(409, e.to_string()))?;
    Ok(public(&value))
}
pub fn verify(root: &Path, id: &str) -> Result<Value, Failure> {
    minarbot_launcher::files::verify(root, id).map_err(|e| err(409, e.to_string()))
}
fn parse(value: Value) -> Result<Value, Failure> {
    let text = |key: &str| value[key].as_str().unwrap_or("");
    let version = text("version");
    let id = text("id");
    let commit = text("commit");
    if !self::id(id)
        || !self::version(version)
        || !id.starts_with(&format!("{version}-"))
        || commit.len() != 40
        || !commit
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !commit.starts_with(id.get(version.len() + 1..).unwrap_or(""))
        || !value["node"].is_string()
        || !value["notes"].is_string()
        || text("notes").encode_utf16().count() > 16000
        || !value["created"].is_string()
        || text("created").is_empty()
    {
        return Err(err(500, "Invalid release metadata."));
    }
    let files = value["files"]
        .as_object()
        .ok_or_else(|| err(500, "Invalid release metadata."))?;
    for (path, hash) in files {
        if path.is_empty()
            || path.starts_with('/')
            || path.chars().any(|c| c == '\\' || c.is_control())
            || path
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
            || !hash.as_str().is_some_and(|h| {
                h.len() == 64
                    && h.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
        {
            return Err(err(500, "Invalid release file manifest."));
        }
    }
    if let Some(issues) = value.get("issues") {
        let list = issues
            .as_array()
            .ok_or_else(|| err(500, "Invalid release issues."))?;
        let mut ids = std::collections::HashSet::new();
        if list.iter().any(|v| {
            !v.as_u64()
                .is_some_and(|n| n > 0 && n <= 9007199254740991 && ids.insert(n))
        }) {
            return Err(err(500, "Invalid release issues."));
        }
    }
    Ok(value)
}
pub fn latest(root: &Path) -> Result<Option<Value>, Failure> {
    let path = root.join("feed/latest.json");
    match fs::read(path) {
        Ok(bytes) => Ok(Some(parse(
            serde_json::from_slice(&bytes).map_err(|_| err(500, "Invalid release metadata."))?,
        )?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(err(409, "Release feed is unavailable.")),
    }
}
pub fn public(value: &Value) -> Value {
    json!({"id":value["id"],"version":value["version"],"notes":value["notes"],"created":value["created"],"commit":value["commit"]})
}
pub fn newer(candidate: &str, current: &str) -> bool {
    let p = |v: &str| {
        v.split('-')
            .next()
            .unwrap_or("")
            .split('.')
            .map(|x| x.parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    if !version(candidate) || !version(current) {
        return false;
    }
    let a = p(candidate);
    let b = p(current);
    (0..3)
        .find_map(|i| (a[i] != b[i]).then_some(a[i] > b[i]))
        .unwrap_or(candidate != current && current.contains('-') && !candidate.contains('-'))
}
