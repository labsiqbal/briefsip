use super::*;
use ring::{aead, hkdf, hmac};
use std::{
    collections::HashMap,
    sync::atomic::{AtomicBool, Ordering},
};

type KeyEntries = HashMap<(String, String), String>;

#[derive(Clone, Default)]
struct Keyring(Arc<Mutex<KeyEntries>>);
impl keys::Store for Keyring {
    fn read(&self, service: &str, name: &str) -> Result<Option<String>> {
        Ok(self
            .0
            .lock()
            .map_err(|_| Failure::storage())?
            .get(&(service.to_owned(), name.to_owned()))
            .cloned())
    }
    fn write(&self, service: &str, name: &str, secret: &str) -> Result<()> {
        self.0
            .lock()
            .map_err(|_| Failure::storage())?
            .insert((service.to_owned(), name.to_owned()), secret.to_owned());
        Ok(())
    }
    fn remove(&self, service: &str, name: &str) -> Result<()> {
        self.0
            .lock()
            .map_err(|_| Failure::storage())?
            .remove(&(service.to_owned(), name.to_owned()));
        Ok(())
    }
}

struct Scratch(PathBuf);
impl Scratch {
    fn create() -> db::Result<Self> {
        let path = std::env::temp_dir().join(format!("briefsip-device-test-{}", request_id()));
        fs::DirBuilder::new().mode(0o700).create(&path)?;
        Ok(Self(path))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Clone)]
struct Fixture {
    state: AppState,
    actor: Arc<Actor>,
    lose_link: Arc<AtomicBool>,
}
impl Fixture {
    fn devices(&self) -> Result<Vec<Value>> {
        let guard = self.state.database.lock().map_err(|_| Failure::storage())?;
        rows(
            &guard.connection,
            "SELECT * FROM devices WHERE account=?",
            [&self.actor.account],
        )
    }

    async fn request(
        axum::extract::State(f): axum::extract::State<Self>,
        req: Request,
    ) -> Response {
        let result = async {
            let path = req.uri().path().to_owned();
            if super::super::host_path(&path) {
                let request = crate::text_header(req.headers(), "x-briefsip-request-id")
                    .unwrap_or("")
                    .to_owned();
                return super::super::host(&f.state, req, &request).await;
            }
            assert_eq!(
                crate::text_header(req.headers(), "authorization"),
                Some("Bearer fixture")
            );
            match path.as_str() {
                "/api/session" => Ok(crate::json_response(
                    200,
                    json!({"ok":true,"data":{"accountId":f.actor.account}}),
                )),
                "/api/devices" => Ok(crate::json_response(
                    200,
                    json!({"ok":true,"data":f.devices()?}),
                )),
                "/api/devices/link-challenges" | "/api/devices/link" => {
                    let body = axum::body::to_bytes(req.into_body(), LIMIT)
                        .await
                        .map_err(|_| Failure::storage())?;
                    let body = crate::web::parse_json(&body)?;
                    let guard = f.state.database.lock().map_err(|_| Failure::storage())?;
                    let db = &guard.connection;
                    if path.ends_with("/link-challenges") {
                        let result = super::super::challenge(db, &f.actor, &body, now())?;
                        Ok(crate::json_response(201, json!({"ok":true,"data":result})))
                    } else {
                        let result = super::super::link(db, &f.actor, &body, now())?;
                        if f.lose_link.swap(false, Ordering::Relaxed) {
                            Err(transport())
                        } else {
                            Ok(super::super::envelope(result))
                        }
                    }
                }
                _ => Err(fail(404, "resource_not_found", "Unknown fixture path.")),
            }
        }
        .await;
        result.unwrap_or_else(|err| {
            crate::json_response(err.status, json!({"ok":false,"error":{"code":err.code}}))
        })
    }

    async fn start(scratch: &Scratch) -> db::Result<(Self, tokio::task::JoinHandle<()>)> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let origin = format!("http://{}", listener.local_addr()?);
        let config: crate::Config =
            serde_json::from_value(json!({"database":scratch.0.join("canonical.sqlite")}))?;
        let db = db::open(&config.database, true, now())?;
        crate::data::initialize_canonical(&db)?;
        crate::computer::initialize_canonical(&db.connection)?;
        let actor = Actor {
            account: request_id(),
            subject: "fixture".into(),
            session: "session-fixture".into(),
            expires: now() + 60000,
        };
        db.connection.execute("INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,'https://fixture.example',?,?)",params![actor.account,actor.subject,now()])?;
        let state = AppState {
            database: Arc::new(Mutex::new(db)),
            origin,
            auth: None,
            computer: Arc::new(crate::computer::Manager::new(&config)?),
            config: Arc::new(config),
            events: crate::events::Hub::new(),
            turns: crate::turns::Runtime::new()?,
            trial_pending: Default::default(),
        };
        let fixture = Self {
            state,
            actor: Arc::new(actor),
            lose_link: Arc::new(AtomicBool::new(false)),
        };
        let router = Router::new()
            .fallback(any(Self::request))
            .with_state(fixture.clone());
        let task = tokio::spawn(async move {
            assert!(axum::serve(listener, router).await.is_ok());
        });
        Ok((fixture, task))
    }
}

