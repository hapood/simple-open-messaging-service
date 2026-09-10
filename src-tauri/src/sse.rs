use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use log::warn;
use tauri::Emitter;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::{http_client_for, pick_origin_race, ProxyState, SSE_CONNECT_TIMEOUT};

// --- desktop SSE supervisor (Rust-owned /events stream) ------------------------------------
//
// Under the Tauri DESKTOP shell the realtime downlink is owned HERE in Rust — not by a JS Web Worker
// (the browser path) and not by Kotlin (the Android path). The webview's `WebsocketService` selects the
// `RustChannelSseTransport` (web/.../rust-channel-sse.transport.ts) for `isTauri() && !isAndroid`, which
// calls these commands and receives frames/state over Tauri events. This decouples the long-lived
// connection from the renderer: it survives a webview reclaim (the stream is tied to the AppHandle, not
// the window), it reads the Bearer directly from `ProxyState.token` (no JS token handshake), and it
// never touches `tauri-plugin-http`'s fragile `__TAURI_CHANNEL__` (the source of the "resource id is
// invalid" churn). Mobile is excluded (`#[cfg(desktop)]`) — Android's Kotlin RealtimeService owns SSE.

#[cfg(desktop)]
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum ConnectionState {
    Connecting,
    Open,
    Reconnecting,
    Closed,
}

#[cfg(desktop)]
#[derive(Clone, serde::Serialize)]
struct SseEventPayload {
    event: String,
    status: i64,             // always 0 (parity with the worker + native transports)
    message: String,         // always "new message" (parity)
    data: serde_json::Value, // Null when the frame carried no `data:`
}

#[cfg(desktop)]
#[derive(Clone, serde::Serialize)]
struct SseForceLogout {
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

/// One parsed SSE frame: the `event:` name + the joined `data:` lines as parsed JSON (Null when empty).
#[cfg(desktop)]
struct ParsedFrame {
    event: String,
    data: serde_json::Value,
}

/// Why one stream attempt ended → tells the supervisor loop whether to reconnect (back off + retry) or
/// stop (force-logout / cancelled).
#[cfg(desktop)]
enum StreamOutcome {
    StreamClosed,                // server ended the stream cleanly → reconnect
    Stale,                       // watchdog: no frame for 60s → reconnect
    Cancelled,                   // sse_stop / logout → exit the loop
    ForceLogout(Option<String>), // 401 or a `FORCE_LOGOUT` frame → exit (no retry, no 401-loop)
    Err,                         // network / non-2xx → reconnect
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
    cancel: Mutex<Option<CancellationToken>>,
    handle: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    state: Arc<Mutex<ConnectionState>>,
    wake: Arc<Notify>,
    offline: Arc<AtomicBool>,
    cached_hello: Arc<Mutex<Option<serde_json::Value>>>,
}

#[cfg(desktop)]
impl SseSupervisor {
    pub(crate) fn new() -> Self {
        Self {
            cancel: Mutex::new(None),
            handle: Mutex::new(None),
            state: Arc::new(Mutex::new(ConnectionState::Closed)),
            wake: Arc::new(Notify::new()),
            offline: Arc::new(AtomicBool::new(false)),
            cached_hello: Arc::new(Mutex::new(None)),
        }
    }
}

#[cfg(desktop)]
fn conn_state_str(s: ConnectionState) -> &'static str {
    match s {
        ConnectionState::Connecting => "connecting",
        ConnectionState::Open => "open",
        ConnectionState::Reconnecting => "reconnecting",
        ConnectionState::Closed => "closed",
    }
}

/// Mirror `s` into the synchronous state field (so `sse_get_state` reflects it) AND emit it to the
/// webview (`soms-sse-state`) so the connection banner updates on every transition.
#[cfg(desktop)]
fn emit_state(app: &tauri::AppHandle, state: &Arc<Mutex<ConnectionState>>, s: ConnectionState) {
    if let Ok(mut g) = state.lock() {
        *g = s;
    }
    let _ = app.emit("soms-sse-state", s);
}

