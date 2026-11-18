use super::*;
use crate::computer::devices::host::keys::Store;
use crate::computer::devices::host::tests::{Fixture, Keyring, Scratch};
use ring::hmac;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Default)]
struct WaitKeys {
    entries: Keyring,
    locked: Arc<AtomicBool>,
    refuse_delete: Arc<AtomicBool>,
}

impl keys::Store for WaitKeys {
    fn read(&self, service: &str, name: &str) -> Result<Option<String>> {
        if self.locked.load(Ordering::Relaxed) && name.starts_with("event-wait/") {
            return Err(fail(503, "locked", "secret-canary"));
        }
        self.entries.read(service, name)
    }

    fn write(&self, service: &str, name: &str, secret: &str) -> Result<()> {
        self.entries.write(service, name, secret)
    }

    fn remove(&self, service: &str, name: &str) -> Result<()> {
        if self.refuse_delete.load(Ordering::Relaxed) {
            return Err(fail(503, "locked", "secret-canary"));
        }
        self.entries.remove(service, name)
    }
}

struct Home {
    _scratch: Scratch,
    path: PathBuf,
    origin: String,
    host: Host,
    keys: WaitKeys,
}

impl Home {
    fn new() -> db::Result<Self> {
        let scratch = Scratch::create()?;
        let origin = "http://127.0.0.1:1".to_owned();
        let path = scratch.0.join("home.sqlite");
        let keys = WaitKeys::default();
        let mut host = Host::open(&path, &origin, true, Box::new(keys.clone()))?;
        let identity = &host.identity;
        let signing = host
            .key(&identity.signing_ref, false, false)
            .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
        let encryption = host
            .key(&identity.encryption_ref, true, false)
            .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
        let mut descriptor = json!({
            "v":1,"accountId":request_id(),"installationId":identity.installation_id,
            "deviceId":identity.device_id,"authorityGeneration":request_id(),
            "deviceGeneration":1,"keyRevision":1,"zone":identity.zone,"zoneRevision":identity.zone_revision,
            "signingPublicKey":B64.encode(signing.public()),"encryptionPublicKey":B64.encode(encryption.public())
        });
        descriptor["signature"] = signing
            .sign(&json!([
                "briefsip-device-descriptor-v1",
                descriptor["accountId"],
                descriptor["installationId"],
                descriptor["deviceId"],
                descriptor["authorityGeneration"],
                descriptor["deviceGeneration"],
                descriptor["keyRevision"],
                descriptor["zone"],
                descriptor["zoneRevision"],
                descriptor["signingPublicKey"],
                descriptor["encryptionPublicKey"]
            ]))
            .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"))
            .into();
        host.remember_descriptor(&descriptor)
            .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
        host.identity.descriptor = Some(descriptor);
        host.persist(&host.identity, true)
            .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
        Ok(Self {
            _scratch: scratch,
            path,
            origin,
            host,
            keys,
        })
    }

    fn reopen(&self) -> db::Result<Host> {
        Host::open(&self.path, &self.origin, true, Box::new(self.keys.clone()))
    }

    fn provision(&self, workflow: bool) -> Value {
        let id = request_id();
        let descriptor = self
            .host
            .identity
            .descriptor
            .as_ref()
            .unwrap_or_else(|| panic!("Missing wait fixture state"));
        let run = request_id();
        let (key, target) = if workflow {
            (
                json!(["workflow", run, 1]).to_string(),
                json!({"kind":"workflow","runId":run,"seq":1,"nodeId":"event","expectedRunRevision":1}),
            )
        } else {
            (
                id.clone(),
                json!({"kind":"turn","taskId":request_id(),"actionId":request_id(),"toolCallId":"call"}),
            )
        };
        signed_provision(json!({
            "v":1,"provisionId":id,"waitKey":key,"projectId":request_id(),"agentId":request_id(),
            "sourceDeviceId":self.host.identity.device_id,"sourceDeviceGeneration":descriptor["deviceGeneration"],
            "authorityGeneration":descriptor["authorityGeneration"],"secretGeneration":1,
            "event":"ready","deadline":now()+60_000,"target":target
        }))
    }

    fn ack(&self, result: &Value, state: &str) -> Value {
        json!({"data":{"provisionId":result["provisionId"],"state":state,"receipt":{"marker":"canonical"}},
            "receipt":{"requestId":result["requestId"],"recordId":result["provisionId"],
                "actorId":self.host.identity.descriptor.as_ref().unwrap_or_else(|| panic!("Missing wait fixture state"))["accountId"],
                "payloadDigest":digest(&json!(["briefsip-wait-secret-result-v1",result]))}})
    }

