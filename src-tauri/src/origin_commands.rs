#[cfg(not(desktop))]
use crate::validate_origin;
use crate::{
    pick_origin_race, OriginMode, ServerSessionState, DEFAULT_API_ORIGIN,
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
/// runtime state: Rust's login selection and runtime failover may change it
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

/// Activate the native login identity captured by the original authentication operation. The expected
/// UUID never comes from mutable current state: a late completion of a superseded login is rejected.
#[tauri::command]
pub(crate) async fn set_session_token(
    token: String,
    session_uuid: Option<String>,
    state: tauri::State<'_, ServerSessionState>,
) -> Result<(), String> {
    let guard = state
        .auth_lifecycle
        .enter(crate::auth_lifecycle::Phase::Login)?;
    let proxy = state.inner().clone();
    // Once admitted, activation belongs to the worker rather than the IPC waiter.
    tauri::async_runtime::spawn_blocking(move || {
        let uuid = session_uuid.ok_or("native login UUID is required")?;
        guard.validate_login(&uuid)?;
        let id = crate::login_session_store::LoginSessionId::try_from(uuid)?;
        let owner = crate::native_db::login_connection(&id)?;
        let activation = if owner.credential().ok().as_deref() == Some(token.as_str()) {
            None
        } else {
            Some(owner.begin_activation().map_err(|e| e.to_string())?)
        };
        let token_for_activation = token.clone();
        let preferences = crate::native_db::preferences_connection()?;
        preferences.with_database(|conn| {
            crate::login_session_store::SessionStore::activate(conn, &id, &token_for_activation)
        })?;
        if let Some(activation) = activation {
            activation
                .commit(token.clone())
                .map_err(|e| e.to_string())?;
        }
        owner.assert_active().map_err(|e| e.to_string())?;
        drop(guard);
        proxy.login_activated();
        Ok(())
    })
    .await
    .map_err(|e| format!("join native login activation: {e}"))?
}

/// Validate a persisted credential against the durable login record before any restoration work.
/// A credential whose login was ended locally never revives it.
#[tauri::command]
pub(crate) async fn login_session_for_token(
    token: String,
    state: tauri::State<'_, ServerSessionState>,
) -> Result<Option<String>, String> {
    let guard = state
        .auth_lifecycle
        .enter(crate::auth_lifecycle::Phase::Login)?;
    let preferences = crate::native_db::preferences_connection()?;
    tauri::async_runtime::spawn_blocking(move || {
        let id = preferences.with_database(|conn| {
            Ok(crate::login_session_store::SessionStore::restore(conn, &token)?.map(String::from))
        })?;
        if let Some(id) = &id {
            guard.register_login(id)?;
        }
        Ok(id)
    })
    .await
    .map_err(|e| format!("join native login restoration check: {e}"))?
}

#[tauri::command]
pub(crate) async fn clear_session_token(session_uuid: String) -> Result<(), String> {
    let expected = crate::login_session_store::LoginSessionId::try_from(session_uuid)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::native_db::end_current_login_if_matching(&expected)
    })
    .await
    .map_err(|e| format!("join native local end: {e}"))?
}

#[cfg(not(desktop))]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogoutAdmission {
    ticket: Option<String>,
    local_clear_failed: bool,
}

/// Stop desktop business work while the Rust coordinator retains revocation credentials.
#[cfg(desktop)]
#[tauri::command]
pub(crate) async fn begin_logout(
    state: tauri::State<'_, ServerSessionState>,
) -> Result<(), String> {
    state.logout.begin_login_logout(&state).await
}

/// Legacy mobile adapter admission captures revocation credentials before OS storage cleanup.
#[cfg(not(desktop))]
#[tauri::command]
pub(crate) async fn begin_logout(
    origin: String,
    session_uuid: Option<String>,
    state: tauri::State<'_, ServerSessionState>,
) -> Result<LogoutAdmission, String> {
    let transition = state.auth_lifecycle.enter(crate::auth_lifecycle::Phase::Logout)?;
    // The renderer captures the active UUID at the logout click; a delayed dispatch of a superseded
    // logout must never end a successor login.
    let expected = session_uuid
        .as_deref()
        .map(|uuid| crate::login_session_store::LoginSessionId::try_from(uuid.to_string()))
        .transpose()?;
    let owner = crate::native_db::current_login()?;
    if owner.as_ref().map(|owner| owner.id()) != expected.as_ref() {
        return Err("native login superseded".into());
    }
    // Capture the ended owner's credential before cancellation. Cleanup can never read or
    // clear a successor credential, even when SQL or OS storage finishes after a new login.
    let token = owner.as_ref().and_then(|owner| owner.credential().ok());
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
    let local_clear_failed = false;

    let ticket = token.and_then(|token| {
        let origin = validate_origin(&origin)?;
        Some(state.logout_tasks.start_in_transition(
            state.api_client(&origin), origin, token, transition,
        ))
    });

    Ok(LogoutAdmission {
        ticket,
        local_clear_failed,
    })
}

/// Complete desktop logout after confirmed revocation or an explicit local-only decision.
/// Rust owns the descriptor and OS cleanup; the renderer never supplies deletion identity.
#[cfg(desktop)]
#[tauri::command]
pub(crate) async fn finish_logout(
    app: tauri::AppHandle,
    local_only: bool,
    state: tauri::State<'_, ServerSessionState>,
) -> Result<(), String> {
    state.logout.finish_desktop(app, local_only).await
}

/// Read the Rust-owned operation projection. No credential is exposed to the renderer.
#[tauri::command]
pub(crate) async fn logout_status(
    state: tauri::State<'_, ServerSessionState>,
) -> Result<crate::native_logout::LogoutStatus, String> {
    Ok(state.logout.status().await)
}

/// One explicit attempt against the credential captured by the logout coordinator.
/// No automatic retry and no credential/cache deletion occurs in this command.
#[tauri::command]
pub(crate) async fn try_logout(
    state: tauri::State<'_, ServerSessionState>,
) -> Result<crate::native_logout::LogoutOutcome, String> {
    state.logout.revoke().await
}

/// Waiting has no credential/cache side effects and cannot mutate a successor session.
#[cfg(not(desktop))]
#[tauri::command]
pub(crate) async fn wait_for_logout(
    ticket: String,
    state: tauri::State<'_, ServerSessionState>,
) -> Result<crate::native_logout::LogoutOutcome, String> {
    Ok(state.logout_tasks.wait(&ticket).await)
}
