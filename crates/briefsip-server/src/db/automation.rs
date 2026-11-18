use super::{canonical, column, table, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashSet};

const MAX_TIME: i64 = 253370764799999;
const MAX_SAFE_INTEGER: i64 = 9007199254740991;
const OBSERVATION: &str = "INTEGER NOT NULL DEFAULT 1 CHECK(observation_revision>0)";

fn has(db: &Connection, table: &str, name: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?) WHERE name=?)",
        [table, name],
        |r| r.get(0),
    )?)
}

pub(super) fn upgrade(db: &Connection) -> Result<()> {
    let mut routine_resync = false;
    let mut schedule_resync = false;
    for (table_name, routine) in [
        ("routines", true),
        ("routine_occurrences", true),
        ("schedules", false),
        ("occurrences", false),
    ] {
        if table(db, table_name)? && !has(db, table_name, "observation_revision")? {
            column(db, table_name, "observation_revision", OBSERVATION)?;
            if routine {
                routine_resync = true;
            } else {
                schedule_resync = true;
            }
        }
    }
    if table(db, "routines")? {
        column(
            db,
            "routines",
            "trigger",
            "TEXT NOT NULL DEFAULT 'schedule'",
        )?;
    }
    if table(db, "routine_schedule_bindings")? {
        if !has(db, "routine_schedule_bindings", "spec_json")? {
            column(
                db,
                "routine_schedule_bindings",
                "spec_json",
                "TEXT CHECK(spec_json IS NULL OR json_valid(spec_json))",
            )?;
            routine_resync = true;
        }
        let mut legacy_bindings = db.prepare(
            "SELECT b.routine,r.next_at,r.interval_ms FROM routine_schedule_bindings b
             JOIN routines r ON r.id=b.routine WHERE b.spec_json IS NULL",
        )?;
        let rows = legacy_bindings
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (routine, next_at, interval) in rows {
            let spec = match interval {
                Some(ms) => {
                    let amount = if ms % 60000 == 0 {
                        json!(ms / 60000)
                    } else {
                        json!(ms as f64 / 60000.0)
                    };
                    json!({"kind":"interval","amount":amount,"unit":"minute","anchorAt":next_at})
                }
                None => json!({"kind":"instant","at":next_at}),
            };
            db.execute(
                "UPDATE routine_schedule_bindings SET spec_json=? WHERE routine=?",
                params![canonical(&spec), routine],
            )?;
        }
    }
    if table(db, "routine_occurrences")? && upgrade_occurrences(db)? {
        routine_resync = true;
    }
    crate::automation::project::initialize(db).map_err(|error| error.message)?;
    if routine_resync {
        db.execute_batch(
            "INSERT INTO sync_scope_revisions(project,revision)
             SELECT DISTINCT project,1 FROM record_scopes WHERE table_name='routines'
             ON CONFLICT(project) DO UPDATE SET revision=revision+1",
        )?;
    }
    if schedule_resync {
        db.execute_batch(
            "INSERT INTO sync_scope_revisions(project,revision)
             SELECT DISTINCT project,1 FROM schedules WHERE true
             ON CONFLICT(project) DO UPDATE SET revision=revision+1",
        )?;
    }
    convert_workflow_schedules(db)?;
    Ok(())
}

fn upgrade_occurrences(db: &Connection) -> Result<bool> {
    let ddl: String = db.query_row(
        "SELECT sql FROM sqlite_schema WHERE name='routine_occurrences'",
        [],
        |r| r.get(0),
    )?;
    let had_kind = has(db, "routine_occurrences", "schedule_kind")?;
    if !had_kind {
        column(db, "routine_occurrences", "schedule_kind", "TEXT NOT NULL DEFAULT 'instant' CHECK(schedule_kind IN('instant','interval','once','cron'))")?;
        // Use the last configuration receipt at the occurrence's revision.
        db.execute_batch(include_str!("routine-schedule-kind.sql"))?;
    }
    if !ddl.contains("'webhook'") {
        let sequence: Option<i64> = db
            .query_row(
                "SELECT seq FROM sqlite_sequence WHERE name='routine_occurrences'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if !has(db, "routine_occurrences", "source")? {
            column(
                db,
                "routine_occurrences",
                "source",
                "TEXT NOT NULL DEFAULT 'schedule'",
            )?;
        }
        db.execute_batch(
            "CREATE TEMP TABLE saved_routine_occurrences AS SELECT * FROM routine_occurrences;
             CREATE TEMP TABLE saved_routine_steps AS SELECT * FROM routine_steps;
             DROP TABLE routine_steps;
             DROP TABLE routine_occurrences;",
        )?;
        crate::automation::project::initialize(db).map_err(|error| error.message)?;
        db.execute_batch(
            "INSERT INTO routine_occurrences SELECT seq,id,routine,project,due_at,schedule_revision,
                initiator_account,assignment_revision,authority_generation,home_device,zone,zone_revision,
                missed_count,state,graph_json,task,observation_revision,source,schedule_kind
             FROM saved_routine_occurrences;
             INSERT INTO routine_steps SELECT * FROM saved_routine_steps;
             DROP TABLE saved_routine_steps;
             DROP TABLE saved_routine_occurrences;
             UPDATE sync_events SET body_json=json_set(body_json,'$.source','schedule')
             WHERE record_kind='routine_occurrence' AND json_type(body_json,'$.source') IS NULL;",
        )?;
        if let Some(sequence) = sequence {
            db.execute(
                "INSERT INTO sqlite_sequence(name,seq) SELECT 'routine_occurrences',?
                 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='routine_occurrences')",
                [sequence],
            )?;
            db.execute(
                "UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name='routine_occurrences'",
                [sequence],
            )?;
        }
        db.execute_batch(include_str!("../automation/project-indexes.sql"))?;
    }
    Ok(!had_kind)
}

