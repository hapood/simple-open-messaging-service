use crate::*;
use futures_util::StreamExt;

pub(crate) async fn proxy_media(
    app: tauri::AppHandle,
    st: ServerSessionState,
    request: tauri::http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let path_and_query = match request.uri().path_and_query() {
        Some(pq) => pq.as_str().to_string(),
        None => "/".to_string(),
    };
    // First-frame thumbnails live inside the authenticated Rust media-cache namespace and therefore share
    // its quota, eviction, clear-cache and account isolation. The URL contains the canonical source path;
    // no digest-only global namespace can leak a prior account's frame.
    if let Some(source_path) = request.uri().path().strip_prefix("/video-thumbnails") {
        if !source_path.starts_with("/uploads/") {
            responder.respond(empty(StatusCode::NOT_FOUND));
            return;
        }
        match media_cache::get_video_thumbnail(&app, &st, source_path).await {
            Ok(bytes) => {
                responder.respond(
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "image/webp")
                        .header("content-length", bytes.len().to_string())
                        .header("cache-control", "no-store")
                        .header("x-content-type-options", "nosniff")
                        .body(Cow::Owned(bytes))
                        .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR)),
                );
            }
            Err(_) => responder.respond(empty(StatusCode::NOT_FOUND)),
        }
        return;
    }
    // Alternate chat-card path: the suffix is the canonical authenticated `/uploads/*` path. Rust
    // reuses the original cache/download, creates a bounded WebP once, and falls back to original bytes
    // for unsupported/corrupt image formats. The canonical `/uploads/*` branch below always stays original.
    if let Some(source_path) = request.uri().path().strip_prefix("/chat-thumbnails") {
        if !source_path.starts_with("/uploads/") {
            responder.respond(empty(StatusCode::NOT_FOUND));
            return;
        }
        if let Some(bytes) = media_cache::read_chat_thumbnail(&app, &st, source_path).await {
            responder.respond(
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "image/webp")
                    .header("content-length", bytes.len().to_string())
                    .header("cache-control", "no-store")
                    .header("x-content-type-options", "nosniff")
                    .body(Cow::Owned(bytes))
                    .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR)),
            );
            return;
        }
        match media_cache::get_or_fetch(&app, &st, source_path).await {
            Ok(media) => {
                // Do not put WebP encoding on the first-paint path. The original displays now; completion
                // emits chat-thumbnail-ready and the mounted card reloads this same alternate URL.
                media_cache::warm_chat_thumbnail(app.clone(), st.clone(), source_path.to_string());
                let mut builder = Response::builder()
                    .status(StatusCode::OK)
                    .header("content-length", media.bytes.len().to_string())
                    .header("cache-control", "no-store");
                if let Some(content_type) = media.content_type {
                    builder = builder.header("content-type", content_type);
                }
                responder.respond(
                    builder
                        .body(Cow::Owned(media.bytes))
                        .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR)),
                );
            }
            Err(error) => {
                warn!("chat thumbnail source failed for {source_path}: {error}");
                responder.respond(empty(StatusCode::BAD_GATEWAY));
            }
        }
        return;
    }
    // Cache-only variant used by oversized gallery-card icons. A miss must stay a 404: probing this
    // route is not permission to fetch the original bytes across the user's configured size gate.
    if let Some(source_path) = request.uri().path().strip_prefix("/cached-chat-thumbnails") {
        if !source_path.starts_with("/uploads/") {
            responder.respond(empty(StatusCode::NOT_FOUND));
            return;
        }
        if let Ok(bytes) = media_cache::get_cached_chat_thumbnail(&app, &st, source_path).await {
            responder.respond(
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "image/webp")
                    .header("content-length", bytes.len().to_string())
                    .header("cache-control", "no-store")
                    .header("x-content-type-options", "nosniff")
                    .body(Cow::Owned(bytes))
                    .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR)),
            );
        } else {
            responder.respond(empty(StatusCode::NOT_FOUND));
        }
        return;
    }
    if !path_and_query.starts_with("/uploads/") {
        responder.respond(empty(StatusCode::NOT_FOUND));
        return;
    }
    if let Some(range) = request
        .headers()
        .get("range")
        .and_then(|value| value.to_str().ok())
    {
        match media_cache::get_or_fetch_range(&app, &st, &path_and_query, range).await {
            Ok(media) => {
                let status = StatusCode::from_u16(media.status).unwrap_or(StatusCode::BAD_GATEWAY);
                let mut builder = Response::builder()
                    .status(status)
                    .header("content-length", media.bytes.len().to_string())
                    .header("cache-control", "no-store");
                if let Some(value) = media.content_type {
                    builder = builder.header("content-type", value);
                }
                if let Some(value) = media.content_range {
                    builder = builder.header("content-range", value);
                }
                if let Some(value) = media.accept_ranges {
                    builder = builder.header("accept-ranges", value);
                }
                responder.respond(
                    builder
                        .body(Cow::Owned(media.bytes))
                        .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR)),
                );
            }
            Err(error) => {
                warn!("media range cache failed for {path_and_query}: {error}");
                responder.respond(empty(StatusCode::BAD_GATEWAY));
            }
        }
        return;
    }
    // Every non-Range object shares the complete-file cache with Save. Tauri's URI responder requires
    // a complete body before responding anyway, so caching an unusual non-Range video request adds no
    // first-frame delay versus passthrough and prevents a later duplicate download.
    match media_cache::get_or_fetch(&app, &st, &path_and_query).await {
        Ok(media) => {
            let should_warm_thumbnail = media
                .content_type
                .as_deref()
                .is_some_and(|value| value.starts_with("image/"));
            if should_warm_thumbnail {
                media_cache::warm_chat_thumbnail(app.clone(), st.clone(), path_and_query.clone());
            }
            let mut builder = Response::builder()
                .status(StatusCode::OK)
                .header("content-length", media.bytes.len().to_string())
                // Rust owns the authoritative complete/sparse cache. Never keep an opaque second copy
                // in Chromium; Range responses above carry the same directive.
                .header("cache-control", "no-store");
            if let Some(content_type) = media.content_type {
                builder = builder.header("content-type", content_type);
            }
            responder.respond(
                builder
                    .body(Cow::Owned(media.bytes))
                    .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR)),
            );
        }
        Err(e) => {
            warn!("media cache fetch failed for {path_and_query}: {e}");
            responder.respond(empty(StatusCode::BAD_GATEWAY));
        }
    }
}

