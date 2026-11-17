use super::*;
use crate::harness::process::Process;
use std::collections::HashMap;

pub fn elicitation(params: &Value) -> Value {
    if params["serverName"] != "briefsip" || params["mode"] != "form" {
        return json!({"action":"decline"});
    }
    let once_pattern = regex::Regex::new(
        r"(?i)^(?:once|accept|approve|allow)(?:[_\s-]*(?:once(?:[_\s-]*only)?|this[_\s-]*time))?$",
    );
    let persistent = regex::Regex::new("(?i)persist|always|remember");
    let schema = &params["requestedSchema"];
    let mut content = serde_json::Map::new();
    if let Some(properties) = schema["properties"].as_object() {
        for (key, field) in properties {
            let options: Vec<&str> = if let Some(values) = field["enum"].as_array() {
                values.iter().filter_map(Value::as_str).collect()
            } else {
                field["oneOf"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v["const"].as_str())
                    .collect()
            };
            let once = options
                .into_iter()
                .find(|s| once_pattern.as_ref().is_ok_and(|r| r.is_match(s.trim())));
            if let Some(value) = once {
                content.insert(key.clone(), json!(value));
            } else if field["type"] == "boolean"
                && persistent.as_ref().is_ok_and(|r| r.is_match(key))
            {
                content.insert(key.clone(), json!(false));
            } else if let Some(value) = field.get("default").filter(|v| !v.is_null()) {
                content.insert(key.clone(), value.clone());
            }
        }
    }
    if schema["required"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|key| key.as_str().is_none_or(|key| !content.contains_key(key)))
    {
        return json!({"action":"decline"});
    }
    json!({"action":"accept","content":content})
}

pub async fn probe(
    path: &std::path::Path,
    runtime: &str,
    hydrated_path: &str,
) -> Option<(bool, Value, Value)> {
    let home = process::ProbeHome::new().ok()?;
    let mut env = HashMap::new();
    env.insert("HOME".into(), home.0.to_string_lossy().into_owned());
    env.insert("PATH".into(), hydrated_path.to_owned());
    let mut process = Process::launch(
        path,
        &if runtime == "pi" {
            vec![
                "--mode".into(),
                "rpc".into(),
                "--offline".into(),
                "--no-extensions".into(),
                "--no-session".into(),
            ]
        } else {
            store::acp_args(runtime, path)
        },
        &home.0,
        &env,
    )
    .ok()?;
    if runtime == "pi" {
        process
            .send(json!({"id":1,"type":"get_state"}))
            .await
            .ok()?;
        let state = tokio::time::timeout(Duration::from_secs(2), process.next())
            .await
            .ok()?
            .ok()?;
        if state["success"] != true {
            return None;
        }
        process
            .send(json!({"id":2,"type":"get_available_models"}))
            .await
            .ok()?;
        let models = tokio::time::timeout(Duration::from_secs(2), process.next())
            .await
            .ok()?
            .ok()?;
        return Some((true,Value::Null,json!(models["data"]["models"].as_array().into_iter().flatten().map(|m|json!({"id":format!("{}/{}",string(m,"provider"),string(m,"id")),"label":m["name"]})).collect::<Vec<_>>())));
    }
    process.send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientInfo":{"name":"briefsip","version":"0.1.0"},"clientCapabilities":{"terminal":false}}})).await.ok()?;
    let value = tokio::time::timeout(Duration::from_secs(2), process.next())
        .await
        .ok()?
        .ok()?;
    Some((
        value["result"]["protocolVersion"] == 1,
        Value::Null,
        json!([]),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn elicitations_only_accept_briefsip_once() {
        let form = json!({"serverName":"briefsip","mode":"form","requestedSchema":{"properties":{"decision":{"enum":["acceptAlways","accept","decline"]},"remember":{"type":"boolean"}},"required":["decision"]}});
        assert_eq!(
            elicitation(&form),
            json!({"action":"accept","content":{"decision":"accept","remember":false}})
        );
        let mut unknown = form.clone();
        unknown["serverName"] = json!("foreign");
        assert_eq!(elicitation(&unknown), json!({"action":"decline"}));
        unknown = form;
        unknown["requestedSchema"]["required"] = json!(["missing"]);
        assert_eq!(elicitation(&unknown), json!({"action":"decline"}));
    }
}
