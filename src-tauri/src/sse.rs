use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{FutureExt, StreamExt};
use log::warn;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::{ServerSessionState, SSE_CONNECT_TIMEOUT};

// Shared Rust /events protocol. Desktop commands below are transport control adapters;
// Android's headless JNI adapter uses the same run_loop and typed publication sink.

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum ConnectionState {
    Connecting,
    Open,
    Reconnecting,
    Closed,
    Disconnected,
}

#[derive(Clone, serde::Serialize)]
struct SseEventPayload {
    event: String,
    status: i64,             // always 0 (parity with the worker + native transports)
    message: String,         // always "new message" (parity)
    data: serde_json::Value, // Null when the frame carried no `data:`
}

#[derive(Clone, serde::Serialize)]
struct SseForceLogout {
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

/// One parsed SSE frame: the `event:` name + the joined `data:` lines as parsed JSON (Null when empty).
struct ParsedFrame {
    event: String,
    data: serde_json::Value,
}

/// Why one stream attempt ended → tells the supervisor loop whether to reconnect (back off + retry) or
/// stop (force-logout / cancelled).
#[derive(Debug, PartialEq, Eq)]
enum StreamOutcome {
    ForcedReconnect, // explicit control: reopen immediately, without failure backoff
    StreamClosed,    // server ended the stream cleanly → reconnect
    Cancelled,       // sse_stop / logout → exit the loop
    ForceLogout(Option<String>), // 401 or a `FORCE_LOGOUT` frame → exit (no retry, no 401-loop)
    Err,             // network / non-2xx → reconnect
}

/// Supervisor state: the spawned connect-loop task + its cancellation token, a synchronous state mirror
/// (`sse_get_state` seeds a freshly-booted renderer the way `SomsFcm.getConnState()` does on Android), the
/// backoff/online `wake` Notify, the offline flag the webview's navigator online/offline drives, and the
/// cached HELLO — the last HELLO frame merged with every incremental revision frame
/// (for example, STATE_FEED_UPDATED) so a re-attached
/// webview can be handed a FRESH handshake via `sse_replay_hello` without a reconnect (a retained open
/// stream does not re-push HELLO on its own).
#[cfg(desktop)]
pub(crate) struct SseSupervisor {
    runtime: &'static crate::realtime::Supervisor,
}

#[cfg(desktop)]
impl SseSupervisor {
    pub(crate) fn new() -> Self {
        Self {
            runtime: crate::realtime::runtime(),
        }
    }
}

fn conn_state_str(s: ConnectionState) -> &'static str {
    match s {
        ConnectionState::Connecting => "connecting",
        ConnectionState::Open => "open",
        ConnectionState::Reconnecting => "reconnecting",
        ConnectionState::Closed => "closed",
        ConnectionState::Disconnected => "disconnected",
    }
}

/// Mirror `s` into the synchronous state field (so `sse_get_state` reflects it) AND emit it to the
/// webview (`soms-sse-state`) so the connection banner updates on every transition.
fn emit_state(
    app: &Arc<crate::realtime::Run>,
    state: &Arc<Mutex<ConnectionState>>,
    s: ConnectionState,
) {
    if let Ok(mut g) = state.lock() {
        *g = s;
    }
    app.set_state(conn_state_str(s));
}

/// Idempotently spawn the connect-loop (no-op if one is already running). The facade's origin-swap path
/// is stop→start, and a renderer-reclaim re-boot calls start again — a duplicate would open a second
/// stream. We rely on `sse_stop` clearing `handle` (the task only exits via cancel or force-logout, both
/// of which the facade follows with stop).
#[cfg(desktop)]
#[tauri::command]
pub(crate) fn sse_start(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ServerSessionState>,
    sse: tauri::State<'_, SseSupervisor>,
) -> Result<u64, String> {
    Ok(sse.runtime.start(
        proxy.inner().clone(),
        Arc::new(crate::realtime::DesktopSink::new(app)),
    ))
}

/// Stop the supervisor: emit `closed` synchronously, wake any backoff sleep, cancel the task. Every await
/// in the loop selects against `cancel.cancelled()`, so cancel propagates promptly (the reqwest future is
/// dropped — cancel-safe in reqwest 0.12). The handle is detached (dropped, not awaited) so the IPC
/// returns at once; the task unwinds on its own.
#[cfg(desktop)]
#[tauri::command]
pub(crate) fn sse_stop(instance: u64, sse: tauri::State<'_, SseSupervisor>) -> Result<(), String> {
    sse.runtime.stop(instance);
    Ok(())
}

