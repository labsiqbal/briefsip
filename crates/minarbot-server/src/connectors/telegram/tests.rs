use super::*;
use crate::connectors::test_support::{self, body, response, Fixture};
use std::sync::{Arc, Mutex};

fn update(id: i64, chat: i64, text: &str) -> Value {
    json!({"update_id":id,"message":{"message_id":id+1,"chat":{"id":chat,"type":"private"},"from":{"id":chat,"is_bot":false},"text":text}})
}

#[test]
fn telegram_accepts_only_allowlisted_private_human_messages() {
    let mut options = test_support::options("telegram");
    options.users = vec![json!(4)];
    let accepted = update(1, 4, "Hello");
    assert_eq!(
        input(&accepted, &options),
        Some(json!({"update":1,"chat":4,"message":2,"text":"Hello","media":null}))
    );
    for (key, value) in [
        ("chat", json!({"id":4,"type":"group"})),
        ("from", json!({"id":5,"is_bot":false})),
        ("from", json!({"id":4,"is_bot":true})),
        ("text", json!("")),
    ] {
        let mut invalid = accepted.clone();
        invalid["message"][key] = value;
        assert!(input(&invalid, &options).is_none());
    }
    assert!(serde_json::from_str::<Value>(r#""\ud800""#).is_err());
    assert!(input(&update(1, 5, "Hello"), &options).is_none());
}

#[test]
fn telegram_chooses_largest_photo_and_treats_caption_as_text() -> Result<()> {
    let mut options = test_support::options("telegram");
    options.users = vec![json!(4)];
    let mut photo = update(1, 4, "");
    photo["message"]["caption"] = json!("/approve plain caption");
    photo["message"]["photo"] = json!([
        {"file_id":"large","file_size":200,"width":200,"height":100},
        {"file_id":"small","file_size":100,"width":20,"height":10}
    ]);
    let accepted = input(&photo, &options).ok_or_else(Failure::storage)?;
    assert_eq!(
        accepted["media"],
        json!({"id":"large","name":"telegram-photo.jpg","size":200})
    );
    assert_eq!(accepted["text"], "/approve plain caption");
    let mut invalid = photo.clone();
    invalid["message"]["caption"] = json!({});
    assert!(input(&invalid, &options).is_none());
    options.users = vec![json!(5)];
    assert!(input(&photo, &options).is_none());
    Ok(())
}

#[tokio::test]
async fn telegram_download_rejects_paths_outside_file_endpoint() -> Result<()> {
    let fixture = Fixture::serve(|_| async { panic!("Invalid path reached fixture") }).await?;
    let mut options = test_support::options("telegram");
    options.origin = Some(fixture.origin.clone());
    let api = Api::new(&options)?;
    for path in [
        "../secret",
        "/absolute",
        "https://other/file",
        "a/%2e%2e/x",
        "a/../x",
        "a?x",
        "a\\b",
        "",
    ] {
        assert_eq!(api.download(path).await.err().map(|e| e.status), Some(400));
    }
    Ok(())
}

#[test]
fn telegram_journal_commits_in_order_and_rolls_back_replay_conflicts() -> Result<()> {
    let mut options = test_support::options("telegram");
    options.users = vec![json!(4)];
    let db = test_support::journal(&options)?;
    assert_eq!(
        record(
            &db,
            &json!([
                update(2, 4, "Second"),
                update(1, 4, "First"),
                update(3, 5, "Foreign")
            ]),
            &options
        )?,
        4
    );
    let rows = all(&db, "SELECT * FROM telegram_inbox ORDER BY update_id", [])?;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["thread"], rows[1]["thread"]);
    assert_ne!(rows[0]["turn"], rows[1]["turn"]);
    runner::initialize(&db, "telegram")?;
    assert_eq!(
        record(
            &db,
            &json!([update(1, 4, "First"), update(2, 4, "Second")]),
            &options
        )?,
        4
    );
    assert_eq!(
        all(&db, "SELECT * FROM telegram_inbox ORDER BY update_id", [])?,
        rows
    );
    assert_eq!(
        record(
            &db,
            &json!([update(4, 4, "New"), update(4, 4, "Changed")]),
            &options
        )
        .err()
        .map(|e| e.status),
        Some(409)
    );
    assert_eq!(
        record(
            &db,
            &json!([update(5,4,"Valid"),{"update_id":-1}]),
            &options
        )
        .err()
        .map(|e| e.status),
        Some(400)
    );
    assert_eq!(
        all(&db, "SELECT * FROM telegram_inbox ORDER BY update_id", [])?,
        rows
    );
    assert!(exists(
        &db,
        "SELECT 1 FROM telegram_binding WHERE offset=4",
        []
    )?);
    bind(&db, 123, &options.agent)?;
    assert_eq!(
        bind(&db, 124, &options.agent)
            .err()
            .map(|error| error.status),
        Some(409)
    );
    assert_eq!(
        bind(&db, 123, &new_id()).err().map(|error| error.status),
        Some(409)
    );

    let mut media = update(4, 4, "");
    media["message"]["caption"] = json!("Read this");
    media["message"]["document"] =
        json!({"file_id":"original","file_name":"example.txt","file_size":3});
    assert_eq!(record(&db, &json!([media]), &options)?, 5);
    media["message"]["document"]["file_id"] = json!("changed");
    assert_eq!(
        record(&db, &json!([media]), &options)
            .err()
            .map(|error| error.message.as_str() == "Telegram attachment identity conflict"),
        Some(true)
    );

    Ok(())
}

#[test]
fn telegram_migrates_approval_selection_and_defaults_old_question_choices() -> Result<()> {
    let db = Connection::open_in_memory()?;
    db.execute_batch("CREATE TABLE telegram_callbacks(notice TEXT PRIMARY KEY,id TEXT NOT NULL UNIQUE,chat INTEGER NOT NULL,message INTEGER NOT NULL,accepted INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'queued') STRICT; CREATE TABLE telegram_questions(id TEXT PRIMARY KEY,turn TEXT NOT NULL,thread TEXT NOT NULL,chat INTEGER NOT NULL) STRICT;")?;
    db.execute(
        "INSERT INTO telegram_callbacks VALUES (?,?,4,100,1,'queued')",
        [new_id(), new_id()],
    )?;
    db.execute(
        "INSERT INTO telegram_questions VALUES (?,?,?,4)",
        [new_id(), new_id(), new_id()],
    )?;
    runner::initialize(&db, "telegram")?;
    runner::initialize(&db, "telegram")?;
    assert!(exists(
        &db,
        "SELECT 1 FROM telegram_callbacks WHERE selection=1 AND status='queued'",
        []
    )?);
    assert!(exists(
        &db,
        "SELECT 1 FROM telegram_questions WHERE choices='[]'",
        []
    )?);
    Ok(())
}

#[tokio::test]
async fn telegram_worker_rotates_waiting_tasks_and_never_submits_unsent_cancelled_tasks(
) -> Result<()> {
    let mut options = test_support::options("telegram");
    let db = test_support::journal(&options)?;
    let updates = (0..100).map(|id| update(id, 4, "Wait")).collect::<Vec<_>>();
    record(&db, &json!(updates), &options)?;
    record(&db, &json!([update(100, 4, "Wait")]), &options)?;
    db.execute("UPDATE telegram_inbox SET status='running'", [])?;
    let last: String = db.query_row(
        "SELECT turn FROM telegram_inbox WHERE update_id=100",
        [],
        |row| row.get(0),
    )?;
    record(&db, &json!([update(101, 5, "Never start")]), &options)?;
    let unsent: String = db.query_row(
        "SELECT turn FROM telegram_inbox WHERE update_id=101",
        [],
        |row| row.get(0),
    )?;
    record(
        &db,
        &json!([update(102, 5, &format!("/stop {unsent}"))]),
        &options,
    )?;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_fixture = seen.clone();
    let fixture = Fixture::serve(move |req: Request| {
        let seen = seen_fixture.clone();
        async move {
            if let Some(focus) = req.uri().query().and_then(|q| q.strip_prefix("focus=")) {
                seen.lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(focus.to_owned());
                response(json!([{"id":focus,"status":"queued","questions":[]}]))
            } else if req.uri().path().ends_with("/sendMessage") {
                let sent = body(req).await;
                response(
                    json!({"ok":true,"result":{"chat":{"id":sent["chat_id"]},"message_id":1000}}),
                )
            } else {
                assert_eq!(req.method(), Method::GET, "Worker submitted cancelled task");
                response(json!([]))
            }
        }
    })
    .await?;
    options.origin = Some(fixture.origin.clone());
    let api = Api::new(&options)?;
    let local = fixture.local()?;
    work(&db, &options, &local, &api).await?;
    work(&db, &options, &local, &api).await?;
    let seen = seen.lock().map_err(|_| Failure::storage())?;
    assert!(seen.contains(&last));
    assert!(!seen.contains(&unsent));
    assert!(exists(
        &db,
        "SELECT 1 FROM telegram_inbox WHERE update_id=101 AND status='cancelled'",
        []
    )?);
    Ok(())
}

#[tokio::test]
async fn telegram_binary_documents_require_exact_chat_confirmation() -> Result<()> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let mut options = test_support::options("telegram");
    let db = test_support::journal(&options)?;
    let id = new_id();
    let bytes = [0, 255, 128, 1];
    db.execute(
        "INSERT INTO telegram_documents VALUES (?,?,?,?,?,?)",
        params![
            id,
            new_id(),
            new_id(),
            new_id(),
            "binary.dat",
            bytes.as_slice()
        ],
    )?;
    queue(&db, &id, &json!({"chat":4,"message":1}), "File: binary.dat")?;
    let calls = Arc::new(AtomicUsize::new(0));
    let capture = calls.clone();
    let fixture = Fixture::serve(move |req: Request| {
        let capture = capture.clone();
        async move {
            if !req.uri().path().ends_with("/sendDocument") {
                return response(json!([]));
            }
            capture.fetch_add(1, Ordering::Relaxed);
            let raw = axum::body::to_bytes(req.into_body(), 4096)
                .await
                .unwrap_or_default();
            assert!(raw.windows(4).any(|chunk| chunk == bytes));
            response(json!({"ok":true,"result":{"chat":{"id":5},"message_id":1}}))
        }
    })
    .await?;
    options.origin = Some(fixture.origin.clone());
    let api = Api::new(&options)?;
    let local = fixture.local()?;
    work(&db, &options, &local, &api).await?;
    assert!(exists(
        &db,
        "SELECT 1 FROM telegram_outbox WHERE status='uncertain' AND part=0 AND message_ids='[]'",
        []
    )?);
    runner::initialize(&db, "telegram")?;
    work(&db, &options, &local, &api).await?;
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    Ok(())
}