/// Idempotently spawn the connect-loop (no-op if one is already running). The facade's origin-swap path
/// is stop→start, and a renderer-reclaim re-boot calls start again — a duplicate would open a second
/// stream. We rely on `sse_stop` clearing `handle` (the task only exits via cancel or force-logout, both
/// of which the facade follows with stop).
#[cfg(desktop)]
#[tauri::command]
pub(crate) fn sse_start(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ProxyState>,
    sse: tauri::State<'_, SseSupervisor>,
) -> Result<(), String> {
    if sse.handle.lock().expect("sse handle lock").is_some() {
        return Ok(());
    }
    let cancel = CancellationToken::new();
    *sse.cancel.lock().expect("sse cancel lock") = Some(cancel.clone());
    let handle = tauri::async_runtime::spawn(sse_supervisor_loop(
        app,
        proxy.inner().clone(),
        cancel,
        sse.state.clone(),
        sse.wake.clone(),
        sse.offline.clone(),
        sse.cached_hello.clone(),
    ));
    *sse.handle.lock().expect("sse handle lock") = Some(handle);
    Ok(())
}

/// Stop the supervisor: emit `closed` synchronously, wake any backoff sleep, cancel the task. Every await
/// in the loop selects against `cancel.cancelled()`, so cancel propagates promptly (the reqwest future is
/// dropped — cancel-safe in reqwest 0.12). The handle is detached (dropped, not awaited) so the IPC
/// returns at once; the task unwinds on its own.
#[cfg(desktop)]
#[tauri::command]
pub(crate) fn sse_stop(
    app: tauri::AppHandle,
    sse: tauri::State<'_, SseSupervisor>,
) -> Result<(), String> {
    emit_state(&app, &sse.state, ConnectionState::Closed);
    sse.wake.notify_one();
    if let Some(cancel) = sse.cancel.lock().expect("sse cancel lock").take() {
        cancel.cancel();
    }
    // take() + drop = detach (the task exits via cancel; we don't block the IPC on it).
    *sse.handle.lock().expect("sse handle lock") = None;
    Ok(())
}

/// Synchronous read of the current connection state — seeds a freshly-booted renderer the way Android's
/// `SomsFcm.getConnState()` does. Rust only pushes state on *transitions*, so without this a reclaimed
/// webview's banner would be stale until the next transition.
#[cfg(desktop)]
#[tauri::command]
pub(crate) fn sse_get_state(sse: tauri::State<'_, SseSupervisor>) -> String {
    conn_state_str(*sse.state.lock().expect("sse state lock")).to_string()
}