    fn secret(&self, request: &Value) -> db::Result<Option<String>> {
        self.keys
            .entries
            .read(&self.host.secret_service(), &reference(request))
            .map_err(|error| error.message.into())
    }

    fn request(&self, provision: &Value) -> Value {
        json!({
            "waitKey":provision["waitKey"],"sourceDeviceId":provision["sourceDeviceId"],
            "deviceGeneration":provision["sourceDeviceGeneration"],"authorityGeneration":provision["authorityGeneration"],
            "secretGeneration":1,"connectionGeneration":1,"expiresAt":now()+59_000
        })
    }
}

fn reference(request: &Value) -> String {
    format!("event-wait/{}/1", text(request, "waitKey"))
}

fn signed_provision(mut body: Value) -> Value {
    body.as_object_mut()
        .unwrap_or_else(|| panic!("Missing wait fixture state"))
        .remove("payloadDigest");
    body["payloadDigest"] = digest(&json!(["briefsip-wait-provision-v1", body])).into();
    body
}

fn saved(host: &Host, request: &Value) -> Value {
    one(
        &host.db,
        "SELECT * FROM device_wait_secrets WHERE provision_id=?",
        [text(request, "provisionId")],
    )
    .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"))
    .unwrap_or_else(|| panic!("Missing wait fixture state"))
}

fn result(host: &Host, request: &Value) -> Value {
    serde_json::from_str(text(&saved(host, request), "result_json"))
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"))
}

fn fail_ready(host: &Host) {
    host.db.execute_batch("CREATE TRIGGER fail_ready BEFORE UPDATE OF result_json ON device_wait_secrets BEGIN SELECT RAISE(ABORT,'fixture ready failure'); END").unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
}

fn staged_keys(f: &Home, count: usize) {
    let keys = f
        .keys
        .entries
        .0
        .lock()
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    assert_eq!(
        keys.keys()
            .filter(|(_, key)| key.starts_with("event-wait/"))
            .count(),
        count
    );
}

#[test]
fn turn_and_workflow_provisions_keep_one_secret_and_exact_result() -> db::Result<()> {
    let f = Home::new()?;
    for (count, workflow) in [false, true].into_iter().enumerate() {
        let request = f.provision(workflow);
        provision(&f.host, &request, false)
            .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
        let ready = result(&f.host, &request);
        assert_eq!(ready["state"], "ready");
        assert_eq!(
            ready["secretRef"],
            json!([request["waitKey"], 1]).to_string()
        );
        let secret = f
            .secret(&request)?
            .unwrap_or_else(|| panic!("Missing wait fixture state"));
        assert!(valid_secret(&secret));
        assert!(!saved(&f.host, &request).to_string().contains(&secret));
        provision(&f.host, &request, false)
            .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
        assert_eq!(result(&f.host, &request), ready);
        assert_eq!(saved(&f.host, &request)["state"], "ready");
        let ack = f.ack(&ready, "activated");
        acknowledge(&f.host, &ready, &ack)
            .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
        assert_eq!(saved(&f.host, &request)["state"], "acknowledged");
        provision(&f.host, &request, false)
            .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
        assert_eq!(result(&f.host, &request), ready);
        assert_eq!(f.secret(&request)?.as_deref(), Some(secret.as_str()));
        staged_keys(&f, count + 1);
    }
    Ok(())
}

