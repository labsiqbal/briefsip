use super::*;

#[tokio::test]
async fn routine_schedule_rejects_invalid_specs_and_mixed_shapes_before_writes() -> Result<()> {
    let f = Fixture::new(epoch("2024-01-01T00:00:00Z"))?;
    for spec in [
        Value::Null,
        json!({}),
        json!({"kind":"instant","at":-1}),
        json!({"kind":"instant","at":253370764800000_i64}),
        json!({"kind":"once","date":"2024-02-30","time":"09:00"}),
        json!({"kind":"once","date":"2024-01-01","time":"24:00"}),
        json!({"kind":"once","date":"2024-01-01","time":"09:00","zone":"UTC"}),
        json!({"kind":"interval","amount":4,"unit":"minute","anchorAt":0}),
        json!({"kind":"interval","amount":5.5,"unit":"minute","anchorAt":0}),
        json!({"kind":"interval","amount":300,"unit":"second","anchorAt":0}),
        json!({"kind":"legacy_interval","intervalMs":60000,"anchorAt":0}),
        json!({"kind":"cron","expression":"* * * * *"}),
        json!({"kind":"cron","expression":"0 9 31 2 *"}),
        json!({"kind":"cron","expression":"@daily"}),
        json!({"kind":"cron","expression":"0 9 * * MON"}),
        json!({"kind":"cron","expression":"0 9 * * *","zone":"UTC"}),
    ] {
        let err = f
            .routine(&routine(spec.clone(), 0, true))
            .await
            .err()
            .ok_or_else(|| fixture_error("invalid routine"))?;
        assert!([400, 422].contains(&err.status), "{spec}");
    }
    let valid = routine(json!({"kind":"instant","at":f.state.config.now()}), 0, true);
    for extra in [
        json!({"nextAt":f.state.config.now()}),
        json!({"intervalSeconds":null}),
        json!({"nextAt":f.state.config.now()+1,"intervalSeconds":300}),
    ] {
        let mut body = valid.clone();
        body.as_object_mut()
            .ok_or_else(|| fixture_error("command"))?
            .extend(
                extra
                    .as_object()
                    .ok_or_else(|| fixture_error("extra fields"))?
                    .clone(),
            );
        assert_eq!(
            f.routine(&body)
                .await
                .err()
                .ok_or_else(|| fixture_error("mixed timing"))?
                .status,
            400
        );
    }
    f.db(|db| {
        assert!(!exists(db, "SELECT 1 FROM routines", [])?);
        assert!(!exists(db, "SELECT 1 FROM receipts", [])?);
        Ok(())
    })
}

#[tokio::test]
async fn routine_cron_skips_gaps_and_second_fold_instants() -> Result<()> {
    let mut f = Fixture::new(epoch("2024-03-10T05:00:00Z"))?;
    f.zone("America/New_York", 2)?;
    let gap = routine(json!({"kind":"cron","expression":"30 2 * * *"}), 0, true);
    f.routine(&gap).await?;
    assert_eq!(
        f.routine_detail(string(&gap, "id")).await?["next_at"],
        epoch("2024-03-11T06:30:00Z")
    );
    f.db(|db| {
        db.execute(
            "UPDATE routines SET enabled=0 WHERE id=?",
            [string(&gap, "id")],
        )?;
        Ok(())
    })?;
    f.clock(epoch("2024-11-03T04:00:00Z"));
    let fold = routine(json!({"kind":"cron","expression":"30 1 * * *"}), 0, true);
    let id = string(&fold, "id");
    f.routine(&fold).await?;
    assert_eq!(
        f.routine_detail(id).await?["next_at"],
        epoch("2024-11-03T05:30:00Z")
    );
    f.clock(epoch("2024-11-03T05:30:00Z"));
    f.ready()?;
    f.tick()?;
    assert_eq!(
        f.routine_detail(id).await?["next_at"],
        epoch("2024-11-04T06:30:00Z")
    );
    f.db(|db| {
        db.execute(
            "UPDATE tasks SET state='completed' WHERE project=?",
            [PROJECT],
        )?;
        db.execute(
            "UPDATE turns SET status='done',reply='Private result' WHERE agent=?",
            [AGENT],
        )?;
        Ok(())
    })?;
    f.tick()?;
    f.clock(epoch("2024-11-03T06:30:00Z"));
    f.ready()?;
    f.tick()?;
    assert_eq!(
        f.routine_runs(id)
            .await?
            .as_array()
            .ok_or_else(|| fixture_error("runs"))?
            .len(),
        1
    );
    let during_fold = routine(fold["schedule"].clone(), 0, true);
    f.routine(&during_fold).await?;
    assert_eq!(
        f.routine_detail(string(&during_fold, "id")).await?["next_at"],
        epoch("2024-11-04T06:30:00Z")
    );
    Ok(())
}

