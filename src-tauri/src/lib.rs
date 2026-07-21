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

use std::borrow::Cow;
use std::fs;
use std::io::Write;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
use tauri::{Assets, Emitter, Manager, Runtime, UriSchemeResponder, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::Notify;

// Desktop SSE supervisor (the Rust-owned /events stream) uses these. Gated so the mobile build (which
// owns SSE in Kotlin) doesn't carry unused imports.
#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(desktop)]
use std::time::Instant;
#[cfg(desktop)]
use tokio_util::sync::CancellationToken;

/// The custom URI scheme the frontend rewrites `/uploads/*` media URLs to (see web/.../runtime.ts).
const MEDIA_SCHEME: &str = "media";

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

/// Web-bundle layout under app_data_dir: `web/active` holds the active version string;
/// `web/<version>/` the extracted SPA; `web/.staging-<version>/` an in-flight install.
const WEB_DIRNAME: &str = "web";
const ACTIVE_FILENAME: &str = "active";
/// Sibling of `active`: the verified SHA-256 (hex) of the installed bundle. Written by
/// `init_download_web` after the sha256 gate; read by `init_update_status` for hash-based update
/// detection (`installedHash != serverHash`). Absent on legacy installs predating hash persistence.
const ACTIVE_HASH_FILENAME: &str = "active.hash";

/// Shared state for the proxies + the token/origin commands. Cloned cheaply (the reqwest Client,
/// the token Arc, the origin Arc, the config-path Arc are all refcounted), so every protocol handler +
/// command handler sees the same live values.
#[derive(Clone)]
struct ProxyState {
    api_origin: Arc<Mutex<String>>,
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
    let normalized = validate_origin(url).ok_or_else(|| format!("not a valid http(s) URL: {url}"))?;
    let path = state.config_path.lock().expect("config_path lock").clone();
    fs::write(&path, &normalized).map_err(|e| format!("failed to write config: {e}"))?;
    *state.api_origin.lock().expect("origin lock") = normalized.clone();
    Ok(normalized)
}

/// `MAJOR.MINOR.PATCH` `>=` compare (shell versions are clean triplets; prerelease/build ignored).
fn semver_gte(a: &str, b: &str) -> bool {
    let pa: Vec<u64> = a
        .split('.')
        .map(|s| s.split('-').next().unwrap_or(s).split('+').next().unwrap_or(s))
        .map(|s| s.parse::<u64>().unwrap_or(0))
        .collect();
    let pb: Vec<u64> = b
        .split('.')
        .map(|s| s.split('-').next().unwrap_or(s).split('+').next().unwrap_or(s))
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
// `app_data/web/active`, so a bundle installed on a prior run is served immediately — not lost on restart.

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
        token: Arc::new(Mutex::new(None)),
        config_path: Arc::new(Mutex::new(PathBuf::new())),
        token_notify: Arc::new(Notify::new()),
        // Seed the cached API client with the boot origin; rebuilt on the first request after a swap.
        api_http: Arc::new(Mutex::new((initial_origin.clone(), http_client_for(&initial_origin)))),
        ota_active: ota_active.clone(),
    };
    let proxy_for_media = proxy_state.clone();

    let builder = tauri::Builder::default();

    // Logging is registered FIRST so it captures every later plugin's setup, the URI-scheme proxies, and
    // the desktop SSE supervisor. Sinks: Webview (emit every Rust log on the `log://log` event — the debug
    // log panel subscribes to it while open; it is no longer re-emitted into the JS console), Stdout
    // (terminal / docker logs; routed to logcat on Android), LogDir (a rotating file under the OS log dir
    // for post-mortem + the bundle's `rust/*`). Info level — the instrumentation emits warn/error for
    // failures; raise to Debug to trace connectivity in detail.
    let builder = builder.plugin(
        tauri_plugin_log::Builder::new()
            .targets([
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
            ])
            // Client-app rotation: a SIZE-BOUNDED rotating set (the desktop/mobile norm) — NOT time-based
            // "keep N days" (a server logrotate pattern this plugin doesn't offer, and the wrong model for
            // a client whose log volume is bursty/idle). The plugin's default is a single 40 KB file — too
            // small for field diagnostics (a reconnect storm fills it in seconds); 1 MiB × keep 5 ≈ 6 MiB
            // total reconstructs a bad session with a hard cap, so a long-lived client can never grow it
            // without bound. Affects only the LogDir file (Webview/Stdout aren't files).
            .max_file_size(1024 * 1024)
            .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
            .level(log::LevelFilter::Info)
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
        // media://localhost — proxy /uploads/* to ${api_origin} with the Bearer token (bare <img src>
        // can't set headers; the SameSite=Strict media_token cookie can't cross origins).
        .register_asynchronous_uri_scheme_protocol(MEDIA_SCHEME, move |_app, request, responder| {
            let st = proxy_for_media.clone();
            tauri::async_runtime::spawn(async move {
                proxy_media(st, request, responder).await;
            });
        })
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
                    is_origin_configured,
                    set_api_origin,
                    set_session_token,
                    clear_session_token,
                    secure_get_token,
                    secure_set_token,
                    secure_clear_token,
                    get_shell_version,
                    init_check_compat,
                    init_validate_cert,
                    init_download_web,
                    init_update_status,
                    sse_start,
                    sse_stop,
                    sse_get_state,
                    sse_net,
                    upload_stream_file,
                    report_diagnostics,
                    read_native_log,
                    api_request,
                    media_request,
                ]
            }
            #[cfg(not(desktop))]
            {
                tauri::generate_handler![
                    get_api_origin,
                    is_origin_configured,
                    set_api_origin,
                    set_session_token,
                    clear_session_token,
                    get_shell_version,
                    init_check_compat,
                    init_validate_cert,
                    init_download_web,
                    init_update_status,
                    report_diagnostics,
                    read_native_log,
                    api_request,
                    media_request,
                ]
            }
        })
        .setup(move |app| {
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
                *proxy_state.api_origin.lock().expect("origin lock") = persisted;
            }
            *proxy_state.config_path.lock().expect("config_path lock") = config_path;

            // Seed the OTA asset resolver from a previously-installed bundle: if `web/active` names a
            // version whose extracted dir exists, serve it on this boot. The `OtaAssets` resolver (installed
            // at `.run`) reads this Arc, so a bundle installed on a prior run is picked up immediately and
            // is never lost on restart. Best-effort: a missing/empty `active` or a deleted dir just leaves
            // the embedded baseline served (the normal cold-start state).
            let web_root = data_dir.join(WEB_DIRNAME);
            if let Some(ver) = fs::read_to_string(web_root.join(ACTIVE_FILENAME))
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
            {
                let dir = web_root.join(&ver);
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
                .on_navigation(nav_allowed)
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
            context.assets = Box::new(OtaAssets { active: ota_active.clone(), fallback: embedded });
            context
        })
        .expect("error while running tauri application");
}

