use super::*;
use std::collections::{BTreeMap, HashSet};

pub fn cleanup(db: &Connection, agent: &str) -> Result<()> {
    if !table(db, "agent_delete_checkpoints")? {
        return Ok(());
    }
    for row in all(
        db,
        "SELECT * FROM agent_delete_checkpoints WHERE agent=?",
        [agent],
    )? {
        let reference = string(&row, "ref");
        let hash = string(&row, "hash");
        let suffix = reference.strip_prefix("refs/briefsip/checkpoints/");
        if !suffix.is_some_and(|s| {
            s.len() == 36
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
        }) || ![40, 64].contains(&hash.len())
            || !hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(error(409, "Invalid checkpoint cleanup record."));
        }
        let status = std::process::Command::new("git")
            .args([
                "-C",
                string(&row, "directory"),
                "update-ref",
                "-d",
                reference,
                hash,
            ])
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|_| Failure::storage())?;
        if !status.success() {
            return Err(Failure::storage());
        }
        db.execute(
            "DELETE FROM agent_delete_checkpoints WHERE agent=? AND directory=? AND ref=?",
            [agent, string(&row, "directory"), reference],
        )?;
    }
    Ok(())
}
fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
fn marked(table: &str) -> String {
    format!(
        "rowid IN(SELECT rid FROM agent_delete_rows WHERE name='{}')",
        table.replace('\'', "''")
    )
}
fn mark(
    db: &Connection,
    tables: &HashSet<String>,
    table: &str,
    condition: &str,
    p: impl Params,
) -> Result<usize> {
    if !tables.contains(table) {
        return Ok(0);
    }
    Ok(db.execute(
        &format!(
            "INSERT OR IGNORE INTO agent_delete_rows SELECT '{}',rowid FROM {} WHERE {condition}",
            table.replace('\'', "''"),
            quote(table)
        ),
        p,
    )?)
}
pub fn initialize(db: &Connection) -> crate::db::Result<()> {
    let required = all(db, "PRAGMA table_info(turns)", [])
        .map_err(|_| "Cannot read turn schema")?
        .iter()
        .any(|r| r["name"] == "agent" && r["notnull"] == 1);
    if !required {
        return Ok(());
    }
    let sql: String = db.query_row(
        "SELECT sql FROM sqlite_schema WHERE name='turns'",
        [],
        |r| r.get(0),
    )?;
    let objects=all(db,"SELECT sql FROM sqlite_schema WHERE tbl_name='turns' AND sql IS NOT NULL AND type IN('index','trigger')",[]).map_err(|_|"Cannot read turn indexes")?;
    let sequence: Option<i64> = db
        .query_row(
            "SELECT seq FROM sqlite_sequence WHERE name='turns'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let table = regex::Regex::new(r#"(?i)CREATE TABLE\s+(?:"turns"|turns)"#)?;
    let agent = regex::Regex::new("(?i)agent TEXT NOT NULL")?;
    let upgrade = agent
        .replace(
            &table.replace(&sql, "CREATE TABLE turns_deletion_upgrade"),
            "agent TEXT",
        )
        .into_owned();
    db.execute_batch("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE")?;
    let result = (|| -> crate::db::Result<()> {
        db.execute_batch(&upgrade)?;
        db.execute_batch("INSERT INTO turns_deletion_upgrade SELECT * FROM turns; DROP TABLE turns; ALTER TABLE turns_deletion_upgrade RENAME TO turns;")?;
        if let Some(seq) = sequence {
            db.execute(
                "UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name='turns'",
                [seq],
            )?;
        }
        for object in objects {
            db.execute_batch(string(&object, "sql"))?;
        }
        db.execute_batch("COMMIT")?;
        Ok(())
    })();
    if result.is_err() {
        db.execute_batch("ROLLBACK")?;
    }
    db.execute_batch("PRAGMA foreign_keys=ON")?;
    result
}
use rusqlite::OptionalExtension;
struct Edge {
    table: String,
    parent: String,
    join: String,
}
pub fn remove(db: &Connection, agent: &str) -> Result<()> {
    db.execute_batch("CREATE TEMP TABLE IF NOT EXISTS agent_delete_rows(name TEXT NOT NULL,rid INTEGER NOT NULL,PRIMARY KEY(name,rid)); DELETE FROM agent_delete_rows; PRAGMA defer_foreign_keys=ON;")?;
    let tables = all(
        db,
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        [],
    )?
    .iter()
    .map(|v| string(v, "name").to_owned())
    .collect::<HashSet<_>>();
    let columns = tables
        .iter()
        .map(|t| {
            Ok((
                t.clone(),
                all(db, &format!("PRAGMA table_info({})", quote(t)), [])?
                    .iter()
                    .map(|v| string(v, "name").to_owned())
                    .collect::<HashSet<_>>(),
            ))
        })
        .collect::<Result<BTreeMap<_, _>>>()?;
    mark(db, &tables, "agents", "id=?", [agent])?;
    mark(db, &tables, "turns", "agent=? AND channel IS NULL", [agent])?;
    for t in [
        "threads",
        "workflows",
        "routines",
        "workspace_checkpoints",
        "room_watermarks",
    ] {
        mark(db, &tables, t, "agent=?", [agent])?;
    }
    for scope in std::iter::once(format!("agents:{agent}")).chain(
        all(db, "SELECT id FROM threads WHERE agent=?", [agent])?
            .iter()
            .map(|v| format!("threads:{}", string(v, "id"))),
    ) {
        for t in ["files", "memories", "compactions", "compaction_sources"] {
            mark(db, &tables, t, "scope=?", [&scope])?;
        }
    }
    mark(db, &tables, "room_invitations", "target=?", [agent])?;
    for (t, condition) in [
        ("hub_link_threads", "agent_id=?"),
        ("hub_link_grants", "json_extract(value,'$.localAgentId')=?"),
        (
            "hub_link_requests",
            "json_extract(value,'$.grant.localAgentId')=?",
        ),
    ] {
        mark(db, &tables, t, condition, [agent])?;
    }
    for t in ["hub_link_turns", "hub_link_events"] {
        mark(
            db,
            &tables,
            t,
            "json_extract(frame,'$.agentId')=? OR json_extract(frame,'$.localAgentId')=?",
            [agent, agent],
        )?;
    }
    db.execute(
        "UPDATE turns SET agent=NULL WHERE agent=? AND channel IS NOT NULL",
        [agent],
    )?;
    db.execute("UPDATE turns SET recipient=NULL WHERE recipient=?", [agent])?;
    db.execute(
        "UPDATE channels SET lead=NULL,revision=revision+1,activity=activity+1 WHERE lead=?",
        [agent],
    )?;
    db.execute(
        "UPDATE room_discussions SET lead=NULL WHERE lead=?",
        [agent],
    )?;
    for room in all(db, "SELECT root,members FROM room_discussions", [])? {
        let mut members = json(&room["members"])?;
        if let Some(m) = members.as_array_mut() {
            m.retain(|v| v != agent);
        }
        db.execute(
            "UPDATE room_discussions SET members=? WHERE root=?",
            rusqlite::params![members.to_string(), room["root"].as_str()],
        )?;
    }
    db.execute("UPDATE room_messages SET agent='' WHERE agent=?", [agent])?;
    db.execute(
        "UPDATE room_messages SET target=NULL WHERE target=?",
        [agent],
    )?;
    db.execute(
        "UPDATE room_turns SET speaker=NULL WHERE speaker=?",
        [agent],
    )?;
    let sidebar =
        one(db, "SELECT sections FROM sidebar WHERE id=1", [])?.ok_or_else(Failure::storage)?;
    let mut sections = json(&sidebar["sections"])?;
    let before = sections.clone();
    for section in sections.as_array_mut().ok_or_else(Failure::storage)? {
        if let Some(ids) = section["agents"].as_array_mut() {
            ids.retain(|v| v != agent);
        }
    }
    if sections != before {
        db.execute(
            "UPDATE sidebar SET sections=?,revision=revision+1 WHERE id=1",
            [sections.to_string()],
        )?;
    }
    let mut edges = Vec::new();
    for t in tables.iter().filter(|t| t.as_str() != "turns") {
        let mut groups: BTreeMap<i64, Vec<Value>> = BTreeMap::new();
        for fk in all(db, &format!("PRAGMA foreign_key_list({})", quote(t)), [])? {
            groups
                .entry(fk["id"].as_i64().ok_or_else(Failure::storage)?)
                .or_default()
                .push(fk);
        }
        for group in groups.values() {
            let parent = string(&group[0], "table");
            if tables.contains(parent) {
                edges.push(Edge {
                    table: t.clone(),
                    parent: parent.into(),
                    join: group
                        .iter()
                        .map(|fk| {
                            format!(
                                "c.{}=p.{}",
                                quote(string(fk, "from")),
                                quote(string(fk, "to"))
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(" AND "),
                });
            }
        }
    }
    loop {
        let mut added = 0;
        for edge in &edges {
            added+=db.execute(&format!("INSERT OR IGNORE INTO agent_delete_rows SELECT ?,c.rowid FROM {} c JOIN {} p ON {} JOIN agent_delete_rows d ON d.name=? AND d.rid=p.rowid",quote(&edge.table),quote(&edge.parent),edge.join),[edge.table.as_str(),edge.parent.as_str()])?;
        }
        for t in ["workspace_git_operations", "workspace_checkpoints"] {
            added += mark(
                db,
                &tables,
                t,
                &format!("turn IN(SELECT id FROM turns WHERE {})", marked("turns")),
                [],
            )?;
        }
        added += mark(
            db,
            &tables,
            "hub_link_turns",
            &format!("turn_id IN(SELECT id FROM turns WHERE {})", marked("turns")),
            [],
        )?;
        for t in ["hub_link_events", "hub_link_turns"] {
            if tables.contains("hub_link_grants") {
                added+=mark(db,&tables,t,&format!("EXISTS(SELECT 1 FROM hub_link_grants g WHERE g.rowid IN(SELECT rid FROM agent_delete_rows WHERE name='hub_link_grants') AND g.project_id=json_extract({}.frame,'$.projectId') AND g.participation_id=json_extract({}.frame,'$.participationId'))",quote(t),quote(t)),[])?;
            }
        }
        for t in ["hub_link_results", "hub_link_actions"] {
            if tables.contains("hub_link_turns") {
                added += mark(
                    db,
                    &tables,
                    t,
                    &format!(
                        "turn_id IN(SELECT turn_id FROM hub_link_turns WHERE {})",
                        marked("hub_link_turns")
                    ),
                    [],
                )?;
            }
        }
        if tables.contains("mcp_server_tokens") {
            added += mark(
                db,
                &tables,
                "mcp_feature_commands",
                &format!(
                    "caller IN(SELECT id FROM mcp_server_tokens WHERE {})",
                    marked("mcp_server_tokens")
                ),
                [],
            )?;
        }
        if tables.contains("composio_policies") {
            added+=mark(db,&tables,"composio_policy_projects",&format!("fingerprint IN(SELECT fingerprint FROM composio_policies WHERE {}) AND NOT EXISTS(SELECT 1 FROM composio_policies p WHERE p.fingerprint=composio_policy_projects.fingerprint AND NOT({}))",marked("composio_policies"),marked("composio_policies")),[])?;
        }
        added += mark(
            db,
            &tables,
            "turns",
            &format!(
                "channel IS NULL AND thread IN(SELECT id FROM threads WHERE {})",
                marked("threads")
            ),
            [],
        )?;
        if columns
            .get("turns")
            .is_some_and(|c| c.contains("workflow_run"))
            && tables.contains("workflow_runs")
        {
            added += mark(
                db,
                &tables,
                "turns",
                &format!(
                    "channel IS NULL AND workflow_run IN(SELECT id FROM workflow_runs WHERE {})",
                    marked("workflow_runs")
                ),
                [],
            )?;
        }
        for (t, col) in [
            ("workflow_steps", "turn"),
            ("flow_steps", "turn"),
            ("flow_runs", "root_turn"),
        ] {
            if tables.contains(t) {
                added += mark(
                    db,
                    &tables,
                    "turns",
                    &format!(
                        "channel IS NULL AND id IN(SELECT {} FROM {} WHERE {})",
                        quote(col),
                        quote(t),
                        marked(t)
                    ),
                    [],
                )?;
            }
        }
        if added == 0 {
            break;
        }
    }
    if exists(
        db,
        &format!(
            "SELECT 1 FROM turns WHERE {} AND(status IN('queued','running') OR paused=1) LIMIT 1",
            marked("turns")
        ),
        [],
    )? {
        return Err(error(409, "Stop or finish agent work before deleting."));
    }
    for edge in edges
        .iter()
        .filter(|e| ["turns", "workflow_runs"].contains(&e.parent.as_str()))
    {
        let active = if edge.parent == "turns" {
            "p.status IN('queued','running') OR p.paused=1"
        } else {
            "p.status NOT IN('done','failed','cancelled')"
        };
        if exists(db,&format!("SELECT 1 FROM {} c JOIN {} p ON {} JOIN agent_delete_rows d ON d.name=? AND d.rid=c.rowid WHERE({active}) LIMIT 1",quote(&edge.table),quote(&edge.parent),edge.join),[edge.table.as_str()])?{return Err(error(409,"Stop or finish agent work before deleting."));}
    }
    for col in ["parent", "waiting_for", "dispatch_target"] {
        db.execute_batch(&format!(
            "UPDATE turns SET {col}=NULL WHERE {col} IN(SELECT id FROM turns WHERE {})",
            marked("turns")
        ))?;
    }
    if columns
        .get("turns")
        .is_some_and(|c| c.contains("workflow_run"))
        && tables.contains("workflow_runs")
    {
        db.execute_batch(&format!("UPDATE turns SET workflow_run=NULL WHERE workflow_run IN(SELECT id FROM workflow_runs WHERE {})",marked("workflow_runs")))?;
    }
    db.execute_batch("CREATE TEMP TABLE IF NOT EXISTS agent_delete_ids(id TEXT PRIMARY KEY); DELETE FROM agent_delete_ids;")?;
    db.execute(
        "INSERT OR IGNORE INTO agent_delete_ids VALUES(?)",
        [format!("agents:{agent}")],
    )?;
    for th in all(db, "SELECT id FROM threads WHERE agent=?", [agent])? {
        db.execute(
            "INSERT OR IGNORE INTO agent_delete_ids VALUES(?)",
            [format!("threads:{}", string(&th, "id"))],
        )?;
    }
    for (t, cols) in &columns {
        if cols.contains("id") {
            db.execute_batch(&format!("INSERT OR IGNORE INTO agent_delete_ids SELECT id FROM {} WHERE {} AND typeof(id)='text'",quote(t),marked(t)))?;
        }
    }
    for (t, cols) in &columns {
        if t.ends_with("_commands")
            || ["channel_creations", "channel_edits", "thread_commands"].contains(&t.as_str())
        {
            for col in ["request", "result", "plan"]
                .iter()
                .filter(|c| cols.contains(**c))
            {
                mark(db,&tables,t,&format!("json_valid({}) AND EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid({}) THEN {} ELSE 'null' END) j JOIN agent_delete_ids d ON j.value=d.id)",quote(col),quote(col),quote(col)),[])?;
            }
        }
    }
    if tables.contains("workspace_checkpoints") {
        db.execute_batch("CREATE TABLE IF NOT EXISTS agent_delete_checkpoints(agent TEXT NOT NULL,directory TEXT NOT NULL,ref TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(agent,directory,ref)) STRICT;")?;
        db.execute(&format!("INSERT OR IGNORE INTO agent_delete_checkpoints SELECT ?,directory,ref,hash FROM workspace_checkpoints WHERE {} AND state='done' AND hash IS NOT NULL",marked("workspace_checkpoints")),[agent])?;
    }
    for t in &tables {
        if exists(db, "SELECT 1 FROM agent_delete_rows WHERE name=?", [t])? {
            db.execute_batch(&format!("DELETE FROM {} WHERE {}", quote(t), marked(t)))?;
        }
    }
    db.execute("INSERT OR IGNORE INTO deleted_agents VALUES(?)", [agent])?;
    if exists(db, "PRAGMA foreign_key_check", [])? {
        return Err(Failure::storage());
    }
    Ok(())
}