#[tokio::test]
async fn telegram_long_and_whitespace_replies_finish_without_replay() -> Result<()> {
    let mut options = test_support::options("telegram");
    let db = test_support::journal(&options)?;
    record(
        &db,
        &json!([update(1, 4, "Reply"), update(2, 5, "Reply")]),
        &options,
    )?;
    let rows = all(&db, "SELECT * FROM telegram_inbox ORDER BY update_id", [])?;
    finish(&db, &rows[0], &"😀".repeat(32001))?;
    finish(&db, &rows[1], "   ")?;
    let posts = Arc::new(Mutex::new(Vec::new()));
    let capture = posts.clone();
    let fixture=Fixture::serve(move |req: Request|{
        let capture=capture.clone();
        async move {
            if !req.uri().path().ends_with("/sendMessage") { return response(json!([])); }
            let message=body(req).await;
            let mut posts=capture.lock().unwrap_or_else(|e|e.into_inner());
            posts.push(message.clone());
            response(json!({"ok":true,"result":{"chat":{"id":message["chat_id"]},"message_id":posts.len()}}))
        }
    }).await?;
    options.origin = Some(fixture.origin.clone());
    let api = Api::new(&options)?;
    let local = fixture.local()?;
    work(&db, &options, &local, &api).await?;
    let count = posts.lock().map_err(|_| Failure::storage())?.len();
    work(&db, &options, &local, &api).await?;
    let posts = posts.lock().map_err(|_| Failure::storage())?;
    assert_eq!(posts.len(), count);
    assert_eq!(
        all(&db, "SELECT * FROM telegram_inbox WHERE status='done'", [])?.len(),
        2
    );
    assert!(posts
        .iter()
        .all(|p| string(p, "text").encode_utf16().count() <= 4096));
    assert!(posts
        .iter()
        .any(|p| string(p, "text").contains("Reply truncated")));
    assert!(posts
        .iter()
        .any(|p| p["text"] == "Task completed without a text reply." && p["chat_id"] == 5));
    Ok(())
}

