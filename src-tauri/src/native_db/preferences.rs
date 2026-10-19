use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use super::{chrono_millis, json_text, parse_json, preferences_connection};

#[cfg(target_os = "android")]
fn notification_key(key: &str) -> Result<&str, String> {
    match key {
        "notificationPreviewMode" | "notificationAlertPolicy" => Ok(key),
        _ => Err("unsupported device notification preference".into()),
    }
}

/// Android background services share the process's already-initialized device connection.
#[cfg(target_os = "android")]
pub(crate) fn read_notification_preference(key: &str) -> Result<Option<String>, String> {
    let key = notification_key(key)?;
    let preferences = preferences_connection()?;
    let value = preferences.with_database(|conn| {
        conn.query_row(
            "SELECT value_json FROM client_preferences WHERE scope='device' AND key=?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("read notification preference: {e}"))
    })?;
    value
        .map(|raw| {
            parse_json(raw)?
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "invalid notification preference value".to_string())
        })
        .transpose()
}

#[cfg(target_os = "android")]
pub(crate) fn write_notification_preference(key: &str, value: &str) -> Result<(), String> {
    let key = notification_key(key)?;
    let preferences = preferences_connection()?;
    let value = json_text(&Value::String(value.to_owned()))?;
    preferences.with_database(|conn| {
        conn.execute(
            "INSERT INTO client_preferences(scope,key,value_json,updated_at)
             VALUES('device',?1,?2,?3)
             ON CONFLICT(scope,key) DO UPDATE SET
               value_json=excluded.value_json, updated_at=excluded.updated_at",
            params![key, value, chrono_millis()],
        )
        .map_err(|e| format!("write notification preference: {e}"))?;
        Ok(())
    })
}

#[tauri::command]
pub(crate) async fn native_db_get_preference(
    scope: String,
    key: String,
) -> Result<Option<Value>, String> {
    let preferences = preferences_connection()?;
    tauri::async_runtime::spawn_blocking(move || {
        let value = preferences.with_database(|conn| {
            conn.query_row(
                "SELECT value_json FROM client_preferences WHERE scope = ?1 AND key = ?2",
                params![scope, key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("get preference: {e}"))
        })?;
        value.map(parse_json).transpose()
    })
    .await
    .map_err(|e| format!("join preference read: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_put_preference(
    scope: String,
    key: String,
    value: Value,
) -> Result<(), String> {
    let preferences = preferences_connection()?;
    tauri::async_runtime::spawn_blocking(move || {
        let value = json_text(&value)?;
        preferences.with_database(|conn| {
            conn.execute(
                "INSERT INTO client_preferences(scope, key, value_json, updated_at)
                 VALUES(?1, ?2, ?3, ?4)
                 ON CONFLICT(scope, key) DO UPDATE SET
                   value_json = excluded.value_json,
                   updated_at = excluded.updated_at",
                params![scope, key, value, chrono_millis()],
            )
            .map_err(|e| format!("put preference: {e}"))?;
            Ok(())
        })
    })
    .await
    .map_err(|e| format!("join preference write: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_delete_preference(scope: String, key: String) -> Result<(), String> {
    let preferences = preferences_connection()?;
    tauri::async_runtime::spawn_blocking(move || {
        preferences.with_database(|conn| {
            conn.execute(
                "DELETE FROM client_preferences WHERE scope = ?1 AND key = ?2",
                params![scope, key],
            )
            .map_err(|e| format!("delete preference: {e}"))?;
            Ok(())
        })
    })
    .await
    .map_err(|e| format!("join preference delete: {e}"))?
}
