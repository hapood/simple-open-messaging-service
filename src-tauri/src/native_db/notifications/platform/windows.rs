use super::CardObservation;
use crate::native_db::desktop_notifications::DesktopNotificationPermission;

pub(crate) async fn badge_refresh(_: tauri::AppHandle, _: String, _: i64) -> Result<(), String> {
    Ok(())
}

pub(crate) async fn permission() -> Result<DesktopNotificationPermission, String> {
    Ok(DesktopNotificationPermission::Unsupported)
}

pub(crate) async fn request_permission() -> Result<DesktopNotificationPermission, String> {
    Ok(DesktopNotificationPermission::Unsupported)
}

pub(crate) fn open_settings(_: tauri::AppHandle) -> Result<(), String> {
    Err("notification settings are not supported on this platform".into())
}

use crate::login_connection::LoginConnection;
use std::sync::Arc;

pub(crate) fn observe(app: Option<&tauri::AppHandle>, owner: &Arc<LoginConnection>) -> Result<CardObservation, String> {
    let app = app.ok_or("Windows notification observation requires an app handle")?;
    crate::native_db::desktop_notifications::restore_windows_cards(app, owner.clone()).map(CardObservation::Supported)
}
