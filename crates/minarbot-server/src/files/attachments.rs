use super::*;
use axum::{http::StatusCode, response::IntoResponse};
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};

pub fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 24
        && bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10])
        && &bytes[12..16] == b"IHDR"
    {
        return Some("image/png");
    }
    if bytes.len() >= 4 && bytes.starts_with(&[255, 216, 255]) {
        return Some("image/jpeg");
    }
    if bytes.len() >= 16
        && &bytes[..4] == b"RIFF"
        && &bytes[8..12] == b"WEBP"
        && [b"VP8 ".as_slice(), b"VP8L", b"VP8X"].contains(&&bytes[12..16])
    {
        return Some("image/webp");
    }
    None
}
pub fn encode_name(name: &str) -> String {
    name.as_bytes()
        .iter()
        .map(|&b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
pub fn download(name: &str, bytes: Vec<u8>) -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!(
                    "attachment; filename=\"download\"; filename*=UTF-8''{}",
                    encode_name(name)
                ),
            ),
            (header::CONTENT_LENGTH, bytes.len().to_string()),
        ],
        bytes,
    )
        .into_response()
}
fn decode_name(raw: &str) -> Result<String> {
    let mut result = Vec::new();
    let mut bytes = raw.bytes();
    while let Some(b) = bytes.next() {
        result.push(if b == b'%' {
            let (a, b) = (bytes.next(), bytes.next());
            let number = a
                .zip(b)
                .and_then(|(a, b)| (a as char).to_digit(16).zip((b as char).to_digit(16)))
                .ok_or_else(|| error(400, "Invalid file name."))?;
            (number.0 * 16 + number.1) as u8
        } else {
            b
        });
    }
    let name = String::from_utf8(result).map_err(|_| error(400, "Invalid file name."))?;
    if name.trim().is_empty()
        || name.encode_utf16().count() > 200
        || name
            .chars()
            .any(|c| c == '/' || c == '\\' || c <= '\x1f' || c == '\x7f')
        || [".", ".."].contains(&name.as_str())
    {
        return Err(error(400, "Invalid file name."));
    }
    Ok(name)
}
pub struct File {
    pub meta: Value,
    pub bytes: Vec<u8>,
}
pub fn file(db: &Connection, id: &str, scope: &str) -> Result<File> {
    let result=db.query_row("SELECT seq,id,name,digest,bytes,created FROM files WHERE id=? AND scope=? AND deleted=0",[id,scope],|r| {
        let bytes: Vec<u8>=r.get(4)?;
        Ok(File { meta:json!({"seq":r.get::<_,i64>(0)?,"id":r.get::<_,String>(1)?,"name":r.get::<_,String>(2)?,"digest":r.get::<_,String>(3)?,"size":bytes.len(),"created":r.get::<_,String>(5)?,"image":image_type(&bytes).is_some()}),bytes })
    }).optional()?;
    result.ok_or_else(|| error(404, "File not found in this conversation."))
}
pub fn list(db: &Connection, scope: &str, before: i64, panel: bool) -> Result<Vec<Value>> {
    let mut stmt=db.prepare("SELECT seq,id,name,length(bytes),created,substr(bytes,1,24) FROM files WHERE scope=? AND deleted=0 AND seq<? ORDER BY seq DESC LIMIT 100")?;
    let rows=stmt.query_map(rusqlite::params![scope,before],|r| {
        let mut v=json!({"seq":r.get::<_,i64>(0)?,"id":r.get::<_,String>(1)?,"name":r.get::<_,String>(2)?,"size":r.get::<_,i64>(3)?,"image":image_type(&r.get::<_,Vec<u8>>(5)?).is_some()});
        if !panel {v["created"]=json!(r.get::<_,String>(4)?);} Ok(v)
    })?.collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(rows)
}
pub async fn handle(state: &AppState, req: Request, parts: &[&str]) -> Result<Response> {
    let (kind, owner) = (parts[1], parts[2]);
    let id = parts.get(4).copied();
    let scope = format!("{kind}:{owner}");
    {
        let db = state.database.lock().map_err(|_| Failure::storage())?;
        context(&db.connection, kind, owner)?;
    }
    if id.is_some_and(|v| !valid_id(v)) {
        return Err(error(400, "Invalid file ID."));
    }
    let q = query(&req);
    if req.method() == Method::GET && id.is_none() {
        let before = match parameter(&q, "before") {
            Some(v) => v
                .parse::<i64>()
                .ok()
                .filter(|v| *v > 0 && *v <= 9007199254740991)
                .ok_or_else(|| error(400, "Invalid file list position."))?,
            None => 9007199254740991,
        };
        let db = state.database.lock().map_err(|_| Failure::storage())?;
        return Ok(json_response(
            200,
            json!(list(&db.connection, &scope, before, false)?),
        ));
    }
    let id = id.ok_or_else(|| error(405, "File operation is unavailable."))?;
    if req.method() == Method::POST {
        if !crate::allowed(state, crate::text_header(req.headers(), "origin"))
            || crate::text_header(req.headers(), "content-type") != Some("application/octet-stream")
        {
            return Err(error(403, "Upload must originate from Minarbot."));
        }
        let name = decode_name(crate::text_header(req.headers(), "x-file-name").unwrap_or(""))?;
        let oversized = crate::text_header(req.headers(), "content-length")
            .and_then(|v| v.parse::<u64>().ok())
            .is_some_and(|n| n > 10 * 1024 * 1024);
        let script_agent = req
            .extensions()
            .get::<crate::automation::scripts::UploadAgent>()
            .cloned();
        let bytes = axum::body::to_bytes(req.into_body(), 10 * 1024 * 1024)
            .await
            .map_err(|_| {
                error(
                    413,
                    if oversized {
                        "File size limit is 10 MiB."
                    } else {
                        "Data is too large."
                    },
                )
            })?;
        if oversized {
            return Err(error(413, "File size limit is 10 MiB."));
        }
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let mut db = state.database.lock().map_err(|_| Failure::storage())?;
        let result = transaction(&mut db.connection, |db| {
            let current = context(db, kind, owner)?;
            if let Some(agent) = &script_agent {
                crate::automation::scripts::allowed(db, &agent.0)?;
                if kind != "threads" || current["agent"] != agent.0 {
                    return Err(error(404, "Side thread not found for this agent."));
                }
            }
            let old=one(db,"SELECT seq,id,scope,name,digest,length(bytes) AS size,created,deleted FROM files WHERE id=?",[id])?;
            let mut result = if let Some(mut old) = old {
                if old["deleted"] != 0
                    || old["scope"] != scope
                    || old["name"] != name
                    || old["digest"] != digest
                {
                    return Err(error(409, "ID was already used for a different file."));
                }
                if let Some(o) = old.as_object_mut() {
                    o.remove("scope");
                    o.remove("digest");
                    o.remove("deleted");
                }
                old
            } else {
                if current["archived"] == 1 {
                    return Err(error(
                        409,
                        "Restore the conversation before uploading files.",
                    ));
                }
                db.execute(
                    "INSERT INTO files(id,scope,name,digest,bytes,created) VALUES(?,?,?,?,?,?)",
                    rusqlite::params![
                        id,
                        scope,
                        name,
                        digest,
                        bytes.as_ref(),
                        timestamp(db, state.config.now())?
                    ],
                )?;
                one(
                    db,
                    "SELECT seq,id,name,length(bytes) AS size,created FROM files WHERE id=?",
                    [id],
                )?
                .ok_or_else(Failure::storage)?
            };
            result["image"] = json!(image_type(&bytes).is_some());
            Ok(result)
        })?;
        return Ok(json_response(200, result));
    }
    if req.method() == Method::DELETE && parameter(&q, "transcription") != Some("1") {
        if req.headers().contains_key(header::AUTHORIZATION)
            || !crate::allowed(state, crate::text_header(req.headers(), "origin"))
            || req.uri().query().is_some()
        {
            return Err(error(
                403,
                "File deletion requires the local owner in Minarbot.",
            ));
        }
        let mut db = state.database.lock().map_err(|_| Failure::storage())?;
        transaction(&mut db.connection, |db| {
            panel::authorize_file(state, db, kind, owner, id, true)?;
            db.execute(
                "UPDATE files SET bytes=X'',digest='',deleted=1 WHERE id=?",
                [id],
            )?;
            preview::forget(db, id)?;
            Ok(())
        })?;
        return Ok(json_response(200, json!({"id":id,"deleted":true})));
    }
    if req.method() != Method::GET {
        return Err(error(405, "File operation is unavailable."));
    }
    let file = {
        let db = state.database.lock().map_err(|_| Failure::storage())?;
        file(&db.connection, id, &scope)?
    };
    let response = read(state, file, &q).await;
    {
        let db = state.database.lock().map_err(|_| Failure::storage())?;
        context(&db.connection, kind, owner)?;
    }
    response
}
pub async fn read(state: &AppState, file: File, q: &[(String, String)]) -> Result<Response> {
    if parameter(q, "metadata") == Some("1") {
        return Ok(json_response(200, file.meta));
    }
    let name = text(&file.meta, "name");
    match parameter(q, "preview") {
        Some("image") => {
            let mime = image_type(&file.bytes)
                .ok_or_else(|| error(415, "Image preview supports PNG, JPEG and WebP."))?;
            Ok((
                [
                    (header::CONTENT_TYPE, mime),
                    (header::CONTENT_DISPOSITION, "inline"),
                ],
                file.bytes,
            )
                .into_response())
        }
        Some("html" | "render") => {
            let html=preview::html(name,&file.bytes).map_err(|_|error(415,"Visual preview requires a UTF-8 HTML file, up to 256 KiB. Download the original file to open it."))?;
            if parameter(q, "preview") == Some("render") {
                Ok(preview::render(html, true))
            } else {
                Ok(json_response(
                    200,
                    json!({"id":file.meta["id"],"name":name,"html":html}),
                ))
            }
        }
        Some("text") => {
            if file.bytes.starts_with(b"%PDF-") {
                return preview::pdf(state, &file.meta, &file.bytes).await;
            }
            if file.bytes.len() > 256 * 1024 {
                return Err(error(
                    413,
                    "Text preview limit is 256 KiB. Download the file to read it.",
                ));
            }
            let text = std::str::from_utf8(&file.bytes)
                .map_err(|_| {
                    error(
                        415,
                        "Preview only supports UTF-8 text. Download the file to open it.",
                    )
                })?
                .trim_start_matches('\u{feff}');
            if text.chars().any(|c| {
                c <= '\x08' || c == '\x0b' || c == '\x0c' || ('\x0e'..='\x1f').contains(&c)
            }) {
                return Err(error(
                    415,
                    "This file is not displayable text. Download it instead.",
                ));
            }
            Ok(json_response(
                200,
                json!({"id":file.meta["id"],"name":name,"text":text}),
            ))
        }
        _ => Ok(download(name, file.bytes)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_headers_identify_only_supported_formats() {
        let mut png = [0; 24];
        png[..8].copy_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
        png[12..16].copy_from_slice(b"IHDR");
        assert_eq!(image_type(&png), Some("image/png"));
        assert_eq!(image_type(&[255, 216, 255, 224]), Some("image/jpeg"));
        assert_eq!(image_type(b"RIFF0000WEBPVP8 "), Some("image/webp"));
        assert_eq!(image_type(b"<svg></svg>"), None);
        assert_eq!(image_type(&png[..12]), None);
    }
}
