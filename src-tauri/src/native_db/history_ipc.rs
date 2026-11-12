//! Per-consumer native history tasks. Cancelling one task drops its history
//! future (and owned HTTP), never the login or another consumer's work.
use super::messages::{NativeHistoryDemand, NativeHistoryIntent, NativeHistoryResult};
use crate::ServerSessionState;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tokio_util::sync::CancellationToken;

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum HistoryEvent {
    Ready { result: NativeHistoryResult },
    Failed { reason: String },
}

#[derive(Default)]
struct HistoryTasks(Mutex<HashMap<String, CancellationToken>>);

impl HistoryTasks {
    fn register(&self) -> (String, CancellationToken) {
        let id = uuid::Uuid::new_v4().to_string();
        let token = CancellationToken::new();
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), token.clone());
        (id, token)
    }

    fn cancel(&self, id: &str) {
        let token = self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        if let Some(token) = token {
            token.cancel();
        }
    }

    fn finish(&self, id: &str) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }
}

fn tasks() -> &'static HistoryTasks {
    static TASKS: OnceLock<HistoryTasks> = OnceLock::new();
    TASKS.get_or_init(HistoryTasks::default)
}

struct Registration(String);
impl Drop for Registration {
    fn drop(&mut self) {
        tasks().finish(&self.0);
    }
}

pub(super) async fn run_until_cancelled<T>(
    token: &CancellationToken,
    work: impl std::future::Future<Output = T>,
) -> Option<T> {
    tokio::select! {
        biased;
        _ = token.cancelled() => None,
        value = work => if token.is_cancelled() { None } else { Some(value) },
    }
}

#[tauri::command]
pub(crate) fn native_message_history_start(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ServerSessionState>,
    user_id: i64,
    thread_id: i64,
    demand: NativeHistoryDemand,
    known_newest_seq: Option<i64>,
    events: tauri::ipc::Channel<HistoryEvent>,
) -> Result<String, String> {
    let intent = NativeHistoryIntent::capture(Some(&app), &proxy, user_id, thread_id)?;
    // Register before spawning: an immediate result cannot leave a stale entry,
    // and cancellation received before the task is first polled is retained.
    let (id, token) = tasks().register();
    let registration = Registration(id.clone());
    tauri::async_runtime::spawn(async move {
        let _registration = registration;
        if let Some(result) = run_until_cancelled(&token, intent.get_with_head(demand, known_newest_seq)).await {
            let event = match result {
                Ok(result) => HistoryEvent::Ready { result },
                Err(reason) => HistoryEvent::Failed { reason },
            };
            let _ = events.send(event);
        }
    });
    Ok(id)
}

#[tauri::command]
pub(crate) fn native_message_history_cancel(request_id: String) {
    tasks().cancel(&request_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    struct DropProbe(Arc<AtomicBool>);
    impl Drop for DropProbe {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn cancellation_drops_owned_work_but_not_another_consumer() {
        let tasks = HistoryTasks::default();
        let (id, token) = tasks.register();
        let (_, sibling) = tasks.register();
        let dropped = Arc::new(AtomicBool::new(false));
        let probe = DropProbe(dropped.clone());
        let (started, ready) = tokio::sync::oneshot::channel();
        let task_token = token.clone();
        let task = tokio::spawn(async move {
            run_until_cancelled(&task_token, async move {
                let _probe = probe;
                let _ = started.send(());
                std::future::pending::<()>().await;
            })
            .await
        });
        ready.await.unwrap();
        tasks.cancel(&id);
        assert!(task.await.unwrap().is_none());
        assert!(dropped.load(Ordering::SeqCst));
        assert!(!sibling.is_cancelled());
        tasks.cancel(&id);
    }

    #[tokio::test]
    async fn cancellation_before_poll_does_not_start_work() {
        let token = CancellationToken::new();
        token.cancel();
        let result = run_until_cancelled(&token, async { panic!("cancelled work polled") }).await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn completed_registration_is_removed() {
        let tasks = HistoryTasks::default();
        let (id, token) = tasks.register();
        assert_eq!(run_until_cancelled(&token, async { 42 }).await, Some(42));
        tasks.finish(&id);
        tasks.cancel(&id);
        assert!(!token.is_cancelled());
        assert!(tasks.0.lock().unwrap().is_empty());
    }
}
