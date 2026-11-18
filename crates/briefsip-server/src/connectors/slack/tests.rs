use super::*;
use crate::connectors::test_support::{self, body, response, Fixture};
use std::sync::{Arc, Mutex};

fn envelope(n: u32, text: &str) -> Value {
    json!({"type":"events_api","envelope_id":format!("envelope-{n}"),"payload":{
        "type":"event_callback","team_id":"TTEAM","api_app_id":"AAPP","event_id":format!("Ev{n}"),
        "authorizations":[{"team_id":"TTEAM","user_id":"UBOT","is_bot":true}],
        "event":{"type":"message","channel_type":"im","channel":"DCHAT","user":"UUSER","text":text,"ts":format!("1700000000.{n:06}")}
    }})
}

#[test]
fn slack_journal_deduplicates_events_and_fences_spoofed_roots() -> Result<()> {
    let mut options = test_support::options("slack");
    options.users = vec![json!("UUSER")];
    let db = test_support::journal(&options)?;
    let first = envelope(1, "Hello");
    assert_eq!(
        record(&db, &first, &options)?.as_deref(),
        Some("envelope-1")
    );
    record(&db, &first, &options)?;
    let mut second = envelope(2, "Continue");
    second["payload"]["event"]["thread_ts"] = first["payload"]["event"]["ts"].clone();
    record(&db, &second, &options)?;
    record(&db, &envelope(3, "Hello"), &options)?;
    let rows = all(&db, "SELECT * FROM slack_inbox ORDER BY event", [])?;
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["thread"], rows[1]["thread"]);
    assert_ne!(rows[0]["thread"], rows[2]["thread"]);
    for (path, value) in [
        ("/payload/team_id", json!("TOTHER")),
        ("/payload/api_app_id", json!("AOTHER")),
        ("/payload/authorizations", json!([])),
        ("/payload/event/user", json!("UOTHER")),
        ("/payload/event/user", json!("UBOT")),
        ("/payload/event/subtype", json!("message_changed")),
        ("/payload/event/bot_id", json!("BBOT")),
        ("/payload/event/channel_type", json!("channel")),
        ("/payload/event/channel", json!("CCHAN")),
    ] {
        let mut invalid = envelope(10, "Hello");
        let (parent, key) = path.rsplit_once('/').ok_or_else(Failure::storage)?;
        invalid.pointer_mut(parent).ok_or_else(Failure::storage)?[key] = value;
        record(&db, &invalid, &options)?;
    }
    assert_eq!(
        all(&db, "SELECT * FROM slack_inbox ORDER BY event", [])?,
        rows
    );
    assert_eq!(
        record(&db, &envelope(1, "Changed"), &options)
            .err()
            .map(|e| e.status),
        Some(409)
    );
    assert_eq!(
        bind(&db, "TOTHER", "AAPP", "UBOT", &options.agent)
            .err()
            .map(|error| error.status),
        Some(409)
    );
    bind(&db, "TTEAM", "AAPP", "UBOT", &options.agent)?;

    Ok(())
}

#[tokio::test]
async fn slack_legacy_workflow_text_stays_an_agent_prompt() -> Result<()> {
    let options = test_support::options("slack");
    let db = Connection::open_in_memory()?;
    db.execute_batch("CREATE TABLE slack_inbox(event TEXT PRIMARY KEY,channel TEXT NOT NULL,sender TEXT NOT NULL,ts TEXT NOT NULL,root TEXT NOT NULL,text TEXT NOT NULL,thread TEXT NOT NULL,turn TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'queued',checked INTEGER NOT NULL DEFAULT 0,UNIQUE(channel,ts)) STRICT; PRAGMA user_version=1;")?;
    db.execute("INSERT INTO slack_inbox VALUES ('EvOld','DCHAT','UUSER','1700000000.000001','1700000000.000001','!workflow old ordinary input',?,?,'queued',0)", [new_id(),new_id()])?;
    runner::initialize(&db, "slack")?;
    db.execute(
        "INSERT INTO slack_binding VALUES(1,'TTEAM','AAPP','UBOT',?)",
        [&options.agent],
    )?;
    let legacy = one(&db, "SELECT * FROM slack_inbox WHERE event='EvOld'", [])?
        .ok_or_else(Failure::storage)?;
    assert_eq!(legacy["kind"], "message");
    let local = Fixture::serve(|_| async { response(json!([])) }).await?;
    assert!(
        !super::super::workflow::handle(&db, "slack", "/unused", &legacy, &local.local()?).await?
    );
    let new = envelope(2, "!workflows next");
    record(&db, &new, &options)?;
    assert!(exists(
        &db,
        "SELECT 1 FROM slack_inbox WHERE event='Ev2' AND kind='workflow-command'",
        []
    )?);
    Ok(())
}

