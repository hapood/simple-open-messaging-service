// SOMS cross-platform shell (Tauri v2) — desktop (Linux/Windows/macOS) and Android.
//
// Single-window, single-origin architecture: ONE primary webview loads the bundled SPA at
// `tauri://localhost` (`http://tauri.localhost` on Android) — the merged frontend (config + login + app,
// built from `web/`). There is NO separate bootstrap and NO `somsapp://` scheme: capabilities + CSP apply
// natively because the webview is the app's own LOCAL origin (a custom-scheme webview would be treated as
// remote and rejected by the capability matcher). First-run server setup is an in-SPA `/config` route
// (the `configGuard` forces it until `is_origin_configured`).
//
// The `init_*` commands drive shell↔server setup + OTA: `init_check_compat` (version gate), then
// `init_validate_cert` (strict TLS for HTTPS — skipped for IP/http), then `init_download_web`
// (download → sha256 → atomic install under `app_data_dir/web/<active>/`) for OTA bundle updates. The
// installed bundle is served via `Context::set_assets` (the Assets provider swaps the served dir, with
// the bundled baseline as fallback) — see the OTA section. `init_update_status` is the read-only
// hash-compare probe (Settings → About). `set_api_origin` persists the backend origin (media proxy +
// HttpClient + native SSE all read it).
//
// Also registers the `media://localhost` custom URI scheme that proxies `/uploads/*` to the backend
// with the current access token in an `Authorization: Bearer` header (a bare `<img src>` can't set
// headers, and the backend's httpOnly `media_token` cookie is SameSite=Strict so it can't cross origins).

mod media_cache;
mod native_db;
mod native_video;
mod navigation;
#[cfg(desktop)]
mod secure_storage;

use std::borrow::Cow;
use std::fs;
use std::io::Write;
use std::net::IpAddr;
#[cfg(target_os = "android")]
use std::os::fd::FromRawFd;
use std::path::{Path, PathBuf};
#[cfg(target_os = "android")]
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
// `log` facade macros (warn!/error!) — backed at runtime by `tauri-plugin-log`, registered FIRST in
// run(). Its Webview target forwards each record into the webview console via the `log://log` event
// (re-emitted by the frontend attachConsole-equivalent in main.ts), so Rust-side failures — SSE connect
// errors (`open_one_stream`), upstream proxy failures (`proxy_api`), panics — surface in the SAME console
// the JS errors do (visible via edge://inspect / adb logcat). Previously these were swallowed or silent.
use log::{error, warn};
use sha2::{Digest, Sha256};
use tauri::http::{Response, StatusCode};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{
    Assets, Emitter, Manager, Runtime, UriSchemeResponder, WebviewUrl, WebviewWindowBuilder,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::Notify;

// Desktop SSE supervisor (the Rust-owned /events stream) uses these. Gated so the mobile build (which
// owns SSE in Kotlin) doesn't carry unused imports.
#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, Ordering};
use tokio_util::sync::CancellationToken;

/// The custom URI scheme the frontend rewrites `/uploads/*` media URLs to (see web/.../runtime.ts).
const MEDIA_SCHEME: &str = "media";

#[cfg(target_os = "android")]
static ANDROID_APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// TCP-connect timeout for EVERY backend reqwest client (`proxy_api`, `upload_stream_file`, the SSE
/// supervisor, the OTA commands) — set on the client builder in `http_client_for`. Bounds the "backend
/// unreachable" wait so a dead host fails fast instead of hanging the webview request. This is a
/// CONNECT timeout only — it never aborts an in-progress body transfer (uploads / large responses take
/// as long as they take; a total-duration timeout would wrongly kill a legitimate large upload).
const BACKEND_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Max wait for a proxied API request's HEADERS (connect + send + server processing). The response BODY
/// read is unbounded — a slow/large download must not be aborted. A backend that accepts the connection
/// but never responds → 504 Gateway Timeout.
const API_HEADERS_TIMEOUT: Duration = Duration::from_secs(30);

/// Timeout for a `probe_health` reachability probe (`select_origin`'s cheap-check + race). Bounds the
/// WHOLE probe (DNS + connect + TLS + headers) so an unreachable origin fails fast instead of hanging the
/// cold-start race or a fail-through flip; overrides the client's longer connect_timeout.
const HEALTH_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Max wait for the SSE stream's opening response. The in-stream liveness watchdog (60s, no frame)
/// only arms AFTER a real `ping` is observed, so without this a server that accepts the connection but
/// never sends headers would hang the connect forever. On timeout → treat as a network error → backoff
/// + reconnect (parity with any other connect failure).
#[cfg(desktop)]
const SSE_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// The shell version, baked from Cargo.toml (`CARGO_PKG_VERSION`) — the same source the Makefile
/// asserts equals `tauri.conf.json.version`. Surfaced in Settings→About for display only.
pub const SHELL_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Exclusive upper bound on the backend (server) version this shell supports. The server reports its
/// version via `/shell/compat`; this shell is compatible iff `serverVersion < COMPAT_BACKEND_MAX`
/// (i.e. `!semver_gte(serverVersion, COMPAT_BACKEND_MAX)`). E.g. `0.2.0` accepts any `0.1.x` backend
/// and rejects `0.2.0` onward — a breaking server bump the operator must ship a new shell for. The
/// compatibility range is authored here (in the shell), not on the server: the server carries no shell
/// floor, so the shell self-gates against the backend version it was built/tested against.
const COMPAT_BACKEND_MAX: &str = "0.2.0";

/// The backend origin the shell talks to when nothing else is configured. A deliberate non-routable
/// placeholder — identical in debug and release APKs (no dev-only `localhost`/LAN default, so the
/// packaged debug build behaves exactly like production) — which is unreachable from a phone, exactly
/// why the bundled bootstrap forces the setup wizard on first run. Operators replace it at runtime via
/// the config form (persisted to the `api_origin` file); desktop dev can still override via SOMS_API_ORIGIN.
const DEFAULT_API_ORIGIN: &str = "https://example.com:7667";

/// Persisted-origin file in the app-data dir. Holds a single validated http(s) URL. Read at boot to
/// override the env/default; written by `persist_origin`.
const CONFIG_FILENAME: &str = "api_origin";

/// Sibling of `api_origin`: the optional LAN (secondary) origin, validated the same way. Absent/empty →
/// no fallback configured (the shell behaves exactly as before). Written by `persist_origin_secondary`.
const CONFIG_SECONDARY_FILENAME: &str = "api_origin_secondary";

/// Web-bundle layout under app_data_dir: `web/active.json` atomically holds the active version + its
/// verified bundle SHA-256; `web/<version>/` is the extracted SPA; `web/.staging-<version>/` an
/// in-flight install.
const WEB_DIRNAME: &str = "web";
const ACTIVE_STATE_FILENAME: &str = "active.json";

#[derive(serde::Deserialize, serde::Serialize)]
struct ActiveWebState {
    version: String,
    sha256: String,
}

fn read_active_web_state(web_root: &Path) -> Option<ActiveWebState> {
    let raw = fs::read_to_string(web_root.join(ACTIVE_STATE_FILENAME)).ok()?;
    let state: ActiveWebState = serde_json::from_str(&raw).ok()?;
    if state.version.trim().is_empty() || state.sha256.trim().is_empty() {
        return None;
    }
    Some(state)
}

/// Which origin `api_origin` currently holds, for the native fallback state machine.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum OriginMode {
    /// Active origin = the primary (normal operation).
    Primary,
    /// Active origin = the secondary; the primary was unreachable at the last `select_origin` race.
    Secondary,
}

/// Shared state for the proxies + the token/origin commands. Cloned cheaply (the reqwest Client,
/// the token Arc, the origin Arc, the config-path Arc are all refcounted), so every protocol handler +
/// command handler sees the same live values.
#[derive(Clone)]
struct ProxyState {
    /// The ACTIVE origin — every transport (api_request/media_request/proxy_media/upload_stream_file)
    /// and the desktop SSE supervisor read THIS. Swapped in-place by `select_origin` on fallback, so the
    /// read sites never change. Cold-start select_origin may flip it from the persisted primary to the
    /// secondary before the first request flies.
    api_origin: Arc<Mutex<String>>,
    /// The user-configured PRIMARY origin (field-1). Only `persist_origin` writes it (set_api_origin /
    /// init_download_web). `is_origin_configured` reads THIS, so a fallback swap to the secondary doesn't
    /// trip the /config first-run guard.
    api_origin_primary: Arc<Mutex<String>>,
    /// The optional LAN (secondary) origin (field-2). None = no fallback configured → select_origin is a
    /// complete no-op and the shell behaves exactly as before.
    api_origin_secondary: Arc<Mutex<Option<String>>>,
    /// Which origin `api_origin` currently holds. No periodic proactive switch-back — movement either way
    /// is handled by re-racing on the next network-level failure.
    origin_mode: Arc<Mutex<OriginMode>>,
    /// Woken on a committed origin switch (select_origin) so the desktop SSE supervisor cancels its current
    /// stream and reopens on the new active origin immediately — API and SSE never split on a single active
    /// origin. Race-free (Notify holds one permit). Mobile follows via the shared EncryptedSharedPreferences
    /// instead (Kotlin owns /events); the Notify is harmless there (nothing awaits it).
    origin_notify: Arc<Notify>,
    /// Serializes `select_origin`'s RACE (single-flight): one race at a time. The cheap-check before the
    /// lock coalesces the common case; this prevents a storm of concurrent full races. `tokio::sync::Mutex`
    /// (held across `.await` probes) — distinct from the `std::sync::Mutex` used elsewhere for sync state.
    select_lock: Arc<tokio::sync::Mutex<()>>,
    token: Arc<Mutex<Option<String>>>,
    config_path: Arc<Mutex<PathBuf>>,
    /// Woken by `set_session_token` after writing a non-empty token. The desktop SSE supervisor awaits
    /// this when no token is set, so an `sse_start` issued before login (the facade connects eagerly at
    /// boot) blocks without busy-looping and without 401-storming, then opens the moment login provides
    /// a token. `tokio::sync::Notify` stores one permit, so a `notify_one()` that races ahead of the
    /// `notified().await` is not lost — race-free. Unused on mobile (Kotlin owns SSE + the token).
    token_notify: Arc<Notify>,
    /// Cached reqwest client for `proxy_api`, keyed on the origin string. Rebuilt only when the origin
    /// changes (see `ProxyState::api_client`) — so API calls reuse one connection pool (TCP+TLS
    /// keepalive across requests) instead of `http_client_for` building a fresh client (fresh pool, no
    /// reuse) on every single request. `(origin, client)`; the origin tag detects a swap. The SSE
    /// supervisor + OTA commands still build per-call clients (infrequent: once per reconnect / once).
    api_http: Arc<Mutex<(String, reqwest::Client)>>,
    /// The active OTA web-bundle dir (extracted under `app_data_dir/web/<version>/`). Shared with the
    /// `OtaAssets` resolver — `init_download_web` swaps it, boot `setup()` seeds it, and the NEXT asset
    /// request serves from the new dir. None → the embedded baseline (`frontendDist`) is served.
    ota_active: Arc<Mutex<Option<PathBuf>>>,
    /// Shell streaming uploads keyed by clientMessageId. A cancel action resolves the token, which drops
    /// the in-flight reqwest future and closes the request body stream/file descriptor.
    upload_cancels: Arc<Mutex<std::collections::HashMap<String, CancellationToken>>>,
    /// App-scoped media downloads keyed by the renderer-generated task id. The shared image-download
    /// adapter cancels through this map; dropping the reqwest stream leaves only a disposable .part file.
    media_download_cancels: Arc<Mutex<std::collections::HashMap<String, CancellationToken>>>,
}

impl ProxyState {
    /// Return a reqwest client for API calls to `origin`, rebuilding + caching only when the origin
    /// changes. `reqwest::Client` is `Clone`-cheap (Arc internals), so the cached pool is shared across
    /// concurrent requests and kept warm between them (keepalive). On an origin swap (`set_api_origin`)
    /// the next request sees a mismatched tag and rebuilds — in-flight requests keep working (they hold
    /// their own clone of the old client).
    fn api_client(&self, origin: &str) -> reqwest::Client {
        let mut g = self.api_http.lock().expect("api_http lock");
        if g.0 == origin {
            return g.1.clone();
        }
        let client = http_client_for(origin);
        *g = (origin.to_string(), client.clone());
        client
    }
}

/// Validate a backend origin: must parse as a clean http(s) URL. Returns the canonical string form so
/// the caller never stores malformed input (the origin feeds both a fetch URL and persisted state).
/// Trailing slash is stripped — the origin is a path-concatenation BASE, and a trailing slash doubles
/// it into `//api/v1` / `//uploads/`, which Fastify 404s on.
fn validate_origin(raw: &str) -> Option<String> {
    reqwest::Url::parse(raw.trim())
        .ok()
        .filter(|u| u.scheme() == "http" || u.scheme() == "https")
        .map(|u| u.to_string().trim_end_matches('/').to_string())
}

/// `true` if the origin's host is a literal IP address (v4/v6). IP origins skip TLS cert validation
/// (self-hosted LAN servers commonly have no valid cert) — IP/http origins are not guaranteed secure
/// by policy.
fn origin_host_is_ip(origin: &str) -> bool {
    let Some(host) = reqwest::Url::parse(origin)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
    else {
        return false;
    };
    // `Url::host_str` serializes an IPv6 literal WITH brackets ("[::1]"), which won't parse as an
    // IpAddr — strip them so a bare-IPv6 origin is detected (and gets permissive TLS, like IPv4).
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.parse::<IpAddr>().is_ok()
}

/// TLS posture the proxy takes toward a backend origin. The security boundary `http_client_for` and
/// `init_validate_cert` both implement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TlsPosture {
    /// HTTPS + DNS host: rustls webpki root store validates the cert — self-signed / expired /
    /// hostname-mismatch → handshake error.
    Strict,
    /// `http` scheme OR literal-IP host: accept self-signed / cleartext. LAN self-hosted servers commonly
    /// have no valid cert for a bare IP; the web-bundle signature still guards integrity.
    Permissive,
}

