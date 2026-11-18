use super::{runner, *};
use axum::{body::Body, http::Response};
use std::future::Future;

pub(crate) fn options(platform: &str) -> runner::Options {
    runner::Options {
        platform: platform.into(),
        directory: std::path::PathBuf::new(),
        script_directory: std::path::PathBuf::new(),
        agent: runner::new_id(),
        token: Some(format!("123:{}", "x".repeat(24))),
        team: Some("TTEAM".into()),
        app: Some("AAPP".into()),
        bot_token: Some(format!("xoxb-{}", "b".repeat(24))),
        app_token: Some(format!("xapp-{}", "a".repeat(24))),
        users: if platform == "slack" {
            vec![json!("UUSER"), json!("UOTHER")]
        } else {
            vec![json!(4), json!(5)]
        },
        channels: vec![],
        origin: None,
    }
}

pub(crate) fn journal(options: &runner::Options) -> Result<Connection> {
    let db = Connection::open_in_memory()?;
    runner::initialize(&db, &options.platform)?;
    if options.platform == "slack" {
        db.execute(
            "INSERT INTO slack_binding VALUES(1,'TTEAM','AAPP','UBOT',?)",
            [&options.agent],
        )?;
    } else {
        db.execute(
            "INSERT INTO telegram_binding VALUES(1,123,?,0)",
            [&options.agent],
        )?;
    }
    Ok(db)
}

pub(crate) struct Fixture {
    pub(crate) origin: String,
    task: tokio::task::JoinHandle<()>,
}
impl Fixture {
    pub(crate) async fn serve<H, F>(handler: H) -> Result<Self>
    where
        H: Fn(Request) -> F + Clone + Send + Sync + 'static,
        F: Future<Output = Response<Body>> + Send + 'static,
    {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|_| Failure::storage())?;
        let origin = format!(
            "http://{}",
            listener.local_addr().map_err(|_| Failure::storage())?
        );
        let task = tokio::spawn(async move {
            let result = axum::serve(listener, Router::new().fallback(any(handler))).await;
            assert!(result.is_ok());
        });
        Ok(Self { origin, task })
    }

    pub(crate) fn local(&self) -> Result<runner::Local> {
        Ok(runner::Local {
            origin: self.origin.clone(),
            token: "fixture".into(),
            client: runner::http().map_err(|_| Failure::storage())?,
        })
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub(crate) fn response(value: Value) -> Response<Body> {
    axum::response::IntoResponse::into_response(axum::Json(value))
}

pub(crate) async fn body(request: Request) -> Value {
    let bytes = axum::body::to_bytes(request.into_body(), 2 * 1024 * 1024).await;
    bytes
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}
