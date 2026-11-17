use super::*;

pub async fn extract(state: &AppState, bytes: &[u8]) -> Result<String> {
    let Some(bridge) = state.config.harness.test_pdf_bridge.as_ref() else {
        return crate::files::preview::extract_pdf(bytes).await;
    };
    if !state.config.harness.test_mode {
        return Err(error(403, "PDF fixture requires test mode."));
    }
    let origin = url::Url::parse(&bridge.origin).map_err(|_| Failure::storage())?;
    if origin.scheme() != "http" || origin.host_str() != Some("127.0.0.1") {
        return Err(error(403, "PDF fixture requires loopback."));
    }
    let response = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(7))
        .build()
        .map_err(|_| Failure::storage())?
        .post(origin)
        .bearer_auth(&bridge.token)
        .body(bytes.to_vec())
        .send()
        .await
        .map_err(|_| error(503, "PDF fixture unavailable."))?;
    let status = response.status().as_u16();
    if response
        .content_length()
        .is_some_and(|n| n > 2 * 1024 * 1024)
    {
        return Err(error(502, "PDF fixture response exceeds limit."));
    }
    let value: Value = response.json().await.map_err(|_| Failure::storage())?;
    if status != 200 {
        return Err(error(status, string(&value, "error")));
    }
    value["text"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(Failure::storage)
}
