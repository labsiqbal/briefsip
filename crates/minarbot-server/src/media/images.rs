use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
const UNCERTAIN:&str="Image generation result is uncertain. Check the service before requesting a new image; resuming the task does not repeat this request.";
pub(super) async fn response(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    if !response.status().is_success() {
        return Err(error(502, "Media provider failed."));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| error(502, "Media provider failed."))?
    {
        if bytes.len() + chunk.len() > limit {
            return Err(error(502, "Media response exceeds the limit."));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
pub async fn generate(state: &AppState, turn: &Value, call: &Value, args: &Value) -> Result<Value> {
    let config = state
        .config
        .media
        .image_provider
        .as_ref()
        .ok_or_else(|| error(503, "Image provider is not configured yet."))?;
    if !closed(args, &["prompt"])
        || string(args, "prompt").trim().is_empty()
        || string(args, "prompt").encode_utf16().count() > 16000
    {
        return Err(error(400, "Invalid image prompt."));
    }
    let url = config
        .endpoint("/images/generations")
        .map_err(|_| Failure::storage())?;
    let seq = {
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        let db = &guard.connection;
        transaction(db, || {
            if !exists(
                db,
                "SELECT 1 FROM turns WHERE id=? AND agent=? AND status='running'",
                [string(turn, "id"), string(turn, "agent")],
            )? {
                return Err(error(409, "Image generation cancelled."));
            }
            if exists(
                db,
                "SELECT 1 FROM image_generations WHERE turn=? AND uncertain=1",
                [string(turn, "id")],
            )? {
                return Err(error(502, UNCERTAIN));
            }
            capacity(db, string(turn, "id"))?;
            db.execute(
                "INSERT INTO image_generations VALUES(?,?,NULL,1)",
                [string(turn, "id"), string(call, "id")],
            )?;
            tools::journal(db, turn, call, &json!({"uncertain":true,"error":UNCERTAIN}))?;
            db.execute("INSERT INTO provider_calls(turn,agent,model,origin,purpose,phase,family,status,created) VALUES(?,?,?,?,'completion','image','openai-images','pending',?)",params![string(turn,"id"),string(turn,"agent"),config.model,url.origin().ascii_serialization(),iso(db,state.config.now())?])?;
            Ok(db.last_insert_rowid())
        })?
    };
    let mut tokens = [None; 3];
    let operation = async {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| Failure::storage())?;
        let mut request=client.post(url).json(&json!({"model":config.model,"prompt":args["prompt"],"n":1,"size":"1024x1024","output_format":"png"}));
        if let Some(key) = &config.api_key {
            request = request.bearer_auth(key);
        }
        let bytes = response(
            request.send().await.map_err(|_| error(502, UNCERTAIN))?,
            6 * 1024 * 1024,
        )
        .await?;
        let data: Value = serde_json::from_slice(&bytes).map_err(|_| error(502, UNCERTAIN))?;
        let rows = data["data"]
            .as_array()
            .filter(|v| v.len() == 1)
            .ok_or_else(|| error(502, UNCERTAIN))?;
        let encoded = string(&rows[0], "b64_json");
        let image = STANDARD
            .decode(encoded)
            .map_err(|_| error(502, UNCERTAIN))?;
        if image.len() > 4 * 1024 * 1024
            || STANDARD.encode(&image) != encoded
            || crate::files::attachments::image_type(&image) != Some("image/png")
            || config
                .api_key
                .as_ref()
                .is_some_and(|k| !k.is_empty() && image.windows(k.len()).any(|b| b == k.as_bytes()))
        {
            return Err(error(502, UNCERTAIN));
        }
        tokens = usage(&data["usage"]);
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        let db = &guard.connection;
        transaction(db, || {
            if !exists(
                db,
                "SELECT 1 FROM turns WHERE id=? AND agent=? AND status='running'",
                [string(turn, "id"), string(turn, "agent")],
            )? {
                return Err(error(409, "Image generation cancelled."));
            }
            capacity(db, string(turn, "id"))?;
            let id = uuid::Uuid::new_v4().to_string();
            let scope = execution::scope(turn);
            db.execute("INSERT INTO files(id,scope,name,digest,bytes,created) VALUES(?,?,'generated-image.png',?,?,?)",params![id,scope,format!("{:x}",Sha256::digest(&image)),image,iso(db,state.config.now())?])?;
            let result = json!({"id":id,"name":"generated-image.png","size":image.len(),"mimeType":"image/png","downloadUrl":format!("/api/{}/files/{id}",scope.replace(':',"/"))});
            db.execute(
                "UPDATE image_generations SET file=?,uncertain=0 WHERE turn=? AND call=?",
                [&id, string(turn, "id"), string(call, "id")],
            )?;
            db.execute(
                "UPDATE flow_tool_calls SET result=? WHERE turn=? AND call_id=?",
                [
                    result.to_string(),
                    string(turn, "id").into(),
                    string(call, "id").into(),
                ],
            )?;
            db.execute("UPDATE provider_calls SET status='received',finished=?,input_tokens=?,output_tokens=?,total_tokens=? WHERE seq=?",params![iso(db,state.config.now())?,tokens[0],tokens[1],tokens[2],seq])?;
            Ok(result)
        })
    };
    let result = tokio::time::timeout(
        std::time::Duration::from_millis(state.config.data.timeout.unwrap_or(120000)),
        operation,
    )
    .await
    .unwrap_or_else(|_| Err(error(502, UNCERTAIN)));
    if result.is_err() {
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        guard.connection.execute(
            "UPDATE provider_calls SET status='failed',finished=?,input_tokens=?,output_tokens=?,total_tokens=? WHERE seq=? AND status='pending'",
            params![iso(&guard.connection, state.config.now())?, tokens[0], tokens[1], tokens[2], seq],
        )?;
    }
    result.map_err(|_| error(502, UNCERTAIN))
}

fn usage(value: &Value) -> [Option<i64>; 3] {
    ["input_tokens", "output_tokens", "total_tokens"].map(|key| {
        value[key]
            .as_i64()
            .filter(|n| (0..=1_000_000_000).contains(n))
    })
}
fn capacity(db: &Connection, turn: &str) -> Result<()> {
    let mut count = db.query_row("SELECT (SELECT count(*) FROM generated_files WHERE turn=?)+(SELECT count(*) FROM image_generations WHERE turn=? AND file IS NOT NULL)", [turn, turn], |r| r.get::<_, i64>(0))?;
    if exists(
        db,
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mcp_files'",
        [],
    )? {
        count += db.query_row("SELECT count(*) FROM mcp_files WHERE turn=?", [turn], |r| {
            r.get::<_, i64>(0)
        })?;
    }
    if count >= 8 {
        return Err(error(429, "Task file limit reached."));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_counts_and_file_cap_include_mcp() -> Result<()> {
        assert_eq!(
            usage(&json!({"input_tokens":0,"output_tokens":1.5,"total_tokens":1_000_000_001i64})),
            [Some(0), None, None]
        );
        assert_eq!(
            usage(&json!({"input_tokens":-1,"output_tokens":"2","total_tokens":1_000_000_000})),
            [None, None, Some(1_000_000_000)]
        );
        let db = Connection::open_in_memory()?;
        db.execute_batch("CREATE TABLE generated_files(turn TEXT);CREATE TABLE image_generations(turn TEXT,file TEXT);INSERT INTO image_generations VALUES('fixture',NULL);")?;
        capacity(&db, "fixture")?;
        db.execute_batch("CREATE TABLE mcp_files(turn TEXT);WITH RECURSIVE n(i) AS(VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<8) INSERT INTO mcp_files SELECT 'fixture' FROM n;")?;
        assert_eq!(capacity(&db, "fixture").err().map(|e| e.status), Some(429));
        capacity(&db, "other")?;
        Ok(())
    }
}
