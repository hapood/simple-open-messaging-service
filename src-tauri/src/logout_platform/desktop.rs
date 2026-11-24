pub(crate) fn cleanup(app: &tauri::AppHandle, _: &str) -> Result<(), String> {
    crate::native_db::desktop_notifications::clear_notifications(app, true)?;
    crate::secure_storage::secure_clear_token_internal()
}
