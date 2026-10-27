// SOMS cross-platform shell (Tauri v2) — desktop (Linux/Windows/macOS) and Android.
//
// Single-window, single-origin architecture: ONE primary webview loads the bundled SPA at
// `tauri://localhost` (`http://tauri.localhost` on Android) — the merged frontend (config + login + app,
// built from `web/`). There is NO separate bootstrap and NO `somsapp://` scheme: capabilities + CSP apply
// natively because the webview is the app's own LOCAL origin (a custom-scheme webview would be treated as
// remote and rejected by the capability matcher). First-run server setup is an in-SPA `/config` route
// (the `configGuard` forces it until `is_origin_configured`).
//
// The `init_*` commands fetch client bootstrap configuration and validate TLS. The webview
// always loads the SPA embedded in the installation package; server setup persists the server.
//
// Also registers the `media://localhost` custom URI scheme that proxies `/uploads/*` to the backend
// with the current access token in an `Authorization: Bearer` header (a bare `<img src>` can't set
// headers, and the backend's httpOnly `media_token` cookie is SameSite=Strict so it can't cross origins).

#[cfg(target_os = "android")]
mod android_realtime;
#[cfg(target_os = "android")]
mod android_runtime;
mod auth_lifecycle;
#[cfg(any(target_os = "android", test))]
mod call;
mod client_compat;
mod diagnostics;
mod login_connection;
mod login_request;
mod login_session_store;
mod media_cache;
mod native_db;
mod native_logout;
mod native_video;
mod navigation;
mod origin_commands;
mod proxy;
mod realtime;
#[cfg(desktop)]
mod secure_storage;
mod server_setup;
mod sse;
mod upload;

pub(crate) use proxy::{activate_origin, is_network_failure, pick_origin_race, runtime_switch};

use std::borrow::Cow;
use std::fs;
use std::net::IpAddr;
#[cfg(target_os = "android")]
use std::os::fd::FromRawFd;
use std::path::PathBuf;
#[cfg(target_os = "android")]
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
// `log` facade macros (warn!/error!) — backed at runtime by `tauri-plugin-log`, registered FIRST in
// run(). Its Webview target forwards each record into the webview console via the `log://log` event
// (re-emitted by the frontend attachConsole-equivalent in main.ts), so Rust-side failures — SSE connect
// errors (`open_one_stream`), upstream proxy failures (`proxy_api`), panics — surface in the SAME console
// the JS errors do (visible via edge://inspect / adb logcat). Previously these were swallowed or silent.
use log::{error, warn};
use tauri::http::{Response, StatusCode};
use tauri::{Emitter, Manager, UriSchemeResponder, WebviewUrl, WebviewWindowBuilder};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::Notify;

// Desktop SSE supervisor (the Rust-owned /events stream) uses these. Gated so the mobile build (which
// owns SSE in Kotlin) doesn't carry unused imports.
use tokio_util::sync::CancellationToken;

/// The custom URI scheme the frontend rewrites `/uploads/*` media URLs to (see web/.../runtime.ts).
const MEDIA_SCHEME: &str = "media";

#[cfg(target_os = "android")]
static ANDROID_APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Max wait for reading the next chunk of response body stream. If the server goes silent
/// for longer than this duration during body transfer, the request is aborted to prevent leaks.
pub(crate) const API_BODY_INACTIVITY_TIMEOUT: Duration = Duration::from_secs(30);

/// TCP-connect timeout for EVERY backend reqwest client (`proxy_api`, `upload_stream_file`, the SSE
/// supervisor, the client configuration probe) — set on the client builder in `http_client_for`. Bounds the "backend
/// unreachable" wait so a dead host fails fast instead of hanging the webview request. This is a
/// CONNECT timeout only — it never aborts an in-progress body transfer (uploads / large responses take
/// as long as they take; a total-duration timeout would wrongly kill a legitimate large upload).
const BACKEND_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Max wait for a proxied API request's HEADERS (connect + send + server processing).
/// A backend that never sends headers produces 504 Gateway Timeout.
const API_HEADERS_TIMEOUT: Duration = Duration::from_secs(12);