fn empty(status: StatusCode) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .body(Cow::Owned(Vec::new()))
        .unwrap()
}

// --- IPC http_request (the webview→backend HTTP transport under Tauri) ---------------------

/// Read an upstream body stream into memory, enforcing an inactivity timeout between successive chunks.
/// If no chunk arrives within `inactivity_timeout`, the read aborts and drops the stream.
pub(crate) async fn read_body_with_inactivity_timeout<B>(
    mut stream: impl futures_util::Stream<Item = Result<B, reqwest::Error>> + Unpin,
    inactivity_timeout: Duration,
    cancel: Option<&CancellationToken>,
) -> Result<Vec<u8>, String>
where
    B: AsRef<[u8]>,
{
    let mut out = Vec::new();
    loop {
        let chunk_step = tokio::time::timeout(inactivity_timeout, stream.next());
        let chunk_result = if let Some(cancel) = cancel {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err("http_request cancelled".to_string()),
                res = chunk_step => res,
            }
        } else {
            chunk_step.await
        };
        match chunk_result {
            Ok(Some(Ok(chunk))) => {
                out.extend_from_slice(chunk.as_ref());
            }
            Ok(Some(Err(e))) => {
                return Err(format!("http_request read: {e}"));
            }
            Ok(None) => break,
            Err(_) => {
                return Err("http_request body inactivity timeout".to_string());
            }
        }
    }
    Ok(out)
}

/// Why a bounded-headers send did not yield a `reqwest::Response`.
#[derive(Debug)]
pub(crate) enum HeadersError {
    SendFailed(reqwest::Error),
    Timeout,
    Cancelled,
}

/// Send `req`, bounding only the HEADERS phase (connect + send + server processing) to `deadline`. The
/// response BODY read is the caller's concern and is deliberately UNbounded — a slow/large download or
/// upload is legitimate and must not be aborted (a total-duration timeout would wrongly kill it; see
/// `BACKEND_CONNECT_TIMEOUT`'s comment). Extracted from the `tokio::time::timeout` block `api_request`
/// and `media_request` previously inlined, so the deadline + its 504 outcome are unit-testable.
pub(crate) async fn send_with_headers_deadline(
    req: reqwest::RequestBuilder,
    deadline: Duration,
) -> Result<reqwest::Response, HeadersError> {
    send_with_headers_deadline_and_cancel(req, deadline, None).await
}

