// SOMS cross-platform shell (Tauri v2) — desktop (Linux/Windows/macOS) and Android.
//
// Two-window dynamic-web architecture:
//  - "init"  window loads the bundled bootstrap (`tauri://localhost`) — the first-run setup wizard AND
//    the reconfigure UI. Created on demand; destroyed after it hands off.
//  - "main" window loads the DOWNLOADED + Ed25519-verified web SPA (`somsapp://localhost`, served from
//    app_data) — the real app. Persistent after first run.
// The bootstrap (init) talks to the backend via the `init_*` commands: shell↔server version compat,
// strict TLS cert validation for HTTPS domains (skipped for IP/http), then download → sha256 →
// Ed25519-verify → atomic install → persist origin. On success it calls `handoff_to_spa`, which Rust
// uses to create/reload "main" and (once the SPA signals `spa-ready`) destroy "init". Reconfigure from
// the SPA calls `open_init`, which creates "init" over "main"; the bootstrap runs the same 3 steps and
// hands off again.
//
// Also registers the `media://localhost` custom URI scheme that proxies `/uploads/*` to the backend
// with the current access token in an `Authorization: Bearer` header (a bare `<img src>` can't set
// headers, and the backend's httpOnly `media_token` cookie is SameSite=Strict so it can't cross origins).

use std::borrow::Cow;
use std::fs;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};
use tauri::http::{header, Response, StatusCode};
use tauri::{Listener, Manager, UriSchemeResponder, WebviewUrl, WebviewWindowBuilder};

/// The custom URI scheme the frontend rewrites `/uploads/*` media URLs to (see web/.../runtime.ts).
const MEDIA_SCHEME: &str = "media";

/// The custom URI scheme that serves the DOWNLOADED web SPA from app_data. The handler below services
/// `somsapp://localhost/<path>` by reading `app_data_dir/web/<active>/<path>` (the bundle the bootstrap
/// installed). Distinct from `tauri://localhost` (the bundled bootstrap) so the two never share a context.
const SOMSAPP_SCHEME: &str = "somsapp";
const SOMSAPP_HOST: &str = "localhost";

/// The shell version, baked from Cargo.toml (`CARGO_PKG_VERSION`) — the same source the Makefile
/// asserts equals `tauri.conf.json.version`. Sent to the server's `/shell/compat` endpoint and compared
/// against the bundle's `minShellVersion` before any download.
pub const SHELL_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Ed25519 public key (32 bytes) the downloaded web bundle MUST be signed with. The bundle is RCE
/// territory; for IP/http origins (TLS skipped) this signature is the only integrity guarantee. The
/// DEFAULT is a deterministic DEV keypair (seed = SHA-256("soms-dev-web-signing-key-v1")); a RELEASE
/// shell overrides it at compile time via `SOMS_WEB_PUBKEY_B64` (base64 32 bytes) — the Makefile / CI
/// sets that env so a release shell rejects dev-signed bundles and vice-versa.
const DEV_WEB_PUBKEY: [u8; 32] = [
    97, 25, 112, 253, 118, 40, 176, 235, 250, 204, 218, 248, 139, 100, 147, 200, 245, 114, 7, 130, 44,
    36, 140, 152, 227, 189, 71, 48, 106, 31, 134, 195,
];
static WEB_PUBKEY_CELL: OnceLock<[u8; 32]> = OnceLock::new();
fn web_pubkey() -> &'static [u8; 32] {
    WEB_PUBKEY_CELL.get_or_init(|| {
        if let Some(b64) = option_env!("SOMS_WEB_PUBKEY_B64") {
            if let Ok(bytes) = STANDARD.decode(b64.trim()) {
                if bytes.len() == 32 {
                    let mut arr = [0u8; 32];
                    arr.copy_from_slice(&bytes);
                    return arr;
                }
            }
        }
        DEV_WEB_PUBKEY
    })
}

/// The backend origin the shell talks to when nothing else is configured. Unreachable from a phone,
/// which is exactly why the bundled bootstrap forces the setup wizard on first run.
const DEFAULT_API_ORIGIN: &str = "http://localhost:3000";

/// Persisted-origin file in the app-data dir. Holds a single validated http(s) URL. Read at boot to
/// override the env/default; written by `persist_origin`.
const CONFIG_FILENAME: &str = "api_origin";