#[tokio::test]
async fn telegram_partial_delivery_keeps_surrogate_pairs_and_does_not_replay_uncertain_parts(
) -> Result<()> {
    let mut options = test_support::options("telegram");
    let db = test_support::journal(&options)?;
    let id = new_id();
    let target = json!({"chat":4,"message":2});
    let text = format!("{}😀tail", "a".repeat(4095));
    queue(&db, &id, &target, &text)?;
    queue(&db, &id, &target, &text)?;
    assert_eq!(
        queue(&db, &id, &json!({"chat":5,"message":2}), &text)
            .err()
            .map(|e| e.status),
        Some(409)
    );
    let calls = Arc::new(Mutex::new(vec![]));
    let capture = calls.clone();
    let fixture = Fixture::serve(move |req: Request| {
        let capture = capture.clone();
        async move {
            if !req.uri().path().ends_with("/sendMessage") {
                return response(json!([]));
            }
            let request = body(req).await;
            let mut calls = capture.lock().unwrap_or_else(|e| e.into_inner());
            calls.push(request);
            response(match calls.len() {
                1 => json!({"ok":true,"result":{"chat":{"id":4},"message_id":1}}),
                2 => Value::Null,
                _ => json!({"ok":false,"error_code":400,"description":"untrusted token detail"}),
            })
        }
    })
    .await?;
    options.origin = Some(fixture.origin.clone());
    let api = Api::new(&options)?;
    let local = fixture.local()?;
    work(&db, &options, &local, &api).await?;
    {
        let calls = calls.lock().map_err(|_| Failure::storage())?;
        assert_eq!(calls.len(), 2);
        assert_eq!(string(&calls[0], "text").encode_utf16().count(), 4095);
        assert_eq!(calls[1]["text"], "😀tail");
        assert_eq!(
            calls[0]["reply_parameters"],
            json!({"message_id":2,"allow_sending_without_reply":false})
        );
        assert!(calls[0].get("parse_mode").is_none());
    }
    assert!(exists(&db,"SELECT 1 FROM telegram_outbox WHERE id=? AND status='uncertain' AND part=1 AND message_ids='[1]'",[&id])?);
    runner::initialize(&db, "telegram")?;
    work(&db, &options, &local, &api).await?;
    assert_eq!(calls.lock().map_err(|_| Failure::storage())?.len(), 2);
    let rejected = new_id();
    queue(&db, &rejected, &target, "Rejected")?;
    work(&db, &options, &local, &api).await?;
    assert!(exists(&db,"SELECT 1 FROM telegram_outbox WHERE id=? AND status='failed' AND error='Telegram rejected request (400).'",[rejected])?);
    let interrupted = new_id();
    queue(&db, &interrupted, &target, "Interrupted")?;
    db.execute(
        "UPDATE telegram_outbox SET status='sending' WHERE id=?",
        [&interrupted],
    )?;
    runner::initialize(&db, "telegram")?;
    assert!(exists(
        &db,
        "SELECT 1 FROM telegram_outbox WHERE id=? AND status='uncertain'",
        [interrupted]
    )?);
    work(&db, &options, &local, &api).await?;
    assert_eq!(calls.lock().map_err(|_| Failure::storage())?.len(), 3);
    Ok(())
}