pub(crate) async fn send_with_headers_deadline_and_cancel(
    req: reqwest::RequestBuilder,
    deadline: Duration,
    cancel: Option<&CancellationToken>,
) -> Result<reqwest::Response, HeadersError> {
    let send_fut = tokio::time::timeout(deadline, req.send());
    if let Some(cancel) = cancel {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(HeadersError::Cancelled),
            res = send_fut => match res {
                Ok(Ok(r)) => Ok(r),
                Ok(Err(e)) => Err(HeadersError::SendFailed(e)),
                Err(_) => Err(HeadersError::Timeout),
            },
        }
    } else {
        match send_fut.await {
            Ok(Ok(r)) => Ok(r),
            Ok(Err(e)) => Err(HeadersError::SendFailed(e)),
            Err(_) => Err(HeadersError::Timeout),
        }
    }
}

// --- native LAN-domain fallback: reachability probe + origin selection -------------------
//
// Initialization and network-failure recovery use the concurrent probe-both race. When a secondary
// is configured, the first healthy endpoint wins; if both fail, the current selection is retained.
//
// `GET /api/v1/client/compat` works PRE-LOGIN (no token), unlike SSE. No request re-send:
// the failed request surfaces to the caller and the SSE HELLO/reconcile restores
// state; these only fix which origin subsequent traffic uses.
//
// Rust is the origin authority on every native host. OS adapters mirror its selection and report
// connectivity facts; API and SSE transports share this same state and origin notification.

/// A `reqwest::Error` that means the origin is UNREACHABLE (connect / DNS / TLS / timeout) — a candidate
/// for `pick_origin_race`. An HTTP status response (incl. 401) never reaches this: it
/// means the server IS reachable, so no switch. Extracted pure so the boundary is unit-testable.
pub(crate) fn is_network_failure(e: &reqwest::Error) -> bool {
    e.is_connect() || e.is_timeout()
}

/// Short-timeout unauthenticated client bootstrap probe. Verify the SOMS response envelope,
/// not just HTTP 200: a reverse proxy welcome page must not win the origin race.
pub(crate) fn is_compat_probe_body(body: &serde_json::Value) -> bool {
    body.get("code").and_then(|v| v.as_i64()) == Some(0)
        && body
            .pointer("/data/apiVersion")
            .and_then(|v| v.as_u64())
            .is_some()
}

async fn probe_client_compat(origin: &str) -> bool {
    let url = format!("{}/api/v1/client/compat", origin.trim_end_matches('/'));
    let client = http_client_for(origin);
    matches!(
        tokio::time::timeout(ORIGIN_PROBE_TIMEOUT, async {
            let response = client.get(&url).send().await?;
            if !response.status().is_success() {
                return Ok(false);
            }
            let body: serde_json::Value = response.json().await?;
            Ok::<bool, reqwest::Error>(is_compat_probe_body(&body))
        })
        .await,
        Ok(Ok(true))
    )
}

/// Apply a chosen origin + mode, notifying the shared SSE supervisor when the endpoint changes
/// (API/SSE lockstep). An unchanged endpoint does not schedule a reconnect.
pub(crate) fn activate_origin(state: &ServerSessionState, origin: &str, mode: OriginMode) {
    let prev = {
        let mut g = state.api_origin.lock().expect("origin lock");
        std::mem::replace(&mut *g, origin.to_string())
    };
    *state.origin_mode.lock().expect("mode lock") = mode;
    if prev.as_str() != origin {
        warn!("origin: {prev} → {origin} ({mode:?})");
        // Nudge the shared SSE supervisor to reopen on the changed endpoint. Notify holds one permit.
        state.origin_notify.notify_one();
    }
}

/// The CONCURRENT race: probe BOTH origins and immediately adopt the first healthy one. Used for login
/// initialization and network-failure recovery. No-op when
/// no secondary is configured (dev / no SOMS_LAN_DOMAIN). Single-flight (one race at a time). Never adopts
/// a dead origin: if both fail, the active is left as-is.
pub(crate) async fn pick_origin_race(state: &ServerSessionState) -> Option<String> {
    pick_origin_race_with_commit(state, |origin, mode| {
        activate_origin(state, origin, mode);
        true
    })
    .await
}