#[test]
fn reveal_checks_live_binding_and_never_recreates_a_missing_secret() -> db::Result<()> {
    let f = Home::new()?;
    let provision_frame = f.provision(false);
    provision(&f.host, &provision_frame, false)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    let secret = f
        .secret(&provision_frame)?
        .unwrap_or_else(|| panic!("Missing wait fixture state"));
    let ready = result(&f.host, &provision_frame);
    let ephemeral = keys::Private::open(&f.keys, "fixture", "browser", true, true)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    let mut request = f.request(&provision_frame);
    request["requestId"] = request_id().into();
    request["ownerAccountId"] = f
        .host
        .identity
        .descriptor
        .as_ref()
        .unwrap_or_else(|| panic!("Missing wait fixture state"))["accountId"]
        .clone();
    request["ephemeralPublicKey"] = B64.encode(ephemeral.public()).into();
    assert!(reveal(&f.host, &request)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"))["ciphertext"]
        .is_string());
    acknowledge(&f.host, &ready, &f.ack(&ready, "activated"))
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    assert!(reveal(&f.host, &request).is_ok());
    for (field, value) in [
        ("waitKey", json!(request_id())),
        ("deviceGeneration", json!(2)),
        ("authorityGeneration", json!(request_id())),
        ("sourceDeviceId", json!(request_id())),
        ("secretGeneration", json!(2)),
        ("expiresAt", json!(now())),
    ] {
        let mut changed = request.clone();
        changed[field] = value;
        assert_eq!(
            reveal(&f.host, &changed)
                .err()
                .unwrap_or_else(|| panic!("Expected wait operation to fail"))
                .code,
            "wait_invalid",
            "{field}"
        );
    }
    f.host
        .db
        .execute("UPDATE device_wait_secrets SET deadline=?", [now()])?;
    assert_eq!(
        reveal(&f.host, &request)
            .err()
            .unwrap_or_else(|| panic!("Expected wait operation to fail"))
            .code,
        "wait_invalid"
    );
    f.host.db.execute(
        "UPDATE device_wait_secrets SET deadline=?",
        [now() + 60_000],
    )?;
    let service = f.host.secret_service();
    let reference = reference(&provision_frame);
    f.keys
        .remove(&service, &reference)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    assert_eq!(
        reveal(&f.host, &request)
            .err()
            .unwrap_or_else(|| panic!("Expected wait operation to fail"))
            .code,
        "device_key_unavailable"
    );
    staged_keys(&f, 0);
    f.keys
        .write(&service, &reference, &secret)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    f.host
        .db
        .execute("UPDATE device_state SET device_generation=2", [])?;
    assert_eq!(
        reveal(&f.host, &request)
            .err()
            .unwrap_or_else(|| panic!("Expected wait operation to fail"))
            .code,
        "wait_invalid"
    );
    assert_eq!(
        f.secret(&provision_frame)?
            .unwrap_or_else(|| panic!("Missing wait fixture state")),
        secret
    );
    Ok(())
}

#[test]
fn wait_staging_replays_after_keyring_write_and_database_reopen() -> db::Result<()> {
    let f = Home::new()?;
    let request = f.provision(false);
    fail_ready(&f.host);
    assert!(provision(&f.host, &request, false).is_err());
    let staged = saved(&f.host, &request);
    assert_eq!(staged["state"], "staging");
    assert!(staged["result_json"].is_null());
    let secret = f
        .secret(&request)?
        .unwrap_or_else(|| panic!("Missing wait fixture state"));
    let reopened = f.reopen()?;
    reopened.db.execute_batch("DROP TRIGGER fail_ready")?;
    resume_staging(&reopened).unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    let ready = result(&reopened, &request);
    assert_eq!(ready["state"], "ready");
    assert_eq!(ready["requestId"], staged["result_request_id"]);
    assert_eq!(
        f.secret(&request)?
            .unwrap_or_else(|| panic!("Missing wait fixture state")),
        secret
    );
    staged_keys(&f, 1);
    provision(&reopened, &request, false)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    assert_eq!(result(&reopened, &request), ready);
    let ack = f.ack(&ready, "activated");
    acknowledge(&reopened, &ready, &ack)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    drop(reopened);
    let reopened = f.reopen()?;
    assert_eq!(saved(&reopened, &request)["state"], "acknowledged");
    provision(&reopened, &request, false)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    assert_eq!(result(&reopened, &request), ready);
    acknowledge(&reopened, &ready, &ack)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    let mut changed = ack.clone();
    changed["data"]["receipt"]["marker"] = "changed".into();
    assert_eq!(
        acknowledge(&reopened, &ready, &changed)
            .err()
            .unwrap_or_else(|| panic!("Expected wait operation to fail"))
            .code,
        "wait_result_conflict"
    );
    assert_eq!(
        saved(&reopened, &request)["ack_json"],
        db::canonical(&ack["data"])
    );
    Ok(())
}