#[tokio::test]
async fn routine_once_keeps_identity_and_never_replays_after_dst_admission() -> Result<()> {
    for (date, time, expected) in [
        ("2024-03-10", "02:30", "2024-03-10T07:00:00Z"),
        ("2024-11-03", "01:30", "2024-11-03T05:30:00Z"),
    ] {
        let now = epoch(expected);
        let f = Fixture::new(now)?;
        f.zone("America/New_York", 2)?;
        let spec = json!({"kind":"once","date":date,"time":time});
        let command = routine(spec.clone(), 0, true);
        let id = string(&command, "id");
        let initial = f.routine(&command).await?;
        let detail = f.routine_detail(id).await?;
        assert_eq!(detail["next_at"], now);
        assert_eq!(detail["schedule"], spec);
        f.tick()?;
        let pending = f.routine_runs(id).await?;
        assert_eq!(pending[0]["state"], "pending");
        assert_eq!(pending[0]["scheduleKind"], "once");
        assert_eq!(
            pending[0]["id"],
            workflow_identity(&json!([id, 1, 2, now, 0]))
        );
        assert_eq!(f.routine_detail(id).await?["enabled"], 1);
        f.db(|db| {
            let events = all(
                db,
                "SELECT body_json FROM sync_events WHERE record_kind='routine_occurrence'",
                [],
            )?;
            assert_eq!(events.len(), 1);
            assert_eq!(data::json(&events[0]["body_json"])?["scheduleKind"], "once");
            Ok(())
        })?;
        f.ready()?;
        f.tick()?;
        assert_eq!(f.routine_detail(id).await?["enabled"], 0);
        let admitted = f.routine_runs(id).await?;
        assert_eq!(admitted[0]["id"], pending[0]["id"]);
        assert_eq!(admitted[0]["state"], "admitted");
        f.db(|db| {
            db.execute(
                "UPDATE tasks SET state='completed' WHERE project=?",
                [PROJECT],
            )?;
            db.execute("UPDATE turns SET status='done' WHERE agent=?", [AGENT])?;
            Ok(())
        })?;
        f.tick()?;
        let mut f = f.restart()?;
        f.clock(now + 3600000);
        f.ready()?;
        f.tick()?;
        assert_eq!(
            f.routine_runs(id)
                .await?
                .as_array()
                .ok_or_else(|| fixture_error("runs"))?
                .len(),
            1
        );
        assert_eq!(f.routine(&command).await?["receipt"], initial["receipt"]);
        let edit = routine(spec, 2, true);
        assert_eq!(
            f.request(&format!("/routines/{id}/edit"), Some(&edit))
                .await
                .err()
                .ok_or_else(|| fixture_error("consumed routine"))?
                .code,
            "schedule_processed"
        );
    }
    Ok(())
}

#[tokio::test]
async fn routine_config_flow_and_receipts_commit_with_metadata_only_observations() -> Result<()> {
    let now = epoch("2024-01-01T00:00:00Z");
    let f = Fixture::new(now)?;
    let before = f.sync(OWNER, None).await?;
    let command = routine(
        json!({"kind":"interval","amount":5,"unit":"minute","anchorAt":now}),
        0,
        true,
    );
    let id = string(&command, "id");
    let cursor = string(&before, "nextCursor");
    f.db(|db| { db.execute_batch("CREATE TRIGGER fail_routine_event BEFORE INSERT ON sync_events WHEN NEW.record_kind='routine' BEGIN SELECT RAISE(ABORT,'fixture routine observation fault'); END")?; Ok(()) })?;
    assert_eq!(
        f.routine(&command)
            .await
            .err()
            .ok_or_else(|| fixture_error("routine observation rollback"))?
            .code,
        "storage_failed"
    );
    f.db(|db| {
        assert!(!exists(db, "SELECT 1 FROM routines", [])?);
        assert!(!exists(db, "SELECT 1 FROM receipts", [])?);
        db.execute_batch("DROP TRIGGER fail_routine_event")?;
        Ok(())
    })?;
    assert!(sync_events(&f.sync(OWNER, Some(cursor)).await?).is_empty());
    let saved = f.routine(&command).await?;
    let created = f.sync(OWNER, Some(cursor)).await?;
    let events = sync_events(&created);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["recordKind"], "routine");
    assert_eq!(events[0]["revision"], 1);
    assert_eq!(
        events[0]["body"]["detailRef"],
        format!("/api/projects/{PROJECT}/routines/{id}")
    );
    assert_eq!(events[0]["body"]["homeDeviceId"], HOME);
    assert_eq!(events[0]["body"]["zone"], "Asia/Jakarta");
    assert_eq!(events[0]["body"]["scheduleRevision"], 1);
    let path = format!("/routines/{id}/flow");
    let flow = flow(0, json!([]));
    let recorded = f.request(&path, Some(&flow)).await?;
    let changed = f.sync(OWNER, Some(string(&created, "nextCursor"))).await?;
    let flow_events = sync_events(&changed);
    assert_eq!(flow_events.len(), 1);
    assert_eq!(flow_events[0]["recordKind"], "routine_flow");
    assert_eq!(flow_events[0]["revision"], 1);
    for marker in [
        "PRIVATE_ROUTINE_PROMPT",
        "\"graph\"",
        "\"links\"",
        "PRIVATE_INSTRUCTIONS",
    ] {
        assert!(!json!([created, changed]).to_string().contains(marker));
    }
    assert_eq!(f.routine(&command).await?["receipt"], saved["receipt"]);
    assert_eq!(
        f.request(&path, Some(&flow)).await?["receipt"],
        recorded["receipt"]
    );
    assert!(sync_events(&f.sync(OWNER, Some(string(&changed, "nextCursor"))).await?).is_empty());
    let snapshot = f.sync(OWNER, None).await?;
    let routines = sync_events(&snapshot)
        .iter()
        .filter(|event| string(event, "recordKind").starts_with("routine"))
        .map(|event| &event["body"])
        .collect::<Vec<_>>();
    assert_eq!(routines, [&events[0]["body"], &flow_events[0]["body"]]);
    Ok(())
}

