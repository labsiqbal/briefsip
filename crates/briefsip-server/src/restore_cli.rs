use crate::{
    auth::Auth,
    config::{now, trusted_origin, AuthConfig},
    data::{closed, one, string, transaction},
    db::{self, digest},
    operator_file::{bounded_read, file_at, open_directory, private, publish},
    restore::{exchange, random_proof, workspace},
    restore_fence::{self, Recovery, MANIFEST_LIMIT},
    web::{parse_json, Failure},
};
use axum::http::{header, HeaderMap, Method};
use rusqlite::params;
use serde_json::{json, Value};
use std::{
    env, fmt, fs,
    io::{self, IsTerminal, Read},
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

#[derive(Debug)]
struct ExitError(u8, String);

impl fmt::Display for ExitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.1)
    }
}

impl std::error::Error for ExitError {}

fn exit_error(code: u8, message: impl Into<String>) -> Box<dyn std::error::Error + Send + Sync> {
    Box::new(ExitError(code, message.into()))
}

fn parent(path: &Path) -> &Path {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
}

fn absolute(path: &Path) -> db::Result<PathBuf> {
    let name = path.file_name().ok_or("Recovery file name is required.")?;
    Ok(fs::canonicalize(parent(path))?.join(name))
}

fn private_json(path: &Path, limit: usize) -> db::Result<Value> {
    let directory = open_directory(&fs::canonicalize(parent(path))?)?;
    let file = file_at(
        &directory,
        path.file_name().ok_or("Recovery file name is required.")?,
    )?;
    if !private(&file) {
        return Err(exit_error(
            5,
            "Recovery file must be private and owned by the user.",
        ));
    }
    let bytes = bounded_read(file, limit).map_err(|error| {
        if matches!(
            error.kind(),
            io::ErrorKind::FileTooLarge | io::ErrorKind::InvalidInput
        ) {
            exit_error(5, "Recovery file must be private and owned by the user.")
        } else {
            error.into()
        }
    })?;
    parse_json(&bytes).map_err(|e| e.message.into())
}

fn save(base: &Path, tag: &str, value: &Value) -> db::Result<PathBuf> {
    let mut name = base
        .file_name()
        .ok_or("Recovery file name is required.")?
        .to_owned();
    name.push(format!(".{tag}-{}.json", Uuid::new_v4()));
    let directory = open_directory(parent(base))?;
    publish(&directory, &name, &serde_json::to_vec(value)?)?;
    Ok(base.with_file_name(name))
}

fn auth_config() -> db::Result<AuthConfig> {
    let required = |name| {
        env::var(name)
            .ok()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| exit_error(5, format!("{name} is required to verify the owner.")))
    };
    let origin = required("BRIEFSIP_ORIGIN")?;
    let development = origin.starts_with("http:");
    trusted_origin(&origin, development)?;
    let issuer = required("CLERK_ISSUER")?;
    let url = url::Url::parse(&issuer)?;
    if !(url.scheme() == "https"
        || development
            && url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Invalid Clerk issuer configuration.".into());
    }
    Ok(AuthConfig {
        secret_key: required("CLERK_SECRET_KEY")?,
        publishable_key: required("CLERK_PUBLISHABLE_KEY")?,
        issuer,
        origin,
        audience: env::var("CLERK_AUDIENCE").ok().filter(|s| !s.is_empty()),
        jwt_key: env::var("CLERK_JWT_KEY").ok().filter(|s| !s.is_empty()),
        development,
        api_url: None,
    })
}

fn session_headers(origin: &str) -> db::Result<HeaderMap> {
    if io::stdin().is_terminal() {
        return Err(exit_error(
            2,
            "Send the Clerk token JSON through a stdin pipe.",
        ));
    }
    let mut bytes = Vec::new();
    io::stdin().take(32_769).read_to_end(&mut bytes)?;
    if bytes.len() > 32_768 {
        return Err(exit_error(2, "Input token exceeds the limit."));
    }
    let input = parse_json(&bytes).map_err(|e| e.message)?;
    let token = string(&input, "token");
    if !closed(&input, &["token"]) || token.is_empty() || token.encode_utf16().count() > 16_384 {
        return Err(exit_error(2, "Invalid Clerk token."));
    }
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        format!("Bearer {token}")
            .parse()
            .map_err(|_| "Invalid Clerk token.")?,
    );
    headers.insert(header::ORIGIN, origin.parse()?);
    Ok(headers)
}