/// The webview's `navigator` online/offline is the one source that knows the network dropped before the
/// 60s watchdog would (dropped wifi → half-open TCP → reqwest blocks near-forever). The JS transport
/// forwards both transitions here (and reuses `online=true` for user-initiated retry). `wake` releases
/// the supervisor's current await — an open-stream read OR a backoff sleep — and the loop re-checks
/// `offline` to decide immediate-retry vs. drop-the-stream.
#[cfg(desktop)]
#[tauri::command]
pub(crate) fn sse_net(online: bool, sse: tauri::State<'_, SseSupervisor>) -> Result<(), String> {
    sse.offline.store(!online, Ordering::Release);
    sse.wake.notify_one();
    Ok(())
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
    app: tauri::AppHandle,
    sse: tauri::State<'_, SseSupervisor>,
) -> Result<(), String> {
    if let Some(data) = sse.cached_hello.lock().expect("cached_hello lock").clone() {
        let _ = app.emit(
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

#[cfg(desktop)]
async fn sse_supervisor_loop(
    app: tauri::AppHandle,
    proxy: ProxyState,
    cancel: CancellationToken,
    state: Arc<Mutex<ConnectionState>>,
    wake: Arc<Notify>,
    offline: Arc<AtomicBool>,
    cached_hello: Arc<Mutex<Option<serde_json::Value>>>,
) {
    // ---- pre-login token wait ----
    // `sse_start` is called eagerly at boot, before login. Block (no busy-loop, no 401-storm) until a
    // token arrives via `set_session_token` (which fires `token_notify`) or stop cancels.
    loop {
        if cancel.is_cancelled() {
            emit_state(&app, &state, ConnectionState::Closed);
            return;
        }
        if proxy.token.lock().expect("token lock").is_some() {
            break;
        }
        tokio::select! {
            _ = cancel.cancelled() => {
                emit_state(&app, &state, ConnectionState::Closed);
                return;
            }
            _ = proxy.token_notify.notified() => {}
        }
    }

    emit_state(&app, &state, ConnectionState::Connecting);

    let mut opened_once = false;
    let mut attempt: u32 = 0;
    loop {
        if cancel.is_cancelled() {
            break;
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
            StreamOutcome::StreamClosed | StreamOutcome::Stale | StreamOutcome::Err => {
                // On a connect/network error (Err), try a SMOOTH switch first: maybe_switch probes the
                // current; if it's healthy (transient) or the OTHER is reachable (flip), reopen at once with
                // no backoff. If both are down (BothDown) or there's no fallback, fall through to the
                // reconnecting backoff — whose retry races both (pick_origin_race below). StreamClosed /
                // Stale may be server-side (not network); they skip the smooth switch → straight to backoff.
                if matches!(outcome, StreamOutcome::Err) {
                    if pick_origin_race(&proxy).await.is_some() {
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
                pick_origin_race(&proxy).await;
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
#[cfg(desktop)]
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

#[cfg(desktop)]
#[derive(Default)]
struct ThreadFeedHead {
    user_id: Option<i64>,
    target: i32,
}

#[cfg(desktop)]
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
#[cfg(desktop)]
#[allow(clippy::too_many_arguments)]
async fn open_one_stream(
    app: &tauri::AppHandle,
    proxy: &ProxyState,
    cancel: &CancellationToken,
    state: &Arc<Mutex<ConnectionState>>,
    wake: &Notify,
    offline: &AtomicBool,
    cached_hello: &Arc<Mutex<Option<serde_json::Value>>>,
    opened_once: &mut bool,
) -> StreamOutcome {
    let origin = proxy.api_origin.lock().expect("origin lock").clone();
    let token = match proxy.token.lock().expect("token lock").clone() {
        Some(t) => t,
        None => return StreamOutcome::Cancelled, // logout raced past the outer gate
    };
    let feed_cancel = cancel.child_token();
    let _feed_guard = feed_cancel.clone().drop_guard();
    let (feed_wakes, mut feed_receiver) = tokio::sync::watch::channel::<Option<(i64, i32)>>(None);
    let feed_app = app.clone();
    let feed_proxy = proxy.clone();
    let feed_token = token.clone();
    // The stream owns one coalescing consumer. Never wait for HTTP/database work in the SSE reader.
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = feed_cancel.cancelled() => break,
                changed = feed_receiver.changed() => if changed.is_err() { break; },
            }
            let Some((user_id, target)) = *feed_receiver.borrow_and_update() else {
                continue;
            };
            if feed_proxy.token.lock().expect("token lock").as_ref() != Some(&feed_token) {
                break;
            }
            let result = tokio::select! {
                _ = feed_cancel.cancelled() => break,
                result = crate::native_db::attention::sync_thread_feed(Some(&feed_app), &feed_proxy, user_id, target, 1) => result,
            };
            if feed_proxy.token.lock().expect("token lock").as_ref() != Some(&feed_token) {
                break;
            }
            match result {
                Ok(result) => {
                    if let Some(error) = &result.error {
                        warn!("thread feed wake failed; next wake retries: {error}");
                    }
                    // Local completion, not a server SSE event. A renderer only reads committed DB changes.
                    let _ = feed_app.emit(
                        "soms-sse-event",
                        SseEventPayload {
                            event: "LOCAL_THREAD_FEED_COMMITTED".into(),
                            status: 0,
                            message: "local data committed".into(),
                            data: serde_json::json!({ "userId": user_id, "cursor": result.cursor }),
                        },
                    );
                }
                Err(error) => warn!("thread feed wake unavailable; next wake retries: {error}"),
            }
        }
    });
    let mut feed_head = ThreadFeedHead::default();
    let url = format!("{}/api/v1/events", origin.trim_end_matches('/'));
    // Bound the CONNECT/headers phase. The in-stream watchdog only arms after a `ping`, so without this
    // a server that accepts the connection but never sends headers would hang the connect forever.
    let resp = match tokio::time::timeout(
        SSE_CONNECT_TIMEOUT,
        http_client_for(&origin)
            .get(&url)
            .header("accept", "text/event-stream")
            .header("authorization", format!("Bearer {}", token))
            .send(),
    )
    .await
    {
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
    let mut watchdog = tokio::time::interval(Duration::from_millis(5_000));
    watchdog.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_frame_at = Instant::now();
    let mut ping_observed = false;

    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return StreamOutcome::Cancelled,
            // An API-side select_origin switched the active origin → drop this stream and reopen on the new
            // active (the loop re-enters open_one_stream, which re-reads proxy.api_origin). API⇄SSE lockstep:
            // they never sit on different origins. Race-free (Notify holds one stored permit).
            _ = proxy.origin_notify.notified() => return StreamOutcome::StreamClosed,
            _ = wake.notified() => {
                // Network transitioned or the user hit retry. Offline → drop the stream and reconnect
                // (the next attempt fails fast, backs off). Online while a healthy stream is open → no-op
                // (avoid churning a working connection); the loop re-enters the select.
                if offline.load(Ordering::Acquire) {
                    return StreamOutcome::StreamClosed;
                }
            }
            chunk = stream.next() => match chunk {
                None => return StreamOutcome::StreamClosed,    // server closed → reconnect
                Some(Err(_)) => return StreamOutcome::Err,     // network error → reconnect
                Some(Ok(bytes)) => {
                    last_frame_at = Instant::now();
                    buf.extend_from_slice(&bytes);
                    while let Some(content) = take_sse_frame(&mut buf) {
                        if let Some(parsed) = parse_sse_frame(&content) {
                            // if/else-if (not `match parsed.event.as_str()`): the scrutinee of a match
                            // would borrow `parsed.event` for the whole match, blocking the move in the
                            // else branch. The `.as_str()` borrows in each condition end at the `)`.
                            if parsed.event.as_str() == "ping" {
                                ping_observed = true;
                            } else if parsed.event.as_str() == "FORCE_LOGOUT" {
                                let reason = parsed
                                    .data
                                    .get("message")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());
                                return StreamOutcome::ForceLogout(reason);
                            } else {
                                // Cache/merge the frame into the cached HELLO (additive) BEFORE emitting it
                                // — the borrows (as_str / &data) end at the call's `)`, so the move into the
                                // payload below is unaffected (same scoping rule the FORCE_LOGOUT branch uses).
                                merge_cached_hello(cached_hello, parsed.event.as_str(), &parsed.data);
                                if let Some(head) = feed_head.accept(&parsed.event, &parsed.data) {
                                    feed_wakes.send_replace(Some(head));
                                }
                                if parsed.event == "THREAD_FEED_UPDATED" { continue; }
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
            _ = watchdog.tick() => {
                // Arm only after a real `ping` (not a `:` comment) to avoid false-triggers on a quiet
                // chat. 60s ≈ 2× the 25s server heartbeat.
                if ping_observed && last_frame_at.elapsed() > Duration::from_millis(60_000) {
                    return StreamOutcome::Stale;
                }
            }
        }
    }
}

/// Full-jitter delay in `[0, ceil)` ms. Subsec nanos of the wall clock is plenty of entropy for backoff
/// spread (the timing is not a secret) and avoids pulling in a `rand` dependency.
#[cfg(desktop)]
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
#[cfg(desktop)]
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
#[cfg(desktop)]
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
#[cfg(desktop)]
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
