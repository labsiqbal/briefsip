use super::*;
use axum::{http::StatusCode, response::IntoResponse, routing::get, Router};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};

#[tokio::test]
async fn redirected_legacy_manifest_still_requires_a_valid_signature() -> crate::db::Result<()> {
    let key = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).map_err(|_| "key generation")?;
    let key = Ed25519KeyPair::from_pkcs8(key.as_ref()).map_err(|_| "key parsing")?;
    let bytes = json!({
        "version":"0.14.0","id":"0.14.0-01234567","commit":"0123456789012345678901234567890123456789",
        "archive":"briefsip-0.14.0-linux-x86_64.tar.gz","sha256":"0".repeat(64),
        "size":1,"notes":"fixture","created":"2026-11-20T00:00:00Z"
    }).to_string();
    let signature = STANDARD.encode(key.sign(bytes.as_bytes()).as_ref());
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let routes = Router::new()
        .route(
            "/legacy/latest/download/{asset}",
            get(
                |axum::extract::Path(asset): axum::extract::Path<String>| async move {
                    (
                        StatusCode::MOVED_PERMANENTLY,
                        [(
                            header::LOCATION,
                            format!("/minarbot/latest/download/{asset}"),
                        )],
                    )
                        .into_response()
                },
            ),
        )
        .route(
            "/minarbot/latest/download/latest.json",
            get(move || async move { bytes }),
        )
        .route(
            "/minarbot/latest/download/latest.json.sig",
            get(move || async move { signature }),
        );
    let server = tokio::spawn(async move { axum::serve(listener, routes).await });
    let outcome = async {
        let feed = Feed::new(
            Some(&format!("{origin}/legacy")),
            Some(&STANDARD.encode(key.public_key().as_ref())),
        )?;
        let manifest = feed.check().await.map_err(|error| error.message)?;
        assert_eq!(manifest.version, "0.14.0");
        let wrong = Feed::new(
            Some(&format!("{origin}/legacy")),
            Some(&STANDARD.encode([1; 32])),
        )?;
        assert_eq!(
            wrong.check().await.err().map(|error| error.code),
            Some(INVALID)
        );
        Ok(())
    }
    .await;
    server.abort();
    outcome
}
