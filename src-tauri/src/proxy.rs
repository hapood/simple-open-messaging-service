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
    if path_and_query.starts_with("/uploads/thumbnails/") {
        match media_cache::fetch_thumbnail(&app, &st, &path_and_query).await {
            Ok(bytes) => responder.respond(
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "image/webp")
                    .header("cache-control", "no-store")
                    .body(Cow::Owned(bytes))
                    .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR)),
            ),
            Err(error) => {
                warn!("thumbnail request failed: {error}");
                responder.respond(empty(StatusCode::NOT_FOUND));
            }
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
    await_headers_with_deadline(req.send(), deadline, cancel).await
}

pub(crate) async fn await_headers_with_deadline<T>(
    send: impl std::future::Future<Output = Result<T, reqwest::Error>>,
    deadline: Duration,
    cancel: Option<&CancellationToken>,
) -> Result<T, HeadersError> {
    let send_fut = tokio::time::timeout(deadline, send);
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
#[cfg(test)]
pub(crate) fn activate_origin(state: &ServerSessionState, origin: &str, mode: OriginMode) {
    let previous = state.routes.snapshot();
    if state.routes.select(&previous, origin, mode) == Some(true) {
        warn!("origin: {} → {origin} ({mode:?})", previous.active);
        // Nudge the shared SSE supervisor to reopen on the changed endpoint. Notify holds one permit.
        state.origin_notify.notify_one();
    }
}

/// The CONCURRENT race: probe BOTH origins and immediately adopt the first healthy one. Used for login
/// initialization and network-failure recovery. No-op when
/// no secondary is configured (dev / no SOMS_LAN_DOMAIN). Single-flight (one race at a time). Never adopts
/// a dead origin: if both fail, the active is left as-is.
pub(crate) async fn pick_origin_race(state: &ServerSessionState) -> Option<String> {
    let _guard = state.select_lock.lock().await;
    let routes = state.routes.snapshot();
    let secondary = routes.secondary.as_deref()?;
    let (origin, mode) = race_origin_candidates(&routes.primary, secondary).await?;
    let changed = state.routes.select(&routes, &origin, mode)?;
    if changed {
        warn!("origin: {} → {origin} ({mode:?})", routes.active);
        state.origin_notify.notify_one();
    }
    Some(origin)
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
/// Authorization Bearer is injected by Rust from the active login owner (JS never handles it).
/// Headers send is bounded by `API_HEADERS_TIMEOUT`.
/// Body stream consumption is bounded by `API_BODY_INACTIVITY_TIMEOUT` between chunks.
#[derive(serde::Serialize)]
pub(crate) struct HttpResponseResult {
    pub(crate) status: u16,
    pub(crate) headers: std::collections::HashMap<String, String>,
    pub(crate) text: Option<String>,
    pub(crate) bytes: Option<Vec<u8>>,
}

/// One caller's cancellation registration. The guard removes its entry even
/// when its future is dropped. Cancelling keeps the entry reserved until this
/// guard exits, so a late cleanup cannot remove a replacement with the same ID.
pub(crate) struct RequestCancellation {
    token: CancellationToken,
    request_id: Option<String>,
    registry:
        std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, CancellationToken>>>,
}
impl RequestCancellation {
    pub(crate) fn register(
        proxy: &ServerSessionState,
        request_id: Option<String>,
    ) -> Result<Self, String> {
        let token = CancellationToken::new();
        if let Some(id) = &request_id {
            let mut registry = proxy
                .http_cancels
                .lock()
                .map_err(|_| "http cancellation registry poisoned")?;
            if registry.contains_key(id) {
                return Err("duplicate request cancellation ID".into());
            }
            registry.insert(id.clone(), token.clone());
        }
        Ok(Self {
            token,
            request_id,
            registry: proxy.http_cancels.clone(),
        })
    }
    pub(crate) fn token(&self) -> &CancellationToken {
        &self.token
    }
}
impl Drop for RequestCancellation {
    fn drop(&mut self) {
        if let Some(id) = &self.request_id {
            if let Ok(mut registry) = self.registry.lock() {
                registry.remove(id);
            }
        }
    }
}

type PreparedRequests = std::collections::HashMap<(usize, String), (std::time::Instant, CancellationToken)>;
static PREPARED_REQUESTS: std::sync::OnceLock<std::sync::Mutex<PreparedRequests>> = std::sync::OnceLock::new();

fn prepared_requests() -> &'static std::sync::Mutex<PreparedRequests> {
    PREPARED_REQUESTS.get_or_init(Default::default)
}

fn preparation_key(proxy: &ServerSessionState, id: &str) -> (usize, String) {
    (std::sync::Arc::as_ptr(&proxy.http_cancels) as usize, id.to_string())
}

/// Two-phase IPC admission: the renderer waits for this acknowledgement before it can
/// dispatch or cancel. Expired reservations fail closed, never become fresh requests.
fn prepare_request(proxy: &ServerSessionState, id: &str) -> Result<(), String> {
    let mut prepared = prepared_requests().lock().map_err(|_| "request preparation poisoned")?;
    prepared.retain(|_, (created, _)| created.elapsed() < Duration::from_secs(60));
    let key = preparation_key(proxy, id);
    if prepared.contains_key(&key) || proxy.http_cancels.lock().map_err(|_| "http cancellation registry poisoned")?.contains_key(id) {
        return Err("duplicate request cancellation ID".into());
    }
    if prepared.len() >= 1024 { return Err("too many prepared HTTP requests".into()); }
    prepared.insert(key, (std::time::Instant::now(), CancellationToken::new()));
    Ok(())
}

fn claim_prepared_request(proxy: &ServerSessionState, id: String) -> Result<RequestCancellation, String> {
    let mut prepared = prepared_requests().lock().map_err(|_| "request preparation poisoned")?;
    let (created, token) = prepared.remove(&preparation_key(proxy, &id)).ok_or("HTTP request preparation missing or expired")?;
    if created.elapsed() >= Duration::from_secs(60) { return Err("HTTP request preparation expired".into()); }
    let mut registry = proxy.http_cancels.lock().map_err(|_| "http cancellation registry poisoned")?;
    if registry.contains_key(&id) { return Err("duplicate request cancellation ID".into()); }
    registry.insert(id.clone(), token.clone());
    Ok(RequestCancellation { token, request_id: Some(id), registry: proxy.http_cancels.clone() })
}

pub(crate) fn cancel_registered_request(proxy: &ServerSessionState, request_id: &str) -> bool {
    // Keep the preparation lock until checking the active map, so claim cannot move
    // a token between the two registries while cancellation is searching for it.
    let Ok(prepared) = prepared_requests().lock() else { return false; };
    if let Some((_, token)) = prepared.get(&preparation_key(proxy, request_id)) {
        let was_active = !token.is_cancelled();
        token.cancel();
        return was_active;
    }
    let Ok(registry) = proxy.http_cancels.lock() else {
        return false;
    };
    if let Some(token) = registry.get(request_id) {
        if !token.is_cancelled() {
            token.cancel();
            return true;
        }
    }
    false
}

/// Transport lifetime only; server authorization still validates the captured credential.
#[derive(Clone, Copy, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RequestScope {
    #[default]
    Session,
    Authentication,
    Server,
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
    scope: Option<RequestScope>,
    short_request: Option<bool>,
    prepare_only: Option<bool>,
    prepared: Option<bool>,
) -> Result<HttpResponseResult, String> {
    if !is_allowed_http_path(&path) {
        return Err(format!(
            "http_request: only /api/v1/* and /uploads/* allowed (got {path})"
        ));
    }
    if prepare_only.unwrap_or(false) {
        prepare_request(&proxy, req_id.as_deref().ok_or("preparation requires a request ID")?)?;
        return Ok(HttpResponseResult { status: 204, headers: Default::default(), text: None, bytes: None });
    }
    let cancellation = if prepared.unwrap_or(false) {
        claim_prepared_request(&proxy, req_id.ok_or("prepared request requires an ID")?)?
    } else {
        RequestCancellation::register(&proxy, req_id)?
    };
    let owner = match scope.unwrap_or_default() {
        RequestScope::Session => Some(crate::native_db::active_login()?),
        RequestScope::Authentication | RequestScope::Server => None,
    };
    perform_scheduled_http_request(Some(&app), &proxy, method, path, headers, body, binary,
        replay_safe, cancellation.token(), owner, short_request.unwrap_or(false)).await
}

