use super::runner::{self, new_id, number, pattern, Local, Options};
use super::*;
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;

struct Api {
    client: reqwest::Client,
    origin: String,
    bot: String,
    app: String,
}
impl Api {
    fn new(options: &Options) -> Result<Self> {
        let bot = options.bot_token.clone().unwrap_or_default();
        let app = options.app_token.clone().unwrap_or_default();
        if !pattern(r"^xoxb-[A-Za-z0-9-]{20,300}$", &bot)
            || !pattern(r"^xapp-[A-Za-z0-9-]{20,300}$", &app)
        {
            return Err(error(400, "Invalid Slack credentials"));
        }
        let origin = options
            .origin
            .clone()
            .unwrap_or_else(|| "https://slack.com".into());
        if origin != "https://slack.com" && super::config::loopback(&origin).is_err() {
            return Err(error(400, "Invalid Slack endpoint"));
        }
        if std::env::var("BRIEFSIP_TEST_SERVER").as_deref() == Ok("rust")
            && super::config::loopback(&origin).is_err()
        {
            return Err(error(
                400,
                "Rust Slack tests require a loopback fixture endpoint.",
            ));
        }
        if url::Url::parse(&origin).map_or(true, |u| u.origin().ascii_serialization() != origin) {
            return Err(error(400, "Invalid connector endpoint"));
        }
        Ok(Self {
            client: runner::http().map_err(|_| Failure::storage())?,
            origin,
            bot,
            app,
        })
    }
    async fn call(&self, method: &str, body: &Value) -> Result<Value> {
        let response = self
            .client
            .post(format!("{}/api/{method}", self.origin))
            .bearer_auth(if method == "apps.connections.open" {
                &self.app
            } else {
                &self.bot
            })
            .json(body)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| error(502, "Slack request outcome is uncertain."))?;
        if response.status() == 429 {
            let retry = response
                .headers()
                .get("retry-after")
                .and_then(|s| s.to_str().ok())
                .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
                .and_then(|s| s.parse::<i64>().ok())
                .filter(|s| *s > 0 && *s < (9_007_199_254_740_991 - crate::config::now()) / 1000);
            let mut e = error(429, "Slack rejected request.");
            e.details = retry.map(|n| json!({"retryAfter":n}));
            return Err(e);
        }
        let status = response.status();
        let v: Value = serde_json::from_slice(&runner::bytes(response, 2 * 1024 * 1024).await?)
            .map_err(|_| error(502, "Slack request outcome is uncertain."))?;
        if v["ok"] == false {
            let definitive = [
                "invalid_auth",
                "not_authed",
                "token_revoked",
                "account_inactive",
                "channel_not_found",
                "file_not_found",
                "file_deleted",
                "is_archived",
                "not_in_channel",
                "msg_too_long",
                "no_text",
                "ratelimited",
                "rate_limited",
                "missing_scope",
                "restricted_action",
            ]
            .contains(&string(&v, "error"));
            return Err(error(
                if definitive { 400 } else { 502 },
                if definitive {
                    "Slack rejected request."
                } else {
                    "Slack request outcome is uncertain."
                },
            ));
        }
        if !status.is_success() || v["ok"] != true {
            return Err(error(502, "Slack request outcome is uncertain."));
        }
        Ok(v)
    }
    fn file_url(&self, value: &str) -> Result<url::Url> {
        let url = url::Url::parse(value).map_err(|_| error(400, "Slack rejected request."))?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || !(url.scheme() == "https"
                && url.host_str() == Some("files.slack.com")
                && url.port().is_none_or(|p| p == 443)
                || self.origin != "https://slack.com"
                    && url.origin().ascii_serialization() == self.origin)
        {
            return Err(error(400, "Slack rejected request."));
        }
        Ok(url)
    }
    async fn download(&self, url: &str) -> Result<Vec<u8>> {
        let url = self.file_url(url)?;
        let response = self
            .client
            .get(url)
            .bearer_auth(&self.bot)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| error(502, "Slack request outcome is uncertain."))?;
        if !response.status().is_success() {
            return Err(error(
                if [400, 401, 403, 404, 410].contains(&response.status().as_u16()) {
                    400
                } else {
                    502
                },
                "Slack file request failed.",
            ));
        }
        runner::bytes(response, 10 * 1024 * 1024).await
    }
}
fn channel(options: &Options, id: &str) -> bool {
    pattern(r"^D[A-Z0-9]{2,30}$", id) || options.channels.iter().any(|c| c == id)
}
fn allowed(options: &Options, sender: &str) -> bool {
    options.users.contains(&json!(sender))
}
fn stamp(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| pattern(r"^\d{10,16}\.\d{6}$", s))
}
fn record(db: &Connection, v: &Value, options: &Options) -> Result<Option<String>> {
    let envelope = string(v, "envelope_id");
    if envelope.is_empty() || envelope.len() > 200 {
        return Ok(None);
    }
    let ack = Some(envelope.to_owned());
    let b = one(db, "SELECT * FROM slack_binding", [])?
        .ok_or_else(|| error(409, "Slack journal unbound"))?;
    let p = &v["payload"];
    let e = &p["event"];
    if v["type"] == "interactive" {
        let action = p["actions"]
            .as_array()
            .filter(|a| a.len() == 1)
            .and_then(|a| a.first())
            .cloned()
            .unwrap_or(Value::Null);
        let raw = string(&action, "value");
        let parts: Vec<_> = raw.split(':').collect();
        if parts.len() != 3
            || !["approval", "question"].contains(&parts[0])
            || !uuid(parts[1])
            || !channel(options, string(&p["channel"], "id"))
            || p["type"] != "block_actions"
            || p["team"]["id"] != b["team"]
            || p["api_app_id"] != b["app"]
            || !allowed(options, string(&p["user"], "id"))
            || action["type"] != "button"
            || p["message"]["user"] != b["bot"]
            || p["container"]["channel_id"] != p["channel"]["id"]
            || p["container"]["message_ts"] != p["message"]["ts"]
        {
            return Ok(ack);
        }
        let approval = parts[0] == "approval";
        let action_id = format!(
            "briefsip_{}_{}",
            if approval { "approve" } else { "answer" },
            parts[2]
        );
        if action["action_id"] != action_id {
            return Ok(ack);
        }
        if approval && !["yes", "no"].contains(&parts[2])
            || !approval && !pattern(r"^[0-7]$", parts[2])
        {
            return Ok(ack);
        }
        let notice = if approval {
            one(db,"SELECT o.* FROM slack_approvals a JOIN slack_workflows w ON w.run=a.run JOIN slack_outbox o ON o.id=a.notice WHERE a.notice=? AND w.channel=? AND w.sender=? AND w.root=o.root",[parts[1],string(&p["channel"],"id"),string(&p["user"],"id")])?
        } else {
            one(db,"SELECT o.*,c.choices FROM slack_questions q JOIN slack_question_choices c ON c.id=q.id JOIN slack_outbox o ON o.id=q.id WHERE q.id=? AND q.channel=? AND q.sender=? AND q.root=o.root",[parts[1],string(&p["channel"],"id"),string(&p["user"],"id")])?
        };
        let Some(notice) = notice else {
            return Ok(ack);
        };
        if notice["status"] == "sending" {
            return Ok(None);
        }
        if notice["status"] != "sent"
            || crate::data::json(&notice["timestamps"])?
                .as_array()
                .and_then(|a| a.last())
                != Some(&p["message"]["ts"])
        {
            return Ok(ack);
        }
        if approval {
            db.execute(
                "INSERT OR IGNORE INTO slack_callbacks(notice,id,accepted) VALUES(?,?,?)",
                params![parts[1], new_id(), parts[2] == "yes"],
            )?;
        } else {
            let choices = crate::data::json(&notice["choices"])?;
            let index = parts[2].parse::<usize>().map_err(|_| Failure::storage())?;
            if choices[index].is_string() {
                db.execute("INSERT OR IGNORE INTO slack_question_callbacks(question,id,answer) VALUES(?,?,?)",params![parts[1],new_id(),choices[index].as_str()])?;
            }
        }
        return Ok(ack);
    }
    if v["type"] != "events_api"
        || p["type"] != "event_callback"
        || p["team_id"] != b["team"]
        || p["api_app_id"] != b["app"]
        || !p["authorizations"].as_array().is_some_and(|a| {
            a.iter().any(|a| {
                a["team_id"] == b["team"] && a["user_id"] == b["bot"] && a["is_bot"] == true
            })
        })
        || !["message", "app_mention"].contains(&string(e, "type"))
        || e.get("subtype").is_some_and(|s| s != "file_share")
        || !e["bot_id"].is_null()
        || e["user"] == b["bot"]
        || !allowed(options, string(e, "user"))
        || !channel(options, string(e, "channel"))
        || !stamp(&e["ts"])
        || e.get("thread_ts").is_some_and(|s| !stamp(s))
        || !e["text"].is_string()
        || string(e, "text").encode_utf16().count() > 16000
        || !pattern(r"^Ev[A-Za-z0-9]{1,100}$", string(p, "event_id"))
    {
        return Ok(ack);
    }
    let direct = string(e, "channel").starts_with('D');
    if direct && (e["type"] != "message" || e["channel_type"] != "im")
        || !direct
            && e["type"] == "message"
            && !["channel", "group"].contains(&string(e, "channel_type"))
    {
        return Ok(ack);
    }
    let root = e.get("thread_ts").unwrap_or(&e["ts"]);
    let mention = format!("<@{}>", string(&b, "bot"));
    if !direct
        && !string(e, "text").contains(&mention)
        && !exists(
            db,
            "SELECT 1 FROM slack_inbox WHERE channel=? AND root=?",
            [string(e, "channel"), root.as_str().unwrap_or("")],
        )?
    {
        return Ok(ack);
    }
    let files = e["files"]
        .as_array()
        .map(|a| a.iter().map(|f| f["id"].clone()).collect::<Vec<_>>())
        .unwrap_or_default();
    let valid = files.len() <= 4
        && files.iter().enumerate().all(|(i, f)| {
            f.as_str().is_some_and(|s| pattern(r"^F[A-Z0-9]{2,30}$", s)) && !files[..i].contains(f)
        });
    let text = if direct {
        string(e, "text").to_owned()
    } else {
        string(e, "text").replace(&mention, "").trim().to_owned()
    };
    let text = if text.is_empty() && !files.is_empty() {
        "Check this attachment.".into()
    } else {
        text
    };
    if text.trim().is_empty() {
        return Ok(ack);
    }
    transaction(db, || {
        let prior = one(
            db,
            "SELECT * FROM slack_inbox WHERE event=? OR(channel=? AND ts=?)",
            [string(p, "event_id"), string(e, "channel"), string(e, "ts")],
        )?;
        if let Some(old) = prior {
            let files_json = json!(files).to_string();
            if old["channel"] != e["channel"]
                || old["sender"] != e["user"]
                || old["ts"] != e["ts"]
                || old["root"] != *root
                || old["text"] != text
                || old["files"].as_str() != Some(files_json.as_str())
            {
                return Err(error(409, "Slack event identity conflict"));
            }
        } else {
            let prior=one(db,"SELECT thread,sender FROM slack_inbox WHERE channel=? AND root=? ORDER BY rowid DESC LIMIT 1",[string(e,"channel"),root.as_str().unwrap_or("")])?;
            if direct && prior.as_ref().is_some_and(|r| r["sender"] != e["user"]) {
                return Err(error(409, "Slack DM participant changed"));
            }
            let thread = match prior {
                Some(row)
                    if !exists(
                        db,
                        "SELECT 1 FROM slack_closed_threads WHERE id=?",
                        [string(&row, "thread")],
                    )? =>
                {
                    string(&row, "thread").into()
                }
                _ => new_id(),
            };
            let turn = new_id();
            let kind = if !files.is_empty() {
                if valid {
                    "media"
                } else {
                    "media-invalid"
                }
            } else if text.starts_with("!workflow ") {
                "workflow"
            } else if text == "!workflows" || text.starts_with("!approve ") {
                "workflow-command"
            } else {
                "message"
            };
            db.execute("INSERT INTO slack_inbox(event,channel,sender,ts,root,text,thread,turn,kind,files) VALUES(?,?,?,?,?,?,?,?,?,?)",params![p["event_id"].as_str(),e["channel"].as_str(),e["user"].as_str(),e["ts"].as_str(),root.as_str(),text,thread,turn,kind,json!(files).to_string()])?;
            if valid {
                for (i, file) in files.iter().enumerate() {
                    db.execute(
                        "INSERT INTO slack_media(turn,position,remote,upload) VALUES(?,?,?,?)",
                        params![turn, i as i64, file.as_str(), new_id()],
                    )?;
                }
            }
        }
        Ok(())
    })?;
    Ok(ack)
}
pub fn finish(db: &Connection, row: &Value, text: &str, notice: Option<&str>) -> Result<()> {
    let text = if text.trim().is_empty() {
        "Task finished without a text reply.".into()
    } else if text.encode_utf16().count() > 64000 {
        format!(
            "{}\n[Balasan dipotong. Baca text lengkap in Briefsip.]",
            text.chars().take(30000).collect::<String>()
        )
    } else {
        text.to_owned()
    };
    let id = notice.unwrap_or_else(|| string(row, "turn"));
    let write = || {
        if one(db, "SELECT text FROM slack_outbox WHERE id=?", [id])?
            .is_some_and(|r| r["text"] != text)
        {
            return Err(error(409, "Slack reply conflict"));
        }
        db.execute(
            "INSERT OR IGNORE INTO slack_outbox(id,channel,sender,root,text) VALUES(?,?,?,?,?)",
            params![
                id,
                row["channel"].as_str(),
                row["sender"].as_str(),
                row["root"].as_str(),
                text
            ],
        )?;
        if notice.is_none() {
            db.execute(
                "UPDATE slack_inbox SET status='done' WHERE event=?",
                [string(row, "event")],
            )?;
        }
        Ok(())
    };
    if db.is_autocommit() {
        transaction(db, write)
    } else {
        write()
    }
}
async fn session(db: &Connection, api: &Api, method: &str) -> Result<Value> {
    loop {
        let until = one(
            db,
            "SELECT until FROM slack_session_cooldowns WHERE method=?",
            [method],
        )?
        .map(|r| number(&r, "until"))
        .unwrap_or(0);
        if until > crate::config::now() {
            tokio::time::sleep(Duration::from_millis(
                (until - crate::config::now()).min(60000) as u64,
            ))
            .await;
            continue;
        }
        match api.call(method, &json!({})).await {
            Err(e) if e.status == 429 => {
                if let Some(seconds) = e.details.as_ref().and_then(|v| v["retryAfter"].as_i64()) {
                    db.execute("INSERT INTO slack_session_cooldowns VALUES(?,?) ON CONFLICT(method) DO UPDATE SET until=max(until,excluded.until)",params![method,crate::config::now()+seconds*1000])?;
                } else {
                    return Err(e);
                }
            }
            r => return r,
        }
    }
}
async fn media(
    db: &Connection,
    api: &Api,
    local: &Local,
    base: &str,
    row: &Value,
) -> Result<Vec<Value>> {
    let files = all(
        db,
        "SELECT turn,position,remote,upload,name FROM slack_media WHERE turn=? ORDER BY position",
        [string(row, "turn")],
    )?;
    let mut total = 0;
    let mut uploads = vec![];
    for file in files {
        let mut stored = db.query_row(
            "SELECT bytes,name FROM slack_media WHERE turn=? AND position=?",
            params![row["turn"].as_str(), file["position"].as_i64()],
            |r| {
                Ok((
                    r.get::<_, Option<Vec<u8>>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                ))
            },
        )?;
        if stored.0.is_none() {
            local.request(&format!("{base}/threads"), None).await?;
            let info = api
                .call("files.info", &json!({"file":file["remote"]}))
                .await?;
            let info = &info["file"];
            if info["id"] != file["remote"]
                || info["is_external"] != false
                || info["mode"] != "hosted"
                || info["size"].as_u64().is_none_or(|n| n > 10 * 1024 * 1024)
                || string(info, "name").trim().is_empty()
                || string(info, "name").encode_utf16().count() > 200
                || string(info, "name")
                    .chars()
                    .any(|c| c < ' ' || c == '/' || c == '\\')
            {
                return Err(error(415, "Invalid Slack file"));
            }
            local.request(&format!("{base}/threads"), None).await?;
            let bytes = api
                .download(
                    info.get("url_private_download")
                        .and_then(Value::as_str)
                        .unwrap_or_else(|| string(info, "url_private")),
                )
                .await?;
            super::media::validate(&bytes)?;
            db.execute(
                "UPDATE slack_media SET bytes=?,name=? WHERE turn=? AND position=?",
                params![
                    bytes,
                    info["name"].as_str(),
                    row["turn"].as_str(),
                    file["position"].as_i64()
                ],
            )?;
            stored = (Some(bytes), Some(string(info, "name").into()));
        }
        let bytes = stored.0.ok_or_else(Failure::storage)?;
        if !super::media::image(&bytes) && !bytes.starts_with(b"%PDF-") {
            total += bytes.len();
        }
        if total > 32 * 1024 {
            return Err(error(415, "Combined attachment too large"));
        }
        uploads.push((
            file["upload"].clone(),
            bytes,
            stored.1.ok_or_else(Failure::storage)?,
        ));
    }
    let mut ids = vec![];
    for (id, bytes, name) in uploads {
        local
            .send(
                &format!(
                    "{base}/threads/{}/files/{}",
                    string(row, "thread"),
                    id.as_str().unwrap_or("")
                ),
                Some(bytes),
                Some(&name),
            )
            .await?;
        ids.push(id);
    }
    Ok(ids)
}
async fn process(db: &Connection, local: &Local, api: &Api, base: &str, row: &Value) -> Result<()> {
    if row["kind"] == "media-invalid" {
        return finish(
            db,
            row,
            "Invalid attachment. Send at most four different files.",
            None,
        );
    }
    let media_input = row["kind"] == "media";
    let text = string(row, "text");
    if !media_input && super::workflow::handle(db, "slack", base, row, local).await? {
        return Ok(());
    }
    if !media_input && row["status"] == "queued" {
        if text == "!status" {
            let active=all(db,"SELECT turn,status FROM slack_inbox WHERE channel=? AND sender=? AND root=? AND event<>? AND status IN('queued','submitting','running') ORDER BY rowid LIMIT 20",[string(row,"channel"),string(row,"sender"),string(row,"root"),string(row,"event")])?;
            return finish(
                db,
                row,
                &if active.is_empty() {
                    "No active tasks in this thread.".into()
                } else {
                    active
                        .iter()
                        .map(|r| {
                            format!(
                                "{}: {}\n!stop {}",
                                string(r, "turn"),
                                string(r, "status"),
                                string(r, "turn")
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n\n")
                },
                None,
            );
        }
        if text.starts_with("!stop") {
            let id = text.strip_prefix("!stop ").filter(|id| uuid(id));
            let target = if let Some(id) = id {
                one(db,"SELECT * FROM slack_inbox WHERE turn=? AND channel=? AND sender=? AND root=? AND event<>? AND status IN('queued','submitting','running')",[id,string(row,"channel"),string(row,"sender"),string(row,"root"),string(row,"event")])?
            } else {
                None
            };
            let Some(target) = target else {
                return finish(
                    db,
                    row,
                    "Active task not found in this thread. Use !status to see task IDs.",
                    None,
                );
            };
            if target["status"] == "queued" {
                db.execute(
                    "UPDATE slack_inbox SET status='cancelled' WHERE event=?",
                    [string(&target, "event")],
                )?;
                return finish(
                    db,
                    row,
                    "Task cancelled before being sent to the agent.",
                    None,
                );
            }
            local
                .request(
                    &format!(
                        "{base}/threads/{}/turns/{}/cancel",
                        string(&target, "thread"),
                        string(&target, "turn")
                    ),
                    Some(&json!({"id":row["turn"]})),
                )
                .await?;
            return finish(
                db,
                row,
                "Cancellation request accepted. Already-created results remain saved.",
                None,
            );
        }
        if text.starts_with("!answer") {
            let p: Vec<_> = text.splitn(3, ' ').collect();
            let q = if p.len() == 3 && uuid(p[1]) && p[2].encode_utf16().count() <= 4000 {
                one(db,"SELECT * FROM slack_questions WHERE id=? AND channel=? AND sender=? AND root=?",[p[1],string(row,"channel"),string(row,"sender"),string(row,"root")])?
            } else {
                None
            };
            let Some(q) = q else {
                return finish(
                    db,
                    row,
                    "Question not found in this thread. Use the command on the question.",
                    None,
                );
            };
            local
                .request(
                    &format!(
                        "{base}/threads/{}/turns/{}/questions/{}/answer",
                        string(&q, "thread"),
                        string(&q, "turn"),
                        string(&q, "id")
                    ),
                    Some(&json!({"id":row["turn"],"text":p[2]})),
                )
                .await?;
            return finish(db, row, "Answer received.", None);
        }
    }
    let input = if string(row, "channel").starts_with('D') {
        text.into()
    } else {
        format!("Slack {}: {text}", string(row, "sender"))
    };
    if row["status"] == "queued" && input.encode_utf16().count() > 16000 {
        return finish(db,row,&format!("Message is too long. Maximum {} characters after removing the bot mention. Shorten the message and send it again.",16000-format!("Slack {}: ",string(row,"sender")).encode_utf16().count()),None);
    }
    if ["queued", "submitting"].contains(&string(row, "status")) {
        db.execute(
            "UPDATE slack_inbox SET status='submitting' WHERE event=?",
            [string(row, "event")],
        )?;
        local.request(&format!("{base}/threads"),Some(&json!({"id":row["thread"],"name":format!("Slack {}",if string(row,"channel").starts_with('D'){string(row,"sender")}else{string(row,"channel")})}))).await?;
        let mut body = json!({"id":row["turn"],"text":input});
        if media_input {
            match media(db,api,local,base,row).await{Ok(files)=>body["files"]=json!(files),Err(e)if [400,413,415].contains(&e.status)=>return finish(db,row,"Attachment cannot be processed. Use at most four files: UTF-8 text or combined PDF text up to 32 KiB (PDF up to 10 MiB), or PNG/JPEG/WebP images up to 4 MiB each.",None),Err(e)=>return Err(e)}
        }
        local
            .request(
                &format!("{base}/threads/{}/turns", string(row, "thread")),
                Some(&body),
            )
            .await?;
        db.execute(
            "UPDATE slack_inbox SET status='running' WHERE event=?",
            [string(row, "event")],
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
        db.execute(
            "INSERT OR IGNORE INTO slack_questions VALUES(?,?,?,?,?,?)",
            [
                string(q, "id"),
                string(row, "channel"),
                string(row, "sender"),
                string(row, "root"),
                string(row, "thread"),
                string(row, "turn"),
            ],
        )?;
        db.execute(
            "INSERT OR IGNORE INTO slack_question_choices VALUES(?,?)",
            params![q["id"].as_str(), q["choices"].to_string()],
        )?;
        let prior = one(
            db,
            "SELECT text FROM slack_outbox WHERE id=?",
            [string(q, "id")],
        )?;
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
        finish(
            db,
            row,
            &prior.map(|r| string(&r, "text").into()).unwrap_or_else(|| {
                format!(
                    "{}{}\n\nReply in this thread: !answer {} answer",
                    string(q, "prompt"),
                    choices,
                    string(q, "id")
                )
            }),
            Some(string(q, "id")),
        )?;
    }
    if ["done", "failed", "cancelled"].contains(&string(turn, "status")) {
        super::media::snapshot(db, "slack", base, row, turn, local, None).await?;
        finish(
            db,
            row,
            if turn["status"] == "done" {
                string(turn, "reply")
            } else if turn["status"] == "cancelled" {
                "Task cancelled."
            } else {
                "Task failed. Check details in Briefsip."
            },
            None,
        )?;
    }
    Ok(())
}
async fn deliver(db: &Connection, local: &Local, api: &Api, base: &str, row: &Value) -> Result<()> {
    let id = string(row, "id");
    let document=one(db,"SELECT d.thread,d.turn,d.file,d.name,d.stage,d.remote,d.url,w.run FROM slack_documents d LEFT JOIN slack_document_workflows w ON w.id=d.id WHERE d.id=?",[id])?;
    if document.is_none()
        && one(
            db,
            "SELECT until FROM slack_delivery_cooldown WHERE id=1",
            [],
        )?
        .is_some_and(|r| number(&r, "until") > crate::config::now())
    {
        return Ok(());
    }
    let chunks = if document.is_some() {
        vec![String::new(); 3]
    } else {
        super::media::chunks(string(row, "text"), 4000, true)
    };
    let start = document
        .as_ref()
        .map(|d| number(d, "stage"))
        .unwrap_or_else(|| number(row, "part")) as usize;
    let mut timestamps = crate::data::json(&row["timestamps"])?;
    for (part, text) in chunks.iter().enumerate().skip(start) {
        let auth = local
            .request(
                &document
                    .as_ref()
                    .map(|d| super::media::source(base, d))
                    .unwrap_or_else(|| format!("{base}/threads")),
                None,
            )
            .await;
        if let Err(e) = auth {
            if document.is_some() && e.status == 404 {
                db.execute("UPDATE slack_outbox SET status='revoked' WHERE id=?", [id])?;
                return Ok(());
            }
            return Err(e);
        }
        if db.execute(
            "UPDATE slack_outbox SET status='sending' WHERE id=? AND status='queued'",
            [id],
        )? == 0
        {
            return Ok(());
        }
        let result=async{
            if let Some(document)=&document{
                if part==0{let length:i64=db.query_row("SELECT length(bytes) FROM slack_documents WHERE id=?",[id],|r|r.get(0))?;let v=api.call("files.getUploadURLExternal",&json!({"filename":document["name"],"length":length})).await?;if !pattern(r"^F[A-Z0-9]{2,30}$",string(&v,"file_id"))||!v["upload_url"].is_string(){return Err(error(502,"Slack request outcome is uncertain."));}db.execute("UPDATE slack_documents SET remote=?,url=? WHERE id=?",[string(&v,"file_id"),string(&v,"upload_url"),id])?;}
                else if part==1{let row=one(db,"SELECT url FROM slack_documents WHERE id=?",[id])?.ok_or_else(Failure::storage)?;let bytes:Vec<u8>=db.query_row("SELECT bytes FROM slack_documents WHERE id=?",[id],|r|r.get(0))?;let response=api.client.post(api.file_url(string(&row,"url"))?).header("Content-Type","application/octet-stream").body(bytes).timeout(Duration::from_secs(30)).send().await.map_err(|_|error(502,"Slack request outcome is uncertain."))?;if response.status()!=200{return Err(error(if [400,401,403,404,410,413,429].contains(&response.status().as_u16()){400}else{502},"Slack upload failed."));}}
                else{let document=one(db,"SELECT remote,name FROM slack_documents WHERE id=?",[id])?.ok_or_else(Failure::storage)?;let v=api.call("files.completeUploadExternal",&json!({"files":[{"id":document["remote"],"title":document["name"]}],"channel_id":row["channel"],"thread_ts":row["root"],"initial_comment":string(row,"text").replace('&',"&amp;").replace('<',"&lt;").replace('>',"&gt;")})).await?;if !v["files"].as_array().is_some_and(|a|a.len()==1&&a[0]["id"]==document["remote"]){return Err(error(502,"Slack request outcome is uncertain."));}}
                transaction(db,||{db.execute("UPDATE slack_documents SET stage=stage+1 WHERE id=?",[id])?;db.execute("UPDATE slack_outbox SET status=? WHERE id=?",[if part==2{"sent"}else{"queued"},id])?;Ok(())})?;
            }else{
                let mut body=json!({"channel":row["channel"],"thread_ts":row["root"],"text":text,"mrkdwn":false,"parse":"none","link_names":false,"unfurl_links":false,"unfurl_media":false,"reply_broadcast":false});
                if part+1==chunks.len(){let choices=one(db,"SELECT choices FROM slack_question_choices WHERE id=?",[id])?.map(|r|crate::data::json(&r["choices"])).transpose()?.unwrap_or(json!([]));let approval=exists(db,"SELECT 1 FROM slack_approvals WHERE notice=?",[id])?;
                    let elements=if approval{["yes","no"].iter().map(|v|json!({"type":"button","action_id":format!("briefsip_approve_{v}"),"text":{"type":"plain_text","text":if *v=="yes"{"Approve"}else{"Reject"}},"value":format!("approval:{id}:{v}")})).collect::<Vec<_>>()}else{choices.as_array().into_iter().flatten().enumerate().map(|(i,c)|json!({"type":"button","action_id":format!("briefsip_answer_{i}"),"text":{"type":"plain_text","text":format!("{}. {}{}",i+1,c.as_str().unwrap_or("").chars().take(45).collect::<String>(),if c.as_str().unwrap_or("").chars().count()>45{"..."}else{""})},"value":format!("question:{id}:{i}")})).collect()};
                    if !elements.is_empty(){let plain=text.replace("&amp;","&").replace("&lt;","<").replace("&gt;",">").chars().collect::<Vec<_>>();let mut blocks=plain.chunks(2000).map(|c|json!({"type":"section","text":{"type":"plain_text","text":c.iter().collect::<String>(),"emoji":false}})).collect::<Vec<_>>();blocks.push(json!({"type":"actions","elements":elements}));body["blocks"]=json!(blocks);}
                }
                let response=api.call("chat.postMessage",&body).await?;if response["channel"]!=row["channel"]||!stamp(&response["ts"]){return Err(error(502,"Slack request outcome is uncertain."));}timestamps.as_array_mut().ok_or_else(Failure::storage)?.push(response["ts"].clone());db.execute("UPDATE slack_outbox SET status=?,part=?,timestamps=? WHERE id=?",params![if part+1==chunks.len(){"sent"}else{"queued"},(part+1)as i64,timestamps.to_string(),id])?;
            }Ok::<_,Failure>(())
        }.await;
        if let Err(e) = result {
            if e.status == 429 && e.details.as_ref().is_some_and(|v| v["retryAfter"].is_i64()) {
                let seconds = e
                    .details
                    .as_ref()
                    .and_then(|v| v["retryAfter"].as_i64())
                    .ok_or_else(Failure::storage)?;
                transaction(db, || {
                    db.execute("INSERT INTO slack_delivery_cooldown VALUES(1,?) ON CONFLICT(id) DO UPDATE SET until=max(until,excluded.until)",[crate::config::now()+seconds*1000])?;
                    db.execute("UPDATE slack_outbox SET status='queued' WHERE id=?", [id])?;
                    Ok(())
                })?;
            } else {
                db.execute(
                    "UPDATE slack_outbox SET status=? WHERE id=?",
                    [
                        if (400..500).contains(&e.status) {
                            "failed"
                        } else {
                            "uncertain"
                        },
                        id,
                    ],
                )?;
            }
            return Ok(());
        }
    }
    Ok(())
}
async fn work(db: &Connection, options: &Options, local: &Local, api: &Api) -> Result<()> {
    let base = format!("/api/scripts/agents/{}", options.agent);
    super::workflow::callbacks(db, "slack", &base, options, local).await?;
    for row in all(db,"SELECT c.id,c.answer,q.id AS question,q.channel,q.sender,q.root,q.thread,q.turn FROM slack_question_callbacks c JOIN slack_questions q ON q.id=c.question WHERE c.status='queued' ORDER BY c.rowid LIMIT 20",[])?{
        if !allowed(options,string(&row,"sender"))||!channel(options,string(&row,"channel")){db.execute("UPDATE slack_question_callbacks SET status='revoked' WHERE id=?",[string(&row,"id")])?;continue;}
        let result=local.request(&format!("{base}/threads/{}/turns/{}/questions/{}/answer",string(&row,"thread"),string(&row,"turn"),string(&row,"question")),Some(&json!({"id":row["id"],"text":row["answer"]}))).await;
        let text=match result{Ok(_)=>"Answer received.",Err(e)if [400,404,409].contains(&e.status)=>"Answer rejected. Check the question and task status in Briefsip.",Err(e)=>return Err(e)};let mut response=row.clone();response["turn"]=row["id"].clone();finish(db,&response,text,None)?;db.execute("UPDATE slack_question_callbacks SET status='done' WHERE id=?",[string(&row,"id")])?;
    }
    for row in all(db,"SELECT * FROM slack_inbox WHERE status IN('queued','submitting','running') ORDER BY text LIKE '!stop %' DESC,checked,rowid LIMIT 100",[])?{
        if !allowed(options,string(&row,"sender"))||!channel(options,string(&row,"channel")){db.execute("UPDATE slack_inbox SET status='revoked' WHERE event=?",[string(&row,"event")])?;continue;}
        db.execute("UPDATE slack_inbox SET checked=(SELECT coalesce(max(checked),0)+1 FROM slack_inbox) WHERE event=?",[string(&row,"event")])?;
        if let Err(e)=process(db,local,api,&base,&row).await{if ![400,404,409].contains(&e.status){return Err(e);}
if [404,409].contains(&e.status){db.execute("INSERT OR IGNORE INTO slack_closed_threads VALUES(?)",[string(&row,"thread")])?;}finish(db,&row,"Message could not be processed. Check the task in Briefsip; a new message will open a new conversation.",None)?;}
    }
    for row in all(
        db,
        "SELECT * FROM slack_outbox WHERE status='queued' ORDER BY rowid LIMIT 20",
        [],
    )? {
        if !allowed(options, string(&row, "sender")) || !channel(options, string(&row, "channel")) {
            db.execute(
                "UPDATE slack_outbox SET status='revoked' WHERE id=?",
                [string(&row, "id")],
            )?;
            continue;
        }
        deliver(db, local, api, &base, &row).await?;
    }
    Ok(())
}
async fn socket(db: &Connection, options: &Options, url: &str) -> Result<()> {
    let endpoint = url::Url::parse(url).map_err(|_| error(400, "Invalid Slack socket endpoint"))?;
    if !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.fragment().is_some()
        || !(endpoint.scheme() == "wss"
            && endpoint
                .host_str()
                .is_some_and(|h| pattern(r"^wss(?:-[a-z0-9-]+)?\.slack\.com$", h))
            && endpoint.port().is_none_or(|p| p == 443)
            || options
                .origin
                .as_ref()
                .is_some_and(|s| s != "https://slack.com")
                && endpoint.scheme() == "ws"
                && endpoint.host_str() == Some("127.0.0.1")
                && endpoint.port().is_some())
    {
        return Err(error(400, "Invalid Slack socket endpoint"));
    }
    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(20),
        tokio_tungstenite::connect_async(url),
    )
    .await
    .map_err(|_| error(502, "Slack socket handshake timed out"))?
    .map_err(|_| error(502, "Slack socket connection failed"))?;
    let mut ready = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let next = if ready {
            socket.next().await
        } else {
            tokio::time::timeout_at(deadline, socket.next())
                .await
                .map_err(|_| error(502, "Slack socket handshake timed out"))?
        };
        let Some(message) = next else {
            return Ok(());
        };
        let message = message.map_err(|_| error(502, "Slack socket connection failed"))?;
        match message {
            tokio_tungstenite::tungstenite::Message::Text(text) => {
                if text.len() > 2 * 1024 * 1024 {
                    return Err(error(400, "Invalid Slack socket message"));
                }
                let v: Value = serde_json::from_str(&text)
                    .map_err(|_| error(400, "Slack socket event rejected; journal retained"))?;
                if v["type"] == "hello" {
                    if v["connection_info"]["app_id"] != options.app.as_deref().unwrap_or("") {
                        return Err(error(400, "Slack app identity mismatch"));
                    }
                    ready = true;
                    continue;
                }
                if !ready {
                    return Err(error(400, "Slack socket event before handshake"));
                }
                if v["type"] == "disconnect" {
                    if v["reason"] == "link_disabled" {
                        return Err(error(400, "Slack Socket Mode disabled"));
                    }
                    return Ok(());
                }
                if let Some(id) = record(db, &v, options)? {
                    socket
                        .send(tokio_tungstenite::tungstenite::Message::Text(
                            json!({"envelope_id":id}).to_string().into(),
                        ))
                        .await
                        .map_err(|_| error(502, "Slack socket acknowledgement failed"))?;
                }
            }
            tokio_tungstenite::tungstenite::Message::Close(_) => return Ok(()),
            _ => (),
        }
    }
}
pub async fn run(db: &Connection, options: &Options) -> Result<()> {
    if options.users.iter().any(|u| {
        !u.as_str()
            .is_some_and(|s| pattern(r"^[UW][A-Z0-9]{2,30}$", s))
    }) {
        return Err(error(400, "Slack requires distinct allowed users"));
    }
    if options.channels.len() > 100
        || options
            .channels
            .iter()
            .enumerate()
            .any(|(i, c)| !pattern(r"^[CG][A-Z0-9]{2,30}$", c) || options.channels[..i].contains(c))
    {
        return Err(error(400, "Invalid Slack channels"));
    }
    let api = Api::new(options)?;
    let auth = session(db, &api, "auth.test").await?;
    if auth["team_id"] != options.team.as_deref().unwrap_or("")
        || string(&auth, "bot_id").is_empty()
    {
        return Err(error(400, "Slack bot identity mismatch"));
    }
    let (team, app, bot) = (
        options.team.as_deref().unwrap_or(""),
        options.app.as_deref().unwrap_or(""),
        string(&auth, "user_id"),
    );
    if !pattern(r"^T[A-Z0-9]{2,30}$", team)
        || !pattern(r"^A[A-Z0-9]{2,30}$", app)
        || !pattern(r"^U[A-Z0-9]{2,30}$", bot)
    {
        return Err(error(400, "Invalid Slack binding"));
    }
    if one(db, "SELECT * FROM slack_binding", [])?.is_some_and(|r| {
        r["team"] != team || r["app"] != app || r["bot"] != bot || r["agent"] != options.agent
    }) {
        return Err(error(409, "Slack journal identity mismatch"));
    }
    db.execute(
        "INSERT OR IGNORE INTO slack_binding VALUES(1,?,?,?,?)",
        [team, app, bot, &options.agent],
    )?;
    let local = Local::read(&options.script_directory)
        .map_err(|_| error(403, "Script discovery is unavailable or unsafe."))?;
    local
        .request(
            &format!("/api/scripts/agents/{}/threads", options.agent),
            None,
        )
        .await?;
    let listen = async {
        loop {
            let connection = session(db, &api, "apps.connections.open").await?;
            socket(db, options, string(&connection, "url")).await?;
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        #[allow(unreachable_code)]
        Ok::<(), Failure>(())
    };
    let worker = async {
        loop {
            work(db, options, &local, &api).await?;
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        #[allow(unreachable_code)]
        Ok::<(), Failure>(())
    };
    tokio::try_join!(listen, worker)?;
    Ok(())
}
