use super::*;
use std::ops::Range;

pub(super) fn slice(text: &str, range: Range<usize>) -> String {
    if range.is_empty() {
        return "\"\"".into();
    }
    let mut selected = String::new();
    let (mut prefix, mut suffix) = (None, None);
    let mut position = 0;
    for c in text.chars() {
        let end = position + c.len_utf16();
        if end > range.start && position < range.end {
            let mut units = [0; 2];
            c.encode_utf16(&mut units);
            if position < range.start {
                prefix = Some(units[1]);
            } else if end > range.end {
                suffix = Some(units[0]);
            } else {
                selected.push(c);
            }
        }
        position = end;
        if position >= range.end {
            break;
        }
    }
    let encoded = json!(selected).to_string();
    let mut out = String::from("\"");
    if let Some(unit) = prefix {
        out.push_str(&format!("\\u{unit:04x}"));
    }
    out.push_str(&encoded[1..encoded.len() - 1]);
    if let Some(unit) = suffix {
        out.push_str(&format!("\\u{unit:04x}"));
    }
    out.push('"');
    out
}
fn encode(value: &Value, rules: &[(&Value, Range<usize>)], out: &mut String) {
    if let Some((_, range)) = rules.iter().find(|(v, _)| std::ptr::eq(*v, value)) {
        if let Some(text) = value.as_str() {
            out.push_str(&slice(text, range.clone()));
            return;
        }
    }
    match value {
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                encode(item, rules, out);
            }
            out.push(']');
        }
        Value::Object(items) => {
            out.push('{');
            for (i, (key, item)) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&json!(key).to_string());
                out.push(':');
                encode(item, rules, out);
            }
            out.push('}');
        }
        _ => out.push_str(&value.to_string()),
    }
}
pub(super) fn json(value: &Value, rules: &[(&Value, Range<usize>)]) -> String {
    let mut body = String::new();
    encode(value, rules, &mut body);
    body
}
pub(crate) fn response(value: &Value, rules: &[(&Value, Range<usize>)]) -> Response {
    use axum::response::IntoResponse;
    let body = json(value, rules);
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "application/json; charset=utf-8",
        )],
        body,
    )
        .into_response()
}
pub(super) fn history(value: &Value) -> Response {
    let mut rules = Vec::new();
    for turn in value.as_array().into_iter().flatten() {
        for key in ["agentMessages", "receivedAgentReplies"] {
            for message in turn[key].as_array().into_iter().flatten() {
                rules.push((&message["reply"], 0..1000));
            }
        }
    }
    response(value, &rules)
}
pub(super) fn sidebar(value: &Value) -> Response {
    let rules = value["summaries"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| (&item["preview"], 0..180))
        .collect::<Vec<_>>();
    response(value, &rules)
}
pub(crate) fn workspace(value: &Value, offset: usize) -> Response {
    response(
        value,
        &[(&value["text"], offset..offset.saturating_add(8000))],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf16_slices_preserve_split_pairs_and_escape_json() {
        assert_eq!(slice("a😀b", 0..2), "\"a\\ud83d\"");
        assert_eq!(slice("a😀b", 2..4), "\"\\ude00b\"");
        assert_eq!(slice("a😀b", 1..3), "\"😀\"");
        assert_eq!(slice("\"\\\n", 0..3), "\"\\\"\\\\\\n\"");
    }
}
