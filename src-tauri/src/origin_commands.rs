use log::warn;

#[cfg(desktop)]
use crate::secure_storage;
use crate::{
    activate_origin, persist_origin, persist_origin_secondary, pick_origin_race,
    send_with_headers_deadline, validate_origin, HeadersError, OriginMode, ProxyState,
    API_HEADERS_TIMEOUT, DEFAULT_API_ORIGIN,
};

// --- frontend-facing commands (origin + token) --------------------------------------------

#[tauri::command]
pub(crate) fn get_api_origin(state: tauri::State<'_, ProxyState>) -> String {
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
pub(crate) fn get_active_api_origin(state: tauri::State<'_, ProxyState>) -> String {
    state.api_origin.lock().expect("origin lock").clone()
}

/// Whether a real backend origin has been configured — the authoritative "has a SOMS backend been
/// configured" check the SPA's configGuard uses, independent of the frontend's secureStore-seeded signal
/// (which can drift). The ProxyState default is a non-routable placeholder (`DEFAULT_API_ORIGIN`), so a
/// non-empty origin is NOT enough: it must also differ from the placeholder.
#[tauri::command]
pub(crate) fn is_origin_configured(state: tauri::State<'_, ProxyState>) -> bool {
    // Reads the PRIMARY — a fallback swap to the secondary must NOT flip this to "configured" (nor must a
    // swap back trip it). The guard asks "did the user configure a real backend" = primary configured.
    let origin = state.api_origin_primary.lock().expect("primary lock");
    !origin.is_empty() && *origin != DEFAULT_API_ORIGIN
}

/// Persist a new backend origin. Legacy entry point (the bundled bootstrap also reaches this via
/// `persist_origin` inside `init_download_web`). Returns the canonical origin Rust stored.
#[tauri::command]
pub(crate) fn set_api_origin(
    url: String,
    state: tauri::State<'_, ProxyState>,
) -> Result<String, String> {
    persist_origin(&state, &url)
}

/// The configured LAN (secondary) origin, or null when no fallback is configured (dev, or servers without
/// SOMS_LAN_DOMAIN). The shell uses this to populate the second server-config field + persist it.
#[tauri::command]
pub(crate) fn get_api_origin_secondary(state: tauri::State<'_, ProxyState>) -> Option<String> {
    state
        .api_origin_secondary
        .lock()
        .expect("secondary lock")
        .clone()
}

/// Persist the LAN (secondary) origin (field-2). Empty/null clears it (disables fallback). Returns the
/// canonical value Rust stored (Some url, or None when cleared).
#[tauri::command]
pub(crate) fn set_api_origin_secondary(
    url: Option<String>,
    state: tauri::State<'_, ProxyState>,
) -> Result<Option<String>, String> {
    persist_origin_secondary(&state, url.as_deref())
}

/// Which origin is currently ACTIVE — for the "正在使用内网服务器" indicator. `primary` = normal;
/// `secondary` = the primary was unreachable and a switch moved to the LAN origin.
#[tauri::command]
pub(crate) fn get_origin_mode(state: tauri::State<'_, ProxyState>) -> String {
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
pub(crate) async fn init_pick_origin(
    state: tauri::State<'_, ProxyState>,
) -> Result<String, String> {
    pick_origin_race(&state).await;
    Ok(state.api_origin.lock().expect("origin lock").clone())
}

/// Android passive-accept: Kotlin (the SSE authority on Android) signals which origin is active; Rust sets
/// it WITHOUT probing/switching (it's not the authority there). Desktop doesn't call this (Rust decides).
/// Sets the ACTIVE origin only (the primary/secondary config is owned by set_api_origin[_secondary]).
#[tauri::command]
pub(crate) fn set_active_origin(
    url: String,
    state: tauri::State<'_, ProxyState>,
) -> Result<String, String> {
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
pub(crate) fn set_session_token(token: String, state: tauri::State<'_, ProxyState>) {
    if let Ok(mut g) = state.token.lock() {
        *g = Some(token);
        // Wake a desktop SSE supervisor blocked in its pre-login token wait (mobile SSE is Kotlin-owned
        // and never waits on this; the extra notify is a harmless no-permit-consumer wakeup).
        drop(g);
        state.token_notify.notify_one();
    }
}

#[tauri::command]
pub(crate) fn clear_session_token(state: tauri::State<'_, ProxyState>) {
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
pub(crate) fn begin_logout(
    origin: String,
    state: tauri::State<'_, ProxyState>,
) -> Result<(), String> {
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