#[tokio::test]
async fn slack_approval_buttons_are_on_final_chunk_and_preserve_plain_text() -> Result<()> {
    let mut options = test_support::options("slack");
    let db = test_support::journal(&options)?;
    let run = new_id();
    let notice = new_id();
    let input = json!({"turn":run,"channel":"DCHAT","sender":"UUSER","root":"1700000000.000001"});
    db.execute(
        "INSERT INTO slack_workflows VALUES(?,?,?,?,?)",
        [&run, "DCHAT", "UUSER", "1700000000.000001", &new_id()],
    )?;
    db.execute("INSERT INTO slack_approvals VALUES(?,1,?)", [&run, &notice])?;
    let tail = "<@UUSER> & <script> &lt;literal&gt;";
    finish(
        &db,
        &input,
        &format!("{}{tail}", "x".repeat(4100)),
        Some(&notice),
    )?;

    let sent = Arc::new(Mutex::new(vec![]));
    let capture = sent.clone();
    let fixture = Fixture::serve(move |req: Request| {
        let capture = capture.clone();
        async move {
            if req.uri().path() != "/api/chat.postMessage" {
                return response(json!([]));
            }
            let body = body(req).await;
            let mut sent = capture.lock().unwrap_or_else(|e| e.into_inner());
            sent.push(body);
            response(
                json!({"ok":true,"channel":"DCHAT","ts":format!("1700000001.{:06}",sent.len())}),
            )
        }
    })
    .await?;
    options.origin = Some(fixture.origin.clone());
    let row = one(&db, "SELECT * FROM slack_outbox WHERE id=?", [&notice])?
        .ok_or_else(Failure::storage)?;
    deliver(&db, &fixture.local()?, &Api::new(&options)?, "/local", &row).await?;
    let sent = sent.lock().map_err(|_| Failure::storage())?;
    assert_eq!(sent.len(), 2);
    assert!(sent[0].get("blocks").is_none());
    let blocks = sent[1]["blocks"].as_array().ok_or_else(Failure::storage)?;
    assert_eq!(
        blocks.last().ok_or_else(Failure::storage)?["type"],
        "actions"
    );
    let plain = &blocks[..blocks.len() - 1];
    assert!(plain.iter().all(|b| b["text"]["type"] == "plain_text"
        && string(&b["text"], "text").encode_utf16().count() <= 2000));
    assert_eq!(
        plain
            .iter()
            .map(|b| string(&b["text"], "text"))
            .collect::<String>(),
        format!("{}{tail}", "x".repeat(100))
    );
    Ok(())
}

#[tokio::test]
async fn slack_file_urls_reject_other_hosts_and_downloads_never_follow_redirects() -> Result<()> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let count = Arc::new(AtomicUsize::new(0));
    let capture = count.clone();
    let fixture = Fixture::serve(move |req: Request| {
        let capture = capture.clone();
        async move {
            assert_eq!(
                req.headers()["Authorization"].to_str().ok(),
                Some(format!("Bearer xoxb-{}", "b".repeat(24)).as_str())
            );
            capture.fetch_add(1, Ordering::Relaxed);
            axum::http::Response::builder()
                .status(302)
                .header("location", "/should-not-receive-token")
                .body(axum::body::Body::empty())
                .unwrap_or_else(|_| response(Value::Null))
        }
    })
    .await?;
    let mut options = test_support::options("slack");
    options.origin = Some(fixture.origin.clone());
    let api = Api::new(&options)?;
    for invalid in [
        "https://files.slack.com.example.com/upload",
        "http://localhost:1234/private",
    ] {
        assert!(api.file_url(invalid).is_err());
    }
    assert!(api
        .download(&format!("{}/redirect", fixture.origin))
        .await
        .is_err());
    assert_eq!(count.load(Ordering::Relaxed), 1);
    Ok(())
}

