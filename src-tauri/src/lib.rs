// SOMS desktop shell (Tauri v2).
//
// Responsibilities:
//  1. Resolve the backend origin and inject `window.__SOMS_API_ORIGIN__` before the Angular app boots
//     (initialization script). Resolution order: a persisted user choice in the app-data config file
//     (set via the in-app Server page — the only way to point a bundled phone APK at a real backend),
//     then the SOMS_API_ORIGIN env var (dev), then the localhost default.
//  2. Register a `media://localhost` custom URI scheme that proxies `/uploads/*` to the backend with
//     the current access token in an `Authorization: Bearer` header. A bare `<img src>` / CSS url()
//     can't set headers, and the backend's httpOnly `media_token` cookie is SameSite=Strict (so it
//     can't cross origins) — the proxy is the only correct way to authenticate media in the shell.
//  3. Hold the access token + live origin for the proxy in `ProxyState`, updated by `set_access_token`
//     / `clear_access_token` (login/logout) and `set_api_origin` (Server page) commands.

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
fn validate_origin(raw: &str) -> Option<String> {
    reqwest::Url::parse(raw.trim())
        .ok()
        .filter(|u| u.scheme() == "http" || u.scheme() == "https")
        .map(|u| u.to_string())
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

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
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
            set_access_token,
            clear_access_token,
            exit_app,
        ])
        .setup(move |app| {
            // Resolve the app-data config path and load the persisted origin, overriding the env/default
            // when the user has configured one. The window reads origin via the live Arc at request time,
            // and the init script below injects the resolved value before any page script runs.
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
            let resolved_origin = proxy_state
                .api_origin
                .lock()
                .expect("origin lock")
                .clone();

            // Inject the API origin as a read-only global BEFORE any page script runs. Read at module
            // load by web/.../constants.ts → every apiPrefix/sseUrl call resolves to the absolute origin.
            // Rust's {:?} on a &str produces a valid JS string literal for these http(s):// URLs.
            let init_script = format!(
                "Object.defineProperty(window,'__SOMS_API_ORIGIN__',{{value:{:?},writable:false}});",
                resolved_origin
            );

            // The main window is created in code (not config) so we can attach the init script. devUrl
            // (dev) vs bundled index.html (release).
            let url = if cfg!(debug_assertions) {
                app.config()
                    .build
                    .dev_url
                    .clone()
                    .map(WebviewUrl::External)
                    .unwrap_or_else(|| WebviewUrl::App("index.html".into()))
            } else {
                WebviewUrl::App("index.html".into())
            };
            WebviewWindowBuilder::new(app, "main", url)
                .title("SOMS")
                .inner_size(1200.0, 800.0)
                .min_inner_size(900.0, 600.0)
                .initialization_script(init_script)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Service one `media://localhost/<path>` request: forward to `${api_origin}/<path>` with the
/// current Bearer token, stream the response body back. Hop-by-hop and length headers are dropped
/// (they describe the upstream transport, not ours). On any upstream failure respond 502 so the <img>
/// shows a broken-image / the gallery's retry card rather than a misleading 200.
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

    match req.send().await {
        Ok(upstream) => {
            let status = upstream.status();
            let mut builder = Response::builder().status(status);
            for (name, value) in upstream.headers().iter() {
                // Drop headers that describe the hop, not the resource; Content-Length would mismatch
                // our body if any intermediate re-encoded, and the others are transport-level.
                if matches!(
                    name.as_str(),
                    "content-length" | "transfer-encoding" | "connection" | "keep-alive"
                ) {
                    continue;
                }
                builder = builder.header(name.clone(), value.clone());
            }
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

/// Read the live backend origin. The frontend reads the boot value from window.__SOMS_API_ORIGIN__
/// directly; this command reports the current (possibly repointed) value for diagnostics / the Server
/// page.
#[tauri::command]
fn get_api_origin(state: tauri::State<'_, ProxyState>) -> String {
    state.api_origin.lock().expect("origin lock").clone()
}

/// Persist a new backend origin chosen in the Server page. Validates http(s), writes the app-data
/// config file (so it survives restarts and is injected before Angular boots on the next launch),
/// and updates the proxy's live origin (so `/uploads/*` media immediately uses the new host). Returns
/// the normalized origin Rust stored; the caller then `location.reload()`s to make the frontend's
/// module-load `apiOrigin`/`apiPrefix`/`sseUrl` re-resolve.
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

/// Stash the access token for the media proxy. Called by AuthService on login / renew.
#[tauri::command]
fn set_access_token(token: String, state: tauri::State<'_, ProxyState>) {
    if let Ok(mut g) = state.token.lock() {
        *g = Some(token);
    }
}

/// Clear the stashed token. Called by AuthService on logout / token invalidation.
#[tauri::command]
fn clear_access_token(state: tauri::State<'_, ProxyState>) {
    if let Ok(mut g) = state.token.lock() {
        *g = None;
    }
}

/// Quit the desktop app cleanly. Called by the web back-exit guard's "press back again to exit" — a
/// second mouse-back / Alt-Left at the conversation list within 2 s. The browser build instead traverses
/// history to the page that preceded the SPA; the Android build handles hardware back natively and never
/// reaches this command. `app.exit` runs the normal run-loop teardown (window close, plugin drop), so it
/// is the correct single-window quit path on PC/macOS.
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}
