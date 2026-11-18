use super::*;
use crate::computer::machines;
use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, StatusCode},
};
use sha2::{Digest, Sha256};
use std::{io::SeekFrom, time::Instant};
use tokio::io::AsyncSeekExt;

static RECEIVING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub async fn peer_statuses(state: &AppState) -> Result<Value> {
    let mut result = Vec::new();
    for machine in machines::list(state)? {
        let id = string(&machine, "id");
        let mut item = if machine["allowUpdates"] != true {
            json!({"machine":id,"available":false,"reason":"Enable updates on both machines."})
        } else if !["online", "version-mismatch"].contains(&string(&machine, "status")) {
            json!({"machine":id,"available":false,"reason":"Machine is offline."})
        } else {
            match machines::update_remote(state, id, "/api/peer/updates", None, 0).await {
                Ok(value) => {
                    let mut item = json!({"machine":id,"available":true});
                    if let Some(map) = value.as_object() {
                        for (key, value) in map {
                            if key != "fanOutAttempt" {
                                item[key] = value.clone();
                            }
                        }
                    }
                    item
                }
                Err(_) => {
                    json!({"machine":id,"available":false,"reason":"Receiving owner must allow updates and start the launcher."})
                }
            }
        };
        if let Some(attempt) = attempts::latest(state, id)? {
            item["fanOutAttempt"] = attempt;
        }
        result.push(item);
    }
    Ok(json!({"machines":result}))
}

pub async fn fan_out(state: &AppState, value: &Value) -> Result<Value> {
    command(value, &["id", "machines", "version"])?;
    let invalid = || error(400, "Select 1 to 16 paired machines.");
    let mut ids = value["machines"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 16)
        .ok_or_else(invalid)?
        .iter()
        .map(|id| {
            id.as_str()
                .filter(|id| crate::web::id(id).is_some())
                .ok_or_else(invalid)
        })
        .collect::<Result<Vec<_>>>()?;
    ids.sort_unstable();
    if ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(invalid());
    }
    let digest = json!({"version":value["version"],"machines":ids}).to_string();
    let id = string(value, "id");
    if let Some(saved) = prior(state, id, &digest)? {
        return Ok(saved);
    }
    let release = target(state, string(value, "version"))?;
    let uncertain = json!({"accepted":true,"machines":ids.iter().map(|machine|json!({"machine":machine,"status":"uncertain","reason":"Submission interrupted. Check the receiving machine before retrying."})).collect::<Vec<_>>()});
    if !attempts::record(state, id, &digest, &uncertain, &release, &ids)? {
        return prior(state, id, &digest)?.ok_or_else(Failure::storage);
    }
    // Keep the attempt and archive alive if the owner closes the HTTP request.
    tokio::spawn(run_fan_out(
        state.clone(),
        id.to_owned(),
        release,
        ids.into_iter().map(str::to_owned).collect(),
    ))
    .await
    .map_err(|_| Failure::storage())?
}

async fn run_fan_out(
    state: AppState,
    id: String,
    release: Value,
    ids: Vec<String>,
) -> Result<Value> {
    let root = state
        .config
        .update
        .options()
        .releases_dir
        .as_ref()
        .ok_or_else(Failure::storage)?;
    let archive = match archive::create(root, string(&release, "id")).await {
        Ok(archive) => archive,
        Err(failure) => {
            for machine in ids {
                attempts::finish(&state, &id, &machine, Some(&failure))?;
            }
            return Err(failure);
        }
    };
    attempts::set_total(&state, &id, archive.size)?;
    let mut tasks = tokio::task::JoinSet::new();
    let mut ids = ids.into_iter();
    let mut result = Vec::new();
    loop {
        while tasks.len() < 4 {
            let Some(machine) = ids.next() else { break };
            let state = state.clone();
            let body = json!({"id":id,"version":release["version"],"target":release["id"],"sha256":archive.sha256});
            let id = id.clone();
            let bytes = archive.size;
            tasks.spawn(async move {
                let outcome = async {
                    attempts::start(&state, &id, &machine)?;
                    machines::update_remote(&state, &machine, "/api/peer/updates/apply", Some(&body), bytes).await
                }.await;
                attempts::finish(&state, &id, &machine, outcome.as_ref().err())?;
                Ok::<_, Failure>(match outcome {
                    Ok(value) => json!({"machine":machine,"status":"accepted","id":value["id"].as_str().unwrap_or("undefined")}),
                    Err(failure) => json!({"machine":machine,"status":"failed","reason":failure.message}),
                })
            });
        }
        match tasks.join_next().await {
            Some(item) => result.push(item.map_err(|_| Failure::storage())??),
            None => break,
        }
    }
    let result = json!({"accepted":true,"machines":result});
    state
        .database
        .lock()
        .map_err(|_| Failure::storage())?
        .connection
        .execute(
            "UPDATE update_commands SET result=? WHERE id=?",
            rusqlite::params![result.to_string(), id],
        )?;
    Ok(result)
}

