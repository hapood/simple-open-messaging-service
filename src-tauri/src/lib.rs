// SOMS cross-platform shell (Tauri v2) — desktop (Linux/Windows/macOS) and Android.
//
// Responsibilities:
//  1. Resolve the backend origin for the media proxy. Resolution order: a persisted user choice in the
//     app-data config file (set via the in-app Server page — the only way to point a bundled phone APK
//     at a real backend), then the SOMS_API_ORIGIN env var (dev), then the localhost default. The web
//     layer no longer reads this from Rust — it seeds from its own persistence surface (native
//     SomsSecureStore on Android, localStorage on desktop); this resolved value feeds only the proxy Arc.
//  2. Register a `media://localhost` custom URI scheme that proxies `/uploads/*` to the backend with
//     the current access token in an `Authorization: Bearer` header. A bare `<img src>` / CSS url()
//     can't set headers, and the backend's httpOnly `media_token` cookie is SameSite=Strict (so it
//     can't cross origins) — the proxy is the only correct way to authenticate media in the shell.
//  3. Hold the session token + live origin for the proxy in `ProxyState`, updated by `set_session_token`
//     / `clear_session_token` (login/logout) and `set_api_origin` (Server page) commands.

use std::borrow::Cow;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::http::{Response, StatusCode};
use tauri::{Manager, UriSchemeResponder, WebviewUrl, WebviewWindowBuilder};

/// The custom URI scheme the frontend rewrites `/uploads/*` media URLs to (see web/.../runtime.ts).
/// The handler below services `media://localhost/<path>` by proxying to `${api_origin}/<path>`.
const MEDIA_SCHEME: &str = "media";

/// The backend origin the shell talks to when nothing else is configured. Unreachable from a phone,
/// which is exactly why the bundled APK forces the Server page on first run (see web auth.guard.ts).
const DEFAULT_API_ORIGIN: &str = "http://localhost:3000";

/// Persisted-origin file in the app-data dir. Holds a single validated http(s) URL (no JSON needed for
/// one string). Read at boot to override the env/default; written by `set_api_origin`.
const CONFIG_FILENAME: &str = "api_origin";

/// Persisted dev-server URL file (the native on-device dev-tools dialog's "Connect" writes this). In a
/// DEBUG build the shell reads it at boot to load a frontend dev server instead of the bundled assets
/// (on-device HMR); ignored in RELEASE. Same app-data dir as [CONFIG_FILENAME]. Must match the Kotlin
/// `DEV_URL_FILENAME` in DevToolsDialog.kt (see FCM_ANDROID_PATCH.md).
const DEV_URL_FILENAME: &str = "dev_url";

/// Shared state for the media proxy + token/origin handoff commands. Cloned cheaply (the reqwest
/// Client, the token Arc, the origin Arc, and the config-path Arc are all refcounted), so the protocol
/// handler and the command handlers see the same live values.
#[derive(Clone)]
struct ProxyState {
    /// Live backend origin. Mutable so `set_api_origin` can repoint the media proxy without a restart;
    /// the frontend reloads to re-resolve its module-load `apiPrefix`/`sseUrl`/media URLs.
    api_origin: Arc<Mutex<String>>,
    token: Arc<Mutex<Option<String>>>,
    http: reqwest::Client,
    /// Path to the persisted-origin file; populated in `setup` once the app handle exists.
    config_path: Arc<Mutex<PathBuf>>,
}