/// Decide the TLS posture for an origin. Extracted pure (no reqwest client, no network) from the two
/// call sites that previously made this `is_http || origin_host_is_ip` decision inline, so the boundary
/// is unit-testable. An unparseable origin → Permissive, matching the `unwrap_or(true)` default both
/// sites already used (`validate_origin` gates persistence, so a bad origin never reaches here in
/// practice — the default is defensive).
fn tls_posture_for(origin: &str) -> TlsPosture {
    let is_http = reqwest::Url::parse(origin)
        .ok()
        .map(|u| u.scheme() == "http")
        .unwrap_or(true);
    if is_http || origin_host_is_ip(origin) {
        TlsPosture::Permissive
    } else {
        TlsPosture::Strict
    }
}

/// Build a reqwest client scoped to one origin's TLS posture (see `tls_posture_for`). Redirects
/// are NEVER followed — an origin pointing at a login-redirect host must not chase into an attacker-
/// controlled path. The media-proxy client (`ProxyState.http`) is untouched.
fn http_client_for(origin: &str) -> reqwest::Client {
    let mut b = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(BACKEND_CONNECT_TIMEOUT);
    if tls_posture_for(origin) == TlsPosture::Permissive {
        b = b.danger_accept_invalid_certs(true);
    }
    b.build().unwrap_or_else(|_| reqwest::Client::new())
}

/// Persist + activate a backend origin: validate, write the app-data config file (survives restarts,
/// feeds the media proxy Arc), and update the live Arc (so `/uploads/*` immediately uses the new host).
/// Factored so `set_api_origin` (Server page, legacy) and `init_download_web` (new) share one writer —
/// the two persistence surfaces (this file + the web's `SomsSecureStore`) stay consistent.
fn persist_origin(state: &ProxyState, url: &str) -> Result<String, String> {
    let normalized =
        validate_origin(url).ok_or_else(|| format!("not a valid http(s) URL: {url}"))?;
    let path = state.config_path.lock().expect("config_path lock").clone();
    fs::write(&path, &normalized).map_err(|e| format!("failed to write config: {e}"))?;
    // This is the "user explicitly chose the primary" path (set_api_origin / init_download_web): record it
    // as the primary, make it active, and reset the mode. The secondary is managed separately by
    // persist_origin_secondary. select_origin may later flip `api_origin` to the secondary on failure.
    *state.api_origin_primary.lock().expect("primary lock") = normalized.clone();
    *state.api_origin.lock().expect("origin lock") = normalized.clone();
    *state.origin_mode.lock().expect("mode lock") = OriginMode::Primary;
    Ok(normalized)
}

/// Persist + set the LAN (secondary) origin (field-2). `None`/empty clears it (deletes the file + sets the
/// Arc to None → no fallback). Validates via the same `validate_origin` so a malformed URL is never stored.
/// Does NOT touch the active origin or mode — `select_origin` decides which is active.
fn persist_origin_secondary(
    state: &ProxyState,
    url: Option<&str>,
) -> Result<Option<String>, String> {
    let dir = state
        .config_path
        .lock()
        .expect("config_path lock")
        .parent()
        .map(|p| p.to_path_buf());
    let normalized = match url.map(str::trim).filter(|s| !s.is_empty()) {
        None => {
            if let Some(dir) = &dir {
                let _ = fs::remove_file(dir.join(CONFIG_SECONDARY_FILENAME));
            }
            *state.api_origin_secondary.lock().expect("secondary lock") = None;
            None
        }
        Some(raw) => {
            let n =
                validate_origin(raw).ok_or_else(|| format!("not a valid http(s) URL: {raw}"))?;
            if let Some(dir) = &dir {
                fs::write(dir.join(CONFIG_SECONDARY_FILENAME), &n)
                    .map_err(|e| format!("failed to write secondary config: {e}"))?;
            }
            *state.api_origin_secondary.lock().expect("secondary lock") = Some(n.clone());
            Some(n)
        }
    };
    Ok(normalized)
}

/// `MAJOR.MINOR.PATCH` `>=` compare (shell versions are clean triplets; prerelease/build ignored).
fn semver_gte(a: &str, b: &str) -> bool {
    let pa: Vec<u64> = a
        .split('.')
        .map(|s| {
            s.split('-')
                .next()
                .unwrap_or(s)
                .split('+')
                .next()
                .unwrap_or(s)
        })
        .map(|s| s.parse::<u64>().unwrap_or(0))
        .collect();
    let pb: Vec<u64> = b
        .split('.')
        .map(|s| {
            s.split('-')
                .next()
                .unwrap_or(s)
                .split('+')
                .next()
                .unwrap_or(s)
        })
        .map(|s| s.parse::<u64>().unwrap_or(0))
        .collect();
    for i in 0..pa.len().max(pb.len()) {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    true
}

// --- OTA asset resolver (runtime web-bundle swap) ----------------------------------------
//
// The shell embeds a baseline SPA via `tauri::generate_context!` (frontendDist). OTA updates download a
// newer bundle, sha256-verify it, and extract it under `app_data_dir/web/<version>/`. To actually SERVE it
// the webview's asset resolver must read from that dir at request time. `Context::set_assets` can swap the
// resolver, but it takes `&mut Context` — unreachable from a runtime IPC command (which only has an
// AppHandle) — so instead a CUSTOM `Assets` impl is installed ONCE at `run()` (before the webview builds),
// wrapping the embedded baseline as a fallback and holding a shared `active: Arc<Mutex<Option<PathBuf>>>`
// that `init_download_web` updates. The next request after a swap serves the new bundle; the running page
// reloads (Settings→About → `location.reload()`) to pick it up. At boot `setup()` seeds `active` from
// `app_data/web/active.json`, so a bundle installed on a prior run is served immediately — not lost on
// restart.

/// A custom `Assets` resolver: serve from the active OTA bundle dir when one is set AND the requested key
/// exists there, otherwise fall back to the embedded baseline. The fallback is the build-time
/// `EmbeddedAssets` moved out of `Context.assets` at `run()` — so the shipped baseline is always available
/// (cold start before any OTA, an OTA dir that doesn't override every key, or a corrupt/missing OTA file).
struct OtaAssets<R: Runtime> {
    active: Arc<Mutex<Option<PathBuf>>>,
    fallback: Box<dyn Assets<R>>,
}

impl<R: Runtime> Assets<R> for OtaAssets<R> {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        if let Some(dir) = self.active.lock().ok().and_then(|g| g.clone()) {
            if let Some(bytes) = read_ota_asset(&dir, key.as_ref()) {
                return Some(Cow::Owned(bytes));
            }
            // Angular uses history-mode routes. A hard navigation after installing an OTA bundle requests
            // e.g. `auth/login`, not `index.html`. Falling through to EmbeddedAssets here can return the
            // embedded baseline's SPA fallback, silently booting the OLD bundle after a successful update.
            // Route-like keys must therefore resolve to the active bundle's entry document.
            if is_spa_route_key(key.as_ref()) {
                if let Some(bytes) = read_ota_asset(&dir, "index.html") {
                    return Some(Cow::Owned(bytes));
                }
            }
        }
        self.fallback.get(key)
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        // Only the embedded set is enumerable (the static list known at build time); OTA-served files are
        // resolved per-request via `get`. `iter` is not on the serve path, so delegating is correct.
        self.fallback.iter()
    }
    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        // Delegate to the embedded baseline. The enforced CSP is the static `tauri.conf.json` policy
        // (script-src 'self', style-src 'unsafe-inline'), so per-asset hashes are not load-bearing: the
        // embedded hashes neither over-restrict (hashes only ADD to the allow-list) nor under-restrict
        // (script-src 'self' already covers every OTA script) for an OTA-served page.
        self.fallback.csp_hashes(html_path)
    }
}

fn is_spa_route_key(key: &str) -> bool {
    let rel = key.trim_start_matches('/').trim_end_matches('/');
    rel.is_empty()
        || rel
            .rsplit('/')
            .next()
            .is_some_and(|part| !part.contains('.'))
}

#[cfg(test)]
#[path = "tests/ota_asset_tests.rs"]
mod ota_asset_tests;