#[tokio::test]
async fn routine_manual_run_preserves_pending_catchup_and_rolls_back_every_effect() -> Result<()> {
    let now = epoch("2024-01-01T00:00:00Z");
    let f = Fixture::new(now)?;
    let id = "11111111-1111-4111-8111-111111111111";
    let mut config = routine(
        json!({"kind":"interval","amount":5,"unit":"minute","anchorAt":now-600000}),
        0,
        true,
    );
    config["requestId"] = json!(id);
    config["id"] = json!(id);
    f.routine(&config).await?;
    f.schedule_tick()?;
    let config = f.routine_detail(id).await?;
    let pending = || {
        f.db(|db| {
            one(
                db,
                "SELECT * FROM routine_occurrences WHERE source='schedule'",
                [],
            )
            .and_then(|row| row.ok_or_else(|| fixture_error("pending schedule")))
        })
    };
    let before = pending()?;
    let start = event_head(&f)?;
    let request = json!({"requestId":"22222222-2222-4222-8222-222222222222"});
    let path = format!("/routines/{id}/run");
    let counts = || {
        f.db(|db| {
            [
                "tasks",
                "turns",
                "threads",
                "receipts",
                "record_scopes",
                "routine_steps",
            ]
            .into_iter()
            .map(|table| {
                db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| {
                    r.get::<_, i64>(0)
                })
                .map_err(Into::into)
            })
            .collect::<Result<Vec<_>>>()
        })
    };
    for fault in [
        "BEFORE INSERT ON sync_events WHEN NEW.record_kind='routine_occurrence'",
        "BEFORE INSERT ON receipts WHEN NEW.scope LIKE 'retained:%/run'",
    ] {
        let saved = counts()?;
        f.db(|db| { db.execute_batch(&format!("CREATE TRIGGER fail_manual {fault} BEGIN SELECT RAISE(ABORT,'fixture manual fault'); END"))?; Ok(()) })?;
        assert_eq!(
            f.request(&path, Some(&request))
                .await
                .err()
                .ok_or_else(|| fixture_error("manual admission rollback"))?
                .code,
            "storage_failed"
        );
        f.db(|db| {
            db.execute_batch("DROP TRIGGER fail_manual")?;
            Ok(())
        })?;
        assert_eq!(counts()?, saved);
        assert!(events_after(&f, start)?.is_empty());
    }
    let admitted = f.request(&path, Some(&request)).await?;
    let occurrence = string(&admitted["data"], "occurrenceId");
    let task = string(&admitted["data"], "taskId");
    assert_eq!(admitted["receipt"]["status"], 202);
    assert_eq!(admitted["data"]["state"], "waiting_device");
    assert_eq!(occurrence, "9L_G-GrTeTWqB4kfWFGm12Gx_YgmpmYdHL-lSByUN1g");
    let manual_row = f.db(|db| {
        one(
            db,
            "SELECT * FROM routine_occurrences WHERE id=?",
            [occurrence],
        )
        .and_then(|row| row.ok_or_else(|| fixture_error("manual occurrence")))
    })?;
    assert_eq!(manual_row["source"], "manual");
    assert_eq!(
        manual_row["observation_revision"],
        admitted["receipt"]["recordRevision"]
    );
    assert_eq!(
        data::json(&manual_row["graph_json"])?,
        json!({"root":AGENT,"nodes":[AGENT],"links":[]})
    );
    f.db(|db| {
        assert_eq!(
            one(db, "SELECT home_device FROM tasks WHERE id=?", [task])?
                .ok_or_else(|| fixture_error("manual task"))?["home_device"],
            HOME
        );
        Ok(())
    })?;
    assert_eq!(pending()?, before);
    assert_eq!(f.routine_detail(id).await?, config);
    let observations = events_after(&f, start)?;
    assert_eq!(
        observations
            .iter()
            .filter(|e| e["record_kind"] == "routine_occurrence")
            .map(|e| &e["body"]["source"])
            .collect::<Vec<_>>(),
        [&json!("manual")]
    );
    assert!(!json!(observations).to_string().contains("PRIVATE_"));
    for state in ["queued", "paused", "uncertain"] {
        f.db(|db| {
            db.execute("UPDATE tasks SET state=? WHERE id=?", params![state, task])?;
            Ok(())
        })?;
        let busy = f
            .request(
                &path,
                Some(&json!({"requestId":uuid::Uuid::new_v4().to_string()})),
            )
            .await
            .err()
            .ok_or_else(|| fixture_error("busy manual routine"))?;
        assert_eq!((busy.status, busy.code), (409, "routine_busy"));
    }
    f.settle_routine(task)?;
    let second = f
        .request(
            &path,
            Some(&json!({"requestId":uuid::Uuid::new_v4().to_string()})),
        )
        .await?;
    assert_ne!(second["data"]["occurrenceId"], occurrence);
    f.db(|db| {
        assert_eq!(
            one(
                db,
                "SELECT due_at FROM routine_occurrences WHERE id=?",
                [string(&second["data"], "occurrenceId")]
            )?
            .ok_or_else(|| fixture_error("second occurrence"))?["due_at"],
            manual_row["due_at"]
        );
        assert!(all(db, "PRAGMA foreign_key_check", [])?.is_empty());
        Ok(())
    })?;
    assert_eq!(pending()?, before);
    assert_eq!(
        f.request(&path, Some(&request)).await?["receipt"],
        admitted["receipt"]
    );
    Ok(())
}