/// Validate a backend origin: must parse as a clean http(s) URL. Returns the canonical string form so
/// the caller never stores or injects malformed input (the origin feeds both a fetch URL and a JS
/// string literal in the init script). `None` on anything else — callers fall back, never panic.
///
/// Trailing slash is stripped because this origin is a path-concatenation BASE, not a page URL:
/// WHATWG serialization appends the root path '/' after the host (`http://h:3000` → `http://h:3000/`),
/// and the frontend builds `${apiOrigin()}/api/v1` while the media proxy builds
/// `${api_origin}${path_and_query}` — a trailing slash on the base doubles both into `//api/v1` /
/// `//uploads/`, which Fastify 404s on (the `//api/v1/auth/login` login failure). Stripping matches the
/// `DEFAULT_API_ORIGIN` literal (never parsed, so already slash-free) and the contract `constants.ts`
/// relies on. Because every origin source — env boot, persisted-config boot, and `set_api_origin` save —
/// flows through here, this also re-normalizes any trailing-slash value an older build persisted to disk.
fn validate_origin(raw: &str) -> Option<String> {
    reqwest::Url::parse(raw.trim())
        .ok()
        .filter(|u| u.scheme() == "http" || u.scheme() == "https")
        .map(|u| u.to_string().trim_end_matches('/').to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Pre-setup best guess (no app handle yet, so no app-data dir): env, else default. setup() overrides
    // this from the persisted config file once the handle is available, and re-injects the resolved value.
    let initial_origin = std::env::var("SOMS_API_ORIGIN")
        .ok()
        .and_then(|s| validate_origin(&s))
        .unwrap_or_else(|| DEFAULT_API_ORIGIN.to_string());

    let proxy_state = ProxyState {
        api_origin: Arc::new(Mutex::new(initial_origin)),
        token: Arc::new(Mutex::new(None)),
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none()) // /uploads is auth-gated; never follow
            .build()
            .expect("reqwest client"),
        config_path: Arc::new(Mutex::new(PathBuf::new())),
    };
    let proxy_for_protocol = proxy_state.clone();

    let builder = tauri::Builder::default();

    // Single-instance lock — desktop only. The plugin has no mobile backend, and a phone's app model
    // has no "second instance" to suppress, so it is excluded from the Android build (see the
    // target-gated Cargo dep). Registered first so a duplicate launch short-circuits before any other
    // plugin/window initializes; the callback focuses the existing main window instead of spawning a
    // second WebView process (every extra instance carries its own multi-hundred-MB heap).
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    builder
        .plugin(tauri_plugin_notification::init())
        // Native HTTP: the plugin's reqwest-backed fetch is what installNativeFetch() (web layer)
        // swaps the webview's fetch for under the Tauri shell, so a bundled app can reach ANY
        // user-configured backend without the webview's CORS gate (which, unlike dev's ng
        // dev-server same-origin proxy, blocks cross-origin reads). The URL scope is granted in
        // capabilities/default.json (http:default, any http/https URL).
        .plugin(tauri_plugin_http::init())
        .register_asynchronous_uri_scheme_protocol(MEDIA_SCHEME, move |_app, request, responder| {
            // Clone the state into the spawned task (cheap: Arc + refcounted Client).
            let st = proxy_for_protocol.clone();
            tauri::async_runtime::spawn(async move {
                proxy_media(st, request, responder).await;
            });
        })
        .manage(proxy_state.clone())
        .invoke_handler(tauri::generate_handler![
            get_api_origin,
            set_api_origin,
            set_session_token,
            clear_session_token,
        ])
        .setup(move |app| {
            // Resolve the app-data config path and load the persisted origin, overriding the env/default
            // when the user has configured one. The media proxy reads origin via the live Arc at request
            // time; the web layer seeds from its own persistence surface (SomsSecureStore on Android,
            // localStorage on desktop) at boot — it no longer reads a Rust-injected global.
            let data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&data_dir)?;
            let config_path = data_dir.join(CONFIG_FILENAME);
            if let Some(persisted) = fs::read_to_string(&config_path)
                .ok()
                .and_then(|s| validate_origin(&s))
            {
                *proxy_state.api_origin.lock().expect("origin lock") = persisted;
            }
            *proxy_state
                .config_path
                .lock()
                .expect("config_path lock") = config_path;

            // The main window is created in code (not config) for direct control of its build + lifecycle.
            //
            // Frontend source resolution. RELEASE always loads the bundled index.html — a runtime-remote
            // frontend would be an arbitrary-code-execution surface. DEBUG can instead load a frontend dev
            // server for on-device HMR, resolved in this precedence:
            //   1. The persisted `dev_url` file (app-data dir) — written by the native on-device dev-tools
            //      dialog's "Connect", so a URL set once sticks across launches; cleared by "Revert" (or
            //      `adb shell pm clear` as a hard reset).
            //   2. `SOMS_DEV_URL` env (per-launch; e.g. `SOMS_DEV_URL=.. cargo tauri dev` on desktop).
            //   3. `SOMS_DEFAULT_DEV_URL` compiled-in default — the Makefile `apk-dev` target bakes it via
            //      `docker -e SOMS_DEFAULT_DEV_URL=..`, so a freshly installed dev APK goes straight to the
            //      dev server with zero config. `option_env!` reads it at compile time.
            //   4. The desktop `tauri dev` devUrl (beforeDevCommand runs `ng serve` on :4200).
            // The persisted file (1) is the operative path on a real device (no env, no shell); (4) keeps
            // desktop `tauri dev` working unchanged. The native dialog + bubble live in gen/android (see
            // FCM_ANDROID_PATCH.md). Everything falls back to the bundled index.html when nothing resolves.
            let dev_url: Option<String> = if cfg!(debug_assertions) {
                fs::read_to_string(data_dir.join(DEV_URL_FILENAME))
                    .ok()
                    .and_then(|s| validate_origin(&s))
                    .or_else(|| {
                        std::env::var("SOMS_DEV_URL")
                            .ok()
                            .and_then(|s| validate_origin(&s))
                    })
                    .or_else(|| {
                        option_env!("SOMS_DEFAULT_DEV_URL").and_then(|s| validate_origin(s))
                    })
                    .or_else(|| {
                        if cfg!(desktop) {
                            app.config().build.dev_url.as_ref().map(|u| u.to_string())
                        } else {
                            None
                        }
                    })
            } else {
                None
            };
            let url = dev_url
                .and_then(|s| reqwest::Url::parse(&s).ok())
                .map(WebviewUrl::External)
                .unwrap_or_else(|| WebviewUrl::App("index.html".into()));
            WebviewWindowBuilder::new(app, "main", url)
                .title("SOMS")
                .inner_size(1200.0, 800.0)
                .min_inner_size(900.0, 600.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Service one `media://localhost/<path>` request: forward to `${api_origin}/<path>` with the current
/// Bearer token AND the browser's `Range` header, returning the upstream's 206 Partial Content verbatim.
///
/// Tauri's `UriSchemeResponder` takes one complete body buffer (`Cow<'static, [u8]>`) — it cannot
/// stream chunk-by-chunk to the WebView. So bounding each request to the byte range the `<video>` /
/// `<audio>` actually requested is what keeps peak memory low: a large video arrives as many small
/// (typically 1–2 MB) range reads, never one whole-file buffer. (Non-range requests — small `<img>`,
/// explicit file downloads — are bounded instead by the backend's per-route upload caps.) Only
/// hop-by-hop transport headers are dropped; content-length / content-range / accept-ranges pass
/// through (a 206 MUST carry content-range + content-length per RFC 7233, and the body is forwarded
/// verbatim so the upstream's length is exactly ours). On any upstream failure respond 502 so the
/// `<img>` shows a broken-image / the gallery's retry card rather than a misleading 200.
async fn proxy_media(
    st: ProxyState,
    request: tauri::http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    // Only /uploads/* is meant to ride this proxy; reject anything else.
    let path_and_query = match request.uri().path_and_query() {
        Some(pq) => pq.as_str().to_string(),
        None => "/".to_string(),
    };
    if !path_and_query.starts_with("/uploads/") {
        responder.respond(empty(StatusCode::NOT_FOUND));
        return;
    }

    // Read the live origin (set_api_origin may have repointed it since boot).
    let api_origin = st.api_origin.lock().expect("origin lock").clone();
    let target = format!("{}{}", api_origin, path_and_query);
    let token = st.token.lock().ok().and_then(|g| g.clone());
    let mut req = st.http.get(&target);
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {}", t));
    }
    // Forward the browser's Range so the upstream answers 206 over JUST the requested bytes — the core
    // memory bound for this proxy (see the method doc). Without it the proxy would buffer every whole
    // media file. The backend's @fastify/static mount and the federation get_file both honor Range/206.
    if let Some(range) = request.headers().get("range") {
        req = req.header("range", range.clone());
    }

    match req.send().await {
        Ok(upstream) => {
            let status = upstream.status();
            let mut builder = Response::builder().status(status);
            for (name, value) in upstream.headers().iter() {
                // Drop only hop-by-hop headers (they describe the upstream transport, not ours).
                // content-length / content-range / accept-ranges are KEPT: the body is forwarded
                // verbatim so the upstream's length is exactly ours, and a 206 MUST carry content-range
                // + content-length (RFC 7233).
                if matches!(
                    name.as_str(),
                    "transfer-encoding" | "connection" | "keep-alive"
                ) {
                    continue;
                }
                builder = builder.header(name.clone(), value.clone());
            }
            // Only the requested range is buffered (not the whole file) — see the method doc.
            let bytes = upstream.bytes().await.unwrap_or_default();
            responder.respond(
                builder
                    .body(Cow::Owned(bytes.to_vec()))
                    .unwrap_or_else(|_| empty(status)),
            );
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

// --- frontend-facing commands ---------------------------------------------------------------

/// Read the live backend origin (for diagnostics / the Server page). The web layer seeds from its own
/// persistence surface (native SomsSecureStore / localStorage), not from this command, so this is
/// informational only.
#[tauri::command]
fn get_api_origin(state: tauri::State<'_, ProxyState>) -> String {
    state.api_origin.lock().expect("origin lock").clone()
}

/// Persist a new backend origin chosen in the Server page. Validates http(s), writes the app-data
/// config file (so it survives restarts and is injected before Angular boots on the next launch),
/// and updates the proxy's live origin (so `/uploads/*` media immediately uses the new host). Returns
/// the normalized origin Rust stored; the caller (frontend `setApiOrigin`) mirrors it into the
/// `apiOrigin` signal so every HttpClient/SSE/media URL resolves to the new host live — no reload.
#[tauri::command]
fn set_api_origin(url: String, state: tauri::State<'_, ProxyState>) -> Result<String, String> {
    let normalized = validate_origin(&url)
        .ok_or_else(|| format!("not a valid http(s) URL: {url}"))?;
    let path = state
        .config_path
        .lock()
        .expect("config_path lock")
        .clone();
    fs::write(&path, &normalized).map_err(|e| format!("failed to write config: {e}"))?;
    *state.api_origin.lock().expect("origin lock") = normalized.clone();
    Ok(normalized)
}

/// Stash the session token for the media proxy. Called by AuthService on login (the long-lived session
/// token authenticates the proxy's /uploads/* requests, replacing the old short-lived access token).
#[tauri::command]
fn set_session_token(token: String, state: tauri::State<'_, ProxyState>) {
    if let Ok(mut g) = state.token.lock() {
        *g = Some(token);
    }
}

/// Clear the stashed session token. Called by AuthService on logout / token invalidation.
#[tauri::command]
fn clear_session_token(state: tauri::State<'_, ProxyState>) {
    if let Ok(mut g) = state.token.lock() {
        *g = None;
    }
}
