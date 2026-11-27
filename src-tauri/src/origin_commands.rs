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
        let preferences = crate::native_db::preferences_connection()?;
        preferences.with_database(|conn| {
            crate::login_session_store::SessionStore::activate(conn, &id)
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

/// Admit a stored credential before any restoration work. The UUID comes from the same secure
/// storage as the credential: a pair that no longer matches the active login restores nothing,
/// so an ended login is never revived.
#[tauri::command]
pub(crate) async fn login_session_for_token(
    _token: String,
    session_uuid: String,
    state: tauri::State<'_, ServerSessionState>,
) -> Result<Option<String>, String> {
    let guard = state
        .auth_lifecycle
        .enter(crate::auth_lifecycle::Phase::Login)?;
    tauri::async_runtime::spawn_blocking(move || {
        let id = crate::native_db::restore_session_journal(&session_uuid, &guard)?;
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

/// Stop native business work while the Rust coordinator retains revocation credentials.
#[tauri::command]
pub(crate) async fn begin_logout(
    state: tauri::State<'_, ServerSessionState>,
) -> Result<(), String> {
    state.logout.begin_login_logout(&state).await
}

/// Complete native logout after confirmed revocation or an explicit local-only decision.
/// Rust owns the descriptor and OS cleanup; the renderer never supplies deletion identity.
#[tauri::command]
pub(crate) async fn finish_logout(
    app: tauri::AppHandle,
    local_only: bool,
    state: tauri::State<'_, ServerSessionState>,
) -> Result<(), String> {
    state.logout.finish_native(app, local_only).await
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

