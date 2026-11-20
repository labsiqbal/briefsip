use super::*;
use tokio::sync::{Semaphore, SemaphorePermit};

static REQUEST: Semaphore = Semaphore::const_new(64);
static CONTROL: Semaphore = Semaphore::const_new(32);
static CONTEXT: Semaphore = Semaphore::const_new(1);
static RESULT: Semaphore = Semaphore::const_new(1);
const REQUEST_BYTES: usize = 65536;
const RESULT_BYTES: usize = 8388608;
fn busy(code: &'static str, message: &'static str) -> Failure {
    let mut failure = Failure::new(429, code, message);
    failure.retryable = true;
    failure.details = Some(json!({"retryAfterMs":1000}));
    failure
}
fn permit(lane: &'static Semaphore) -> Result<SemaphorePermit<'static>> {
    lane.try_acquire()
        .map_err(|_| busy("server_capacity", "Server is busy. Try again."))
}
pub(crate) fn body_limit(path: &str, method: &Method, headers: &HeaderMap) -> usize {
    if *method == Method::POST && path == "/api/agents" {
        return 750000;
    }
    if *method == Method::POST && crate::tasks::result_path(path) {
        let short = !headers.contains_key("transfer-encoding")
            && crate::text_header(headers, "content-length")
                .and_then(|length| length.parse::<usize>().ok())
                .is_some_and(|length| length <= REQUEST_BYTES);
        if !short {
            return RESULT_BYTES;
        }
    }
    REQUEST_BYTES
}

pub fn reserve(
    path: &str,
    method: &Method,
    headers: &HeaderMap,
) -> Result<Vec<SemaphorePermit<'static>>> {
    let parts = path.split('/').skip(1).collect::<Vec<_>>();
    let recovery = matches!(
        parts.as_slice(),
        [
            "api",
            "tasks",
            _,
            "recovery-session" | "recovery-import" | "recovery-results"
        ]
    );
    let receipt = matches!(
        parts.as_slice(),
        ["api", "tasks", _] | ["api", "tasks", _, "results", _]
    );
    let control = recovery
        || receipt
        || *method == Method::DELETE
        || parts.last().is_some_and(|s| {
            matches!(
                *s,
                "control"
                    | "reconcile"
                    | "complete"
                    | "heartbeat"
                    | "wait-secret-results"
                    | "wait-reveal-results"
                    | "wait-event-results"
                    | "session"
                    | "revoke"
            )
        })
        || path.ends_with("/session/logout");
    let mut permits = Vec::new();
    if !matches!(parts.as_slice(), ["api", "devices", _, "stream"]) {
        permits.push(permit(if control { &CONTROL } else { &REQUEST })?);
    }
    if matches!(parts.as_slice(), ["api", "tasks", _, "context"]) {
        permits.push(permit(&CONTEXT)?);
    }
    if body_limit(path, method, headers) == RESULT_BYTES {
        permits.push(permit(&RESULT)?);
    }
    Ok(permits)
}
pub fn task_capacity(db: &Connection, project: &str, agent: &str) -> Result<()> {
    let counts=one(db,"SELECT count(*) AS total,sum(agent=?) AS agent FROM tasks WHERE project=? AND state NOT IN('completed','failed','cancelled','transferred')",[agent,project])?.ok_or_else(Failure::storage)?;
    if counts["total"].as_i64().unwrap_or(0) >= 1000 || counts["agent"].as_i64().unwrap_or(0) >= 100
    {
        return Err(busy(
            "queue_full",
            "Queue is full. Try after a task finishes.",
        ));
    }
    let path = all(db, "PRAGMA database_list", [])?
        .into_iter()
        .find(|r| r["name"] == "main")
        .map(|r| string(&r, "file").to_owned())
        .unwrap_or_default();
    if path.is_empty() {
        return Ok(());
    }
    let space = rustix::fs::statvfs(path.as_str()).map(|space| {
        let size = u128::from(space.f_bsize);
        (
            u128::from(space.f_bavail) * size,
            u128::from(space.f_blocks) * size,
        )
    });
    require_storage_capacity(space)
}

fn require_storage_capacity(
    bytes: std::result::Result<(u128, u128), rustix::io::Errno>,
) -> Result<()> {
    let (free, total) = bytes.map_err(|_| {
        let mut error = Failure::new(503, "storage_unavailable", "Storage is not available yet.");
        error.retryable = true;
        error
    })?;
    if free < 1_073_741_824 || free < total.div_ceil(20) {
        let mut error = Failure::new(
            507,
            "storage_pressure",
            "Storage is almost full. Task has not been accepted.",
        );
        error.retryable = true;
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_lanes_release_and_queue_capacity_is_scoped() -> Result<()> {
        let mut requests = (0..64)
            .map(|_| permit(&REQUEST))
            .collect::<Result<Vec<_>>>()?;
        assert_eq!(
            permit(&REQUEST).err().map(|e| e.code),
            Some("server_capacity")
        );
        let controls = (0..32)
            .map(|_| permit(&CONTROL))
            .collect::<Result<Vec<_>>>()?;
        assert_eq!(
            permit(&CONTROL).err().map(|e| e.code),
            Some("server_capacity")
        );
        let context = permit(&CONTEXT)?;
        let result = permit(&RESULT)?;
        assert!(permit(&CONTEXT).is_err());
        assert!(permit(&RESULT).is_err());
        requests.pop();
        let next = permit(&REQUEST)?;
        assert!(permit(&REQUEST).is_err());
        drop((requests, controls, context, result, next));
        for lane in [&REQUEST, &CONTROL, &CONTEXT, &RESULT] {
            let _next = permit(lane)?;
        }
        let db = Connection::open_in_memory()?;
        db.execute_batch("CREATE TABLE tasks(project TEXT,agent TEXT,state TEXT)")?;
        for _ in 0..100 {
            db.execute("INSERT INTO tasks VALUES('A','busy','paused')", [])?;
        }
        assert_eq!(
            task_capacity(&db, "A", "busy").err().map(|e| e.code),
            Some("queue_full")
        );
        task_capacity(&db, "B", "busy")?;
        task_capacity(&db, "A", "free")?;
        db.execute_batch(
            "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<900)
             INSERT INTO tasks SELECT 'A','agent-'||i,'waiting_device' FROM n;",
        )?;
        let error = task_capacity(&db, "A", "free")
            .err()
            .map(|error| (error.code, error.retryable));
        assert_eq!(error, Some(("queue_full", true)));
        assert_eq!(
            db.query_row("SELECT count(*) FROM tasks", [], |row| row.get::<_, i64>(0))?,
            1000
        );
        db.execute("UPDATE tasks SET state='transferred' WHERE rowid=1", [])?;
        task_capacity(&db, "A", "busy")?;
        Ok(())
    }

    #[test]
    fn storage_admission_requires_a_readable_volume_and_both_floors() -> Result<()> {
        const GIB: u128 = 1 << 30;
        require_storage_capacity(Ok((GIB, 20 * GIB)))?;
        for (free, total) in [(GIB - 1, 20 * GIB - 20), (2 * GIB, 41 * GIB)] {
            let error = require_storage_capacity(Ok((free, total)))
                .err()
                .map(|error| (error.status, error.code, error.retryable));
            assert_eq!(error, Some((507, "storage_pressure", true)));
        }
        let error = require_storage_capacity(Err(rustix::io::Errno::NOENT))
            .err()
            .map(|error| (error.status, error.code, error.retryable));
        assert_eq!(error, Some((503, "storage_unavailable", true)));
        Ok(())
    }
}
