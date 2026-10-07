use crate::*;

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

// --- IPC api_request (the webview→backend HTTP transport under Tauri) ---------------------

/// Why a bounded-headers send did not yield a `reqwest::Response`.
#[derive(Debug)]
pub(crate) enum HeadersError {
    /// The request could not be sent at all (DNS / connect / TLS / mid-send reset). A connect-level
    /// failure — the JS side maps this `Err` to `HttpErrorResponse(status: 0)` → "network".
    SendFailed(reqwest::Error),
    /// The server accepted the connection but sent no headers within the deadline — a gateway timeout.
    /// Kept distinct from `SendFailed` so the caller surfaces a real HTTP 504 (the JS side then reports
    /// "HTTP 504") instead of conflating a hung upstream with a connect-level failure.
    Timeout,
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
    match tokio::time::timeout(deadline, req.send()).await {
        Ok(Ok(r)) => Ok(r),
        Ok(Err(e)) => Err(HeadersError::SendFailed(e)),
        Err(_) => Err(HeadersError::Timeout),
    }
}

// --- native LAN-domain fallback: reachability probe + origin selection -------------------
//
// Origin selection has TWO modes, deliberately split:
//  - `pick_origin_race` — the CONCURRENT probe-both race. Used ONLY for initialization (login, before the
//    auth request — picks the origin to authenticate against) and for a full-disconnect RECONNECT (both
//    origins were down → the backoff retry races both to find the reachable one). "Pick from scratch."
//  - `maybe_switch` — the runtime smooth switch: probe the CURRENT active; if down, probe the OTHER
//    (sequential, single — NOT concurrent); flip if the other is reachable. Used on single-point failures
//    (a transport request / the SSE stream). Lighter than a full race; never races both at runtime.
//
// `GET /api/v1/client/compat` works PRE-LOGIN (no token), unlike SSE. No request re-send:
// the failed request surfaces to the caller and the SSE HELLO/reconcile restores
// state; these only fix which origin subsequent traffic uses.
//
// Authority: on DESKTOP Rust decides both (race + switch + `origin_notify` to its own SSE supervisor). On
// ANDROID Kotlin is authoritative (it owns the FGS, including background); Rust is PASSIVE — it never
// probes/switches, it just accepts the origin Kotlin signals via `set_active_origin` (JS-mediated). So the
// `maybe_switch`/`pick_origin_race` CALL SITES in the transports/SSE are desktop-only.

/// A `reqwest::Error` that means the origin is UNREACHABLE (connect / DNS / TLS / timeout) — a candidate
/// for `maybe_switch` / `pick_origin_race`. An HTTP status response (incl. 401) never reaches this: it
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

/// Apply a chosen origin + mode as the active one, notifying the desktop SSE supervisor to reopen on it
/// (API⇄SSE lockstep). No-op if it's already the active. Shared by `pick_origin_race` + `maybe_switch`.
pub(crate) fn activate_origin(state: &ServerSessionState, origin: &str, mode: OriginMode) {
    let prev = {
        let mut g = state.api_origin.lock().expect("origin lock");
        std::mem::replace(&mut *g, origin.to_string())
    };
    *state.origin_mode.lock().expect("mode lock") = mode;
    if prev.as_str() != origin {
        warn!("origin: {prev} → {origin} ({mode:?})");
        // Nudge the desktop SSE supervisor to cancel + reopen on the new active immediately. Race-free
        // (Notify holds one permit). Mobile SSE (Kotlin) follows via its own state + signals Rust instead.
        state.origin_notify.notify_one();
    }
}

