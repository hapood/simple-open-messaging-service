use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use log::warn;
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::{is_network_failure, runtime_switch, ServerSessionState};

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
pub(crate) fn iso_utc_now() -> String {
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
    proxy: &ServerSessionState,
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
pub(crate) async fn retry_pending_diagnostics(app: tauri::AppHandle, proxy: ServerSessionState) {
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
pub(crate) fn set_debug_logging(enabled: bool) {
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
pub(crate) fn log_js(
    app: tauri::AppHandle,
    lines: Vec<String>,
    clear: Option<bool>,
) -> Result<(), String> {
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
pub(crate) async fn report_diagnostics(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ServerSessionState>,
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
pub(crate) enum NativeLogSource {
    Rust,
    Kotlin,
}

/// The tailed native log returned to the debug panel.
#[derive(serde::Serialize)]
pub(crate) struct NativeLogTail {
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
pub(crate) fn read_native_log(
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
