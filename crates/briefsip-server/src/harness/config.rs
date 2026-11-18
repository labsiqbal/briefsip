use crate::{data::providers::format_timeout, web::Failure, AppState};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex as SyncMutex},
    time::{Duration, Instant},
};
use tokio::{
    sync::{watch, Mutex},
    time::Instant as ClockInstant,
};

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub harness: Option<Value>,
    pub test_harness_bridge: Option<Bridge>,
    pub test_pdf_bridge: Option<Bridge>,
    #[serde(skip)]
    pub test_mode: bool,
    #[serde(skip)]
    pub environment: HashMap<String, String>,
    #[serde(skip)]
    pub cache: Arc<Mutex<Option<(Instant, Value)>>>,
    #[serde(skip)]
    pub revocations: Arc<std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>>,
    #[serde(skip)]
    pub stopping_processes: Arc<std::sync::Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    #[serde(skip)]
    pub homes: Arc<Mutex<HashMap<String, super::store::Home>>>,
    #[serde(skip)]
    clocks: Arc<SyncMutex<HashMap<String, TurnClock>>>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bridge {
    pub origin: String,
    pub token: String,
}

#[derive(Clone)]
pub(super) struct TurnClock {
    deadlines: watch::Sender<Deadlines>,
    idle: Duration,
    max: Duration,
}

#[derive(Clone, Copy)]
struct Deadlines {
    idle: ClockInstant,
    max: ClockInstant,
    waiting_since: Option<ClockInstant>,
    waiters: usize,
}

impl Deadlines {
    fn next(self) -> ClockInstant {
        self.idle.min(self.max)
    }
}

impl TurnClock {
    fn new(idle: Duration, max: Duration, checkpoint: Option<(u64, u64)>) -> Self {
        let now = ClockInstant::now();
        let (active, idle_left) = checkpoint
            .map(|(active, idle_left)| {
                (
                    Duration::from_millis(active),
                    Duration::from_millis(idle_left),
                )
            })
            .unwrap_or((Duration::ZERO, idle));
        let (deadlines, _) = watch::channel(Deadlines {
            idle: now + idle.min(idle_left),
            max: now + max.saturating_sub(active),
            waiting_since: None,
            waiters: 0,
        });
        Self {
            deadlines,
            idle,
            max,
        }
    }

    pub(super) fn activity(&self) {
        self.deadlines.send_if_modified(|d| {
            let now = ClockInstant::now();
            if d.waiting_since.is_some() || now >= d.next() {
                return false;
            }
            d.idle = now + self.idle;
            true
        });
    }

    fn pause(&self) -> super::Result<CardWait> {
        let paused = self.deadlines.send_if_modified(|d| {
            let now = ClockInstant::now();
            if d.waiting_since.is_none() && now >= d.next() {
                return false;
            }
            d.waiters += 1;
            d.waiting_since.get_or_insert(now);
            true
        });
        if !paused {
            return Err(self.failure(*self.deadlines.borrow()));
        }
        Ok(CardWait {
            clock: Some(self.clone()),
        })
    }

    fn resume(&self) {
        self.deadlines.send_modify(|d| {
            d.waiters -= 1;
            if d.waiters == 0 {
                if let Some(started) = d.waiting_since.take() {
                    let elapsed = started.elapsed();
                    d.idle += elapsed;
                    d.max += elapsed;
                }
            }
        });
    }

    pub(super) async fn expired(&self) -> Failure {
        let mut deadlines = self.deadlines.subscribe();
        loop {
            let d = *deadlines.borrow_and_update();
            if d.waiting_since.is_some() {
                let _ = deadlines.changed().await;
            } else if ClockInstant::now() >= d.next() {
                return self.failure(d);
            } else {
                tokio::select! {
                    _ = deadlines.changed() => {},
                    _ = tokio::time::sleep_until(d.next()) => {},
                }
            }
        }
    }

    fn failure(&self, d: Deadlines) -> Failure {
        let limit = if d.max <= d.idle {
            format!("Reached the {} limit.", format_timeout(self.max))
        } else {
            format!("No activity for {}.", format_timeout(self.idle))
        };
        super::error(
            502,
            format!("{limit} Check workspace changes before retrying. This turn was not replayed."),
        )
    }
}

pub(super) struct ActiveClock<'a> {
    config: &'a Config,
    turn: &'a str,
    pub(super) clock: TurnClock,
}