#[tokio::test]
async fn slack_uncertain_text_delivery_preserves_confirmed_parts_across_restart() -> Result<()> {
    let mut options = test_support::options("slack");
    let db = test_support::journal(&options)?;
    record(&db, &envelope(1, "Hello"), &options)?;
    let row = one(&db, "SELECT * FROM slack_inbox", [])?.ok_or_else(Failure::storage)?;
    let id = string(&row, "turn");
    finish(&db, &row, &"<@UOTHER>".repeat(700), None)?;
    let posts = Arc::new(Mutex::new(vec![]));
    let captured = posts.clone();
    let remote = Fixture::serve(move |req: Request| {
        let captured = captured.clone();
        async move {
            let post = body(req).await;
            let mut posts = captured.lock().unwrap_or_else(|e| e.into_inner());
            posts.push(post);
            if posts.len() == 2 {
                return response(json!({"ok":false,"error":"internal_error"}));
            }
            response(json!({"ok":true,"channel":"DCHAT","ts":"1700000001.000001"}))
        }
    })
    .await?;
    options.origin = Some(remote.origin.clone());
    let api = Api::new(&options)?;
    let local = Fixture::serve(|_| async { response(json!([])) }).await?;
    let outbox =
        || one(&db, "SELECT * FROM slack_outbox WHERE id=?", [id])?.ok_or_else(Failure::storage);
    deliver(&db, &local.local()?, &api, "/local", &outbox()?).await?;
    {
        let posts = posts.lock().map_err(|_| Failure::storage())?;
        assert_eq!(posts.len(), 2);
        assert!(string(&posts[0], "text").starts_with("&lt;"));
        assert_eq!(posts[0]["mrkdwn"], false);
        assert_eq!(posts[0]["reply_broadcast"], false);
        assert_eq!(posts[0]["thread_ts"], row["root"]);
        assert!(posts
            .iter()
            .all(|post| string(post, "text").encode_utf16().count() <= 4000));
    }
    assert_eq!(outbox()?["status"], "uncertain");
    assert_eq!(outbox()?["part"], 1);
    assert_eq!(
        crate::data::json(&outbox()?["timestamps"])?,
        json!(["1700000001.000001"])
    );
    runner::initialize(&db, "slack")?;
    assert!(!exists(
        &db,
        "SELECT 1 FROM slack_outbox WHERE status='queued'",
        []
    )?);
    work(&db, &options, &local.local()?, &api).await?;
    assert_eq!(posts.lock().map_err(|_| Failure::storage())?.len(), 2);
    db.execute("UPDATE slack_outbox SET status='queued'", [])?;
    let revoked = Fixture::serve(|_| async {
        axum::response::IntoResponse::into_response(axum::http::StatusCode::FORBIDDEN)
    })
    .await?;
    assert_eq!(
        deliver(&db, &revoked.local()?, &api, "/local", &outbox()?)
            .await
            .err()
            .map(|e| e.status),
        Some(403)
    );
    assert_eq!(posts.lock().map_err(|_| Failure::storage())?.len(), 2);
    db.execute("UPDATE slack_outbox SET status='sending'", [])?;
    runner::initialize(&db, "slack")?;
    assert_eq!(outbox()?["status"], "uncertain");
    Ok(())
}

