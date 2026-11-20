use super::runner::{self, new_id, number, pattern, Local, Options};
use super::*;
use std::time::Duration;

struct Api {
    client: reqwest::Client,
    origin: String,
    token: String,
}
impl Api {
    fn new(options: &Options) -> Result<Self> {
        let token = options.token.clone().unwrap_or_default();
        if !pattern(r"^[0-9]{1,20}:[A-Za-z0-9_-]{20,200}$", &token) {
            return Err(error(400, "Invalid Telegram token"));
        }
        let origin = options
            .origin
            .clone()
            .unwrap_or_else(|| "https://api.telegram.org".into());
        if origin != "https://api.telegram.org" && super::config::loopback(&origin).is_err() {
            return Err(error(400, "Invalid Telegram endpoint"));
        }
        if minarbot_launcher::rename_migration::var("MINARBOT_TEST_SERVER").as_deref() == Ok("rust")
            && super::config::loopback(&origin).is_err()
        {
            return Err(error(
                400,
                "Rust Telegram tests require a loopback fixture endpoint.",
            ));
        }
        if url::Url::parse(&origin).map_or(true, |u| u.origin().ascii_serialization() != origin) {
            return Err(error(400, "Invalid connector endpoint"));
        }
        Ok(Self {
            client: runner::http().map_err(|_| Failure::storage())?,
            origin,
            token,
        })
    }
    async fn call(&self, method: &str, body: &Value) -> Result<Value> {
        let response = self
            .client
            .post(format!("{}/bot{}/{method}", self.origin, self.token))
            .json(body)
            .timeout(Duration::from_secs(40))
            .send()
            .await
            .map_err(|_| error(502, "Telegram request outcome is uncertain."))?;
        let status = response.status();
        let value: Value = serde_json::from_slice(&runner::bytes(response, 2 * 1024 * 1024).await?)
            .map_err(|_| error(502, "Telegram request outcome is uncertain."))?;
        if value["ok"] == false
            && value["error_code"]
                .as_u64()
                .is_some_and(|n| (400..500).contains(&n))
        {
            let code = value["error_code"].as_u64().unwrap_or(400) as u16;
            return Err(error(code, format!("Telegram rejected request ({code}).")));
        }
        if !status.is_success() || value["ok"] != true {
            return Err(error(502, "Telegram request outcome is uncertain."));
        }
        Ok(value["result"].clone())
    }
    async fn download(&self, path: &str) -> Result<Vec<u8>> {
        if path.is_empty()
            || path.len() > 1024
            || !path
                .split('/')
                .all(|p| pattern(r"^[A-Za-z0-9_.-]+$", p) && ![".", ".."].contains(&p))
        {
            return Err(error(400, "Telegram rejected request (400)."));
        }
        let response = self
            .client
            .get(format!("{}/file/bot{}/{path}", self.origin, self.token))
            .timeout(Duration::from_secs(40))
            .send()
            .await
            .map_err(|_| error(502, "Telegram request outcome is uncertain."))?;
        if !response.status().is_success() {
            return Err(error(
                response.status().as_u16(),
                "Telegram rejected request.",
            ));
        }
        runner::bytes(response, 10 * 1024 * 1024).await
    }
}
fn allowed(options: &Options, chat: i64) -> bool {
    chat > 0 && options.users.contains(&json!(chat))
}
fn input(update: &Value, options: &Options) -> Option<Value> {
    let m = &update["message"];
    let chat = number(&m["chat"], "id");
    if !update["update_id"]
        .as_i64()
        .is_some_and(|n| (0..9_007_199_254_740_991).contains(&n))
        || m["chat"]["type"] != "private"
        || !allowed(options, chat)
        || m["from"]["id"] != chat
        || m["from"]["is_bot"] != false
        || number(m, "message_id") <= 0
    {
        return None;
    }
    let photo = m["photo"]
        .as_array()
        .filter(|a| a.len() <= 20)
        .and_then(|a| {
            a.iter()
                .max_by_key(|p| number(p, "width").saturating_mul(number(p, "height")))
        });
    let file = m.get("document").or(photo);
    let mut media = Value::Null;
    if let Some(f) = file {
        if string(f, "file_id").is_empty()
            || string(f, "file_id").len() > 512
            || f.get("file_size")
                .is_some_and(|s| s.as_i64().is_none_or(|n| n < 0))
        {
            return None;
        }
        let name = string(f, "file_name");
        let valid = !name.trim().is_empty()
            && name.encode_utf16().count() <= 200
            && !name
                .chars()
                .any(|c| c < ' ' || c == '\u{7f}' || c == '/' || c == '\\')
            && ![".", ".."].contains(&name);
        media = json!({"id":f["file_id"],"name":if valid{name}else if m.get("document").is_some(){"telegram-file"}else{"telegram-photo.jpg"},"size":f.get("file_size").cloned().unwrap_or(Value::Null)});
    }
    if m.get("caption").is_some_and(|v| !v.is_string()) {
        return None;
    }
    let text = if media.is_null() {
        m["text"].as_str()?
    } else if !string(m, "caption").trim().is_empty() {
        string(m, "caption")
    } else {
        "Read this attachment."
    };
    if text.trim().is_empty() || text.encode_utf16().count() > 16000 {
        return None;
    }
    Some(
        json!({"update":update["update_id"],"chat":chat,"message":m["message_id"],"text":text,"media":media}),
    )
}
fn callback(db: &Connection, update: &Value, options: &Options) -> Result<Option<Value>> {
    let q = &update["callback_query"];
    let m = &q["message"];
    let data = string(q, "data");
    let p: Vec<_> = data.split(':').collect();
    if p.len() != 3
        || !["a", "q"].contains(&p[0])
        || !uuid(p[1])
        || string(q, "id").is_empty()
        || string(q, "id").len() > 256
        || !allowed(options, number(&q["from"], "id"))
        || q["from"]["is_bot"] != false
        || m["chat"]["type"] != "private"
        || m["chat"]["id"] != q["from"]["id"]
        || number(m, "message_id") <= 0
    {
        return Ok(None);
    }
    let binding =
        one(db, "SELECT bot FROM telegram_binding WHERE id=1", [])?.ok_or_else(Failure::storage)?;
    if m["from"]["id"] != binding["bot"] || m["from"]["is_bot"] != true {
        return Ok(None);
    }
    let approval = p[0] == "a";
    let selection = if approval {
        match p[2] {
            "y" => 1,
            "n" => 0,
            _ => return Ok(None),
        }
    } else {
        match p[2].parse::<i64>() {
            Ok(n) if (0..8).contains(&n) => n,
            _ => return Ok(None),
        }
    };
    let row = if approval {
        one(db,"SELECT o.status,o.message_ids FROM telegram_approvals a JOIN telegram_workflows w ON w.run=a.run JOIN telegram_outbox o ON o.id=a.notice WHERE a.notice=? AND w.chat=? AND o.chat=? AND o.status IN('sent','sending')",params![p[1],q["from"]["id"].as_i64(),q["from"]["id"].as_i64()])?
    } else {
        one(db,"SELECT o.status,o.message_ids,q.choices FROM telegram_questions q JOIN telegram_outbox o ON o.id=q.id WHERE q.id=? AND q.chat=? AND o.chat=? AND o.status IN('sent','sending')",params![p[1],q["from"]["id"].as_i64(),q["from"]["id"].as_i64()])?
    };
    let Some(row) = row else {
        return Ok(None);
    };
    let ids = crate::data::json(&row["message_ids"])?;
    if row["status"] == "sent" && ids.as_array().and_then(|a| a.last()) != Some(&m["message_id"]) {
        return Ok(None);
    }
    if !approval && !crate::data::json(&row["choices"])?[selection as usize].is_string() {
        return Ok(None);
    }
    Ok(Some(
        json!({"notice":p[1],"chat":q["from"]["id"],"message":m["message_id"],"selection":selection,"pending":row["status"]=="sending"}),
    ))
}
fn record(db: &Connection, updates: &Value, options: &Options) -> Result<i64> {
    let updates = updates
        .as_array()
        .filter(|a| {
            a.len() <= 100
                && a.iter().all(|u| {
                    u["update_id"]
                        .as_i64()
                        .is_some_and(|n| (0..9_007_199_254_740_991).contains(&n))
                })
        })
        .ok_or_else(|| error(400, "Invalid Telegram updates"))?;
    transaction(db, || {
        let binding = one(db, "SELECT offset FROM telegram_binding WHERE id=1", [])?
            .ok_or_else(|| error(409, "Telegram journal is not bound"))?;
        let mut offset = number(&binding, "offset");
        let mut sorted = updates.clone();
        sorted.sort_by_key(|u| number(u, "update_id"));
        for update in sorted {
            if let Some(c) = callback(db, &update, options)? {
                if c["pending"] == true {
                    break;
                }
                if number(&update, "update_id") >= number(&binding, "offset") {
                    db.execute("INSERT OR IGNORE INTO telegram_callbacks(notice,id,chat,message,selection) VALUES(?,?,?,?,?)",params![c["notice"].as_str(),new_id(),c["chat"].as_i64(),c["message"].as_i64(),c["selection"].as_i64()])?;
                }
            }
            if let Some(input) = input(&update, options) {
                let prior = one(
                    db,
                    "SELECT * FROM telegram_inbox WHERE update_id=? OR(chat=? AND message=?)",
                    params![
                        input["update"].as_i64(),
                        input["chat"].as_i64(),
                        input["message"].as_i64()
                    ],
                )?;
                if let Some(prior) = prior {
                    if prior["update_id"] != input["update"]
                        || prior["chat"] != input["chat"]
                        || prior["message"] != input["message"]
                        || prior["text"] != input["text"]
                    {
                        return Err(error(409, "Telegram update identity conflict"));
                    }
                    let stored = one(
                        db,
                        "SELECT remote AS id,name,size FROM telegram_media WHERE turn=?",
                        [string(&prior, "turn")],
                    )?
                    .unwrap_or(Value::Null);
                    if stored != input["media"] {
                        return Err(error(409, "Telegram attachment identity conflict"));
                    }
                } else if number(&input, "update") >= number(&binding, "offset") {
                    let previous=one(db,"SELECT thread FROM telegram_inbox WHERE chat=? ORDER BY update_id DESC LIMIT 1",params![input["chat"].as_i64()])?;
                    let thread = match previous {
                        Some(row)
                            if !exists(
                                db,
                                "SELECT 1 FROM telegram_closed_threads WHERE id=?",
                                [string(&row, "thread")],
                            )? =>
                        {
                            string(&row, "thread").to_owned()
                        }
                        _ => new_id(),
                    };
                    let turn = new_id();
                    db.execute("INSERT INTO telegram_inbox(update_id,chat,message,text,thread,turn) VALUES(?,?,?,?,?,?)",params![input["update"].as_i64(),input["chat"].as_i64(),input["message"].as_i64(),input["text"].as_str(),thread,turn])?;
                    if !input["media"].is_null() {
                        db.execute(
                            "INSERT INTO telegram_media VALUES(?,?,?,?,?,NULL)",
                            params![
                                turn,
                                input["media"]["id"].as_str(),
                                input["media"]["name"].as_str(),
                                input["media"]["size"].as_i64(),
                                new_id()
                            ],
                        )?;
                    }
                }
            }
            offset = offset.max(number(&update, "update_id") + 1);
        }
        db.execute("UPDATE telegram_binding SET offset=? WHERE id=1", [offset])?;
        Ok(offset)
    })
}
fn queue(db: &Connection, id: &str, row: &Value, text: &str) -> Result<()> {
    if let Some(prior) = one(
        db,
        "SELECT chat,reply_to,text FROM telegram_outbox WHERE id=?",
        [id],
    )? {
        if prior["chat"] != row["chat"]
            || prior["reply_to"] != row["message"]
            || prior["text"] != text
        {
            return Err(error(409, "Telegram reply identity conflict"));
        }
        return Ok(());
    }
    db.execute(
        "INSERT INTO telegram_outbox(id,chat,reply_to,text,status) VALUES(?,?,?,?,'queued')",
        params![id, row["chat"].as_i64(), row["message"].as_i64(), text],
    )?;
    Ok(())
}
fn finish(db: &Connection, row: &Value, text: &str) -> Result<()> {
    let text = if text.trim().is_empty() {
        "Task completed without a text reply.".into()
    } else if text.encode_utf16().count() > 64000 {
        format!(
            "{}\n\n[Reply truncated. Read the full text in Minarbot.]",
            text.chars()
                .scan(0, |n, c| {
                    *n += c.len_utf16();
                    (*n <= 63000).then_some(c)
                })
                .collect::<String>()
        )
    } else {
        text.to_owned()
    };
    transaction(db, || {
        queue(db, string(row, "turn"), row, &text)?;
        db.execute(
            "UPDATE telegram_inbox SET status='done' WHERE update_id=?",
            params![row["update_id"].as_i64()],
        )?;
        Ok(())
    })
}
async fn work(db: &Connection, options: &Options, local: &Local, api: &Api) -> Result<()> {
    let base = format!("/api/scripts/agents/{}", options.agent);
    for c in all(db,"SELECT c.*,a.run,a.revision,q.turn,q.thread,q.choices FROM telegram_callbacks c LEFT JOIN telegram_approvals a ON a.notice=c.notice LEFT JOIN telegram_questions q ON q.id=c.notice WHERE c.status='queued' ORDER BY c.rowid LIMIT 100",[])?{
        if !allowed(options,number(&c,"chat")){db.execute("UPDATE telegram_callbacks SET status='revoked' WHERE notice=?",[string(&c,"notice")])?;continue;}
        let reply = if c["run"].is_string() {
            let decision = json!({"id":c["id"],"revision":c["revision"],"accepted":c["selection"]==1});
            match local.request(&format!("{base}/workflow-runs/{}/approve",string(&c,"run")), Some(&decision)).await {
                Ok(_) if c["selection"]==1 => "Approval received.",
                Ok(_) => "Rejection received.",
                Err(e) if [400,404,409].contains(&e.status) => "Approval could not be applied. Check the latest status in Minarbot.",
                Err(e) => return Err(e),
            }
        } else {
            let choices = crate::data::json(&c["choices"])?;
            let answer = json!({"id":c["id"],"text":choices[number(&c,"selection") as usize]});
            match local.request(&format!("{base}/threads/{}/turns/{}/questions/{}/answer",string(&c,"thread"),string(&c,"turn"),string(&c,"notice")), Some(&answer)).await {
                Ok(_) => "Answer received.",
                Err(e) if [400,404,409].contains(&e.status) => "Answer could not be applied. Check task status in Minarbot.",
                Err(e) => return Err(e),
            }
        };
        transaction(db,||{queue(db,string(&c,"id"),&c,reply)?;db.execute("UPDATE telegram_callbacks SET status='done' WHERE notice=?",[string(&c,"notice")])?;Ok(())})?;
    }
    for entry in all(db,"SELECT update_id FROM telegram_inbox WHERE status IN('queued','submitting','running') ORDER BY text LIKE '/stop %' DESC,checked,update_id LIMIT 100",[])?{
        let Some(row) = one(db,"SELECT * FROM telegram_inbox WHERE update_id=? AND status IN('queued','submitting','running')",params![entry["update_id"].as_i64()])? else { continue };

        if !allowed(options,number(&row,"chat")){db.execute("UPDATE telegram_inbox SET status='revoked' WHERE update_id=?",params![row["update_id"].as_i64()])?;continue;}
        db.execute("UPDATE telegram_inbox SET checked=(SELECT coalesce(max(checked),0)+1 FROM telegram_inbox) WHERE update_id=?",params![row["update_id"].as_i64()])?;
        let result=process(db,options,local,api,&base,&row).await;
        if let Err(e)=result {
            let media = exists(db,"SELECT 1 FROM telegram_media WHERE turn=?",[string(&row,"turn")])?;
            if media && [413,415].contains(&e.status) {
                finish(db,&row,"Attachment rejected. PDF must contain readable text up to 32 KiB. Scanned PDFs require OCR. Check the file, then send a new message.")?;
                continue;
            }
            if ![400,404,409].contains(&e.status) {
                return Err(e);
            }
            let command = string(&row,"text").split(' ').next().unwrap_or("");
            if !media && ["/workflow","/workflows","/approve","/stop"].contains(&command) {
                finish(db,&row,"Workflow request denied. Check the latest revision, status, and permissions in Minarbot.")?;
                continue;
            }
            if [404,409].contains(&e.status) {
                db.execute("INSERT OR IGNORE INTO telegram_closed_threads VALUES(?)",[string(&row,"thread")])?;
            }
            finish(db,&row,"Message cannot be processed in this conversation. Check the previous task in Minarbot. Send a new message to start a new conversation.")?;
        }
    }
    for row in all(
        db,
        "SELECT * FROM telegram_outbox WHERE status='queued' ORDER BY rowid LIMIT 20",
        [],
    )? {
        if !allowed(options, number(&row, "chat")) {
            db.execute(
                "UPDATE telegram_outbox SET status='revoked' WHERE id=?",
                [string(&row, "id")],
            )?;
            continue;
        }
        deliver(db, local, api, &base, &row).await?;
    }
    Ok(())
}
async fn process(
    db: &Connection,
    _options: &Options,
    local: &Local,
    api: &Api,
    base: &str,
    row: &Value,
) -> Result<()> {
    let text = string(row, "text");
    let media = one(
        db,
        "SELECT turn,remote,name,size,upload FROM telegram_media WHERE turn=?",
        [string(row, "turn")],
    )?;
    if media.is_none() && super::workflow::handle(db, "telegram", base, row, local).await? {
        return Ok(());
    }
    if ["queued", "submitting"].contains(&string(row, "status")) {
        if media.is_none() && text == "/status" {
            let active=all(db,"SELECT turn,status FROM telegram_inbox WHERE chat=? AND update_id<>? AND status IN('queued','submitting','running') ORDER BY update_id LIMIT 20",params![row["chat"].as_i64(),row["update_id"].as_i64()])?;
            return finish(
                db,
                row,
                &if active.is_empty() {
                    "No active tasks in this conversation.".into()
                } else {
                    active
                        .iter()
                        .map(|r| {
                            format!(
                                "{}: {}\n/stop {}",
                                r["turn"].as_str().unwrap_or(""),
                                string(r, "status"),
                                string(r, "turn")
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n\n")
                },
            );
        }
        if media.is_none() && text.starts_with("/stop") {
            let id = text.strip_prefix("/stop ").filter(|id| uuid(id));
            let target = if let Some(id) = id {
                one(db,"SELECT * FROM telegram_inbox WHERE turn=? AND chat=? AND status IN('queued','submitting','running')",params![id,row["chat"].as_i64()])?
            } else {
                None
            };
            let Some(target) = target else {
                return finish(
                    db,
                    row,
                    "Active task not found for this conversation. Use /status to see task IDs.",
                );
            };
            if target["status"] == "queued" {
                db.execute(
                    "UPDATE telegram_inbox SET status='cancelled' WHERE update_id=?",
                    params![target["update_id"].as_i64()],
                )?;
                return finish(db, row, "Task cancelled before sending to the agent.");
            }
            let result = local
                .request(
                    &format!(
                        "{base}/threads/{}/turns/{}/cancel",
                        string(&target, "thread"),
                        string(&target, "turn")
                    ),
                    Some(&json!({"id":row["turn"]})),
                )
                .await;
            if let Err(e) = result {
                if [404, 409].contains(&e.status) {
                    return finish(
                        db,
                        row,
                        "Task cannot be cancelled. Check the latest status in Minarbot.",
                    );
                }
                return Err(e);
            }
            db.execute(
                "UPDATE telegram_inbox SET status='running' WHERE update_id=?",
                params![target["update_id"].as_i64()],
            )?;
            return finish(
                db,
                row,
                "Cancellation request accepted. Steps already executed may remain saved.",
            );
        }
        if media.is_none() && text.starts_with("/answer") {
            let parts: Vec<_> = text.splitn(3, ' ').collect();
            let question = if parts.len() == 3
                && uuid(parts[1])
                && (1..=4000).contains(&parts[2].encode_utf16().count())
            {
                one(
                    db,
                    "SELECT * FROM telegram_questions WHERE id=? AND chat=?",
                    params![parts[1], row["chat"].as_i64()],
                )?
            } else {
                None
            };
            let Some(q) = question else {
                return finish(
                    db,
                    row,
                    "Question not found for this conversation. Use /answer QUESTION_ID answer.",
                );
            };
            let result = local
                .request(
                    &format!(
                        "{base}/threads/{}/turns/{}/questions/{}/answer",
                        string(&q, "thread"),
                        string(&q, "turn"),
                        string(&q, "id")
                    ),
                    Some(&json!({"id":row["turn"],"text":parts[2]})),
                )
                .await;
            if let Err(e) = result {
                if [400, 404, 409].contains(&e.status) {
                    return finish(db, row, "Answer rejected. Choose an available answer or check task status in Minarbot.");
                }
                return Err(e);
            }
            return finish(db, row, "Answer accepted.");
        }
        db.execute(
            "UPDATE telegram_inbox SET status='submitting' WHERE update_id=?",
            params![row["update_id"].as_i64()],
        )?;
        local
            .request(
                &format!("{base}/threads"),
                Some(&json!({"id":row["thread"],"name":format!("Telegram {}",row["chat"])})),
            )
            .await?;
        let mut files = vec![];
        if let Some(media) = &media {
            let result = async {
                if media["size"].as_u64().is_some_and(|n| n > 10 * 1024 * 1024) {
                    return Err(error(413, "Attachment too large"));
                }
                let mut bytes = db.query_row(
                    "SELECT bytes FROM telegram_media WHERE turn=?",
                    [string(row, "turn")],
                    |r| r.get::<_, Option<Vec<u8>>>(0),
                )?;
                if bytes.is_none() {
                    let file = api
                        .call("getFile", &json!({"file_id":media["remote"]}))
                        .await?;
                    if file["file_id"] != media["remote"] || !file["file_path"].is_string() {
                        return Err(error(400, "Invalid Telegram file"));
                    }
                    if file["file_size"]
                        .as_i64()
                        .is_some_and(|n| !(0..=10 * 1024 * 1024).contains(&n))
                    {
                        return Err(error(413, "Attachment too large"));
                    }
                    local.request(&format!("{base}/threads"), None).await?;
                    let downloaded = api.download(string(&file, "file_path")).await?;
                    super::media::validate(&downloaded)?;
                    db.execute(
                        "UPDATE telegram_media SET bytes=? WHERE turn=?",
                        params![downloaded, row["turn"].as_str()],
                    )?;
                    bytes = Some(downloaded);
                }
                local
                    .send(
                        &format!(
                            "{base}/threads/{}/files/{}",
                            string(row, "thread"),
                            string(media, "upload")
                        ),
                        bytes,
                        Some(string(media, "name")),
                    )
                    .await?;
                Ok::<_, Failure>(())
            }
            .await;
            if let Err(e) = result {
                if [400, 413, 415].contains(&e.status) {
                    return finish(db,row,"Attachment cannot be processed. Use UTF-8 text up to 32 KiB or PDF up to 10 MiB with readable text up to 32 KiB, or PNG/JPEG/WebP images up to 4 MiB each.");
                }
                return Err(e);
            }
            files.push(media["upload"].clone());
        }
        let mut body = json!({"id":row["turn"],"text":row["text"]});
        if media.is_some() {
            body["files"] = json!(files);
        }
        local
            .request(
                &format!("{base}/threads/{}/turns", string(row, "thread")),
                Some(&body),
            )
            .await?;
        db.execute(
            "UPDATE telegram_inbox SET status='running' WHERE update_id=?",
            params![row["update_id"].as_i64()],
        )?;
    }
    let turns = local
        .request(
            &format!(
                "{base}/threads/{}/turns?focus={}",
                string(row, "thread"),
                string(row, "turn")
            ),
            None,
        )
        .await?;
    let Some(turn) = turns
        .as_array()
        .and_then(|a| a.iter().find(|t| t["id"] == row["turn"]))
    else {
        return Ok(());
    };
    for q in turn["questions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|q| q["answer"].is_null())
    {
        transaction(db, || {
            db.execute("INSERT OR IGNORE INTO telegram_questions(id,turn,thread,chat,choices) VALUES(?,?,?,?,?)",params![q["id"].as_str(),row["turn"].as_str(),row["thread"].as_str(),row["chat"].as_i64(),q["choices"].to_string()])?;
            let choices = q["choices"]
                .as_array()
                .filter(|a| !a.is_empty())
                .map(|a| {
                    format!(
                        "\nChoose:\n{}",
                        a.iter()
                            .enumerate()
                            .map(|(i, c)| format!("{}. {}", i + 1, c.as_str().unwrap_or("")))
                            .collect::<Vec<_>>()
                            .join("\n")
                    )
                })
                .unwrap_or_default();
            if !exists(
                db,
                "SELECT 1 FROM telegram_outbox WHERE id=?",
                [string(q, "id")],
            )? {
                queue(
                    db,
                    string(q, "id"),
                    row,
                    &format!(
                        "{}{}\n\nBalas: /answer {} answer",
                        string(q, "prompt"),
                        choices,
                        string(q, "id")
                    ),
                )?;
            }
            Ok(())
        })?;
    }
    if !["done", "failed", "cancelled"].contains(&string(turn, "status")) {
        return Ok(());
    }
    super::media::snapshot(db, "telegram", base, row, turn, local, None).await?;
    let mut text = match string(turn, "status") {
        "done" => turn["reply"]
            .as_str()
            .filter(|text| !text.is_empty())
            .unwrap_or("Task finished without a text reply."),
        "cancelled" => "Task cancelled.",
        _ => "Task failed. Check details in Minarbot.",
    }
    .to_owned();
    let files = turn["generatedFiles"].as_array();
    for _ in files.into_iter().flatten().filter(|file| {
        file["size"]
            .as_u64()
            .is_none_or(|size| size > 10 * 1024 * 1024)
    }) {
        text.push_str(
            "\nResult file is too large for this connector. Download it through Minarbot.",
        );
    }
    if turn["status"] != "done" && files.is_some_and(|files| !files.is_empty()) {
        text.push_str("\nCreated files were sent as a partial result.");
    }
    finish(db, row, &text)
}
async fn deliver(db: &Connection, local: &Local, api: &Api, base: &str, row: &Value) -> Result<()> {
    let id = string(row, "id");
    let document=one(db,"SELECT d.thread,d.turn,d.file,d.name,w.run FROM telegram_documents d LEFT JOIN telegram_document_workflows w ON w.id=d.id WHERE d.id=?",[id])?;
    let chunks = if document.is_some() {
        vec![String::new()]
    } else {
        super::media::chunks(string(row, "text"), 4096, false)
    };
    let mut ids = crate::data::json(&row["message_ids"])?;
    for (part, text) in chunks.iter().enumerate().skip(number(row, "part") as usize) {
        let authorize = local
            .request(
                &document
                    .as_ref()
                    .map(|d| super::media::source(base, d))
                    .unwrap_or_else(|| format!("{base}/threads")),
                None,
            )
            .await;
        if let Err(e) = authorize {
            if document.is_some() && e.status == 404 {
                db.execute("UPDATE telegram_outbox SET status='revoked',error='Source file is no longer available.' WHERE id=?",[id])?;
                return Ok(());
            }
            return Err(e);
        }
        if db.execute(
            "UPDATE telegram_outbox SET status='sending' WHERE id=? AND status='queued' AND part=?",
            params![id, part as i64],
        )? == 0
        {
            return Ok(());
        }
        let mut body = json!({"chat_id":row["chat"],"reply_parameters":{"message_id":row["reply_to"],"allow_sending_without_reply":false},"text":text,"link_preview_options":{"is_disabled":true}});
        if part + 1 == chunks.len() {
            let q = one(
                db,
                "SELECT choices FROM telegram_questions WHERE id=? AND chat=?",
                params![id, row["chat"].as_i64()],
            )?;
            if exists(db,"SELECT 1 FROM telegram_approvals a JOIN telegram_workflows w ON w.run=a.run WHERE a.notice=? AND w.chat=?",params![id,row["chat"].as_i64()])?{body["reply_markup"]=json!({"inline_keyboard":[[{"text":"Approve","callback_data":format!("a:{id}:y")},{"text":"Reject","callback_data":format!("a:{id}:n")}]]});}
            else if let Some(q)=q{let choices=crate::data::json(&q["choices"])?;if let Some(choices)=choices.as_array().filter(|a|!a.is_empty()){body["reply_markup"]=json!({"inline_keyboard":choices.iter().enumerate().map(|(i,c)|json!([{"text":format!("{}. {}{}",i+1,c.as_str().unwrap_or("").chars().take(45).collect::<String>(),if c.as_str().unwrap_or("").chars().count()>45{"..."}else{""}),"callback_data":format!("q:{id}:{i}")}])).collect::<Vec<_>>()});}}
        }
        let result = if let Some(document) = &document {
            let bytes: Vec<u8> = db.query_row(
                "SELECT bytes FROM telegram_documents WHERE id=?",
                [id],
                |r| r.get(0),
            )?;
            super::media::telegram_document(
                &api.client,
                &api.origin,
                &api.token,
                row,
                string(document, "name"),
                bytes,
            )
            .await
        } else {
            api.call("sendMessage", &body).await
        };
        let result = match result {
            Ok(v) if number(&v, "message_id") > 0 && v["chat"]["id"] == row["chat"] => v,
            other => {
                let definitive = other
                    .as_ref()
                    .err()
                    .is_some_and(|e| (400..500).contains(&e.status));
                db.execute(
                    "UPDATE telegram_outbox SET status=?,error=? WHERE id=?",
                    [
                        if definitive { "failed" } else { "uncertain" },
                        if definitive {
                            other
                                .as_ref()
                                .err()
                                .map(|e| e.message.as_str())
                                .unwrap_or("")
                        } else {
                            "Telegram delivery not confirmed; automatic retry disabled."
                        },
                        id,
                    ],
                )?;
                return Ok(());
            }
        };
        ids.as_array_mut()
            .ok_or_else(Failure::storage)?
            .push(result["message_id"].clone());
        db.execute(
            "UPDATE telegram_outbox SET status=?,part=?,message_ids=? WHERE id=?",
            params![
                if part + 1 == chunks.len() {
                    "sent"
                } else {
                    "queued"
                },
                (part + 1) as i64,
                ids.to_string(),
                id
            ],
        )?;
    }
    Ok(())
}
async fn poll(db: &Connection, options: &Options, api: &Api) -> Result<i64> {
    let binding = one(db, "SELECT offset FROM telegram_binding WHERE id=1", [])?
        .ok_or_else(Failure::storage)?;
    let updates=api.call("getUpdates",&json!({"offset":binding["offset"],"limit":20,"timeout":25,"allowed_updates":["message","callback_query"]})).await?;
    let offset = record(db, &updates, options)?;
    for update in updates
        .as_array()
        .into_iter()
        .flatten()
        .filter(|u| number(u, "update_id") < offset)
    {
        let query = string(&update["callback_query"], "id");
        if query.is_empty() || query.len() > 256 {
            continue;
        }
        let accepted = if let Some(choice) = callback(db, update, options)? {
            one(
                db,
                "SELECT selection FROM telegram_callbacks WHERE notice=?",
                [string(&choice, "notice")],
            )?
            .is_some_and(|recorded| recorded["selection"] == choice["selection"])
        } else {
            false
        };
        let text = if accepted {
            "Choice recorded. Result sent to the conversation."
        } else {
            "Button is invalid or the choice was already recorded."
        };
        let _ = api
            .call(
                "answerCallbackQuery",
                &json!({"callback_query_id":query,"text":text}),
            )
            .await;
    }
    Ok(offset)
}
fn bind(db: &Connection, bot: i64, agent: &str) -> Result<()> {
    if one(db, "SELECT bot,agent FROM telegram_binding WHERE id=1", [])?
        .is_some_and(|b| b["bot"] != bot || b["agent"] != agent)
    {
        return Err(error(
            409,
            "Telegram journal belongs to another bot or agent",
        ));
    }
    db.execute(
        "INSERT OR IGNORE INTO telegram_binding(id,bot,agent) VALUES(1,?,?)",
        params![bot, agent],
    )?;
    Ok(())
}
pub async fn run(db: &Connection, options: &Options) -> Result<()> {
    if options.users.iter().any(|u| {
        !u.as_i64()
            .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)
    }) {
        return Err(error(400, "Telegram requires distinct allowed user IDs"));
    }
    let api = Api::new(options)?;
    let bot = api.call("getMe", &json!({})).await?;
    if number(&bot, "id") <= 0
        || bot["is_bot"] != true
        || number(&bot, "id").to_string() != api.token.split(':').next().unwrap_or("")
    {
        return Err(error(400, "Telegram bot identity mismatch"));
    }
    bind(db, number(&bot, "id"), &options.agent)?;
    let local = Local::read(&options.script_directory)
        .map_err(|_| error(403, "Script discovery is unavailable or unsafe."))?;
    local
        .request(
            &format!("/api/scripts/agents/{}/threads", options.agent),
            None,
        )
        .await?;
    let incoming = async {
        loop {
            poll(db, options, &api).await?;
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        #[allow(unreachable_code)]
        Ok::<(), Failure>(())
    };
    let worker = async {
        loop {
            work(db, options, &local, &api).await?;
            tokio::time::sleep(Duration::from_millis(1000)).await;
        }
        #[allow(unreachable_code)]
        Ok::<(), Failure>(())
    };
    tokio::try_join!(incoming, worker)?;
    Ok(())
}
pub(super) fn finish_input(db: &Connection, row: &Value, text: &str) -> Result<()> {
    finish(db, row, text)
}

#[cfg(test)]
mod tests;
