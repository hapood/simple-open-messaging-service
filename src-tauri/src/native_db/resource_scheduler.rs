use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use super::attention::{
    pending_thread_resource_work, read_tomb_progress, sync_group_meta_page, sync_tombstone_page,
    FeedIntent, MetaPageOutcome, TombPageOutcome,
};
use crate::login_connection::DatabaseWork;
use crate::login_request::LoginRequest;
use crate::realtime::NativeEvents;
use log::warn;

#[derive(Clone, Copy, Eq, PartialEq, Hash, Debug)]
enum Lane {
    Tomb,
    Meta,
}
impl Lane {
    fn index(self) -> usize {
        match self {
            Self::Tomb => 0,
            Self::Meta => 1,
        }
    }
    fn limit(self) -> usize {
        match self {
            Self::Tomb => 4,
            Self::Meta => 2,
        }
    }
}
type Task = (i64, Lane);
#[derive(Default)]
struct Entry {
    running: bool,
    retry_at: Option<Instant>,
    attempts: u32,
    stalled_at: Option<(i64, i64)>,
}
#[derive(Default)]
struct SchedulerState {
    active: [usize; 2],
    pending: HashSet<Task>,
    entries: HashMap<Task, Entry>,
}
struct LoginScheduler {
    work: DatabaseWork,
    request: LoginRequest,
    user_id: i64,
    events: NativeEvents,
    state: Mutex<SchedulerState>,
}
// One retained scheduler for the current login, including idle cutoff stalls.
// The instance is never rebound; cancellation retires it even without another login.
static CURRENT: LazyLock<Mutex<Option<Arc<LoginScheduler>>>> = LazyLock::new(|| Mutex::new(None));

fn scheduler_for(
    work: DatabaseWork,
    request: LoginRequest,
    user_id: i64,
    events: NativeEvents,
) -> Option<Arc<LoginScheduler>> {
    if user_id <= 0 || work.assert_current().is_err() {
        return None;
    }
    let mut current = CURRENT.lock().expect("resource scheduler owner poisoned");
    if let Some(existing) = current.as_ref() {
        if existing.work.assert_current().is_ok() {
            if existing.work.owner().id() == work.owner().id() && existing.user_id == user_id {
                return Some(Arc::clone(existing));
            }
            return None;
        }
    }
    let scheduler = Arc::new(LoginScheduler {
        work,
        request,
        user_id,
        events,
        state: Mutex::default(),
    });
    *current = Some(Arc::clone(&scheduler));
    let weak = Arc::downgrade(&scheduler);
    let cancellation = scheduler.work.cancellation();
    tokio::spawn(async move {
        cancellation.cancelled().await;
        let mut current = CURRENT.lock().expect("resource scheduler owner poisoned");
        if current
            .as_ref()
            .is_some_and(|value| weak.ptr_eq(&Arc::downgrade(value)))
        {
            *current = None;
        }
    });
    Some(scheduler)
}