async fn check_permission(state: &AppState, machine: &str, bearer: Option<&str>) -> Result<()> {
    if authorize(state, bearer).await? != machine {
        return Err(PeerError::PermissionRevoked.failure());
    }
    machines::ensure_updates_allowed(state, machine)
}

async fn peer_apply(
    state: &AppState,
    value: &Value,
    machine: &str,
    bearer: Option<&str>,
) -> Result<Value> {
    command(value, &["id", "version", "target", "sha256"])?;
    let target = string(value, "target");
    let expected = string(value, "sha256");
    if !archive::valid_hash(expected)
        || !release::id(target)
        || !target.starts_with(&format!("{}-", string(value, "version")))
    {
        return Err(error(400, "Invalid peer release."));
    }
    let options = state.config.update.options();
    let releases = options
        .releases_dir
        .as_ref()
        .ok_or_else(|| PeerError::LauncherUnavailable.failure())?;
    if status(state).await?["launcherAvailable"] != true {
        return Err(PeerError::LauncherUnavailable.failure());
    }
    let _receiving = RECEIVING
        .try_lock()
        .map_err(|_| error(409, "Another update is already running."))?;
    let hash = format!(
        "{:x}",
        Sha256::digest(format!("update:{machine}:{}", string(value, "id")).as_bytes())
    );
    let id = format!(
        "{}-{}-4{}-8{}-{}",
        &hash[..8],
        &hash[8..12],
        &hash[13..16],
        &hash[17..20],
        &hash[20..32]
    );
    if !releases.join(target).exists() {
        archive::receive(
            releases,
            target,
            expected,
            |offset| machines::download_release(state, machine, target, offset),
            || check_permission(state, machine, bearer),
        )
        .await?;
    }
    let release = release::verify(releases, target)
        .map_err(|_| PeerError::IntegrityMismatch.detail("Peer release manifest mismatch."))?;
    if release["version"] != value["version"] {
        return Err(PeerError::IntegrityMismatch.detail("Peer release version mismatch."));
    }
    check_permission(state, machine, bearer).await?;
    launcher(
        options,
        json!({"type":"apply","id":id,"target":release["id"],"version":release["version"]}),
    )
    .await
}

async fn authorize(state: &AppState, bearer: Option<&str>) -> Result<String> {
    machines::authorize_update(state, bearer)
        .await
        .map_err(|failure| {
            if [401, 403].contains(&failure.status) {
                PeerError::PermissionRevoked.failure()
            } else {
                failure
            }
        })
}

fn byte_range(value: &str, size: u64) -> Option<(u64, u64)> {
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    let number = |value: &str| {
        value
            .bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| value.parse::<u64>().ok())
            .flatten()
    };
    let last = size.checked_sub(1)?;
    if start.is_empty() {
        let suffix = number(end)?;
        return (suffix > 0).then(|| (size.saturating_sub(suffix), last));
    }
    let start = number(start)?;
    let end = if end.is_empty() {
        last
    } else {
        number(end)?.min(last)
    };
    (start <= end).then_some((start, end))
}

