use super::runner::{new_id, Local};
use super::*;
use std::time::Duration;
pub fn validate(bytes: &[u8]) -> Result<()> {
    if bytes.len() > 10 * 1024 * 1024 {
        return Err(error(413, "Attachment too large"));
    }
    if image(bytes) {
        if bytes.len() > 4 * 1024 * 1024 {
            return Err(error(413, "Image attachment too large"));
        }
    } else if !bytes.starts_with(b"%PDF-")
        && (bytes.len() > 32 * 1024
            || std::str::from_utf8(bytes).ok().is_none_or(|s| {
                s.chars()
                    .any(|c| matches!(c,'\x00'..='\x08'|'\x0b'..='\x0c'|'\x0e'..='\x1f'))
            }))
    {
        return Err(error(415, "Attachment is invalid."));
    }
    Ok(())
}
pub fn image(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"\xff\xd8\xff")
        || bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP")
}
pub fn chunks(text: &str, max: usize, escape: bool) -> Vec<String> {
    let mut result = vec![];
    let (mut chunk, mut width) = (String::new(), 0);
    for c in text.chars() {
        let safe = if escape {
            match c {
                '&' => "&amp;".into(),
                '<' => "&lt;".into(),
                '>' => "&gt;".into(),
                c => c.to_string(),
            }
        } else {
            c.to_string()
        };
        let n = safe.encode_utf16().count();
        if width + n > max {
            result.push(chunk);
            chunk = String::new();
            width = 0;
        }
        chunk.push_str(&safe);
        width += n;
    }
    if !chunk.is_empty() {
        result.push(chunk);
    }
    result
}
pub fn source(base: &str, row: &Value) -> String {
    if row["run"].is_string() {
        format!(
            "{base}/workflow-runs/{}/files/{}?metadata=1",
            string(row, "run"),
            string(row, "file")
        )
    } else {
        format!(
            "{base}/threads/{}/turns/{}/files/{}?metadata=1",
            string(row, "thread"),
            string(row, "turn"),
            string(row, "file")
        )
    }
}
pub async fn snapshot(
    db: &Connection,
    platform: &str,
    base: &str,
    row: &Value,
    turn: &Value,
    local: &Local,
    run: Option<&str>,
) -> Result<()> {
    let documents = format!("{platform}_documents");
    for file in turn["generatedFiles"].as_array().into_iter().flatten() {
        if file["size"].as_u64().is_none_or(|n| n > 10 * 1024 * 1024) {
            continue;
        }
        let mut document = one(
            db,
            &format!("SELECT id,name FROM {documents} WHERE turn=? AND file=?"),
            [string(row, "turn"), string(file, "id")],
        )?;
        if document.is_none() {
            let path = if let Some(run) = run {
                format!("{base}/workflow-runs/{run}/files/{}", string(file, "id"))
            } else {
                format!(
                    "{base}/threads/{}/turns/{}/files/{}",
                    string(row, "thread"),
                    string(row, "turn"),
                    string(file, "id")
                )
            };
            let bytes =
                super::runner::bytes(local.send(&path, None, None).await?, 10 * 1024 * 1024)
                    .await?;
            let id = new_id();
            db.execute(
                &format!(
                    "INSERT INTO {documents}(id,turn,thread,file,name,bytes) VALUES(?,?,?,?,?,?)"
                ),
                params![
                    id,
                    row["turn"].as_str(),
                    row["thread"].as_str(),
                    file["id"].as_str(),
                    file["name"].as_str(),
                    bytes
                ],
            )?;
            document = Some(json!({"id":id,"name":file["name"]}));
        }
        let document = document.ok_or_else(Failure::storage)?;
        if let Some(run) = run {
            db.execute(
                &format!("INSERT OR IGNORE INTO {platform}_document_workflows VALUES(?,?)"),
                [string(&document, "id"), run],
            )?;
        }
        let text = format!(
            "{}File: {}",
            if turn["status"] == "done" {
                ""
            } else {
                "Partial result. "
            },
            string(&document, "name")
        );
        if platform == "slack" {
            super::slack::finish(db, row, &text, Some(string(&document, "id")))?;
        } else {
            db.execute("INSERT OR IGNORE INTO telegram_outbox(id,chat,reply_to,text,status) VALUES(?,?,?,?,'queued')",params![document["id"].as_str(),row["chat"].as_i64(),row["message"].as_i64(),text])?;
        }
    }
    Ok(())
}
pub async fn telegram_document(
    client: &reqwest::Client,
    origin: &str,
    token: &str,
    row: &Value,
    name: &str,
    bytes: Vec<u8>,
) -> Result<Value> {
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(name.to_owned())
        .mime_str("application/octet-stream")
        .map_err(|_| Failure::storage())?;
    let mut form = reqwest::multipart::Form::new()
        .text("chat_id", row["chat"].to_string())
        .text(
            "reply_parameters",
            json!({"message_id":row["reply_to"],"allow_sending_without_reply":false}).to_string(),
        )
        .text("disable_content_type_detection", "true")
        .part("document", part);
    if string(row, "text").encode_utf16().count() <= 1024 {
        form = form.text("caption", string(row, "text").to_owned());
    }
    let response = client
        .post(format!("{origin}/bot{token}/sendDocument"))
        .multipart(form)
        .timeout(Duration::from_secs(40))
        .send()
        .await
        .map_err(|_| error(502, "Telegram request outcome is uncertain."))?;
    let status = response.status();
    let value: Value =
        serde_json::from_slice(&super::runner::bytes(response, 2 * 1024 * 1024).await?)
            .map_err(|_| error(502, "Telegram request outcome is uncertain."))?;
    if status.is_success() && value["ok"] == true {
        return Ok(value["result"].clone());
    }
    if value["ok"] == false {
        if let Some(code) = value["error_code"]
            .as_u64()
            .filter(|n| (400..500).contains(n))
        {
            return Err(error(
                code as u16,
                format!("Telegram rejected request ({code})."),
            ));
        }
    }
    Err(error(502, "Telegram request outcome is uncertain."))
}
