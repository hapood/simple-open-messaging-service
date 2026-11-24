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

pub(crate) fn observe(_: Option<&tauri::AppHandle>, _: &Arc<LoginConnection>) -> Result<CardObservation, String> {
    Ok(CardObservation::Unsupported)
}
