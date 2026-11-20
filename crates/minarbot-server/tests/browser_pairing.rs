use reqwest::{header, redirect::Policy, StatusCode};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::Duration,
};

struct Server {
    child: Child,
    data: PathBuf,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.data);
    }
}

#[tokio::test]
async fn pairing_gates_remote_routes_without_locking_out_loopback(
) -> Result<(), Box<dyn std::error::Error>> {
    const HOST: &str = "minarbot.example";
    const ORIGIN: &str = "https://minarbot.example";
    let data = std::env::temp_dir().join(format!("minarbot-pairing-{}", uuid::Uuid::new_v4()));
    let child = Command::new(env!("CARGO_BIN_EXE_minarbot-server"))
        .arg("--test-config")
        .env("MINARBOT_TEST_SERVER", "rust")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    let mut server = Server { child, data };
    let config = json!({
        "database": server.data.join("minarbot.sqlite"),
        "port": 0,
        "allowedOrigins": [ORIGIN]
    });
    write!(
        server.child.stdin.take().ok_or("server stdin missing")?,
        "{config}"
    )?;
    let mut output = BufReader::new(server.child.stdout.take().ok_or("server stdout missing")?);
    let mut line = String::new();
    output.read_line(&mut line)?;
    let local = line
        .trim()
        .strip_prefix("Minarbot: ")
        .ok_or("server did not report its origin")?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(5))
        .build()?;

    let manage = format!("{local}/api/device-pairing");
    let agents = format!("{local}/api/agents");
    let status = client
        .get(&manage)
        .header(header::HOST, HOST)
        .send()
        .await?;
    assert_eq!(status.json::<Value>().await?["required"], false);
    assert_eq!(
        client
            .get(&agents)
            .header(header::HOST, HOST)
            .send()
            .await?
            .status(),
        StatusCode::OK
    );

    let locked = client
        .post(&manage)
        .header(header::HOST, HOST)
        .header(header::ORIGIN, ORIGIN)
        .json(&json!({"required":true}))
        .send()
        .await?;
    assert_eq!(locked.status(), StatusCode::FORBIDDEN);
    assert_eq!(locked.json::<Value>().await?["code"], "pair_browser_first");

    let issue = client
        .post(format!("{manage}/code"))
        .header(header::ORIGIN, local)
        .json(&json!({}))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    assert_eq!(issue["url"], format!("{ORIGIN}/pair"));
    assert!(issue["qr"]
        .as_str()
        .ok_or("pairing response has no QR code")?
        .starts_with("data:image/svg+xml;base64,"));

    client
        .post(&manage)
        .header(header::ORIGIN, local)
        .json(&json!({"required":true}))
        .send()
        .await?
        .error_for_status()?;
    assert_eq!(client.get(&agents).send().await?.status(), StatusCode::OK);
    assert_eq!(
        client
            .get(&agents)
            .header("x-forwarded-for", "100.64.0.1")
            .send()
            .await?
            .status(),
        StatusCode::UNAUTHORIZED
    );

    for path in ["/api/agents", "/api/environment", "/api/machines"] {
        let response = client
            .get(format!("{local}{path}"))
            .header(header::HOST, HOST)
            .send()
            .await?;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
        assert_eq!(
            response.json::<Value>().await?["code"],
            "device_pairing_required"
        );
    }
    let page = client.get(local).header(header::HOST, HOST).send().await?;
    assert_eq!(page.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(page.headers()[header::REFERRER_POLICY], "same-origin");
    assert!(page.text().await?.contains("Pair this device"));

    let paired = client
        .post(format!("{local}/pair"))
        .header(header::HOST, HOST)
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(format!(
            "code={}&name=Test+phone",
            issue["code"]
                .as_str()
                .ok_or("pairing response has no code")?
        ))
        .send()
        .await?;
    assert_eq!(paired.status(), StatusCode::SEE_OTHER);
    let cookie = paired.headers()[header::SET_COOKIE].to_str()?;
    assert!(cookie.ends_with("; HttpOnly; Secure; SameSite=Strict"));
    let cookie = cookie.split(';').next().ok_or("empty pairing cookie")?;
    assert_eq!(
        client
            .get(&agents)
            .header(header::HOST, HOST)
            .header(header::COOKIE, cookie)
            .send()
            .await?
            .status(),
        StatusCode::OK
    );
    let status = client
        .get(&manage)
        .header(header::HOST, HOST)
        .header(header::COOKIE, cookie)
        .send()
        .await?
        .json::<Value>()
        .await?;
    assert_eq!(status["devices"][0]["name"], "Test phone");
    assert_eq!(status["devices"][0]["id"], status["current"]);
    client
        .post(format!("{manage}/revoke"))
        .header(header::ORIGIN, local)
        .json(&json!({"id":status["current"]}))
        .send()
        .await?
        .error_for_status()?;
    assert_eq!(
        client
            .get(&agents)
            .header(header::HOST, HOST)
            .header(header::COOKIE, cookie)
            .send()
            .await?
            .status(),
        StatusCode::UNAUTHORIZED
    );
    Ok(())
}