/// Synchronous read of the current connection state — seeds a freshly-booted renderer the way Android's
/// `SomsFcm.getConnState()` does. Rust only pushes state on *transitions*, so without this a reclaimed
/// webview's banner would be stale until the next transition.
#[cfg(desktop)]
#[tauri::command]
pub(crate) fn sse_get_state(instance: u64, sse: tauri::State<'_, SseSupervisor>) -> String {
    if sse.runtime.current().is_some_and(|r| r.owner() == instance) {
        sse.runtime.state()
    } else {
        "closed".into()
    }
}

/// The webview's `navigator` online/offline is the one source that knows the network dropped before the
/// transport could (dropped wifi → half-open TCP → reqwest blocks near-forever). The JS transport
/// forwards both transitions here (and reuses `online=true` for user-initiated retry). `wake` releases
/// the supervisor's current await — an open-stream read OR a backoff sleep — and the loop re-checks
/// `offline` to decide immediate-retry vs. drop-the-stream.
#[cfg(desktop)]
#[tauri::command]
pub(crate) fn sse_net(
    instance: u64,
    online: bool,
    sse: tauri::State<'_, SseSupervisor>,
) -> Result<(), String> {
    sse.runtime.net(instance, online, false);
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) fn sse_retry(instance: u64, force: bool, sse: tauri::State<'_, SseSupervisor>) -> u64 {
    sse.runtime.retry(instance, force)
}

/// Hand a freshly-attached webview the cached HELLO. A retained open stream does NOT re-push HELLO (it is
/// sent once per `register`), yet a re-attached webview (renderer reclaim, or an Android cold start where the
/// FGS opened `/events` before the webview mounted) needs one to bootstrap (userId / stateFeedEndId /
/// profileRev). The supervisor caches the last HELLO and merges every
/// incremental revision frame into it (see `open_one_stream`), so this replays the CURRENT merged HELLO down
/// the same `soms-sse-event` channel the original used — no reconnect, no connection churn, no event gap.
/// `app.emit` broadcasts to all webviews (a live webview receiving a second HELLO just re-runs its idempotent
/// onHello). No-op when the cache is empty (the facade's HELLO-timeout backstop then force-reconnects for a
/// fresh one). Mirrors Android's `SomsFcm.replayHello`.
#[cfg(desktop)]
#[tauri::command]
pub(crate) fn sse_replay_hello(
    instance: u64,
    sse: tauri::State<'_, SseSupervisor>,
) -> Result<(), String> {
    if let Some(run) = sse.runtime.current().filter(|r| r.owner() == instance) {
        let Some(data) = run.replay() else {
            return Ok(());
        };
        let _ = run.emit(
            "soms-sse-event",
            SseEventPayload {
                event: "HELLO".to_string(),
                status: 0,
                message: "new message".to_string(),
                data,
            },
        );
    }
    Ok(())
}

fn control_wake_outcome(offline: &AtomicBool, force: &AtomicBool) -> Option<StreamOutcome> {
    if offline.load(Ordering::Acquire) {
        return Some(StreamOutcome::StreamClosed);
    }
    force
        .swap(false, Ordering::AcqRel)
        .then_some(StreamOutcome::ForcedReconnect)
}

fn receipt_body_accepted(body: &serde_json::Value) -> bool {
    body.get("code").and_then(serde_json::Value::as_i64) == Some(0)
}

async fn receipt_accepted(response: Result<reqwest::Response, reqwest::Error>) -> bool {
    let Ok(response) = response else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    response
        .json::<serde_json::Value>()
        .await
        .is_ok_and(|body| receipt_body_accepted(&body))
}

#[cfg(test)]
mod receipt_tests {
    #[test]
    fn explicit_force_is_not_a_failure_and_does_not_override_offline() {
        use super::*;
        let offline = AtomicBool::new(false);
        let force = AtomicBool::new(true);
        assert_eq!(
            control_wake_outcome(&offline, &force),
            Some(StreamOutcome::ForcedReconnect)
        );
        assert_eq!(control_wake_outcome(&offline, &force), None);
        offline.store(true, Ordering::Release);
        force.store(true, Ordering::Release);
        assert_eq!(
            control_wake_outcome(&offline, &force),
            Some(StreamOutcome::StreamClosed)
        );
        assert!(force.load(Ordering::Acquire));
    }
    #[test]
    fn only_business_success_acknowledges_a_receipt() {
        assert!(super::receipt_body_accepted(
            &serde_json::json!({"code":0,"data":null})
        ));
        for body in [
            serde_json::json!({"code":10000}),
            serde_json::json!({"code":"0"}),
            serde_json::json!({}),
            serde_json::Value::Null,
        ] {
            assert!(!super::receipt_body_accepted(&body));
        }
    }
}

