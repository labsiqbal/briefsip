use crate::{files, web::Failure, AppState};
use axum::{extract::Request, response::Response};
use serde_json::{json, Value};
use std::{
    fs,
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct Metrics {
    previous: Option<(Instant, u64, u64, usize, u64)>,
    cached: Option<Value>,
    started: Option<Instant>,
}
fn memory(text: &str, key: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        line.strip_prefix(key)?
            .split_whitespace()
            .next()?
            .parse::<u64>()
            .ok()?
            .checked_mul(1024)
    })
}
fn cpu() -> (u64, u64, usize) {
    let text = fs::read_to_string("/proc/stat").unwrap_or_default();
    let mut idle = 0;
    let mut total = 0;
    let mut cores = 0;
    for line in text
        .lines()
        .filter(|l| l.starts_with("cpu") && l.as_bytes().get(3).is_some_and(u8::is_ascii_digit))
    {
        let values: Vec<u64> = line
            .split_whitespace()
            .skip(1)
            .take(8)
            .map(|n| n.parse().unwrap_or(0))
            .collect();
        idle += values.get(3).copied().unwrap_or(0);
        total += values.iter().sum::<u64>();
        cores += 1;
    }
    (idle, total, cores)
}
fn disk(value: rustix::fs::StatVfs) -> Option<Value> {
    let (blocks, free, available, size) = (
        value.f_blocks as u128,
        value.f_bfree as u128,
        value.f_bavail as u128,
        value.f_frsize as u128,
    );
    if blocks == 0 || size == 0 || free < available || blocks < free {
        return None;
    }
    let (total, used, available, reserved) = (
        blocks * size,
        (blocks - free) * size,
        available * size,
        (free - available) * size,
    );
    let pressure = if available * 100 < total * 2 && available <= 1024u128.pow(3) {
        "critical"
    } else if available * 10 < total && available <= 5 * 1024u128.pow(3) {
        "warning"
    } else {
        "normal"
    };
    Some(
        json!({"total":total.to_string(),"available":available.to_string(),"used":used.to_string(),"reserved":reserved.to_string(),"percent":(used*1000/(used+available).max(1)) as f64/10.0,"pressure":pressure}),
    )
}
impl Metrics {
    fn collect(&mut self, state: &AppState) -> Result<Value, Failure> {
        let now = Instant::now();
        if self
            .previous
            .is_some_and(|p| now.duration_since(p.0) < Duration::from_secs(2))
        {
            if let Some(value) = &self.cached {
                return Ok(value.clone());
            }
        }
        let (idle, total, cores) = cpu();
        let process = fs::read_to_string("/proc/self/schedstat")
            .ok()
            .and_then(|v| v.split_whitespace().next()?.parse::<u64>().ok())
            .unwrap_or(0);
        let interval = self
            .previous
            .map(|p| now.duration_since(p.0).as_millis() as u64);
        let percent = self
            .previous
            .and_then(|(_, before_idle, before_total, before_cores, _)| {
                let elapsed = total.checked_sub(before_total)?;
                let idle = idle.checked_sub(before_idle)?;
                (cores > 0 && cores == before_cores && elapsed > 0 && idle <= elapsed)
                    .then(|| ((1.0 - idle as f64 / elapsed as f64) * 1000.0).round() / 10.0)
            });
        let process_percent = self.previous.and_then(|(before, _, _, _, cpu)| {
            let elapsed = now.duration_since(before).as_nanos() as f64;
            process
                .checked_sub(cpu)
                .map(|v| (v as f64 / elapsed * 1000.0).round() / 10.0)
        });
        let meminfo = fs::read_to_string("/proc/meminfo").unwrap_or_default();
        let available = memory(&meminfo, "MemAvailable:");
        let total_memory = memory(&meminfo, "MemTotal:");
        let rss = memory(
            &fs::read_to_string("/proc/self/status").unwrap_or_default(),
            "VmRSS:",
        )
        .unwrap_or(0);
        let mut files_out = Vec::new();
        for (kind, suffix) in [
            ("database", ""),
            ("wal", "-wal"),
            ("shared-memory", "-shm"),
            ("rollback-journal", "-journal"),
            ("mcp-key", ".mcp-key"),
        ] {
            let mut path = state.config.database.as_os_str().to_os_string();
            path.push(suffix);
            let (status, bytes) = match fs::symlink_metadata(path) {
                Ok(m) if m.is_file() => ("present", Some(m.len().to_string())),
                Ok(_) => ("not-regular", None),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => ("missing", None),
                Err(_) => ("unavailable", None),
            };
            files_out.push(json!({"kind":kind,"status":status,"bytes":bytes}));
        }
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        let db = &guard.connection;
        let page_size: u64 = db.query_row("PRAGMA page_size", [], |r| r.get(0))?;
        let pages: u64 = db.query_row("PRAGMA page_count", [], |r| r.get(0))?;
        let free: u64 = db.query_row("PRAGMA freelist_count", [], |r| r.get(0))?;
        let value = json!({"sampledAt":files::timestamp(db,crate::config::now())?,"platform":std::env::consts::OS,"cpu":{"scope":"host","cores":cores,"availableParallelism":std::thread::available_parallelism().map(|n|n.get()).unwrap_or(1),"percent":percent,"intervalMs":interval},"memory":{"total":total_memory,"available":available.filter(|a|total_memory.is_some_and(|t|*a<=t)),"source":"MemAvailable"},"process":{"rss":rss,"cpuPercent":process_percent,"memoryLimit":null,"availableMemory":available,"uptimeSeconds":now.duration_since(*self.started.get_or_insert(now)).as_secs()},"filesystem":state.config.database.parent().and_then(|p|rustix::fs::statvfs(p).ok()).and_then(disk),"storage":{"files":files_out,"databaseBytes":(page_size*pages).to_string(),"reusableBytes":(page_size*free).to_string()}});
        self.previous = Some((now, idle, total, cores, process));
        self.cached = Some(value.clone());
        Ok(value)
    }
}
pub async fn handle(state: &AppState, request: Request) -> Result<Response, Failure> {
    if request.method() != axum::http::Method::GET {
        return Err(Failure::new(405, "invalid_request", "Method not allowed."));
    }
    files::origin(state, &request)?;
    if request.uri().query().is_some() {
        return Err(Failure::new(
            400,
            "invalid_request",
            "Host metrics do not accept paths or parameters.",
        ));
    }
    let value = state
        .computer
        .metrics
        .lock()
        .map_err(|_| Failure::storage())?
        .collect(state)?;
    Ok(crate::json_response(200, value))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn available_memory_does_not_substitute_free_memory() {
        assert_eq!(
            memory("MemFree: 10 kB\nMemAvailable: 20 kB\n", "MemAvailable:"),
            Some(20480)
        );
        assert_eq!(memory("MemAvailable: -1 kB\n", "MemAvailable:"), None);
    }
}