/// Read one asset (`key`, e.g. `index.html` / `assets/x.js` — the leading slash Tauri may include is
/// stripped, matching how `AssetKey` is requested) from an OTA bundle dir. Path-traversal-hardened: the
/// key may not contain `..` or a backslash, and the resolved canonical path must stay within `dir`
/// (defends against symlinks too), so a malformed/malicious key can never escape to an arbitrary file.
fn read_ota_asset(dir: &Path, key: &str) -> Option<Vec<u8>> {
    let rel = key.trim_start_matches('/');
    if rel.is_empty() || rel.contains("..") || rel.contains('\\') {
        return None;
    }
    let candidate = dir.join(rel);
    let canon_dir = dir.canonicalize().ok()?;
    let canon_candidate = candidate.canonicalize().ok()?;
    if !canon_candidate.starts_with(&canon_dir) {
        return None;
    }
    fs::read(&canon_candidate).ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Pre-setup best guess (no app handle yet, so no app-data dir): env, else default. setup() overrides
    // this from the persisted config file once the handle is available.
    let initial_origin = std::env::var("SOMS_API_ORIGIN")
        .ok()
        .and_then(|s| validate_origin(&s))
        .unwrap_or_else(|| DEFAULT_API_ORIGIN.to_string());

    // The active OTA bundle dir, shared between the `OtaAssets` resolver (installed at `.run` below) and
    // `ProxyState` (so `init_download_web` + boot `setup()` can swap it via the shared Arc).
    let ota_active: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
    let proxy_state = ProxyState {
        api_origin: Arc::new(Mutex::new(initial_origin.clone())),
        // Pre-setup best guess: primary == active == the boot origin (env/default). setup() overrides both
        // from the persisted files; the secondary starts None until setup reads its file.
        api_origin_primary: Arc::new(Mutex::new(initial_origin.clone())),
        api_origin_secondary: Arc::new(Mutex::new(None)),
        origin_mode: Arc::new(Mutex::new(OriginMode::Primary)),
        origin_notify: Arc::new(Notify::new()),
        select_lock: Arc::new(tokio::sync::Mutex::new(())),
        token: Arc::new(Mutex::new(None)),
        config_path: Arc::new(Mutex::new(PathBuf::new())),
        token_notify: Arc::new(Notify::new()),
        // Seed the cached API client with the boot origin; rebuilt on the first request after a swap.
        api_http: Arc::new(Mutex::new((
            initial_origin.clone(),
            http_client_for(&initial_origin),
        ))),
        ota_active: ota_active.clone(),
        upload_cancels: Arc::new(Mutex::new(std::collections::HashMap::new())),
        media_download_cancels: Arc::new(Mutex::new(std::collections::HashMap::new())),
    };
    let proxy_for_media = proxy_state.clone();

    let builder = tauri::Builder::default();

    // Logging is registered FIRST so it captures every later plugin's setup, the URI-scheme proxies, and
    // the desktop SSE supervisor. Sinks: Webview (emit every Rust log on the `log://log` event — the debug
    // log panel subscribes to it while open; it is no longer re-emitted into the JS console), Stdout
    // (terminal / docker logs; routed to logcat on Android), LogDir (a rotating file under the OS log dir
    // for post-mortem + the bundle's `rust/*`). The sink accepts Debug, while release starts with the
    // global facade capped at Error below; the hidden About gesture raises that cap at runtime.
    let builder = builder.plugin(
        tauri_plugin_log::Builder::new()
            .targets([
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                    file_name: None,
                }),
            ])
            // Client-app rotation: a SIZE-BOUNDED rotating set (the desktop/mobile norm) — NOT time-based
            // "keep N days" (a server logrotate pattern this plugin doesn't offer, and the wrong model for
            // a client whose log volume is bursty/idle). The plugin's default is a single 40 KB file — too
            // small for field diagnostics (a reconnect storm fills it in seconds); 1 MiB × keep 5 ≈ 6 MiB
            // total reconstructs a bad session with a hard cap, so a long-lived client can never grow it
            // without bound. Affects only the LogDir file (Webview/Stdout aren't files).
            .max_file_size(1024 * 1024)
            .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
            .level(log::LevelFilter::Debug)
            // Silence the HTTP stack at info (hyper logs connection-lifecycle events) so the webview
            // console stays focused on OUR failures and the rotating file's effective history stretches
            // further. Our own sites emit warn/error, all of which still pass.
            .level_for("hyper", log::LevelFilter::Warn)
            .level_for("reqwest", log::LevelFilter::Warn)
            .level_for("rustls", log::LevelFilter::Warn)
            // Explicit UTC format for EVERY target: `${ISO_UTC} [LEVEL] [target] message`. The plugin's
            // default formatter OMITS the timestamp on mobile (the Android default is `[target] message`,
            // relying on logcat) and omits milliseconds on desktop — so without this, the debug panel's
            // Rust leg has no parseable timestamp on Android (every line sorts to the end of the merged
            // view). Emitting our own also decouples the panel's parser from the plugin's default format,
            // which could change between versions. The ISO prefix matches the JS/Kotlin ring-buffer format
            // exactly, so all three layers interleave by timestamp with no per-source timezone guesswork.
            .format(|out, message, record| {
                out.finish(format_args!(
                    "{} [{}] [{}] {}",
                    iso_utc_now(),
                    record.level(),
                    record.target(),
                    message,
                ))
            })
            .build(),
    );

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());

    let builder = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        // media://localhost — proxy /uploads/* to ${api_origin} with the Bearer token (bare <img src>
        // can't set headers; the SameSite=Strict media_token cookie can't cross origins).
        .register_asynchronous_uri_scheme_protocol(
            MEDIA_SCHEME,
            move |context, request, responder| {
                let st = proxy_for_media.clone();
                let app = context.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    proxy_media(app, st, request, responder).await;
                });
            },
        )
        .manage(proxy_state.clone());
    // SseSupervisor is #[cfg(desktop)] (the desktop-only reqwest/tokio SSE supervisor — mobile owns the
    // /events stream natively via Kotlin RealtimeService, so there is no Rust supervisor to manage), so
    // .manage() it on desktop only. Mirrors the #[cfg(desktop)] single-instance + #[cfg(mobile)] barcode
    // plugin rebinds just above; without this guard the Android build references a configured-out type
    // (E0433 cannot find type `SseSupervisor`).
    #[cfg(desktop)]
    let builder = builder.manage(SseSupervisor::new());
    builder
        .invoke_handler({
            #[cfg(desktop)]
            {
                tauri::generate_handler![
                    get_api_origin,
                    get_active_api_origin,
                    is_origin_configured,
                    set_api_origin,
                    get_api_origin_secondary,
                    set_api_origin_secondary,
                    get_origin_mode,
                    init_pick_origin,
                    set_active_origin,
                    set_session_token,
                    clear_session_token,
                    begin_logout,
                    secure_storage::secure_get_token,
                    secure_storage::secure_set_token,
                    secure_storage::secure_clear_token,
                    get_shell_version,
                    init_check_compat,
                    init_validate_cert,
                    init_download_web,
                    init_update_status,
                    sse_start,
                    sse_stop,
                    sse_get_state,
                    sse_net,
                    sse_replay_hello,
                    upload_stream_file,
                    cancel_upload,
                    report_diagnostics,
                    set_debug_logging,
                    log_js,
                    read_native_log,
                    api_request,
                    media_request,
                    media_cache::cache_media,
                    media_cache::download_media,
                    media_cache::cancel_media_download,
                    media_cache::clear_media_cache,
                    media_cache::get_media_cache_info,
                    media_cache::save_media_desktop,
                    media_cache::set_media_cache_limit,
                    native_video::create_native_video_stream,
                    native_db::native_db_threads,
                    native_db::native_db_list_friend_intents,
                    native_db::native_db_put_thread,
                    native_db::native_db_replace_threads,
                    native_db::native_db_delete_thread,
                    native_db::native_db_apply_thread_delta,
                    native_db::native_db_apply_missed_summary,
                    native_db::native_db_get_profile,
                    native_db::native_db_get_member_profile,
                    native_db::native_db_list_member_profiles,
                    native_db::native_db_put_profile,
                    native_db::native_db_get_meta,
                    native_db::native_db_put_meta,
                    native_db::native_db_get_preference,
                    native_db::native_db_put_preference,
                    native_db::native_db_delete_preference,
                    native_db::native_db_recreate_cache,
                    native_db::native_db_validate_cache,
                    native_db::native_db_recreate_messages,
                    native_db::native_db_count_messages,
                    native_db::native_db_clear_user,
                    native_db::native_db_clear_all,
                    native_db::native_db_get_avatar,
                    native_db::native_db_put_avatar,
                    native_db::native_db_query_messages,
                    native_db::native_db_put_messages,
                    native_db::native_db_get_deleted_hwm,
                    native_db::native_db_apply_deleted_messages,
                    native_db::native_db_message_section,
                    native_db::native_db_message_coverage,
                    native_db::native_db_get_message,
                    native_db::native_db_newest_messages,
                    native_db::native_db_delete_messages_by_thread,
                    navigation::open_external_url,
                ]
            }
            #[cfg(not(desktop))]
            {
                tauri::generate_handler![
                    get_api_origin,
                    get_active_api_origin,
                    is_origin_configured,
                    set_api_origin,
                    get_api_origin_secondary,
                    set_api_origin_secondary,
                    get_origin_mode,
                    init_pick_origin,
                    set_active_origin,
                    set_session_token,
                    clear_session_token,
                    begin_logout,
                    get_shell_version,
                    init_check_compat,
                    init_validate_cert,
                    init_download_web,
                    init_update_status,
                    upload_stream_file,
                    cancel_upload,
                    report_diagnostics,
                    set_debug_logging,
                    log_js,
                    read_native_log,
                    api_request,
                    media_request,
                    media_cache::cache_media,
                    media_cache::download_media,
                    media_cache::cancel_media_download,
                    media_cache::clear_media_cache,
                    media_cache::get_media_cache_info,
                    media_cache::set_media_cache_limit,
                    native_video::create_native_video_stream,
                    native_db::native_db_threads,
                    native_db::native_db_list_friend_intents,
                    native_db::native_db_put_thread,
                    native_db::native_db_replace_threads,
                    native_db::native_db_delete_thread,
                    native_db::native_db_apply_thread_delta,
                    native_db::native_db_apply_missed_summary,
                    native_db::native_db_get_profile,
                    native_db::native_db_get_member_profile,
                    native_db::native_db_list_member_profiles,
                    native_db::native_db_put_profile,
                    native_db::native_db_get_meta,
                    native_db::native_db_put_meta,
                    native_db::native_db_get_preference,
                    native_db::native_db_put_preference,
                    native_db::native_db_delete_preference,
                    native_db::native_db_recreate_cache,
                    native_db::native_db_validate_cache,
                    native_db::native_db_recreate_messages,
                    native_db::native_db_count_messages,
                    native_db::native_db_clear_user,
                    native_db::native_db_clear_all,
                    native_db::native_db_get_avatar,
                    native_db::native_db_put_avatar,
                    native_db::native_db_query_messages,
                    native_db::native_db_put_messages,
                    native_db::native_db_get_deleted_hwm,
                    native_db::native_db_apply_deleted_messages,
                    native_db::native_db_message_section,
                    native_db::native_db_message_coverage,
                    native_db::native_db_get_message,
                    native_db::native_db_newest_messages,
                    native_db::native_db_delete_messages_by_thread,
                    navigation::open_external_url,
                ]
            }
        })
        .setup(move |app| {
            // Release stays on the cheapest useful diagnostic tier until the user explicitly unlocks
            // debug tools. Debug builds remain verbose. The web app re-enables Debug after every launch
            // when its persisted debug flag is set.
            #[cfg(not(debug_assertions))]
            log::set_max_level(log::LevelFilter::Error);
            #[cfg(debug_assertions)]
            log::set_max_level(log::LevelFilter::Debug);

            #[cfg(target_os = "android")]
            {
                let _ = ANDROID_APP.set(app.handle().clone());
            }
            // Route panics through the `log` facade (→ webview console + stdout + log file). The release
            // profile sets `panic = "abort"`, but the hook still runs before the abort, so a Rust panic
            // leaves a trace instead of vanishing. Installed in setup() — by then the log plugin has
            // initialized its facade during app construction.
            std::panic::set_hook(Box::new(|info| {
                error!("panic: {info}");
            }));

            let data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&data_dir)?;
            let config_path = data_dir.join(CONFIG_FILENAME);
            if let Some(persisted) = fs::read_to_string(&config_path)
                .ok()
                .and_then(|s| validate_origin(&s))
            {
                // The persisted file is the user-configured PRIMARY. Seed primary + active from it; a
                // cold-start select_origin (spawned later in setup) may flip `api_origin` to the secondary
                // if the primary is unreachable on this network.
                *proxy_state.api_origin_primary.lock().expect("primary lock") = persisted.clone();
                *proxy_state.api_origin.lock().expect("origin lock") = persisted;
            }
            // Secondary (LAN) origin — optional. Absent file → None → no fallback (exact legacy behavior).
            if let Some(sec) = fs::read_to_string(data_dir.join(CONFIG_SECONDARY_FILENAME))
                .ok()
                .and_then(|s| validate_origin(&s))
            {
                *proxy_state
                    .api_origin_secondary
                    .lock()
                    .expect("secondary lock") = Some(sec);
            }
            *proxy_state.config_path.lock().expect("config_path lock") = config_path;

            // Seed the OTA asset resolver from a previously-installed bundle: if `web/active.json` names a
            // version whose extracted dir exists, serve it on this boot. The `OtaAssets` resolver (installed
            // at `.run`) reads this Arc, so a bundle installed on a prior run is picked up immediately and
            // is never lost on restart. Best-effort: a missing/invalid state file or a deleted dir just
            // leaves the embedded baseline served (the normal cold-start state).
            let web_root = data_dir.join(WEB_DIRNAME);
            if let Some(active) = read_active_web_state(&web_root) {
                let dir = web_root.join(&active.version);
                if dir.is_dir() {
                    *proxy_state.ota_active.lock().expect("ota_active lock") = Some(dir);
                }
            }

            // The single window always loads the bundled SPA (frontendDist → `tauri://localhost`). There
            // is no separate bootstrap and no `somsapp://` origin anymore: the merged frontend owns both
            // first-run config (an in-SPA `/config` route) and the app. OTA bundle updates swap the served
            // asset dir via `Context::set_assets` (the Assets provider), not a second origin.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("SOMS")
                .on_navigation(navigation::is_allowed)
                .inner_size(1200.0, 800.0)
                .min_inner_size(900.0, 600.0)
                .build()?;

            // Offline diagnostics delivery: re-POST any report bundles captured during a prior network
            // outage (kept under app_cache_dir/pending-*). Fire-and-forget — never blocks app launch.
            let retry_app = app.handle().clone();
            let retry_state = proxy_state.clone();
            tauri::async_runtime::spawn(async move {
                retry_pending_diagnostics(retry_app, retry_state).await;
            });

            // The web APP_INITIALIZER invokes `init_pick_origin` before routing begins. That timing matters:
            // the logged-out login page immediately loads public `/config`, so the active origin must be
            // selected even when no session token exists and before the user submits the login form.
            Ok(())
        })
        .run({
            // Install the OTA asset resolver: move the embedded baseline (`Context.assets` is a pub field)
            // out and wrap it in `OtaAssets`, which serves the active OTA bundle dir when one is set and
            // falls back to the embedded baseline otherwise. The shared `ota_active` Arc is the same one
            // `ProxyState` holds, so `init_download_web` / boot `setup()` swaps take effect on the next
            // asset request with no `&mut Context` needed at runtime.
            let mut context = tauri::generate_context!();
            let embedded = context.assets;
            context.assets = Box::new(OtaAssets {
                active: ota_active.clone(),
                fallback: embedded,
            });
            context
        })
        .expect("error while running tauri application");
}

// --- media:// proxy (unchanged) -----------------------------------------------------------