enum Operation<'a> {
    Copy {
        source: &'a str,
        canonical: bool,
    },
    Bootstrap,
    Reconcile(&'a str),
    Fence {
        session: &'a str,
        evidence: Option<&'a str>,
        plan: Option<&'a str>,
        command: &'a str,
    },
}

fn arguments(args: &[String]) -> Option<(&str, Operation<'_>)> {
    let values: Vec<_> = args.iter().map(String::as_str).collect();
    match values.as_slice() {
        ["--read-only", source, "--db", db] => Some((
            db,
            Operation::Copy {
                source,
                canonical: true,
            },
        )),
        ["workspace", source, "--db", db] => Some((
            db,
            Operation::Copy {
                source,
                canonical: false,
            },
        )),
        ["bootstrap", "--db", db] => Some((db, Operation::Bootstrap)),
        ["reconcile", "--db", db, "--bootstrap", path] => Some((db, Operation::Reconcile(path))),
        ["fence-request", "--db", db, "--session", session] => Some((
            db,
            Operation::Fence {
                session,
                evidence: None,
                plan: None,
                command: "fence-request",
            },
        )),
        [command @ ("verify-fence" | "activation-plan"), "--db", db, "--session", session, "--evidence", evidence] => {
            Some((
                db,
                Operation::Fence {
                    session,
                    evidence: Some(evidence),
                    plan: None,
                    command,
                },
            ))
        }
        ["activate", "--db", db, "--session", session, "--evidence", evidence, "--plan", plan] => {
            Some((
                db,
                Operation::Fence {
                    session,
                    evidence: Some(evidence),
                    plan: Some(plan),
                    command: "activate",
                },
            ))
        }
        _ => None,
    }
}