/// Pool idle timeout for cached clients. Reclaims idle TCP sockets after 30 seconds of inactivity.
const HTTP_POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// Maximum idle connections kept open per host. Limits idle socket resource consumption.
const HTTP_POOL_MAX_IDLE_PER_HOST: usize = 16;

/// Timeout for the unauthenticated client-compatibility probe used in origin selection.
/// Bounds the full request (including its response body) during cold start and failover.
const ORIGIN_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Max wait for the SSE stream's opening response. A server that accepts the connection but
/// never sends headers would hang the connect forever. On timeout → treat as a network error → backoff
/// + reconnect (parity with any other connect failure).
const SSE_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// The backend origin the shell talks to when nothing else is configured. A deliberate non-routable
/// placeholder — identical in debug and release APKs (no dev-only `localhost`/LAN default, so the
/// packaged debug build behaves exactly like production) — which is unreachable from a phone, exactly
/// why the bundled bootstrap forces the setup wizard on first run. Operators replace it at runtime via
/// the config form (persisted to the `api_origin` file); desktop dev can still override via SOMS_API_ORIGIN.
const DEFAULT_API_ORIGIN: &str = "https://example.com:7667";

/// One configuration file stores the primary and optional backup origins atomically.
const CONFIG_FILENAME: &str = "server_origins.json";

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
pub(crate) struct ServerSessionState {
    /// The ACTIVE origin — every transport (api_request/media_request/proxy_media/upload_stream_file)
    /// and the desktop SSE supervisor read THIS. Swapped in-place by `select_origin` on fallback, so the
    /// read sites never change. Cold-start select_origin may flip it from the persisted primary to the
    /// secondary before the first request flies.
    api_origin: Arc<Mutex<String>>,
    /// The configured primary origin. Setup installs it together with the backup; failover changes
    /// only the active address. `is_origin_configured` therefore stays stable across network switches.
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
    /// Serializes global address selection and configuration commits. Candidates are captured after
    /// acquiring this lock so a queued probe cannot reactivate a replaced configuration.
    select_lock: Arc<tokio::sync::Mutex<()>>,
    server_setup: Arc<server_setup::ServerSetup>,
    auth_lifecycle: Arc<auth_lifecycle::AuthLifecycle>,
    token: Arc<Mutex<Option<String>>>,
    config_path: Arc<Mutex<PathBuf>>,
    /// Woken by `set_session_token` after writing a non-empty token. The desktop SSE supervisor awaits
    /// this when no token is set, so an `sse_start` issued before login (the facade connects eagerly at
    /// boot) blocks without busy-looping and without 401-storming, then opens the moment login provides
    /// a token. `tokio::sync::Notify` stores one permit, so a `notify_one()` that races ahead of the
    /// `notified().await` is not lost — race-free. Unused on mobile (Kotlin owns SSE + the token).
    token_notify: Arc<Notify>,
    /// Cached reqwest client for `proxy_api`, keyed on the origin string. Rebuilt only when the origin
    /// changes (see `ServerSessionState::api_client`) — so API calls reuse one connection pool (TCP+TLS
    /// keepalive across requests) instead of `http_client_for` building a fresh client (fresh pool, no
    /// reuse) on every single request. `(origin, client)`; the origin tag detects a swap. The SSE
    /// supervisor and bootstrap probes still build per-call clients (infrequent).
    api_http: Arc<Mutex<(String, reqwest::Client)>>,
    /// Shell streaming uploads keyed by clientMessageId. A cancel action resolves the token, which drops
    /// the in-flight reqwest future and closes the request body stream/file descriptor.
    upload_cancels: Arc<Mutex<std::collections::HashMap<String, CancellationToken>>>,
    /// In-flight HTTP requests dispatched from the WebView keyed by reqId.
    pub(crate) http_cancels: Arc<Mutex<std::collections::HashMap<String, CancellationToken>>>,
    #[cfg(not(desktop))]
    native_voice_pending: Arc<Mutex<std::collections::HashMap<String, upload::NativeVoicePending>>>,
    /// App-scoped media downloads keyed by the renderer-generated task id. The shared image-download
    /// adapter cancels through this map; dropping the reqwest stream leaves only a disposable .part file.
    media_download_cancels: Arc<Mutex<std::collections::HashMap<String, CancellationToken>>>,
    logout_tasks: native_logout::LogoutTasks,
    /// The active native login UUID (login-lifetime identity; distinct from the transport token).
    login_session: Arc<Mutex<Option<login_session_store::LoginSessionId>>>,
}

