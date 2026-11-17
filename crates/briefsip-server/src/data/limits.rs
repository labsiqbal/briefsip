use super::*;
use tokio::sync::{Semaphore, SemaphorePermit};

static REQUEST: Semaphore = Semaphore::const_new(64);
static CONTROL: Semaphore = Semaphore::const_new(32);
static CONTEXT: Semaphore = Semaphore::const_new(1);
static RESULT: Semaphore = Semaphore::const_new(1);
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
pub fn reserve(path: &str, method: &Method) -> Result<Vec<SemaphorePermit<'static>>> {
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
    if matches!(
        parts.as_slice(),
        ["api", "tasks", _, "reconcile" | "recovery-results"]
    ) && *method != Method::GET
        && *method != Method::HEAD
    {
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
    let space = rustix::fs::statvfs(path.as_str()).map_err(|_| {
        let mut e = Failure::new(503, "storage_unavailable", "Storage is not available yet.");
        e.retryable = true;
        e
    })?;
    let free = u128::from(space.f_bavail) * u128::from(space.f_bsize);
    let total = u128::from(space.f_blocks) * u128::from(space.f_bsize);
    if free < 1_073_741_824 || free * 20 < total {
        return Err(Failure::new(
            507,
            "storage_pressure",
            "Storage is almost full. Task has not been accepted.",
        ));
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
        let control = permit(&CONTROL)?;
        let context = permit(&CONTEXT)?;
        let result = permit(&RESULT)?;
        assert!(permit(&CONTEXT).is_err());
        assert!(permit(&RESULT).is_err());
        requests.pop();
        assert!(permit(&REQUEST).is_ok());
        drop((requests, control, context, result));
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
        db.execute("UPDATE tasks SET state='transferred' WHERE rowid=1", [])?;
        task_capacity(&db, "A", "busy")?;
        Ok(())
    }
}