pub(crate) async fn run_loop(app: Arc<crate::realtime::Run>, proxy: ServerSessionState) {
    if wait_for_identity(&app, &proxy).await {
        if let Some(login_cancel) = app.login_cancellation() {
            tokio::select! { biased;
                _ = app.cancel.cancelled() => {},
                _ = login_cancel.cancelled() => {},
                _ = sse_supervisor_loop(
                    app.clone(), proxy, app.cancel.clone(),
                    Arc::new(Mutex::new(ConnectionState::Closed)),
                    app.wake.clone(), app.offline.clone(), app.hello.clone(),
                ) => {},
            }
        }
    }
    // Cover early identity/bootstrap failures as well as normal terminal stream outcomes.
    app.set_state("closed");
    app.cancel.cancel();
}

async fn wait_for_identity(app: &Arc<crate::realtime::Run>, proxy: &ServerSessionState) -> bool {
    // An unbound OS worker may await its first admitted login. Once bound it can never adopt another.
    loop {
        let notified = proxy.token_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if !app.active() {
            return false;
        }
        if app.bind_identity() {
            return true;
        }
        if !app.active() {
            return false;
        }
        let login_cancel = app.login_cancellation().unwrap_or_default();
        tokio::select! { biased;
            _ = app.cancel.cancelled() => return false,
            _ = login_cancel.cancelled() => return false,
            _ = &mut notified => {},
        }
    }
}

async fn sse_supervisor_loop(
    app: Arc<crate::realtime::Run>,
    proxy: ServerSessionState,
    cancel: CancellationToken,
    state: Arc<Mutex<ConnectionState>>,
    wake: Arc<Notify>,
    offline: Arc<AtomicBool>,
    cached_hello: Arc<Mutex<Option<serde_json::Value>>>,
) {
    emit_state(&app, &state, ConnectionState::Connecting);
    app.pick_origin().await;
    if !app.authenticated() {
        return;
    }
    app.publish_origin();

    let mut opened_once = false;
    let mut attempt: u32 = 0;
    loop {
        if !app.authenticated() {
            break;
        }
        if offline.load(Ordering::Acquire) {
            emit_state(&app, &state, ConnectionState::Disconnected);
            tokio::select! { biased; _ = cancel.cancelled() => break, _ = wake.notified() => continue }
        }
        let outcome = open_one_stream(
            &app,
            &proxy,
            &cancel,
            &state,
            &wake,
            &offline,
            &cached_hello,
            &mut opened_once,
        )
        .await;
        if cancel.is_cancelled() {
            break;
        }
        match outcome {
            StreamOutcome::ForceLogout(reason) => {
                let _ = app.emit("soms-sse-force-logout", SseForceLogout { reason });
                break; // no retry — a stale/revoked token would 401-loop
            }
            StreamOutcome::Cancelled => break,
            StreamOutcome::ForcedReconnect => {
                attempt = 0;
                emit_state(&app, &state, ConnectionState::Connecting);
                continue;
            }
            StreamOutcome::StreamClosed | StreamOutcome::Err => {
                // Preserve the existing origin race after a network error: a successful selection
                // reopens immediately. Server-side closure goes through the bounded backoff.
                if matches!(outcome, StreamOutcome::Err) {
                    let picked = app.pick_origin().await;
                    if !app.authenticated() {
                        break;
                    }
                    if picked.is_some() {
                        app.publish_origin();
                        warn!("sse: origin race after Err succeeded → reopen at once (no backoff)");
                        attempt = 0;
                        continue;
                    }
                }
                emit_state(&app, &state, ConnectionState::Reconnecting);
                attempt = attempt.saturating_add(1);
                // Full-jitter backoff (parity with the worker): random(0, min(1000·2^attempt, 30000)).
                let ceil = (1000u64 << attempt.min(5)).min(30_000);
                let delay = Duration::from_millis(jitter(ceil));
                // Announce the scheduled delay so the renderer's countdown chip can tick (the JS side owns
                // the live clock). Backend→frontend events need no capability; same channel as the other
                // soms-sse-* events. An early wake (`sse_net` retry / online) resolves the select before
                // `delay` elapses; the next failure re-emits, the next open clears it via the state event.
                let _ = app.emit("soms-sse-reconnect-in", delay.as_millis() as u64);
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = wake.notified() => {
                        // online / user-retry / network-change → retry at once (reset attempt); offline →
                        // retry fails fast and backs off again. The pick_origin_race just below re-races on
                        // the changed topology (the other origin may now be reachable).
                        if !offline.load(Ordering::Acquire) {
                            attempt = 0;
                        }
                    }
                    _ = tokio::time::sleep(delay) => {}
                }
                // Full-disconnect RECONNECT: race BOTH origins (the concurrent race) to find the reachable
                // one before reopening. This + login init are the only two places the concurrent race runs.
                // If both are still down, the active is unchanged → the next open fails → backoff again.
                app.pick_origin().await;
                if app.authenticated() {
                    app.publish_origin();
                }
            }
        }
    }
    emit_state(&app, &state, ConnectionState::Closed);
}