// --- media:// proxy (unchanged) -----------------------------------------------------------

async fn proxy_media(
    st: ProxyState,
    request: tauri::http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let path_and_query = match request.uri().path_and_query() {
        Some(pq) => pq.as_str().to_string(),
        None => "/".to_string(),
    };
    if !path_and_query.starts_with("/uploads/") {
        responder.respond(empty(StatusCode::NOT_FOUND));
        return;
    }
    let api_origin = st.api_origin.lock().expect("origin lock").clone();
    let target = format!("{}{}", api_origin, path_and_query);
    let token = st.token.lock().ok().and_then(|g| g.clone());
    // Use the cached per-origin client (the IP/http permissive-TLS posture + a warm pool) — the same client
    // `api_request` / `media_request` use — so a media load and an API call resolve identically regardless
    // of whether the origin is a self-signed LAN IP.
    let mut req = st.api_client(&api_origin).get(&target);
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {}", t));
    }
    if let Some(range) = request.headers().get("range") {
        req = req.header("range", range.clone());
    }
    // Forward the correlation id when present so any media load routed through the HttpClient chain
    // (and thus stamped by correlationIdInterceptor) correlates with pino req.id.
    if let Some(rid) = request.headers().get("x-request-id") {
        req = req.header("x-request-id", rid.clone());
    }
    match req.send().await {
        Ok(upstream) => {
            let status = upstream.status();
            let mut builder = Response::builder().status(status);
            for (name, value) in upstream.headers().iter() {
                if matches!(name.as_str(), "transfer-encoding" | "connection" | "keep-alive") {
                    continue;
                }
                builder = builder.header(name.clone(), value.clone());
            }
            let bytes = upstream.bytes().await.unwrap_or_default();
            responder.respond(builder.body(Cow::Owned(bytes.to_vec())).unwrap_or_else(|_| empty(status)));
        }
        Err(_) => responder.respond(empty(StatusCode::BAD_GATEWAY)),
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
    proxy: tauri::State<'_, ProxyState>,
    method: String,
    path: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<Vec<u8>>,
) -> Result<ApiRequestResult, String> {
    let api_origin = proxy.api_origin.lock().expect("origin lock").clone();
    let target = format!("{}{}", api_origin, path);
    let method = reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET);
    let client = proxy.api_client(&api_origin);
    let mut req = client.request(method, &target);
    // Inject the Bearer from Rust's held token ONLY. JS does not pass `authorization` (the token never
    // reaches JS); when no token is set (pre-login / public path) the request goes out unauthenticated
    // and the backend's @Public() gate decides. This — not forwarding a JS header — is what keeps the
    // token out of JS; the login flow awaits `set_session_token` so the token is set before the first
    // authenticated request (closing the race the old proxy_api papered over by forwarding JS's header).
    if let Some(t) = proxy.token.lock().ok().and_then(|g| g.clone()) {
        req = req.header("authorization", format!("Bearer {}", t));
    }
    // Forward only a whitelist of JS-supplied headers; `authorization` is intentionally NOT in the list.
    // `x-request-id` is the correlation id the JS `correlationIdInterceptor` stamps — forward it so the
    // backend honors it as request.id (→ pino req.id + the echoed response header), making a webview
    // `[http] … req=<id>` failure greppable in the server logs for the same request.
    for name in ["content-type", "accept", "accept-language", "range", "x-request-id"] {
        if let Some(v) = headers.get(name) {
            req = req.header(name, v);
        }
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    // Bound the HEADERS phase (connect + send + server processing). The body READ below is unbounded — a
    // slow/large download is legitimate and must not be killed. Connect-only failures (`SendFailed`) are
    // already caught by `BACKEND_CONNECT_TIMEOUT` on the cached client and surface as an `Err` → JS
    // status 0 → "network". A HUNG upstream (`Timeout`: connected but no headers) surfaces as a real
    // HTTP 504 so the client can distinguish "server accepted then went silent" from "couldn't connect".
    let upstream = match send_with_headers_deadline(req, API_HEADERS_TIMEOUT).await {
        Ok(r) => r,
        Err(HeadersError::SendFailed(e)) => {
            warn!("api_request {target} upstream send failed: {e}");
            return Err(format!("api_request send: {e}"));
        }
        Err(HeadersError::Timeout) => {
            warn!("api_request {target} upstream headers timed out → 504");
            return Ok(ApiRequestResult {
                status: 504,
                headers: std::collections::HashMap::new(),
                body: "Gateway Timeout".to_string(),
            });
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
            "transfer-encoding" | "connection" | "keep-alive" | "content-encoding" | "content-length"
        ) {
            continue;
        }
        if let Ok(vs) = value.to_str() {
            out_headers.insert(name.as_str().to_string(), vs.to_string());
        }
    }
    let bytes = upstream.bytes().await.map_err(|e| format!("api_request read: {e}"))?;
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
    proxy: tauri::State<'_, ProxyState>,
    path: String,
) -> Result<MediaRequestResult, String> {
    // Only /uploads/* is ever proxied as media (parity with `proxy_media`'s gate); reject anything else so
    // the command can't be turned into an arbitrary-origin GET by a compromised renderer.
    if !path.starts_with("/uploads/") {
        return Err(format!("media_request: only /uploads/* allowed (got {path})"));
    }
    let api_origin = proxy.api_origin.lock().expect("origin lock").clone();
    let target = format!("{}{}", api_origin, path);
    let mut req = proxy.api_client(&api_origin).get(&target);
    // Inject the Bearer from Rust's held token ONLY (same rule as `api_request` — JS never passes the token).
    if let Some(t) = proxy.token.lock().ok().and_then(|g| g.clone()) {
        req = req.header("authorization", format!("Bearer {}", t));
    }
    // Bound the HEADERS phase; the body READ (a large image) is unbounded — a slow download is legitimate.
    // Same headers-deadline contract as `api_request`: SendFailed → Err (JS "network"), a hung upstream
    // → 504 (distinct from a connect failure). Empty body — the JS avatar cache treats non-2xx as a
    // graceful miss.
    let upstream = match send_with_headers_deadline(req, API_HEADERS_TIMEOUT).await {
        Ok(r) => r,
        Err(HeadersError::SendFailed(e)) => {
            warn!("media_request {target} send failed: {e}");
            return Err(format!("media_request send: {e}"));
        }
        Err(HeadersError::Timeout) => {
            warn!("media_request {target} headers timed out → 504");
            return Ok(MediaRequestResult { status: 504, content_type: None, body: vec![] });
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

/// Desktop-only streaming upload: POST a file straight from its on-disk `path` to `${origin}${endpoint}`
/// as a multipart form, WITHOUT buffering the whole file into the webview / IPC. Tauri's `<input
/// type=file>` injects the real filesystem path as `File.path` on desktop; the frontend (MsgService)
/// routes uploads here when `file.path` is present + `isTauri()`, and falls back to the HttpClient-via-
/// `api://` path otherwise (browser, where the File is already an in-memory blob, + Android, where
/// `File.path` is not populated). Auth uses `ProxyState.token` (uploads happen post-login, so it's set).
///
/// Streaming: `tokio::fs::File` + `ReaderStream` → `reqwest::Body::wrap_stream` → multipart
/// `Part::stream_with_length(size)`. The file is read + sent in chunks; the peak memory is one chunk,
/// not the whole file — so a multi-GB video upload never materializes in RAM (the `api://` URI-scheme
/// proxy CAN'T do this: Tauri hands it a `Request<Vec<u8>>`, fully buffered at the IPC boundary).
#[cfg(desktop)]
#[tauri::command]
async fn upload_stream_file(
    proxy: tauri::State<'_, ProxyState>,
    path: String,
    endpoint: String,
    filename: String,
    mime: String,
    size: u64,
    fields: std::collections::HashMap<String, String>,
    client_message_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let origin = proxy.api_origin.lock().expect("origin lock").clone();
    let url = format!("{}/api/v1{}", origin, endpoint);
    let client = proxy.api_client(&origin);
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| format!("open file: {e}"))?;
    let stream = tokio_util::io::ReaderStream::new(file);
    let part = reqwest::multipart::Part::stream_with_length(reqwest::Body::wrap_stream(stream), size)
        .file_name(filename)
        .mime_str(&mime)
        .map_err(|e| format!("mime: {e}"))?;
    let mut form = reqwest::multipart::Form::new();
    for (k, v) in fields {
        form = form.text(k, v);
    }
    form = form.part("file", part);
    let mut req = client.post(&url).multipart(form);
    if let Some(cid) = client_message_id {
        req = req.header("x-client-message-id", cid);
    }
    if let Some(t) = proxy.token.lock().ok().and_then(|g| g.clone()) {
        req = req.header("authorization", format!("Bearer {}", t));
    }
    // No send timeout: a large upload legitimately takes minutes, and a total-duration timeout would
    // wrongly abort it. `BACKEND_CONNECT_TIMEOUT` (on the cached client) already catches an unreachable
    // backend; a mid-upload stall is an accepted rare failure (the user can retry).
    let resp = req.send().await.map_err(|e| format!("upload send: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("upload read: {e}"))?;
    if !status.is_success() {
        return Err(format!("upload HTTP {}: {}", status.as_u16(), text));
    }
    // Return the raw envelope ({code,message,data}); the frontend reads it as StandardResponse<T>.
    serde_json::from_str::<serde_json::Value>(&text).map_err(|e| format!("upload parse: {e}"))
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
/// Cap on the webview console capture included in a bundle. The log files are already bounded by the
/// ~6 MiB rotation; this bounds the console slice too so the total stays under the backend's 16 MiB
/// per-bundle cap (logs 6 + console 4 + manifest ≈ 10 MiB). When truncated, the MOST RECENT entries
/// (the tail) are kept — the relevant context for "what just broke".
const CONSOLE_DUMP_MAX: usize = 4 * 1024 * 1024;

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
    let dur = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
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
    console_dump: &str,
    manifest: &serde_json::Value,
    native_log: Option<&[u8]>,
) -> std::io::Result<Vec<u8>> {
    let manifest_json = serde_json::to_vec_pretty(manifest).unwrap_or_else(|_| b"{}".to_vec());
    let mut tar_buf: Vec<u8> = Vec::new();
    {
        let mut builder = tar::Builder::new(&mut tar_buf);
        tar_add_file(&mut builder, "manifest.json", &manifest_json)?;
        tar_add_file(&mut builder, "webview-console.log", console_dump.as_bytes())?;
        // The Kotlin `native.log` (Android DEBUG builds only — `SomsLog` is BuildConfig.DEBUG-gated and
        // writes to filesDir/soms-native.log). Absent on desktop + release; skipped silently so the bundle
        // stays layered without forcing every platform to produce one.
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
    let resp = req.send().await.map_err(|e| format!("diagnostics send: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("diagnostics read: {e}"))?;
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
            let manifest_path = cache_dir.join(format!("{DIAG_PENDING_PREFIX}{digest}.manifest.json"));
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

/// Build + upload one diagnostic bundle (the Settings "Report" action). On success the cached tar +
/// manifest sidecar are deleted and the new report id is returned; on any failure they are KEPT for the
/// next-launch retry and an Err is returned (the frontend shows "saved locally, will retry"). NOT
/// desktop-gated: works on Android too (the log files + reqwest + flate2/tar are all cross-platform).
#[tauri::command]
async fn report_diagnostics(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ProxyState>,
    console_dump: String,
    manifest: serde_json::Value,
) -> Result<i64, String> {
    let log_dir = app.path().app_log_dir().map_err(|e| format!("log dir: {e}"))?;
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cache dir: {e}"))?;
    fs::create_dir_all(&cache_dir).map_err(|e| format!("cache mkdir: {e}"))?;
    // Bound the console slice so the total stays under the backend cap; keep the tail (newest). Advance
    // to a UTF-8 char boundary so the byte slice never splits a multi-byte char (which would panic).
    let console: String = if console_dump.len() > CONSOLE_DUMP_MAX {
        log::warn!(
            "diagnostics: console dump {} bytes exceeds cap; truncating to the last {} bytes",
            console_dump.len(),
            CONSOLE_DUMP_MAX
        );
        let mut start = console_dump.len() - CONSOLE_DUMP_MAX;
        while !console_dump.is_char_boundary(start) {
            start += 1;
        }
        console_dump[start..].to_string()
    } else {
        console_dump
    };
    // The Kotlin native log lives under the app-internal data dir (Android `filesDir` resolves to Tauri's
    // `app_data_dir`). Absent on desktop + release → None → the bundle omits the native/ entry. Best-effort:
    // a missing/unreadable file is not a diagnostics failure.
    let native_log: Option<Vec<u8>> = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|d| fs::read(d.join("soms-native.log")).ok());
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
/// `Kotlin` = the Android `filesDir/soms-native.log` written by `SomsLog` (DEBUG builds only).
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

/// Tail a native log for the debug panel (Settings→About 7-tap gesture → FAB → overlay). Reads ONLY the
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
        NativeLogSource::Kotlin => app
            .path()
            .app_data_dir()
            .ok()
            .map(|d| d.join("soms-native.log"))
            .filter(|p| p.exists()),
    };
    let Some(path) = path else {
        return Ok(NativeLogTail { path: String::new(), content: String::new() });
    };
    let bytes = fs::read(&path).unwrap_or_default();
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(NativeLogTail {
        path: path.to_string_lossy().into_owned(),
        content: last_lines(&text, tail_lines),
    })
}

// --- frontend-facing commands (origin + token) --------------------------------------------

#[tauri::command]
fn get_api_origin(state: tauri::State<'_, ProxyState>) -> String {
    state.api_origin.lock().expect("origin lock").clone()
}

/// Whether a real backend origin has been configured — the authoritative "has a SOMS backend been
/// configured" check the SPA's configGuard uses, independent of the frontend's secureStore-seeded signal
/// (which can drift). The ProxyState default is a non-routable placeholder (`DEFAULT_API_ORIGIN`), so a
/// non-empty origin is NOT enough: it must also differ from the placeholder.
#[tauri::command]
fn is_origin_configured(state: tauri::State<'_, ProxyState>) -> bool {
    let origin = state.api_origin.lock().expect("origin lock");
    !origin.is_empty() && *origin != DEFAULT_API_ORIGIN
}

/// Persist a new backend origin. Legacy entry point (the bundled bootstrap also reaches this via
/// `persist_origin` inside `init_download_web`). Returns the canonical origin Rust stored.
#[tauri::command]
fn set_api_origin(url: String, state: tauri::State<'_, ProxyState>) -> Result<String, String> {
    persist_origin(&state, &url)
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

// --- trusted-device secure storage (desktop only) ------------------------------------------

#[cfg(desktop)]
fn secure_entry() -> Result<keyring::Entry, keyring::Error> {
    keyring::Entry::new("soms", "session")
}

#[cfg(desktop)]
#[tauri::command]
fn secure_set_token(token: String) -> Result<(), String> {
    secure_entry().map_err(|e| e.to_string())?.set_password(&token).map_err(|e| e.to_string())
}

#[cfg(desktop)]
#[tauri::command]
fn secure_get_token() -> Result<Option<String>, String> {
    match secure_entry().map_err(|e| e.to_string())?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(desktop)]
#[tauri::command]
fn secure_clear_token() -> Result<(), String> {
    match secure_entry().map_err(|e| e.to_string())?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
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
    StreamClosed,            // server ended the stream cleanly → reconnect
    Stale,                   // watchdog: no frame for 60s → reconnect
    Cancelled,               // sse_stop / logout → exit the loop
    ForceLogout(Option<String>), // 401 or a `FORCE_LOGOUT` frame → exit (no retry, no 401-loop)
    Err,                     // network / non-2xx → reconnect
}

/// Supervisor state: the spawned connect-loop task + its cancellation token, a synchronous state mirror
/// (`sse_get_state` seeds a freshly-booted renderer the way `SomsFcm.getConnState()` does on Android),
/// the backoff/online `wake` Notify, and the offline flag the webview's navigator online/offline drives.
#[cfg(desktop)]
struct SseSupervisor {
    cancel: Mutex<Option<CancellationToken>>,
    handle: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    state: Arc<Mutex<ConnectionState>>,
    wake: Arc<Notify>,
    offline: Arc<AtomicBool>,
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

#[cfg(desktop)]
async fn sse_supervisor_loop(
    app: tauri::AppHandle,
    proxy: ProxyState,
    cancel: CancellationToken,
    state: Arc<Mutex<ConnectionState>>,
    wake: Arc<Notify>,
    offline: Arc<AtomicBool>,
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
        let outcome =
            open_one_stream(&app, &proxy, &cancel, &state, &wake, &offline, &mut opened_once).await;
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
                        // online / user-retry → retry at once (reset attempt); offline → retry fails fast
                        // and backs off again (the loop re-checks `offline`).
                        if !offline.load(Ordering::Acquire) {
                            attempt = 0;
                        }
                    }
                    _ = tokio::time::sleep(delay) => {}
                }
            }
        }
    }
    emit_state(&app, &state, ConnectionState::Closed);
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
mod sse_parser_tests {
    use super::*;

    #[test]
    fn line_end_at_handles_all_forms() {
        assert_eq!(line_end_at(b"a\nb", 1), (true, 1)); // \n
        assert_eq!(line_end_at(b"a\rb", 1), (true, 1)); // \r alone
        assert_eq!(line_end_at(b"a\r\nb", 1), (true, 2)); // \r\n (one logical end, len 2)
        assert_eq!(line_end_at(b"ab", 0), (false, 1)); // ordinary byte
        assert_eq!(line_end_at(b"a", 9), (false, 1)); // past end is safe (no panic)
    }

    #[test]
    fn take_frame_lf_boundary_consumes_through_it() {
        let mut buf = b"event: ping\ndata: {}\n\nrest".to_vec();
        let frame = take_sse_frame(&mut buf).expect("complete frame");
        assert_eq!(frame, b"event: ping\ndata: {}"); // content, boundary NOT included
        assert_eq!(buf, b"rest"); // boundary consumed, remainder stays
    }

    #[test]
    fn take_frame_crlf_boundary() {
        let mut buf = b"event: x\r\ndata: 1\r\n\r\nz".to_vec();
        let frame = take_sse_frame(&mut buf).expect("complete frame");
        assert_eq!(frame, b"event: x\r\ndata: 1");
        assert_eq!(buf, b"z");
    }

    #[test]
    fn take_frame_returns_none_and_leaves_buf_when_incomplete() {
        let mut buf = b"event: ping\ndata: {}".to_vec(); // no blank-line terminator yet
        assert!(take_sse_frame(&mut buf).is_none());
        assert_eq!(buf, b"event: ping\ndata: {}", "incomplete buffer must be untouched"); // chunk-split safe
    }

    #[test]
    fn take_frame_drains_multiple_frames_in_order() {
        let mut buf = b":comment\n\nevent:b\ndata:c\n\n".to_vec();
        let f1 = take_sse_frame(&mut buf).unwrap();
        let f2 = take_sse_frame(&mut buf).unwrap();
        assert!(take_sse_frame(&mut buf).is_none());
        assert_eq!(f1, b":comment");
        assert_eq!(f2, b"event:b\ndata:c");
    }

    #[test]
    fn parse_basic_event_and_json_data() {
        let f = parse_sse_frame(b"event: NEW_MESSAGE\ndata: {\"id\":5}").unwrap();
        assert_eq!(f.event, "NEW_MESSAGE");
        assert_eq!(f.data, serde_json::json!({"id": 5}));
    }

    #[test]
    fn parse_multi_data_lines_join_with_newline_before_json() {
        // A frame split across two `data:` lines must join with `\n` then parse — the value can wrap.
        let f = parse_sse_frame(b"event: x\ndata: {\"a\":\ndata: 1}").unwrap();
        assert_eq!(f.data, serde_json::json!({"a": 1}));
    }

    #[test]
    fn parse_strips_exactly_one_leading_space_after_colon() {
        // `event: x` (one space) → "x". `data: {}` (one space) → "{}".
        let f = parse_sse_frame(b"event: x\ndata: {}").unwrap();
        assert_eq!(f.event, "x");
        assert_eq!(f.data, serde_json::json!({}));
    }

    #[test]
    fn parse_comment_line_is_ignored_but_event_still_parsed() {
        // The leading `: connected` heartbeat frame has no `event:` → dropped (next test). But a comment
        // INSIDE a real frame is ignored without breaking the parse.
        let f = parse_sse_frame(b": keepalive\nevent: x\ndata: 1").unwrap();
        assert_eq!(f.event, "x");
        assert_eq!(f.data, serde_json::json!(1));
    }

    #[test]
    fn parse_frame_with_no_event_is_dropped() {
        // The connect heartbeat (`: connected`) and a bare `data:` frame have no event → None.
        assert!(parse_sse_frame(b": connected").is_none());
        assert!(parse_sse_frame(b"data: hello").is_none());
    }

    #[test]
    fn parse_empty_data_is_null_not_dropped() {
        // `event: ping\ndata:` → event kept, data Null. Critical: a ping must NOT be dropped (it arms the
        // watchdog), so empty data must yield Null, not None.
        let f = parse_sse_frame(b"event: ping\ndata:").unwrap();
        assert_eq!(f.event, "ping");
        assert!(f.data.is_null());
    }

    #[test]
    fn parse_malformed_json_data_drops_the_frame_keeps_stream_alive() {
        // A bad payload returns None (drop the frame) — NOT a throw that kills the stream (the JS worker's
        // JSON.parse fragility we deliberately did not port).
        assert!(parse_sse_frame(b"event: x\ndata: {not json").is_none());
    }

    #[test]
    fn parse_force_logout_carries_message_for_extraction() {
        // parse_sse_frame returns the structure; open_one_stream extracts data.message into the reason.
        let f = parse_sse_frame(b"event: FORCE_LOGOUT\ndata: {\"message\":\"device_revoke\"}").unwrap();
        assert_eq!(f.event, "FORCE_LOGOUT");
        let reason = f.data.get("message").and_then(|v| v.as_str());
        assert_eq!(reason, Some("device_revoke"));
    }
}

// Origin parsing + TLS posture — the security boundary that decides whether a backend origin gets
// strict TLS validation or permissive (self-signed/cleartext accepted). Pure (no reqwest client, no
// network), so these run on EVERY target — unlike the desktop-only `sse_parser_tests` above.
#[cfg(test)]
mod origin_tests {
    use super::*;

    #[test]
    fn tls_posture_https_dns_host_is_strict() {
        assert_eq!(tls_posture_for("https://example.com"), TlsPosture::Strict);
        assert_eq!(tls_posture_for("https://soms.example.com:8443/api"), TlsPosture::Strict);
    }

    #[test]
    fn tls_posture_http_scheme_is_permissive_regardless_of_host() {
        // Cleartext http → never strict, even for a DNS host that would be strict over https.
        assert_eq!(tls_posture_for("http://example.com"), TlsPosture::Permissive);
        assert_eq!(tls_posture_for("http://10.0.0.5:3000"), TlsPosture::Permissive);
    }

    #[test]
    fn tls_posture_ip_host_is_permissive_even_over_https() {
        // LAN self-hosted over HTTPS+IP → permissive (no valid cert expected for a bare-IP host).
        assert_eq!(tls_posture_for("https://10.0.0.5"), TlsPosture::Permissive);
        assert_eq!(tls_posture_for("https://192.168.88.8:8443"), TlsPosture::Permissive);
        assert_eq!(tls_posture_for("https://[::1]:3000"), TlsPosture::Permissive);
    }

    #[test]
    fn tls_posture_unparseable_origin_is_permissive() {
        // Defensive default (matches the historical unwrap_or(true)); validate_origin gates persistence
        // so a malformed origin never reaches here in practice.
        assert_eq!(tls_posture_for("not a url"), TlsPosture::Permissive);
        assert_eq!(tls_posture_for(""), TlsPosture::Permissive);
    }

    #[test]
    fn validate_origin_accepts_http_https_and_strips_trailing_slash() {
        assert_eq!(validate_origin("https://example.com/"), Some("https://example.com".to_string()));
        assert_eq!(validate_origin("http://10.0.0.5:3000"), Some("http://10.0.0.5:3000".to_string()));
        // Surrounding whitespace tolerated (real input from a settings field).
        assert_eq!(validate_origin("  https://example.com  "), Some("https://example.com".to_string()));
    }

    #[test]
    fn validate_origin_rejects_non_http_schemes_and_schemeless_garbage() {
        assert_eq!(validate_origin("ftp://example.com"), None);
        assert_eq!(validate_origin("file:///etc/passwd"), None);
        assert_eq!(validate_origin("example.com"), None); // no scheme → relative URL, rejected
        assert_eq!(validate_origin("garbage"), None);
        assert_eq!(validate_origin(""), None);
    }

    #[test]
    fn origin_host_is_ip_detects_v4_v6_and_rejects_dns() {
        assert!(origin_host_is_ip("http://192.168.1.10"));
        assert!(origin_host_is_ip("https://10.0.0.5:3000"));
        assert!(origin_host_is_ip("https://[::1]:8443"));
        assert!(!origin_host_is_ip("https://example.com"));
        assert!(!origin_host_is_ip("garbage"));
    }
}

// send_with_headers_deadline — the bounded-headers send shared by api_request + media_request. The
// contract that matters: a connected-but-silent upstream yields `HeadersError::Timeout` (→ HTTP 504),
// NOT a connect failure. Driven with a real socket so no mock-server crate is needed — just std::net
// + a thread that accepts then holds the connection open without responding.
#[cfg(test)]
mod headers_deadline_tests {
    use super::*;

    /// A peer that completes the TCP handshake then never sends a byte — reqwest is "connected" but
    /// waits for headers that never arrive, so the deadline fires.
    struct SilentPeer {
        _addr: std::net::SocketAddr,
        _thread: std::thread::JoinHandle<()>,
    }

    impl SilentPeer {
        fn spawn() -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            // Accept and then hold the socket open without responding: `io::copy` from the stream blocks
            // until the client closes (which happens when the deadline drops the reqwest future), so the
            // thread ends cleanly with the test — no leak.
            let thread = std::thread::spawn(move || {
                if let Ok((mut stream, _)) = listener.accept() {
                    let _ = std::io::copy(&mut stream, &mut std::io::sink());
                }
            });
            Self { _addr: addr, _thread: thread }
        }
    }

    #[tokio::test]
    async fn deadline_yields_timeout_when_upstream_accepts_but_never_responds() {
        let peer = SilentPeer::spawn();
        let client = reqwest::Client::new();
        let url = format!("http://{}/", peer._addr);
        let outcome = send_with_headers_deadline(client.get(&url), Duration::from_millis(200)).await;
        assert!(
            matches!(outcome, Err(HeadersError::Timeout)),
            "a silent upstream past the deadline must be Timeout (→504), got {outcome:?}"
        );
    }

    #[tokio::test]
    async fn deadline_yields_send_failed_for_an_unreachable_host() {
        // A port with no listener on the loopback → ECONNREFUSED at connect (a SendFailed, NOT a Timeout)
        // — this is the case that must stay an `Err` (→ JS "network"), proving the 504 path is gated to
        // connected-but-silent only. Bind+drop to claim a free port, then connect to the now-closed port.
        let addr = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
        // (listener dropped here — port closed)
        let client = reqwest::Client::new();
        let url = format!("http://{addr}/");
        let outcome = send_with_headers_deadline(client.get(&url), Duration::from_secs(2)).await;
        assert!(
            matches!(outcome, Err(HeadersError::SendFailed(_))),
            "an unreachable host must be SendFailed (→network), not Timeout, got {outcome:?}"
        );
    }
}

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
        &resp.text()
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
    Ok(env.data.map(|d| d.server_version.trim().to_string()).unwrap_or_default())
}

/// Step 1: `GET /api/v1/shell/compat` — the server reports its version; THIS shell decides compatibility
/// (it carries the upper bound `COMPAT_BACKEND_MAX`). Hard-blocks (returns Err) when the server is too
/// new for this shell. The wizard's `errorKeyFor` maps the error text to `sc.compatErr` via the
/// "not compatible" substring.
#[tauri::command]
async fn init_check_compat(origin: String) -> Result<serde_json::Value, String> {
    let client = http_client_for(&origin);
    let server_version = fetch_server_version(&client, &origin).await?;
    if server_version.is_empty() {
        return Err("address: server did not report a version".to_string());
    }
    // Compatible iff `serverVersion < COMPAT_BACKEND_MAX` ⟺ `!semver_gte(serverVersion, COMPAT_BACKEND_MAX)`.
    if semver_gte(&server_version, COMPAT_BACKEND_MAX) {
        return Err(format!(
            "this app (shell {SHELL_VERSION}) is not compatible with server version {server_version} (this app supports servers below {COMPAT_BACKEND_MAX})"
        ));
    }
    Ok(serde_json::json!({ "compatible": true, "serverVersion": server_version }))
}

/// Step 2: verify the TLS certificate is valid. HTTPS + DNS host → strict probe of `/api/v1/health`
/// (rustls validates the chain: self-signed/expired/hostname-mismatch → error). IP host or `http` →
/// skipped (IP/http origins are not guaranteed secure by policy).
#[tauri::command]
async fn init_validate_cert(origin: String) -> Result<serde_json::Value, String> {
    if tls_posture_for(&origin) == TlsPosture::Permissive {
        return Ok(serde_json::json!({ "valid": true, "summary": "insecure", "note": "http/ip origin — certificate validation skipped; not guaranteed secure by policy" }));
    }
    let client = http_client_for(&origin);
    let url = format!("{}/api/v1/health", origin.trim_end_matches('/'));
    match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => Ok(serde_json::json!({ "valid": true, "summary": "https" })),
        Ok(r) => Err(format!("certificate/host check failed: server returned HTTP {}", r.status())),
        Err(e) => Err(format!("certificate/host check failed (self-signed / expired / unreachable?): {e}")),
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
    let menv: ApiEnvelope<ManifestData> = serde_json::from_str(&mresp.text().await.map_err(|e| format!("manifest read: {e}"))?)
        .map_err(|e| format!("manifest parse: {e}"))?;
    if menv.code != 0 {
        return Err(format!("server returned code {} at web-manifest", menv.code));
    }
    let manifest = menv.data.ok_or_else(|| "manifest: empty data".to_string())?;
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
            let _ = app.emit("web-download-progress", DownloadProgress { received, total });
        }
    }
    // Final emit so a known-total bar reaches 100% even if the tail chunk was under EMIT_STEP.
    let _ = app.emit("web-download-progress", DownloadProgress { received, total });

    // 3c. sha256
    let mut hasher = Sha256::new();
    hasher.update(&buf);
    let got = hasher.finalize();
    let got_hex = got.iter().map(|b| format!("{:02x}", b)).collect::<String>();
    if got_hex != manifest.sha256.to_lowercase() {
        return Err(format!("bundle sha256 mismatch (expected {}, got {})", manifest.sha256, got_hex));
    }

    // 3d. extract atomically. Tar extraction is blocking → spawn_blocking off the async runtime.
    let data_dir = app.path().app_data_dir().map_err(|e| format!("app_data_dir: {e}"))?;
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
        archive.unpack(&staging_clone).map_err(|e| format!("extract: {e}"))
    })
    .await
    .map_err(|e| format!("extract task: {e}"))??;

    // 3f. activate (atomic rename) + GC (keep active + one previous)
    let final_dir = web_root.join(&manifest.web_version);
    if final_dir.exists() {
        let _ = fs::remove_dir_all(&final_dir);
    }
    fs::rename(&staging, &final_dir).map_err(|e| format!("activate rename: {e}"))?;
    let active_tmp = web_root.join(format!("{ACTIVE_FILENAME}.tmp"));
    fs::write(&active_tmp, &manifest.web_version).map_err(|e| format!("active write: {e}"))?;
    fs::rename(&active_tmp, web_root.join(ACTIVE_FILENAME)).map_err(|e| format!("active rename: {e}"))?;
    // Persist the verified bundle hash so later launch probes detect updates by hash equality
    // (`installedHash != serverHash`) without re-downloading. Atomic tmp+rename, mirroring `active`.
    let hash_tmp = web_root.join(format!("{ACTIVE_HASH_FILENAME}.tmp"));
    fs::write(&hash_tmp, manifest.sha256.as_bytes()).map_err(|e| format!("active hash write: {e}"))?;
    fs::rename(&hash_tmp, web_root.join(ACTIVE_HASH_FILENAME))
        .map_err(|e| format!("active hash rename: {e}"))?;
    gc_web_versions(&web_root, &manifest.web_version);

    // 3f2. swap the served assets to the freshly-installed bundle. The `OtaAssets` resolver (installed at
    // `.run`) reads this Arc on the next request, so the new build is served after the running page reloads
    // (Settings→About → location.reload). THIS is the step that was missing: without it the download +
    // extract wrote to disk but the webview kept serving the embedded baseline, so an OTA never took effect.
    *state.ota_active.lock().expect("ota_active lock") = Some(final_dir.clone());

    // 3g. persist origin (media proxy Arc + api_origin file)
    persist_origin(&state, &origin)?;

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
                if name == ACTIVE_FILENAME
                    || name == ACTIVE_HASH_FILENAME
                    || name.starts_with('.')
                    || name == active
                {
                    continue;
                }
                let mtime = entry.metadata().and_then(|m| m.modified()).unwrap_or(UNIX_EPOCH);
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
    let menv: ApiEnvelope<ManifestData> =
        serde_json::from_str(&mresp.text().await.map_err(|e| format!("manifest read: {e}"))?)
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
async fn init_update_status(origin: String, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let origin = origin.trim_end_matches('/').to_string();
    let client = http_client_for(&origin);

    // Local shell version (compile-time) + installed web version + the persisted verified hash.
    let shell_version = SHELL_VERSION.to_string();
    let web_root = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join(WEB_DIRNAME));
    let installed_web = web_root
        .as_deref()
        .and_then(|p| fs::read_to_string(p.join(ACTIVE_FILENAME)).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    // The verified hash of the installed bundle, written by `init_download_web`. Absent on legacy
    // installs that predate hash persistence → empty (a one-time "update available" nudge once the server
    // advertises any hash; self-heals after the next install writes the file).
    let installed_hash = web_root
        .as_deref()
        .and_then(|p| fs::read_to_string(p.join(ACTIVE_HASH_FILENAME)).ok())
        .map(|s| s.trim().to_lowercase())
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

// --- document-navigation guard ------------------------------------------------------------

/// Top-level navigation guard, registered on the single window's `WebviewWindowBuilder` via
/// `.on_navigation(nav_allowed)`. Confines the webview's DOCUMENT to the app's own origin —
/// `tauri://localhost` (`http://tauri.localhost` on Android), where the bundled SPA is served — plus
/// `about:blank` (the pre-navigation frame). Every other URL — any external http(s) site — is refused.
///
/// Why: the webview carries the app's full privileges (IPC, secure storage, the bearer-token media proxy,
/// native bridges). Letting it navigate to an arbitrary page would run that page in a privileged context
/// (IPC probes, phishing, token theft) and break Tauri's trust model (the webview IS the trusted UI).
/// This does NOT restrict the SPA's fetch/SSE to the runtime-configured backend — that is API traffic
/// (CSP `connect-src`), not document navigation. Legitimate external LINKS must be routed to the system
/// browser (tauri-plugin-opener), never loaded inside the webview.
///
/// Android: wry routes this through `RustWebViewClient.shouldOverrideUrlLoading` → `Rust.shouldOverride`,
/// so the guard is enforced on-device, not only on desktop.
fn nav_allowed(url: &reqwest::Url) -> bool {
    let scheme = url.scheme();
    let host = url.host_str().unwrap_or("");
    scheme == "tauri" || scheme == "about" || host == "tauri.localhost"
}
