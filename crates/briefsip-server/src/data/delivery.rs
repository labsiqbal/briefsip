use super::*;

pub fn migrate(db: &Connection, now: i64) -> Result<()> {
    let whitespace = regex::Regex::new(r"[\s\u{feff}]+").map_err(|_| Failure::storage())?;
    for row in all(db,"SELECT th.id,th.name,th.revision,t.text,t.origin,a.name AS sender FROM threads th JOIN turns t ON t.id=(SELECT id FROM turns WHERE thread=th.id ORDER BY seq LIMIT 1) LEFT JOIN agent_deliveries d ON d.turn=t.id LEFT JOIN agent_requests r ON r.id=d.request LEFT JOIN turns parent ON parent.id=r.turn LEFT JOIN agents a ON a.id=parent.agent WHERE NOT EXISTS(SELECT 1 FROM delivery_conversations dc WHERE dc.thread=th.id) AND(d.turn IS NOT NULL OR t.origin LIKE 'peer:%' OR t.origin LIKE 'session:%')",[])? {
        let origin = string(&row, "origin");
        let peer = origin.starts_with("peer:");
        let sender = if peer {
            origin.strip_prefix("peer:").unwrap_or("").to_owned()
        } else if let Some(sender) = row["sender"].as_str() {
            sender.to_owned()
        } else {
            one(db, "SELECT name FROM agents WHERE id=?", [origin.get(8..).unwrap_or("")])?
                .and_then(|a| a["name"].as_str().map(str::to_owned)).unwrap_or_else(|| "Agent".to_owned())
        };
        let machine = peer.then(|| sender.strip_prefix("Briefsip:").map(str::trim_start).unwrap_or(&sender));
        let agent = if peer { "Briefsip" } else { &sender };
        db.execute("INSERT INTO delivery_conversations(thread,sender,machine,activity) VALUES(?,?,?,?)",rusqlite::params![row["id"].as_str(),agent,machine,now])?;
        if row["revision"] == 1 && string(&row,"name").starts_with("Message from ") {
            let title_prefix = if let Some(machine) = machine {
                format!("{} on {}: ", prefix(agent,28), prefix(machine,24))
            } else { format!("{} asked: ", prefix(agent,40)) };
            let text = whitespace.replace_all(string(&row, "text"), " ");
            let name = prefix(&format!("{title_prefix}{}",text.trim()),80);
            db.execute("UPDATE threads SET name=?,revision=revision+1 WHERE id=?",rusqlite::params![name,row["id"].as_str()])?;
        }
    }
    Ok(())
}
fn prefix(text: &str, max: usize) -> String {
    let mut count = 0;
    text.chars()
        .take_while(|c| {
            count += c.len_utf16();
            count <= max
        })
        .collect()
}
pub fn maintain(db: &Connection, now: i64) -> Result<()> {
    for row in all(db,"SELECT dc.* FROM delivery_conversations dc JOIN threads th ON th.id=dc.thread WHERE th.archived=0 AND th.deleted=0",[])? {
        let thread = string(&row,"thread");
        if conversations::unfinished(db,thread)? {
            db.execute("UPDATE delivery_conversations SET settled_at=NULL WHERE thread=?",[thread])?;
        } else if row["settled_at"].is_null() {
            db.execute("UPDATE delivery_conversations SET settled_at=? WHERE thread=?",rusqlite::params![now,thread])?;
        } else if conversations::settings(db,&Value::Null,true)?["autoArchive"] == true
            && row["settled_at"].as_i64().is_some_and(|n| n <= now.saturating_sub(7*86_400_000)) {
            db.execute("UPDATE threads SET archived=1,revision=revision+1 WHERE id=? AND archived=0 AND deleted=0",[thread])?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn descendants_delay_archive_and_settings_preserve_renames() -> Result<()> {
        let db = Connection::open_in_memory()?;
        db.execute_batch("CREATE TABLE agents(id TEXT,name TEXT); CREATE TABLE threads(id TEXT,name TEXT,revision INTEGER DEFAULT 1,archived INTEGER DEFAULT 0,deleted INTEGER DEFAULT 0); CREATE TABLE turns(seq INTEGER,id TEXT,thread TEXT,agent TEXT,parent TEXT,origin TEXT,text TEXT,status TEXT,paused INTEGER DEFAULT 0); CREATE TABLE agent_deliveries(turn TEXT,request TEXT); CREATE TABLE agent_requests(id TEXT,turn TEXT); CREATE TABLE delivery_conversations(thread TEXT,sender TEXT,machine TEXT,activity INTEGER,settled_at INTEGER); CREATE TABLE conversation_settings(id INTEGER,auto_archive INTEGER); INSERT INTO conversation_settings VALUES(1,1); INSERT INTO agents VALUES('helper','Helper'); INSERT INTO threads(id,name) VALUES('peer','Message from Briefsip: omarchy'),('renamed','Owner title'); INSERT INTO turns(seq,id,thread,agent,origin,text,status) VALUES(1,'remote','peer','helper','peer:Briefsip: omarchy','Inspect   release','done'),(2,'renamed','renamed','helper','session:helper','Check','done');")?;
        migrate(&db, 1)?;
        migrate(&db, 2)?;
        assert_eq!(
            one(&db, "SELECT name,revision FROM threads WHERE id='peer'", [])?,
            Some(json!({"name":"Briefsip on omarchy: Inspect release","revision":2}))
        );
        assert_eq!(
            one(&db, "SELECT name FROM threads WHERE id='renamed'", [])?,
            Some(json!({"name":"Owner title"}))
        );
        maintain(&db, 100)?;
        db.execute_batch(
            "INSERT INTO turns(id,parent,status,paused) VALUES('child','remote','queued',1)",
        )?;
        maintain(&db, 100 + 7 * 86_400_000)?;
        assert_eq!(
            one(&db, "SELECT archived FROM threads WHERE id='peer'", [])?,
            Some(json!({"archived":0}))
        );
        db.execute_batch("UPDATE turns SET status='cancelled',paused=0 WHERE id='child'; UPDATE conversation_settings SET auto_archive=0")?;
        maintain(&db, 100 + 8 * 86_400_000)?;
        maintain(&db, 100 + 30 * 86_400_000)?;
        assert_eq!(
            one(&db, "SELECT archived FROM threads WHERE id='peer'", [])?,
            Some(json!({"archived":0}))
        );
        db.execute_batch("UPDATE conversation_settings SET auto_archive=1")?;
        maintain(&db, 100 + 30 * 86_400_000)?;
        assert_eq!(
            one(&db, "SELECT archived FROM threads WHERE id='peer'", [])?,
            Some(json!({"archived":1}))
        );
        Ok(())
    }
}