/// Merge one inbound SSE frame into the cached HELLO so a later `sse_replay_hello` hands a re-attached
/// webview a FRESH handshake (a retained open stream does not re-push HELLO on its own). `HELLO` replaces
/// the cache wholesale; each incremental revision frame patches its matching field. Additive — the caller
/// still emits the frame to the live webview. Best-effort: a missing/malformed field is skipped (never
/// panics); incremental frames before the first HELLO are dropped (no partial cached handshake).
fn merge_cached_hello(
    cached: &Arc<Mutex<Option<serde_json::Value>>>,
    event: &str,
    data: &serde_json::Value,
) {
    let mut guard = match cached.lock() {
        Ok(g) => g,
        Err(_) => return, // poisoned — leave the cache; the next HELLO reseeds it
    };
    if event == "HELLO" {
        *guard = Some(data.clone());
        return;
    }
    // Incremental merges apply only once HELLO has seeded the cache.
    let Some(obj) = guard.as_mut().and_then(|v| v.as_object_mut()) else {
        return;
    };
    match event {
        "STATE_FEED_UPDATED" | "THREAD_FEED_UPDATED" => {
            let (input, output) = if event == "STATE_FEED_UPDATED" {
                ("feedId", "stateFeedEndId")
            } else {
                ("threadFeedEndId", "threadFeedEndId")
            };
            if let Some(inc) = data.get(input).and_then(|v| v.as_i64()) {
                let cur = obj.get(output).and_then(|v| v.as_i64());
                if cur.is_none_or(|c| inc >= c) {
                    obj.insert(output.to_string(), serde_json::Value::from(inc));
                }
            }
        }
        _ => {}
    }
}

#[cfg(all(test, desktop))]
#[path = "tests/cached_hello_merge_tests.rs"]
mod cached_hello_merge_tests;

#[derive(Default)]
struct StateFeedHead {
    user_id: Option<i64>,
    target: i64,
}

impl StateFeedHead {
    fn accept(&mut self, event: &str, data: &serde_json::Value) -> Option<(i64, i64)> {
        if event == "HELLO" {
            self.user_id = data
                .get("userId")
                .and_then(|value| value.as_i64())
                .filter(|id| *id > 0);
        } else if event != "STATE_FEED_UPDATED" {
            return None;
        }
        let key = if event == "HELLO" {
            "stateFeedEndId"
        } else {
            "feedId"
        };
        let target = data
            .get(key)
            .and_then(|value| value.as_i64())
            .filter(|id| *id >= 0)?;
        self.target = self.target.max(target);
        self.user_id.map(|user_id| (user_id, self.target))
    }
}

#[derive(Default)]
struct ThreadFeedHead {
    user_id: Option<i64>,
    target: i32,
}

impl ThreadFeedHead {
    fn accept(&mut self, event: &str, data: &serde_json::Value) -> Option<(i64, i32)> {
        if event != "HELLO" && event != "THREAD_FEED_UPDATED" {
            return None;
        }
        if event == "HELLO" {
            self.user_id = data
                .get("userId")
                .and_then(|value| value.as_i64())
                .filter(|id| *id > 0);
        }
        let target = data
            .get("threadFeedEndId")
            .and_then(|value| value.as_i64())
            .and_then(|value| i32::try_from(value).ok())
            .filter(|value| *value >= 0)?;
        self.target = self.target.max(target);
        self.user_id.map(|user_id| (user_id, self.target))
    }
}