#[tokio::test]
async fn retries_enrollment_across_restart_and_refreshes_signed_stream_after_rotation(
) -> db::Result<()> {
    let scratch = Scratch::create()?;
    let (fixture, server) = Fixture::start(&scratch).await?;
    let database = scratch.0.join("home.sqlite");
    let store = Keyring::default();
    let open = || {
        Host::open(
            &database,
            &fixture.state.origin,
            true,
            Box::new(store.clone()),
        )
    };
    let mut home = open()?;
    fixture.lose_link.store(true, Ordering::Relaxed);
    assert_eq!(
        home.enroll("fixture", "new").await.err().map(|e| e.status),
        Some(503)
    );
    assert!(home.identity.pending.is_some());
    let device = home.identity.device_id.clone();
    let pending = fs::read(home.directory.join("identity.json"))?;
    assert!(!String::from_utf8_lossy(&pending).contains("clerkToken"));
    drop(home);
    let mut home = open()?;
    assert_eq!(
        home.enroll("fixture", "new")
            .await
            .map_err(|err| format!("{}: {}", err.code, err.message))?["generation"],
        1
    );
    let signing = home.identity.signing_ref.clone();
    assert_eq!(
        home.enroll("fixture", "reenroll")
            .await
            .map_err(|err| format!("{}: {}", err.code, err.message))?["generation"],
        2
    );
    assert_eq!(home.identity.signing_ref, signing);
    assert_eq!(
        home.enroll("fixture", "rotate")
            .await
            .map_err(|err| format!("{}: {}", err.code, err.message))?["generation"],
        3
    );
    assert_ne!(home.identity.signing_ref, signing);
    let (session, frames) = home.open_stream().await.map_err(|err| err.message)?;
    let status = fixture.devices().map_err(|err| err.message)?;
    assert_eq!(status[0]["status"], "ready");
    assert_eq!(status[0]["id"], device);
    let proof = home
        .signed(
            &format!("/api/devices/{device}/heartbeat"),
            Method::POST,
            String::new(),
            &request_id(),
            Some(&session.token),
        )
        .map_err(|err| err.message)?
        .build()?;
    assert_eq!(
        proof.headers()["authorization"],
        format!("Device {}", session.token)
    );
    assert!(!proof.url().as_str().contains(&session.token));
    drop(frames);
    drop(home);
    let reopened = open()?;
    let keys: i64 =
        reopened
            .db
            .query_row("SELECT count(*) FROM device_enrollment_keys", [], |r| {
                r.get(0)
            })?;
    assert_eq!(keys, 3);
    assert!(Host::open(
        &database,
        &fixture.state.origin,
        true,
        Box::new(Keyring::default())
    )
    .is_err());
    server.abort();
    let _ = server.await;
    Ok(())
}

fn decrypt(
    request: &Value,
    result: &Value,
    private: &keys::Private,
    host_public: &Value,
) -> Result<String> {
    let shared = private.agree(host_public)?;
    let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, text(request, "requestId").as_bytes());
    let prk = salt.extract(&shared);
    let info = [b"briefsip-wait-reveal-v1".as_slice()];
    let mut bytes = [0; 32];
    prk.expand(&info, &aead::AES_256_GCM)
        .map_err(|_| Failure::storage())?
        .fill(&mut bytes)
        .map_err(|_| Failure::storage())?;
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, &bytes).map_err(|_| Failure::storage())?,
    );
    let mut content = decode(&result["ciphertext"], 64)?;
    content.extend(decode(&result["tag"], 16)?);
    let iv = decode(&result["iv"], 12)?
        .try_into()
        .map_err(|_| Failure::storage())?;
    let associated = json!([
        request["requestId"],
        request["waitKey"],
        request["ownerAccountId"],
        request["deviceGeneration"],
        request["secretGeneration"],
        request["expiresAt"]
    ])
    .to_string();
    let plaintext = key
        .open_in_place(
            aead::Nonce::assume_unique_for_key(iv),
            aead::Aad::from(associated.as_bytes()),
            &mut content,
        )
        .map_err(|_| Failure::storage())?;
    String::from_utf8(plaintext.to_vec()).map_err(|_| Failure::storage())
}