pub(crate) fn schedule_pending(
    work: DatabaseWork,
    request: LoginRequest,
    user_id: i64,
    events: NativeEvents,
) {
    let Some(scheduler) = scheduler_for(work, request, user_id, events) else {
        return;
    };
    tokio::spawn(async move {
        let work = scheduler.work.clone();
        let user_id = scheduler.user_id;
        let Ok(Ok(pending)) = super::spawn_owned_database(Ok(work), move |conn| {
            pending_thread_resource_work(conn, user_id)
        })
        .await
        else {
            return;
        };
        for thread_id in pending.tomb_thread_ids {
            scheduler.enqueue((thread_id, Lane::Tomb));
        }
        for thread_id in pending.meta_thread_ids {
            scheduler.enqueue((thread_id, Lane::Meta));
        }
    });
}
pub(super) fn wake_tomb_cutoff(
    work: DatabaseWork,
    request: LoginRequest,
    user_id: i64,
    thread_id: i64,
    events: NativeEvents,
) {
    if thread_id <= 0 {
        return;
    }
    if let Some(scheduler) = scheduler_for(work, request, user_id, events) {
        scheduler.enqueue((thread_id, Lane::Tomb));
    }
}
impl LoginScheduler {
    fn enqueue(self: &Arc<Self>, task: Task) {
        if self.work.assert_current().is_err() {
            return;
        }
        {
            let mut state = self
                .state
                .lock()
                .expect("resource scheduler state poisoned");
            state.entries.entry(task).or_default();
            // A pending successor is allowed while the same task runs, but it
            // cannot acquire a slot until that run has completed.
            state.pending.insert(task);
        }
        self.pump(task.1);
    }
    fn pump(self: &Arc<Self>, lane: Lane) {
        loop {
            if self.work.assert_current().is_err() {
                return;
            }
            let selected = {
                let mut state = self
                    .state
                    .lock()
                    .expect("resource scheduler state poisoned");
                if state.active[lane.index()] >= lane.limit() {
                    return;
                }
                let ready: Vec<Task> = state
                    .pending
                    .iter()
                    .copied()
                    .filter(|task| {
                        let entry = &state.entries[task];
                        task.1 == lane && !entry.running && entry.retry_at.is_none()
                    })
                    .collect();
                if ready.is_empty() {
                    return;
                }
                let index = (uuid::Uuid::new_v4().as_u128() % ready.len() as u128) as usize;
                let task = ready[index];
                state.pending.remove(&task);
                let entry = state.entries.get_mut(&task).unwrap();
                entry.running = true;
                let stalled = entry.stalled_at;
                state.active[lane.index()] += 1;
                (task, stalled)
            };
            let scheduler = Arc::clone(self);
            tokio::spawn(async move {
                let outcome = scheduler.run(selected.0, selected.1).await;
                scheduler.finish(selected.0, outcome);
            });
        }
    }
    async fn run(
        &self,
        task: Task,
        stalled: Option<(i64, i64)>,
    ) -> Result<TombPageOutcome, String> {
        let (thread_id, lane) = task;
        if lane == Lane::Tomb {
            if let Some((target, cutoff)) = stalled {
                let user_id = self.user_id;
                let progress = super::spawn_owned_database(Ok(self.work.clone()), move |conn| {
                    read_tomb_progress(conn, user_id, thread_id)
                })
                .await
                .map_err(|e| e.to_string())??;
                match progress {
                    None => return Ok(TombPageOutcome::Done),
                    Some((latest, hwm, _)) if hwm >= latest => return Ok(TombPageOutcome::Done),
                    Some((latest, _, current)) if latest <= target && current <= cutoff => {
                        return Ok(TombPageOutcome::CutoffStalled { target, cutoff });
                    }
                    _ => {}
                }
            }
        }
        let mut intent =
            FeedIntent::from_parts(self.user_id, self.work.clone(), self.request.clone())?;
        match lane {
            Lane::Tomb => sync_tombstone_page(&mut intent, thread_id, &self.events).await,
            Lane::Meta => Ok(
                match sync_group_meta_page(&mut intent, thread_id, &self.events).await? {
                    MetaPageOutcome::More => TombPageOutcome::More,
                    MetaPageOutcome::Done => TombPageOutcome::Done,
                },
            ),
        }
    }
    fn finish(self: &Arc<Self>, task: Task, outcome: Result<TombPageOutcome, String>) {
        let retry = {
            let mut state = self
                .state
                .lock()
                .expect("resource scheduler state poisoned");
            state.active[task.1.index()] -= 1;
            let entry = state.entries.get_mut(&task).unwrap();
            entry.running = false;
            if self.work.assert_current().is_err() {
                return;
            }
            let mut retry = None;
            match outcome {
                Ok(TombPageOutcome::CutoffStalled { target, cutoff }) => {
                    entry.attempts = 0;
                    entry.stalled_at = Some((target, cutoff));
                }
                Ok(TombPageOutcome::More) => {
                    entry.attempts = 0;
                    entry.stalled_at = None;
                    state.pending.insert(task);
                }
                Ok(TombPageOutcome::Done) => {
                    entry.attempts = 0;
                    entry.stalled_at = None;
                    if !state.pending.contains(&task) {
                        state.entries.remove(&task);
                    }
                }
                Err(error) => {
                    entry.attempts = entry.attempts.saturating_add(1);
                    let delay = Duration::from_millis(
                        (1000u64 << entry.attempts.saturating_sub(1).min(5)).min(30_000),
                    );
                    entry.retry_at = Some(Instant::now() + delay);
                    state.pending.insert(task);
                    retry = Some(delay);
                    warn!("resource task {task:?} failed; retrying with backoff: {error}");
                }
            }
            retry
        };
        if let Some(delay) = retry {
            let scheduler = Arc::clone(self);
            tokio::spawn(async move {
                let cancellation = scheduler.work.cancellation();
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return,
                    _ = tokio::time::sleep(delay) => {}
                }
                {
                    let mut state = scheduler
                        .state
                        .lock()
                        .expect("resource scheduler state poisoned");
                    if let Some(entry) = state.entries.get_mut(&task) {
                        entry.retry_at = None;
                    }
                }
                scheduler.pump(task.1);
            });
        }
        self.pump(task.1);
    }
}
