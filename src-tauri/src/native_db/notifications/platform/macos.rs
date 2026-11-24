use super::CardObservation;
use crate::native_db::desktop_notifications::{macos_platform, DesktopNotificationPermission};

pub(crate) async fn badge_refresh(app: tauri::AppHandle, session_uuid: String, user_id: i64) -> Result<(), String> {
    crate::native_db::desktop_badge::refresh(app, session_uuid, user_id).await
}

pub(crate) async fn permission() -> Result<DesktopNotificationPermission, String> {
    macos_platform::permission().await
}

pub(crate) async fn request_permission() -> Result<DesktopNotificationPermission, String> {
    // A denial is a permission state, not a transport failure.
    let result = macos_platform::authorize().await;
    let permission = macos_platform::permission().await?;
    if permission == DesktopNotificationPermission::Denied {
        return Ok(permission);
    }
    result?;
    Ok(permission)
}

pub(crate) fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    // The webview cannot supply a URL to this operation.
    app.opener().open_url(
        "x-apple.systempreferences:com.apple.preference.notifications",
        None::<&str>,
    ).map_err(|error| error.to_string())
}

use crate::login_connection::LoginConnection;
use std::sync::Arc;

pub(crate) fn observe(_: Option<&tauri::AppHandle>, _: &Arc<LoginConnection>) -> Result<CardObservation, String> {
    crate::native_db::desktop_notifications::macos_platform::restore_cards().map(CardObservation::Supported)
}
