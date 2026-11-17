use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{path::PathBuf, process::Stdio};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn worker() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(root) = exe.parent().and_then(|d| d.parent()) {
            let path = root.join("app/shared-data-worker.py");
            if path.is_file() {
                return path;
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../app/shared-data-worker.py")
}
fn input(mode: &str, v: &Value) -> Result<Value> {
    let keys_allowed = if mode == "list" {
        vec!["after"]
    } else if mode == "drop" {
        vec!["table"]
    } else {
        vec!["sql", "parameters"]
    };
    if !keys(v, &keys_allowed) {
        return Err(error(400, "Unknown query field."));
    }
    if mode == "list" {
        if v.get("after")
            .is_some_and(|v| v.as_str().is_none_or(|v| v.encode_utf16().count() > 128))
        {
            return Err(error(400, "Invalid table position."));
        }
    } else if mode == "drop" {
        if !v["table"]
            .as_str()
            .is_some_and(|v| !v.is_empty() && v.encode_utf16().count() <= 128)
        {
            return Err(error(400, "Invalid table name."));
        }
    } else {
        if !v["sql"].as_str().is_some_and(|v| {
            !v.trim().is_empty() && v.encode_utf16().count() <= 16000 && v.len() <= 32000
        }) {
            return Err(error(
                400,
                "SQL must contain one statement, up to 16000 characters/32 KiB.",
            ));
        }
        if v.get("parameters").is_some_and(|v| {
            !v.as_array().is_some_and(|a| {
                a.len() <= 100
                    && v.to_string().len() <= 32000
                    && a.iter().all(|v| {
                        v.is_null()
                            || v.is_string()
                            || v.as_f64().is_some_and(|n| {
                                n.is_finite() && (n.fract() != 0.0 || n.abs() <= 9007199254740991.0)
                            })
                    })
            })
        }) {
            return Err(error(400, "Query parameters are invalid or exceed 32 KiB."));
        }
    }
    let mut result = json!({"mode":mode});
    result
        .as_object_mut()
        .ok_or_else(Failure::storage)?
        .extend(v.as_object().ok_or_else(Failure::storage)?.clone());
    Ok(result)
}
async fn prepare(
    state: &AppState,
    request: &Value,
    readonly: bool,
    admin: bool,
    status: u16,
) -> Result<(i64, Option<Vec<u8>>, Value)> {
    let (revision, image) = {
        let db = state.database.lock().map_err(|_| Failure::storage())?;
        db.connection.query_row(
            "SELECT revision,image FROM shared_data WHERE id=1",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<Vec<u8>>>(1)?)),
        )?
    };
    let mut payload = request.clone();
    payload["owner"] = Value::Null;
    payload["readonly"] = json!(readonly);
    payload["admin"] = json!(admin);
    payload["image"] = image
        .map(|v| json!(STANDARD.encode(v)))
        .unwrap_or(Value::Null);
    let mut child = tokio::process::Command::new("python3")
        .arg("-I")
        .arg(worker())
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("LANG", "C.UTF-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| error(status, "Python 3.11+ worker with sqlite3 is unavailable."))?;
    let mut stdin = child.stdin.take().ok_or_else(Failure::storage)?;
    let stdout = child.stdout.take().ok_or_else(Failure::storage)?;
    let bytes = payload.to_string();
    let work = async {
        let write = async {
            let result = stdin.write_all(bytes.as_bytes()).await;
            drop(stdin);
            result.map_err(|_| error(status, "Query worker stopped before receiving input."))
        };
        let read = async {
            let mut out = Vec::new();
            stdout
                .take(24 * 1024 * 1024 + 1)
                .read_to_end(&mut out)
                .await
                .map_err(|_| Failure::storage())?;
            if out.len() > 24 * 1024 * 1024 {
                return Err(error(status, "Worker result is too large."));
            }
            Ok(out)
        };
        let (write, out) = tokio::join!(write, read);
        write?;
        let out = out?;
        if !child
            .wait()
            .await
            .map_err(|_| Failure::storage())?
            .success()
        {
            return Err(error(status, "Query stopped by worker resource limits."));
        }
        let output: Value = serde_json::from_slice(&out)
            .map_err(|_| error(status, "Invalid query worker result."))?;
        if let Some(message) = output["error"].as_str() {
            return Err(error(status, message));
        }
        let result = output
            .get("result")
            .filter(|r| r.is_object())
            .cloned()
            .ok_or_else(|| error(status, "Invalid query result."))?;
        let image = output["image"]
            .as_str()
            .map(|v| {
                STANDARD
                    .decode(v)
                    .map_err(|_| error(status, "Invalid query worker result."))
            })
            .transpose()?;
        if image.as_ref().is_some_and(|v| v.len() > 16 * 1024 * 1024) {
            return Err(error(status, "Shared database limit is 16 MiB."));
        }
        Ok((revision, image, result))
    };
    match tokio::time::timeout(std::time::Duration::from_secs(3), work).await {
        Ok(result) => result,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(error(status, "Query timed out."))
        }
    }
}
pub async fn handle(state: &AppState, req: Request) -> Result<Response> {
    let path = req.uri().path().to_owned();
    if req.method() == Method::GET && path == "/api/data" {
        let q = query(&req);
        let input = input(
            "list",
            &json!({"after":parameter(&q,"after").unwrap_or("")}),
        )?;
        let (revision, _, mut result) = prepare(state, &input, true, false, 503).await?;
        result["revision"] = json!(revision);
        return Ok(json_response(200, result));
    }
    if req.method() != Method::POST {
        return Err(error(404, "Route not found."));
    }
    mutation(state, &req)?;
    let v = body(req, 64000).await?;
    if !v.is_object() {
        return Err(error(400, "JSON object is required."));
    }
    if !valid_id(text(&v, "id")) {
        return Err(error(400, "Invalid request ID."));
    }
    let revision = v["revision"]
        .as_i64()
        .filter(|n| (0..=9007199254740991).contains(n))
        .ok_or_else(|| error(400, "Invalid data revision."))?;
    let dropping = path.ends_with("/drop");
    let mut args = Map::new();
    for key in if dropping {
        vec!["table"]
    } else {
        vec!["sql", "parameters"]
    } {
        if let Some(value) = v.get(key) {
            args.insert(key.to_owned(), value.clone());
        }
    }
    let input = input(
        if dropping { "drop" } else { "query" },
        &Value::Object(args),
    )?;
    let request = json!({"path":path,"revision":revision,"input":input}).to_string();
    let id = text(&v, "id");
    {
        let db = state.database.lock().map_err(|_| Failure::storage())?;
        if let Some(prior) = one(
            &db.connection,
            "SELECT request,result FROM shared_data_commands WHERE id=?",
            [id],
        )? {
            if prior["request"] != request {
                return Err(error(
                    409,
                    "Query ID was already used for a different command.",
                ));
            }
            return Ok(json_response(
                200,
                serde_json::from_str(text(&prior, "result")).map_err(|_| Failure::storage())?,
            ));
        }
        let current: i64 =
            db.connection
                .query_row("SELECT revision FROM shared_data WHERE id=1", [], |r| {
                    r.get(0)
                })?;
        if current != revision {
            return Err(error(409, "Data changed. Reload before continuing."));
        }
    }
    let (prepared_revision, image, mut result) =
        prepare(state, &input, !dropping, dropping, 400).await?;
    let mut db = state.database.lock().map_err(|_| Failure::storage())?;
    let result = transaction(&mut db.connection, |db| {
        if let Some(prior) = one(
            db,
            "SELECT request,result FROM shared_data_commands WHERE id=?",
            [id],
        )? {
            if prior["request"] != request {
                return Err(error(
                    409,
                    "Query ID was already used for a different command.",
                ));
            }
            return serde_json::from_str(text(&prior, "result")).map_err(|_| Failure::storage());
        }
        let current: i64 =
            db.query_row("SELECT revision FROM shared_data WHERE id=1", [], |r| {
                r.get(0)
            })?;
        if current != revision || prepared_revision != revision {
            return Err(error(409, "Data changed. Reload before continuing."));
        }
        if let Some(image) = &image {
            db.execute(
                "UPDATE shared_data SET image=?,revision=revision+1 WHERE id=1 AND revision=?",
                rusqlite::params![image, revision],
            )?;
        }
        result["revision"] = json!(revision + i64::from(image.is_some()));
        db.execute(
            "INSERT INTO shared_data_commands VALUES(?,?,?)",
            [id, &request, &result.to_string()],
        )?;
        Ok(result)
    })?;
    Ok(json_response(200, result))
}