async fn perform_scheduled_http_request(
    app: Option<&tauri::AppHandle>,
    proxy: &ServerSessionState,
    method: String,
    path: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<Vec<u8>>,
    binary: bool,
    replay_safe: bool,
    cancel: &CancellationToken,
    owner: Option<std::sync::Arc<crate::login_connection::LoginConnection>>,
    short_request: bool,
) -> Result<HttpResponseResult, String> {
    let intent = owner.as_ref().map(|owner| {
        crate::login_request::LoginRequest::capture(&proxy, owner.clone())
    }).transpose()?;
    let owner_cancel = owner.as_ref().map(|owner| owner.cancellation()).unwrap_or_default();
    // Capture all credentials before admission. Independent auth/server requests never borrow
    // business authority; logout uses its own previously captured revocation operation.
    let credential = if let Some(intent) = &intent {
        Some(intent.endpoint()?.credential)
    } else {
        // Authentication and server metadata are public routes, not a way to borrow
        // an unrelated active login's bearer. Native logout owns its captured bearer.
        None
    };
    let independent = CapturedHttpRoute::capture(proxy);
    let operation = async {
        let _permit = if short_request && is_short_http_path(&path, binary, &headers) {
            Some(crate::login_request::SHORT_REQUEST_SEMAPHORE.acquire().await
                .map_err(|_| "short request admission closed".to_string())?)
        } else { None };
        perform_http_request_with_events(
            app, proxy, method, path, headers, body, binary, replay_safe,
            Some(cancel), intent, credential, independent,
        ).await
    };
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("http_request cancelled".into()),
        _ = owner_cancel.cancelled() => Err("native login superseded".into()),
        result = operation => result,
    };
    if let Some(owner) = owner { owner.assert_active().map_err(|e| e.to_string())?; }
    result
}