/// Probe captured endpoints without reading or publishing global routing state. Dropping the
/// future cancels both probes; primary wins when both become healthy in the same poll.
pub(crate) async fn race_origin_candidates(
    primary: &str,
    secondary: &str,
) -> Option<(String, OriginMode)> {
    let primary_probe = probe_client_compat(primary);
    let secondary_probe = probe_client_compat(secondary);
    tokio::pin!(primary_probe, secondary_probe);
    tokio::select! {
        biased;
        primary_ok = &mut primary_probe => {
            if primary_ok {
                Some((primary.to_string(), OriginMode::Primary))
            } else {
                secondary_probe.await.then(|| (secondary.to_string(), OriginMode::Secondary))
            }
        }
        secondary_ok = &mut secondary_probe => {
            if secondary_ok {
                Some((secondary.to_string(), OriginMode::Secondary))
            } else {
                primary_probe.await.then(|| (primary.to_string(), OriginMode::Primary))
            }
        }
    }
}

/// Probe without holding a lifecycle lock; the caller admits the synchronous selection commit.
pub(crate) async fn pick_origin_race_with_commit(
    state: &ServerSessionState,
    commit: impl FnOnce(&str, OriginMode) -> bool,
) -> Option<String> {
    let _guard = state.select_lock.lock().await;
    let Some(secondary) = state
        .api_origin_secondary
        .lock()
        .expect("secondary lock")
        .clone()
    else {
        #[cfg(debug_assertions)]
        log::info!("origin race: no secondary configured; keeping primary");
        return None; // no fallback configured → no-op
    };
    let active = state.api_origin.lock().expect("origin lock").clone();
    let primary = state
        .api_origin_primary
        .lock()
        .expect("primary lock")
        .clone();
    #[cfg(debug_assertions)]
    log::info!("origin race: start active={active} primary={primary} secondary={secondary}");

    // Single-flight the race. Do not serially "cheap-check" the current address first: when it is down,
    // every such check burns a full timeout before the reachable fallback is even considered.
    let chosen = race_origin_candidates(&primary, &secondary).await;
    let Some((origin, mode)) = chosen else {
        warn!("pick_origin_race: both origins unreachable; staying on {active}");
        return None;
    };
    commit(&origin, mode).then_some(origin)
}

/// Shared Rust runtime origin switch; Android's OS adapter does not select endpoints.
pub(crate) async fn runtime_switch(state: &ServerSessionState) {
    let _ = pick_origin_race(state).await;
}

/// Validate allowed path prefixes for the unified http transport.
pub(crate) fn is_allowed_http_path(path: &str) -> bool {
    path.starts_with("/api/v1/") || path == "/api/v1" || path.starts_with("/uploads/")
}

/// The webview→backend HTTP transport under the Tauri shell. Replaces the former `api_request` and
/// `media_request` commands with a single unified transport.
///
/// Paths are restricted to `/api/v1/*` and `/uploads/*`.
/// Authorization Bearer is injected by Rust from `ServerSessionState.token` (JS never handles it).
/// Headers send is bounded by `API_HEADERS_TIMEOUT`.
/// Body stream consumption is bounded by `API_BODY_INACTIVITY_TIMEOUT` between chunks.
#[derive(serde::Serialize)]
pub(crate) struct HttpResponseResult {
    pub(crate) status: u16,
    pub(crate) headers: std::collections::HashMap<String, String>,
    pub(crate) text: Option<String>,
    pub(crate) bytes: Option<Vec<u8>>,
}

#[tauri::command]
pub(crate) async fn http_request(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ServerSessionState>,
    req_id: Option<String>,
    method: String,
    path: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<Vec<u8>>,
    binary: bool,
    replay_safe: bool,
) -> Result<HttpResponseResult, String> {
    if !is_allowed_http_path(&path) {
        return Err(format!(
            "http_request: only /api/v1/* and /uploads/* allowed (got {path})"
        ));
    }
    let cancel = CancellationToken::new();
    if let Some(id) = &req_id {
        let mut map = proxy.http_cancels.lock().expect("http_cancels lock");
        map.insert(id.clone(), cancel.clone());
    }
    let result = perform_http_request_with_events(
        Some(&app),
        &proxy,
        method,
        path,
        headers,
        body,
        binary,
        replay_safe,
        Some(&cancel),
    )
    .await;
    if let Some(id) = &req_id {
        let mut map = proxy.http_cancels.lock().expect("http_cancels lock");
        map.remove(id);
    }
    result
}

#[tauri::command]
pub(crate) fn cancel_http_request(
    proxy: tauri::State<'_, ServerSessionState>,
    req_id: String,
) -> bool {
    let mut map = proxy.http_cancels.lock().expect("http_cancels lock");
    if let Some(token) = map.remove(&req_id) {
        token.cancel();
        true
    } else {
        false
    }
}