/// Web-bundle layout under app_data_dir: `web/active` holds the active version string;
/// `web/<version>/` the extracted SPA; `web/.staging-<version>/` an in-flight install.
const WEB_DIRNAME: &str = "web";
const ACTIVE_FILENAME: &str = "active";

/// Shared state for the media proxy + token/origin handoff commands + the reconfigure flag. Cloned
/// cheaply (the reqwest Client, the token Arc, the origin Arc, the config-path Arc are all refcounted),
/// so every protocol handler + command handler sees the same live values.
#[derive(Clone)]
struct ProxyState {
    api_origin: Arc<Mutex<String>>,
    token: Arc<Mutex<Option<String>>>,
    http: reqwest::Client,
    config_path: Arc<Mutex<PathBuf>>,
    /// Set by `open_init` so the bootstrap (loaded fresh) knows it was opened for reconfigure, not a
    /// first run. Read by `init_get_state`.
    reconfigure: Arc<AtomicBool>,
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
/// (self-hosted LAN servers commonly have no valid cert) — the Ed25519 bundle signature remains the
/// integrity guarantee there.
fn origin_host_is_ip(origin: &str) -> bool {
    let host = reqwest::Url::parse(origin).ok().map(|u| u.host_str().unwrap_or("").to_string());
    match host {
        Some(h) => h.parse::<IpAddr>().is_ok(),
        None => false,
    }
}

/// Build a reqwest client scoped to one origin's TLS posture. HTTPS + DNS host → STRICT (rustls webpki
/// root store validates the cert: self-signed / expired / hostname-mismatch → handshake error). IP host
/// OR `http` scheme → permissive (self-signed / cleartext accepted; the bundle signature still guards
/// integrity). Redirects are NEVER followed (an origin pointing at a login-redirect host must not chase
/// into an attacker-controlled path). The media-proxy client (`ProxyState.http`) is untouched.
fn http_client_for(origin: &str) -> reqwest::Client {
    let is_http = reqwest::Url::parse(origin)
        .ok()
        .map(|u| u.scheme() == "http")
        .unwrap_or(true);
    let permissive = is_http || origin_host_is_ip(origin);
    let mut b = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
    if permissive {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Pre-setup best guess (no app handle yet, so no app-data dir): env, else default. setup() overrides
    // this from the persisted config file once the handle is available.
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
        reconfigure: Arc::new(AtomicBool::new(false)),
    };
    let proxy_for_media = proxy_state.clone();

    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main").or_else(|| app.get_webview_window("init")) {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());

    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        // media://localhost — proxy /uploads/* to ${api_origin} with the Bearer token (bare <img src>
        // can't set headers; the SameSite=Strict media_token cookie can't cross origins).
        .register_asynchronous_uri_scheme_protocol(MEDIA_SCHEME, move |_app, request, responder| {
            let st = proxy_for_media.clone();
            tauri::async_runtime::spawn(async move {
                proxy_media(st, request, responder).await;
            });
        })
        // somsapp://localhost — serve the DOWNLOADED web SPA from app_data_dir/web/<active>/. Distinct
        // origin from tauri:// (the bundled bootstrap) so the two contexts never mix. The closure's first
        // param is a UriSchemeContext (a borrow wrapper over AppHandle — no clone); resolve the app-data
        // dir synchronously here, then move it into the async task.
        .register_asynchronous_uri_scheme_protocol(SOMSAPP_SCHEME, move |app, request, responder| {
            // UriSchemeContext::app_handle() → &AppHandle; resolve the app-data dir synchronously, then
            // move it into the async task that serves the file.
            let data_dir = app.app_handle().path().app_data_dir().ok();
            tauri::async_runtime::spawn(async move {
                serve_app_file(data_dir, request, responder).await;
            });
        })
        .manage(proxy_state.clone())
        .invoke_handler({
            #[cfg(desktop)]
            {
                tauri::generate_handler![
                    get_api_origin,
                    set_api_origin,
                    set_session_token,
                    clear_session_token,
                    secure_get_token,
                    secure_set_token,
                    secure_clear_token,
                    get_shell_version,
                    init_get_state,
                    init_check_compat,
                    init_validate_cert,
                    init_download_web,
                    init_check_update,
                    handoff_to_spa,
                    open_init,
                ]
            }
            #[cfg(not(desktop))]
            {
                tauri::generate_handler![
                    get_api_origin,
                    set_api_origin,
                    set_session_token,
                    clear_session_token,
                    get_shell_version,
                    init_get_state,
                    init_check_compat,
                    init_validate_cert,
                    init_download_web,
                    init_check_update,
                    handoff_to_spa,
                    open_init,
                ]
            }
        })
        .setup(move |app| {
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

            // Decide the first window: if a verified web bundle + origin exist, go straight to the SPA
            // ("main"); otherwise open the bootstrap ("init") for the first-run setup wizard.
            let origin_set = !proxy_state
                .api_origin
                .lock()
                .expect("origin lock")
                .is_empty();
            let web_ready = web_index_exists(&data_dir);
            let url = if origin_set && web_ready {
                WebviewUrl::External(
                    reqwest::Url::parse(&format!("{}://{}/index.html", SOMSAPP_SCHEME, SOMSAPP_HOST))
                        .unwrap(),
                )
            } else {
                WebviewUrl::App("index.html".into())
            };
            let label = if origin_set && web_ready { "main" } else { "init" };
            WebviewWindowBuilder::new(app, label, url)
                .title("SOMS")
                .inner_size(1200.0, 800.0)
                .min_inner_size(900.0, 600.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Does the installed web bundle have an index.html to load? (active version file present AND its
/// index.html exists.) Gates the first-window decision so a fresh install never opens a blank SPA.
fn web_index_exists(data_dir: &Path) -> bool {
    let active = data_dir.join(WEB_DIRNAME).join(ACTIVE_FILENAME);
    let ver = match fs::read_to_string(&active) {
        Ok(s) => s.trim().to_string(),
        Err(_) => return false,
    };
    if ver.is_empty() {
        return false;
    }
    data_dir.join(WEB_DIRNAME).join(&ver).join("index.html").exists()
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
    let mut req = st.http.get(&target);
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {}", t));
    }
    if let Some(range) = request.headers().get("range") {
        req = req.header("range", range.clone());
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

// --- somsapp:// SPA file server -----------------------------------------------------------

/// Outcome of resolving one `somsapp://` request against the installed bundle — computed entirely on
/// a blocking thread (all the fs I/O lives here), then turned into an HTTP response on the async task.
enum ServedFile {
    /// A real file to serve (index.html or a hashed asset).
    Ok { bytes: Vec<u8>, content_type: String, is_index: bool },
    /// The requested path (or the bundle root) does not exist.
    NotFound,
    /// No bundle is active yet (the app launched before / without the SPA installed).
    Unavailable,
}

/// Serve one `somsapp://localhost/<path>` request from the installed web bundle. ALL fs I/O — reading
/// the active-version string, canonicalizing the root, resolving + reading the file — is offloaded to
/// `spawn_blocking` so the async-runtime worker that owns this request is never blocked on disk. Path
/// traversal is guarded; unknown paths fall back to index.html (Angular router owns client-side
/// routes); hashed assets get a long immutable cache, index.html gets no-cache (so bundle swaps land).
async fn serve_app_file(
    data_dir: Option<PathBuf>,
    request: tauri::http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    // Only the request path is needed on the blocking thread; lift it out and drop the request.
    let req_path = request.uri().path().to_string();
    let resolved = tauri::async_runtime::spawn_blocking(move || resolve_served_file(data_dir, &req_path)).await;
    let response = match resolved {
        Ok(ServedFile::Ok { bytes, content_type, is_index }) => build_served_response(bytes, &content_type, is_index),
        Ok(ServedFile::NotFound) => empty(StatusCode::NOT_FOUND),
        Ok(ServedFile::Unavailable) => empty(StatusCode::SERVICE_UNAVAILABLE),
        Err(_) => empty(StatusCode::INTERNAL_SERVER_ERROR),
    };
    responder.respond(response);
}

/// The blocking half: read the active version, canonicalize the root, resolve the requested path with
/// an SPA fallback to index.html, read its bytes. No responder / no Response building here — pure disk.
fn resolve_served_file(data_dir: Option<PathBuf>, req_path: &str) -> ServedFile {
    let data_dir = match data_dir {
        Some(d) => d,
        None => return ServedFile::Unavailable,
    };
    let active_path = data_dir.join(WEB_DIRNAME).join(ACTIVE_FILENAME);
    let ver = match fs::read_to_string(&active_path) {
        Ok(s) => s.trim().to_string(),
        Err(_) => return ServedFile::Unavailable,
    };
    if ver.is_empty() {
        return ServedFile::Unavailable;
    }
    let root = data_dir.join(WEB_DIRNAME).join(&ver);
    let root_canon = match root.canonicalize() {
        Ok(c) => c,
        Err(_) => return ServedFile::NotFound,
    };

    // Strip the leading '/' and URL-decode the path segment. The request path is e.g. "/main-abc.js"
    // or "/chat/42" (an Angular client route → SPA fallback).
    let raw_path = req_path.trim_start_matches('/').to_string();
    let rel = percent_decode(&raw_path);
    let candidate = root_canon.join(&rel);
    let served = match candidate.canonicalize() {
        Ok(c) if c.starts_with(&root_canon) && c.is_file() => Some(c),
        _ => None,
    };
    let file_path = served.clone().unwrap_or_else(|| root_canon.join("index.html"));

    let bytes = match fs::read(&file_path) {
        Ok(b) => b,
        Err(_) => return ServedFile::NotFound,
    };
    let is_index = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n == "index.html");
    let content_type = content_type_for(&file_path);
    ServedFile::Ok { bytes, content_type, is_index }
}

/// Build the 200 response for a served file: content-type, cache headers (hashed assets immutable,
/// index.html no-cache so a bundle swap is picked up on reload), a tight CSP, and nosniff.
fn build_served_response(bytes: Vec<u8>, content_type: &str, is_index: bool) -> Response<Cow<'static, [u8]>> {
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, if is_index { "no-cache" } else { "public, max-age=31536000, immutable" })
        .header("x-content-type-options", "nosniff")
        // Tight CSP: 'self' = somsapp://localhost. The SPA uses external stylesheets (no inline <style>),
        // so style-src 'self' suffices (no nonce needed). media: in img-src because runtime.ts rewrites
        // /uploads/* → media://localhost. connect-src is broad because the backend origin is runtime-configured.
        .header(header::CONTENT_SECURITY_POLICY, "default-src 'self'; img-src 'self' data: blob: media:; style-src 'self'; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost https: http: ws: wss:; script-src 'self'");
    // Keep upstream Range support minimal (SPA assets are small); forward accept-ranges only for non-html.
    if !is_index {
        builder = builder.header(header::ACCEPT_RANGES, "bytes");
    }
    builder.body(Cow::Owned(bytes)).unwrap_or_else(|_| empty(StatusCode::OK))
}

fn content_type_for(path: &Path) -> String {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8".into(),
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8".into(),
        Some("css") => "text/css; charset=utf-8".into(),
        Some("json") => "application/json; charset=utf-8".into(),
        Some("svg") => "image/svg+xml".into(),
        Some("png") => "image/png".into(),
        Some("jpg") | Some("jpeg") => "image/jpeg".into(),
        Some("gif") => "image/gif".into(),
        Some("webp") => "image/webp".into(),
        Some("ico") => "image/x-icon".into(),
        Some("woff") => "font/woff".into(),
        Some("woff2") => "font/woff2".into(),
        Some("ttf") => "font/ttf".into(),
        Some("otf") => "font/otf".into(),
        Some("wasm") => "application/wasm".into(),
        _ => "application/octet-stream".into(),
    }
}

/// Minimal percent-decoder for a single path segment (the bundle paths are ASCII; this covers the
/// common `%20` etc. without pulling a url crate helper).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

// --- frontend-facing commands (origin + token) --------------------------------------------

#[tauri::command]
fn get_api_origin(state: tauri::State<'_, ProxyState>) -> String {
    state.api_origin.lock().expect("origin lock").clone()
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

// --- shell dynamic-update: init_* + window lifecycle ---------------------------------------

#[tauri::command]
fn get_shell_version() -> String {
    SHELL_VERSION.to_string()
}

#[derive(serde::Serialize)]
struct InitState {
    origin: String,
    has_web: bool,
    active_version: Option<String>,
    reconfigure: bool,
}

/// State the bootstrap reads on load: the configured origin, whether a verified web bundle is
/// installed (+ its version), and whether this open is a reconfigure (`open_init` set the flag). The
/// bootstrap shows the form unless it has origin+web AND this is not a reconfigure (defensive —
/// `setup` normally opens "main" directly in that case).
#[tauri::command]
fn init_get_state(app: tauri::AppHandle, state: tauri::State<'_, ProxyState>) -> InitState {
    let origin = state.api_origin.lock().expect("origin lock").clone();
    let data_dir = app.path().app_data_dir().ok();
    let (has_web, active_version) = match &data_dir {
        Some(d) => {
            let active = d.join(WEB_DIRNAME).join(ACTIVE_FILENAME);
            let ver = fs::read_to_string(&active).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            let has = ver.as_ref().is_some_and(|v| d.join(WEB_DIRNAME).join(v).join("index.html").exists());
            (has, ver)
        }
        None => (false, None),
    };
    let reconfigure = state.reconfigure.swap(false, Ordering::SeqCst);
    InitState {
        origin,
        has_web,
        active_version,
        reconfigure,
    }
}

#[derive(serde::Deserialize)]
struct ApiEnvelope<T> {
    code: i64,
    data: Option<T>,
}

#[derive(serde::Deserialize)]
struct CompatData {
    compatible: bool,
    #[serde(rename = "minShellVersion")]
    min_shell_version: String,
}

/// Step 1: `GET /api/v1/shell/compat?version=<shell>` — is this shell build allowed to use this server?
#[tauri::command]
async fn init_check_compat(origin: String) -> Result<serde_json::Value, String> {
    let client = http_client_for(&origin);
    let url = format!("{}/api/v1/shell/compat?version={}", origin.trim_end_matches('/'), SHELL_VERSION);
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("compat request failed: {e}"))?;
    let status = resp.status();
    let body: ApiEnvelope<CompatData> = serde_json::from_str(
        &resp.text().await.map_err(|e| format!("compat read failed: {e}"))?,
    )
    .map_err(|e| format!("compat parse failed (HTTP {status}): {e}"))?;
    if body.code != 0 {
        return Err(format!("server returned code {} at compat", body.code));
    }
    let data = body.data.ok_or_else(|| "compat: empty data".to_string())?;
    if !data.compatible {
        return Err(format!(
            "this app (shell {}) is too old for this server (requires {})",
            SHELL_VERSION, data.min_shell_version
        ));
    }
    Ok(serde_json::json!({ "compatible": true, "minShellVersion": data.min_shell_version }))
}

/// Step 2: verify the TLS certificate is valid. HTTPS + DNS host → strict probe of `/api/v1/health`
/// (rustls validates the chain: self-signed/expired/hostname-mismatch → error). IP host or `http` →
/// skipped (the bundle signature is the only integrity guarantee there).
#[tauri::command]
async fn init_validate_cert(origin: String) -> Result<serde_json::Value, String> {
    let is_http = reqwest::Url::parse(&origin)
        .ok()
        .map(|u| u.scheme() == "http")
        .unwrap_or(true);
    if is_http || origin_host_is_ip(&origin) {
        return Ok(serde_json::json!({ "valid": true, "summary": "insecure", "note": "http/ip origin — certificate validation skipped; bundle signature is the integrity guarantee" }));
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
    #[serde(rename = "minShellVersion")]
    min_shell_version: String,
    sha256: String,
    signature: String,
    #[serde(rename = "downloadUrl")]
    download_url: String,
}

/// Step 3: download the web bundle, verify sha256 + Ed25519 signature against the pinned pubkey,
/// extract atomically, activate, persist origin. Returns the installed webVersion.
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
    if !semver_gte(SHELL_VERSION, &manifest.min_shell_version) {
        return Err(format!(
            "this app (shell {}) is too old for this web bundle (requires {})",
            SHELL_VERSION, manifest.min_shell_version
        ));
    }

    // 3b. download
    let dl_url = if manifest.download_url.starts_with("http") {
        manifest.download_url.clone()
    } else {
        format!("{}{}", origin, manifest.download_url)
    };
    let bytes = client
        .get(&dl_url)
        .send()
        .await
        .map_err(|e| format!("bundle download failed: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("bundle read failed: {e}"))?;

    // 3c. sha256
    let mut hasher = Sha256::new();
    hasher.update(&bytes[..]);
    let got = hasher.finalize();
    let got_hex = got.iter().map(|b| format!("{:02x}", b)).collect::<String>();
    if got_hex != manifest.sha256.to_lowercase() {
        return Err(format!("bundle sha256 mismatch (expected {}, got {})", manifest.sha256, got_hex));
    }

    // 3d. Ed25519 verify (signs the full bundle bytes — matches scripts/sign-web-bundle.mjs)
    let sig_bytes = STANDARD
        .decode(manifest.signature.trim())
        .map_err(|e| format!("signature decode: {e}"))?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|e| format!("signature parse: {e}"))?;
    let vk = VerifyingKey::from_bytes(web_pubkey()).map_err(|e| format!("pubkey parse: {e}"))?;
    vk.verify_strict(&bytes[..], &sig).map_err(|_| "bundle signature INVALID — refusing to install".to_string())?;

    // 3e. extract atomically. Tar extraction is blocking → spawn_blocking off the async runtime.
    let data_dir = app.path().app_data_dir().map_err(|e| format!("app_data_dir: {e}"))?;
    let web_root = data_dir.join(WEB_DIRNAME);
    fs::create_dir_all(&web_root).map_err(|e| format!("web dir create: {e}"))?;
    let staging = web_root.join(format!(".staging-{}", manifest.web_version));
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    let staging_clone = staging.clone();
    let bytes_vec = bytes.to_vec();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let decoder = flate2::read::GzDecoder::new(&bytes_vec[..]);
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
    gc_web_versions(&web_root, &manifest.web_version);

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
                if name == ACTIVE_FILENAME || name.starts_with('.') || name == active {
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

#[derive(serde::Deserialize)]
struct ManifestOnlyVersion {
    #[serde(rename = "webVersion")]
    web_version: String,
}

/// On-launch update probe: compare the local active version against the server's current manifest.
/// Returns whether a newer bundle is available (the SPA calls this in the background, then
/// `init_download_web` to install it + prompts a reload).
#[tauri::command]
async fn init_check_update(origin: String, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let origin = origin.trim_end_matches('/').to_string();
    let client = http_client_for(&origin);
    let resp = client
        .get(format!("{}/api/v1/shell/web-manifest", origin))
        .send()
        .await
        .map_err(|e| format!("update probe failed: {e}"))?;
    let env: ApiEnvelope<ManifestOnlyVersion> =
        serde_json::from_str(&resp.text().await.map_err(|e| format!("update read: {e}"))?)
            .map_err(|e| format!("update parse: {e}"))?;
    if env.code != 0 {
        return Err(format!("server returned code {} at web-manifest", env.code));
    }
    let server_ver = env.data.map(|d| d.web_version).unwrap_or_default();
    let local = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|d| fs::read_to_string(d.join(WEB_DIRNAME).join(ACTIVE_FILENAME)).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let update_available = !server_ver.is_empty() && server_ver != local;
    Ok(serde_json::json!({ "updateAvailable": update_available, "newVersion": server_ver, "currentVersion": local }))
}

// --- two-window lifecycle + natural handoff -----------------------------------------------

/// `somsapp://localhost/index.html` as a parsed URL (the "main" window target).
fn somsapp_index_url() -> reqwest::Url {
    reqwest::Url::parse(&format!("{}://{}/index.html", SOMSAPP_SCHEME, SOMSAPP_HOST)).unwrap()
}

/// If the SPA does not emit `spa-ready` within this long after handoff, complete the handoff anyway.
/// Backstop so a SPA that crashes / hangs mid-boot can never strand the user on a hidden "main" + a
/// never-closing "init". Generous vs. a normal boot (Angular paints in well under a second), tight
/// enough that a real hang is surfaced rather than frozen indefinitely.
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(15);

/// Show "main" + close "init" exactly once. The `spa-ready` event handler and the timeout backstop
/// both call this; the shared flag's `swap(true)` is atomic, so the first caller wins and the second
/// is a no-op (the loser's `main.show()`/`init.close()` would be harmless, but skipping it is clearer).
fn complete_handoff(app: &tauri::AppHandle, done: &Arc<AtomicBool>) {
    if done.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    if let Some(init) = app.get_webview_window("init") {
        let _ = init.close();
    }
}

/// Called by the bootstrap after the 3 init steps succeed (first-run OR reconfigure). Creates "main"
/// (or reloads it) hidden, waits for the SPA's `spa-ready` event (Angular emits it after first paint),
/// then shows "main" and closes "init" — no blank gap (the SPA shows its app-shell spinner until
/// painted, then real content; the shared auth-shell makes the swap read as an in-place transition).
/// A backstop timer completes the handoff if `spa-ready` never arrives, so a hung SPA can't deadlock.
#[tauri::command]
fn handoff_to_spa(app: tauri::AppHandle) -> Result<(), String> {
    let init_win = app.get_webview_window("init");

    if let Some(main) = app.get_webview_window("main") {
        // Reconfigure: reload main against the (possibly new) origin/web.
        let _ = main.eval("location.replace('somsapp://localhost/index.html')");
    } else {
        // First-run: create main matching init's geometry, hidden until painted.
        let mut b = WebviewWindowBuilder::new(&app, "main", WebviewUrl::External(somsapp_index_url()))
            .title("SOMS")
            .visible(false);
        if let Some(init) = &init_win {
            if let Ok(s) = init.inner_size() {
                b = b.inner_size(s.width as f64, s.height as f64);
            }
            if let Ok(p) = init.outer_position() {
                b = b.position(p.x as f64, p.y as f64);
            }
        } else {
            b = b.inner_size(1200.0, 800.0).min_inner_size(900.0, 600.0);
        }
        b.build().map_err(|e| format!("create main window: {e}"))?;
    }

    // Complete the handoff on the SPA's first paint. A separate backstop (below) fires after
    // HANDOFF_TIMEOUT so a SPA that never emits spa-ready still hands off; the shared flag makes the
    // first to fire the winner.
    let done = Arc::new(AtomicBool::new(false));
    let app_for_event = app.clone();
    let done_for_event = done.clone();
    app.once("spa-ready", move |_| {
        complete_handoff(&app_for_event, &done_for_event);
    });
    // tokio isn't a direct dep (tauri::async_runtime re-exports only runtime/sync/JoinHandle), so the
    // backstop sleeps on a blocking-pool thread via std::thread::sleep — it occupies one cheap blocking
    // worker for the timeout, not an async-runtime worker, and is a no-op if spa-ready already fired.
    let app_for_timeout = app.clone();
    let done_for_timeout = done;
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(HANDOFF_TIMEOUT);
        complete_handoff(&app_for_timeout, &done_for_timeout);
    });
    Ok(())
}

/// Called by the SPA login page's "Server settings" button. Creates the "init" window over "main"
/// (hidden), marks `reconfigure` so the bootstrap shows the form pre-filled, waits for `init-ready`
/// (the bootstrap's first paint), then shows it. On the bootstrap's save it calls `handoff_to_spa`
/// again, which reloads main + destroys init.
#[tauri::command]
fn open_init(app: tauri::AppHandle, state: tauri::State<'_, ProxyState>) -> Result<(), String> {
    if app.get_webview_window("init").is_some() {
        if let Some(init) = app.get_webview_window("init") {
            let _ = init.set_focus();
        }
        return Ok(());
    }
    state.reconfigure.store(true, Ordering::SeqCst);

    let main = app.get_webview_window("main");
    let mut b = WebviewWindowBuilder::new(&app, "init", WebviewUrl::App("index.html".into()))
        .title("SOMS")
        .visible(false);
    if let Some(main) = &main {
        if let Ok(s) = main.inner_size() {
            b = b.inner_size(s.width as f64, s.height as f64);
        }
        if let Ok(p) = main.outer_position() {
            b = b.position(p.x as f64, p.y as f64);
        }
    } else {
        b = b.inner_size(1200.0, 800.0).min_inner_size(900.0, 600.0);
    }
    b.build().map_err(|e| format!("create init window: {e}"))?;

    let app_handle = app.clone();
    app.once("init-ready", move |_| {
        if let Some(init) = app_handle.get_webview_window("init") {
            let _ = init.show();
            let _ = init.set_focus();
        }
    });
    Ok(())
}
