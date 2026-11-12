//! Serializes OS credential I/O, not login transitions. No lifecycle or owner-slot lock is
//! held across the adapter call. A queued write validates its captured owner only after it
//! reaches the storage lane; an old completion cannot overwrite a successor's stored value.
use std::sync::Mutex;

static STORAGE: Mutex<()> = Mutex::new(());

#[cfg(test)]
#[path = "tests/credential_storage_tests.rs"]
mod tests;

pub(crate) fn persist<T>(
    session_uuid: &str,
    token: &str,
    write: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let id = crate::login_session_store::LoginSessionId::try_from(session_uuid.to_string())?;
    let owner = crate::native_db::login_connection(&id)?;
    let _storage = STORAGE
        .lock()
        .map_err(|_| "credential storage lane poisoned")?;
    if owner.credential().map_err(|e| e.to_string())? != token {
        return Err("credential mismatch".into());
    }
    let result = write()?;
    owner.assert_active().map_err(|e| e.to_string())?;
    Ok(result)
}

pub(crate) fn clear(
    clear: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let _storage = STORAGE
        .lock()
        .map_err(|_| "credential storage lane poisoned")?;
    // Login transitions serialize logout cleanup before admitting another login.
    // This storage adapter executes deletion; it is not a second session authority.
    clear()
}