struct LegacySchedule {
    workflow: String,
    agent: String,
    project: String,
    account: String,
    grant: i64,
    home: String,
    zone: String,
    zone_revision: i64,
    revision: i64,
    next_at: i64,
    interval: Option<i64>,
    input: String,
}

fn convert_workflow_schedules(db: &Connection) -> Result<()> {
    if !table(db, "workflow_schedules")? || !table(db, "workflow_occurrences")? {
        return Ok(());
    }
    let generation: String = db.query_row(
        "SELECT generation FROM authority_state WHERE id=1",
        [],
        |r| r.get(0),
    )?;
    let mut schedules = db.prepare(include_str!("legacy-workflow-schedules.sql"))?;
    let mut assignments = schedules.query([])?;
    let mut changed = BTreeSet::new();
    while let Some(row) = assignments.next()? {
        let schedule = LegacySchedule {
            workflow: row.get(0)?,
            agent: row.get(1)?,
            project: row.get(2)?,
            account: row.get(3)?,
            grant: row.get(4)?,
            home: row.get(5)?,
            zone: row.get(6)?,
            zone_revision: row.get(7)?,
            revision: row.get(8)?,
            next_at: row.get(9)?,
            interval: row.get(10)?,
            input: row.get(11)?,
        };
        if !(1..=MAX_SAFE_INTEGER).contains(&schedule.revision)
            || !(0..=MAX_TIME).contains(&schedule.next_at)
            || schedule
                .interval
                .is_some_and(|ms| !(60000..=31536000000).contains(&ms))
            || schedule.input.encode_utf16().count() > 16000
        {
            continue;
        }
        if convert_schedule(db, &schedule, &generation)? {
            changed.insert(schedule.project);
        }
    }
    for project in changed {
        db.execute(
            "INSERT INTO sync_scope_revisions VALUES (?,1) ON CONFLICT(project) DO UPDATE SET revision=revision+1",
            [project],
        )?;
    }
    Ok(())
}

fn convert_schedule(db: &Connection, s: &LegacySchedule, generation: &str) -> Result<bool> {
    let mut history = db.prepare(include_str!("legacy-workflow-history.sql"))?;
    let rows = history
        .query_map(params![s.workflow, s.account, s.project, s.agent], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, bool>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.iter().any(|(at, missed, _, verified)| {
        !verified || !(0..=MAX_TIME).contains(at) || !(0..=MAX_SAFE_INTEGER).contains(missed)
    }) {
        return Ok(false);
    }
    let spec = match s.interval {
        Some(ms) => json!({"kind":"legacy_interval","intervalMs":ms,"anchorAt":s.next_at}),
        None => json!({"kind":"instant","at":s.next_at}),
    };
    let processed: HashSet<_> = rows.iter().map(|r| r.0).collect();
    let mut next = Some(s.next_at);
    while let Some(at) = next.filter(|at| processed.contains(at)) {
        next = s.interval.map(|ms| at + ms).filter(|at| *at <= MAX_TIME);
    }
    db.execute(
        "INSERT INTO schedules(id,project,agent,home_device,initiator_account,assignment_revision,authority_generation,kind,zone,zone_revision,spec_json,next_at,enabled,revision)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?)",
        params![s.workflow,s.project,s.agent,s.home,s.account,s.grant,generation,spec["kind"].as_str(),s.zone,s.zone_revision,canonical(&spec),next,s.revision],
    )?;
    db.execute(
        "INSERT INTO workflow_schedule_targets VALUES (?1,?1,?2)",
        params![s.workflow, s.input],
    )?;
    for (at, missed, run, _) in rows {
        let identity = json!([s.workflow, s.revision, s.zone_revision, at, 0]).to_string();
        let id = URL_SAFE_NO_PAD.encode(Sha256::digest(identity.as_bytes()));
        let state = if run.is_some() {
            "admitted"
        } else {
            "consumed"
        };
        let admission = run
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        db.execute(
            "INSERT INTO occurrences(schedule,occurrence_id,due_at,schedule_revision,zone_revision,initiator_account,
             assignment_revision,authority_generation,task,state,missed_count,run,admission_id)
             VALUES(?,?,?,?,?,?,?,?,NULL,?,?,?,?)",
            params![s.workflow,id,at,s.revision,s.zone_revision,s.account,s.grant,generation,state,missed,run,admission],
        )?;
    }
    Ok(true)
}