pub(crate) async fn perform_http_request_with_events(
    app: Option<&tauri::AppHandle>,
    proxy: &ServerSessionState,
    method: String,
    path: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<Vec<u8>>,
    binary: bool,
    replay_safe: bool,
    cancel: Option<&CancellationToken>,
) -> Result<HttpResponseResult, String> {
    let method = reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET);
    let mut attempt = 0u8;
    let upstream = loop {
        let api_origin = proxy.api_origin.lock().expect("origin lock").clone();
        let target = format!("{}{}", api_origin, path);
        let client = proxy.api_client(&api_origin);
        let mut req = client.request(method.clone(), &target);
        if let Some(t) = proxy.token.lock().ok().and_then(|g| g.clone()) {
            req = req.header("authorization", format!("Bearer {}", t));
        }
        for name in [
            "content-type",
            "accept",
            "accept-language",
            "range",
            "x-request-id",
            "x-client-message-id",
        ] {
            if let Some(v) = headers.get(name) {
                req = req.header(name, v);
            }
        }
        if let Some(b) = body.clone() {
            req = req.body(b);
        }

        match send_with_headers_deadline_and_cancel(req, API_HEADERS_TIMEOUT, cancel).await {
            Ok(r) => break r,
            Err(HeadersError::Cancelled) => {
                return Err("http_request cancelled".to_string());
            }
            Err(failure) => {
                let is_reachability_failure = match &failure {
                    HeadersError::SendFailed(e) => is_network_failure(e),
                    HeadersError::Timeout => true,
                    HeadersError::Cancelled => false,
                };
                if !is_reachability_failure {
                    let HeadersError::SendFailed(e) = failure else {
                        unreachable!()
                    };
                    return Err(format!("http_request send: {e}"));
                }

                let selected = pick_origin_race(proxy).await;
                if let (Some(app), Some(origin)) = (app, selected.as_ref()) {
                    let _ = app.emit("active-origin-changed", origin);
                }
                if replay_safe && attempt == 0 && selected.is_some() {
                    attempt = 1;
                    warn!("http_request {target} failed; replaying on active origin");
                    continue;
                }

                return match failure {
                    HeadersError::SendFailed(e) => {
                        warn!("http_request {target} upstream send failed: {e}");
                        Err(format!("http_request send: {e}"))
                    }
                    HeadersError::Timeout => {
                        warn!("http_request {target} upstream headers timed out → 504");
                        Ok(HttpResponseResult {
                            status: 504,
                            headers: std::collections::HashMap::new(),
                            text: if !binary {
                                Some("Gateway Timeout".to_string())
                            } else {
                                None
                            },
                            bytes: if binary { Some(Vec::new()) } else { None },
                        })
                    }
                    HeadersError::Cancelled => unreachable!(),
                };
            }
        }
    };
    let status = upstream.status().as_u16();
    let mut out_headers = std::collections::HashMap::new();
    for (name, value) in upstream.headers().iter() {
        if matches!(
            name.as_str(),
            "transfer-encoding"
                | "connection"
                | "keep-alive"
                | "content-encoding"
                | "content-length"
        ) {
            continue;
        }
        if let Ok(vs) = value.to_str() {
            out_headers.insert(name.as_str().to_string(), vs.to_string());
        }
    }
    let raw_bytes = read_body_with_inactivity_timeout(
        upstream.bytes_stream(),
        API_BODY_INACTIVITY_TIMEOUT,
        cancel,
    )
    .await?;

    if binary {
        Ok(HttpResponseResult {
            status,
            headers: out_headers,
            text: None,
            bytes: Some(raw_bytes),
        })
    } else {
        Ok(HttpResponseResult {
            status,
            headers: out_headers,
            text: Some(String::from_utf8_lossy(&raw_bytes).into_owned()),
            bytes: None,
        })
    }
}

#[cfg(test)]
mod realtime_origin_tests {
    use super::*;
    use futures_util::FutureExt;

    #[tokio::test]
    async fn only_changed_endpoints_schedule_a_stream_wake() {
        let state = ServerSessionState::new();
        let primary = state.api_origin.lock().unwrap().clone();
        activate_origin(&state, &primary, OriginMode::Primary);
        assert!(state.origin_notify.notified().now_or_never().is_none());
        let secondary = "http://127.0.0.1:39999";
        activate_origin(&state, secondary, OriginMode::Secondary);
        assert!(state.origin_notify.notified().now_or_never().is_some());
        activate_origin(&state, secondary, OriginMode::Secondary);
        assert!(state.origin_notify.notified().now_or_never().is_none());
    }
}