#[tokio::test]
async fn routine_manual_admission_snapshots_flow_and_rechecks_private_scope_on_replay() -> Result<()>
{
    let now = epoch("2024-01-01T00:00:00Z");
    let f = Fixture::new(now)?;
    let target = uuid::Uuid::new_v4().to_string();
    f.add_agent(&target)?;
    let config = routine(
        json!({"kind":"interval","amount":5,"unit":"minute","anchorAt":now+600000}),
        0,
        true,
    );
    f.routine(&config).await?;
    let path = format!("/routines/{}", string(&config, "id"));
    let flow_path = path.clone() + "/flow";
    let run_path = path + "/run";
    let links = json!([{"from":AGENT,"to":target}]);
    f.request(&flow_path, Some(&flow(0, links.clone()))).await?;
    let request = json!({"requestId":uuid::Uuid::new_v4().to_string()});
    let saved = f.request(&run_path, Some(&request)).await?;
    let occurrence = string(&saved["data"], "occurrenceId");
    let graph = || {
        f.db(|db| {
            one(
                db,
                "SELECT graph_json FROM routine_occurrences WHERE id=?",
                [occurrence],
            )
            .and_then(|row| {
                Ok(row.ok_or_else(|| fixture_error("occurrence"))?["graph_json"].clone())
            })
        })
    };
    let snapshot = graph()?;
    assert_eq!(data::json(&snapshot)?["links"], links);
    f.request(&flow_path, Some(&flow(1, json!([])))).await?;
    assert_eq!(graph()?, snapshot);
    assert_eq!(
        f.request(&run_path, Some(&request)).await?["receipt"],
        saved["receipt"]
    );
    f.db(|db| {
        let private = uuid::Uuid::new_v4().to_string();
        db.execute("INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES(?,'fixture','private',0)",[&private])?;
        db.execute("UPDATE record_scopes SET visibility='owner',account=? WHERE table_name='routine_flows'",[&private])?;
        Ok(())
    })?;
    for body in [
        request,
        json!({"requestId":uuid::Uuid::new_v4().to_string()}),
    ] {
        assert_eq!(
            f.request(&run_path, Some(&body))
                .await
                .err()
                .ok_or_else(|| fixture_error("private flow"))?
                .status,
            404
        );
    }
    assert!(!f.sync(OWNER, None).await?.to_string().contains("PRIVATE_"));
    Ok(())
}