async fn execute(database: &Path, operation: Operation<'_>) -> db::Result<Value> {
    if let Operation::Copy { source, canonical } = operation {
        return match workspace(Path::new(source), database, canonical)? {
            Some(proof) => Ok(
                json!({"state":"read_only_recovery","bootstrapFile":save(database,"restore-bootstrap",&proof)?,"expiresAt":proof["expiresAt"]}),
            ),
            None => Ok(json!({"state":"restored"})),
        };
    }
    let db = db::open_recovery(database, matches!(operation, Operation::Fence { .. })).map_err(
        |error| {
            if error
                .downcast_ref::<io::Error>()
                .is_some_and(|e| e.kind() == io::ErrorKind::PermissionDenied)
            {
                exit_error(5, error.to_string())
            } else {
                error
            }
        },
    )?;
    if let Operation::Bootstrap = operation {
        let connection = &db.connection;
        return transaction(connection, || {
            let generation = one(connection, "SELECT generation FROM authority_state WHERE id=1 AND serving_state='read_only_recovery'", [])?
                .ok_or_else(|| Failure::new(403, "recovery_session_invalid", "Recovery evidence is invalid or expired."))?;
            let bootstrap = random_proof().map_err(|_| Failure::storage())?;
            let expires = now() + 900_000;
            connection.execute("UPDATE authority_state SET recovery_session_hash=?,recovery_expires_at=?,revision=revision+1 WHERE id=1", params![digest(&bootstrap),expires])?;
            let proof = json!({"bootstrap":bootstrap,"recoveryGeneration":generation["generation"],"expiresAt":expires});
            let path = written(database, "restore-bootstrap", &proof)?;
            Ok(json!({"state":"read_only_recovery","bootstrapFile":path,"expiresAt":expires}))
        }).map_err(|e| e.message.into());
    }
    let (gate, key) = match operation {
        Operation::Reconcile(path) => (path, "bootstrap"),
        Operation::Fence { session, .. } => (session, "session"),
        _ => return Err("Invalid recovery operation.".into()),
    };
    let gate_path = absolute(Path::new(gate))?;
    let proof = private_json(&gate_path, 4096)?;
    let generation = string(&proof, "recoveryGeneration");
    if !closed(&proof, &[key, "recoveryGeneration", "expiresAt"])
        || crate::web::id(generation).as_deref() != Some(generation)
        || crate::computer::devices::decode(&proof[key], 32).is_err()
        || !db
            .connection
            .prepare("SELECT 1 FROM authority_state WHERE id=1 AND generation=?")?
            .exists([generation])?
    {
        return Err(exit_error(
            5,
            "Local evidence does not match the recovery authority.",
        ));
    }
    let config = auth_config()?;
    let headers = session_headers(&config.origin)?;
    let auth = Auth::new(config.clone(), None)?;
    let db = Mutex::new(db);
    let actor = auth
        .authenticate(&db, &headers, &Method::POST, now())
        .await
        .map_err(|e| e.message)?;
    auth.require_current(&db, &actor, now())
        .map_err(|e| e.message)?;
    let db = db
        .into_inner()
        .map_err(|_| "Recovery database lock failed.")?;
    let connection = &db.connection;
    if matches!(operation, Operation::Reconcile(_)) {
        return transaction(connection, || {
            let session = exchange(connection, &actor, string(&proof, key), now())?;
            let path = written(&gate_path, "session", &session)?;
            Ok(json!({"state":"read_only_recovery","sessionFile":path,"expiresAt":session["expiresAt"]}))
        }).map_err(|e| e.message.into());
    }
    let Operation::Fence {
        command,
        evidence,
        plan,
        ..
    } = operation
    else {
        return Err("Invalid recovery operation.".into());
    };
    let trust_path = env::var_os("BRIEFSIP_RESTORE_TRUST")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            exit_error(
                5,
                "BRIEFSIP_RESTORE_TRUST is required to verify the infrastructure fence.",
            )
        })?;
    let trust = restore_fence::trust(&private_json(Path::new(&trust_path), 4096)?, &config.origin)
        .map_err(|e| e.message)?;
    let evidence = evidence
        .map(|path| private_json(Path::new(path), 65_536))
        .transpose()?;
    let plan = plan
        .map(|path| private_json(Path::new(path), MANIFEST_LIMIT + 65_536))
        .transpose()?;
    let recovery = Recovery {
        db: connection,
        actor: &actor,
        session: string(&proof, key),
        generation,
        trust: &trust,
    };
    transaction(connection, || {
        match (command, evidence, plan) {
            ("fence-request", None, None) => {
                let request = recovery.prepare()?;
                let path = written(database,"restore-fence-request",&request)?;
                Ok(json!({"state":"read_only_recovery","requestFile":path,"expiresAt":request["expiresAt"]}))
            }
            ("verify-fence", Some(evidence), None) => recovery.verify(&evidence),
            ("activation-plan", Some(evidence), None) => {
                let plan = recovery.plan(&evidence)?;
                let path = written(database, "restore-activation-plan", &plan)?;
                Ok(json!({"state":"read_only_recovery","planFile":path}))
            }
            ("activate", Some(evidence), Some(plan)) => recovery.activate(&evidence, &plan, &config.issuer),
            _ => Err(Failure::storage()),
        }
    }).map_err(|error| {
        if error.code == "restore_plan_manifest_invalid" {
            exit_error(5, error.message)
        } else {
            error.message.into()
        }
    })
}

fn written(base: &Path, tag: &str, value: &Value) -> Result<PathBuf, Failure> {
    save(base, tag, value).map_err(|error| {
        Failure::new(
            500,
            "restore_write_failed",
            format!("Could not write recovery file: {error}"),
        )
    })
}

pub async fn run(args: &[String]) -> Value {
    let Some((database, operation)) = arguments(args) else {
        return json!({"exitCode":2,"error":"Use restore workspace BACKUP --db NEW_DATABASE, restore --read-only BACKUP --db NEW_DATABASE, restore bootstrap --db DATABASE, restore reconcile --db DATABASE --bootstrap FILE, restore fence-request --db DATABASE --session FILE, or restore verify-fence/activation-plan/activate --db DATABASE --session FILE --evidence FILE [--plan FILE]."});
    };
    let result = async {
        let database = absolute(Path::new(database))?;
        let mut result = execute(&database, operation).await?;
        result["database"] = json!(database);
        result["exitCode"] = json!(0);
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(result)
    }
    .await;
    result.unwrap_or_else(|error| {
        let code = error.downcast_ref::<ExitError>().map_or(1, |error| error.0);
        json!({"exitCode":code,"error":error.to_string()})
    })
}