/// The CONCURRENT race: probe BOTH origins and immediately adopt the first healthy one. Used for login
/// init + full-disconnect reconnect — NOT for runtime single-failure (that's `maybe_switch`). No-op when
/// no secondary is configured (dev / no SOMS_LAN_DOMAIN). Single-flight (one race at a time). Never adopts
/// a dead origin: if both fail, the active is left as-is.
pub(crate) async fn pick_origin_race(state: &ServerSessionState) -> Option<String> {
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
    let _guard = state.select_lock.lock().await;
    let chosen = {
        let primary_probe = probe_client_compat(&primary);
        let secondary_probe = probe_client_compat(&secondary);
        tokio::pin!(primary_probe, secondary_probe);

        // Resolve as soon as one endpoint is healthy. Leaving this scope immediately drops the losing
        // reqwest future, cancelling its in-flight request and releasing its connection resources.
        // If the first completed probe failed, wait only for the other already-running probe.
        // `biased` preserves primary preference when both are ready together.
        tokio::select! {
            biased;
            primary_ok = &mut primary_probe => {
                #[cfg(debug_assertions)]
                log::info!("origin race: primary={primary} healthy={primary_ok}");
                if primary_ok {
                    Some((primary.clone(), OriginMode::Primary))
                } else {
                    let secondary_ok = secondary_probe.await;
                    #[cfg(debug_assertions)]
                    log::info!("origin race: secondary={secondary} healthy={secondary_ok}");
                    secondary_ok.then(|| (secondary.clone(), OriginMode::Secondary))
                }
            }
            secondary_ok = &mut secondary_probe => {
                #[cfg(debug_assertions)]
                log::info!("origin race: secondary={secondary} healthy={secondary_ok}");
                if secondary_ok {
                    Some((secondary.clone(), OriginMode::Secondary))
                } else {
                    let primary_ok = primary_probe.await;
                    #[cfg(debug_assertions)]
                    log::info!("origin race: primary={primary} healthy={primary_ok}");
                    primary_ok.then(|| (primary.clone(), OriginMode::Primary))
                }
            }
        }
    };
    let Some((origin, mode)) = chosen else {
        warn!("pick_origin_race: both origins unreachable; staying on {active}");
        return None;
    };
    if origin != active {
        activate_origin(state, &origin, mode);
    } else {
        *state.origin_mode.lock().expect("mode lock") = mode;
        // A transport failure triggered this race. Even when the winning URL did not change, reset SSE:
        // its socket may be stale while the health endpoint has already recovered.
        state.origin_notify.notify_one();
        #[cfg(debug_assertions)]
        log::info!("origin race: selected={origin} mode={mode:?}");
    }
    Some(origin)
}

/// Desktop-only runtime switch (the transports + diagnostics call this on a network failure). On Android
/// Rust is PASSIVE — Kotlin owns the decision and signals via `set_active_origin` — so this is a no-op
/// there, avoiding a second, divergent decision-maker.
pub(crate) async fn runtime_switch(state: &ServerSessionState) {
    let _ = pick_origin_race(state).await;
}

/// The webview→backend HTTP transport under the Tauri shell. The frontend `TauriHttpBackend`
/// (web/.../tauri-http.backend.ts) invokes this instead of `fetch()`: Android's Chromium WebView rejects
/// non-standard schemes in `fetch()`, so the old `api://` custom-scheme proxy could not be fetched there;
/// routing through IPC also lets RUST own the session token (JS never touches it). Mirrors what the
/// former `proxy_api` did, but as an IPC command: build a reqwest request to `${api_origin}${path}`
/// (`path` already includes `/api/v1…` + query), forward a whitelist of JS headers (NEVER `authorization`
/// — Rust injects the Bearer from `ServerSessionState.token`), buffer the response, return status + headers +
/// UTF-8 body. Uses the cached `api_client` (one connection pool per origin). Message/API JSON replies
/// have a bounded body read as well as bounded headers; media downloads use a separate transport.
/// Redirects are never followed (same posture as `http_client_for`).
#[derive(serde::Serialize)]
pub(crate) struct ApiRequestResult {
    pub(crate) status: u16,
    pub(crate) headers: std::collections::HashMap<String, String>,
    pub(crate) body: String,
}

#[tauri::command]
pub(crate) async fn api_request(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ServerSessionState>,
    method: String,
    path: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<Vec<u8>>,
    replay_safe: bool,
) -> Result<ApiRequestResult, String> {
    perform_api_request(&app, &proxy, method, path, headers, body, replay_safe).await
}

pub(crate) async fn perform_api_request(
    app: &tauri::AppHandle,
    proxy: &ServerSessionState,
    method: String,
    path: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<Vec<u8>>,
    replay_safe: bool,
) -> Result<ApiRequestResult, String> {
    perform_api_request_with_events(Some(app), proxy, method, path, headers, body, replay_safe)
        .await
}