async fn slack_upload_recovers_failed_stage(failed_stage: &str, stage: i64) -> Result<()> {
    let mut options = test_support::options("slack");
    let db = test_support::journal(&options)?;
    let id = new_id();
    db.execute(
        "INSERT INTO slack_documents(id,turn,thread,file,name,bytes) VALUES (?,?,?,?,?,?)",
        params![
            id,
            new_id(),
            new_id(),
            new_id(),
            "file.txt",
            b"exact".as_slice()
        ],
    )?;
    db.execute("INSERT INTO slack_outbox(id,channel,sender,root,text) VALUES(?,'DCHAT','UUSER','1700000000.000001','File')",[&id])?;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let capture = seen.clone();
    let fail = failed_stage.to_owned();
    let remote = Fixture::serve(move |req: Request| {
        let capture = capture.clone();
        let fail = fail.clone();
        async move {
            let path = req.uri().path();
            let stage = if path.ends_with("/upload") {
                "upload"
            } else if path.ends_with("getUploadURLExternal") {
                "allocate"
            } else {
                "complete"
            };
            let host = req
                .headers()
                .get("host")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_owned();
            if stage == "upload" {
                assert!(req.headers().get("Authorization").is_none());
                let raw = axum::body::to_bytes(req.into_body(), 1024).await;
                assert_eq!(raw.as_deref().ok(), Some(b"exact".as_slice()));
            }
            let mut seen = capture.lock().unwrap_or_else(|e| e.into_inner());
            let fail = stage == fail && !seen.contains(&stage);
            seen.push(stage);
            if fail {
                return axum::response::IntoResponse::into_response(
                    axum::http::StatusCode::BAD_GATEWAY,
                );
            }
            if stage == "upload" {
                return axum::response::IntoResponse::into_response(axum::http::StatusCode::OK);
            }
            response(if stage == "allocate" {
                json!({"ok":true,"file_id":"FFILE","upload_url":format!("http://{host}/upload")})
            } else {
                json!({"ok":true,"files":[{"id":"FFILE"}]})
            })
        }
    })
    .await?;
    options.origin = Some(remote.origin.clone());
    let api = Api::new(&options)?;
    let local = Fixture::serve(|_| async { response(json!([])) }).await?;
    let local = local.local()?;
    work(&db, &options, &local, &api).await?;
    assert!(exists(
        &db,
        "SELECT 1 FROM slack_outbox WHERE status='uncertain'",
        []
    )?);
    assert!(exists(
        &db,
        "SELECT 1 FROM slack_documents WHERE stage=?",
        [stage]
    )?);
    let count = seen.lock().map_err(|_| Failure::storage())?.len();
    runner::initialize(&db, "slack")?;
    work(&db, &options, &local, &api).await?;
    assert_eq!(seen.lock().map_err(|_| Failure::storage())?.len(), count);
    runner::recover_reply(&db, "slack", &id, 0, "retry")?;
    work(&db, &options, &local, &api).await?;
    assert!(exists(
        &db,
        "SELECT 1 FROM slack_outbox WHERE status='sent'",
        []
    )?);
    assert!(exists(
        &db,
        "SELECT 1 FROM slack_documents WHERE stage=3",
        []
    )?);
    assert_eq!(
        seen.lock()
            .map_err(|_| Failure::storage())?
            .iter()
            .filter(|s| **s == "allocate")
            .count(),
        if failed_stage == "allocate" { 2 } else { 1 }
    );
    Ok(())
}

#[tokio::test]
async fn slack_lost_allocation_response_preserves_stage_until_explicit_retry() -> Result<()> {
    slack_upload_recovers_failed_stage("allocate", 0).await
}
#[tokio::test]
async fn slack_lost_upload_response_preserves_stage_and_exact_bytes_until_explicit_retry(
) -> Result<()> {
    slack_upload_recovers_failed_stage("upload", 1).await
}