async fn proxy_media(
    app: tauri::AppHandle,
    st: ProxyState,
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
enum HeadersError {
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
async fn send_with_headers_deadline(
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
// `GET /api/v1/health` (public) is the ONLY reachability oracle — it works PRE-LOGIN (no token), unlike
// SSE. No request re-send: the failed request surfaces to the caller and the SSE HELLO/reconcile restores
// state; these only fix which origin subsequent traffic uses.
//
// Authority: on DESKTOP Rust decides both (race + switch + `origin_notify` to its own SSE supervisor). On
// ANDROID Kotlin is authoritative (it owns the FGS, including background); Rust is PASSIVE — it never
// probes/switches, it just accepts the origin Kotlin signals via `set_active_origin` (JS-mediated). So the
// `maybe_switch`/`pick_origin_race` CALL SITES in the transports/SSE are desktop-only.

/// A `reqwest::Error` that means the origin is UNREACHABLE (connect / DNS / TLS / timeout) — a candidate
/// for `maybe_switch` / `pick_origin_race`. An HTTP status response (incl. 401) never reaches this: it
/// means the server IS reachable, so no switch. Extracted pure so the boundary is unit-testable.
fn is_network_failure(e: &reqwest::Error) -> bool {
    e.is_connect() || e.is_timeout()
}

/// Short-timeout UNAUTHENTICATED probe of `{origin}/api/v1/health` — true iff the origin answered a
/// healthy (2xx) response within `HEALTH_PROBE_TIMEOUT`. No Bearer: health is public, so this works
/// PRE-LOGIN (when no session token exists and SSE cannot connect). A fresh client per probe (probes are
/// infrequent: login + on failure + reconnect); the outer timeout bounds DNS + connect + TLS + headers.
async fn probe_health(origin: &str) -> bool {
    let url = format!("{}/api/v1/health", origin.trim_end_matches('/'));
    let client = http_client_for(origin);
    match tokio::time::timeout(HEALTH_PROBE_TIMEOUT, client.get(&url).send()).await {
        Ok(Ok(r)) => r.status().is_success(),
        _ => false, // timeout, connect/DNS/TLS failure, or non-2xx → not healthy
    }
}

/// Apply a chosen origin + mode as the active one, notifying the desktop SSE supervisor to reopen on it
/// (API⇄SSE lockstep). No-op if it's already the active. Shared by `pick_origin_race` + `maybe_switch`.
fn activate_origin(state: &ProxyState, origin: &str, mode: OriginMode) {
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
async fn pick_origin_race(state: &ProxyState) -> Option<String> {
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
        let primary_probe = probe_health(&primary);
        let secondary_probe = probe_health(&secondary);
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
async fn runtime_switch(state: &ProxyState) {
    let _ = pick_origin_race(state).await;
}

/// The webview→backend HTTP transport under the Tauri shell. The frontend `TauriHttpBackend`
/// (web/.../tauri-http.backend.ts) invokes this instead of `fetch()`: Android's Chromium WebView rejects
/// non-standard schemes in `fetch()`, so the old `api://` custom-scheme proxy could not be fetched there;
/// routing through IPC also lets RUST own the session token (JS never touches it). Mirrors what the
/// former `proxy_api` did, but as an IPC command: build a reqwest request to `${api_origin}${path}`
/// (`path` already includes `/api/v1…` + query), forward a whitelist of JS headers (NEVER `authorization`
/// — Rust injects the Bearer from `ProxyState.token`), buffer the response, return status + headers +
/// UTF-8 body. Uses the cached `api_client` (one connection pool per origin); the body READ is unbounded,
/// only the headers phase is bounded by `API_HEADERS_TIMEOUT` (connect-only failures are already caught
/// by `BACKEND_CONNECT_TIMEOUT`). Redirects are never followed (same posture as `http_client_for`).
#[derive(serde::Serialize)]
struct ApiRequestResult {
    status: u16,
    headers: std::collections::HashMap<String, String>,
    body: String,
}

#[tauri::command]
async fn api_request(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ProxyState>,
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
                if let Some(origin) = selected.as_ref() {
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
    let bytes = upstream
        .bytes()
        .await
        .map_err(|e| format!("api_request read: {e}"))?;
    Ok(ApiRequestResult {
        status,
        headers: out_headers,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

// --- IPC media_request (the webview→backend MEDIA transport under Tauri) ------------------

/// The webview→backend MEDIA transport under the Tauri shell. The avatar repository
/// (`AvatarRepository.fetchBlob`) does `http.get(assetUrl(path), { responseType: 'blob' })`; `assetUrl`
/// rewrites `/uploads/*` to `media://localhost/...` under Tauri. `media://` works for a bare `<img src>`
/// (the resource loader consults `shouldInterceptRequest` → the `proxy_media` scheme handler), but
/// Android's Chromium WebView rejects non-standard schemes in `fetch()`, so the BLOB fetch path the
/// avatar cache uses could not fetch `media://` there. `TauriHttpBackend` therefore routes `media://`
/// requests to THIS command: a reqwest GET to `${api_origin}${path}` with the Bearer injected from
/// `ProxyState.token` (so JS still never touches the token), returning the raw bytes. Mirrors `proxy_media`
/// but as an IPC command returning bytes (not a scheme-handler `Response`); reuses the cached per-origin
/// `api_client` (the IP/http permissive-TLS posture + one warm connection pool), so uploads served from a
/// self-signed LAN IP server resolve the same way API calls do.
#[derive(serde::Serialize)]
struct MediaRequestResult {
    status: u16,
    content_type: Option<String>,
    body: Vec<u8>,
}

#[tauri::command]
async fn media_request(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ProxyState>,
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

/// Shell-wide streaming upload: POST a file straight from its on-disk `path` to `${origin}${endpoint}`
/// as a multipart form, WITHOUT buffering the whole file into the webview / IPC. Tauri's `<input
/// type=file>` injects the real filesystem path as `File.path` on desktop. Mobile native surfaces pass
/// app-private recording/selection paths to the same upload core, so file bytes stay outside the WebView.
/// Browser/PWA has no Rust shell and continues to use HttpClient. Auth uses `ProxyState.token` (uploads
/// happen post-login, so it is set).
///
/// Streaming: `tokio::fs::File` + `ReaderStream` → `reqwest::Body::wrap_stream` → multipart
/// `Part::stream_with_length(size)`. The file is read + sent in chunks; the peak memory is one chunk,
/// not the whole file — so a multi-GB video upload never materializes in RAM (the `api://` URI-scheme
/// proxy CAN'T do this: Tauri hands it a `Request<Vec<u8>>`, fully buffered at the IPC boundary).
#[tauri::command]
async fn upload_stream_file(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ProxyState>,
    path: String,
    endpoint: String,
    filename: String,
    mime: String,
    size: u64,
    fields: std::collections::HashMap<String, String>,
    client_message_id: Option<String>,
) -> Result<serde_json::Value, String> {
    upload_stream_path_core(
        app,
        proxy.inner().clone(),
        path,
        endpoint,
        filename,
        mime,
        size,
        fields,
        client_message_id,
    )
    .await
}

async fn upload_stream_path_core(
    app: tauri::AppHandle,
    proxy: ProxyState,
    path: String,
    endpoint: String,
    filename: String,
    mime: String,
    size: u64,
    fields: std::collections::HashMap<String, String>,
    client_message_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| format!("open file: {e}"))?;
    let actual_size = file
        .metadata()
        .await
        .map_err(|e| format!("file metadata: {e}"))?
        .len();
    if size > 0 && actual_size != size {
        return Err(format!(
            "file changed after selection (selected {size} bytes, now {actual_size} bytes)"
        ));
    }
    let size = if size > 0 { size } else { actual_size };
    upload_stream_open_file_core(
        app,
        proxy,
        file,
        endpoint,
        filename,
        mime,
        size,
        fields,
        client_message_id,
    )
    .await
}

/// Upload an already-open file descriptor without reopening it through a filesystem path.
///
/// Android document providers commonly return `content://` descriptors whose `/proc/self/fd/<n>`
/// symlink cannot be opened again (and pipe-backed providers may not have a reusable path at all).
/// Taking a `tokio::fs::File` here keeps the original picker grant alive for the whole request and
/// makes normal Rust ownership close the descriptor on success, error, or cancellation.
async fn upload_stream_open_file_core(
    app: tauri::AppHandle,
    proxy: ProxyState,
    mut file: tokio::fs::File,
    endpoint: String,
    filename: String,
    mime: String,
    size: u64,
    fields: std::collections::HashMap<String, String>,
    client_message_id: Option<String>,
) -> Result<serde_json::Value, String> {
    if !matches!(
        endpoint.as_str(),
        "/upload" | "/upload/file" | "/upload/video" | "/upload/audio" | "/upload/avatar"
    ) {
        return Err("unsupported upload endpoint".to_string());
    }
    if let Some(cid) = client_message_id.as_ref() {
        return upload_resumable_open_file(app, proxy, &mut file, filename, mime, size, cid).await;
    }
    let origin = proxy.api_origin.lock().expect("origin lock").clone();
    let url = format!("{}/api/v1{}", origin, endpoint);
    let client = proxy.api_client(&origin);
    let progress_id = client_message_id.clone();
    let mut loaded = 0_u64;
    let mut last_reported = 0_u64;
    let mut last_report_at = Instant::now();
    // Report at most roughly every 256 KiB / 100 ms. ReaderStream may yield very small chunks; emitting
    // every chunk would flood the WebView IPC on a fast multi-GB upload.
    let stream = tokio_util::io::ReaderStream::new(file).map(move |result| {
        if let Ok(bytes) = &result {
            loaded = loaded.saturating_add(bytes.len() as u64);
            let due_bytes = loaded.saturating_sub(last_reported) >= 256 * 1024;
            let due_time = last_report_at.elapsed() >= Duration::from_millis(100);
            if due_bytes || due_time || (size > 0 && loaded >= size) {
                if let Some(cid) = progress_id.as_ref() {
                    let _ = app.emit(
                        "upload-progress",
                        serde_json::json!({
                            "clientMessageId": cid,
                            "loaded": loaded,
                            "total": size,
                        }),
                    );
                }
                last_reported = loaded;
                last_report_at = Instant::now();
            }
        }
        result
    });
    let body = reqwest::Body::wrap_stream(stream);
    let part = if size > 0 {
        reqwest::multipart::Part::stream_with_length(body, size)
    } else {
        reqwest::multipart::Part::stream(body)
    }
    .file_name(filename)
    .mime_str(&mime)
    .map_err(|e| format!("mime: {e}"))?;
    let mut form = reqwest::multipart::Form::new();
    for (k, v) in fields {
        form = form.text(k, v);
    }
    form = form.part("file", part);
    let mut req = client.post(&url).multipart(form);
    if let Some(cid) = client_message_id.as_ref() {
        req = req.header("x-client-message-id", cid);
    }
    if let Some(t) = proxy.token.lock().ok().and_then(|g| g.clone()) {
        req = req.header("authorization", format!("Bearer {}", t));
    }
    // No send timeout: a large upload legitimately takes minutes, and a total-duration timeout would
    // wrongly abort it. `BACKEND_CONNECT_TIMEOUT` (on the cached client) already catches an unreachable
    // backend; a mid-upload stall is an accepted rare failure (the user can retry).
    let upload_cancel = CancellationToken::new();
    if let Some(cid) = client_message_id.as_ref() {
        proxy
            .upload_cancels
            .lock()
            .expect("upload_cancels lock")
            .insert(cid.clone(), upload_cancel.clone());
    }
    let send_result = tokio::select! {
        result = req.send() => Some(result),
        _ = upload_cancel.cancelled() => None,
    };
    if let Some(cid) = client_message_id.as_ref() {
        proxy
            .upload_cancels
            .lock()
            .expect("upload_cancels lock")
            .remove(cid);
    }
    let resp = match send_result {
        None => return Err("upload cancelled".to_string()),
        Some(Ok(r)) => r,
        Some(Err(e)) => {
            // Unreachable backend mid-upload: re-race select_origin so the user's RETRY hits the new active
            // origin. We do NOT re-issue the streaming upload here (re-opening the file + re-streaming is
            // the caller's job); non-network errors don't switch.
            if is_network_failure(&e) {
                runtime_switch(&proxy).await;
            }
            return Err(format!("upload send: {e}"));
        }
    };
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("upload read: {e}"))?;
    if !status.is_success() {
        return Err(format!("upload HTTP {}: {}", status.as_u16(), text));
    }
    // Return the raw envelope ({code,message,data}); the frontend reads it as StandardResponse<T>.
    serde_json::from_str::<serde_json::Value>(&text).map_err(|e| format!("upload parse: {e}"))
}

/// Native counterpart of the browser's sequential resumable protocol. The server owns the
/// authoritative offset; every retry re-initializes idempotently and resumes from that offset.
async fn upload_resumable_open_file(
    app: tauri::AppHandle,
    proxy: ProxyState,
    file: &mut tokio::fs::File,
    filename: String,
    mime: String,
    size: u64,
    client_message_id: &str,
) -> Result<serde_json::Value, String> {
    const FALLBACK_CHUNK: usize = 4 * 1024 * 1024;
    let origin = proxy.api_origin.lock().expect("origin lock").clone();
    let client = proxy.api_client(&origin);
    let token = proxy.token.lock().ok().and_then(|g| g.clone());
    let auth = |request: reqwest::RequestBuilder| {
        if let Some(value) = token.as_ref() {
            request.header("authorization", format!("Bearer {value}"))
        } else {
            request
        }
    };
    let init_url = format!("{origin}/api/v1/uploads/resumable/init");
    let init = auth(client.post(init_url).json(&serde_json::json!({
        "clientMessageId": client_message_id,
        "originalName": filename,
        "mimeType": if mime.is_empty() { "application/octet-stream" } else { &mime },
        "totalBytes": size,
    })))
    .send()
    .await
    .map_err(|e| format!("upload init: {e}"))?;
    let init_value = init
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("upload init parse: {e}"))?;
    if init_value.get("code").and_then(|v| v.as_i64()) != Some(0) {
        return Ok(init_value);
    }
    let upload_id = init_value
        .pointer("/data/uploadId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "upload init omitted uploadId".to_string())?
        .to_string();
    let status_url = format!("{origin}/api/v1/uploads/resumable/{upload_id}");
    let status = auth(client.get(&status_url))
        .send()
        .await
        .map_err(|e| format!("upload status: {e}"))?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("upload status parse: {e}"))?;
    if status.get("code").and_then(|v| v.as_i64()) != Some(0) {
        return Ok(status);
    }
    let mut offset = status
        .pointer("/data/offset")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let chunk_size = status
        .pointer("/data/chunkSize")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(FALLBACK_CHUNK);
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|e| format!("seek upload source: {e}"))?;
    let cancel = CancellationToken::new();
    proxy
        .upload_cancels
        .lock()
        .expect("upload_cancels lock")
        .insert(client_message_id.to_string(), cancel.clone());
    let transfer = async {
        while offset < size {
            let wanted =
                usize::try_from((size - offset).min(chunk_size as u64)).unwrap_or(chunk_size);
            let mut chunk = vec![0_u8; wanted];
            file.read_exact(&mut chunk)
                .await
                .map_err(|e| format!("read upload source: {e}"))?;
            let end = offset + wanted as u64 - 1;
            let response = auth(
                client
                    .put(&status_url)
                    .header("content-type", "application/octet-stream")
                    .header("content-range", format!("bytes {offset}-{end}/{size}"))
                    .body(chunk),
            )
            .send()
            .await
            .map_err(|e| format!("upload chunk: {e}"))?
            .json::<serde_json::Value>()
            .await
            .map_err(|e| format!("upload chunk parse: {e}"))?;
            if response.get("code").and_then(|v| v.as_i64()) != Some(0) {
                return Ok(response);
            }
            offset = response
                .pointer("/data/offset")
                .and_then(|v| v.as_u64())
                .unwrap_or(end + 1);
            let _ = app.emit(
                "upload-progress",
                serde_json::json!({
                    "clientMessageId": client_message_id,
                    "loaded": offset,
                    "total": size,
                }),
            );
        }
        auth(
            client
                .post(format!("{status_url}/complete"))
                .json(&serde_json::json!({})),
        )
        .send()
        .await
        .map_err(|e| format!("upload complete: {e}"))?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("upload complete parse: {e}"))
    };
    let result = tokio::select! {
        value = transfer => value,
        _ = cancel.cancelled() => Err("upload cancelled".to_string()),
    };
    proxy
        .upload_cancels
        .lock()
        .expect("upload_cancels lock")
        .remove(client_message_id);
    result
}

/// Android's source adapter transfers ownership of a readable descriptor (system-picker content URI or
/// app-private recorder file) to Rust. Only metadata crosses JNI; Rust adopts the descriptor itself
/// instead of reopening `/proc/self/fd/<n>`, which Android document providers may reject with EACCES.
/// The resulting `File` owns the descriptor and closes it on every completion/cancellation/error path.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustUploadBridge_uploadFd(
    mut env: jni::JNIEnv,
    _receiver: jni::objects::JObject,
    fd: jni::sys::jint,
    upload_id: jni::objects::JString,
    attempt_id: jni::objects::JString,
    endpoint: jni::objects::JString,
    filename: jni::objects::JString,
    mime: jni::objects::JString,
    size: jni::sys::jlong,
    fields_json: jni::objects::JString,
    client_message_id: jni::objects::JString,
) {
    if fd < 0 {
        return;
    }
    // SAFETY: Kotlin calls ParcelFileDescriptor.detachFd() immediately before this JNI method and
    // transfers sole ownership to Rust. Construct the owner before spawning so every later return or
    // panic drops the descriptor exactly once.
    let file = unsafe { std::fs::File::from_raw_fd(fd) };
    let read = |env: &mut jni::JNIEnv, value: jni::objects::JString| {
        env.get_string(&value)
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let upload_id = read(&mut env, upload_id);
    let attempt_id = read(&mut env, attempt_id);
    let endpoint = read(&mut env, endpoint);
    let filename = read(&mut env, filename);
    let mime = read(&mut env, mime);
    let fields_json = read(&mut env, fields_json);
    let client_message_id = read(&mut env, client_message_id);
    let fields = serde_json::from_str::<std::collections::HashMap<String, String>>(&fields_json)
        .unwrap_or_default();
    let Some(app) = ANDROID_APP.get().cloned() else {
        return;
    };
    let proxy = app.state::<ProxyState>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let result = upload_stream_open_file_core(
            app.clone(),
            proxy,
            tokio::fs::File::from_std(file),
            endpoint,
            filename,
            mime,
            size.max(0) as u64,
            fields,
            Some(client_message_id),
        )
        .await;
        let payload = match result {
            Ok(response) => serde_json::json!({
                "uploadId": upload_id,
                "attemptId": attempt_id,
                "ok": true,
                "response": response,
            }),
            Err(message) => serde_json::json!({
                "uploadId": upload_id,
                "attemptId": attempt_id,
                "ok": false,
                "message": message,
            }),
        };
        let _ = app.emit("native-upload-result", payload);
    });
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustUploadBridge_cancelUpload(
    mut env: jni::JNIEnv,
    _receiver: jni::objects::JObject,
    client_message_id: jni::objects::JString,
) {
    let Ok(client_message_id) = env.get_string(&client_message_id) else {
        return;
    };
    let Some(app) = ANDROID_APP.get() else {
        return;
    };
    cancel_upload(
        app.state::<ProxyState>(),
        client_message_id.to_string_lossy().into_owned(),
    );
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustUploadBridge_uploadVoicePath(
    mut env: jni::JNIEnv,
    _receiver: jni::objects::JObject,
    path: jni::objects::JString,
    context_id: jni::sys::jlong,
    thread_id: jni::sys::jlong,
    client_message_id: jni::objects::JString,
    duration_ms: jni::sys::jlong,
    size: jni::sys::jlong,
) {
    let read = |env: &mut jni::JNIEnv, value: jni::objects::JString| {
        env.get_string(&value)
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let path = read(&mut env, path);
    let client_message_id = read(&mut env, client_message_id);
    let Some(app) = ANDROID_APP.get().cloned() else {
        return;
    };
    let proxy = app.state::<ProxyState>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let emit_phase = |phase: &str, error: Option<&str>| {
            let _ = app.emit(
                "native-voice-upload",
                serde_json::json!({
                    "contextId": context_id,
                    "threadId": thread_id,
                    "clientMessageId": client_message_id,
                    "durationMs": duration_ms,
                    "size": size,
                    "phase": phase,
                    "error": error,
                }),
            );
        };
        emit_phase("started", None);
        let origin = proxy.api_origin.lock().expect("origin lock").clone();
        let token = proxy.token.lock().ok().and_then(|value| value.clone());
        let stage_body = serde_json::json!({
            "threadId": thread_id,
            "contentType": "AUDIO",
            "clientMessageId": client_message_id,
            "meta": { "duration": duration_ms as f64 / 1000.0 },
        })
        .to_string();
        let mut stage = proxy
            .api_client(&origin)
            .post(format!("{origin}/api/v1/send-media"))
            .header("content-type", "application/json")
            .body(stage_body);
        if let Some(token) = token {
            stage = stage.header("authorization", format!("Bearer {token}"));
        }
        let stage_result = async {
            let response = stage.send().await.map_err(|e| format!("stage send: {e}"))?;
            let status = response.status();
            let text = response
                .text()
                .await
                .map_err(|e| format!("stage read: {e}"))?;
            if !status.is_success() {
                return Err(format!("stage HTTP {}: {text}", status.as_u16()));
            }
            let envelope: serde_json::Value =
                serde_json::from_str(&text).map_err(|e| format!("stage parse: {e}"))?;
            if envelope.get("code").and_then(|v| v.as_i64()) != Some(0) {
                return Err(format!("stage rejected: {text}"));
            }
            Ok(())
        }
        .await;
        let result = match stage_result {
            Ok(()) => {
                upload_stream_path_core(
                    app.clone(),
                    proxy,
                    path.clone(),
                    "/upload/audio".to_string(),
                    "voice.m4a".to_string(),
                    "audio/mp4".to_string(),
                    size.max(0) as u64,
                    std::collections::HashMap::new(),
                    Some(client_message_id.clone()),
                )
                .await
            }
            Err(error) => Err(error),
        };
        match result {
            Ok(response) if response.get("code").and_then(|v| v.as_i64()) == Some(0) => {
                emit_phase("completed", None)
            }
            Ok(response) => emit_phase("failed", Some(&format!("upload rejected: {response}"))),
            Err(error) => emit_phase("failed", Some(&error)),
        }
        let _ = fs::remove_file(path);
    });
}

/// Cancel one shell streaming upload. Idempotent: a task that already completed or has not reached the
/// streaming phase simply has no token. Browser cancellation remains owned by HttpClient unsubscribe.
#[tauri::command]
fn cancel_upload(proxy: tauri::State<'_, ProxyState>, client_message_id: String) {
    if let Some(token) = proxy
        .upload_cancels
        .lock()
        .expect("upload_cancels lock")
        .remove(&client_message_id)
    {
        token.cancel();
    }
}

// --- diagnostics reporting (field-support log bundle upload) ------------------------------
//
// Builds a gzip tar of the client's Rust logs (app_log_dir/*) + the webview console capture (passed
// from JS) + a version manifest, and POSTs it DIRECTLY to ${origin}/api/v1/diagnostics/report. Rust owns
// the bundle build + the upload (NOT the webview): the log files only Rust can read, multi-MB bytes are
// awkward over Tauri IPC, and this mirrors the SSE supervisor's direct-reqwest-to-origin pattern + the
// "Rust owns all backend traffic under Tauri" rule. Offline resilience: on any failure the tar (+ a
// manifest sidecar) is kept under app_cache_dir()/pending-* and retried fire-and-forget on the next app
// launch (setup()), so a report captured during a network outage is never lost. The bundle's sha256 is
// both the filename and the POST's X-Request-Id (correlates the upload ↔ the bundle ↔ the server's pino
// req.id) — no uuid crate needed.

/// Prefix for cached, not-yet-uploaded diagnostic bundles + their manifest sidecars under app_cache_dir():
/// `pending-<sha256>.tar.gz` + `pending-<sha256>.manifest.json`.
const DIAG_PENDING_PREFIX: &str = "pending-";
/// Drop cached pending bundles older than this (the client-side cache cap — repeated offline failures
/// must not fill app_cache_dir). Generous: a transient outage clears within minutes.
const DIAG_PENDING_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// Size cap on the durable `webview-console.log` mirror (under `app_log_dir`). The JS ring buffer appends
/// its captured entries here across restarts via `log_js`; once the file exceeds this cap it is
/// front-trimmed to half (a ring-on-disk: the newest tail survives, mirroring the JS in-memory ring's
/// semantics). 1 MiB matches SOMS.log's per-file rotation size, so the bundle's JS slice is bounded the
/// same way the Rust slice is. (The backend's per-bundle cap is 16 MiB; logs ≈6 + console 1 + manifest
/// stays well under.)
const WEBVIEW_CONSOLE_MAX: usize = 1024 * 1024;

/// sha256(bytes) → lowercase hex (the bundle filename + the POST's X-Request-Id). The input is hashed
/// inside; nothing here is secret (a bundle digest is not sensitive).
fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest.iter() {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

/// Current time as ISO-8601 UTC `YYYY-MM-DDTHH:MM:SS.mmmZ`, dependency-free (chrono/time are only
/// transitive deps). Used by the log formatter — see the `.format(...)` note on the log Builder.
fn iso_utc_now() -> String {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let ms = dur.subsec_millis();
    let sod = secs.rem_euclid(86_400); // seconds-of-day
    let days = (secs / 86_400) as i64; // days since 1970-01-01
                                       // Howard Hinnant's civil_from_days — days since Unix epoch → (year, month, day).
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year,
        m,
        d,
        sod / 3600,
        (sod / 60) % 60,
        sod % 60,
        ms,
    )
}

/// Append one `name` → `bytes` entry to the in-memory tar (mode 0644; size set explicitly so the entry
/// is well-formed regardless of the reader's reported length).
fn tar_add_file(
    builder: &mut tar::Builder<&mut Vec<u8>>,
    name: &str,
    bytes: &[u8],
) -> std::io::Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    builder.append_data(&mut header, name, &mut std::io::Cursor::new(bytes))
}

/// Build the diagnostic bundle (gzip tar): `manifest.json` + `rust/<each app_log_dir file>` +
/// `webview-console.log` + (when present) `native/kotlin.log`. Returns the compressed bytes. The three
/// payloads are non-overlapping by layer (JS console / Rust files / Kotlin native log): Rust is no longer
/// mirrored into the JS console, so there is no cross-layer duplication — correlation happens at view time
/// in the debug panel, not capture time.
fn build_diagnostics_bundle(
    log_dir: &Path,
    console: &[u8],
    manifest: &serde_json::Value,
    native_log: Option<&[u8]>,
) -> std::io::Result<Vec<u8>> {
    let manifest_json = serde_json::to_vec_pretty(manifest).unwrap_or_else(|_| b"{}".to_vec());
    let mut tar_buf: Vec<u8> = Vec::new();
    {
        let mut builder = tar::Builder::new(&mut tar_buf);
        tar_add_file(&mut builder, "manifest.json", &manifest_json)?;
        tar_add_file(&mut builder, "webview-console.log", console)?;
        // The Kotlin `native.log` (Android only; debug builds enable it immediately, release enables it
        // through the runtime debug gate). Absent on desktop or before first enable; skipped silently so
        // the bundle stays layered without forcing every platform to produce one.
        if let Some(bytes) = native_log {
            if !bytes.is_empty() {
                tar_add_file(&mut builder, "native/kotlin.log", bytes)?;
            }
        }
        // Every regular file in the log dir (the tauri-plugin-log SOMS.log + its rotations). Robust to the
        // rotation naming; the dir is dedicated to this app's logs, so including all of it is safe.
        if let Ok(entries) = fs::read_dir(log_dir) {
            for entry in entries.flatten() {
                if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    if let Ok(bytes) = fs::read(entry.path()) {
                        let name = entry.file_name().to_string_lossy().into_owned();
                        tar_add_file(&mut builder, &format!("rust/{name}"), &bytes)?;
                    }
                }
            }
        }
        builder.finish()?;
    }
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&tar_buf)?;
    encoder.finish()
}

/// POST one diagnostic bundle to the backend. On success (HTTP 2xx + envelope code 0) returns the new
/// report id; otherwise an Err string (the caller keeps the cached bundle for retry). `request_id` is
/// both the X-Request-Id (→ pino req.id) and the on-disk bundle's sha256.
async fn post_diagnostics_bundle(
    proxy: &ProxyState,
    bundle: &[u8],
    manifest: &serde_json::Value,
    request_id: &str,
) -> Result<i64, String> {
    let origin = proxy.api_origin.lock().expect("origin lock").clone();
    let url = format!("{}/api/v1/diagnostics/report", origin.trim_end_matches('/'));
    let client = proxy.api_client(&origin);
    let part = reqwest::multipart::Part::bytes(bundle.to_vec())
        .file_name("bundle.tar.gz")
        .mime_str("application/gzip")
        .map_err(|e| format!("mime: {e}"))?;
    let form = reqwest::multipart::Form::new()
        .text("manifest", manifest.to_string())
        .part("bundle", part);
    let mut req = client
        .post(&url)
        .multipart(form)
        .header("x-request-id", request_id);
    if let Some(t) = proxy.token.lock().ok().and_then(|g| g.clone()) {
        req = req.header("authorization", format!("Bearer {}", t));
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            // Network failure: re-race select_origin so the NEXT retry (this launch's loop or the next
            // launch's retry_pending_diagnostics) targets the reachable origin. Diagnostics are best-effort
            // + cached on failure, so we don't retry in-line — just fix connectivity for the next attempt.
            if is_network_failure(&e) {
                runtime_switch(proxy).await;
            }
            return Err(format!("diagnostics send: {e}"));
        }
    };
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("diagnostics read: {e}"))?;
    if !status.is_success() {
        return Err(format!("diagnostics HTTP {}: {}", status.as_u16(), text));
    }
    let envelope: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("diagnostics parse: {e}"))?;
    if envelope.get("code").and_then(|v| v.as_i64()) != Some(0) {
        return Err(format!("diagnostics rejected by backend: {envelope}"));
    }
    envelope
        .pointer("/data/id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "diagnostics response missing data.id".to_string())
}