impl<'a> ActiveClock<'a> {
    pub(super) fn new(state: &'a AppState, turn: &'a str) -> super::Result<Self> {
        let config = &state.config.harness;
        let checkpoint = {
            let db = state.database.lock().map_err(|_| Failure::storage())?;
            db.connection
                .query_row(
                    "SELECT active_ms,idle_remaining_ms FROM harness_card_time WHERE turn=?",
                    [turn],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
        };
        let clock = TurnClock::new(
            state.config.data.turn_idle_timeout(),
            state.config.data.turn_max_timeout(),
            checkpoint,
        );
        config
            .clocks
            .lock()
            .map_err(|_| Failure::storage())?
            .insert(turn.into(), clock.clone());
        Ok(Self {
            config,
            turn,
            clock,
        })
    }
}

impl Drop for ActiveClock<'_> {
    fn drop(&mut self) {
        if let Ok(mut clocks) = self.config.clocks.lock() {
            clocks.remove(self.turn);
        }
    }
}

pub(crate) struct CardWait {
    clock: Option<TurnClock>,
}

impl CardWait {
    pub(crate) fn start(state: &AppState, turn: &str) -> super::Result<Option<Self>> {
        let clock = state
            .config
            .harness
            .clocks
            .lock()
            .map_err(|_| Failure::storage())?
            .get(turn)
            .cloned();
        clock.map(|clock| clock.pause()).transpose()
    }

    // Question and Computer cards release the process. Save both budgets for the next launch.
    pub(crate) fn checkpoint(
        state: &AppState,
        db: &rusqlite::Connection,
        turn: &str,
    ) -> super::Result<Option<Self>> {
        let wait = Self::start(state, turn)?;
        if let Some(clock) = wait.as_ref().and_then(|wait| wait.clock.as_ref()) {
            let d = *clock.deadlines.borrow();
            let now = d.waiting_since.ok_or_else(Failure::storage)?;
            let active_ms = clock
                .max
                .saturating_sub(d.max.saturating_duration_since(now))
                .as_millis() as u64;
            let idle_remaining_ms = d.idle.saturating_duration_since(now).as_millis() as u64;
            db.execute(
                "INSERT INTO harness_card_time(turn,active_ms,idle_remaining_ms) VALUES(?,?,?) ON CONFLICT(turn) DO UPDATE SET active_ms=excluded.active_ms,idle_remaining_ms=excluded.idle_remaining_ms",
                rusqlite::params![turn, active_ms, idle_remaining_ms],
            )?;
        }
        Ok(wait)
    }

    pub(crate) fn keep_paused(mut self) {
        self.clock = None;
    }
}

impl Drop for CardWait {
    fn drop(&mut self) {
        if let Some(clock) = &self.clock {
            clock.resume();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn harness_events_every_30_seconds_complete_after_three_minutes() {
        let clock = TurnClock::new(Duration::from_secs(40), Duration::from_secs(3600), None);
        let start = ClockInstant::now();
        let runtime = async {
            for _ in 0..6 {
                tokio::time::sleep(Duration::from_secs(30)).await;
                clock.activity();
            }
        };
        tokio::select! {
            failure = clock.expired() => panic!("{}", failure.message),
            () = runtime => {}
        }
        assert_eq!(start.elapsed(), Duration::from_secs(180));
    }

    #[tokio::test(start_paused = true)]
    async fn silent_harness_hits_idle_deadline() {
        let clock = TurnClock::new(Duration::from_secs(600), Duration::from_secs(3600), None);
        let start = ClockInstant::now();
        let failure = clock.expired().await;
        assert_eq!(start.elapsed(), Duration::from_secs(600));
        assert!(failure.message.starts_with("No activity for 10 min."));
    }

    #[tokio::test(start_paused = true)]
    async fn approval_wait_preserves_idle_and_wall_time() {
        let clock = TurnClock::new(Duration::from_secs(40), Duration::from_secs(60), None);
        let start = ClockInstant::now();
        let runtime = async {
            tokio::time::sleep(Duration::from_secs(20)).await;
            clock.activity();
            let approval = clock.pause().map_err(|failure| failure.message)?;
            tokio::time::sleep(Duration::from_secs(120)).await;
            drop(approval);
            tokio::time::sleep(Duration::from_secs(30)).await;
            clock.activity();
            std::future::pending::<()>().await;
            Ok::<_, String>(())
        };
        let failure = tokio::select! {
            failure = clock.expired() => failure,
            result = runtime => panic!("runtime should hit its wall limit: {result:?}"),
        };
        assert_eq!(start.elapsed(), Duration::from_secs(180));
        assert!(failure.message.starts_with("Reached the 1 min limit."));
    }
}