#[tokio::test]
async fn signed_stream_handles_bounded_wait_event_and_reveal_without_sending_plaintext(
) -> db::Result<()> {
    let scratch = Scratch::create()?;
    let (fixture, server) = Fixture::start(&scratch).await?;
    let store = Keyring::default();
    let mut home = Host::open(
        &scratch.0.join("home.sqlite"),
        &fixture.state.origin,
        true,
        Box::new(store.clone()),
    )?;
    home.enroll("fixture", "new")
        .await
        .map_err(|err| format!("{}: {}", err.code, err.message))?;
    let (session, mut frames) = home
        .open_stream()
        .await
        .map_err(|err| format!("{}: {}", err.code, err.message))?;
    let descriptor = home
        .identity
        .descriptor
        .clone()
        .ok_or("Missing device descriptor")?;
    let key = request_id();
    let secret = "ab".repeat(32);
    let mut provision = json!({"v":1,"provisionId":key,"waitKey":key,"projectId":request_id(),"agentId":request_id(),
        "sourceDeviceId":home.identity.device_id,"sourceDeviceGeneration":descriptor["deviceGeneration"],
        "authorityGeneration":descriptor["authorityGeneration"],"secretGeneration":1,"event":"ready","deadline":now()+60000,
        "target":{"kind":"turn","taskId":request_id(),"actionId":request_id(),"toolCallId":"call"}});
    provision["payloadDigest"] = digest(&json!(["briefsip-wait-provision-v1", provision])).into();
    let reference = format!("event-wait/{key}/1");
    let key_service = format!(
        "briefsip/{}/{}",
        home.identity.installation_id, home.identity.device_id
    );
    keys::Store::write(&store, &key_service, &reference, &secret)
        .map_err(|err| format!("{}: {}", err.code, err.message))?;
    protected_wait::provision(&home, &provision, false)
        .map_err(|err| format!("{}: {}", err.code, err.message))?;
    protected_wait::provision(&home, &provision, false)
        .map_err(|err| format!("{}: {}", err.code, err.message))?;
    let count: i64 = home
        .db
        .query_row("SELECT count(*) FROM device_wait_secrets", [], |r| r.get(0))?;
    assert_eq!(count, 1);
    let mut stream = protected_wait::Stream::new();
    let request = json!({"waitKey":key,"sourceDeviceId":home.identity.device_id,"deviceGeneration":descriptor["deviceGeneration"],
        "authorityGeneration":descriptor["authorityGeneration"],"secretGeneration":1,"connectionGeneration":session.connection,"expiresAt":now()+60000});
    let client = keys::Private::open(&store, "browser", "ephemeral", true, true)
        .map_err(|err| format!("{}: {}", err.code, err.message))?;
    let mut reveal = request.clone();
    reveal["requestId"] = request_id().into();
    reveal["ownerAccountId"] = fixture.actor.account.clone().into();
    reveal["ephemeralPublicKey"] = B64.encode(client.public()).into();
    let (response, handled) = tokio::join!(waits::request(&fixture.state, &reveal, None), async {
        let frame = frames.next().await?;
        stream
            .handle(&mut home, &session.token, session.connection, &frame)
            .await
    });
    handled.map_err(|err| format!("{}: {}", err.code, err.message))?;
    let sealed = response.map_err(|err| format!("{}: {}", err.code, err.message))?;
    assert!(!sealed.to_string().contains(&secret));
    assert_eq!(
        decrypt(
            &reveal,
            &sealed,
            &client,
            &descriptor["encryptionPublicKey"]
        )
        .map_err(|err| format!("{}: {}", err.code, err.message))?,
        secret
    );

    let mut event = request;
    let mut body = br#"{"event":"ready","payload":{"ok":true}}"#.to_vec();
    body.resize(LIMIT, b' ');
    let at = now() / 1000;
    let delivery = "signed-event";
    let signed = [format!("{at}\n{delivery}\n").as_bytes(), &body].concat();
    let signature: String = hmac::sign(
        &hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes()),
        &signed,
    )
    .as_ref()
    .iter()
    .map(|b| format!("{b:02x}"))
    .collect();
    event["byteLength"] = body.len().into();
    event["bodyDigest"] = byte_digest(&body).into();
    event["headers"] = json!({"x-briefsip-time":at.to_string(),"x-briefsip-id":delivery,"x-briefsip-signature":signature});
    let (response, handled) =
        tokio::join!(waits::request(&fixture.state, &event, Some(&body)), async {
            for _ in 0..3 {
                let frame = frames.next().await?;
                stream
                    .handle(&mut home, &session.token, session.connection, &frame)
                    .await?;
            }
            Ok::<_, Failure>(())
        });
    handled.map_err(|err| format!("{}: {}", err.code, err.message))?;
    assert_eq!(
        response.map_err(|err| format!("{}: {}", err.code, err.message))?["digest"],
        event["bodyDigest"]
    );
    drop(frames);
    server.abort();
    let _ = server.await;
    Ok(())
}