/// On-launch retry: re-POST every cached pending bundle (captured during a prior network outage) and
/// drop the ones that succeed. Best-effort + fire-and-forget (spawned from setup). First sweeps pending
/// bundles older than the cache cap so repeated offline failures can't fill app_cache_dir.
async fn retry_pending_diagnostics(app: tauri::AppHandle, proxy: ProxyState) {
    let cache_dir = match app.path().app_cache_dir() {
        Ok(d) => d,
        Err(_) => return,
    };
    let cutoff = SystemTime::now() - DIAG_PENDING_TTL;
    let mut pendings: Vec<(PathBuf, PathBuf, String, serde_json::Value, Vec<u8>)> = Vec::new();
    if let Ok(entries) = fs::read_dir(&cache_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with(DIAG_PENDING_PREFIX) || !name.ends_with(".tar.gz") {
                continue;
            }
            // Cache cap: drop tars (and their manifest sidecars) older than the TTL.
            if entry
                .metadata()
                .and_then(|m| m.modified())
                .map(|m| m < cutoff)
                .unwrap_or(false)
            {
                let _ = fs::remove_file(&path);
                continue;
            }
            let digest = &name[DIAG_PENDING_PREFIX.len()..name.len() - ".tar.gz".len()];
            let manifest_path =
                cache_dir.join(format!("{DIAG_PENDING_PREFIX}{digest}.manifest.json"));
            let manifest = fs::read_to_string(&manifest_path)
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .unwrap_or_else(|| serde_json::json!({}));
            if let Ok(bundle) = fs::read(&path) {
                pendings.push((path, manifest_path, digest.to_string(), manifest, bundle));
            }
        }
    }
    for (tar_path, manifest_path, digest, manifest, bundle) in pendings {
        match post_diagnostics_bundle(&proxy, &bundle, &manifest, &digest).await {
            Ok(_) => {
                let _ = fs::remove_file(&tar_path);
                let _ = fs::remove_file(&manifest_path);
                log::info!("diagnostics retry: delivered cached bundle {digest}");
            }
            Err(e) => log::warn!("diagnostics retry: bundle {digest} still failing: {e}"),
        }
    }
}

