use super::*;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Runner {
    boot_id: String,
    process_id: u32,
    process_start: String,
    lock_id: String,
}

pub(super) struct Lock {
    pub(super) boot_id: String,
    path: PathBuf,
    file: (u64, u64),
    _guard: Connection,
}

fn unavailable() -> Failure {
    fail(
        409,
        "executor_uninspectable",
        "Cannot inspect the executor process.",
    )
}
fn busy() -> Failure {
    fail(409, "executor_busy", "Another executor owns this journal.")
}
fn invalid_lock() -> Failure {
    fail(
        409,
        "executor_lock_invalid",
        "Executor lock must be private and owned by the user.",
    )
}

fn process_start(pid: u32) -> Result<Option<String>> {
    let data = match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(data) => data,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(unavailable()),
    };
    let start = data
        .rsplit_once(") ")
        .and_then(|(_, fields)| fields.split_ascii_whitespace().nth(19))
        .filter(|field| valid_start(field))
        .ok_or_else(unavailable)?;
    Ok(Some(start.into()))
}

fn valid_start(value: &str) -> bool {
    !value.is_empty() && value.len() <= 20 && value.bytes().all(|b| b.is_ascii_digit())
}

fn stopped(runner: &Runner, boot_id: &str) -> Result<()> {
    if runner.process_id == 0
        || !valid_start(&runner.process_start)
        || id(&json!(runner.boot_id)).is_err()
        || id(&json!(runner.lock_id)).is_err()
    {
        return Err(unavailable());
    }
    if runner.boot_id == boot_id
        && process_start(runner.process_id)?.as_deref() == Some(&runner.process_start)
    {
        return Err(busy());
    }
    Ok(())
}

fn private_file(path: &Path) -> Result<fs::Metadata> {
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
    {
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(invalid_lock()),
    }
    private_metadata(path, false).map_err(|_| invalid_lock())
}

impl Lock {
    pub(super) fn acquire(db: &Connection, directory: &Path) -> Result<Self> {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(directory)
            .map_err(|_| invalid_lock())?;
        private_metadata(directory, true).map_err(|_| invalid_lock())?;
        let guard_path = directory.join("executor.guard.sqlite");
        private_file(&guard_path)?;
        let guard = Connection::open(guard_path)?;
        guard
            .execute_batch("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE")
            .map_err(|_| busy())?;
        let boot_id = fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .map_err(|_| unavailable())?
            .trim()
            .to_owned();
        let process_id = std::process::id();
        let runner = Runner {
            boot_id,
            process_id,
            process_start: process_start(process_id)?.ok_or_else(unavailable)?,
            lock_id: request_id(),
        };
        let path = directory.join("executor.lock");
        let previous_file = private_file(&path)?;
        if previous_file.len() > 4096 {
            return Err(invalid_lock());
        }
        let raw = fs::read(&path).map_err(|_| invalid_lock())?;
        if !raw.is_empty() {
            let previous = serde_json::from_slice(&raw).map_err(|_| invalid_lock())?;
            stopped(&previous, &runner.boot_id)?;
        }
        let mut statement = db.prepare(
            "SELECT intent_json FROM device_journal WHERE state NOT IN ('acknowledged','not_sent')",
        )?;
        for row in statement.query_map([], |r| r.get::<_, String>(0))? {
            let intent: Value = serde_json::from_str(&row?).map_err(|_| unavailable())?;
            let prior: Runner =
                serde_json::from_value(intent["runner"].clone()).map_err(|_| unavailable())?;
            stopped(&prior, &runner.boot_id)?;
            let children = intent["children"]
                .as_array()
                .filter(|a| a.len() <= 64)
                .ok_or_else(unavailable)?;
            for child in children {
                let group = child["processGroupId"]
                    .as_i64()
                    .and_then(|pid| i32::try_from(pid).ok())
                    .filter(|pid| *pid > 0)
                    .and_then(rustix::process::Pid::from_raw)
                    .ok_or_else(unavailable)?;
                if child["processId"]
                    .as_u64()
                    .is_none_or(|pid| pid == 0 || pid > 9_007_199_254_740_991)
                    || child["processStart"]
                        .as_str()
                        .is_none_or(|start| !valid_start(start))
                {
                    return Err(unavailable());
                }
                match rustix::process::test_kill_process_group(group) {
                    Err(rustix::io::Errno::SRCH) => {}
                    Ok(()) => return Err(busy()),
                    Err(_) => return Err(unavailable()),
                }
            }
        }
        let current = private_metadata(&path, false).map_err(|_| invalid_lock())?;
        if (current.dev(), current.ino()) != (previous_file.dev(), previous_file.ino()) {
            return Err(invalid_lock());
        }
        let data = serde_json::to_value(&runner).map_err(|_| Failure::storage())?;
        save(&path, db::canonical(&data).as_bytes(), true).map_err(|_| Failure::storage())?;
        let info = private_metadata(&path, false).map_err(|_| invalid_lock())?;
        Ok(Self {
            boot_id: runner.boot_id,
            path,
            file: (info.dev(), info.ino()),
            _guard: guard,
        })
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        if fs::symlink_metadata(&self.path).is_ok_and(|info| (info.dev(), info.ino()) == self.file)
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}