#[tokio::test]
async fn routine_offline_catchup_admission_and_terminal_sync_are_atomic() -> Result<()> {
    let now = epoch("2024-01-01T00:00:00Z");
    let mut f = Fixture::new(now)?;
    let config = routine(
        json!({"kind":"interval","amount":5,"unit":"minute","anchorAt":now-600000}),
        0,
        true,
    );
    let id = string(&config, "id");
    f.routine(&config).await?;
    let before = event_head(&f)?;
    f.db(|db| { db.execute_batch("CREATE TRIGGER fail_observation BEFORE INSERT ON sync_events WHEN NEW.record_kind='routine_occurrence' BEGIN SELECT RAISE(ABORT,'fixture occurrence fault'); END")?; Ok(()) })?;
    assert_eq!(
        f.schedule_tick()
            .err()
            .ok_or_else(|| fixture_error("occurrence rollback"))?
            .code,
        "storage_failed"
    );
    assert_eq!(f.routine_runs(id).await?, json!([]));
    assert!(events_after(&f, before)?.is_empty());
    f.db(|db| {
        db.execute_batch("DROP TRIGGER fail_observation")?;
        Ok(())
    })?;
    f.schedule_tick()?;
    let pending = events_after(&f, before)?;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0]["record_kind"], "routine_occurrence");
    assert_eq!(pending[0]["revision"], 1);
    assert_eq!(pending[0]["body"]["source"], "schedule");
    assert_eq!(pending[0]["body"]["state"], "pending");
    assert_eq!(pending[0]["body"]["missedCount"], 2);
    let occurrence = &pending[0]["record_id"];
    let after_pending = event_head(&f)?;
    f.schedule_tick()?;
    assert!(events_after(&f, after_pending)?.is_empty());
    f.clock(now + 300000);
    f.schedule_tick()?;
    let missed = events_after(&f, after_pending)?;
    assert_eq!(missed[0]["record_id"], *occurrence);
    assert_eq!(missed[0]["revision"], 2);
    assert_eq!(missed[0]["body"]["missedCount"], 3);
    let after_missed = event_head(&f)?;
    f.ready()?;
    f.db(|db| { db.execute_batch("CREATE TRIGGER fail_observation BEFORE INSERT ON sync_events WHEN NEW.record_kind='routine' BEGIN SELECT RAISE(ABORT,'fixture admission fault'); END")?; Ok(()) })?;
    assert_eq!(
        f.schedule_tick()
            .err()
            .ok_or_else(|| fixture_error("admission rollback"))?
            .code,
        "storage_failed"
    );
    assert_eq!(f.routine_runs(id).await?[0]["state"], "pending");
    f.db(|db| {
        assert!(!exists(db, "SELECT 1 FROM tasks", [])?);
        db.execute_batch("DROP TRIGGER fail_observation")?;
        Ok(())
    })?;
    assert!(events_after(&f, after_missed)?.is_empty());
    f.schedule_tick()?;
    let admitted = events_after(&f, after_missed)?
        .into_iter()
        .filter(|e| string(e, "record_kind").starts_with("routine"))
        .collect::<Vec<_>>();
    assert_eq!(
        admitted
            .iter()
            .map(|e| json!([e["record_kind"], e["revision"]]))
            .collect::<Vec<_>>(),
        [json!(["routine", 2]), json!(["routine_occurrence", 3])]
    );
    assert_eq!(admitted[0]["body"]["scheduleRevision"], 2);
    assert_eq!(admitted[1]["record_id"], *occurrence);
    assert_eq!(admitted[1]["body"]["state"], "admitted");
    let task = string(&admitted[1]["body"], "taskId");
    let after_admitted = event_head(&f)?;
    f.db(|db| { db.execute_batch("CREATE TRIGGER fail_observation BEFORE INSERT ON sync_events WHEN NEW.record_kind='routine_occurrence' BEGIN SELECT RAISE(ABORT,'fixture settlement fault'); END")?; Ok(()) })?;
    assert_eq!(
        f.settle_routine(task)
            .err()
            .ok_or_else(|| fixture_error("settlement rollback"))?
            .code,
        "storage_failed"
    );
    assert_eq!(f.routine_runs(id).await?[0]["steps"][0]["state"], "queued");
    assert!(events_after(&f, after_admitted)?.is_empty());
    f.db(|db| {
        db.execute_batch("DROP TRIGGER fail_observation")?;
        Ok(())
    })?;
    f.schedule_tick()?;
    let settled = events_after(&f, after_admitted)?;
    assert_eq!(settled.len(), 1);
    assert_eq!(settled[0]["record_id"], *occurrence);
    assert_eq!(settled[0]["revision"], 4);
    assert_eq!(settled[0]["body"]["state"], "done");
    assert_eq!(
        settled[0]["body"]["detailRef"],
        format!("/api/projects/{PROJECT}/routines/{id}/runs")
    );
    assert!(!json!([pending, missed, admitted, settled])
        .to_string()
        .contains("PRIVATE_"));
    let after_settled = event_head(&f)?;
    f.schedule_tick()?;
    assert!(events_after(&f, after_settled)?.is_empty());
    f.db(|db| {
        assert!(all(db, "PRAGMA foreign_key_check", [])?.is_empty());
        Ok(())
    })
}

