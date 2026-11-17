#![forbid(unsafe_code)]
mod auth;
mod computer;
mod config;
mod data;
mod db;
mod events;
mod files;
mod updates;
mod web;

use axum::{
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use config::Config;
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::net::TcpListener;
use web::Failure;

const POLICY: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self' https: http:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

#[derive(Clone)]
pub(crate) struct AppState {
    database: Arc<Mutex<db::Database>>,
    config: Arc<Config>,
    origin: String,
    auth: Option<auth::Auth>,
    events: events::Hub,
    computer: Arc<computer::Manager>,
    pub(crate) trial_pending: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

fn json_response(status: u16, value: Value) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        value.to_string(),
    )
        .into_response()
}
fn local_error(status: u16, message: &str) -> Response {
    json_response(status, json!({"error":message}))
}
fn security_headers(response: &mut Response) {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    if !response
        .headers()
        .contains_key(header::CONTENT_SECURITY_POLICY)
    {
        response.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(POLICY),
        );
    }
}
fn text_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}
fn allowed(state: &AppState, value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        value == state.origin
            || state
                .config
                .allowed_origins
                .iter()
                .any(|item| item == value)
    })
}

async fn dispatch(State(state): State<AppState>, request: Request) -> Response {
    if state.auth.is_some() {
        return canonical(&state, request).await;
    }
    let host = text_header(request.headers(), "host").unwrap_or("");
    if !updates::transport(request.uri().path())
        && format!("http://{host}") != state.origin
        && !state
            .config
            .allowed_origins
            .contains(&format!("https://{host}"))
        || text_header(request.headers(), "sec-fetch-site") == Some("cross-site")
    {
        let mut response = local_error(
            403,
            "Access is only allowed through the local Briefsip address.",
        );
        security_headers(&mut response);
        return response;
    }
    let mut response = local(&state, request)
        .await
        .unwrap_or_else(|error| local_error(error.status, &error.message));
    let cache = response.headers().get(header::CACHE_CONTROL).cloned();
    security_headers(&mut response);
    if let Some(cache) = cache {
        response.headers_mut().insert(header::CACHE_CONTROL, cache);
    }
    response
}
async fn local(state: &AppState, request: Request) -> Result<Response, Failure> {
    let path = request.uri().path();
    if updates::pending(state) && !["/api/environment", "/api/updates"].contains(&path) {
        return Ok(local_error(
            503,
            "Update is being verified. Retry after restart.",
        ));
    }
    if text_header(request.headers(), "authorization")
        .is_some_and(|value| value.starts_with("Bearer bsi_"))
    {
        return Ok(local_error(401, "Unauthorized request."));
    }
    if let Some(scope) = events::scope(path) {
        if request.headers().contains_key("authorization")
            || request.headers().contains_key("origin")
                && !allowed(state, text_header(request.headers(), "origin"))
        {
            return Ok(local_error(
                403,
                "Streaming requires the local owner in Briefsip.",
            ));
        }
        if request.method() != Method::GET {
            return Ok(local_error(405, "Streaming requires GET."));
        }
        if request.uri().query().is_some() && request.uri().path() != "/api/sync" {
            return Ok(local_error(
                400,
                "Streaming does not accept query parameters.",
            ));
        }
        return state.events.response(scope, &state.database);
    }
    if updates::handles(path) {
        return updates::local(state, request).await;
    }
    if data::handles(path) {
        return data::local(state, request).await;
    }
    if request.method() == Method::GET && path != "/api" && !path.starts_with("/api/") {
        return static_ui(state, path).await;
    }
    Ok(local_error(404, "Route not found."))
}
async fn static_ui(state: &AppState, path: &str) -> Result<Response, Failure> {
    let spa = !path.starts_with("/assets/");
    let file = state.config.dist.join(if spa {
        "index.html"
    } else {
        path.trim_start_matches('/')
    });
    if !spa && path.split('/').any(|part| part == "..") {
        return Ok(local_error(404, "Page not found."));
    }
    let mut bytes = match tokio::fs::read(&file).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return Ok(local_error(
                404,
                "App has not been built yet. Run npm run build.",
            ))
        }
    };
    let mut policy = None;
    if spa {
        let html = String::from_utf8_lossy(&bytes);
        let Some(end) = html.find("</head>") else {
            return Ok(local_error(500, "Built app is missing </head>."));
        };
        let mut random = [0; 16];
        getrandom::getrandom(&mut random).map_err(|_| Failure::storage())?;
        let nonce = STANDARD.encode(random);
        bytes = format!(
            "{}<meta name=\"csp-nonce\" content=\"{nonce}\">{}",
            &html[..end],
            &html[end..]
        )
        .into_bytes();
        policy = Some(POLICY.replace(
            "style-src 'self'",
            &format!("style-src 'self' 'nonce-{nonce}'"),
        ));
    }
    let mime = match file.extension().and_then(|value| value.to_str()) {
        Some("svg") => "image/svg+xml",
        Some("html") => "text/html",
        Some("js") => "text/javascript",
        Some("css") => "text/css",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    };
    let status = if spa && !navigation(path) {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::OK
    };
    let mut response = (status, [(header::CONTENT_TYPE, mime)], bytes).into_response();
    if let Some(policy) = policy {
        response.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_str(&policy).map_err(|_| Failure::storage())?,
        );
    }
    Ok(response)
}
fn navigation(path: &str) -> bool {
    fn id(value: &str) -> bool {
        value.len() == 36
            && value.bytes().enumerate().all(|(index, byte)| {
                if [8, 13, 18, 23].contains(&index) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            })
    }
    let parts: Vec<_> = path.split('/').skip(1).collect();
    match parts.as_slice() {
        [""] | ["routines"] | ["workflows"] => true,
        ["settings", section] => [
            "general",
            "appearance",
            "providers",
            "skills",
            "connected-apps",
            "hub",
            "mcp",
            "machines",
            "updates",
            "usage",
            "data",
            "backup",
            "mcp-server",
        ]
        .contains(section),
        ["agents" | "rooms" | "projects", value] => id(value),
        ["agents", agent, "conversations", thread] => id(agent) && id(thread),
        ["machines", machine, "agents", agent] => id(machine) && id(agent),
        _ => false,
    }
}
async fn canonical(state: &AppState, request: Request) -> Response {
    let mut request_id = String::new();
    let result = canonical_request(state, request, &mut request_id).await;
    let mut response = match result {
        Ok(value) => value,
        Err(error) => {
            let mut value = json!({"ok":false,"error":{"code":error.code,"message":error.message,"retryable":error.retryable,"requestId":request_id}});
            if let Some(details) = error.details {
                value["error"]["details"] = details;
            }
            let mut response = json_response(error.status, value);
            if error.status == 413 {
                response
                    .headers_mut()
                    .insert(header::CONNECTION, HeaderValue::from_static("close"));
            }
            response
        }
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
        .headers_mut()
        .insert("x-briefsip-protocol", HeaderValue::from_static("1"));
    if let Ok(value) = HeaderValue::from_str(&request_id) {
        response
            .headers_mut()
            .insert("x-briefsip-request-id", value);
    }
    response
}
async fn canonical_request(
    state: &AppState,
    request: Request,
    request_id: &mut String,
) -> Result<Response, Failure> {
    if text_header(request.headers(), "x-briefsip-protocol") != Some("1") {
        return Err(Failure::new(
            426,
            "unsupported_version",
            "Unsupported protocol version.",
        ));
    }
    let media = text_header(request.headers(), "content-type")
        .unwrap_or("")
        .to_ascii_lowercase();
    let valid_media = media == "application/json"
        || media.split_once(';').is_some_and(|(kind, parameter)| {
            kind.trim_end() == "application/json" && parameter.trim_start() == "charset=utf-8"
        });
    if !valid_media {
        return Err(Failure::new(
            415,
            "unsupported_media_type",
            "Use Content-Type application/json.",
        ));
    }
    let id = text_header(request.headers(), "x-briefsip-request-id")
        .and_then(web::id)
        .ok_or_else(|| Failure::new(400, "invalid_id", "requestId must be a UUID v4."))?;
    *request_id = id;
    if request.uri().query().is_some() && request.uri().path() != "/api/sync" {
        return Err(Failure::new(400, "invalid_route", "Invalid route."));
    }
    let _capacity = data::limits::reserve(request.uri().path(), request.method())?;
    let auth = state.auth.as_ref().ok_or_else(Failure::storage)?;
    let actor = auth
        .authenticate(
            &state.database,
            request.headers(),
            request.method(),
            state.config.now(),
        )
        .await?;
    let query = data::query(&request);
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    let body = if method != Method::GET && method != Method::HEAD {
        let bytes = axum::body::to_bytes(request.into_body(), 65536)
            .await
            .map_err(|_| {
                let mut error =
                    Failure::new(413, "payload_too_large", "Payload exceeds the limit.");
                error.details = Some(json!({"maxBytes":65536}));
                error
            })?;
        let value = web::parse_json(&bytes)?;
        let body_id = value.get("requestId").and_then(Value::as_str);
        if let Some(body_id) = body_id {
            let body_id = web::id(body_id)
                .ok_or_else(|| Failure::new(400, "invalid_id", "ID must be a UUID v4."))?;
            if body_id != request_id.as_str() {
                return Err(Failure::new(
                    400,
                    "request_id_mismatch",
                    "Header and body IDs must match.",
                ));
            }
        } else {
            return Err(Failure::new(
                400,
                "request_id_mismatch",
                "Header and body IDs must match.",
            ));
        }
        value
    } else {
        json!({})
    };
    if path == "/api/session" && method == Method::GET {
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        let active: i64 = guard.connection.query_row(
            "SELECT count(*) FROM authority_state WHERE id=1 AND serving_state='active'",
            [],
            |row| row.get(0),
        )?;
        if active == 0 {
            let mut error =
                Failure::new(503, "authority_unavailable", "Authority is not active yet.");
            error.retryable = true;
            return Err(error);
        }
        let mut query = guard.connection.prepare("SELECT p.id,p.name,p.private,p.revision,m.role,m.grant_revision FROM projects p JOIN project_members m ON m.project=p.id WHERE m.account=? AND m.deleted=0 AND p.deleted=0 ORDER BY p.id")?;
        let projects = query.query_map([&actor.account], |row| Ok(json!({"id":row.get::<_,String>(0)?,"name":row.get::<_,String>(1)?,"private":row.get::<_,i64>(2)?,"revision":row.get::<_,i64>(3)?,"role":row.get::<_,String>(4)?,"grant_revision":row.get::<_,i64>(5)?})))?.collect::<Result<Vec<_>,_>>()?;
        return Ok(json_response(
            200,
            json!({"ok":true,"data":{"accountId":actor.account,"projects":projects}}),
        ));
    }
    if let Some(response) = data::canonical(state, &path, &method, &body, &actor, &query).await? {
        return Ok(response);
    }
    if path == "/api/session/logout" && method == Method::POST {
        if let Some(key) = body
            .as_object()
            .and_then(|map| map.keys().find(|key| *key != "requestId"))
        {
            return Err(Failure::new(
                400,
                "unknown_field",
                format!("Field {key} is unknown."),
            ));
        }
        let value = auth
            .logout(&state.database, &actor, state.config.now())
            .await?;
        return Ok(json_response(200, json!({"ok":true,"data":value})));
    }
    Err(Failure::new(
        404,
        "resource_not_found",
        "Route is not available yet.",
    ))
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> db::Result<()> {
    let config = Config::read()?;
    let database = Arc::new(Mutex::new(db::open(
        &config.database,
        config.auth.is_some(),
        config.now(),
    )?));
    let events = events::Hub::new();
    {
        let guard = database.lock().map_err(|_| "Database lock poisoned")?;
        if config.auth.is_none() {
            files::init(&guard.connection)?;
            data::initialize(&guard)?;
            computer::initialize(&guard.connection)?;
            updates::initialize(&guard.connection)?;
        }
        events.watch(&guard.connection);
    }
    let listener = TcpListener::bind((config.host.as_str(), config.port)).await?;
    let origin = format!(
        "{}://{}",
        if config.tls.is_some() {
            "https"
        } else {
            "http"
        },
        listener.local_addr()?
    );
    let tls = config.tls.clone();
    let auth = config.auth.clone().map(auth::Auth::new).transpose()?;
    let trial_pending = updates::trial(&config);
    let computer = Arc::new(computer::Manager::new(&config)?);
    let state = AppState {
        database,
        config: Arc::new(config),
        origin: origin.clone(),
        auth,
        events,
        trial_pending,
        computer: computer.clone(),
    };
    let computer_maintenance = computer::maintenance(state.clone());
    let conversation_maintenance = data::maintenance(state.clone());
    let trial_watch = updates::watch_trial(state.clone());
    let maintenance_state = state.clone();
    let maintenance = tokio::spawn(async move {
        let mut timer = tokio::time::interval(Duration::from_secs(30));
        loop {
            timer.tick().await;
            if let Some(auth) = &maintenance_state.auth {
                let _ = auth.retry_logouts(&maintenance_state.database).await;
            }
        }
    });
    let shutdown_events = state.events.clone();
    let router = Router::new()
        .merge(computer::routes())
        .merge(files::routes())
        .merge(updates::routes())
        .route("/api/session", any(dispatch))
        .route("/api/session/logout", any(dispatch))
        .route("/api/agents", any(dispatch))
        .route("/api/agents/{id}/turns/stream", any(dispatch))
        .route("/api/threads/{id}/turns/stream", any(dispatch))
        .route("/api/channels/{id}/turns/stream", any(dispatch))
        .merge(data::routes())
        .fallback(dispatch)
        .with_state(state);
    println!("Briefsip: {origin}");
    let result = if let Some(tls) = tls {
        let configuration = axum_server::tls_rustls::RustlsConfig::from_pem(
            tls.cert.into_bytes(),
            tls.key.into_bytes(),
        )
        .await?;
        let handle = axum_server::Handle::new();
        let stop = handle.clone();
        let task = tokio::spawn(async move {
            shutdown().await;
            shutdown_events.close();
            stop.graceful_shutdown(Some(Duration::from_secs(5)));
        });
        let result = axum_server::from_tcp_rustls(listener.into_std()?, configuration)?
            .handle(handle)
            .serve(router.into_make_service())
            .await;
        task.abort();
        result
    } else {
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                shutdown().await;
                shutdown_events.close();
            })
            .await
    };
    maintenance.abort();
    conversation_maintenance.abort();
    for task in computer_maintenance {
        task.abort();
    }
    computer.close().await;
    trial_watch.abort();
    result?;
    Ok(())
}
async fn shutdown() {
    let interrupt = tokio::signal::ctrl_c();
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    tokio::select! { _ = interrupt => (), _ = terminate => () }
}

#[cfg(test)]
mod tests {
    use super::navigation;
    #[test]
    fn navigation_matches_node_paths() {
        for path in ["/", "/routines", "/workflows", "/settings/appearance", "/agents/00000000-0000-4000-8000-000000000000", "/agents/00000000-0000-4000-8000-000000000000/conversations/00000000-0000-4000-8000-000000000001"] { assert!(navigation(path), "{path}"); }
        for path in [
            "/settings/nope",
            "/agents/malformed",
            "/rooms/deleted",
            "/projects/deleted",
            "/nonsense/path",
            "/missing.txt",
        ] {
            assert!(!navigation(path), "{path}");
        }
    }
}
