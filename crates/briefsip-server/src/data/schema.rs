use super::*;
use crate::db::Database;
fn column(db: &Connection, table: &str, name: &str, definition: &str) -> crate::db::Result<()> {
    let mut q = db.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = q
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if !names.iter().any(|v| v == name) {
        db.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {name} {definition}"
        ))?;
    }
    Ok(())
}
pub fn initialize(database: &Database) -> crate::db::Result<()> {
    let db = &database.connection;
    deletion::initialize(db)?;
    db.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> crate::db::Result<()> {
        db.execute_batch("CREATE TABLE IF NOT EXISTS channel_members(channel TEXT NOT NULL REFERENCES channels(id),agent TEXT NOT NULL REFERENCES agents(id),PRIMARY KEY(channel,agent)) STRICT;")?;
        for (table, cols) in [
            (
                "channels",
                vec![
                    ("activity", "INTEGER NOT NULL DEFAULT 0"),
                    ("read_position", "INTEGER NOT NULL DEFAULT 0"),
                ],
            ),
            (
                "turns",
                vec![
                    ("recipient", "TEXT REFERENCES agents(id)"),
                    ("automatic", "INTEGER NOT NULL DEFAULT 0"),
                    ("routing", "TEXT"),
                    ("paused", "INTEGER NOT NULL DEFAULT 0"),
                    ("revision", "INTEGER NOT NULL DEFAULT 1"),
                    ("no_update", "INTEGER NOT NULL DEFAULT 0"),
                    ("waiting_for", "TEXT REFERENCES turns(id)"),
                    ("origin", "TEXT"),
                    ("message_depth", "INTEGER NOT NULL DEFAULT 0"),
                    ("started_at", "TEXT"),
                    ("stopped_at", "TEXT"),
                    ("dispatch_mode", "TEXT NOT NULL DEFAULT 'queue'"),
                    ("dispatch_target", "TEXT"),
                    ("dispatch_label", "TEXT"),
                ],
            ),
        ] {
            for (name, definition) in cols {
                column(db, table, name, definition)?;
            }
        }
        db.execute_batch(include_str!("schema.sql"))?;
        for (table, name, definition) in [
            ("local_projects", "archived", "INTEGER NOT NULL DEFAULT 0"),
            (
                "local_projects",
                "allow_installation_apps",
                "INTEGER NOT NULL DEFAULT 0",
            ),
            ("channels", "project", "TEXT REFERENCES local_projects(id)"),
            (
                "memories",
                "selection_locked",
                "INTEGER NOT NULL DEFAULT 1 CHECK(selection_locked IN(0,1))",
            ),
            ("room_discussions", "stopped", "INTEGER NOT NULL DEFAULT 0"),
        ] {
            column(db, table, name, definition)?;
        }
        db.execute_batch("CREATE TABLE IF NOT EXISTS agent_creations(id TEXT PRIMARY KEY REFERENCES agents(id),request TEXT NOT NULL) STRICT;
            CREATE TABLE IF NOT EXISTS agent_edits(id TEXT PRIMARY KEY,agent TEXT NOT NULL REFERENCES agents(id),request TEXT NOT NULL,result TEXT NOT NULL) STRICT;
            CREATE TABLE IF NOT EXISTS thread_commands(id TEXT PRIMARY KEY,request TEXT NOT NULL,result TEXT NOT NULL) STRICT;
            CREATE TABLE IF NOT EXISTS channel_creations(id TEXT PRIMARY KEY REFERENCES channels(id),request TEXT NOT NULL) STRICT;
            CREATE TABLE IF NOT EXISTS channel_edits(id TEXT PRIMARY KEY,request TEXT NOT NULL,result TEXT NOT NULL) STRICT;
            CREATE TABLE IF NOT EXISTS deleted_agents(id TEXT PRIMARY KEY) STRICT;
            CREATE TABLE IF NOT EXISTS local_project_sections(project TEXT NOT NULL REFERENCES local_projects(id),channel TEXT PRIMARY KEY REFERENCES channels(id),name TEXT NOT NULL,position INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,UNIQUE(project,name)) STRICT;
            CREATE TABLE IF NOT EXISTS local_project_legacy_channels(channel TEXT PRIMARY KEY REFERENCES channels(id)) STRICT;
            CREATE TRIGGER IF NOT EXISTS channel_turn_created AFTER INSERT ON turns WHEN NEW.channel IS NOT NULL BEGIN UPDATE channels SET activity=activity+1 WHERE id=NEW.channel; END;
            CREATE TRIGGER IF NOT EXISTS channel_turn_changed AFTER UPDATE ON turns WHEN NEW.channel IS NOT NULL AND(NEW.status IS NOT OLD.status OR NEW.reply IS NOT OLD.reply OR NEW.agent IS NOT OLD.agent OR NEW.revision IS NOT OLD.revision) BEGIN UPDATE channels SET activity=activity+1 WHERE id=NEW.channel; END;
            UPDATE turns SET status='interrupted',error='The process stopped before the result was saved. Check the provider before sending again.' WHERE status='running';
            UPDATE provider_calls SET status='interrupted' WHERE status='pending';")?;
        for a in all(
            db,
            "SELECT * FROM agents WHERE id NOT IN(SELECT id FROM agent_creations)",
            [],
        )
        .map_err(|_| "Cannot read agent creations")?
        {
            db.execute(
                "INSERT INTO agent_creations VALUES(?,?)",
                rusqlite::params![
                    string(&a, "id"),
                    json!({"name":a["name"],"model":a["model"],"instructions":a["instructions"]})
                        .to_string()
                ],
            )?;
        }
        projects::migrate(db, crate::config::now()).map_err(|_| "Project migration failed")?;
        delivery::migrate(db, crate::config::now()).map_err(|_| "Conversation migration failed")?;
        Ok(())
    })();
    match result {
        Ok(()) => {
            db.execute_batch("COMMIT")?;
            Ok(())
        }
        Err(e) => {
            db.execute_batch("ROLLBACK")?;
            Err(e)
        }
    }
}