#[tokio::test]
async fn routine_sync_rechecks_assignments_and_each_private_mapping() -> Result<()> {
    let now = epoch("2024-01-01T00:00:00Z");
    let f = Fixture::new(now)?;
    let member = uuid::Uuid::new_v4().to_string();
    let unassigned = uuid::Uuid::new_v4().to_string();
    f.db(|db| {
        for account in [&member, &unassigned] {
            db.execute(
                "INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES(?,'fixture',?,0)",
                [account, account],
            )?;
            db.execute(
                "INSERT INTO project_members VALUES(?,?,'member',1,0)",
                [PROJECT, account],
            )?;
        }
        db.execute(
            "INSERT INTO collaborator_agents VALUES(?,?,?,1,1)",
            params![PROJECT, member, AGENT],
        )?;
        Ok(())
    })?;
    let config = routine(
        json!({"kind":"interval","amount":5,"unit":"minute","anchorAt":now}),
        0,
        true,
    );
    let id = string(&config, "id");
    f.routine(&config).await?;
    f.request(&format!("/routines/{id}/flow"), Some(&flow(0, json!([]))))
        .await?;
    f.schedule_tick()?;
    let occurrence = f.routine_runs(id).await?[0]["id"].clone();
    let routine_kinds = |page: &Value| {
        sync_events(page)
            .iter()
            .map(|e| string(e, "recordKind"))
            .filter(|kind| kind.starts_with("routine"))
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    let visible = f.sync(&member, None).await?;
    assert_eq!(
        routine_kinds(&visible),
        ["routine", "routine_flow", "routine_occurrence"]
    );
    assert!(routine_kinds(&f.sync(&unassigned, None).await?).is_empty());
    f.db(|db| { db.execute("UPDATE record_scopes SET visibility='owner' WHERE table_name IN('routine_flows','routine_occurrences')",[])?; Ok(()) })?;
    assert_eq!(
        f.sync(&member, Some(string(&visible, "nextCursor")))
            .await
            .err()
            .ok_or_else(|| fixture_error("private occurrence and flow"))?
            .code,
        "resync_required"
    );
    assert_eq!(routine_kinds(&f.sync(&member, None).await?), ["routine"]);
    f.db(|db| {
        db.execute(
            "UPDATE record_scopes SET account=?,visibility='owner' WHERE table_name='routines'",
            [&member],
        )?;
        Ok(())
    })?;
    assert!(routine_kinds(&f.sync(OWNER, None).await?).is_empty());
    f.db(|db| { db.execute("UPDATE record_scopes SET visibility='project' WHERE table_name IN('routines','routine_flows','routine_occurrences')",[])?; Ok(()) })?;
    let previous = f.sync(&member, None).await?;
    f.db(|db| { db.execute("UPDATE collaborator_agents SET enabled=0,revision=revision+1 WHERE project=? AND account=?",params![PROJECT,member])?; Ok(()) })?;
    assert_eq!(
        f.sync(&member, Some(string(&previous, "nextCursor")))
            .await
            .err()
            .ok_or_else(|| fixture_error("revoked routine reader"))?
            .code,
        "resync_required"
    );
    assert!(routine_kinds(&f.sync(&member, None).await?).is_empty());
    let owner = f.sync(OWNER, None).await?;
    assert_eq!(
        sync_events(&owner)
            .iter()
            .find(|e| e["recordId"] == occurrence)
            .ok_or_else(|| fixture_error("owner occurrence"))?["body"]["state"],
        "pending"
    );
    Ok(())
}

#[tokio::test]
async fn routine_zone_observations_preserve_pending_and_disabled_timing_revisions() -> Result<()> {
    let now = epoch("2024-01-01T00:00:00Z");
    let f = Fixture::new(now)?;
    let config = routine(
        json!({"kind":"interval","amount":5,"unit":"minute","anchorAt":now}),
        0,
        true,
    );
    let id = string(&config, "id");
    f.routine(&config).await?;
    f.schedule_tick()?;
    let before = event_head(&f)?;
    let pending = f.routine_runs(id).await?;
    f.zone("America/New_York", 2)?;
    f.schedule_tick()?;
    let changed = events_after(&f, before)?;
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0]["record_kind"], "routine");
    assert_eq!(changed[0]["revision"], 2);
    assert_eq!(changed[0]["body"]["zone"], "America/New_York");
    assert_eq!(changed[0]["body"]["zoneRevision"], 2);
    assert_eq!(changed[0]["body"]["scheduleRevision"], 1);
    assert_eq!(changed[0]["body"]["nextAt"], pending[0]["dueAt"]);
    assert_eq!(f.routine_runs(id).await?, pending);
    let changed_head = event_head(&f)?;
    f.schedule_tick()?;
    assert!(events_after(&f, changed_head)?.is_empty());
    let future = routine(
        json!({"kind":"interval","amount":5,"unit":"minute","anchorAt":now+600000}),
        1,
        false,
    );
    f.request(&format!("/routines/{id}/edit"), Some(&future))
        .await?;
    let disabled_head = event_head(&f)?;
    f.zone("Europe/London", 3)?;
    f.schedule_tick()?;
    let after = events_after(&f, disabled_head)?;
    assert_eq!(after.len(), 1);
    assert_eq!(after[0]["body"]["zone"], "Europe/London");
    assert_eq!(after[0]["body"]["enabled"], false);
    assert_eq!(after[0]["body"]["scheduleRevision"], 2);
    Ok(())
}