/// Serialize appends to the durable `webview-console.log` so overlapping (batched, fire-and-forget)
/// `log_js` calls can't interleave half-lines. Held only across synchronous fs ops (no `.await` while
/// held), which keeps it safe for `std::sync::Mutex`.
static WEBVIEW_CONSOLE_LOCK: Mutex<()> = Mutex::new(());

/// The durable webview JS-console slice — the mirror the JS ring buffer (`web/.../log-buffer.ts`) appends
/// to across restarts via `log_js`. Lives next to `SOMS.log` under `app_log_dir` so the diagnostic bundle
/// builds it from the same durable store as the Rust logs (and survives a crash/relaunch with the
/// pre-crash JS trail intact — the in-memory ring buffer alone is lost on restart).
fn webview_console_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_log_dir()
        .ok()
        .map(|d| d.join("webview-console.log"))
}

/// Front-trim `path` to its newest `keep` bytes on a line boundary (a ring-on-disk). Called only when the
/// file exceeds `WEBVIEW_CONSOLE_MAX`; whole-line granularity so no entry is split. The rewrite is atomic
/// (write a sibling `.tmp` then rename over) so a crash mid-trim — or a concurrent reader — can never see
/// a truncated/torn file. Best-effort: any I/O error leaves the file as-is (diagnostics must never break
/// the app).
fn trim_webview_console_front(path: &Path, keep: usize) {
    let Ok(bytes) = fs::read(path) else { return };
    if bytes.len() <= keep {
        return;
    }
    // Advance from `keep` to the next newline so the trimmed head begins on a line boundary.
    let start = bytes[keep..]
        .iter()
        .position(|b| *b == b'\n')
        .map(|i| keep + i + 1)
        .unwrap_or(bytes.len());
    // Same-directory temp + rename = atomic on POSIX/Windows; a crash between write and rename leaves
    // the original untouched (the orphan `.tmp` is harmless, overwritten next trim).
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    if fs::write(&tmp, &bytes[start..]).is_err() {
        let _ = fs::remove_file(&tmp);
        return;
    }
    let _ = fs::rename(&tmp, path);
}

#[cfg(test)]
#[path = "tests/webview_console_trim_tests.rs"]
mod webview_console_trim_tests;

/// Raise/lower the process-wide native log cap alongside the web debug-tools gate. The plugin's sink is
/// configured for Debug, so this cheap facade-level filter prevents message formatting and file I/O in
/// normal release operation. Error remains available when debug tools are disabled.
#[tauri::command]
fn set_debug_logging(enabled: bool) {
    log::set_max_level(if enabled {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Error
    });
}

/// Append the JS console's batched flush to the durable `webview-console.log` (or truncate it when `clear`
/// is set — the debug panel's "clear" wipes both the live ring and the durable record together).
/// Throttled/batched from `log-buffer.ts`; a missing/unwritable log dir is a silent no-op. Registered on
/// every platform (desktop + Android) so the JS slice is durable wherever diagnostics can be reported.
///
/// SYNC deliberately: the work is blocking fs I/O (open/append/metadata/trim), and a sync Tauri command
/// runs on the command thread pool, OFF the async reactor — so a chatty console burst can't stall the
/// SSE supervisor / IPC that share that reactor. `report_diagnostics` reads the same file under the same
/// lock, so the two never see a torn file.
#[tauri::command]
fn log_js(app: tauri::AppHandle, lines: Vec<String>, clear: Option<bool>) -> Result<(), String> {
    let path = match webview_console_path(&app) {
        Some(p) => p,
        None => return Ok(()),
    };
    let _guard = WEBVIEW_CONSOLE_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if clear.unwrap_or(false) {
        // Truncate to empty — the durable counterpart of clearConsoleBuffer.
        let _ = fs::write(&path, b"");
        return Ok(());
    }
    if lines.is_empty() {
        return Ok(());
    }
    {
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("open webview-console: {e}"))?;
        for line in &lines {
            writeln!(f, "{line}").map_err(|e| format!("write webview-console: {e}"))?;
        }
        f.flush().ok();
    }
    if let Ok(meta) = fs::metadata(&path) {
        if (meta.len() as usize) > WEBVIEW_CONSOLE_MAX {
            trim_webview_console_front(&path, WEBVIEW_CONSOLE_MAX / 2);
        }
    }
    Ok(())
}

/// Build + upload one diagnostic bundle (the Settings "Report" action). On success the cached tar +
/// manifest sidecar are deleted and the new report id is returned; on any failure they are KEPT for the
/// next-launch retry and an Err is returned (the frontend shows "saved locally, will retry"). NOT
/// desktop-gated: works on Android too (the log files + reqwest + flate2/tar are all cross-platform).
#[tauri::command]
async fn report_diagnostics(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ProxyState>,
    manifest: serde_json::Value,
) -> Result<i64, String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("log dir: {e}"))?;
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cache dir: {e}"))?;
    fs::create_dir_all(&cache_dir).map_err(|e| format!("cache mkdir: {e}"))?;
    // The webview JS-console slice is the durable mirror the JS ring buffer appends to across restarts
    // (log_js → app_log_dir/webview-console.log). Read it here so a report — even right after a crash/
    // relaunch, when the in-memory ring is empty — still carries the pre-crash JS trail. The file is
    // already size-capped (front-trimmed by log_js); missing on a first run before any capture → empty.
    //
    // Read on a BLOCKING thread (spawn_blocking) under the same lock `log_js` holds while writing, so the
    // read never parks an async-reactor worker on the mutex: like `log_js` (a sync command), this file
    // accessor runs off-reactor, and the lock serializes the two. A JoinError (the blocking task panicked)
    // → empty slice (treat as no JS trail rather than fail the whole report).
    let app_for_read = app.clone();
    let console: Vec<u8> = tokio::task::spawn_blocking(move || {
        let _guard = WEBVIEW_CONSOLE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        webview_console_path(&app_for_read)
            .and_then(|p| fs::read(p).ok())
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default();
    // The Kotlin native log is Android `Context.getFilesDir()/soms-native.log` (Tauri's `app_data_dir()` is
    // the data ROOT, so it lives under `files/`). Absent on desktop or before runtime debug is first
    // enabled → None → the bundle omits the native/ entry. Best-effort: a missing/unreadable file is not a
    // diagnostics failure.
    let native_log: Option<Vec<u8>> = kotlin_native_log_path(&app).and_then(|p| fs::read(p).ok());
    let bundle = build_diagnostics_bundle(&log_dir, &console, &manifest, native_log.as_deref())
        .map_err(|e| format!("build bundle: {e}"))?;
    let digest = sha256_hex(&bundle);
    let tar_path = cache_dir.join(format!("{DIAG_PENDING_PREFIX}{digest}.tar.gz"));
    let manifest_path = cache_dir.join(format!("{DIAG_PENDING_PREFIX}{digest}.manifest.json"));
    // Persist the bundle + manifest sidecar BEFORE the upload so an upload-time crash leaves a retryable
    // pending pair (the next launch's retry_pending_diagnostics re-POSTs them).
    fs::write(&tar_path, &bundle).map_err(|e| format!("write bundle: {e}"))?;
    fs::write(&manifest_path, manifest.to_string()).map_err(|e| format!("write manifest: {e}"))?;
    let id = match post_diagnostics_bundle(&proxy, &bundle, &manifest, &digest).await {
        Ok(id) => id,
        Err(e) => {
            warn!("diagnostics upload failed (cached for retry): {e}");
            return Err(e);
        }
    };
    // Delivered — drop the cached pair.
    let _ = fs::remove_file(&tar_path);
    let _ = fs::remove_file(&manifest_path);
    Ok(id)
}

// --- native log tail (debug panel) ---------------------------------------------------------

/// Which native log the debug panel tails. `Rust` = the tauri-plugin-log file under `app_log_dir`;
/// `Kotlin` = the Android `filesDir/soms-native.log` written by `SomsLog` while runtime debug is enabled.
#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum NativeLogSource {
    Rust,
    Kotlin,
}

/// The tailed native log returned to the debug panel.
#[derive(serde::Serialize)]
struct NativeLogTail {
    /// Absolute path read (for the panel's "which file was this" debug). Empty when the source has no file.
    path: String,
    /// The last `tail_lines` lines (UTF-8 lossy). Empty when the source is absent on this platform.
    content: String,
}

/// The last `n` newline-delimited lines of `text` (joined by `\n`); `n == 0` or empty text → "".
fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

/// The most-recently-modified regular file in `dir` — the active log being appended (robust to the
/// tauri-plugin-log rotation naming, which is not hardcoded here). None when the dir has no files.
fn newest_file(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(PathBuf, SystemTime)> = None;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            if let Ok(m) = entry.metadata().and_then(|meta| meta.modified()) {
                if best.as_ref().map(|(_, t)| &m > t).unwrap_or(true) {
                    best = Some((entry.path(), m));
                }
            }
        }
    }
    best.map(|(p, _)| p)
}

/// Tail a native log for the debug panel (Settings→About 10-tap gesture → FAB → overlay). Reads ONLY the
/// active `tauri-plugin-log` file in `app_log_dir` (rust) or `app_data_dir/soms-native.log` (kotlin) — BY
/// NAME, never a caller-supplied path — so this cannot be used as a generic file-read surface. A
/// missing/unreadable file returns `{ path: "", content: "" }`; the panel renders the source as "n/a".
#[tauri::command]
fn read_native_log(
    app: tauri::AppHandle,
    source: NativeLogSource,
    tail_lines: usize,
) -> Result<NativeLogTail, String> {
    let path: Option<PathBuf> = match source {
        NativeLogSource::Rust => app.path().app_log_dir().ok().and_then(|d| newest_file(&d)),
        NativeLogSource::Kotlin => kotlin_native_log_path(&app),
    };
    let Some(path) = path else {
        return Ok(NativeLogTail {
            path: String::new(),
            content: String::new(),
        });
    };
    let bytes = fs::read(&path).unwrap_or_default();
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(NativeLogTail {
        path: path.to_string_lossy().into_owned(),
        content: last_lines(&text, tail_lines),
    })
}

/// Resolve the Kotlin `SomsLog` sink: Android `Context.getFilesDir()/soms-native.log`. Tauri's
/// `app_data_dir()` resolves to the app's DATA ROOT (NOT `filesDir`), so the file lives under `files/`. The
/// data root is also probed as a fallback — a future Tauri path-resolver change that shifted the base would
/// otherwise silently empty the debug panel's Kotlin tab again (the original bug: the panel read
/// `app_data_dir/soms-native.log` while Kotlin wrote `…/files/soms-native.log`). Returns None if neither path
/// exists (desktop + release before runtime debug has ever been enabled).
fn kotlin_native_log_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let root = app.path().app_data_dir().ok()?;
    [
        root.join("files").join("soms-native.log"),
        root.join("soms-native.log"),
    ]
    .into_iter()
    .find(|p| p.exists())
}

// --- frontend-facing commands (origin + token) --------------------------------------------

#[tauri::command]
fn get_api_origin(state: tauri::State<'_, ProxyState>) -> String {
    // Returns the user-configured PRIMARY (stable) — NOT the swapping active origin. On native, request
    // URLs are built in Rust from the active `api_origin` (which select_origin may flip to the secondary);
    // JS never needs the active for URL building, and seeding the JS signal from the stable primary keeps
    // the origin-change SSE effect from firing on a fallback switch. The active MODE is exposed via
    // get_origin_mode (for the "正在使用内网服务器" indicator).
    state
        .api_origin_primary
        .lock()
        .expect("primary lock")
        .clone()
}

/// The exact endpoint every Rust-owned HTTP transport uses right now. Unlike `get_api_origin` this is
/// runtime state: `init_pick_origin`, desktop failover, or Android's `set_active_origin` may change it
/// without changing either configured address.
#[tauri::command]
fn get_active_api_origin(state: tauri::State<'_, ProxyState>) -> String {
    state.api_origin.lock().expect("origin lock").clone()
}

/// Whether a real backend origin has been configured — the authoritative "has a SOMS backend been
/// configured" check the SPA's configGuard uses, independent of the frontend's secureStore-seeded signal
/// (which can drift). The ProxyState default is a non-routable placeholder (`DEFAULT_API_ORIGIN`), so a
/// non-empty origin is NOT enough: it must also differ from the placeholder.
#[tauri::command]
fn is_origin_configured(state: tauri::State<'_, ProxyState>) -> bool {
    // Reads the PRIMARY — a fallback swap to the secondary must NOT flip this to "configured" (nor must a
    // swap back trip it). The guard asks "did the user configure a real backend" = primary configured.
    let origin = state.api_origin_primary.lock().expect("primary lock");
    !origin.is_empty() && *origin != DEFAULT_API_ORIGIN
}