impl ServerSessionState {
    fn replace_session_token(&self, token: Option<String>) -> Option<String> {
        if let Ok(mut current) = self.token.lock() {
            if current.is_some() && *current != token {
                #[cfg(not(desktop))]
                {
                    for (cid, voice) in self
                        .native_voice_pending
                        .lock()
                        .expect("native voice lock")
                        .drain()
                    {
                        if let Some(cancel) = self
                            .upload_cancels
                            .lock()
                            .expect("upload cancels lock")
                            .remove(&cid)
                        {
                            cancel.cancel();
                        }
                        let _ = std::fs::remove_file(voice.path());
                    }
                }
            }
            let previous = std::mem::replace(&mut *current, token);
            drop(current);
            self.token_notify.notify_one();
            realtime::runtime().refresh_login_work();
            return previous;
        }
        None
    }

    #[cfg(any(target_os = "android", test))]
    pub(crate) fn update_session_token_admitted(
        &self,
        token: Option<String>,
        session_uuid: &str,
    ) -> Result<(), String> {
        let id = crate::login_session_store::LoginSessionId::try_from(session_uuid.to_string())?;
        match token {
            Some(token) => {
                // Publishing a credential is the activation boundary: it must belong to a
                // preparation made for the CURRENT server configuration.
                let active = self
                    .login_session
                    .lock()
                    .map_err(|_| "login session lock poisoned")?;
                if *active != Some(id.clone()) {
                    return Err("native login superseded".into());
                }
                let guard = self
                    .auth_lifecycle
                    .enter(crate::auth_lifecycle::Phase::Login)?;
                guard.validate_login(session_uuid)?;
                let owner = crate::native_db::login_connection(&id)?;
                if owner.credential().map_err(|e| e.to_string())? != token {
                    return Err("credential mismatch".into());
                }
                self.replace_session_token(Some(token));
                Ok(())
            }
            None => {
                let mut active = self
                    .login_session
                    .lock()
                    .map_err(|_| "login session lock poisoned")?;
                if active.as_ref() == Some(&id) {
                    *active = None;
                    drop(active);
                    self.replace_session_token(None);
                }
                Ok(())
            }
        }
    }

    #[cfg(any(target_os = "android", test))]
    pub(crate) fn clear_residual_token(&self) -> Result<(), String> {
        let active = self
            .login_session
            .lock()
            .map_err(|_| "login session lock poisoned")?;
        if active.is_none() {
            drop(active);
            self.replace_session_token(None);
            Ok(())
        } else {
            Err("cannot clear residual token while a login session is active".into())
        }
    }

    fn new() -> Self {
        let initial_origin = std::env::var("SOMS_API_ORIGIN")
            .ok()
            .and_then(|s| validate_origin(&s))
            .unwrap_or_else(|| DEFAULT_API_ORIGIN.to_string());
        ServerSessionState {
            api_origin: Arc::new(Mutex::new(initial_origin.clone())),
            // Pre-setup best guess: primary == active == the boot origin (env/default). setup() overrides both
            // from the persisted files; the secondary starts None until setup reads its file.
            api_origin_primary: Arc::new(Mutex::new(initial_origin.clone())),
            api_origin_secondary: Arc::new(Mutex::new(None)),
            origin_mode: Arc::new(Mutex::new(OriginMode::Primary)),
            origin_notify: Arc::new(Notify::new()),
            select_lock: Arc::new(tokio::sync::Mutex::new(())),
            server_setup: Arc::new(server_setup::ServerSetup::default()),
            auth_lifecycle: Arc::new(auth_lifecycle::AuthLifecycle::default()),
            token: Arc::new(Mutex::new(None)),
            config_path: Arc::new(Mutex::new(PathBuf::new())),
            token_notify: Arc::new(Notify::new()),
            // Seed the cached API client with the boot origin; rebuilt on the first request after a swap.
            api_http: Arc::new(Mutex::new((
                initial_origin.clone(),
                http_client_for(&initial_origin),
            ))),
            upload_cancels: Arc::new(Mutex::new(std::collections::HashMap::new())),
            http_cancels: Arc::new(Mutex::new(std::collections::HashMap::new())),
            #[cfg(not(desktop))]
            native_voice_pending: Arc::new(Mutex::new(std::collections::HashMap::new())),
            media_download_cancels: Arc::new(Mutex::new(std::collections::HashMap::new())),
            logout_tasks: native_logout::LogoutTasks::default(),
            login_session: Arc::new(Mutex::new(None)),
        }
    }