#[tauri::command]
pub(crate) fn cancel_http_request(
    proxy: tauri::State<'_, ServerSessionState>,
    req_id: String,
) -> bool {
    cancel_registered_request(&proxy, &req_id)
}

fn is_short_http_path(path: &str, binary: bool, headers: &std::collections::HashMap<String, String>) -> bool {
    let path = path.split('?').next().unwrap_or(path);
    path.starts_with("/api/v1/") && !binary
        && !["/api/v1/upload", "/api/v1/uploads"].iter().any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
        && !headers.get("accept").is_some_and(|value| value.contains("text/event-stream"))
}

struct CapturedHttpRoute {
    active: (String, reqwest::Client),
    primary: (String, reqwest::Client),
    secondary: Option<(String, reqwest::Client)>,
}
impl CapturedHttpRoute {
    fn capture(proxy: &ServerSessionState) -> Self {
        Self::capture_with_client(proxy, |origin| proxy.api_client(origin))
    }

    fn capture_with_client(
        proxy: &ServerSessionState,
        mut client: impl FnMut(&str) -> reqwest::Client,
    ) -> Self {
        let snapshot = proxy.routes.snapshot();
        let mut route = |origin: &str| (origin.to_string(), client(origin));
        Self {
            active: route(&snapshot.active),
            primary: route(&snapshot.primary),
            secondary: snapshot.secondary.as_deref().map(route),
        }
    }
    async fn select(&mut self) -> Option<String> {
        let secondary = self.secondary.as_ref()?;
        let (origin, _) = race_origin_candidates(&self.primary.0, &secondary.0).await?;
        self.active = if origin == self.primary.0 { self.primary.clone() } else { secondary.clone() };
        Some(origin)
    }
}

async fn perform_http_request_with_events(
    _app: Option<&tauri::AppHandle>,
    _proxy: &ServerSessionState,
    method: String,
    path: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<Vec<u8>>,
    binary: bool,
    replay_safe: bool,
    cancel: Option<&CancellationToken>,
    mut intent: Option<crate::login_request::LoginRequest>,
    credential: Option<String>,
    mut independent: CapturedHttpRoute,
) -> Result<HttpResponseResult, String> {
    let method = reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET);
    let mut attempt = 0u8;
    let upstream = loop {
        let (api_origin, client) = if let Some(intent) = &intent {
            let endpoint = intent.endpoint()?;
            (endpoint.origin, endpoint.client)
        } else {
            independent.active.clone()
        };
        let target = format!("{}{}", api_origin, path);
        let mut req = client.request(method.clone(), &target);
        if let Some(t) = &credential {
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

                let selected = if let Some(captured) = &intent {
                    if let Some((endpoint, _)) = captured.select_endpoint().await {
                        let origin = endpoint.origin.clone();
                        intent = Some(captured.at_endpoint(&endpoint));
                        Some(origin)
                    } else { None }
                } else {
                    independent.select().await
                };
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
#[path = "tests/proxy_scheduler_tests.rs"]
mod scheduler_tests;

#[cfg(test)]
mod realtime_origin_tests {
    use super::*;
    use futures_util::FutureExt;

    #[tokio::test]
    async fn only_changed_endpoints_schedule_a_stream_wake() {
        let state = ServerSessionState::new();
        let primary = state.routes.snapshot().active.clone();
        state.routes.replace(primary.clone(), Some("http://127.0.0.1:39999".into()));
        activate_origin(&state, &primary, OriginMode::Primary);
        assert!(state.origin_notify.notified().now_or_never().is_none());
        let secondary = "http://127.0.0.1:39999";
        activate_origin(&state, secondary, OriginMode::Secondary);
        assert!(state.origin_notify.notified().now_or_never().is_some());
        activate_origin(&state, secondary, OriginMode::Secondary);
        assert!(state.origin_notify.notified().now_or_never().is_none());
    }
}