#[test]
fn wait_keyring_failures_leave_immutable_results_without_replacing_keys() -> db::Result<()> {
    let f = Home::new()?;
    let request = f.provision(true);
    f.host.db.execute_batch("CREATE TRIGGER fail_stage BEFORE INSERT ON device_wait_secrets BEGIN SELECT RAISE(ABORT,'fixture stage failure'); END")?;
    assert!(provision(&f.host, &request, false).is_err());
    staged_keys(&f, 0);
    f.host.db.execute_batch("DROP TRIGGER fail_stage")?;
    let service = f.host.secret_service();
    f.keys
        .write(&service, &reference(&request), "corrupt-canary")
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    provision(&f.host, &request, false)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    let failed = result(&f.host, &request);
    assert_eq!(failed["state"], "failed");
    assert_eq!(failed["errorCode"], "keystore_unavailable");
    assert_eq!(f.secret(&request)?.as_deref(), Some("corrupt-canary"));
    assert!(!failed.to_string().contains("corrupt-canary"));
    f.keys
        .remove(&service, &reference(&request))
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    provision(&f.host, &request, false)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    assert_eq!(result(&f.host, &request), failed);
    staged_keys(&f, 0);
    assert!(acknowledge(&f.host, &failed, &f.ack(&failed, "activated")).is_err());
    acknowledge(&f.host, &failed, &f.ack(&failed, "closed"))
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    assert_eq!(saved(&f.host, &request)["state"], "acknowledged");

    let locked = f.provision(true);
    f.keys.locked.store(true, Ordering::Relaxed);
    provision(&f.host, &locked, false)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    let failure = result(&f.host, &locked);
    assert_eq!(failure["errorCode"], "keystore_unavailable");
    assert!(!failure.to_string().contains("secret-canary"));
    staged_keys(&f, 0);
    Ok(())
}

#[test]
fn closed_wait_keeps_cleanup_pending_and_retries_without_changing_evidence() -> db::Result<()> {
    let f = Home::new()?;
    let request = f.provision(false);
    provision(&f.host, &request, false)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    let ready = result(&f.host, &request);
    let closed = f.ack(&ready, "closed");
    f.keys.refuse_delete.store(true, Ordering::Relaxed);
    acknowledge(&f.host, &ready, &closed)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    cleanup(&f.host).unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    staged_keys(&f, 1);
    assert_eq!(saved(&f.host, &request)["cleanup_pending"], 1);
    provision(&f.host, &request, false)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    assert_eq!(result(&f.host, &request), ready);
    assert_eq!(
        acknowledge(&f.host, &ready, &f.ack(&ready, "activated"))
            .err()
            .unwrap_or_else(|| panic!("Expected wait operation to fail"))
            .code,
        "wait_result_conflict"
    );
    f.keys.refuse_delete.store(false, Ordering::Relaxed);
    let reopened = f.reopen()?;
    cleanup(&reopened).unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    acknowledge(&reopened, &ready, &closed)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    assert_eq!(saved(&reopened, &request)["cleanup_pending"], 0);
    provision(&reopened, &request, false)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    assert_eq!(result(&reopened, &request), ready);
    staged_keys(&f, 0);
    Ok(())
}

#[test]
fn wait_provision_rejects_invalid_frames_before_allocating_keys() -> db::Result<()> {
    let f = Home::new()?;
    let request = f.provision(false);
    for (field, value) in [
        ("secret", json!("must-not-enter-db")),
        ("sourceDeviceId", json!(request_id())),
        ("sourceDeviceGeneration", json!(2)),
        ("authorityGeneration", json!(request_id())),
        ("waitKey", json!("foreign")),
    ] {
        let mut changed = request.clone();
        changed[field] = value;
        assert!(
            provision(&f.host, &signed_provision(changed), false).is_err(),
            "{field}"
        );
    }
    let mut changed = request.clone();
    changed["target"]["runId"] = request_id().into();
    assert!(provision(&f.host, &signed_provision(changed), false).is_err());
    let mut changed = request.clone();
    changed["target"]["toolCallId"] = "\n".into();
    assert!(provision(&f.host, &signed_provision(changed), false).is_err());
    let mut changed = request.clone();
    changed["payloadDigest"] = "0".repeat(64).into();
    assert!(provision(&f.host, &changed, false).is_err());
    assert!(rows(&f.host.db, "SELECT * FROM device_wait_secrets", [])
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"))
        .is_empty());
    staged_keys(&f, 0);
    let mut expired = request;
    expired["deadline"] = now().into();
    let expired = signed_provision(expired);
    provision(&f.host, &expired, false)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    let failed = result(&f.host, &expired);
    assert_eq!(failed["errorCode"], "wait_expired");
    staged_keys(&f, 0);
    let mut invalid_ack = f.ack(&failed, "closed");
    invalid_ack["data"]["state"] = json!(["closed"]);
    assert!(acknowledge(&f.host, &failed, &invalid_ack).is_err());
    Ok(())
}

