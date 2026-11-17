use serde::{
    de::{self, MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer,
};
use serde_json::{Map, Value};
use std::fmt;

#[derive(Debug)]
pub struct Failure {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub details: Option<Value>,
}
impl Failure {
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            retryable: false,
            details: None,
        }
    }
    pub fn storage() -> Self {
        let mut error = Self::new(
            500,
            "storage_failed",
            "Save failed. Repeat the same request.",
        );
        error.retryable = true;
        error
    }
}
impl From<rusqlite::Error> for Failure {
    fn from(_: rusqlite::Error) -> Self {
        Self::storage()
    }
}
struct Unique(Value);
impl<'de> Deserialize<'de> for Unique {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Json;
        impl<'de> Visitor<'de> for Json {
            type Value = Value;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("JSON value")
            }
            fn visit_bool<E: de::Error>(self, value: bool) -> Result<Value, E> {
                Ok(value.into())
            }
            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Value, E> {
                Ok(value.into())
            }
            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Value, E> {
                Ok(value.into())
            }
            fn visit_f64<E: de::Error>(self, value: f64) -> Result<Value, E> {
                serde_json::Number::from_f64(value)
                    .map(Value::Number)
                    .ok_or_else(|| E::custom("Invalid JSON number"))
            }
            fn visit_str<E: de::Error>(self, value: &str) -> Result<Value, E> {
                Ok(value.into())
            }
            fn visit_string<E: de::Error>(self, value: String) -> Result<Value, E> {
                Ok(value.into())
            }
            fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
                Ok(Value::Null)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Value, A::Error> {
                let mut result = Vec::new();
                while let Some(Unique(value)) = sequence.next_element()? {
                    result.push(value);
                }
                Ok(Value::Array(result))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut object: A) -> Result<Value, A::Error> {
                let mut result = Map::new();
                while let Some((key, Unique(value))) = object.next_entry::<String, Unique>()? {
                    if result.contains_key(&key) {
                        return Err(de::Error::custom(format!("Duplicate JSON key: {key}.")));
                    }
                    result.insert(key, value);
                }
                Ok(Value::Object(result))
            }
        }
        deserializer.deserialize_any(Json).map(Unique)
    }
}
pub fn parse_json(bytes: &[u8]) -> Result<Value, Failure> {
    let raw = std::str::from_utf8(bytes)
        .map_err(|_| Failure::new(400, "invalid_json", "Body must be UTF-8."))?;
    let Unique(value) = serde_json::from_str(raw).map_err(|error| {
        let text = error.to_string();
        if text.starts_with("Duplicate JSON key:") {
            Failure::new(
                400,
                "duplicate_key",
                text.split(" at line ")
                    .next()
                    .unwrap_or("Duplicate JSON key."),
            )
        } else {
            Failure::new(400, "invalid_json", "Invalid JSON.")
        }
    })?;
    fn depth(value: &Value, level: usize) -> bool {
        level <= 64
            && match value {
                Value::Array(values) => values.iter().all(|value| depth(value, level + 1)),
                Value::Object(values) => values.values().all(|value| depth(value, level + 1)),
                _ => true,
            }
    }
    if !depth(&value, 0) {
        return Err(Failure::new(
            400,
            "invalid_json",
            "JSON is nested too deeply.",
        ));
    }
    Ok(value)
}
pub fn id(value: &str) -> Option<String> {
    if value.len() != 36
        || !value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
    {
        return None;
    }
    uuid::Uuid::parse_str(value)
        .ok()
        .filter(|id| id.get_version_num() == 4 && id.get_variant() == uuid::Variant::RFC4122)
        .map(|id| id.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn json_and_ids_reject_ambiguous_input() {
        assert_eq!(
            parse_json(br#"{"requestId":1,"requestId":2}"#)
                .err()
                .map(|error| error.code),
            Some("duplicate_key")
        );
        assert_eq!(
            parse_json(br#"{"outer":{"name":1,"\u006eame":2}}"#)
                .err()
                .map(|error| error.message),
            Some("Duplicate JSON key: name.".into())
        );
        assert!(parse_json(&[0xff]).is_err());
        assert!(parse_json(b"{} {} ").is_err());
        assert!(id("00000000000040008000000000000001").is_none());
    }
}
