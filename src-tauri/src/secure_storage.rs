//! Desktop OS credential storage. Persistence never activates or replaces a login.

fn session_entry() -> Result<keyring::Entry, keyring::Error> {
    keyring::Entry::new("soms", "session")
}

#[tauri::command]
pub(crate) fn secure_set_token(token: String, session_uuid: String) -> Result<(), String> {
    crate::credential_storage::persist(&session_uuid, &token, || {
        session_entry()
            .map_err(|e| e.to_string())?
            .set_password(&token)
            .map_err(|e| e.to_string())
    })
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
    secure_clear_token_internal()
}

pub(crate) fn secure_clear_token_internal() -> Result<(), String> {
    crate::credential_storage::clear(delete_credential)
}

#[tauri::command]
pub(crate) fn secure_clear_residual_token() -> Result<(), String> {
    crate::credential_storage::clear(delete_credential)
}

fn delete_credential() -> Result<(), String> {
    match session_entry()
        .map_err(|e| e.to_string())?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