#[tokio::test]
async fn telegram_command_answer_is_scoped_and_retries_exact_identity() -> Result<()> {
    let mut options = test_support::options("telegram");
    let db = test_support::journal(&options)?;
    record(&db, &json!([update(1, 4, "Ask")]), &options)?;
    let original = one(&db, "SELECT * FROM telegram_inbox", [])?.ok_or_else(Failure::storage)?;
    let thread = string(&original, "thread");
    let turn = string(&original, "turn");
    let question = new_id();
    let answers = Arc::new(Mutex::new(Vec::new()));
    let sent = Arc::new(Mutex::new(Vec::new()));
    let captured_answers = answers.clone();
    let captured_sent = sent.clone();
    let question_id = question.clone();
    let fixture=Fixture::serve(move |req: Request|{
        let answers=captured_answers.clone();
        let sent=captured_sent.clone();
        let question=question_id.clone();
        async move{
            let path=req.uri().path().to_owned();
            if path.ends_with("/answer"){
                let answer=body(req).await;
                let mut answers=answers.lock().unwrap_or_else(|e|e.into_inner());
                answers.push((path,answer));
                if answers.len()==1 { return axum::response::IntoResponse::into_response(axum::http::StatusCode::BAD_GATEWAY); }
            } else if let Some(focus)=req.uri().query().and_then(|q|q.strip_prefix("focus=")){
                let answered=!answers.lock().unwrap_or_else(|e|e.into_inner()).is_empty();
                return response(json!([{"id":focus,"status":if answered{"done"}else{"waiting"},"reply":"Confirmed",
                    "questions":[{"id":question,"prompt":"Proceed?","choices":["Yes","No"],"answer":if answered{json!("Yes")}else{Value::Null}}]}]));
            } else if path.ends_with("/sendMessage"){
                let message=body(req).await;
                let mut sent=sent.lock().unwrap_or_else(|e|e.into_inner());
                sent.push(message.clone());
                return response(json!({"ok":true,"result":{"chat":{"id":message["chat_id"]},"message_id":sent.len()}}));
            }
            response(json!({}))
        }
    }).await?;
    options.origin = Some(fixture.origin.clone());
    let api = Api::new(&options)?;
    let local = fixture.local()?;
    work(&db, &options, &local, &api).await?;
    assert!(string(&sent.lock().map_err(|_| Failure::storage())?[0], "text").contains("/answer"));

    let answer = format!("/answer {question} Yes");
    record(&db, &json!([update(2, 5, &answer)]), &options)?;
    work(&db, &options, &local, &api).await?;
    assert_eq!(answers.lock().map_err(|_| Failure::storage())?.len(), 0);
    assert_eq!(
        sent.lock().map_err(|_| Failure::storage())?[1]["chat_id"],
        5
    );
    record(&db, &json!([update(3, 4, &answer)]), &options)?;
    assert_eq!(
        work(&db, &options, &local, &api)
            .await
            .err()
            .map(|e| e.status),
        Some(502)
    );
    runner::initialize(&db, "telegram")?;
    work(&db, &options, &local, &api).await?;
    let answers = answers.lock().map_err(|_| Failure::storage())?;
    assert_eq!(answers.len(), 2);
    assert_eq!(answers[0], answers[1]);
    assert!(answers[0].0.ends_with(&format!(
        "/threads/{thread}/turns/{turn}/questions/{question}/answer"
    )));
    assert!(sent
        .lock()
        .map_err(|_| Failure::storage())?
        .iter()
        .any(|m| m["text"] == "Confirmed" && m["chat_id"] == 4));
    Ok(())
}

