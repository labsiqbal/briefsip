use super::*;
use crate::computer::machines;
use axum::{
    body::{Body, Bytes},
    http::{header, HeaderValue},
    response::IntoResponse,
};
use sha2::{Digest, Sha256};

pub async fn peer_statuses(state: &AppState) -> Result<Value> {
    let mut result = Vec::new();
    for machine in machines::list(state)? {
        let id = string(&machine, "id");
        if machine["allowUpdates"] != true
            || !["online", "version-mismatch"].contains(&string(&machine, "status"))
        {
            result.push(json!({"machine":id,"available":false,"reason":if machine["allowUpdates"]==true{"Machine is offline."}else{"Enable updates on both machines."}}));
        } else {
            match machines::update_remote(state,id,"/api/peer/updates",None).await {
                Ok(value)=>{let mut item=json!({"machine":id,"available":true});if let Some(map)=value.as_object(){for(k,v)in map{item[k]=v.clone();}}result.push(item);}
                Err(_)=>result.push(json!({"machine":id,"available":false,"reason":"Receiving owner must allow updates and start the launcher."}))
            }
        }
    }
    Ok(json!({"machines":result}))
}
pub async fn fan_out(state: &AppState, value: &Value) -> Result<Value> {
    command(value, &["id", "machines", "version"])?;
    let ids = value["machines"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 16)
        .ok_or_else(|| error(400, "Select 1 to 16 paired machines."))?;
    let mut ids = ids
        .iter()
        .map(|id| {
            id.as_str()
                .filter(|id| crate::web::id(id).is_some())
                .ok_or_else(|| error(400, "Select 1 to 16 paired machines."))
        })
        .collect::<Result<Vec<_>>>()?;
    ids.sort_unstable();
    if ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(error(400, "Select 1 to 16 paired machines."));
    }
    let digest = json!({"version":value["version"],"machines":ids}).to_string();
    let id = string(value, "id");
    if let Some(saved) = prior(state, id, &digest)? {
        return Ok(saved);
    }
    let release = target(state, string(value, "version"))?;
    let uncertain = json!({"accepted":true,"machines":ids.iter().map(|machine|json!({"machine":machine,"status":"uncertain","reason":"Submission interrupted. Check the receiving machine before retrying."})).collect::<Vec<_>>()});
    save(state, id, &digest, &uncertain)?;
    let root = state
        .config
        .update
        .options()
        .releases_dir
        .as_ref()
        .ok_or_else(|| error(409, "Release feed is not configured."))?;
    let archive = archive::create(root, string(&release, "id")).await?;
    let mut tasks = tokio::task::JoinSet::new();
    let mut ids = ids.into_iter();
    let mut result = Vec::new();
    loop {
        while tasks.len() < 4 {
            let Some(machine) = ids.next() else { break };
            let machine = machine.to_owned();
            let state = state.clone();
            let body = json!({"id":id,"version":release["version"],"target":release["id"],"sha256":archive.sha256});
            tasks.spawn(async move{
                match machines::update_remote(&state,&machine,"/api/peer/updates/apply",Some(&body)).await{
                    Ok(value)=>json!({"machine":machine,"status":"accepted","id":value["id"].as_str().unwrap_or("undefined")}),
                    Err(failure)=>json!({"machine":machine,"status":"failed","reason":failure.message})
                }
            });
        }
        match tasks.join_next().await {
            Some(Ok(item)) => result.push(item),
            Some(Err(_)) => return Err(Failure::storage()),
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
async fn peer_apply(state: &AppState, value: &Value, machine: &str) -> Result<Value> {
    command(value, &["id", "version", "target", "sha256"])?;
    let target = string(value, "target");
    let expected = string(value, "sha256");
    if !value["target"].is_string()
        || !value["sha256"].is_string()
        || expected.len() != 64
        || !expected
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !target.starts_with(&format!("{}-", string(value, "version")))
    {
        return Err(error(400, "Invalid peer release."));
    }
    let options = state.config.update.options();
    if status(state).await?["launcherAvailable"] != true || options.releases_dir.is_none() {
        return Err(error(
            409,
            "Receiving machine is not running under the Briefsip launcher.",
        ));
    }
    if !release::id(target) {
        return Err(error(
            502,
            "Peer release download failed integrity, permission, time or size checks.",
        ));
    }
    let releases = options.releases_dir.as_ref().ok_or_else(Failure::storage)?;
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
        let response =
            machines::download_release(state, machine, &format!("/api/updates/releases/{target}"))
                .await?;
        if !response.status().is_success() {
            return Err(error(
                502,
                "Peer release download failed integrity, permission, time or size checks.",
            ));
        }
        archive::receive(response, releases, target, expected, || {
            machines::ensure_updates_allowed(state, machine)
        })
        .await
        .map_err(|_| {
            error(
                502,
                "Peer release download failed integrity, permission, time or size checks.",
            )
        })?;
    }
    let release = release::verify(releases, target)?;
    if release["version"] != value["version"] {
        return Err(error(409, "Peer release version mismatch."));
    }
    machines::ensure_updates_allowed(state, machine)?;
    launcher(
        options,
        json!({"type":"apply","id":id,"target":release["id"],"version":release["version"]}),
    )
    .await
}
pub async fn peer(state: &AppState, request: Request) -> Result<Response> {
    if request.headers().contains_key("origin")
        || request.headers().contains_key("sec-fetch-site")
        || request.uri().query().is_some()
    {
        return Err(error(403, "Use the authenticated peer channel."));
    }
    let machine = machines::authorize_update(
        state,
        crate::text_header(request.headers(), "authorization"),
    )
    .await?;
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
        let bytes = axum::body::to_bytes(request.into_body(), 8192)
            .await
            .map_err(|_| error(400, "Invalid update request."))?;
        let value =
            serde_json::from_slice(&bytes).map_err(|_| error(400, "Invalid update request."))?;
        return Ok(json_response(
            202,
            peer_apply(state, &value, &machine).await?,
        ));
    }
    if let Some(id) = path
        .strip_prefix("/api/updates/releases/")
        .filter(|_| request.method() == Method::GET)
    {
        let root = state
            .config
            .update
            .options()
            .releases_dir
            .as_ref()
            .ok_or_else(|| error(404, "Release feed is unavailable."))?;
        let archive = archive::create(root, id).await?;
        machines::authorize_update(
            state,
            crate::text_header(request.headers(), "authorization"),
        )
        .await?;
        let mut file = tokio::fs::File::open(&archive.file)
            .await
            .map_err(|_| error(500, "Could not read release."))?;
        let sha256 = archive.sha256.clone();
        let stream = async_stream::stream! {
            let _archive=archive;
            loop {
                let mut bytes=vec![0;65536];
                match file.read(&mut bytes).await {
                    Ok(0)=>break,
                    Ok(n)=>{bytes.truncate(n);yield Ok::<Bytes,std::io::Error>(Bytes::from(bytes));},
                    Err(error)=>{yield Err(error);break;}
                }
            }
        };
        let mut response = Body::from_stream(stream).into_response();
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/gzip"),
        );
        response.headers_mut().insert(
            "x-briefsip-sha256",
            HeaderValue::from_str(&sha256).map_err(|_| Failure::storage())?,
        );
        return Ok(response);
    }
    Err(error(405, "Method not allowed."))
}