#[test]
fn current_wait_staging_precedes_forty_stale_rows_without_losing_keys() -> db::Result<()> {
    let mut f = Home::new()?;
    fail_ready(&f.host);
    for _ in 0..40 {
        assert!(provision(&f.host, &f.provision(false), false).is_err());
    }
    f.host
        .identity
        .descriptor
        .as_mut()
        .unwrap_or_else(|| panic!("Missing wait fixture state"))["deviceGeneration"] = 2.into();
    f.host
        .db
        .execute("UPDATE device_state SET device_generation=2", [])
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    let current = f.provision(true);
    assert!(provision(&f.host, &current, false).is_err());
    staged_keys(&f, 41);
    f.host
        .db
        .execute_batch("DROP TRIGGER fail_ready")
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    resume_staging(&f.host).unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    assert_eq!(saved(&f.host, &current)["state"], "ready");
    assert_eq!(result(&f.host, &current)["state"], "ready");
    resume_staging(&f.host).unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    assert!(rows(
        &f.host.db,
        "SELECT * FROM device_wait_secrets WHERE state='staging'",
        []
    )
    .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"))
    .is_empty());
    staged_keys(&f, 41);
    Ok(())
}

#[tokio::test]
async fn malformed_wait_result_is_rejected_before_device_lookup() -> db::Result<()> {
    let scratch = Scratch::create()?;
    let (fixture, server) = Fixture::start(&scratch).await?;
    server.abort();
    let _ = server.await;
    let state = fixture.state;
    let database = state
        .database
        .lock()
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    let principal = crate::computer::devices::Principal {
        device: request_id(),
        account: request_id(),
        generation: 1,
        authority: request_id(),
        session: None,
    };
    let failed = json!({
        "requestId":request_id(),"provisionId":request_id(),"payloadDigest":"0".repeat(64),
        "waitKey":request_id(),"secretGeneration":1,"sourceDeviceGeneration":1,
        "state":"failed","errorCode":"wait_expired"
    });
    for (key, value) in [
        ("secretRef", json!("leak")),
        ("errorCode", json!("secret-canary")),
        ("errorCode", json!(["wait_expired"])),
    ] {
        let mut malformed = failed.clone();
        malformed[key] = value;
        let error = crate::tasks::waits::secret_result(
            &state,
            &database.connection,
            &principal,
            &malformed,
            now(),
        )
        .err()
        .unwrap_or_else(|| panic!("Expected wait operation to fail"));
        assert_eq!(error.status, 400);
        assert_eq!(error.code, "wait_invalid");
        assert!(!error.message.contains("secret-canary"));
    }
    Ok(())
}

#[test]
fn event_assembly_rejects_bounds_duplicates_disorder_corruption_and_timeout() {
    let body = json!({"event":"ready","payload":"界".repeat(20_000)})
        .to_string()
        .into_bytes();
    let mut request = json!({
        "waitKey":request_id(),"sourceDeviceId":request_id(),"deviceGeneration":1,"authorityGeneration":request_id(),
        "secretGeneration":1,"connectionGeneration":1,"expiresAt":1,"byteLength":body.len(),"bodyDigest":byte_digest(&body),
        "headers":{"x-briefsip-time":"1","x-briefsip-id":"delivery","x-briefsip-signature":"0".repeat(64)}
    });
    let job_id = request_id();
    let digest = digest(&json!(["briefsip-wait-event-v1", request]));
    let chunks: Vec<_> = body.chunks(CHUNK).enumerate().map(|(index, chunk)| {
        json!({"jobId":job_id,"request":request,"payloadDigest":digest,"offset":index*CHUNK,"chunk":B64.encode(chunk)})
    }).collect();
    assert_eq!(chunks.len(), 3);
    assert!(chunks.iter().all(|job| job.to_string().len() < LIMIT));
    waits::validate_host_request(&request, true)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    let mut stream = Stream::new();
    assert!(stream
        .assemble(&chunks[0], &request)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"))
        .is_none());
    assert!(stream
        .assemble(&chunks[1], &request)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"))
        .is_none());
    assert_eq!(
        stream
            .assemble(&chunks[2], &request)
            .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"))
            .unwrap_or_else(|| panic!("Missing wait fixture state")),
        body
    );
    assert!(Stream::new().assemble(&chunks[1], &request).is_err());

    for index in [0, 2] {
        let mut stream = Stream::new();
        stream
            .assemble(&chunks[0], &request)
            .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
        assert!(stream.assemble(&chunks[index], &request).is_err());
    }
    let mut stream = Stream::new();
    stream
        .assemble(&chunks[0], &request)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    let mut other_job = chunks[1].clone();
    other_job["jobId"] = request_id().into();
    assert!(stream.assemble(&other_job, &request).is_err());
    stream
        .assembly
        .as_mut()
        .unwrap_or_else(|| panic!("Missing wait fixture state"))
        .started -= Duration::from_secs(5);
    assert!(stream.assemble(&chunks[1], &request).is_err());

    let mut stream = Stream::new();
    stream
        .assemble(&chunks[0], &request)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    stream
        .assemble(&chunks[1], &request)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    let mut corrupt = chunks[2].clone();
    corrupt["chunk"] = B64.encode(vec![0; body.len() - 2 * CHUNK]).into();
    assert!(stream.assemble(&corrupt, &request).is_err());
    request["byteLength"] = (LIMIT + 1).into();
    assert_eq!(
        waits::validate_host_request(&request, true)
            .err()
            .unwrap_or_else(|| panic!("Expected wait operation to fail"))
            .status,
        413
    );
}