#[tokio::test]
async fn slack_workspace_rate_limit_persists_across_reopen_and_keeps_confirmed_parts() -> Result<()>
{
    let mut options = test_support::options("slack");
    let db = test_support::journal(&options)?;
    let requests = Arc::new(Mutex::new(Vec::new()));
    let state = Arc::new(Mutex::new(("rate", "1")));
    let capture = requests.clone();
    let remote_state = state.clone();
    let fixture=Fixture::serve(move |req: Request|{
        let capture=capture.clone();
        let state=remote_state.clone();
        async move {
            let payload=body(req).await;
            let mut requests=capture.lock().unwrap_or_else(|e|e.into_inner());
            requests.push(payload);
            let mut state=state.lock().unwrap_or_else(|e|e.into_inner());
            match *state {
                ("rate",header) => axum::http::Response::builder().status(429).header("retry-after",header)
                    .body(axum::body::Body::empty()).unwrap_or_else(|_|response(Value::Null)),
                ("lost",_) => response(Value::Null),
                ("one",_) => {
                    *state=("rate","1");
                    response(json!({"ok":true,"channel":"DCHAT","ts":format!("1700000001.{:06}",requests.len())}))
                }
                _=>response(json!({"ok":true,"channel":"DCHAT","ts":format!("1700000001.{:06}",requests.len())})),
            }
        }
    }).await?;
    options.origin = Some(fixture.origin.clone());
    let api = Api::new(&options)?;
    let allowed = Fixture::serve(|_| async { response(json!([])) }).await?;
    let denied = Fixture::serve(|_| async {
        axum::response::IntoResponse::into_response(axum::http::StatusCode::FORBIDDEN)
    })
    .await?;
    let local = allowed.local()?;
    let add = |text: &str| -> Result<String> {
        let id = new_id();
        db.execute("INSERT INTO slack_outbox(id,channel,sender,root,text) VALUES(?,'DCHAT','UUSER','1700000000.000001',?)",[&id,text])?;
        Ok(id)
    };
    let row = |id: &str| {
        one(&db, "SELECT * FROM slack_outbox WHERE id=?", [id])?.ok_or_else(Failure::storage)
    };
    let count = || {
        requests
            .lock()
            .map(|r| r.len())
            .map_err(|_| Failure::storage())
    };
    let mode = |mode| {
        state
            .lock()
            .map(|mut s| *s = mode)
            .map_err(|_| Failure::storage())
    };
    let first = add("Reply")?;
    let second = add("Reply")?;
    deliver(&db, &local, &api, "/local", &row(&first)?).await?;
    assert_eq!(count()?, 1);
    assert_eq!(row(&first)?["status"], "queued");
    let until = one(
        &db,
        "SELECT until FROM slack_delivery_cooldown WHERE id=1",
        [],
    )?
    .ok_or_else(Failure::storage)?;
    assert!(number(&until, "until") > crate::config::now());
    runner::initialize(&db, "slack")?;
    deliver(&db, &local, &api, "/local", &row(&second)?).await?;
    assert_eq!(count()?, 1);
    db.execute("UPDATE slack_delivery_cooldown SET until=0", [])?;
    mode(("ok", "1"))?;
    assert_eq!(
        deliver(&db, &denied.local()?, &api, "/local", &row(&first)?)
            .await
            .err()
            .map(|e| e.status),
        Some(403)
    );
    assert_eq!(count()?, 1);
    deliver(&db, &local, &api, "/local", &row(&first)?).await?;
    assert_eq!(count()?, 2);
    assert_eq!(row(&first)?["status"], "sent");
    mode(("lost", "1"))?;
    deliver(&db, &local, &api, "/local", &row(&second)?).await?;
    runner::initialize(&db, "slack")?;
    work(&db, &options, &local, &api).await?;
    assert_eq!(count()?, 3);
    assert_eq!(row(&second)?["status"], "uncertain");
    for header in ["0", "-1", "1.5", "bad", "999999999999999999999"] {
        mode(("rate", header))?;
        let id = add("Rejected")?;
        deliver(&db, &local, &api, "/local", &row(&id)?).await?;
        assert_eq!(row(&id)?["status"], "failed");
    }
    let multipart = add(&"x".repeat(5000))?;
    mode(("one", "1"))?;
    deliver(&db, &local, &api, "/local", &row(&multipart)?).await?;
    let partial = row(&multipart)?;
    assert_eq!(partial["status"], "queued");
    assert_eq!(partial["part"], 1);
    assert_eq!(
        crate::data::json(&partial["timestamps"])?
            .as_array()
            .map(Vec::len),
        Some(1)
    );
    db.execute("UPDATE slack_delivery_cooldown SET until=0", [])?;
    mode(("ok", "1"))?;
    let before = count()?;
    deliver(&db, &local, &api, "/local", &row(&multipart)?).await?;
    assert_eq!(count()?, before + 1);
    assert_eq!(row(&multipart)?["part"], 2);
    assert_eq!(
        requests
            .lock()
            .map_err(|_| Failure::storage())?
            .last()
            .ok_or_else(Failure::storage)?["text"],
        "x".repeat(1000)
    );
    Ok(())
}

