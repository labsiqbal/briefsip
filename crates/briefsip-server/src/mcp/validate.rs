use serde_json::Value;
pub fn valid(schema: &Value, value: &Value) -> bool {
    check(schema, schema, value, 0)
}
fn check(root: &Value, schema: &Value, value: &Value, depth: usize) -> bool {
    if depth > 64 || schema == &Value::Bool(false) {
        return false;
    }
    if let Some(reference) = schema["$ref"].as_str() {
        if !reference.starts_with("#/")
            || !root
                .pointer(&reference[1..])
                .is_some_and(|s| check(root, s, value, depth + 1))
        {
            return false;
        }
    }
    if schema["allOf"]
        .as_array()
        .is_some_and(|a| a.iter().any(|s| !check(root, s, value, depth + 1)))
        || schema
            .get("not")
            .is_some_and(|s| check(root, s, value, depth + 1))
    {
        return false;
    }
    if let Some(condition) = schema.get("if") {
        let branch = if check(root, condition, value, depth + 1) {
            "then"
        } else {
            "else"
        };
        if schema
            .get(branch)
            .is_some_and(|s| !check(root, s, value, depth + 1))
        {
            return false;
        }
    }
    if let Some(options) = schema["oneOf"].as_array() {
        if options
            .iter()
            .filter(|s| check(root, s, value, depth + 1))
            .count()
            != 1
        {
            return false;
        }
    }
    if let Some(options) = schema["anyOf"].as_array() {
        if !options.iter().any(|s| check(root, s, value, depth + 1)) {
            return false;
        }
    }
    if schema.get("const").is_some_and(|v| v != value)
        || schema["enum"]
            .as_array()
            .is_some_and(|v| !v.contains(value))
    {
        return false;
    }
    if let Some(kind) = schema["type"].as_str() {
        if !match kind {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "integer" => value.as_f64().is_some_and(|v| v.fract() == 0.0),
            "number" => value.is_number(),
            "null" => value.is_null(),
            "boolean" => value.is_boolean(),
            _ => false,
        } {
            return false;
        }
    }
    if let Some(object) = value.as_object() {
        if schema["minProperties"]
            .as_u64()
            .is_some_and(|n| object.len() < n as usize)
            || schema["maxProperties"]
                .as_u64()
                .is_some_and(|n| object.len() > n as usize)
        {
            return false;
        }
        if let Some(names) = schema.get("propertyNames") {
            if object
                .keys()
                .any(|k| !check(root, names, &Value::String(k.clone()), depth + 1))
            {
                return false;
            }
        }
        if schema["required"].as_array().is_some_and(|a| {
            a.iter()
                .any(|k| k.as_str().is_none_or(|k| !object.contains_key(k)))
        }) {
            return false;
        }
        for (key, v) in object {
            if let Some(s) = schema["properties"].get(key) {
                if !check(root, s, v, depth + 1) {
                    return false;
                }
            } else if schema["additionalProperties"] == false
                || schema["additionalProperties"].is_object()
                    && !check(root, &schema["additionalProperties"], v, depth + 1)
            {
                return false;
            }
        }
    }
    if let Some(array) = value.as_array() {
        if schema["minItems"]
            .as_u64()
            .is_some_and(|n| array.len() < n as usize)
            || schema["maxItems"]
                .as_u64()
                .is_some_and(|n| array.len() > n as usize)
            || schema["uniqueItems"] == true
                && array
                    .iter()
                    .enumerate()
                    .any(|(i, v)| array[..i].contains(v))
            || schema["items"].is_object()
                && array
                    .iter()
                    .any(|v| !check(root, &schema["items"], v, depth + 1))
        {
            return false;
        }
    }
    if let Some(s) = value.as_str() {
        let len = s.encode_utf16().count() as u64;
        if schema["minLength"].as_u64().is_some_and(|n| len < n)
            || schema["maxLength"].as_u64().is_some_and(|n| len > n)
        {
            return false;
        }
        if let Some(p) = schema["pattern"].as_str() {
            if !regex::RegexBuilder::new(p)
                .size_limit(1024 * 1024)
                .build()
                .is_ok_and(|r| r.is_match(s))
            {
                return false;
            }
        }
    }
    if let Some(n) = value.as_f64() {
        if schema["exclusiveMinimum"].as_f64().is_some_and(|v| n <= v)
            || schema["exclusiveMaximum"].as_f64().is_some_and(|v| n >= v)
            || schema["minimum"].as_f64().is_some_and(|v| n < v)
            || schema["maximum"].as_f64().is_some_and(|v| n > v)
        {
            return false;
        }
    }
    true
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn checks_closed_nested_objects() {
        let s = json!({"type":"object","required":["id"],"properties":{"id":{"type":"integer","minimum":1}},"additionalProperties":false});
        assert!(valid(&s, &json!({"id":1})));
        assert!(!valid(&s, &json!({"id":0})));
        assert!(!valid(&s, &json!({"id":1,"extra":true})));
    }
}