#[test]
fn home_event_rechecks_keys_authority_and_hmac_on_expired_replay() -> db::Result<()> {
    let f = Home::new()?;
    let frame = f.provision(false);
    provision(&f.host, &frame, false)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    let ready = result(&f.host, &frame);
    acknowledge(&f.host, &ready, &f.ack(&ready, "activated"))
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    let secret = f
        .secret(&frame)?
        .unwrap_or_else(|| panic!("Missing wait fixture state"));
    let body = br#"{"event":"ready","payload":{"count":7}}"#;
    let mut request = f.request(&frame);
    let delivery = "delivery-1";
    let signature = |time: i64| {
        let signed = [format!("{time}\n{delivery}\n").as_bytes(), body.as_slice()].concat();
        hmac::sign(
            &hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes()),
            &signed,
        )
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
    };
    let time = now() / 1000;
    request["headers"] = json!({"x-briefsip-time":time.to_string(),"x-briefsip-id":delivery,"x-briefsip-signature":signature(time)});
    assert_eq!(
        event(&f.host, &request, body)
            .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"))["digest"],
        byte_digest(body)
    );
    for (field, value) in [
        ("sourceDeviceId", json!(request_id())),
        ("deviceGeneration", json!(2)),
        ("authorityGeneration", json!(request_id())),
        ("secretGeneration", json!(2)),
    ] {
        let mut changed = request.clone();
        changed[field] = value;
        assert_eq!(
            event(&f.host, &changed, body)
                .err()
                .unwrap_or_else(|| panic!("Expected wait operation to fail"))
                .code,
            "wait_invalid",
            "{field}"
        );
    }

    request["headers"]["x-briefsip-time"] = "1".into();
    request["headers"]["x-briefsip-signature"] = signature(1).into();
    f.host
        .db
        .execute("UPDATE device_wait_secrets SET deadline=?", [now()])?;
    assert_eq!(
        event(&f.host, &request, body)
            .err()
            .unwrap_or_else(|| panic!("Expected wait operation to fail"))
            .status,
        401
    );
    request["accepted"] = json!({"id":delivery,"digest":byte_digest(body)});
    assert_eq!(
        event(&f.host, &request, body)
            .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"))["id"],
        delivery
    );
    let mut changed = request.clone();
    changed["headers"]["x-briefsip-signature"] = "0".repeat(64).into();
    assert_eq!(
        event(&f.host, &changed, body)
            .err()
            .unwrap_or_else(|| panic!("Expected wait operation to fail"))
            .status,
        401
    );
    let mut changed = request.clone();
    changed["accepted"]["id"] = "different".into();
    assert_eq!(
        event(&f.host, &changed, body)
            .err()
            .unwrap_or_else(|| panic!("Expected wait operation to fail"))
            .status,
        409
    );
    let service = f.host.secret_service();
    let reference = reference(&frame);
    f.keys
        .remove(&service, &reference)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    assert_eq!(
        event(&f.host, &request, body)
            .err()
            .unwrap_or_else(|| panic!("Expected wait operation to fail"))
            .code,
        "device_key_unavailable"
    );
    staged_keys(&f, 0);
    f.keys
        .write(&service, &reference, &secret)
        .unwrap_or_else(|error| panic!("Wait fixture failed: {error:?}"));
    f.host
        .db
        .execute("UPDATE device_wait_secrets SET closed=1", [])?;
    assert_eq!(
        event(&f.host, &request, body)
            .err()
            .unwrap_or_else(|| panic!("Expected wait operation to fail"))
            .code,
        "wait_invalid"
    );
    Ok(())
}