/// Persist a new backend origin. Legacy entry point (the bundled bootstrap also reaches this via
/// `persist_origin` inside `init_download_web`). Returns the canonical origin Rust stored.
#[tauri::command]
fn set_api_origin(url: String, state: tauri::State<'_, ProxyState>) -> Result<String, String> {
    persist_origin(&state, &url)
}

/// The configured LAN (secondary) origin, or null when no fallback is configured (dev, or servers without
/// SOMS_LAN_DOMAIN). The shell uses this to populate the second server-config field + persist it.
#[tauri::command]
fn get_api_origin_secondary(state: tauri::State<'_, ProxyState>) -> Option<String> {
    state
        .api_origin_secondary
        .lock()
        .expect("secondary lock")
        .clone()
}

/// Persist the LAN (secondary) origin (field-2). Empty/null clears it (disables fallback). Returns the
/// canonical value Rust stored (Some url, or None when cleared).
#[tauri::command]
fn set_api_origin_secondary(
    url: Option<String>,
    state: tauri::State<'_, ProxyState>,
) -> Result<Option<String>, String> {
    persist_origin_secondary(&state, url.as_deref())
}

/// Which origin is currently ACTIVE — for the "正在使用内网服务器" indicator. `primary` = normal;
/// `secondary` = the primary was unreachable and a switch moved to the LAN origin.
#[tauri::command]
fn get_origin_mode(state: tauri::State<'_, ProxyState>) -> String {
    match *state.origin_mode.lock().expect("mode lock") {
        OriginMode::Primary => "primary".to_string(),
        OriginMode::Secondary => "secondary".to_string(),
    }
}

/// Login initialization — the CONCURRENT race. Probe both origins' `/health`, pick the reachable one, set
/// it active. Called by the shell ONCE before the auth request, so login targets a reachable origin (on the
/// LAN the public origin is hairpin-unreachable). Pre-token (no SSE yet) — health is the only probe that
/// works. No-op when no secondary is configured (single-origin). Returns the active origin Rust picked.
#[tauri::command]
async fn init_pick_origin(state: tauri::State<'_, ProxyState>) -> Result<String, String> {
    pick_origin_race(&state).await;
    Ok(state.api_origin.lock().expect("origin lock").clone())
}

/// Android passive-accept: Kotlin (the SSE authority on Android) signals which origin is active; Rust sets
/// it WITHOUT probing/switching (it's not the authority there). Desktop doesn't call this (Rust decides).
/// Sets the ACTIVE origin only (the primary/secondary config is owned by set_api_origin[_secondary]).
#[tauri::command]
fn set_active_origin(url: String, state: tauri::State<'_, ProxyState>) -> Result<String, String> {
    let normalized =
        validate_origin(&url).ok_or_else(|| format!("not a valid http(s) URL: {url}"))?;
    let secondary = state
        .api_origin_secondary
        .lock()
        .expect("secondary lock")
        .clone();
    let mode = if Some(&normalized) == secondary.as_ref() {
        OriginMode::Secondary
    } else {
        OriginMode::Primary
    };
    activate_origin(&state, &normalized, mode);
    Ok(normalized)
}

#[tauri::command]
fn set_session_token(token: String, state: tauri::State<'_, ProxyState>) {
    if let Ok(mut g) = state.token.lock() {
        *g = Some(token);
        // Wake a desktop SSE supervisor blocked in its pre-login token wait (mobile SSE is Kotlin-owned
        // and never waits on this; the extra notify is a harmless no-permit-consumer wakeup).
        drop(g);
        state.token_notify.notify_one();
    }
}

#[tauri::command]
fn clear_session_token(state: tauri::State<'_, ProxyState>) {
    if let Ok(mut g) = state.token.lock() {
        *g = None;
    }
}

/// End the currently attached native session without tying UI progress to the old backend.
///
/// The token is TAKEN from the global proxy state before this command returns, so requests aimed at a
/// subsequently configured server can never inherit it. The remote revoke owns the captured token + origin
/// and runs in the background; it cannot later clear or redirect a newer session. Desktop keyring deletion
/// is performed synchronously before spawning so a fast account/server switch cannot race a stale delete.
#[tauri::command]
fn begin_logout(origin: String, state: tauri::State<'_, ProxyState>) -> Result<(), String> {
    let token = state.token.lock().ok().and_then(|mut token| token.take());

    #[cfg(desktop)]
    secure_storage::secure_clear_token()?;

    // The frontend snapshots the old configured origin before navigating. Never re-read the mutable active
    // origin here: a delayed IPC dispatch after reconfiguration must not send the old token to the new host.
    // An empty/invalid origin can occur only in a drifted/first-run shell; local logout still succeeds.
    let Some(origin) = validate_origin(&origin) else {
        return Ok(());
    };
    let client = state.api_client(&origin);

    if let Some(token) = token {
        tauri::async_runtime::spawn(async move {
            let target = format!("{origin}/api/v1/auth/logout");
            let request = client
                .post(&target)
                .header("authorization", format!("Bearer {token}"))
                .json(&serde_json::json!({}));
            match send_with_headers_deadline(request, API_HEADERS_TIMEOUT).await {
                Ok(response) if response.status().is_success() => {}
                Ok(response) => warn!(
                    "background logout {target} returned HTTP {}",
                    response.status()
                ),
                Err(HeadersError::SendFailed(error)) => {
                    warn!("background logout {target} failed: {error}")
                }
                Err(HeadersError::Timeout) => {
                    warn!("background logout {target} timed out")
                }
            }
        });
    }
    Ok(())
}

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
/// (STATE_REV_UPDATED / NEW_MESSAGE) so a re-attached
/// webview can be handed a FRESH handshake via `sse_replay_hello` without a reconnect (a retained open
/// stream does not re-push HELLO on its own).
#[cfg(desktop)]
struct SseSupervisor {
    cancel: Mutex<Option<CancellationToken>>,
    handle: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    state: Arc<Mutex<ConnectionState>>,
    wake: Arc<Notify>,
    offline: Arc<AtomicBool>,
    cached_hello: Arc<Mutex<Option<serde_json::Value>>>,
}

#[cfg(desktop)]
impl SseSupervisor {
    fn new() -> Self {
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
fn sse_start(
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
fn sse_stop(app: tauri::AppHandle, sse: tauri::State<'_, SseSupervisor>) -> Result<(), String> {
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
fn sse_get_state(sse: tauri::State<'_, SseSupervisor>) -> String {
    conn_state_str(*sse.state.lock().expect("sse state lock")).to_string()
}

/// The webview's `navigator` online/offline is the one source that knows the network dropped before the
/// 60s watchdog would (dropped wifi → half-open TCP → reqwest blocks near-forever). The JS transport
/// forwards both transitions here (and reuses `online=true` for user-initiated retry). `wake` releases
/// the supervisor's current await — an open-stream read OR a backoff sleep — and the loop re-checks
/// `offline` to decide immediate-retry vs. drop-the-stream.
#[cfg(desktop)]
#[tauri::command]
fn sse_net(online: bool, sse: tauri::State<'_, SseSupervisor>) -> Result<(), String> {
    sse.offline.store(!online, Ordering::Release);
    sse.wake.notify_one();
    Ok(())
}

/// Hand a freshly-attached webview the cached HELLO. A retained open stream does NOT re-push HELLO (it is
/// sent once per `register`), yet a re-attached webview (renderer reclaim, or an Android cold start where the
/// FGS opened `/events` before the webview mounted) needs one to bootstrap (userId / threadRevision /
/// profileRev / latestMessage). The supervisor caches the last HELLO and merges every
/// incremental revision frame into it (see `open_one_stream`), so this replays the CURRENT merged HELLO down
/// the same `soms-sse-event` channel the original used — no reconnect, no connection churn, no event gap.
/// `app.emit` broadcasts to all webviews (a live webview receiving a second HELLO just re-runs its idempotent
/// onHello). No-op when the cache is empty (the facade's HELLO-timeout backstop then force-reconnects for a
/// fresh one). Mirrors Android's `SomsFcm.replayHello`.
#[cfg(desktop)]
#[tauri::command]
fn sse_replay_hello(
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
        "STATE_REV_UPDATED" => {
            if let Some(inc) = data.get("stateRevision").and_then(|v| v.as_i64()) {
                let cur = obj.get("stateRevision").and_then(|v| v.as_i64());
                if cur.is_none_or(|c| inc >= c) {
                    obj.insert("stateRevision".to_string(), serde_json::Value::from(inc));
                }
            }
        }
        // latestMessage = {threadId, seq, ts} — last-signal-wins (a valid upper bound for the missed walk,
        // mirroring the client's onNewMessage `_to` advancement).
        "NEW_MESSAGE" => {
            if let (Some(tid), Some(seq), Some(ts)) = (
                data.get("threadId").cloned(),
                data.get("seq").cloned(),
                data.get("ts").cloned(),
            ) {
                obj.insert(
                    "latestMessage".to_string(),
                    serde_json::json!({ "threadId": tid, "seq": seq, "ts": ts }),
                );
            }
        }
        _ => {}
    }
}

#[cfg(all(test, desktop))]
#[path = "tests/cached_hello_merge_tests.rs"]
mod cached_hello_merge_tests;

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

// Origin parsing + TLS posture — the security boundary that decides whether a backend origin gets
// strict TLS validation or permissive (self-signed/cleartext accepted). Pure (no reqwest client, no
// network), so these run on EVERY target — unlike the desktop-only `sse_parser_tests` above.
#[cfg(test)]
#[path = "tests/origin_tests.rs"]
mod origin_tests;

// send_with_headers_deadline — the bounded-headers send shared by api_request + media_request. The
// contract that matters: a connected-but-silent upstream yields `HeadersError::Timeout` (→ HTTP 504),
// NOT a connect failure. Driven with a real socket so no mock-server crate is needed — just std::net
// + a thread that accepts then holds the connection open without responding.
#[cfg(test)]
#[path = "tests/headers_deadline_tests.rs"]
mod headers_deadline_tests;

#[cfg(test)]
#[path = "tests/select_origin_tests.rs"]
mod select_origin_tests;

// --- shell dynamic-update: init_* + window lifecycle ---------------------------------------

#[tauri::command]
fn get_shell_version() -> String {
    SHELL_VERSION.to_string()
}

#[derive(serde::Deserialize)]
struct ApiEnvelope<T> {
    code: i64,
    data: Option<T>,
}

#[derive(serde::Deserialize)]
struct CompatData {
    #[serde(rename = "serverVersion")]
    server_version: String,
    /// The server's canonical PRIMARY origin (advertised for the shell's symmetric auto-fill). Optional —
    /// older servers don't advertise it. See src/shell/shell.service.ts compat() + src/common/origin.ts.
    #[serde(rename = "primaryOrigin", default)]
    primary_origin: Option<String>,
    /// The server's LAN (secondary) origin, when SOMS_LAN_DOMAIN is configured. Optional.
    #[serde(rename = "lanOrigin", default)]
    lan_origin: Option<String>,
    /// The Firebase client config folded into /shell/compat (the Android shell inits FirebaseApp from this
    /// at runtime — replaces a separate /push/firebase-config round-trip). Raw passthrough: the shell hands
    /// it straight back to JS unchanged, so a typed struct would only add a match risk. Null on older servers.
    #[serde(rename = "firebaseConfig", default)]
    firebase_config: Option<serde_json::Value>,
}

/// Fetch the server's reported version from `/shell/compat`. The server carries no shell floor — it only
/// reports `serverVersion`; the shell decides compatibility against `COMPAT_BACKEND_MAX`. Shared by the
/// compat gate, the download-time re-check, and the launch update-status probe. Connectivity /
/// bad-response errors are tagged `address:` so the wizard's `errorKeyFor` maps them to `sc.addrErr`
/// (wrong port, offline, or not a SOMS backend) — distinct from a true version mismatch (`sc.compatErr`,
/// raised separately by `init_check_compat` when `serverVersion >= COMPAT_BACKEND_MAX`).
async fn fetch_server_version(client: &reqwest::Client, origin: &str) -> Result<String, String> {
    let base = origin.trim_end_matches('/');
    let resp = client
        .get(format!("{base}/api/v1/shell/compat"))
        .send()
        .await
        .map_err(|e| format!("address: could not reach server: {e}"))?;
    let env: ApiEnvelope<CompatData> = serde_json::from_str(
        &resp
            .text()
            .await
            .map_err(|e| format!("address: could not read server response: {e}"))?,
    )
    .map_err(|e| format!("address: invalid server response (not a SOMS backend?): {e}"))?;
    if env.code != 0 {
        return Err(format!(
            "address: server returned code {} (not a SOMS backend?)",
            env.code
        ));
    }
    Ok(env
        .data
        .map(|d| d.server_version.trim().to_string())
        .unwrap_or_default())
}

/// Fetch the FULL `/shell/compat` body (version + the advertised client origins), for `init_check_compat`
/// to surface `primaryOrigin`/`lanOrigin` to the shell's symmetric auto-fill. Errors tagged `address:`
/// (parity with `fetch_server_version`, which stays the minimal version-only path the download +
/// update-status probes use).
async fn fetch_compat(client: &reqwest::Client, origin: &str) -> Result<CompatData, String> {
    let base = origin.trim_end_matches('/');
    let resp = client
        .get(format!("{base}/api/v1/shell/compat"))
        .send()
        .await
        .map_err(|e| format!("address: could not reach server: {e}"))?;
    let env: ApiEnvelope<CompatData> = serde_json::from_str(
        &resp
            .text()
            .await
            .map_err(|e| format!("address: could not read server response: {e}"))?,
    )
    .map_err(|e| format!("address: invalid server response (not a SOMS backend?): {e}"))?;
    if env.code != 0 {
        return Err(format!(
            "address: server returned code {} (not a SOMS backend?)",
            env.code
        ));
    }
    env.data
        .ok_or_else(|| "address: server did not report a version".to_string())
}

/// Step 1: `GET /api/v1/shell/compat` — the server reports its version; THIS shell decides compatibility
/// (it carries the upper bound `COMPAT_BACKEND_MAX`). Hard-blocks (returns Err) when the server is too
/// new for this shell. The wizard's `errorKeyFor` maps the error text to `sc.compatErr` via the
/// "not compatible" substring.
#[tauri::command]
async fn init_check_compat(origin: String) -> Result<serde_json::Value, String> {
    let client = http_client_for(&origin);
    let compat = fetch_compat(&client, &origin).await?;
    let server_version = compat.server_version.trim().to_string();
    if server_version.is_empty() {
        return Err("address: server did not report a version".to_string());
    }
    // Compatible iff `serverVersion < COMPAT_BACKEND_MAX` ⟺ `!semver_gte(serverVersion, COMPAT_BACKEND_MAX)`.
    if semver_gte(&server_version, COMPAT_BACKEND_MAX) {
        return Err(format!(
            "this app (shell {SHELL_VERSION}) is not compatible with server version {server_version} (this app supports servers below {COMPAT_BACKEND_MAX})"
        ));
    }
    // Surface the server's advertised origins so the shell can symmetrically auto-fill the field the user
    // didn't enter (the user types one; /shell/compat supplies the other; a modal confirms before trust).
    Ok(serde_json::json!({
        "compatible": true,
        "serverVersion": server_version,
        "primaryOrigin": compat.primary_origin,
        "lanOrigin": compat.lan_origin,
        "firebaseConfig": compat.firebase_config,
    }))
}

/// Step 2: verify the TLS certificate is valid. HTTPS + DNS host → strict probe of `/api/v1/health`
/// (rustls validates the chain: self-signed/expired/hostname-mismatch → error). IP host or `http` →
/// skipped (IP/http origins are not guaranteed secure by policy).
#[tauri::command]
async fn init_validate_cert(origin: String) -> Result<serde_json::Value, String> {
    if tls_posture_for(&origin) == TlsPosture::Permissive {
        return Ok(
            serde_json::json!({ "valid": true, "summary": "insecure", "note": "http/ip origin — certificate validation skipped; not guaranteed secure by policy" }),
        );
    }
    let client = http_client_for(&origin);
    let url = format!("{}/api/v1/health", origin.trim_end_matches('/'));
    match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => {
            Ok(serde_json::json!({ "valid": true, "summary": "https" }))
        }
        Ok(r) => Err(format!(
            "certificate/host check failed: server returned HTTP {}",
            r.status()
        )),
        Err(e) => Err(format!(
            "certificate/host check failed (self-signed / expired / unreachable?): {e}"
        )),
    }
}

#[derive(serde::Deserialize)]
struct ManifestData {
    #[serde(rename = "webVersion")]
    web_version: String,
    sha256: String,
    #[serde(rename = "downloadUrl")]
    download_url: String,
}

/// Byte-progress payload for the `web-download-progress` event emitted while streaming the web bundle.
/// `total` is None when the server uses chunked transfer encoding (no Content-Length) — the UI then
/// shows an indeterminate bar instead of a percentage.
#[derive(serde::Serialize, Clone)]
struct DownloadProgress {
    received: u64,
    total: Option<u64>,
}

/// Step 3: download the web bundle, verify its sha256 against the manifest, extract atomically,
/// activate, persist origin. Returns the installed webVersion.
#[tauri::command]
async fn init_download_web(
    app: tauri::AppHandle,
    origin: String,
    state: tauri::State<'_, ProxyState>,
) -> Result<serde_json::Value, String> {
    let origin = origin.trim_end_matches('/').to_string();
    let client = http_client_for(&origin);

    // 3a. manifest
    let manifest_url = format!("{}/api/v1/shell/web-manifest", origin);
    let mresp = client
        .get(&manifest_url)
        .send()
        .await
        .map_err(|e| format!("manifest request failed: {e}"))?;
    let menv: ApiEnvelope<ManifestData> = serde_json::from_str(
        &mresp
            .text()
            .await
            .map_err(|e| format!("manifest read: {e}"))?,
    )
    .map_err(|e| format!("manifest parse: {e}"))?;
    if menv.code != 0 {
        return Err(format!(
            "server returned code {} at web-manifest",
            menv.code
        ));
    }
    let manifest = menv
        .data
        .ok_or_else(|| "manifest: empty data".to_string())?;
    // Defense-in-depth compat re-check (the wizard gated compat in `init_check_compat` moments before;
    // this also guards the post-login About→update path). Refuse to fetch a bundle from a backend this
    // shell has flagged incompatible.
    let server_version = fetch_server_version(&client, &origin).await?;
    if semver_gte(&server_version, COMPAT_BACKEND_MAX) {
        return Err(format!(
            "this app (shell {SHELL_VERSION}) is not compatible with server version {server_version} (supports servers below {COMPAT_BACKEND_MAX})"
        ));
    }

    // 3b. download — streamed, emitting byte-progress (`web-download-progress`) so the UI drives a real
    // progress bar instead of a frozen 90%. The whole bundle is buffered in memory first (a few MB)
    // because sha256 + tar-extract both need the full bytes; the progress is for UX, not chunked install.
    let dl_url = if manifest.download_url.starts_with("http") {
        manifest.download_url.clone()
    } else {
        format!("{}{}", origin, manifest.download_url)
    };
    let resp = client
        .get(&dl_url)
        .send()
        .await
        .map_err(|e| format!("bundle download failed: {e}"))?;
    let total = resp.content_length(); // None for chunked transfers → the UI falls back to indeterminate
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut received: u64 = 0;
    let mut last_emitted_at: u64 = 0;
    const EMIT_STEP: u64 = 64 * 1024; // throttle: emit ~once per 64KB so the IPC channel is never flooded
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("bundle read failed: {e}"))?;
        received += chunk.len() as u64;
        buf.extend_from_slice(&chunk);
        if received - last_emitted_at >= EMIT_STEP {
            last_emitted_at = received;
            let _ = app.emit(
                "web-download-progress",
                DownloadProgress { received, total },
            );
        }
    }
    // Final emit so a known-total bar reaches 100% even if the tail chunk was under EMIT_STEP.
    let _ = app.emit(
        "web-download-progress",
        DownloadProgress { received, total },
    );