/// Background consumers use the same HTTP policy without a shell event sink.
pub(crate) async fn perform_api_request_with_events(
    app: Option<&tauri::AppHandle>,
    proxy: &ServerSessionState,
    method: String,
    path: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<Vec<u8>>,
    replay_safe: bool,
) -> Result<ApiRequestResult, String> {
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

        match send_with_headers_deadline(req, API_HEADERS_TIMEOUT).await {
            Ok(r) => break r,
            Err(failure) => {
                let is_reachability_failure = match &failure {
                    HeadersError::SendFailed(e) => is_network_failure(e),
                    HeadersError::Timeout => true,
                };
                if !is_reachability_failure {
                    let HeadersError::SendFailed(e) = failure else {
                        unreachable!()
                    };
                    return Err(format!("api_request send: {e}"));
                }

                // Every reachability failure immediately races the configured addresses. A winner becomes
                // the single active origin for subsequent HTTP and SSE. Only explicitly replay-safe
                // requests are issued again; unsafe writes still benefit from the switch but surface their
                // original ambiguous failure to the caller.
                let selected = pick_origin_race(&proxy).await;
                if let (Some(app), Some(origin)) = (app, selected.as_ref()) {
                    let _ = app.emit("active-origin-changed", origin);
                }
                if replay_safe && attempt == 0 && selected.is_some() {
                    attempt = 1;
                    warn!("api_request {target} failed; replaying on active origin");
                    continue;
                }

                return match failure {
                    HeadersError::SendFailed(e) => {
                        warn!("api_request {target} upstream send failed: {e}");
                        Err(format!("api_request send: {e}"))
                    }
                    HeadersError::Timeout => {
                        warn!("api_request {target} upstream headers timed out → 504");
                        Ok(ApiRequestResult {
                            status: 504,
                            headers: std::collections::HashMap::new(),
                            body: "Gateway Timeout".to_string(),
                        })
                    }
                };
            }
        }
    };
    let status = upstream.status().as_u16();
    let mut out_headers = std::collections::HashMap::new();
    for (name, value) in upstream.headers().iter() {
        // Drop hop-by-hop + content-encoding/length: reqwest already decompressed the body, and the JS
        // side derives length from the returned bytes. Multiple same-name headers collapse (last wins) —
        // acceptable for /api/v1 JSON responses (no repeated headers in practice).
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
    // A server can return headers then stall forever before completing a JSON reply. This deadline
    // bounds that gap independently of the header deadline. Uploads use their own progress-aware
    // transport; do not impose a total-duration deadline on a streaming upload here.
    let bytes = tokio::time::timeout(API_HEADERS_TIMEOUT, upstream.bytes())
        .await
        .map_err(|_| "api_request body timed out".to_string())?
        .map_err(|e| format!("api_request read: {e}"))?;
    Ok(ApiRequestResult {
        status,
        headers: out_headers,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

// --- IPC media_request (the webview→backend MEDIA transport under Tauri) ------------------

/// The webview→backend MEDIA transport under the Tauri shell. `assetUrl` rewrites `/uploads/*`
/// to `media://localhost/...` under Tauri. `media://` works for a bare `<img src>`
/// (the resource loader consults `shouldInterceptRequest` → the `proxy_media` scheme handler), but
/// Android's Chromium WebView rejects non-standard schemes in `fetch()`. `TauriHttpBackend` routes `media://`
/// requests to THIS command: a reqwest GET to `${api_origin}${path}` with the Bearer injected from
/// `ServerSessionState.token` (so JS still never touches the token), returning the raw bytes. Mirrors `proxy_media`
/// but as an IPC command returning bytes (not a scheme-handler `Response`); reuses the cached per-origin
/// `api_client` (the IP/http permissive-TLS posture + one warm connection pool), so uploads served from a
/// self-signed LAN IP server resolve the same way API calls do.
#[derive(serde::Serialize)]
pub(crate) struct MediaRequestResult {
    pub(crate) status: u16,
    pub(crate) content_type: Option<String>,
    pub(crate) body: Vec<u8>,
}

#[tauri::command]
pub(crate) async fn media_request(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ServerSessionState>,
    path: String,
) -> Result<MediaRequestResult, String> {
    // Only /uploads/* is ever proxied as media (parity with `proxy_media`'s gate); reject anything else so
    // the command can't be turned into an arbitrary-origin GET by a compromised renderer.
    if !path.starts_with("/uploads/") {
        return Err(format!(
            "media_request: only /uploads/* allowed (got {path})"
        ));
    }
    let mut attempt = 0u8;
    let upstream = loop {
        let api_origin = proxy.api_origin.lock().expect("origin lock").clone();
        let target = format!("{}{}", api_origin, path);
        let mut req = proxy.api_client(&api_origin).get(&target);
        if let Some(t) = proxy.token.lock().ok().and_then(|g| g.clone()) {
            req = req.header("authorization", format!("Bearer {}", t));
        }
        match send_with_headers_deadline(req, API_HEADERS_TIMEOUT).await {
            Ok(r) => break r,
            Err(failure) => {
                let switchable = match &failure {
                    HeadersError::SendFailed(e) => is_network_failure(e),
                    HeadersError::Timeout => true,
                };
                let selected = if switchable {
                    pick_origin_race(&proxy).await
                } else {
                    None
                };
                if let Some(origin) = selected.as_ref() {
                    let _ = app.emit("active-origin-changed", origin);
                }
                if attempt == 0 && selected.is_some() {
                    attempt = 1;
                    continue;
                }
                return match failure {
                    HeadersError::SendFailed(e) => Err(format!("media_request send: {e}")),
                    HeadersError::Timeout => Ok(MediaRequestResult {
                        status: 504,
                        content_type: None,
                        body: vec![],
                    }),
                };
            }
        }
    };
    let status = upstream.status().as_u16();
    let content_type = upstream
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let bytes = upstream
        .bytes()
        .await
        .map_err(|e| format!("media_request read: {e}"))?;
    Ok(MediaRequestResult {
        status,
        content_type,
        body: bytes.to_vec(),
    })
}