#[tokio::test]
async fn routine_edit_blocks_pending_and_atomically_cancels_unstarted_work() -> Result<()> {
    let now = epoch("2024-01-01T00:00:00Z");
    let f = Fixture::new(now)?;
    let spec = json!({"kind":"interval","amount":5,"unit":"minute","anchorAt":now});
    let config = routine(spec.clone(), 0, true);
    let id = string(&config, "id");
    let path = format!("/routines/{id}/edit");
    f.routine(&config).await?;
    f.schedule_tick()?;
    let pending = f.routine_runs(id).await?;
    let before = event_head(&f)?;
    let future = routine(
        json!({"kind":"interval","amount":5,"unit":"minute","anchorAt":now+600000}),
        1,
        true,
    );
    f.request(&path, Some(&future)).await?;
    let blocked = events_after(&f, before)?;
    assert_eq!(
        blocked
            .iter()
            .find(|e| e["record_id"] == pending[0]["id"])
            .ok_or_else(|| fixture_error("blocked observation"))?["body"]["state"],
        "blocked"
    );
    assert_eq!(
        blocked
            .iter()
            .find(|e| e["record_kind"] == "routine")
            .ok_or_else(|| fixture_error("edited routine observation"))?["revision"],
        2
    );
    f.request(&path, Some(&routine(spec.clone(), 2, true)))
        .await?;
    f.ready()?;
    f.schedule_tick()?;
    let admitted = f.routine_runs(id).await?;
    let admitted_id = &admitted[0]["id"];
    let task = string(&admitted[0], "taskId");
    assert_eq!(admitted[0]["state"], "admitted");
    let disable = routine(spec, 4, false);
    let before = event_head(&f)?;
    f.db(|db| { db.execute_batch("CREATE TRIGGER fail_cancel BEFORE INSERT ON sync_events WHEN NEW.record_kind='routine_occurrence' BEGIN SELECT RAISE(ABORT,'fixture cancellation fault'); END")?; Ok(()) })?;
    assert_eq!(
        f.request(&path, Some(&disable))
            .await
            .err()
            .ok_or_else(|| fixture_error("cancellation rollback"))?
            .code,
        "storage_failed"
    );
    let state = || {
        f.db(|db| {
            one(db, "SELECT state FROM tasks WHERE id=?", [task]).and_then(|row| {
                Ok(row.ok_or_else(|| fixture_error("routine task"))?["state"].clone())
            })
        })
    };
    assert_eq!(state()?, "queued");
    assert_eq!(f.routine_runs(id).await?, admitted);
    assert!(events_after(&f, before)?.is_empty());
    f.db(|db| {
        db.execute_batch("DROP TRIGGER fail_cancel")?;
        Ok(())
    })?;
    let saved = f.request(&path, Some(&disable)).await?;
    let events = events_after(&f, before)?;
    assert_eq!(
        events
            .iter()
            .find(|e| e["record_id"] == *admitted_id)
            .ok_or_else(|| fixture_error("cancelled observation"))?["body"]["state"],
        "blocked"
    );
    assert_eq!(state()?, "cancelled");
    let after = event_head(&f)?;
    assert_eq!(
        f.request(&path, Some(&disable)).await?["receipt"],
        saved["receipt"]
    );
    assert!(events_after(&f, after)?.is_empty());
    Ok(())
}

#[tokio::test]
async fn routine_home_zone_edits_move_only_future_wall_clocks() -> Result<()> {
    let now = epoch("2024-01-01T00:00:00Z");
    let mut f = Fixture::new(now)?;
    let once_spec = json!({"kind":"once","date":"2024-01-02","time":"09:00"});
    let at = now + 300000;
    let once = routine(once_spec.clone(), 0, true);
    let cron = routine(json!({"kind":"cron","expression":"0 9 * * *"}), 0, true);
    let instant = routine(json!({"kind":"instant","at":at}), 0, true);
    let elapsed = routine(
        json!({"kind":"interval","amount":1,"unit":"day","anchorAt":at}),
        0,
        true,
    );
    for body in [&once, &cron, &instant, &elapsed] {
        f.routine(body).await?;
    }
    let id = string(&once, "id");
    assert_eq!(
        f.routine_detail(id).await?["next_at"],
        epoch("2024-01-02T02:00:00Z")
    );
    assert_eq!(
        f.routine_detail(string(&cron, "id")).await?["next_at"],
        epoch("2024-01-01T02:00:00Z")
    );
    f.zone("America/New_York", 2)?;
    f.schedule_tick()?;
    assert_eq!(
        f.routine_detail(id).await?["next_at"],
        epoch("2024-01-02T14:00:00Z")
    );
    assert_eq!(
        f.routine_detail(string(&cron, "id")).await?["next_at"],
        epoch("2024-01-01T14:00:00Z")
    );
    assert_eq!(
        f.routine_detail(string(&instant, "id")).await?["next_at"],
        at
    );
    assert_eq!(
        f.routine_detail(string(&elapsed, "id")).await?["next_at"],
        at
    );
    f.clock(epoch("2024-01-02T14:00:00Z"));
    f.schedule_tick()?;
    let pending = f.routine_runs(id).await?;
    f.zone("Pacific/Honolulu", 3)?;
    let f = f.restart()?;
    f.schedule_tick()?;
    assert_eq!(f.routine_runs(id).await?, pending);
    assert_eq!(f.routine_detail(id).await?["next_at"], pending[0]["dueAt"]);
    f.ready()?;
    f.schedule_tick()?;
    let admitted = f.routine_runs(id).await?;
    assert_eq!(admitted[0]["id"], pending[0]["id"]);
    assert_eq!(admitted[0]["zoneRevision"], 2);
    f.settle_routine(string(&admitted[0], "taskId"))?;
    let path = format!("/routines/{id}/edit");
    f.request(&path, Some(&routine(once_spec.clone(), 2, false)))
        .await?;
    assert_eq!(f.routine_detail(id).await?["next_at"], pending[0]["dueAt"]);
    assert_eq!(
        f.request(&path, Some(&routine(once_spec, 3, true)))
            .await
            .err()
            .ok_or_else(|| fixture_error("consumed routine"))?
            .code,
        "schedule_processed"
    );
    Ok(())
}

