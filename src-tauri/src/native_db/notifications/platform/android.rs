use super::CardObservation;
use crate::login_connection::LoginConnection;
use std::sync::Arc;

pub(crate) fn observe(_: Option<&tauri::AppHandle>, _: &Arc<LoginConnection>) -> Result<CardObservation, String> {
    crate::android_notifications::restore_cards().map(CardObservation::Supported)
}
