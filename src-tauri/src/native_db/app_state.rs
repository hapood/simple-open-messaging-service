//! Installation key/value state. The app lifecycle and other records that are not user
//! settings live here; user settings stay in `settings` and are never changed by logout.
//! Every value is JSON text.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

pub(crate) const SCHEMA_VERSION_KEY: &str = "schemaVersion";
pub(crate) const SCHEMA_VERSION: u8 = 1;
pub(crate) const LIFECYCLE_STATE_KEY: &str = "lifecycleState";
pub(crate) const SESSION_UUID_KEY: &str = "sessionUuid";

pub(crate) fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
         );",
    )
    .map_err(|e| format!("create app state table: {e}"))
}

/// A value that is not valid JSON is an error, never an absent record.
pub(crate) fn get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM app_state WHERE key=?1", [key], |row| {
        row.get(0)
    })
    .optional()
    .map_err(|e| format!("read app state {key}: {e}"))
}

pub(crate) fn put(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO app_state(key,value) VALUES(?1,?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )
    .map_err(|e| format!("write app state {key}: {e}"))?;
    Ok(())
}

pub(crate) fn remove(conn: &Connection, key: &str) -> Result<(), String> {
    conn.execute("DELETE FROM app_state WHERE key=?1", [key])
        .map_err(|e| format!("delete app state {key}: {e}"))?;
    Ok(())
}

fn ensure_renderer_writable(key: &str) -> Result<(), String> {
    if matches!(
        key,
        SCHEMA_VERSION_KEY
            | LIFECYCLE_STATE_KEY
            | SESSION_UUID_KEY
            | crate::forward_recent_targets::RECENT_TARGETS_KEY
    ) {
        return Err(format!("app state key {key} is owned by Rust"));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn native_db_get_app_state(key: String) -> Result<Option<Value>, String> {
    let preferences = super::preferences_connection()?;
    tauri::async_runtime::spawn_blocking(move || {
        preferences.with_database(|conn| {
            let Some(raw) = get(conn, &key)? else {
                return Ok(None);
            };
            serde_json::from_str(&raw)
                .map(Some)
                .map_err(|e| format!("decode app state {key}: {e}"))
        })
    })
    .await
    .map_err(|e| format!("join app state read: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_put_app_state(key: String, value: Value) -> Result<(), String> {
    ensure_renderer_writable(&key)?;
    let encoded =
        serde_json::to_string(&value).map_err(|e| format!("encode app state {key}: {e}"))?;
    let preferences = super::preferences_connection()?;
    tauri::async_runtime::spawn_blocking(move || {
        preferences.with_database(|conn| put(conn, &key, &encoded))
    })
    .await
    .map_err(|e| format!("join app state write: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_delete_app_state(key: String) -> Result<(), String> {
    ensure_renderer_writable(&key)?;
    let preferences = super::preferences_connection()?;
    tauri::async_runtime::spawn_blocking(move || {
        preferences.with_database(|conn| remove(conn, &key))
    })
    .await
    .map_err(|e| format!("join app state delete: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_cannot_bypass_recent_targets_session_admission() {
        // Both generic put and delete commands use this guard before opening the database.
        assert!(
            ensure_renderer_writable(crate::forward_recent_targets::RECENT_TARGETS_KEY).is_err()
        );
        assert!(ensure_renderer_writable("pushDeviceId").is_ok());
    }
}
