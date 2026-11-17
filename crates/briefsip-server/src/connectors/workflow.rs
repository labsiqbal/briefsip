use super::runner::{new_id, number, Local, Options};
use super::*;
fn finish(db: &Connection, platform: &str, row: &Value, text: &str) -> Result<()> {
    if platform == "slack" {
        super::slack::finish(db, row, text, None)
    } else {
        super::telegram::finish_input(db, row, text)
    }
}
fn done(status: &str) -> bool {
    ["done", "failed", "cancelled"].contains(&status)
}
fn permitted(
    db: &Connection,
    platform: &str,
    row: &Value,
    run: &str,
    revision: Option<i64>,
) -> Result<bool> {
    let suffix = if revision.is_some() {
        format!(" JOIN {platform}_approvals a ON a.run=w.run")
    } else {
        String::new()
    };
    let clause = if platform == "slack" {
        "w.channel=? AND w.sender=? AND w.root=?"
    } else {
        "w.chat=?"
    };
    let mut values: Vec<rusqlite::types::Value> = vec![run.to_owned().into()];
    if platform == "slack" {
        for k in ["channel", "sender", "root"] {
            values.push(string(row, k).to_owned().into());
        }
    } else {
        values.push(number(row, "chat").into());
    }
    if let Some(revision) = revision {
        values.push(revision.into());
    }
    exists(
        db,
        &format!(
            "SELECT 1 FROM {platform}_workflows w{suffix} WHERE w.run=? AND {clause}{}",
            if revision.is_some() {
                " AND a.revision=?"
            } else {
                ""
            }
        ),
        rusqlite::params_from_iter(values),
    )
}
pub async fn handle(
    db: &Connection,
    platform: &str,
    base: &str,
    row: &Value,
    local: &Local,
) -> Result<bool> {
    let prefix = if platform == "slack" { '!' } else { '/' };
    let text = string(row, "text");
    let parts: Vec<_> = text.splitn(4, ' ').collect();
    let cmd = parts[0];
    if cmd == format!("{prefix}stop")
        && row["status"] == "queued"
        && parts.len() == 2
        && uuid(parts[1])
        && permitted(db, platform, row, parts[1], None)?
    {
        let table = format!("{platform}_workflow_cancels");
        let mut decision = one(
            db,
            &format!("SELECT run,revision FROM {table} WHERE id=?"),
            [string(row, "turn")],
        )?;
        if decision.is_none() {
            let run = local
                .request(&format!("{base}/workflow-runs/{}", parts[1]), None)
                .await?;
            if done(string(&run, "status")) {
                finish(
                    db,
                    platform,
                    row,
                    if platform == "slack" {
                        "Workflow already finished or stopped."
                    } else {
                        "Workflow is complete or stopped."
                    },
                )?;
                return Ok(true);
            }
            db.execute(
                &format!("INSERT INTO {table} VALUES(?,?,?)"),
                params![row["turn"].as_str(), parts[1], run["revision"].as_i64()],
            )?;
            decision = Some(json!({"run":parts[1],"revision":run["revision"]}));
        }
        let decision = decision.ok_or_else(Failure::storage)?;
        local
            .request(
                &format!("{base}/workflow-runs/{}/cancel", string(&decision, "run")),
                Some(&json!({"id":row["turn"],"revision":decision["revision"]})),
            )
            .await?;
        finish(
            db,
            platform,
            row,
            if platform == "slack" {
                "Workflow cancelled. Already-created results remain saved."
            } else {
                "Workflow cancelled. Steps already executed remain saved."
            },
        )?;
        return Ok(true);
    }
    if cmd == format!("{prefix}workflows") {
        if parts.len() > 2 || parts.get(1).is_some_and(|id| !uuid(id)) {
            finish(
                db,
                platform,
                row,
                &format!(
                    "Use {prefix}workflows or {prefix}workflows {}.",
                    if platform == "slack" {
                        "ID_CURSOR"
                    } else {
                        "CURSOR_ID"
                    }
                ),
            )?;
            return Ok(true);
        }
        let page = local
            .request(
                &format!(
                    "{base}/workflows{}",
                    parts
                        .get(1)
                        .map(|id| format!("?after={id}"))
                        .unwrap_or_default()
                ),
                None,
            )
            .await?;
        let list = page["workflows"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|w| {
                format!(
                    "{}\n{prefix}workflow {} {} input",
                    string(w, "name"),
                    string(w, "id"),
                    w["revision"]
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        let mut text = if list.is_empty() {
            if platform == "slack" {
                "Not yet ada workflow.".into()
            } else {
                "No workflows yet.".into()
            }
        } else {
            list
        };
        if let Some(after) = page["next_after"].as_str() {
            text.push_str(&format!(
                "\n\n{}: {prefix}workflows {after}",
                if platform == "slack" {
                    "Halaman berikut"
                } else {
                    "Next page"
                }
            ));
        }
        finish(db, platform, row, &text)?;
        return Ok(true);
    }
    if cmd == format!("{prefix}approve") {
        let revision = parts
            .get(2)
            .and_then(|s| s.parse::<i64>().ok())
            .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991);
        let valid = parts.len() == 4
            && uuid(parts[1])
            && revision.is_some()
            && ["yes", "no"].contains(&parts[3]);
        if !valid || !permitted(db, platform, row, parts.get(1).unwrap_or(&""), revision)? {
            finish(
                db,
                platform,
                row,
                if platform == "slack" {
                    "Approval not found in this thread. Use the command on the approval message."
                } else {
                    "Approval not found for this conversation. Use the command in the approval message."
                },
            )?;
            return Ok(true);
        }
        local
            .request(
                &format!("{base}/workflow-runs/{}/approve", parts[1]),
                Some(&json!({"id":row["turn"],"revision":revision,"accepted":parts[3]=="yes"})),
            )
            .await?;
        finish(
            db,
            platform,
            row,
            match (platform, parts[3]) {
                ("slack", "yes") => "Approval received.",
                ("slack", _) => "Rejection received.",
                (_, "yes") => "Approval accepted.",
                _ => "Rejection accepted.",
            },
        )?;
        return Ok(true);
    }
    if cmd != format!("{prefix}workflow") {
        return Ok(false);
    }
    let revision = parts
        .get(2)
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991);
    if parts.len() != 4
        || !uuid(parts[1])
        || revision.is_none()
        || parts[3].is_empty()
        || parts[3].encode_utf16().count() > 16000
    {
        finish(db,platform,row,&format!("Use {prefix}workflow ID REVISION input. Choose a workflow through {prefix}workflows."))?;
        return Ok(true);
    }
    if row["status"] != "running" {
        transaction(db, || {
            if platform == "slack" {
                db.execute(
                    "INSERT OR IGNORE INTO slack_workflows VALUES(?,?,?,?,?)",
                    [
                        string(row, "turn"),
                        string(row, "channel"),
                        string(row, "sender"),
                        string(row, "root"),
                        parts[1],
                    ],
                )?;
                db.execute(
                    "UPDATE slack_inbox SET status='submitting' WHERE event=?",
                    [string(row, "event")],
                )?;
            } else {
                db.execute(
                    "INSERT OR IGNORE INTO telegram_workflows VALUES(?,?,?,?)",
                    params![
                        row["turn"].as_str(),
                        row["chat"].as_i64(),
                        parts[1],
                        revision
                    ],
                )?;
                db.execute(
                    "UPDATE telegram_inbox SET status='submitting' WHERE update_id=?",
                    params![row["update_id"].as_i64()],
                )?;
            }
            Ok(())
        })?;
        local
            .request(
                &format!("{base}/workflows/{}/run", parts[1]),
                Some(&json!({"id":row["turn"],"revision":revision,"input":parts[3]})),
            )
            .await?;
        db.execute(
            &format!("UPDATE {platform}_inbox SET status='running' WHERE turn=?"),
            [string(row, "turn")],
        )?;
    }
    let run = local
        .request(
            &format!("{base}/workflow-runs/{}", string(row, "turn")),
            None,
        )
        .await?;
    if run["status"] == "approval" {
        transaction(db, || {
            let notice = one(
                db,
                &format!("SELECT notice FROM {platform}_approvals WHERE run=? AND revision=?"),
                params![row["turn"].as_str(), run["revision"].as_i64()],
            )?;
            if notice.is_none() {
                let id = new_id();
                db.execute(
                    &format!("INSERT INTO {platform}_approvals VALUES(?,?,?)"),
                    params![row["turn"].as_str(), run["revision"].as_i64(), id],
                )?;
                let text = format!(
                    "{}\n\nApprove: {prefix}approve {} {} yes\nReject: {prefix}approve {} {} no",
                    string(&run, "prompt"),
                    string(row, "turn"),
                    run["revision"],
                    string(row, "turn"),
                    run["revision"]
                );
                if platform == "slack" {
                    super::slack::finish(db, row, &text, Some(&id))?;
                } else {
                    db.execute("INSERT INTO telegram_outbox(id,chat,reply_to,text,status) VALUES(?,?,?,?,'queued')",params![id,row["chat"].as_i64(),row["message"].as_i64(),text])?;
                }
            }
            Ok(())
        })?;
    }
    if done(string(&run, "status")) {
        super::media::snapshot(
            db,
            platform,
            base,
            row,
            &run,
            local,
            Some(string(row, "turn")),
        )
        .await?;
        finish(
            db,
            platform,
            row,
            if run["status"] == "done" {
                let result = string(&run, "result");
                if result.is_empty() {
                    "Workflow finished without a text result."
                } else {
                    result
                }
            } else if run["status"] == "cancelled" {
                "Workflow cancelled."
            } else if platform == "slack" {
                "Workflow failed or rejected. Check earlier results in Briefsip."
            } else {
                "Workflow failed or was rejected. Check previous results in Briefsip."
            },
        )?;
    }
    Ok(true)
}
pub async fn callbacks(
    db: &Connection,
    platform: &str,
    base: &str,
    options: &Options,
    local: &Local,
) -> Result<()> {
    if platform != "slack" {
        return Ok(());
    }
    for row in all(db,"SELECT c.id,c.accepted,a.run,a.revision,w.channel,w.sender,w.root FROM slack_callbacks c JOIN slack_approvals a ON a.notice=c.notice JOIN slack_workflows w ON w.run=a.run WHERE c.status='queued' ORDER BY c.rowid LIMIT 20",[])?{
        if !options.users.contains(&row["sender"])||!string(&row,"channel").starts_with('D')&&!options.channels.iter().any(|s|row["channel"]==*s){db.execute("UPDATE slack_callbacks SET status='revoked' WHERE id=?",[string(&row,"id")])?;continue;}
        let result=local.request(&format!("{base}/workflow-runs/{}/approve",string(&row,"run")),Some(&json!({"id":row["id"],"revision":row["revision"],"accepted":row["accepted"]==1}))).await;
        let text=match result{Ok(_)if row["accepted"]==1=>"Approval received.",Ok(_)=>"Rejection received.",Err(e)if [400,404,409].contains(&e.status)=>"Decision rejected. Check workflow revision and status in Briefsip.",Err(e)=>return Err(e)};
        let mut response=row.clone();response["turn"]=row["id"].clone();super::slack::finish(db,&response,text,None)?;db.execute("UPDATE slack_callbacks SET status='done' WHERE id=?",[string(&row,"id")])?;
    }
    Ok(())
}
