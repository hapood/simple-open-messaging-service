// SOMS desktop shell (Tauri v2).
//
// Responsibilities:
//  1. Inject `window.__SOMS_API_ORIGIN__` before the Angular app boots (initialization script), so
//     the bundled webview reaches the (cross-origin) backend at the configured origin. The origin
//     comes from the SOMS_API_ORIGIN env var (default http://localhost:3000 for dev).
//  2. Register a `media://localhost` custom URI scheme that proxies `/uploads/*` to the backend with
//     the current access token in an `Authorization: Bearer` header. A bare `<img src>` / CSS url()
//     can't set headers, and the backend's httpOnly `media_token` cookie is SameSite=Strict (so it
//     can't cross origins) — the proxy is the only correct way to authenticate media in the shell.
//  3. Hold the access token for the proxy in `ProxyState`, updated by `set_access_token` /
//     `clear_access_token` commands the frontend calls on login / logout (see AuthService).

use std::borrow::Cow;
use std::sync::{Arc, Mutex};

use tauri::http::{Response, StatusCode};
use tauri::{UriSchemeResponder, WebviewUrl, WebviewWindowBuilder};

/// The custom URI scheme the frontend rewrites `/uploads/*` media URLs to (see web/.../runtime.ts).
/// The handler below services `media://localhost/<path>` by proxying to `${api_origin}/<path>`.
const MEDIA_SCHEME: &str = "media";

/// The backend origin the shell talks to. Read once at startup from SOMS_API_ORIGIN (default
/// http://localhost:3000). Injected into the webview as `window.__SOMS_API_ORIGIN__` before boot.
const DEFAULT_API_ORIGIN: &str = "http://localhost:3000";

/// Shared state for the media proxy + token handoff commands. Cloned cheaply (the reqwest Client and
/// the token Arc are both refcounted), so the protocol handler and the command handlers see the same
/// token and HTTP pool.
#[derive(Clone)]
struct ProxyState {
    api_origin: String,
    token: Arc<Mutex<Option<String>>>,
    http: reqwest::Client,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let api_origin = std::env::var("SOMS_API_ORIGIN").unwrap_or_else(|_| DEFAULT_API_ORIGIN.to_string());
    // Sanity: the origin feeds both a fetch URL and a JS string literal; reject anything that isn't
    // a clean http(s) URL so we never inject malformed JS or fetch off-path. Fall back to the default
    // rather than panic — a misconfigured env shouldn't brick the app.
    let api_origin = reqwest::Url::parse(&api_origin)
        .ok()
        .filter(|u| u.scheme() == "http" || u.scheme() == "https")
        .map(|u| u.to_string())
        .unwrap_or_else(|| DEFAULT_API_ORIGIN.to_string());

    let proxy_state = ProxyState {
        api_origin: api_origin.clone(),
        token: Arc::new(Mutex::new(None)),
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none()) // /uploads is auth-gated; never follow
            .build()
            .expect("reqwest client"),
    };
    let proxy_for_protocol = proxy_state.clone();

    // Inject the API origin as a read-only global BEFORE any page script runs. Read at module load
    // by web/.../constants.ts → every apiPrefix/sseUrl call resolves to the absolute origin.
    // Rust's {:?} on a &str produces a valid JS string literal for these http(s):// URLs.
    let init_script = format!(
        "Object.defineProperty(window,'__SOMS_API_ORIGIN__',{{value:{:?},writable:false}});",
        api_origin
    );

    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol(MEDIA_SCHEME, move |_app, request, responder| {
            // Clone the state into the spawned task (cheap: Arc + refcounted Client).
            let st = proxy_for_protocol.clone();
            tauri::async_runtime::spawn(async move {
                proxy_media(st, request, responder).await;
            });
        })
        .manage(proxy_state)
        .invoke_handler(tauri::generate_handler![
            get_api_origin,
            set_access_token,
            clear_access_token,
        ])
        .setup(move |app| {
            // The main window is created in code (not config) so we can attach the init script that
            // injects the env-driven API origin. devUrl (dev) vs bundled index.html (release).
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
                .initialization_script(init_script.clone())
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

    let target = format!("{}{}", st.api_origin, path_and_query);
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

/// Read the backend origin (the frontend reads this from window.__SOMS_API_ORIGIN__ directly; this
/// command is a fallback / diagnostic).
#[tauri::command]
fn get_api_origin(state: tauri::State<'_, ProxyState>) -> String {
    state.api_origin.clone()
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
