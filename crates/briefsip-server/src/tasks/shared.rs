use super::*;
use tokio::sync::Semaphore;
static WORKERS: Semaphore = Semaphore::const_new(2);

pub async fn run(
    state: &AppState,
    task_id: &str,
    p: &Principal,
    v: &Value,
    token: &str,
) -> Result<Response> {
    let task = {
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        let db = &guard.connection;
        let task = task(db, task_id)?;
        let checked = transaction(db, || {
            mutations::execute(db, p, &task, v, token, state.config.now(), true, None)
        })?;
        if checked["validated"] != true {
            return response(checked);
        }
        task
    };
    let _slot = WORKERS.try_acquire().map_err(|_| {
        let mut e = fail(
            429,
            "server_capacity",
            "Two queries are running. Try again after they finish.",
        );
        e.retryable = true;
        e
    })?;
    let work = async {
        let name = string(&v["toolCall"]["function"], "name");
        let args: Value = serde_json::from_str(string(&v["toolCall"]["function"], "arguments"))
            .map_err(|_| Failure::storage())?;
        let mut request = crate::files::shared::input(
            if name == "list_data_tables" {
                "list"
            } else {
                "query"
            },
            &args,
        )?;
        request["owner"] = task["agent"].clone();
        crate::files::shared::prepare_project(
            state,
            &request,
            false,
            false,
            400,
            Some(string(&task, "project")),
        )
        .await
    };
    tokio::pin!(work);
    let mut stopped = tokio::time::interval(std::time::Duration::from_millis(10));
    let outcome = loop {
        tokio::select! {
            result=&mut work=>break result,
            _=stopped.tick()=>{
                let guard=state.database.lock().map_err(|_|Failure::storage())?;
                let current=task_row(&guard.connection,task_id)?;
                if current["state"]!="running"{return Err(fail(409,"ownership_conflict","Query cancelled before saving."))}
            }
        }
    };
    let guard = state.database.lock().map_err(|_| Failure::storage())?;
    let db = &guard.connection;
    let current = task_row(db, task_id)?;
    response(transaction(db, || {
        mutations::execute(
            db,
            p,
            &current,
            v,
            token,
            state.config.now(),
            false,
            Some(outcome),
        )
    })?)
}
fn task_row(db: &Connection, id: &str) -> Result<Value> {
    task(db, id)
}
pub fn finish(db: &Connection, task: &Value, outcome: mutations::DataOutcome) -> Result<Value> {
    let (revision, image, mut result) = match outcome {
        Ok(value) => value,
        Err(error) => return Ok(json!({"error":error.message})),
    };
    let project = string(task, "project");
    if let Some(image) = image {
        db.execute(
            "INSERT OR IGNORE INTO shared_data(project,id,revision,image) VALUES(?,1,0,NULL)",
            [project],
        )?;
        if db.execute("UPDATE shared_data SET image=?,revision=revision+1 WHERE project=? AND id=1 AND revision=?",params![image,project,revision])?==0{return Ok(json!({"error":"Data changed while the query was running. Reload and try as a new query."}))}
        result["revision"] = json!(revision + 1);
    } else {
        result["revision"] = json!(revision);
    }
    Ok(result)
}
