use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tauri::Manager;

const DB_FILENAME: &str = "soms-local.sqlite3";

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create app data: {e}"))?;
    Ok(dir.join(DB_FILENAME))
}

fn open(app: &tauri::AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(db_path(app)?).map_err(|e| format!("open native db: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("configure native db: {e}"))?;
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS threads (
          user_id INTEGER NOT NULL,
          thread_id INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (user_id, thread_id)
        );
        CREATE TABLE IF NOT EXISTS profiles (
          user_id INTEGER NOT NULL,
          identity TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          profile_rev INTEGER NOT NULL,
          PRIMARY KEY (user_id, identity)
        );
        CREATE TABLE IF NOT EXISTS sync_state (
          user_id INTEGER NOT NULL,
          key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          PRIMARY KEY (user_id, key)
        );
        CREATE TABLE IF NOT EXISTS client_preferences (
          scope TEXT NOT NULL,
          key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (scope, key)
        );
        CREATE TABLE IF NOT EXISTS notification_global_state (
          account_id INTEGER PRIMARY KEY,
          cursor_thread_id INTEGER,
          cursor_seq INTEGER,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS notification_thread_state (
          account_id INTEGER NOT NULL,
          thread_id INTEGER NOT NULL,
          dismissed_seq INTEGER,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, thread_id)
        );
        CREATE TABLE IF NOT EXISTS avatars (
          user_id INTEGER NOT NULL,
          identity TEXT NOT NULL,
          source_path TEXT NOT NULL,
          mime TEXT NOT NULL,
          data BLOB NOT NULL,
          last_render INTEGER NOT NULL,
          PRIMARY KEY (user_id, identity)
        );
        CREATE TABLE IF NOT EXISTS messages (
          user_id INTEGER NOT NULL,
          thread_id INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (user_id, thread_id, seq)
        );
        CREATE INDEX IF NOT EXISTS messages_user_thread_seq
          ON messages(user_id, thread_id, seq);
        ",
    )
    .map_err(|e| format!("migrate native db: {e}"))?;
    Ok(conn)
}

#[tauri::command]
pub(crate) async fn native_db_get_preference(
    app: tauri::AppHandle,
    scope: String,
    key: String,
) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let value = open(&app)?
            .query_row(
                "SELECT value_json FROM client_preferences WHERE scope = ?1 AND key = ?2",
                params![scope, key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("get preference: {e}"))?;
        value.map(parse_json).transpose()
    })
    .await
    .map_err(|e| format!("join preference read: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_put_preference(
    app: tauri::AppHandle,
    scope: String,
    key: String,
    value: Value,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        open(&app)?
            .execute(
                "INSERT INTO client_preferences(scope, key, value_json, updated_at)
                 VALUES(?1, ?2, ?3, ?4)
                 ON CONFLICT(scope, key) DO UPDATE SET
                   value_json = excluded.value_json,
                   updated_at = excluded.updated_at",
                params![scope, key, json_text(&value)?, chrono_millis()],
            )
            .map_err(|e| format!("put preference: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("join preference write: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_delete_preference(
    app: tauri::AppHandle,
    scope: String,
    key: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        open(&app)?
            .execute(
                "DELETE FROM client_preferences WHERE scope = ?1 AND key = ?2",
                params![scope, key],
            )
            .map_err(|e| format!("delete preference: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("join preference delete: {e}"))?
}

fn json_text(value: &Value) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| format!("encode native db value: {e}"))
}

fn parse_json(value: String) -> Result<Value, String> {
    serde_json::from_str(&value).map_err(|e| format!("decode native db value: {e}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadDelta {
    thread_id: i64,
    direction: String,
    item: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeAvatar {
    identity: String,
    path: String,
    mime: String,
    data: Vec<u8>,
    last_render: i64,
}

#[tauri::command]
pub(crate) async fn native_db_get_avatar(
    app: tauri::AppHandle,
    user_id: i64,
    identity: String,
) -> Result<Option<NativeAvatar>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        let avatar = conn
            .query_row(
                "SELECT source_path, mime, data, last_render FROM avatars
                 WHERE user_id = ?1 AND identity = ?2",
                params![user_id, identity],
                |row| {
                    Ok(NativeAvatar {
                        identity: identity.clone(),
                        path: row.get(0)?,
                        mime: row.get(1)?,
                        data: row.get(2)?,
                        last_render: row.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(|e| format!("get avatar: {e}"))?;
        if avatar.is_some() {
            conn.execute(
                "UPDATE avatars SET last_render = ?3 WHERE user_id = ?1 AND identity = ?2",
                params![user_id, identity, chrono_millis()],
            )
            .map_err(|e| format!("touch avatar: {e}"))?;
        }
        Ok(avatar)
    })
    .await
    .map_err(|e| format!("join avatar read: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_put_avatar(
    app: tauri::AppHandle,
    user_id: i64,
    identity: String,
    path: String,
    mime: String,
    data: Vec<u8>,
    last_render: i64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        open(&app)?
            .execute(
                "INSERT INTO avatars(user_id, identity, source_path, mime, data, last_render)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(user_id, identity) DO UPDATE SET
                   source_path = excluded.source_path,
                   mime = excluded.mime,
                   data = excluded.data,
                   last_render = excluded.last_render",
                params![user_id, identity, path, mime, data, last_render],
            )
            .map_err(|e| format!("put avatar: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("join avatar write: {e}"))?
}

fn chrono_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[tauri::command]
pub(crate) async fn native_db_threads(
    app: tauri::AppHandle,
    user_id: i64,
) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        let mut stmt = conn
            .prepare("SELECT payload_json FROM threads WHERE user_id = ?1")
            .map_err(|e| format!("prepare thread read: {e}"))?;
        let rows = stmt
            .query_map([user_id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("query threads: {e}"))?;
        rows.map(|row| {
            row.map_err(|e| format!("read thread: {e}"))
                .and_then(parse_json)
        })
        .collect()
    })
    .await
    .map_err(|e| format!("join thread read: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_put_thread(
    app: tauri::AppHandle,
    user_id: i64,
    thread_id: i64,
    item: Value,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        open(&app)?
            .execute(
                "INSERT INTO threads(user_id, thread_id, payload_json) VALUES(?1, ?2, ?3)
                 ON CONFLICT(user_id, thread_id) DO UPDATE SET payload_json = excluded.payload_json",
                params![user_id, thread_id, json_text(&item)?],
            )
            .map_err(|e| format!("put thread: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("join thread write: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_replace_threads(
    app: tauri::AppHandle,
    user_id: i64,
    items: Vec<Value>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open(&app)?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("begin replace threads: {e}"))?;
        tx.execute("DELETE FROM threads WHERE user_id = ?1", [user_id])
            .map_err(|e| format!("clear threads: {e}"))?;
        for item in items {
            let thread_id = item
                .get("threadId")
                .and_then(Value::as_i64)
                .ok_or_else(|| "thread item has no numeric threadId".to_string())?;
            tx.execute(
                "INSERT INTO threads(user_id, thread_id, payload_json) VALUES(?1, ?2, ?3)",
                params![user_id, thread_id, json_text(&item)?],
            )
            .map_err(|e| format!("insert thread: {e}"))?;
        }
        tx.commit()
            .map_err(|e| format!("commit replace threads: {e}"))
    })
    .await
    .map_err(|e| format!("join replace threads: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_delete_thread(
    app: tauri::AppHandle,
    user_id: i64,
    thread_id: i64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        open(&app)?
            .execute(
                "DELETE FROM threads WHERE user_id = ?1 AND thread_id = ?2",
                params![user_id, thread_id],
            )
            .map_err(|e| format!("delete thread: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("join delete thread: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_apply_thread_delta(
    app: tauri::AppHandle,
    user_id: i64,
    revision: i64,
    delta: Vec<ThreadDelta>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open(&app)?;
        let tx = conn.transaction().map_err(|e| format!("begin thread delta: {e}"))?;
        for op in delta {
            match op.direction.as_str() {
                "DELETE" => {
                    tx.execute(
                        "DELETE FROM threads WHERE user_id = ?1 AND thread_id = ?2",
                        params![user_id, op.thread_id],
                    )
                    .map_err(|e| format!("apply thread delete: {e}"))?;
                }
                "ADD" => {
                    let item = op.item.ok_or_else(|| "ADD delta has no item".to_string())?;
                    tx.execute(
                        "INSERT INTO threads(user_id, thread_id, payload_json) VALUES(?1, ?2, ?3)
                         ON CONFLICT(user_id, thread_id) DO UPDATE SET payload_json = excluded.payload_json",
                        params![user_id, op.thread_id, json_text(&item)?],
                    )
                    .map_err(|e| format!("apply thread add: {e}"))?;
                }
                other => return Err(format!("unknown thread delta direction: {other}")),
            }
        }
        tx.execute(
            "INSERT INTO sync_state(user_id, key, value_json) VALUES(?1, 'threadRevision', ?2)
             ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json",
            params![user_id, revision.to_string()],
        )
        .map_err(|e| format!("save thread revision: {e}"))?;
        tx.commit().map_err(|e| format!("commit thread delta: {e}"))
    })
    .await
    .map_err(|e| format!("join thread delta: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_get_profile(
    app: tauri::AppHandle,
    user_id: i64,
    identity: String,
) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let value = open(&app)?
            .query_row(
                "SELECT payload_json FROM profiles WHERE user_id = ?1 AND identity = ?2",
                params![user_id, identity],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("get profile: {e}"))?;
        value.map(parse_json).transpose()
    })
    .await
    .map_err(|e| format!("join profile read: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_put_profile(
    app: tauri::AppHandle,
    user_id: i64,
    identity: String,
    profile_rev: i64,
    profile: Value,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        let changed = conn
            .execute(
                "INSERT INTO profiles(user_id, identity, payload_json, profile_rev)
                 VALUES(?1, ?2, ?3, ?4)
                 ON CONFLICT(user_id, identity) DO UPDATE SET
                   payload_json = excluded.payload_json,
                   profile_rev = excluded.profile_rev
                 WHERE excluded.profile_rev >= profiles.profile_rev",
                params![user_id, identity, json_text(&profile)?, profile_rev],
            )
            .map_err(|e| format!("put profile: {e}"))?;
        Ok(changed > 0)
    })
    .await
    .map_err(|e| format!("join profile write: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_get_meta(
    app: tauri::AppHandle,
    user_id: i64,
    key: String,
) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let value = open(&app)?
            .query_row(
                "SELECT value_json FROM sync_state WHERE user_id = ?1 AND key = ?2",
                params![user_id, key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("get sync state: {e}"))?;
        value.map(parse_json).transpose()
    })
    .await
    .map_err(|e| format!("join sync-state read: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_put_meta(
    app: tauri::AppHandle,
    user_id: i64,
    key: String,
    value: Value,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        open(&app)?
            .execute(
                "INSERT INTO sync_state(user_id, key, value_json) VALUES(?1, ?2, ?3)
                 ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json",
                params![user_id, key, json_text(&value)?],
            )
            .map_err(|e| format!("put sync state: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("join sync-state write: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_query_messages(
    app: tauri::AppHandle,
    user_id: i64,
    thread_id: i64,
    anchor: Option<i64>,
    order_by: String,
    take: i64,
) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        let (sql, bound) = match (order_by.as_str(), anchor) {
            ("desc", Some(anchor)) => (
                "SELECT payload_json FROM messages
                 WHERE user_id = ?1 AND thread_id = ?2 AND seq < ?3
                 ORDER BY seq DESC LIMIT ?4",
                anchor,
            ),
            ("asc", Some(anchor)) => (
                "SELECT payload_json FROM messages
                 WHERE user_id = ?1 AND thread_id = ?2 AND seq > ?3
                 ORDER BY seq ASC LIMIT ?4",
                anchor,
            ),
            ("desc", None) => (
                "SELECT payload_json FROM messages
                 WHERE user_id = ?1 AND thread_id = ?2 AND seq <= ?3
                 ORDER BY seq DESC LIMIT ?4",
                i64::MAX,
            ),
            ("asc", None) => (
                "SELECT payload_json FROM messages
                 WHERE user_id = ?1 AND thread_id = ?2 AND seq >= ?3
                 ORDER BY seq ASC LIMIT ?4",
                i64::MIN,
            ),
            (other, _) => return Err(format!("unknown message order: {other}")),
        };
        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| format!("prepare message query: {e}"))?;
        let rows = stmt
            .query_map(params![user_id, thread_id, bound, take.max(0)], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| format!("query messages: {e}"))?;
        rows.map(|row| {
            row.map_err(|e| format!("read message: {e}"))
                .and_then(parse_json)
        })
        .collect()
    })
    .await
    .map_err(|e| format!("join message query: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_put_messages(
    app: tauri::AppHandle,
    user_id: i64,
    messages: Vec<Value>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open(&app)?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("begin message write: {e}"))?;
        for message in messages {
            let thread_id = message
                .get("threadId")
                .and_then(Value::as_i64)
                .ok_or_else(|| "message has no numeric threadId".to_string())?;
            let seq = message
                .get("seq")
                .and_then(Value::as_i64)
                .ok_or_else(|| "message has no numeric seq".to_string())?;
            let created_at = message
                .get("createdAt")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            tx.execute(
                "INSERT INTO messages(user_id, thread_id, seq, created_at, payload_json)
                 VALUES(?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(user_id, thread_id, seq) DO UPDATE SET
                   created_at = excluded.created_at,
                   payload_json = excluded.payload_json",
                params![user_id, thread_id, seq, created_at, json_text(&message)?],
            )
            .map_err(|e| format!("put message: {e}"))?;
        }
        tx.commit()
            .map_err(|e| format!("commit message write: {e}"))
    })
    .await
    .map_err(|e| format!("join message write: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_get_message(
    app: tauri::AppHandle,
    user_id: i64,
    thread_id: i64,
    seq: i64,
) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let value = open(&app)?
            .query_row(
                "SELECT payload_json FROM messages
                 WHERE user_id = ?1 AND thread_id = ?2 AND seq = ?3",
                params![user_id, thread_id, seq],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("get message: {e}"))?;
        value.map(parse_json).transpose()
    })
    .await
    .map_err(|e| format!("join message read: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_newest_messages(
    app: tauri::AppHandle,
    user_id: i64,
    thread_ids: Vec<i64>,
) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        let mut stmt = conn
            .prepare(
                "SELECT payload_json FROM messages
                 WHERE user_id = ?1 AND thread_id = ?2
                 ORDER BY seq DESC LIMIT 1",
            )
            .map_err(|e| format!("prepare newest-message query: {e}"))?;
        let mut out = Vec::with_capacity(thread_ids.len());
        for thread_id in thread_ids {
            let value = stmt
                .query_row(params![user_id, thread_id], |row| row.get::<_, String>(0))
                .optional()
                .map_err(|e| format!("query newest message: {e}"))?;
            if let Some(value) = value {
                out.push(parse_json(value)?);
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("join newest-message query: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_delete_messages_by_thread(
    app: tauri::AppHandle,
    user_id: i64,
    thread_id: i64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        open(&app)?
            .execute(
                "DELETE FROM messages WHERE user_id = ?1 AND thread_id = ?2",
                params![user_id, thread_id],
            )
            .map_err(|e| format!("delete thread messages: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("join thread-message delete: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_clear_user(
    app: tauri::AppHandle,
    user_id: i64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open(&app)?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("begin user clear: {e}"))?;
        for table in ["threads", "profiles", "sync_state", "avatars", "messages"] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE user_id = ?1"),
                [user_id],
            )
            .map_err(|e| format!("clear {table}: {e}"))?;
        }
        tx.commit().map_err(|e| format!("commit user clear: {e}"))
    })
    .await
    .map_err(|e| format!("join user clear: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_clear_all(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = db_path(&app)?;
        if path.exists() {
            let conn = open(&app)?;
            conn.execute_batch(
                "DELETE FROM threads; DELETE FROM profiles; DELETE FROM sync_state; DELETE FROM avatars;
                 DELETE FROM messages; VACUUM;",
            )
            .map_err(|e| format!("clear native db: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("join native db clear: {e}"))?
}