async fn serve_release(
    state: &AppState,
    headers: &HeaderMap,
    machine: String,
    id: &str,
) -> Result<Response> {
    let root = state
        .config
        .update
        .options()
        .releases_dir
        .as_ref()
        .ok_or_else(|| error(404, "Release feed is unavailable."))?;
    let archive = archive::create(root, id).await?;
    authorize(state, crate::text_header(headers, "authorization")).await?;
    let size = archive.size;
    let mut response = Response::builder()
        .header(header::CONTENT_TYPE, "application/gzip")
        .header(header::ACCEPT_RANGES, "bytes")
        .header("x-briefsip-sha256", &archive.sha256);
    let (start, end) = if let Some(value) = headers.get(header::RANGE) {
        let Some((start, end)) = value
            .to_str()
            .ok()
            .and_then(|value| byte_range(value, size))
        else {
            return response
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                .body(Body::empty())
                .map_err(|_| Failure::storage());
        };
        response = response
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
        (start, end)
    } else {
        (0, size - 1)
    };
    let length = end - start + 1;
    let mut file = tokio::fs::File::open(&archive.file)
        .await
        .map_err(|_| error(500, "Could not read release."))?;
    file.seek(SeekFrom::Start(start))
        .await
        .map_err(|_| error(500, "Could not seek release."))?;
    let mut file = file.take(length);
    let attempt = attempts::active(state, &machine, id)?;
    if let Some(attempt) = &attempt {
        attempts::progress(state, attempt, &machine, start)?;
    }
    let state = state.clone();
    let stream = async_stream::stream! {
        let _archive = archive;
        let mut offset = start;
        let mut next_progress = Instant::now();
        while offset <= end {
            let mut bytes = vec![0; 65536];
            let n = match file.read(&mut bytes).await {
                Ok(0) => {
                    yield Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof));
                    break;
                }
                Ok(n) => n,
                Err(failure) => {
                    yield Err(failure);
                    break;
                }
            };
            offset += n as u64;
            bytes.truncate(n);
            if let Some(attempt) = &attempt {
                if offset > end || Instant::now() >= next_progress {
                    if let Err(failure) = attempts::progress(&state, attempt, &machine, offset) {
                        eprintln!("peer release progress machine={machine} code={}", failure.code);
                    }
                    next_progress = Instant::now() + Duration::from_secs(1);
                }
            }
            yield Ok(Bytes::from(bytes));
        }
    };
    response
        .header(header::CONTENT_LENGTH, length)
        .body(Body::from_stream(stream))
        .map_err(|_| Failure::storage())
}

pub async fn peer(state: &AppState, request: Request) -> Result<Response> {
    if request.headers().contains_key("origin")
        || request.headers().contains_key("sec-fetch-site")
        || request.uri().query().is_some()
    {
        return Err(error(403, "Use the authenticated peer channel."));
    }
    let is_apply =
        request.uri().path() == "/api/peer/updates/apply" && request.method() == Method::POST;
    let result = peer_request(state, request).await;
    Ok(match result {
        Ok(response) => response,
        Err(failure) => {
            if is_apply {
                eprintln!(
                    "peer release apply code={} message={:?}",
                    failure.code, failure.message
                );
            }
            json_response(
                failure.status,
                json!({"error":failure.message,"code":failure.code}),
            )
        }
    })
}

async fn peer_request(state: &AppState, request: Request) -> Result<Response> {
    let bearer = crate::text_header(request.headers(), "authorization");
    let machine = authorize(state, bearer).await?;
    let path = request.uri().path();
    if path == "/api/peer/updates" && request.method() == Method::GET {
        return Ok(json_response(200, status(state).await?));
    }
    if path == "/api/peer/updates/apply" && request.method() == Method::POST {
        if crate::text_header(request.headers(), "content-type").and_then(|v| v.split(';').next())
            != Some("application/json")
        {
            return Err(error(415, "Use Content-Type application/json."));
        }
        let bearer = bearer.map(str::to_owned);
        let bytes = axum::body::to_bytes(request.into_body(), 8192)
            .await
            .map_err(|_| error(400, "Invalid update request."))?;
        let value =
            serde_json::from_slice(&bytes).map_err(|_| error(400, "Invalid update request."))?;
        let result = peer_apply(state, &value, &machine, bearer.as_deref()).await;
        if let Err(failure) = &result {
            eprintln!(
                "peer release apply machine={machine} release={:?} code={} message={:?}",
                string(&value, "target"),
                failure.code,
                failure.message
            );
        }
        return Ok(match result {
            Ok(value) => json_response(202, value),
            Err(failure) => json_response(
                failure.status,
                json!({"error":failure.message,"code":failure.code}),
            ),
        });
    }
    if let Some(id) = path
        .strip_prefix("/api/updates/releases/")
        .filter(|_| request.method() == Method::GET)
    {
        return serve_release(state, request.headers(), machine, id).await;
    }
    Err(error(405, "Method not allowed."))
}