/// Open + consume one SSE stream until it ends (clean close / error / stale / cancel / force-logout).
#[allow(clippy::too_many_arguments)]
async fn open_one_stream(
    app: &Arc<crate::realtime::Run>,
    proxy: &ServerSessionState,
    cancel: &CancellationToken,
    state: &Arc<Mutex<ConnectionState>>,
    wake: &Notify,
    offline: &AtomicBool,
    cached_hello: &Arc<Mutex<Option<serde_json::Value>>>,
    opened_once: &mut bool,
) -> StreamOutcome {
    // A selection made before this attempt already applies to its URL. Consume that stored wake
    // before reading the endpoint, so our own bootstrap race does not immediately close the new stream.
    let _ = proxy.origin_notify.notified().now_or_never();
    let Some(endpoint) = app.endpoint() else {
        return StreamOutcome::Cancelled;
    };
    let origin = endpoint.origin;
    let token = endpoint.credential;
    let client = endpoint.client;
    let feed_cancel = cancel.child_token();
    let _feed_guard = feed_cancel.clone().drop_guard();
    let (feed_wakes, mut feed_receiver) = tokio::sync::watch::channel::<Option<(i64, i32)>>(None);
    let receipt_cancel = cancel.child_token();
    let _receipt_guard = receipt_cancel.clone().drop_guard();
    let (receipt_wakes, mut receipt_receiver) =
        tokio::sync::watch::channel::<Option<(String, i32)>>(None);
    let receipt_url = format!("{}/api/v1/events/receipt", origin.trim_end_matches('/'));
    let receipt_token = token.clone();
    let receipt_client = client.clone();
    // This task is independent of the stream reader and the thread-feed projection. A fixed
    // window (not trailing debounce) coalesces continuous message wakes without delaying FCM.
    crate::realtime::spawn(app.clone(), async move {
        loop {
            tokio::select! {
                _ = receipt_cancel.cancelled() => break,
                changed = receipt_receiver.changed() => if changed.is_err() { break; },
            }
            let Some(mut latest) = receipt_receiver.borrow_and_update().clone() else {
                continue;
            };
            let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
            loop {
                tokio::select! {
                    _ = receipt_cancel.cancelled() => return,
                    changed = receipt_receiver.changed() => {
                        if changed.is_err() { return; }
                        if let Some(receipt) = receipt_receiver.borrow_and_update().clone() {
                            if receipt.0 != latest.0 || receipt.1 >= latest.1 {
                                latest = receipt;
                            }
                        }
                    },
                    _ = tokio::time::sleep_until(deadline) => break,
                }
            }
            let send = |receipt: &(String, i32)| {
                receipt_client
                    .post(&receipt_url)
                    .bearer_auth(&receipt_token)
                    .json(&serde_json::json!({
                        "sseUuid": &receipt.0,
                        "threadFeedEndId": receipt.1,
                    }))
                    .timeout(Duration::from_secs(2))
                    .send()
            };
            let success = tokio::select! {
                _ = receipt_cancel.cancelled() => return,
                success = async { receipt_accepted(send(&latest).await).await } => success,
            };
            if !success && !receipt_receiver.has_changed().unwrap_or(false) {
                tokio::select! {
                    _ = receipt_cancel.cancelled() => return,
                    changed = receipt_receiver.changed() => if changed.is_ok() { continue; } else { return; },
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {},
                }
                tokio::select! {
                    _ = receipt_cancel.cancelled() => return,
                    success = async { receipt_accepted(send(&latest).await).await } => {
                        if !success { warn!("SSE receipt retry was not acknowledged"); }
                    },
                }
            }
        }
    });
    let state_target_for_feed = Arc::new(AtomicI64::new(0));
    let feed_state_target = state_target_for_feed.clone();
    let feed_app = app.clone();
    let feed_proxy = proxy.clone();
    // The stream owns one coalescing consumer. Never wait for HTTP/database work in the SSE reader.
    crate::realtime::spawn(app.clone(), async move {
        loop {
            tokio::select! {
                _ = feed_cancel.cancelled() => break,
                changed = feed_receiver.changed() => if changed.is_err() { break; },
            }
            let Some((user_id, target)) = *feed_receiver.borrow_and_update() else {
                continue;
            };
            if !feed_app.authenticated() {
                break;
            }
            // Structural state-feed rows must exist before thread metadata and notification
            // projections use them. Both state wakes and this barrier share Rust's state lane.
            let intent = match crate::native_db::attention::NativeThreadFeedIntent::capture(
                feed_app.app(),
                &feed_proxy,
                user_id,
                target,
            ) {
                Ok(intent) => intent,
                Err(error) => {
                    warn!("thread feed wake unavailable: {error}");
                    continue;
                }
            };
            #[cfg(target_os = "android")]
            let feed_work = intent.database_work();
            let state_target = feed_state_target.load(Ordering::Acquire);
            let state_result = tokio::select! {
                _ = feed_cancel.cancelled() => break,
                result = intent.state_barrier(state_target) => result,
            };
            if let Err(error) = state_result {
                warn!("state feed barrier before thread feed failed: {error}");
                continue;
            }
            let result = tokio::select! {
                _ = feed_cancel.cancelled() => break,
                result = intent.synchronize() => result,
            };
            if !feed_app.authenticated() || feed_cancel.is_cancelled() {
                break;
            }
            match result {
                Ok(result) => {
                    #[cfg(target_os = "android")]
                    {
                        // Assembly shares the exact cache view captured before the structural barrier.
                        let batch = tokio::select! { biased;
                            _ = feed_cancel.cancelled() => break,
                            result = crate::native_db::notifications::from_result(feed_work, user_id, &result) => result,
                        };
                        if let Ok(batch) = batch {
                            feed_app.publish(crate::realtime::Output::Notifications(batch));
                        }
                    }
                    if let Some(error) = &result.error {
                        warn!("thread feed wake failed; next wake retries: {error}");
                    }
                }
                Err(error) => warn!("thread feed wake unavailable; next wake retries: {error}"),
            }
        }
    });
    let (state_wakes, mut state_receiver) = tokio::sync::watch::channel::<Option<(i64, i64)>>(None);
    let state_app = app.clone();
    let state_events = crate::realtime::NativeEvents::capture(app.app());
    let state_proxy = proxy.clone();
    let state_cancel = cancel.child_token();
    let _state_guard = state_cancel.clone().drop_guard();
    crate::realtime::spawn(app.clone(), async move {
        loop {
            tokio::select! {
                _ = state_cancel.cancelled() => break,
                changed = state_receiver.changed() => if changed.is_err() { break; },
            }
            let Some((user_id, target)) = *state_receiver.borrow_and_update() else {
                continue;
            };
            if !state_app.authenticated() {
                break;
            }
            let result = tokio::select! {
                _ = state_cancel.cancelled() => break,
                result = crate::native_db::state_feed_sync::synchronize(&state_proxy, user_id, target) => result,
            };
            if !state_app.authenticated() || state_cancel.is_cancelled() {
                break;
            }
            match result {
                Ok(cursor) => {
                    let _ = state_events.emit(
                        "soms-sse-event",
                        SseEventPayload {
                            event: "LOCAL_STATE_FEED_COMMITTED".into(),
                            status: 0,
                            message: "local state committed".into(),
                            data: serde_json::json!({ "userId": user_id, "cursor": cursor }),
                        },
                    );
                }
                Err(error) => warn!("state feed wake failed; next wake retries: {error}"),
            }
        }
    });
    let mut state_head = StateFeedHead::default();
    let mut feed_head = ThreadFeedHead::default();
    let url = format!("{}/api/v1/events", origin.trim_end_matches('/'));
    // Bound the connect/headers phase: a server that never responds must not hang startup.
    let request = tokio::time::timeout(
        SSE_CONNECT_TIMEOUT,
        client
            .get(&url)
            .header("accept", "text/event-stream")
            .header("authorization", format!("Bearer {}", token))
            .send(),
    );
    let response = tokio::select! { biased;
        _ = cancel.cancelled() => return StreamOutcome::Cancelled,
        outcome = async {
            loop {
                wake.notified().await;
                if let Some(outcome) = control_wake_outcome(offline, &app.force) { break outcome; }
            }
        } => return outcome,
        result = request => result,
    };
    if !app.authenticated() {
        return StreamOutcome::Cancelled;
    }
    let resp = match response {
        Ok(Ok(r)) => r,
        // Surface WHY the connect failed (DNS / TLS / refused / timeout) — without this the supervisor
        // retried silently and the webview console never learned the cause.
        Ok(Err(e)) => {
            warn!("sse connect to {url} failed: {e}");
            return StreamOutcome::Err;
        }
        Err(_) => {
            warn!("sse connect to {url} timed out");
            return StreamOutcome::Err;
        }
    };
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        warn!("sse connect to {url} got 401 — session revoked/expired, forcing logout");
        return StreamOutcome::ForceLogout(None); // session dead — no retry
    }
    if !resp.status().is_success() {
        warn!(
            "sse connect to {url} returned unexpected status {}",
            resp.status()
        );
        return StreamOutcome::Err;
    }

    // Headers received → open. Emit the backfill pulse BEFORE `open` on every open after the first (the
    // `openedOnce` rule, mirrors sse.worker.ts) so a reconnect drives the same downstream catch-up.
    if *opened_once {
        let _ = app.emit("soms-sse-reconnect", ());
    }
    *opened_once = true;
    emit_state(app, state, ConnectionState::Open);

    let mut buf: Vec<u8> = Vec::with_capacity(8192);
    let mut stream = resp.bytes_stream();
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return StreamOutcome::Cancelled,
            // Global routing observations may prompt a new probe, but this run can select only its
            // captured candidates. A changed configuration requires explicit lifecycle replacement.
            _ = proxy.origin_notify.notified() => return StreamOutcome::StreamClosed,
            _ = proxy.token_notify.notified() => {
                if !app.authenticated() { return StreamOutcome::Cancelled; }
            },
            _ = wake.notified() => {
                // Network transitioned or the user hit retry. Offline → drop the stream and reconnect
                // (the next attempt fails fast, backs off). Online while a healthy stream is open → no-op
                // (avoid churning a working connection); the loop re-enters the select.
                if let Some(outcome) = control_wake_outcome(offline, &app.force) {
                    return outcome;
                }
            }
            chunk = stream.next() => match chunk {
                None => return StreamOutcome::StreamClosed,    // server closed → reconnect
                Some(Err(_)) => return StreamOutcome::Err,     // network error → reconnect
                Some(Ok(bytes)) => {
                    buf.extend_from_slice(&bytes);
                    while let Some(content) = take_sse_frame(&mut buf) {
                        if !app.authenticated() { return StreamOutcome::Cancelled; }
                        if let Some(parsed) = parse_sse_frame(&content) {
                            // if/else-if (not `match parsed.event.as_str()`): the scrutinee of a match
                            // would borrow `parsed.event` for the whole match, blocking the move in the
                            // else branch. The `.as_str()` borrows in each condition end at the `)`.
                            if parsed.event.as_str() == "SSE_REPLACED" {
                                // A newer stream owns this device session. Do not reconnect
                                // automatically and evict it in a loop.
                                return StreamOutcome::Cancelled;
                            } else if parsed.event.as_str() == "FORCE_LOGOUT" {
                                let reason = parsed
                                    .data
                                    .get("message")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());
                                return StreamOutcome::ForceLogout(reason);
                            } else {
                                if parsed.event == "THREAD_FEED_UPDATED" {
                                    if let (Some(uuid), Some(head)) = (
                                        parsed.data.get("sseUuid").and_then(|v| v.as_str()),
                                        parsed.data.get("threadFeedEndId").and_then(|v| v.as_i64())
                                            .and_then(|value| i32::try_from(value).ok())
                                            .filter(|value| *value >= 0),
                                    ) {
                                        receipt_wakes.send_replace(Some((uuid.to_owned(), head)));
                                    }
                                }
                                // Cache/merge the frame into the cached HELLO (additive) BEFORE emitting it
                                // — the borrows (as_str / &data) end at the call's `)`, so the move into the
                                // payload below is unaffected (same scoping rule the FORCE_LOGOUT branch uses).
                                if parsed.event == "HELLO" {
                                    if let (Some(user), Some(session)) = (parsed.data["userId"].as_i64().and_then(|v| i32::try_from(v).ok()), parsed.data["sessionId"].as_i64()) {
                                        app.publish(crate::realtime::Output::Identity(user, session));
                                    }
                                    if let Some(call) = parsed.data.get("activeCall") {
                                        if call["state"].as_str() == Some("ringing") && call["isCaller"].as_bool() == Some(false) {
                                            // Establish the call immediately, before forwarding later SDP/ICE.
                                            // Optional presentation lookup must never gate call initialization.
                                            app.publish(crate::realtime::Output::IncomingCall(call.clone()));
                                        }
                                    }
                                }
                                merge_cached_hello(cached_hello, parsed.event.as_str(), &parsed.data);
                                if let Some(head) = state_head.accept(&parsed.event, &parsed.data) {
                                    state_target_for_feed.store(head.1, Ordering::Release);
                                    state_wakes.send_replace(Some(head));
                                }
                                if let Some(head) = feed_head.accept(&parsed.event, &parsed.data) {
                                    feed_wakes.send_replace(Some(head));
                                }
                                if parsed.event == "THREAD_FEED_UPDATED" || parsed.event == "STATE_FEED_UPDATED" { continue; }
                                if parsed.event == "PROFILE_AVAILABLE" {
                                    if let Some(user_id) = feed_head.user_id {
                                        let profile_app = app.clone();
                                        let profile_proxy = proxy.clone();
                                        let profile_data = parsed.data;
                                        let profile_cancel = cancel.child_token();
                                        crate::realtime::spawn(app.clone(), async move {
                                            let result = tokio::select! { biased;
                                                _ = profile_cancel.cancelled() => return,
                                                result = crate::native_db::attention::materialize_profile_event(
                                                &profile_proxy,
                                                user_id,
                                                &profile_data,
                                                ) => result,
                                            };
                                            if !profile_app.authenticated() || profile_cancel.is_cancelled() { return; }
                                            match result {
                                                Ok(()) => {
                                                    let _ = profile_app.emit(
                                                        "soms-sse-event",
                                                        SseEventPayload {
                                                            event: "PROFILE_AVAILABLE".into(),
                                                            status: 0,
                                                            message: "local profile committed".into(),
                                                            data: profile_data,
                                                        },
                                                    );
                                                }
                                                Err(error) => warn!("materialize profile event: {error}"),
                                            }
                                        });
                                        continue;
                                    }
                                }
                                let _ = app.emit(
                                    "soms-sse-event",
                                    SseEventPayload {
                                        event: parsed.event,
                                        status: 0,
                                        message: "new message".to_string(),
                                        data: parsed.data,
                                    },
                                );
                            }
                        }
                    }
                }
            },
        }
    }
}