    // 3c. sha256
    let mut hasher = Sha256::new();
    hasher.update(&buf);
    let got = hasher.finalize();
    let got_hex = got.iter().map(|b| format!("{:02x}", b)).collect::<String>();
    if got_hex != manifest.sha256.to_lowercase() {
        return Err(format!(
            "bundle sha256 mismatch (expected {}, got {})",
            manifest.sha256, got_hex
        ));
    }

    // 3d. extract atomically. Tar extraction is blocking → spawn_blocking off the async runtime.
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let web_root = data_dir.join(WEB_DIRNAME);
    fs::create_dir_all(&web_root).map_err(|e| format!("web dir create: {e}"))?;
    let staging = web_root.join(format!(".staging-{}", manifest.web_version));
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    let staging_clone = staging.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let decoder = flate2::read::GzDecoder::new(&buf[..]);
        let mut archive = tar::Archive::new(decoder);
        archive.set_overwrite(true);
        archive
            .unpack(&staging_clone)
            .map_err(|e| format!("extract: {e}"))
    })
    .await
    .map_err(|e| format!("extract task: {e}"))??;

    // 3f. activate (atomic rename) + GC (keep active + one previous)
    let final_dir = web_root.join(&manifest.web_version);
    if final_dir.exists() {
        let _ = fs::remove_dir_all(&final_dir);
    }
    fs::rename(&staging, &final_dir).map_err(|e| format!("activate rename: {e}"))?;
    // Commit the selected version and its verified hash as ONE atomic state change. A crash can now expose
    // either the complete old state or the complete new state, never a new version paired with an old hash.
    let active_state = ActiveWebState {
        version: manifest.web_version.clone(),
        sha256: manifest.sha256.to_lowercase(),
    };
    let active_bytes =
        serde_json::to_vec(&active_state).map_err(|e| format!("active state serialize: {e}"))?;
    let active_tmp = web_root.join(".active.json.tmp");
    fs::write(&active_tmp, active_bytes).map_err(|e| format!("active state write: {e}"))?;
    fs::rename(&active_tmp, web_root.join(ACTIVE_STATE_FILENAME))
        .map_err(|e| format!("active state rename: {e}"))?;
    // The old split format is intentionally unsupported. Remove its metadata after the first successful
    // active.json commit; before that point boot/update checks simply ignore it and use the embedded SPA.
    let _ = fs::remove_file(web_root.join("active"));
    let _ = fs::remove_file(web_root.join("active.hash"));
    gc_web_versions(&web_root, &manifest.web_version);

    // 3f2. swap the served assets to the freshly-installed bundle. The `OtaAssets` resolver (installed at
    // `.run`) reads this Arc on the next request, so the new build is served after the running page reloads
    // (Settings→About → location.reload). THIS is the step that was missing: without it the download +
    // extract wrote to disk but the webview kept serving the embedded baseline, so an OTA never took effect.
    *state.ota_active.lock().expect("ota_active lock") = Some(final_dir.clone());

    // 3g. A post-login update may be downloaded through the active LAN fallback. That address must not
    // replace the configured public primary. First-run/reconfigure still persists its reachable address;
    // the page writes the canonical primary immediately afterwards.
    let updating_through_secondary = state
        .api_origin_secondary
        .lock()
        .expect("secondary lock")
        .as_deref()
        == Some(origin.as_str())
        && *state.origin_mode.lock().expect("mode lock") == OriginMode::Secondary;
    if !updating_through_secondary {
        persist_origin(&state, &origin)?;
    }

    Ok(serde_json::json!({ "webVersion": manifest.web_version }))
}

/// Keep only the active version + the immediately previous one; delete older extracted bundles so the
/// app_data dir doesn't grow unbounded across updates.
fn gc_web_versions(web_root: &Path, active: &str) {
    // Determine "previous" = the most-recent version dir that isn't active. Best-effort; ignore errors.
    let mut others: Vec<(String, SystemTime)> = Vec::new();
    if let Ok(entries) = fs::read_dir(web_root) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name == ACTIVE_STATE_FILENAME
                    // Obsolete pre-active.json files are deliberately unsupported, but are metadata files,
                    // not extracted version directories; leave them alone instead of recursing into them.
                    || name == "active"
                    || name == "active.hash"
                    || name.starts_with('.')
                    || name == active
                {
                    continue;
                }
                let mtime = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(UNIX_EPOCH);
                others.push((name.to_string(), mtime));
            }
        }
    }
    others.sort_by(|a, b| b.1.cmp(&a.1)); // newest first (by mtime, index 1)
                                          // Keep one previous (the newest non-active); delete the rest. The tuple is (versionString, mtime).
    for (name, _) in others.into_iter().skip(1) {
        let _ = fs::remove_dir_all(web_root.join(name));
    }
}

/// Best-effort fetch of the server's reported version + the current web-bundle manifest. Returns
/// `(server_version, server_hash, server_web_version)`; the caller degrades to empty fields on `Err` so a
/// flaky network never produces a false incompatibility or a false update prompt.
async fn fetch_compat_and_manifest(
    client: &reqwest::Client,
    origin: &str,
) -> Result<(String, String, String), String> {
    let server_version = fetch_server_version(client, origin).await?;

    let base = origin.trim_end_matches('/');
    let mresp = client
        .get(format!("{base}/api/v1/shell/web-manifest"))
        .send()
        .await
        .map_err(|e| format!("manifest: {e}"))?;
    let menv: ApiEnvelope<ManifestData> = serde_json::from_str(
        &mresp
            .text()
            .await
            .map_err(|e| format!("manifest read: {e}"))?,
    )
    .map_err(|e| format!("manifest parse: {e}"))?;
    let (server_hash, server_web) = menv
        .data
        .map(|d| (d.sha256, d.web_version))
        .unwrap_or_default();

    Ok((server_version, server_hash, server_web))
}

/// Read-only update status for the SPA's Settings→About page + the launch-time incompatibility prompt
/// (NOT an install gate — never rejects). Pulls the server version + manifest and returns the local +
/// server values + the derived flags: `incompatible` (this shell can't run this backend — prompt
/// "contact admin") and `webUpdateAvailable` (the server advertises a bundle whose hash differs from the
/// installed one — prompt "update"). Network failures resolve to empty server fields + false flags so the
/// cached bundle keeps the app usable.
#[tauri::command]
async fn init_update_status(
    origin: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let origin = origin.trim_end_matches('/').to_string();
    let client = http_client_for(&origin);

    // Local shell version (compile-time) + the atomically-persisted active web version/hash.
    let shell_version = SHELL_VERSION.to_string();
    let web_root = app.path().app_data_dir().ok().map(|d| d.join(WEB_DIRNAME));
    let active_state = web_root.as_deref().and_then(read_active_web_state);
    let installed_web = active_state
        .as_ref()
        .map(|s| s.version.clone())
        .unwrap_or_default();
    let installed_hash = active_state
        .map(|s| s.sha256.to_lowercase())
        .unwrap_or_default();

    // Best-effort server probe (graceful on failure — empty fields, no false flags).
    let (server_version, server_hash, server_web) =
        match fetch_compat_and_manifest(&client, &origin).await {
            Ok(v) => v,
            Err(_) => (String::new(), String::new(), String::new()),
        };

    let incompatible =
        !server_version.is_empty() && semver_gte(&server_version, COMPAT_BACKEND_MAX);
    let web_update_available =
        !server_hash.is_empty() && server_hash.to_lowercase() != installed_hash;

    Ok(serde_json::json!({
        "shellVersion": shell_version,
        "serverVersion": server_version,
        "installedWebVersion": installed_web,
        "serverWebVersion": server_web,
        "incompatible": incompatible,
        "webUpdateAvailable": web_update_available,
    }))
}
