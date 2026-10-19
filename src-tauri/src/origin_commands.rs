#[cfg(desktop)]
use log::warn;

#[cfg(desktop)]
use crate::secure_storage;
use crate::{
    activate_origin, persist_origin, persist_origin_secondary, pick_origin_race, validate_origin,
    OriginMode, ServerSessionState, DEFAULT_API_ORIGIN,
};

// --- frontend-facing commands (origin + token) --------------------------------------------

#[tauri::command]
pub(crate) fn get_api_origin(state: tauri::State<'_, ServerSessionState>) -> String {
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
pub(crate) fn get_active_api_origin(state: tauri::State<'_, ServerSessionState>) -> String {
    state.api_origin.lock().expect("origin lock").clone()
}

/// Whether a real backend origin has been configured — the authoritative "has a SOMS backend been
/// configured" check the SPA's configGuard uses, independent of the frontend's secureStore-seeded signal
/// (which can drift). The ServerSessionState default is a non-routable placeholder (`DEFAULT_API_ORIGIN`), so a
/// non-empty origin is NOT enough: it must also differ from the placeholder.
#[tauri::command]
pub(crate) fn is_origin_configured(state: tauri::State<'_, ServerSessionState>) -> bool {
    // Reads the PRIMARY — a fallback swap to the secondary must NOT flip this to "configured" (nor must a
    // swap back trip it). The guard asks "did the user configure a real backend" = primary configured.
    let origin = state.api_origin_primary.lock().expect("primary lock");
    !origin.is_empty() && *origin != DEFAULT_API_ORIGIN
}

/// Persist a new backend origin. Legacy entry point (the bundled bootstrap also reaches this via
/// `persist_origin` in this command). Returns the canonical origin Rust stored.
#[tauri::command]
pub(crate) fn set_api_origin(
    url: String,
    state: tauri::State<'_, ServerSessionState>,
) -> Result<String, String> {
    persist_origin(&state, &url)
}

/// The configured LAN (secondary) origin, or null when no fallback is configured (dev, or servers without
/// SOMS_LAN_DOMAIN). The shell uses this to populate the second server-config field + persist it.
#[tauri::command]
pub(crate) fn get_api_origin_secondary(
    state: tauri::State<'_, ServerSessionState>,
) -> Option<String> {
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
    state: tauri::State<'_, ServerSessionState>,
) -> Result<Option<String>, String> {
    persist_origin_secondary(&state, url.as_deref())
}

/// Which origin is currently ACTIVE — for the "正在使用内网服务器" indicator. `primary` = normal;
/// `secondary` = the primary was unreachable and a switch moved to the LAN origin.
#[tauri::command]
pub(crate) fn get_origin_mode(state: tauri::State<'_, ServerSessionState>) -> String {
    match *state.origin_mode.lock().expect("mode lock") {
        OriginMode::Primary => "primary".to_string(),
        OriginMode::Secondary => "secondary".to_string(),
    }
}

/// Login initialization — the CONCURRENT race. Probe both origins' `/client/compat`, pick the reachable one, set
/// it active. Called by the shell ONCE before the auth request, so login targets a reachable origin (on the
/// LAN the public origin is hairpin-unreachable). Pre-token (no SSE yet) — client bootstrap is the
/// unauthenticated probe. No-op when no secondary is configured (single-origin). Returns the active origin Rust picked.
#[tauri::command]
pub(crate) async fn init_pick_origin(
    state: tauri::State<'_, ServerSessionState>,
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
    state: tauri::State<'_, ServerSessionState>,
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

/// Activate the native login identity captured by the original authentication operation. The expected
/// UUID never comes from mutable current state: a late completion of a superseded login is rejected.
#[tauri::command]
pub(crate) async fn set_session_token(
    token: String,
    session_uuid: Option<String>,
    state: tauri::State<'_, ServerSessionState>,
) -> Result<(), String> {
    {
        let uuid = session_uuid.ok_or("native login UUID is required")?;
        let id = crate::login_session_store::LoginSessionId::try_from(uuid)?;
        let owner = crate::native_db::login_connection(&id)?;
        let activation = if owner.credential().ok().as_deref() == Some(token.as_str()) {
            None
        } else {
            Some(owner.begin_activation().map_err(|e| e.to_string())?)
        };
        let token_for_activation = token.clone();
        let id_for_state = id.clone();
        let preferences = crate::native_db::preferences_connection()?;
        tauri::async_runtime::spawn_blocking(move || {
            preferences.with_database(|conn| {
                crate::login_session_store::SessionStore::activate(conn, &id, &token_for_activation)
            })
        })
        .await
        .map_err(|e| format!("join native login activation: {e}"))??;
        if let Some(activation) = activation {
            activation
                .commit(token.clone())
                .map_err(|e| e.to_string())?;
        }
        owner.assert_active().map_err(|e| e.to_string())?;
        *state.login_session.lock().expect("login session lock") = Some(id_for_state);
    }
    state.replace_session_token(Some(token));
    Ok(())
}

/// Validate a persisted credential against the durable login record before any restoration work.
/// A credential whose login was ended locally never revives it.
#[tauri::command]
pub(crate) async fn login_session_for_token(token: String) -> Result<Option<String>, String> {
    let preferences = crate::native_db::preferences_connection()?;
    tauri::async_runtime::spawn_blocking(move || {
        preferences.with_database(|conn| {
            Ok(crate::login_session_store::SessionStore::restore(conn, &token)?.map(String::from))
        })
    })
    .await
    .map_err(|e| format!("join native login restoration check: {e}"))?
}

#[tauri::command]
pub(crate) async fn clear_session_token(
    session_uuid: String,
    state: tauri::State<'_, ServerSessionState>,
) -> Result<(), String> {
    let expected = crate::login_session_store::LoginSessionId::try_from(session_uuid)?;
    let ended = {
        let mut active = state.login_session.lock().expect("login session lock");
        if *active != Some(expected.clone()) {
            return Ok(());
        }
        active.take()
    };
    if let Some(id) = ended.as_ref() {
        let owner = crate::native_db::end_login_connection(id)?;
        let preferences = crate::native_db::preferences_connection()?;
        tauri::async_runtime::spawn_blocking(move || {
            let durable = preferences.with_database(|conn| {
                crate::login_session_store::SessionStore::end(conn, ended.as_ref())?;
                crate::login_session_store::SessionStore::finish_ending(conn, ended.as_ref())
            });
            let released = crate::native_db::release_login_connection(&owner);
            durable.and(released)
        })
        .await
        .map_err(|e| format!("join native local end: {e}"))??;
    }
    state.replace_session_token(None);
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogoutAdmission {
    ticket: Option<String>,
    local_clear_failed: bool,
}

/// Capture and detach before the platform adapter clears its secure credential. In particular,
/// Android's secure-store adapter also clears Rust's token, so it must wait for this acknowledgement.
/// The bounded remote attempt starts here even if the renderer disappears before waiting for it.
#[tauri::command]
pub(crate) async fn begin_logout(
    origin: String,
    session_uuid: Option<String>,
    state: tauri::State<'_, ServerSessionState>,
) -> Result<LogoutAdmission, String> {
    // The renderer captures the active UUID at the logout click; a delayed dispatch of a superseded
    // logout must never end a successor login.
    let expected = session_uuid
        .as_deref()
        .map(|uuid| crate::login_session_store::LoginSessionId::try_from(uuid.to_string()))
        .transpose()?;
    {
        let mut active = state.login_session.lock().expect("login session lock");
        if *active != expected {
            return Err("native login superseded".into());
        }
        *active = None;
    }
    // The guard is dropped before awaiting: never hold the login lock across blocking I/O.
    if let Some(id) = expected.as_ref() {
        let owner = crate::native_db::end_login_connection(id)?;
        let preferences = crate::native_db::preferences_connection()?;
        let id_for_store = id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let durable = preferences.with_database(|conn| {
                crate::login_session_store::SessionStore::end(conn, Some(&id_for_store))?;
                crate::login_session_store::SessionStore::finish_ending(conn, Some(&id_for_store))
            });
            let released = crate::native_db::release_login_connection(&owner);
            durable.and(released)
        })
        .await
        .map_err(|e| format!("join native logout end: {e}"))??;
    }
    let token = state.replace_session_token(None);
    let ticket = token.and_then(|token| {
        // Never re-read the mutable origin after capturing the ended credential.
        let origin = validate_origin(&origin)?;
        Some(
            state
                .logout_tasks
                .start(state.api_client(&origin), origin, token),
        )
    });

    #[cfg(desktop)]
    let local_clear_failed = match expected.as_ref() {
        Some(id) => match secure_storage::secure_clear_token_internal(&id.to_string(), &state) {
            Ok(()) => false,
            Err(error) => {
                warn!("logout credential clear failed: {error}");
                true
            }
        },
        None => false,
    };
    #[cfg(not(desktop))]
    let local_clear_failed = false;

    Ok(LogoutAdmission {
        ticket,
        local_clear_failed,
    })
}

/// Waiting has no credential/cache side effects and cannot mutate a successor session.
#[tauri::command]
pub(crate) async fn wait_for_logout(
    ticket: String,
    state: tauri::State<'_, ServerSessionState>,
) -> Result<(), String> {
    state.logout_tasks.wait(&ticket).await;
    Ok(())
}
