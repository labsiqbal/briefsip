use super::*;
fn invalid() -> Failure {
    error(400, "Invalid resource template.")
}
fn expressions(template: &str) -> Result<Vec<(usize, usize, &str)>> {
    if template.is_empty()
        || template.len() > 2000
        || template
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(invalid());
    }
    let mut out = vec![];
    let mut offset = 0;
    while let Some(at) = template[offset..].find('{') {
        let start = offset + at;
        let end = template[start..]
            .find('}')
            .map(|i| i + start)
            .ok_or_else(invalid)?;
        if template[offset..start].contains('}') || template[start + 1..end].contains('{') {
            return Err(invalid());
        }
        out.push((start, end + 1, &template[start + 1..end]));
        offset = end + 1;
    }
    if template[offset..].contains('}') {
        return Err(invalid());
    }
    Ok(out)
}
fn spec(value: &str) -> Result<(&str, Option<usize>, bool)> {
    let pattern=regex::Regex::new(r"^((?:[A-Za-z0-9_]|%[A-Fa-f0-9]{2})+(?:\.(?:[A-Za-z0-9_]|%[A-Fa-f0-9]{2})+)*)(?::([1-9][0-9]{0,3})|(\*))?$").map_err(|_|Failure::storage())?;
    let c = pattern.captures(value).ok_or_else(invalid)?;
    let name = c.get(1).ok_or_else(invalid)?.as_str();
    if name.len() > 128 || ["__proto__", "constructor", "prototype"].contains(&name) {
        return Err(invalid());
    }
    Ok((
        name,
        c.get(2).and_then(|v| v.as_str().parse().ok()),
        c.get(3).is_some(),
    ))
}
pub fn schema(template: &str) -> Result<Value> {
    let mut props = serde_json::Map::new();
    let string = json!({"type":"string","maxLength":2000});
    for (_, _, expression) in expressions(template)? {
        for variable in expression
            .trim_start_matches(&['+', '#', '.', '/', ';', '?', '&'][..])
            .split(',')
        {
            let (name, prefix, _) = spec(variable)?;
            let scalar = prefix.is_some()
                || props
                    .get(name)
                    .is_some_and(|v| v.get("type") == Some(&json!("string")));
            props.insert(name.into(),if scalar{string.clone()}else{json!({"oneOf":[string,{"type":"array","items":string,"maxItems":32},{"type":"object","additionalProperties":string,"propertyNames":{"maxLength":128},"maxProperties":32}]})});
            if props.len() > 64 {
                return Err(invalid());
            }
        }
    }
    Ok(json!({"type":"object","properties":props,"additionalProperties":false}))
}
fn encode(s: &str, reserved: bool) -> String {
    let bytes = s.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if reserved
            && b == b'%'
            && i + 2 < bytes.len()
            && bytes[i + 1].is_ascii_hexdigit()
            && bytes[i + 2].is_ascii_hexdigit()
        {
            out.push_str(&s[i..i + 3]);
            i += 3;
            continue;
        }
        if b.is_ascii_alphanumeric()
            || b"_.~-".contains(&b)
            || reserved && b":/?#[]@!$&'()*+,;=".contains(&b)
        {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
        i += 1;
    }
    out
}
pub fn expand(template: &str, args: &Value) -> Result<String> {
    let expressions = expressions(template)?;
    let mut output = String::new();
    let mut offset = 0;
    for (start, end, expression) in expressions {
        output.push_str(&encode(&template[offset..start], true));
        offset = end;
        let operator = expression.chars().next().filter(|c| "+#./;?&".contains(*c));
        let body = if operator.is_some() {
            &expression[1..]
        } else {
            expression
        };
        let named = operator.is_some_and(|c| ";?&".contains(c));
        let reserved = operator.is_some_and(|c| "+#".contains(c));
        let named_value = |name: &str, value: &str| {
            format!(
                "{name}{}",
                if !value.is_empty() || operator != Some(';') {
                    format!("={value}")
                } else {
                    String::new()
                }
            )
        };
        let mut parts = vec![];
        for variable in body.split(',') {
            let (name, length, explode) = spec(variable)?;
            let Some(value) = args.get(name) else {
                continue;
            };
            if let Some(s) = value.as_str() {
                let s = s
                    .chars()
                    .take(length.unwrap_or(usize::MAX))
                    .collect::<String>();
                let s = encode(&s, reserved);
                parts.push(if named { named_value(name, &s) } else { s });
                continue;
            }
            if length.is_some() {
                return Err(invalid());
            }
            let list = value.as_array();
            let entries = if let Some(list) = list {
                list.iter()
                    .map(|v| {
                        v.as_str()
                            .map(|v| (name.to_owned(), v.to_owned()))
                            .ok_or_else(invalid)
                    })
                    .collect::<Result<Vec<_>>>()?
            } else if let Some(map) = value.as_object() {
                map.iter()
                    .map(|(k, v)| {
                        v.as_str()
                            .map(|v| (k.clone(), v.to_owned()))
                            .ok_or_else(invalid)
                    })
                    .collect::<Result<Vec<_>>>()?
            } else {
                return Err(invalid());
            };
            if entries.is_empty() {
                continue;
            }
            if explode {
                for (key, item) in entries {
                    let encoded = encode(&item, reserved);
                    parts.push(if list.is_some() {
                        if named {
                            named_value(name, &encoded)
                        } else {
                            encoded
                        }
                    } else {
                        named_value(&encode(&key, reserved), &encoded)
                    });
                }
            } else {
                let encoded = if list.is_some() {
                    entries
                        .iter()
                        .map(|(_, v)| encode(v, reserved))
                        .collect::<Vec<_>>()
                } else {
                    entries
                        .iter()
                        .flat_map(|(k, v)| [encode(k, reserved), encode(v, reserved)])
                        .collect::<Vec<_>>()
                }
                .join(",");
                parts.push(if named {
                    named_value(name, &encoded)
                } else {
                    encoded
                });
            }
        }
        if !parts.is_empty() {
            if let Some(c) = operator.filter(|c| *c != '+') {
                output.push(c);
            }
            let separator = match operator {
                Some('?') | Some('&') => "&",
                Some('.') => ".",
                Some('/') => "/",
                Some(';') => ";",
                _ => ",",
            };
            output.push_str(&parts.join(separator));
        }
    }
    output.push_str(&encode(&template[offset..], true));
    if output.len() > 2000
        || !regex::Regex::new(r"^[A-Za-z][A-Za-z0-9+.-]*:")
            .map_err(|_| Failure::storage())?
            .is_match(&output)
        || output
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "{}".contains(c))
    {
        return Err(invalid());
    }
    Ok(output)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rfc6570_composites() {
        assert_eq!(
            expand(
                "fixture://items{/path*}{?q,list*}",
                &json!({"path":["a b","c"],"q":"🧪","list":["one","two"]})
            )
            .ok(),
            Some("fixture://items/a%20b/c?q=%F0%9F%A7%AA&list=one&list=two".into())
        );
        assert_eq!(
            expand("fixture:{+value}", &json!({"value":"a%20b/c"})).ok(),
            Some("fixture:a%20b/c".into())
        );
    }

    #[test]
    fn template_variables_and_expansion_are_bounded_and_encoded() -> Result<()> {
        for (template, args, expected) in [
            (
                "fixture://data/{x,y}",
                json!({"x":"a/b","y":"#?"}),
                "fixture://data/a%2Fb,%23%3F",
            ),
            (
                "fixture://data/{+path}",
                json!({"path":"a/b%2F?q=x"}),
                "fixture://data/a/b%2F?q=x",
            ),
            (
                "fixture://data{/path*}{?q,filters*}",
                json!({"path":["a/b","c"],"q":"A B","filters":{"first":"x&y","empty":""}}),
                "fixture://data/a%2Fb/c?q=A%20B&first=x%26y&empty=",
            ),
            (
                "fixture://data{;x,y}",
                json!({"x":"","y":"ok"}),
                "fixture://data;x;y=ok",
            ),
            (
                "fixture://data{.ext}{#hash}",
                json!({"ext":"json","hash":"a/b"}),
                "fixture://data.json#a/b",
            ),
            (
                "fixture://data/{x:1}/{x:2}",
                json!({"x":"😀ab"}),
                "fixture://data/%F0%9F%98%80/%F0%9F%98%80a",
            ),
            (
                "fixture://data{?x%20y}",
                json!({"x%20y":"ok"}),
                "fixture://data?x%20y=ok",
            ),
            (
                "fixture://data/{+x*}",
                json!({"x":{"a/b":"c/d"}}),
                "fixture://data/a/b=c/d",
            ),
            ("fixture://data{?x}", json!({"x":[]}), "fixture://data"),
            ("fixture://data{;x}", json!({"x":{}}), "fixture://data"),
            (
                "fixture://data?one=1{&x}",
                json!({"x":{}}),
                "fixture://data?one=1",
            ),
            (
                "fixture://data{?list}",
                json!({"list":["red","green","blue"]}),
                "fixture://data?list=red,green,blue",
            ),
            (
                "fixture://data{?keys}",
                json!({"keys":{"semi":";","dot":".","comma":","}}),
                "fixture://data?keys=semi,%3B,dot,.,comma,%2C",
            ),
            (
                "fixture://data{;keys*}",
                json!({"keys":{"semi":";","dot":".","comma":","}}),
                "fixture://data;semi=%3B;dot=.;comma=%2C",
            ),
            (
                "fixture://data{+keys}",
                json!({"keys":{"semi":";","dot":".","comma":","}}),
                "fixture://datasemi,;,dot,.,comma,,",
            ),
            (
                "fixture://data{?x,x}",
                json!({"x":"ok"}),
                "fixture://data?x=ok&x=ok",
            ),
            (
                "fixture://data/{x}",
                json!({"x":"!'()*"}),
                "fixture://data/%21%27%28%29%2A",
            ),
        ] {
            assert_eq!(expand(template, &args)?, expected, "{template}");
        }
        let arguments = schema("fixture://data/{id:3}{?q,list*,map*}")?;
        for valid in [
            json!({"id":"abc","q":"","list":["a"],"map":{"k":"v"}}),
            json!({}),
        ] {
            assert!(super::super::validate::valid(&arguments, &valid));
        }
        for invalid in [
            json!({"uri":"fixture://unexpected"}),
            json!({"id":["a"]}),
            json!({"q":1}),
            json!({"list":[1]}),
            json!({"map":{"nested":{}}}),
            json!({"q":"x".repeat(2001)}),
        ] {
            assert!(!super::super::validate::valid(&arguments, &invalid));
        }
        for template in [
            "fixture://{",
            "fixture://{}",
            "fixture://{x:0}",
            "fixture://{x:10000}",
            "fixture://{x**}",
            "fixture://{__proto__}",
            "fixture://{constructor}",
            "fixture://{x y}",
            "fixture://{x,,y}",
        ] {
            assert!(schema(template).is_err(), "{template}");
        }
        assert!(expand("fixture://data{?constructor}", &json!({})).is_err());
        assert!(expand("relative/{id}", &json!({"id":"x"})).is_err());
        assert!(expand("fixture://{x}{x}", &json!({"x":"a".repeat(1500)})).is_err());
        Ok(())
    }
}
