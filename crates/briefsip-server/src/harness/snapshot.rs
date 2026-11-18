use super::*;
use crate::data::transaction;
use std::collections::BTreeSet;

use crate::mcp::secrets::redact;

pub struct Snapshot {
    state: AppState,
    call: i64,
    turn: String,
    segments: Vec<Value>,
    dirty: BTreeSet<usize>,
    revision: i64,
    last: Instant,
    secrets: Vec<String>,
    closed: bool,
}
impl Snapshot {
    pub fn new(state: &AppState, call: i64, turn: &str, secrets: Vec<String>) -> Self {
        Self {
            state: state.clone(),
            call,
            turn: turn.into(),
            segments: Vec::new(),
            dirty: BTreeSet::new(),
            revision: 0,
            last: Instant::now() - Duration::from_secs(1),
            secrets,
            closed: false,
        }
    }
    pub fn current(&self) -> &str {
        self.segments
            .last()
            .filter(|s| s["kind"] == "text")
            .map(|s| string(s, "text"))
            .unwrap_or("")
    }
    pub fn text(&mut self, value: &str, id: Option<&str>, replace: bool) -> Result<()> {
        let index = if let Some(index) =
            id.and_then(|id| self.segments.iter().position(|s| s["id"] == id))
        {
            if self.segments[index]["kind"] != "text" {
                return Err(error(502, "Invalid harness text identity."));
            }
            index
        } else if self
            .segments
            .last()
            .is_some_and(|s| s["kind"] == "text" && id.is_none_or(|id| s["id"] == id))
        {
            self.segments.len() - 1
        } else {
            if self.segments.len() >= 512 || id.is_some_and(|id| id.len() > 300) {
                return Err(error(502, "Coding harness stream has too many segments."));
            }
            self.segments.push(json!({"id":id.map(str::to_owned).unwrap_or_else(||format!("text-{}",self.segments.len())),"kind":"text","text":"","state":"","final":0}));
            self.segments.len() - 1
        };
        let next = if replace {
            value.to_owned()
        } else {
            format!("{}{}", string(&self.segments[index], "text"), value)
        };
        if next == self.segments[index]["text"] {
            return Ok(());
        }
        if self
            .segments
            .iter()
            .map(|s| string(s, "text").len())
            .sum::<usize>()
            - string(&self.segments[index], "text").len()
            + next.len()
            > 2 * 1024 * 1024
        {
            return Err(error(502, "Coding harness answer exceeded 2 MiB."));
        }
        self.segments[index]["text"] = json!(next);
        self.dirty.insert(index);
        if self.last.elapsed() >= Duration::from_millis(40) {
            self.flush()?;
        }
        Ok(())
    }
    pub fn tool(
        &mut self,
        id: &str,
        name: &str,
        state: &str,
        arguments: &Value,
        result: &Value,
    ) -> Result<()> {
        if id.is_empty() || id.len() > 300 || name.len() > 2000 || state.len() > 100 {
            return Err(error(502, "Invalid harness tool identity."));
        }
        let arguments = crate::turns::diagnostics::display(arguments, &self.secrets);
        let failed = crate::turns::diagnostics::tool_failed(result);
        let result = crate::turns::diagnostics::display(result, &self.secrets);
        let name = crate::turns::diagnostics::text(name, &self.secrets);
        let terminal = matches!(
            state,
            "completed"
                | "done"
                | "failed"
                | "declined"
                | "denied"
                | "cancelled"
                | "interrupted"
                | "error"
                | "aborted"
        );
        self.flush()?;
        let key = format!("tool-{id}");
        let index = if let Some(index) = self.segments.iter().position(|s| s["id"] == key) {
            index
        } else {
            if self.segments.len() >= 512 {
                return Err(error(502, "Coding harness stream has too many segments."));
            }
            self.segments
                .push(json!({"id":key,"kind":"tool","text":name,"state":state,"final":0}));
            self.segments.len() - 1
        };
        {
            let guard = self.state.database.lock().map_err(|_| Failure::storage())?;
            let db = &guard.connection;
            let now = crate::data::iso(db, self.state.config.now())?;
            transaction(db, || {
                db.execute(
                    "INSERT INTO harness_steps(turn,id,name,state) VALUES(?,?,?,?)
                     ON CONFLICT(turn,id) DO UPDATE SET name=excluded.name,state=excluded.state",
                    rusqlite::params![self.turn, id, name, state],
                )?;
                db.execute(
                    "INSERT INTO turn_step_diagnostics(turn,id,started,finished,arguments,result,failed) VALUES(?,?,?,?,?,?,?)
                     ON CONFLICT(turn,id) DO UPDATE SET started=coalesce(started,excluded.started),
                     finished=coalesce(excluded.finished,finished),arguments=coalesce(excluded.arguments,arguments),
                     result=coalesce(excluded.result,result),failed=max(failed,excluded.failed)",
                    rusqlite::params![self.turn, id, (!terminal).then_some(&now), terminal.then_some(&now), arguments, result, failed],
                )?;
                Ok(())
            })?;
        }
        self.segments[index]["text"] = json!(name);
        self.segments[index]["state"] = json!(state);
        self.dirty.insert(index);
        self.flush()
    }
    pub fn flush(&mut self) -> Result<()> {
        if self.dirty.is_empty() {
            return Ok(());
        }
        self.revision += 1;
        let guard = self.state.database.lock().map_err(|_| Failure::storage())?;
        let db = &guard.connection;
        transaction(db, || {
            for index in &self.dirty {
                let s = &self.segments[*index];
                db.execute("INSERT INTO provider_stream_segments VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(call,ordinal) DO UPDATE SET text=excluded.text,state=excluded.state,final=excluded.final,revision=excluded.revision",rusqlite::params![self.call,*index as i64,string(s,"id"),string(s,"kind"),redact(string(s,"text"),&self.secrets,s["final"]!=1),string(s,"state"),s["final"].as_i64(),self.revision])?;
            }
            db.execute("INSERT INTO provider_streams VALUES(?,?) ON CONFLICT(call) DO UPDATE SET text=excluded.text",rusqlite::params![self.call,redact(self.current(),&self.secrets,self.segments.last().is_none_or(|s|s["final"]!=1))])?;
            Ok(())
        })?;
        self.dirty.clear();
        self.last = Instant::now();
        self.state.events.turn(db, &self.turn)?;
        Ok(())
    }
    pub fn finish(&mut self) -> Result<String> {
        let text = self.current().to_owned();
        if text.trim().is_empty() {
            return Err(error(502,"Coding harness returned no complete text answer. Check workspace changes before retrying."));
        }
        if let Some(last) = self.segments.last_mut() {
            last["final"] = json!(1);
            self.dirty.insert(self.segments.len() - 1);
        }
        self.flush()?;
        self.closed = true;
        Ok(redact(&text, &self.secrets, false))
    }
}
impl Drop for Snapshot {
    fn drop(&mut self) {
        if !self.closed {
            let _ = self.flush();
            if let Ok(db) = self.state.database.lock() {
                let _=db.connection.execute("UPDATE provider_calls SET status='failed',finished=? WHERE seq=? AND status='pending'",rusqlite::params![data::iso(&db.connection,self.state.config.now()).ok(),self.call]);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_masks_complete_escaped_and_partial_streaming_values() {
        let secret = "PROJECT_CANARY_j4W8sK3p".to_owned();
        let secrets = [secret.clone()];
        assert_eq!(
            redact(&format!("prefix {secret}"), &secrets, true),
            "prefix [REDACTED]"
        );
        assert_eq!(
            redact(&format!("prefix {}", &secret[..10]), &secrets, true),
            "prefix "
        );
        assert_eq!(
            redact(
                r#"{"value":"line\nsecret"}"#,
                &["line\nsecret".to_owned()],
                false
            ),
            r#"{"value":"[REDACTED]"}"#
        );
    }
}