#[tokio::test]
async fn slack_session_cooldown_is_durable_and_isolated_by_method() -> Result<()> {
    let mut options = test_support::options("slack");
    let db = test_support::journal(&options)?;
    let calls = Arc::new(Mutex::new(Vec::new()));
    let capture = calls.clone();
    let remote = Fixture::serve(move |req: Request| {
        let capture = capture.clone();
        async move {
            let path = req.uri().path().to_owned();
            let mut calls = capture.lock().unwrap_or_else(|e| e.into_inner());
            calls.push((path.clone(), crate::config::now()));
            match (calls.len(), path.as_str()) {
                (1, "/api/auth.test") => axum::http::Response::builder()
                    .status(429)
                    .header("retry-after", "1")
                    .body(axum::body::Body::empty())
                    .unwrap_or_else(|_| response(Value::Null)),
                (4, "/api/auth.test") => response(Value::Null),
                _ => response(json!({"ok":true})),
            }
        }
    })
    .await?;
    options.origin = Some(remote.origin.clone());
    let api = Api::new(&options)?;
    assert!(
        tokio::time::timeout(Duration::from_millis(250), session(&db, &api, "auth.test"))
            .await
            .is_err()
    );
    let until: i64 = db.query_row(
        "SELECT until FROM slack_session_cooldowns WHERE method='auth.test'",
        [],
        |row| row.get(0),
    )?;
    runner::initialize(&db, "slack")?;
    session(&db, &api, "apps.connections.open").await?;
    session(&db, &api, "auth.test").await?;
    assert_eq!(
        session(&db, &api, "auth.test")
            .await
            .err()
            .map(|e| e.status),
        Some(502)
    );
    let calls = calls.lock().map_err(|_| Failure::storage())?;
    assert_eq!(calls.len(), 4);
    assert_eq!(calls[1].0, "/api/apps.connections.open");
    assert!(calls[1].1 < until);
    assert!(calls[2].1 >= until);
    Ok(())
}

#[tokio::test]
async fn slack_preserves_legacy_question_notice_and_snapshots_choices_without_redelivery(
) -> Result<()> {
    let mut options = test_support::options("slack");
    let db = test_support::journal(&options)?;
    record(&db, &envelope(1, "Hello"), &options)?;
    db.execute("UPDATE slack_inbox SET status='running'", [])?;
    let row = one(&db, "SELECT * FROM slack_inbox", [])?.ok_or_else(Failure::storage)?;
    let question = new_id();
    db.execute(
        "INSERT INTO slack_questions VALUES(?,?,?,?,?,?)",
        [
            &question,
            string(&row, "channel"),
            string(&row, "sender"),
            string(&row, "root"),
            string(&row, "thread"),
            string(&row, "turn"),
        ],
    )?;
    finish(&db, &row, "Proceed?\nChoose: Yes | No", Some(&question))?;
    db.execute(
        "UPDATE slack_outbox SET status='sent',part=1,timestamps='[\"1700000001.000001\"]'",
        [],
    )?;
    let fixture=Fixture::serve(move |req: Request|{
        let question=question.clone();
        async move {
            assert_eq!(req.method(),Method::GET);
            let turn=req.uri().query().and_then(|q|q.strip_prefix("focus="));
            response(json!([{"id":turn,"status":"waiting","questions":[{"id":question,"prompt":"Proceed?","choices":["Yes","No"],"answer":null}]}]))
        }
    }).await?;
    options.origin = Some(fixture.origin.clone());
    work(&db, &options, &fixture.local()?, &Api::new(&options)?).await?;
    let outbox = one(&db, "SELECT * FROM slack_outbox", [])?.ok_or_else(Failure::storage)?;
    assert_eq!(outbox["text"], "Proceed?\nChoose: Yes | No");
    assert_eq!(outbox["status"], "sent");
    let choices =
        one(&db, "SELECT choices FROM slack_question_choices", [])?.ok_or_else(Failure::storage)?;
    assert_eq!(
        crate::data::json(&choices["choices"])?,
        json!(["Yes", "No"])
    );
    Ok(())
}
