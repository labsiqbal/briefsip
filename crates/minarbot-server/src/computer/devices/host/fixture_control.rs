use super::*;
use std::{
    cell::{Cell, RefCell},
    io::BufRead,
    rc::Rc,
};
use tokio::{sync::mpsc, task::LocalSet};

fn output(id: &Value, result: Result<Value>) {
    let reply = match result {
        Ok(value) => json!({"id":id,"value":value}),
        Err(error) => {
            json!({"id":id,"error":{"status":error.status,"code":error.code,"message":error.message}})
        }
    };
    println!("{reply}");
}

pub(super) async fn run(host: Host, database: &Path) -> db::Result<()> {
    let (send, receive) = mpsc::channel(8);
    std::thread::spawn(move || {
        for line in std::io::stdin()
            .lock()
            .lines()
            .map_while(std::result::Result::ok)
        {
            if send.blocking_send(line).is_err() {
                break;
            }
        }
    });
    LocalSet::new()
        .run_until(serve(host, database, receive))
        .await
}

async fn serve(
    mut host: Host,
    database: &Path,
    mut receive: mpsc::Receiver<String>,
) -> db::Result<()> {
    let session = Rc::new(RefCell::new(None::<stream::Session>));
    let generation = Rc::new(Cell::new(0));
    let mut connection: Option<tokio::task::JoinHandle<db::Result<()>>> = None;
    while let Some(line) = receive.recv().await {
        let command = crate::web::parse_json(line.as_bytes()).map_err(|err| err.message)?;
        match text(&command, "op") {
            "connect" => {
                if connection.is_some() {
                    output(
                        &command["id"],
                        Err(invalid("Fixture is already connected.")),
                    );
                    continue;
                }
                // Retain the executor across disconnects so a second process cannot recover its work.
                let _ = host.acquire_executor();
                let peer = host.stream_peer(database).map_err(|error| error.message)?;
                let session = session.clone();
                let generation = generation.clone();
                let offset = generation.get();
                connection = Some(tokio::task::spawn_local(stream::supervise(
                    peer,
                    move |phase, attempt, opened| {
                        *session.borrow_mut() = opened.cloned();
                        generation.set(offset + attempt);
                        println!("{}", json!({"phase":phase,"generation":generation.get()}));
                    },
                    |results| println!("{}", json!({"recovery":results})),
                )));
                output(&command["id"], Ok(Value::Null));
            }
            "disconnect" => {
                if let Some(connection) = connection.take() {
                    connection.abort();
                    let _ = connection.await;
                }
                *session.borrow_mut() = None;
                println!(
                    "{}",
                    json!({"phase":"offline","generation":generation.get()})
                );
                output(&command["id"], Ok(Value::Null));
            }
            _ => {
                let Some(session) = session.borrow().clone() else {
                    output(&command["id"], Err(transport()));
                    continue;
                };
                let mut peer = host.stream_peer(database).map_err(|error| error.message)?;
                tokio::task::spawn_local(async move {
                    output(
                        &command["id"],
                        invoke(&mut peer, &session.token, &command).await,
                    );
                });
            }
        }
    }
    Ok(())
}

async fn invoke(host: &mut Host, token: &str, command: &Value) -> Result<Value> {
    let operation = text(command, "op");
    match operation {
        "recover" => {
            return match host.recover_journal(token).await {
                Ok(evidence) => Ok(json!(evidence)),
                Err(error) if error.code == "executor_busy" => Ok(json!([])),
                Err(error) => Err(error),
            };
        }
        "action" => {
            let input = &command["input"];
            let provider = command.get("provider").map(fixture_provider).transpose()?;
            let client = host.client.clone();
            return host
                .execute_action(token, input, || async {
                    provider
                        .ok_or_else(Failure::storage)?
                        .prepare("", &input["context"])?
                        .send(client)
                        .await
                })
                .await;
        }
        _ => {}
    }
    let task = id(&command["taskId"])?;
    match operation {
        "start-task" => host.start_task(token, &task).await,
        "context" => {
            host.task_context(token, &task, &command["ownership"], &command["revision"])
                .await
        }
        "run-task" => {
            host.run_task(token, &task, &fixture_provider(&command["provider"])?)
                .await
        }
        "acquire" => {
            let request = id(&command["requestId"])?;
            let existing = host
                .executor_refs()?
                .into_iter()
                .find(|record| record["taskId"] == task && record["requestId"] == request);
            let persisted = existing.is_some();
            let record = existing.unwrap_or_else(|| json!({
                "taskId":task,"requestId":request,"tokenReference":format!("executor/{task}/{request}"),
                "acquire":{"lockProof":command["lockProof"],"previousExecutorGeneration":command["previousExecutorGeneration"]},
            }));
            host.acquire_task(token, record, persisted).await
        }
        "prepare" | "commit" | "reconcile" => {
            let body = &command["body"];
            let runner = host.executor_token(&task, &body["ownership"])?;
            let path = if operation == "reconcile" {
                format!("/api/tasks/{task}/reconcile")
            } else {
                let action = id(&command["actionId"])?;
                format!("/api/tasks/{task}/actions/{action}/{operation}")
            };
            Ok(host
                .post_path(&path, token, body, Some(&runner), LIMIT, TIMEOUT)
                .await?["data"]
                .clone())
        }
        "complete" | "recover-action" => {
            host.acquire_executor()?;
            let action = id(&command["actionId"])?;
            let row = journal::latest_row(&host.db, &action)?;
            if row["task_id"] != task {
                return Err(journal::missing());
            }
            if operation == "complete" {
                host.complete_task(token, &task, &row).await
            } else {
                host.recover_action(token, &row).await
            }
        }
        _ => Err(fail(
            400,
            "fixture_command_invalid",
            "Unknown fixture command.",
        )),
    }
}

fn fixture_provider(origin: &Value) -> Result<provider::Provider> {
    let origin = origin
        .as_str()
        .ok_or_else(|| invalid("Fixture provider is missing."))?;
    provider::Provider::new(Some(origin.into()), true)
        .map_err(|_| invalid("Fixture provider must be loopback."))
}
