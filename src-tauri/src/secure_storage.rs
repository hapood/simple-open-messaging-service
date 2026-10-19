//! Desktop trusted-device credential storage.
//!
//! Mobile persists its session in the Android native encrypted store, so this
//! module is compiled only for desktop targets.

fn session_entry() -> Result<keyring::Entry, keyring::Error> {
    keyring::Entry::new("soms", "session")
}

#[tauri::command]
pub(crate) fn secure_set_token(
    token: String,
    session_uuid: String,
    state: tauri::State<'_, crate::ServerSessionState>,
) -> Result<(), String> {
    let id = crate::login_session_store::LoginSessionId::try_from(session_uuid)?;
    let active = state
        .login_session
        .lock()
        .map_err(|_| "login session lock poisoned")?;
    if *active != Some(id.clone()) {
        return Err("native login superseded".into());
    }
    let owner = crate::native_db::login_connection(&id)?;
    if owner.credential().map_err(|e| e.to_string())? != token {
        return Err("credential mismatch".into());
    }
    session_entry()
        .map_err(|e| e.to_string())?
        .set_password(&token)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn secure_get_token() -> Result<Option<String>, String> {
    match session_entry().map_err(|e| e.to_string())?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub(crate) fn secure_clear_token(
    session_uuid: String,
    state: tauri::State<'_, crate::ServerSessionState>,
) -> Result<(), String> {
    secure_clear_token_internal(&session_uuid, &state)
}

pub(crate) fn secure_clear_token_internal(
    session_uuid: &str,
    state: &crate::ServerSessionState,
) -> Result<(), String> {
    let id = crate::login_session_store::LoginSessionId::try_from(session_uuid.to_string())?;
    let active = state
        .login_session
        .lock()
        .map_err(|_| "login session lock poisoned")?;
    if active.is_some() && *active != Some(id) {
        return Ok(());
    }
    match session_entry()
        .map_err(|e| e.to_string())?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub(crate) fn secure_clear_residual_token(
    state: tauri::State<'_, crate::ServerSessionState>,
) -> Result<(), String> {
    let active = state
        .login_session
        .lock()
        .map_err(|_| "login session lock poisoned")?;
    if active.is_some() {
        return Err("cannot clear residual token while a login session is active".into());
    }
    match session_entry()
        .map_err(|e| e.to_string())?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