/// Full-jitter delay in `[0, ceil)` ms. Subsec nanos of the wall clock is plenty of entropy for backoff
/// spread (the timing is not a secret) and avoids pulling in a `rand` dependency.
fn jitter(ceil: u64) -> u64 {
    if ceil == 0 {
        return 0;
    }
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    n % ceil
}

/// `(true, len)` if a logical SSE line-end (`\n`, `\r`, or `\r\n`) starts at `i`. Line-ends never appear
/// inside UTF-8 continuation bytes (they're 0x80–0xBF), so byte-wise frame scanning is unambiguous and
/// no streaming UTF-8 decoder is needed (unlike the JS worker's `TextDecoder({stream:true})`).
fn line_end_at(buf: &[u8], i: usize) -> (bool, usize) {
    if i >= buf.len() {
        return (false, 1);
    }
    match buf[i] {
        b'\n' => (true, 1),
        b'\r' => {
            if i + 1 < buf.len() && buf[i + 1] == b'\n' {
                (true, 2)
            } else {
                (true, 1)
            }
        }
        _ => (false, 1),
    }
}

/// If a complete frame (text terminated by a blank line — two adjacent logical line-ends) is buffered at
/// the front of `buf`, return its content and drain through the boundary. `None` when no full frame is
/// present yet (the caller waits for more bytes).
fn take_sse_frame(buf: &mut Vec<u8>) -> Option<Vec<u8>> {
    let n = buf.len();
    let mut i = 0;
    while i < n {
        let (is_end, len1) = line_end_at(buf, i);
        if is_end {
            let second = i + len1;
            let (is_end2, len2) = line_end_at(buf, second);
            if is_end2 {
                let boundary_end = second + len2;
                let content = buf[..i].to_vec();
                buf.drain(..boundary_end);
                return Some(content);
            }
        }
        i += len1;
    }
    None
}