#[tokio::test]
async fn telegram_stop_fences_other_chats_and_skips_unsent_cancelled_tasks() -> Result<()> {
    let mut options = test_support::options("telegram");
    let db = test_support::journal(&options)?;
    record(&db, &json!([update(1, 4, "Never start")]), &options)?;
    let turn: String = db.query_row("SELECT turn FROM telegram_inbox", [], |row| row.get(0))?;
    let stop = format!("/stop {turn}");
    record(
        &db,
        &json!([update(2, 5, &stop), update(3, 4, &stop)]),
        &options,
    )?;
    let sent = Arc::new(Mutex::new(Vec::new()));
    let capture = sent.clone();
    let fixture=Fixture::serve(move |req: Request|{
        let capture=capture.clone();
        async move {
            if req.uri().path().ends_with("/sendMessage") {
                let message=body(req).await;
                let mut sent=capture.lock().unwrap_or_else(|e|e.into_inner());
                sent.push(message.clone());
                return response(json!({"ok":true,"result":{"chat":{"id":message["chat_id"]},"message_id":sent.len()}}));
            }
            assert_eq!(req.method(),Method::GET,"Cancelled task must never be submitted");
            response(json!([]))
        }
    }).await?;
    options.origin = Some(fixture.origin.clone());
    work(&db, &options, &fixture.local()?, &Api::new(&options)?).await?;
    assert!(exists(
        &db,
        "SELECT 1 FROM telegram_inbox WHERE turn=? AND status='cancelled'",
        [turn]
    )?);
    let sent = sent.lock().map_err(|_| Failure::storage())?;
    assert!(sent
        .iter()
        .any(|m| m["chat_id"] == 5 && string(m, "text").contains("not found")));
    assert!(sent
        .iter()
        .any(|m| m["chat_id"] == 4 && string(m, "text").contains("before sending")));
    Ok(())
}
