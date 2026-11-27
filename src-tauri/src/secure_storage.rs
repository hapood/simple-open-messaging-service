//! Desktop OS credential storage. The token is stored together with the UUID of the login it
//! belongs to; persistence never activates or replaces a login.

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredLoginCredential {
    pub(crate) token: String,
    pub(crate) session_uuid: String,
}

fn session_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("soms", "session").map_err(|e| e.to_string())
}

fn read(entry: keyring::Entry) -> Result<Option<String>, String> {
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn parse_pair(raw: &str) -> Option<StoredLoginCredential> {
    let pair: StoredLoginCredential = serde_json::from_str(raw).ok()?;
    if pair.token.is_empty() || pair.session_uuid.is_empty() {
        return None;
    }
    Some(pair)
}

#[tauri::command]
pub(crate) fn secure_set_token(token: String, session_uuid: String) -> Result<(), String> {
    crate::credential_storage::persist(&session_uuid, &token, || {
        let payload = serde_json::to_string(&StoredLoginCredential {
            token: token.clone(),
            session_uuid: session_uuid.clone(),
        })
        .map_err(|e| e.to_string())?;
        session_entry()?
            .set_password(&payload)
            .map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub(crate) fn secure_get_login() -> Result<Option<StoredLoginCredential>, String> {
    let Some(raw) = read(session_entry()?)? else {
        return Ok(None);
    };
    if let Some(pair) = parse_pair(&raw) {
        return Ok(Some(pair));
    }
    delete_credential()?;
    Err("unreadable login credential".into())
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
    match session_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