/// Parse one frame's text into `{event, data}`. Implements the SSE wire slice the JS worker does: a line
/// starting with `:` is a comment; one leading space after the `field:` colon is stripped; multiple
/// `data:` lines join with `\n`; `id`/`retry`/unknown fields are dropped. A frame with no `event:` field
/// → `None` (dropped — e.g. the leading `: connected`). A non-empty `data:` payload that fails to parse
/// as JSON → `None` (drop the frame, keep the stream alive — NOT the worker's `JSON.parse`-throws-kills-
/// the-stream behavior).
fn parse_sse_frame(content: &[u8]) -> Option<ParsedFrame> {
    let text = std::str::from_utf8(content).ok()?;
    let mut event: Option<String> = None;
    let mut data_lines: Vec<String> = Vec::new();
    for line in text.split(|c: char| c == '\n' || c == '\r') {
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let (field, mut value) = match line.find(':') {
            Some(idx) => (&line[..idx], &line[idx + 1..]),
            None => (line, ""),
        };
        if value.starts_with(' ') {
            value = &value[1..];
        }
        match field {
            "event" => event = Some(value.to_string()),
            "data" => data_lines.push(value.to_string()),
            _ => {}
        }
    }
    let event = event?;
    let joined = data_lines.join("\n");
    let data = if joined.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_str::<serde_json::Value>(&joined).ok()?
    };
    Some(ParsedFrame { event, data })
}

// SSE parser unit tests (desktop-only — the parser fns are #[cfg(desktop)]). Pure byte/string logic,
// the trickiest new code in the supervisor: line-end forms, frame boundaries, multi-line data join,
// comment lines, malformed-JSON handling. Run with `cargo test` (the docker desktop build).
#[cfg(all(test, desktop))]
#[path = "tests/sse_parser_tests.rs"]
mod sse_parser_tests;