#[tokio::test]
async fn routine_cron_zone_history_survives_restart_and_admission_rollback() -> Result<()> {
    let mut f = Fixture::new(epoch("2024-01-01T00:00:00Z"))?;
    let spec = json!({"kind":"cron","expression":"0 9 * * *"});
    let config = routine(spec.clone(), 0, true);
    let id = string(&config, "id");
    f.routine(&config).await?;
    assert_eq!(
        f.routine_detail(id).await?["next_at"],
        epoch("2024-01-01T02:00:00Z")
    );
    f.clock(epoch("2024-01-03T22:00:00Z"));
    f.schedule_tick()?;
    let pending = f.routine_runs(id).await?;
    assert_eq!(pending[0]["missedCount"], 2);
    assert_eq!(pending[0]["scheduleKind"], "cron");
    f.zone("Pacific/Honolulu", 2)?;
    f.schedule_tick()?;
    assert_eq!(f.routine_runs(id).await?, pending);
    let mut f = f.restart()?;
    f.schedule_tick()?;
    assert_eq!(f.routine_runs(id).await?, pending);
    f.clock(epoch("2024-01-04T18:00:00Z"));
    f.schedule_tick()?;
    assert_eq!(f.routine_runs(id).await?, pending);
    f.clock(epoch("2024-01-04T19:00:00Z"));
    f.schedule_tick()?;
    assert_eq!(f.routine_runs(id).await?[0]["missedCount"], 3);
    f.zone("Asia/Jakarta", 3)?;
    f.schedule_tick()?;
    f.ready()?;
    let before = event_head(&f)?;
    f.db(|db| { db.execute_batch("CREATE TRIGGER fail_cron BEFORE INSERT ON receipts WHEN NEW.scope LIKE 'tasks:routine-step:%' BEGIN SELECT RAISE(ABORT,'fixture cron admission fault'); END")?; Ok(()) })?;
    assert_eq!(
        f.schedule_tick()
            .err()
            .ok_or_else(|| fixture_error("cron receipt fault"))?
            .code,
        "storage_failed"
    );
    assert_eq!(f.routine_runs(id).await?[0]["state"], "pending");
    assert!(events_after(&f, before)?.is_empty());
    f.db(|db| {
        assert!(!exists(db, "SELECT 1 FROM tasks", [])?);
        db.execute_batch("DROP TRIGGER fail_cron")?;
        Ok(())
    })?;
    f.schedule_tick()?;
    let admitted = f.routine_runs(id).await?;
    f.settle_routine(string(&admitted[0], "taskId"))?;
    f.schedule_tick()?;
    assert_eq!(
        admitted
            .as_array()
            .ok_or_else(|| fixture_error("runs"))?
            .len(),
        1
    );
    assert_eq!(admitted[0]["id"], pending[0]["id"]);
    assert_eq!(admitted[0]["zoneRevision"], 1);
    assert_eq!(admitted[0]["missedCount"], 3);
    assert_eq!(
        f.routine_detail(id).await?["next_at"],
        epoch("2024-01-05T02:00:00Z")
    );
    f.db(|db| {
        assert_eq!(
            db.query_row("SELECT count(*) FROM tasks", [], |r| r.get::<_, i64>(0))?,
            1
        );
        Ok(())
    })?;
    let before = event_head(&f)?;
    f.request(
        &format!("/routines/{id}/edit"),
        Some(&routine(spec, 2, false)),
    )
    .await?;
    assert_eq!(
        f.routine_detail(id).await?["next_at"],
        epoch("2024-01-05T02:00:00Z")
    );
    assert!(!json!(events_after(&f, before)?)
        .to_string()
        .contains("PRIVATE_"));
    Ok(())
}

#[tokio::test]
async fn routine_legacy_seconds_and_interval_metadata_preserve_exact_progress() -> Result<()> {
    let now = epoch("2024-01-01T00:00:00Z");
    let f = Fixture::new(now)?;
    let anchor = now - 960000;
    for seconds in [None, Some(300_i64), Some(301), Some(31536000)] {
        let mut command = routine(Value::Null, 0, true);
        command
            .as_object_mut()
            .ok_or_else(|| fixture_error("routine command"))?
            .remove("schedule");
        command["nextAt"] = json!(anchor);
        command["intervalSeconds"] = json!(seconds);
        let id = string(&command, "id");
        f.routine(&command).await?;
        let detail = f.routine_detail(id).await?;
        assert_eq!(detail["next_at"], anchor);
        assert_eq!(
            detail["schedule"]["kind"],
            if seconds.is_none() {
                "instant"
            } else {
                "interval"
            }
        );
        f.ready()?;
        f.schedule_tick()?;
        let admitted = f.routine_runs(id).await?;
        f.settle_routine(string(&admitted[0], "taskId"))?;
        let expected = seconds.map_or(anchor, |seconds| {
            anchor + (960 / seconds + 1) * seconds * 1000
        });
        assert_eq!(f.routine_detail(id).await?["next_at"], expected);
    }
    let spec = json!({"kind":"interval","amount":5,"unit":"minute","anchorAt":anchor});
    let config = routine(spec.clone(), 0, true);
    let id = string(&config, "id");
    f.routine(&config).await?;
    f.ready()?;
    f.schedule_tick()?;
    let admitted = f.routine_runs(id).await?;
    f.settle_routine(string(&admitted[0], "taskId"))?;
    let next = f.routine_detail(id).await?["next_at"].clone();
    f.request(
        &format!("/routines/{id}/edit"),
        Some(&routine(spec, 2, true)),
    )
    .await?;
    assert_eq!(f.routine_detail(id).await?["next_at"], next);
    Ok(())
}