    /// Return a reqwest client for API calls to `origin`, rebuilding + caching only when the origin
    /// changes. `reqwest::Client` is `Clone`-cheap (Arc internals), so the cached pool is shared across
    /// concurrent requests and kept warm between them (keepalive). On an origin swap
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
    /// have no valid cert for a bare IP; this transport is not guaranteed secure.
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
/// controlled path. The media-proxy client (`ServerSessionState.http`) is untouched.
fn http_client_for(origin: &str) -> reqwest::Client {
    let mut b = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(BACKEND_CONNECT_TIMEOUT)
        .pool_idle_timeout(Some(HTTP_POOL_IDLE_TIMEOUT))
        .pool_max_idle_per_host(HTTP_POOL_MAX_IDLE_PER_HOST);
    if tls_posture_for(origin) == TlsPosture::Permissive {
        b = b.danger_accept_invalid_certs(true);
    }
    b.build().unwrap_or_else(|_| reqwest::Client::new())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "android")]
    let proxy_state = android_runtime::proxy_state()
        .expect("Application must initialize the Rust runtime before Tauri")
        .clone();
    #[cfg(not(target_os = "android"))]
    let proxy_state = ServerSessionState::new();
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
                    diagnostics::iso_utc_now(),
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

    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_deep_link::init());

    let builder = builder
        .plugin(tauri_plugin_opener::init())
        // media://localhost — proxy /uploads/* to ${api_origin} with the Bearer token (bare <img src>
        // can't set headers; the SameSite=Strict media_token cookie can't cross origins).
        .register_asynchronous_uri_scheme_protocol(
            MEDIA_SCHEME,
            move |context, request, responder| {
                let st = proxy_for_media.clone();
                let app = context.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    proxy::proxy_media(app, st, request, responder).await;
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
    let builder = builder.manage(sse::SseSupervisor::new());
    builder
        .invoke_handler({
            #[cfg(desktop)]
            {
                tauri::generate_handler![
                    native_db::desktop_notifications::desktop_notification_update,
                    native_db::profile_namespaces::native_db_profile_namespace_bindings,
                    native_db::profile_namespaces::native_db_commit_profile_namespace_bindings,
                    native_db::profile_namespaces::native_db_apply_profile_namespace_changes,
                    native_db::profile_namespaces::native_db_write_profile_namespace_tomb,
                    native_db::profile_namespaces::native_db_write_profile_tomb,
                    native_db::desktop_notifications::desktop_notifications_clear,
                    native_db::desktop_notifications::desktop_notification_pending,
                    native_db::desktop_notifications::desktop_notification_acknowledge,
                    origin_commands::get_api_origin,
                    origin_commands::get_active_api_origin,
                    origin_commands::is_origin_configured,
                    origin_commands::get_api_origin_secondary,
                    origin_commands::get_origin_mode,
                    origin_commands::init_pick_origin,
                    origin_commands::set_session_token,
                    origin_commands::clear_session_token,
                    origin_commands::login_session_for_token,
                    native_db::native_db_begin_login,
                    origin_commands::begin_logout,
                    origin_commands::wait_for_logout,
                    secure_storage::secure_get_token,
                    secure_storage::secure_set_token,
                    secure_storage::secure_clear_token,
                    secure_storage::secure_clear_residual_token,
                    server_setup::begin_server_setup,
                    server_setup::cancel_server_setup,
                    server_setup::check_server_setup,
                    server_setup::commit_server_setup,
                    client_compat::init_check_compat,
                    client_compat::init_validate_cert,
                    client_compat::init_compat_status,
                    sse::sse_start,
                    sse::sse_stop,
                    sse::sse_get_state,
                    sse::sse_net,
                    sse::sse_retry,
                    sse::sse_replay_hello,
                    upload::upload_stream_file,
                    upload::cancel_upload,
                    diagnostics::report_diagnostics,
                    diagnostics::set_debug_logging,
                    diagnostics::log_js,
                    diagnostics::read_native_log,
                    proxy::http_request,
                    proxy::cancel_http_request,
                    media_cache::cache_media,
                    media_cache::download_media,
                    media_cache::cancel_media_download,
                    media_cache::clear_media_cache,
                    media_cache::get_media_cache_info,
                    media_cache::save_media_desktop,
                    media_cache::set_media_cache_limit,
                    native_video::create_native_video_stream,
                    native_db::client_state::native_db_patch_thread,
                    native_db::account_state::native_db_advance_intent_request_read,
                    native_db::account_state::native_db_initialize_account_state,
                    native_db::account_state::native_db_read_account_state,
                    native_db::account_state::native_db_write_self_profile,
                    native_db::account_state::native_db_write_composer_drafts,
                    native_db::client_state::native_db_threads,
                    native_db::client_state::native_db_delete_thread,
                    native_db::contacts::native_db_get_profile,
                    native_db::contacts::native_db_get_group_member,
                    native_db::contacts::native_db_query_group_members,
                    native_db::attention::native_db_thread_states,
                    native_db::watch_ipc::native_watch_profile,
                    native_db::watch_ipc::native_watch_namespace,
                    native_db::watch_ipc::native_watch_cancel,
                    native_db::attention::native_profile_resolve,
                    native_db::attention::native_thread_feed_changes,
                    native_db::attention::native_db_advance_thread_read,
                    native_db::attention::native_db_project_thread_attention,
                    native_db::attention::native_db_drain_thread_misc,
                    native_db::preferences::native_db_get_preference,
                    native_db::preferences::native_db_put_preference,
                    native_db::preferences::native_db_delete_preference,
                    native_db::native_db_recreate_cache,
                    native_db::native_db_validate_cache,
                    native_db::native_db_recreate_messages,
                    native_db::native_db_count_messages,
                    native_db::native_db_clear_user,
                    native_db::native_db_clear_all,
                    native_db::profile_avatars::native_db_get_profile_avatar,
                    native_db::messages::native_db_query_messages,
                    native_db::messages::native_db_count_unread_message_slots,
                    native_db::messages::native_message_history_get,
                    native_db::messages::native_db_put_cached_messages,
                    native_db::messages::native_db_put_message_head,
                    native_db::messages::native_db_get_deleted_hwm,
                    native_db::messages::native_db_apply_deleted_messages,
                    native_db::messages::native_db_get_message,
                    native_db::messages::native_db_get_deleted_message_seqs,
                    native_db::messages::native_db_newest_messages,
                    native_db::messages::native_db_correct_system_message_profile,
                    native_db::messages::native_db_delete_messages_by_thread,
                    native_db::messages::native_db_get_message_by_origin,
                    navigation::open_external_url,
                ]
            }
            #[cfg(not(desktop))]
            {
                tauri::generate_handler![
                    origin_commands::get_api_origin,
                    origin_commands::get_active_api_origin,
                    origin_commands::is_origin_configured,
                    origin_commands::get_api_origin_secondary,
                    origin_commands::get_origin_mode,
                    origin_commands::init_pick_origin,
                    origin_commands::set_session_token,
                    origin_commands::clear_session_token,
                    origin_commands::login_session_for_token,
                    native_db::native_db_begin_login,
                    origin_commands::begin_logout,
                    origin_commands::wait_for_logout,
                    server_setup::begin_server_setup,
                    server_setup::cancel_server_setup,
                    server_setup::check_server_setup,
                    server_setup::commit_server_setup,
                    client_compat::init_check_compat,
                    client_compat::init_validate_cert,
                    client_compat::init_compat_status,
                    upload::upload_stream_file,
                    upload::cancel_upload,
                    upload::retry_native_voice,
                    upload::discard_native_voice,
                    diagnostics::report_diagnostics,
                    diagnostics::set_debug_logging,
                    diagnostics::log_js,
                    diagnostics::read_native_log,
                    proxy::http_request,
                    proxy::cancel_http_request,
                    media_cache::cache_media,
                    media_cache::download_media,
                    media_cache::cancel_media_download,
                    media_cache::clear_media_cache,
                    media_cache::get_media_cache_info,
                    media_cache::set_media_cache_limit,
                    native_video::create_native_video_stream,
                    native_db::client_state::native_db_patch_thread,
                    native_db::profile_namespaces::native_db_profile_namespace_bindings,
                    native_db::profile_namespaces::native_db_commit_profile_namespace_bindings,
                    native_db::profile_namespaces::native_db_apply_profile_namespace_changes,
                    native_db::profile_namespaces::native_db_write_profile_namespace_tomb,
                    native_db::profile_namespaces::native_db_write_profile_tomb,
                    native_db::account_state::native_db_advance_intent_request_read,
                    native_db::account_state::native_db_initialize_account_state,
                    native_db::account_state::native_db_read_account_state,
                    native_db::account_state::native_db_write_self_profile,
                    native_db::account_state::native_db_write_composer_drafts,
                    native_db::client_state::native_db_threads,
                    native_db::client_state::native_db_delete_thread,
                    native_db::contacts::native_db_get_profile,
                    native_db::contacts::native_db_get_group_member,
                    native_db::contacts::native_db_query_group_members,
                    native_db::attention::native_db_thread_states,
                    native_db::watch_ipc::native_watch_profile,
                    native_db::watch_ipc::native_watch_namespace,
                    native_db::watch_ipc::native_watch_cancel,
                    native_db::attention::native_profile_resolve,
                    native_db::attention::native_thread_feed_changes,
                    native_db::attention::native_db_advance_thread_read,
                    native_db::attention::native_db_project_thread_attention,
                    native_db::attention::native_db_drain_thread_misc,
                    native_db::preferences::native_db_get_preference,
                    native_db::preferences::native_db_put_preference,
                    native_db::preferences::native_db_delete_preference,
                    native_db::native_db_recreate_cache,
                    native_db::native_db_validate_cache,
                    native_db::native_db_recreate_messages,
                    native_db::native_db_count_messages,
                    native_db::native_db_clear_user,
                    native_db::native_db_clear_all,
                    native_db::profile_avatars::native_db_get_profile_avatar,
                    native_db::messages::native_db_query_messages,
                    native_db::messages::native_db_count_unread_message_slots,
                    native_db::messages::native_message_history_get,
                    native_db::messages::native_db_put_cached_messages,
                    native_db::messages::native_db_put_message_head,
                    native_db::messages::native_db_get_deleted_hwm,
                    native_db::messages::native_db_apply_deleted_messages,
                    native_db::messages::native_db_get_message,
                    native_db::messages::native_db_get_deleted_message_seqs,
                    native_db::messages::native_db_newest_messages,
                    native_db::messages::native_db_correct_system_message_profile,
                    native_db::messages::native_db_delete_messages_by_thread,
                    native_db::messages::native_db_get_message_by_origin,
                    navigation::open_external_url,
                ]
            }
        })
        .setup(move |app| {
            #[cfg(target_os = "windows")]
            native_db::desktop_notifications::initialize_windows_links(app.handle())?;
            #[cfg(target_os = "macos")]
            native_db::desktop_notifications::macos_platform::initialize(app.handle().clone());
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
            native_db::location::initialize(&data_dir)?;
            native_db::initialize_preferences()?;
            if let Err(error) = native_db::initialize_login_cache() {
                warn!("login cache initialization requires repair: {error}");
            }
            fs::create_dir_all(&data_dir)?;
            // Android resources were restored by Application; do not overwrite live background state.
            #[cfg(not(target_os = "android"))]
            {
                let config_path = data_dir.join(CONFIG_FILENAME);
                *proxy_state.config_path.lock().expect("config_path lock") = config_path;
                server_setup::restore(&proxy_state).map_err(std::io::Error::other)?;
            }

            // The single window loads only the embedded SPA.
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
                diagnostics::retry_pending_diagnostics(retry_app, retry_state).await;
            });

            // The web APP_INITIALIZER invokes `init_pick_origin` before routing begins. That timing matters:
            // the logged-out login page immediately loads public `/config`, so the active origin must be
            // selected even when no session token exists and before the user submits the login form.
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// --- media:// proxy (unchanged) -----------------------------------------------------------

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
