//! Installation key/value state. Login lifecycle and other non-settings live here.
//! User preferences stay in `client_preferences` and are not cleared by logout.

use rusqlite::{params, Connection, OptionalExtension};

pub(crate) const LOGIN_STATE_KEY: &str = "loginState";
pub(crate) const SESSION_UUID_KEY: &str = "sessionUuid";

pub(crate) fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
         );",
    )
    .map_err(|e| format!("initialize app state: {e}"))
}

pub(crate) fn get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    ensure_schema(conn)?;
    conn.query_row(
        "SELECT value FROM app_state WHERE key=?1",
        [key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("read app state: {e}"))
}

pub(crate) fn put(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    ensure_schema(conn)?;
    conn.execute(
        "INSERT INTO app_state(key,value) VALUES(?1,?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )
    .map_err(|e| format!("write app state: {e}"))?;
    Ok(())
}

pub(crate) fn remove(conn: &Connection, key: &str) -> Result<(), String> {
    ensure_schema(conn)?;
    conn.execute("DELETE FROM app_state WHERE key=?1", [key])
        .map_err(|e| format!("delete app state: {e}"))?;
    Ok(())
}
