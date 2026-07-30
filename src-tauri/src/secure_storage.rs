//! Desktop trusted-device credential storage.
//!
//! Mobile persists its session in the Android native encrypted store, so this
//! module is compiled only for desktop targets.

fn session_entry() -> Result<keyring::Entry, keyring::Error> {
    keyring::Entry::new("soms", "session")
}

#[tauri::command]
pub(crate) fn secure_set_token(token: String) -> Result<(), String> {
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
pub(crate) fn secure_clear_token() -> Result<(), String> {
    match session_entry()
        .map_err(|e| e.to_string())?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
