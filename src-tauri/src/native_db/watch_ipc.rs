//! Push-based watch IPC bridging the web shell to the native watch cores.
//! The command pair mirrors the web subscription contract: subscribe returns
//! an opaque watch id and pushes states through the channel (empty first
//! frame, then the cached or resolved value), and cancel releases the watch.
//!
//! Cancellation discipline: `native_watch_cancel` aborts the forwarder, whose
//! dropped subscription releases the shared flight when it is the last
//! consumer — dropping the flight's in-flight resolve future aborts its HTTP
//! request at the socket. A dead push channel (webview reload) ends the
//! forwarder the same way, and the login epoch cancels every flight outright.
use super::attention::FeedIntent;
use super::namespace_subscriptions::{self, NamespaceWatch};
use super::profile_namespaces::ProfileNamespacePair;
use super::profile_subscriptions;
use crate::ServerSessionState;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::State;

#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum ProfileWatchEvent {
    #[serde(rename = "empty")]
    Empty,
    #[serde(rename = "ready")]
    Ready { profile: Value },
    #[serde(rename = "failed")]
    Failed { reason: String },
}

fn profile_event(outcome: Option<Result<Value, String>>) -> ProfileWatchEvent {
    match outcome {
        None => ProfileWatchEvent::Empty,
        Some(Ok(profile)) => ProfileWatchEvent::Ready { profile },
        Some(Err(reason)) => ProfileWatchEvent::Failed { reason },
    }
}

/// One live IPC watch. `done` closes the registration race: a forwarder can
/// finish before its entry is inserted (a cache hit settles immediately), so
/// both the insert and the forwarder re-check the flag and remove the entry.
struct WatchEntry {
    handle: tauri::async_runtime::JoinHandle<()>,
    done: Arc<AtomicBool>,
}

static WATCHES: OnceLock<Mutex<HashMap<String, WatchEntry>>> = OnceLock::new();

fn watches() -> &'static Mutex<HashMap<String, WatchEntry>> {
    WATCHES.get_or_init(Default::default)
}

fn register(id: &str, handle: tauri::async_runtime::JoinHandle<()>, done: Arc<AtomicBool>) {
    if let Ok(mut watches) = watches().lock() {
        watches.insert(
            id.to_owned(),
            WatchEntry {
                handle,
                done: done.clone(),
            },
        );
        // The forwarder may already have settled (local cache hit).
        if done.load(Ordering::Acquire) {
            watches.remove(id);
        }
    }
}

fn finish(id: &str, done: &AtomicBool) {
    done.store(true, Ordering::Release);
    if let Ok(mut watches) = watches().lock() {
        watches.remove(id);
    }
}

#[tauri::command]
pub(crate) async fn native_watch_profile(
    proxy: State<'_, ServerSessionState>,
    user_id: i64,
    request: Value,
    events: tauri::ipc::Channel<ProfileWatchEvent>,
) -> Result<String, String> {
    let intent = FeedIntent::capture(&proxy, user_id)?;
    let mut subscription = profile_subscriptions::subscribe(intent, request)?;
    let id = uuid::Uuid::new_v4().to_string();
    let done = Arc::new(AtomicBool::new(false));
    let finish_done = done.clone();
    let finish_id = id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        loop {
            let event = profile_event(subscription.state());
            let terminal = !matches!(event, ProfileWatchEvent::Empty);
            if events.send(event).is_err() {
                break;
            }
            // A profile snapshot is immutable: its stream ends at the first
            // settled value, releasing the flight unless other consumers
            // still hold it.
            if terminal {
                break;
            }
            if !subscription.changed().await {
                break;
            }
        }
        finish(&finish_id, &finish_done);
        // Dropping the subscription here releases the shared flight when it
        // is the last consumer, aborting any in-flight HTTP request.
    });
    register(&id, handle, done);
    Ok(id)
}

#[tauri::command]
pub(crate) async fn native_watch_namespace(
    proxy: State<'_, ServerSessionState>,
    user_id: i64,
    pair: ProfileNamespacePair,
    events: tauri::ipc::Channel<NamespaceWatch>,
) -> Result<String, String> {
    let intent = FeedIntent::capture(&proxy, user_id)?;
    let mut subscription = namespace_subscriptions::watch(intent, pair)?;
    let id = uuid::Uuid::new_v4().to_string();
    let done = Arc::new(AtomicBool::new(false));
    let finish_done = done.clone();
    let finish_id = id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        loop {
            let event = subscription.state();
            let terminal = event.is_terminal();
            if events.send(event).is_err() {
                break;
            }
            // Bindings are mutable: only failure states end the stream.
            if terminal {
                break;
            }
            if !subscription.changed().await {
                break;
            }
        }
        finish(&finish_id, &finish_done);
        // Dropping the subscription releases the shared flight when it is
        // the last consumer, aborting any in-flight resolve request.
    });
    register(&id, handle, done);
    Ok(id)
}

#[tauri::command]
pub(crate) fn native_watch_cancel(watch_id: String) -> Result<(), String> {
    if watch_id.is_empty() {
        return Err("invalid watch id".into());
    }
    let entry = watches()
        .lock()
        .ok()
        .and_then(|mut watches| watches.remove(&watch_id));
    if let Some(entry) = entry {
        entry.done.store(true, Ordering::Release);
        entry.handle.abort();
    }
    Ok(())
}
