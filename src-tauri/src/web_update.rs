use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

use crate::{
    http_client_for, persist_origin, read_active_web_state, semver_gte, tls_posture_for,
    ActiveWebState, OriginMode, ProxyState, TlsPosture, ACTIVE_STATE_FILENAME, COMPAT_BACKEND_MAX,
    SHELL_VERSION, WEB_DIRNAME,
};

// --- shell dynamic-update: init_* + window lifecycle ---------------------------------------

#[tauri::command]
pub(crate) fn get_shell_version() -> String {
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
pub(crate) async fn init_check_compat(origin: String) -> Result<serde_json::Value, String> {
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
pub(crate) async fn init_validate_cert(origin: String) -> Result<serde_json::Value, String> {
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
pub(crate) async fn init_download_web(
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
pub(crate) async fn init_update_status(
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
