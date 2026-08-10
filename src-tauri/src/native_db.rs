use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tauri::Manager;

const DB_FILENAME: &str = "soms-local.sqlite3";
const CACHE_SCHEMA_VERSION: i64 = 1;

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create app data: {e}"))?;
    Ok(dir.join(DB_FILENAME))
}

fn configure(conn: &Connection) -> Result<(), String> {
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("configure native db: {e}"))?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("configure native db: {e}"))
}

/// Device preferences must be available before authentication. This is the only ordinary open path
/// allowed to create the SQLite file, and it creates only the device-scoped preference table.
fn open_preferences(app: &tauri::AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(db_path(app)?).map_err(|e| format!("open preference db: {e}"))?;
    configure(&conn)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS client_preferences (
           scope TEXT NOT NULL,
           key TEXT NOT NULL,
           value_json TEXT NOT NULL,
           updated_at INTEGER NOT NULL,
           PRIMARY KEY (scope, key)
         );",
    )
    .map_err(|e| format!("initialize preference db: {e}"))?;
    Ok(conn)
}

/// Open an already-initialized account cache. Unlike `Connection::open`, this cannot create a missing
/// database file and never repairs missing tables during a read/write command.
fn open_cache(app: &tauri::AppHandle) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        db_path(app)?,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("open existing native cache: {e}"))?;
    configure(&conn)?;
    validate_cache_schema(&conn)?;
    Ok(conn)
}

// Account-cache commands use the strict existing-schema path. Kept as a short local alias so every
// command below cannot accidentally regain rusqlite's create-on-open behavior.
fn open(app: &tauri::AppHandle) -> Result<Connection, String> {
    open_cache(app)
}

fn validate_cache_schema(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row(
            "SELECT CAST(value_json AS INTEGER) FROM client_preferences
             WHERE scope='cache' AND key='schemaVersion'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("read native cache schema version: {e}"))?;
    if version != CACHE_SCHEMA_VERSION {
        return Err(format!(
            "native cache schema version mismatch: expected {CACHE_SCHEMA_VERSION}, got {version}"
        ));
    }
    for object in [
        "threads",
        "profiles",
        "sync_state",
        "notification_global_state",
        "notification_thread_state",
        "avatars",
        "messages",
    ] {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [object],
                |row| row.get(0),
            )
            .map_err(|e| format!("validate native cache table {object}: {e}"))?;
        if !exists {
            return Err(format!("native cache schema missing table: {object}"));
        }
    }
    for index in [
        "messages_user_thread_seq",
        "messages_section_left",
        "messages_section_right",
    ] {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1)",
                [index],
                |row| row.get(0),
            )
            .map_err(|e| format!("validate native cache index {index}: {e}"))?;
        if !exists {
            return Err(format!("native cache schema missing index: {index}"));
        }
    }
    Ok(())
}

fn create_cache_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
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
          section_left INTEGER,
          section_right INTEGER,
          PRIMARY KEY (user_id, thread_id, seq)
        );
        CREATE INDEX IF NOT EXISTS messages_user_thread_seq
          ON messages(user_id, thread_id, seq);
        ",
    )
    .map_err(|e| format!("initialize native cache: {e}"))?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS messages_section_left
           ON messages(user_id, thread_id, seq) WHERE section_left = 1;
         CREATE INDEX IF NOT EXISTS messages_section_right
           ON messages(user_id, thread_id, seq) WHERE section_right = 1;",
    )
    .map_err(|e| format!("initialize native cache indexes: {e}"))?;
    conn.execute(
        "INSERT INTO client_preferences(scope,key,value_json,updated_at)
         VALUES('cache','schemaVersion',?1,?2)
         ON CONFLICT(scope,key) DO UPDATE SET
           value_json=excluded.value_json, updated_at=excluded.updated_at",
        params![CACHE_SCHEMA_VERSION.to_string(), chrono_millis()],
    )
    .map_err(|e| format!("set native cache schema version: {e}"))?;
    Ok(())
}

fn drop_cache_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS threads;
         DROP TABLE IF EXISTS profiles;
         DROP TABLE IF EXISTS sync_state;
         DROP TABLE IF EXISTS notification_global_state;
         DROP TABLE IF EXISTS notification_thread_state;
         DROP TABLE IF EXISTS avatars;
         DROP TABLE IF EXISTS messages;
         DELETE FROM client_preferences WHERE scope='cache' AND key='schemaVersion';",
    )
    .map_err(|e| format!("drop native cache: {e}"))
}

/// Explicit fresh-login initialization. Device preferences survive; all rebuildable account cache tables
/// are dropped and recreated as one schema operation.
#[tauri::command]
pub(crate) async fn native_db_recreate_cache(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_preferences(&app)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Exclusive)
            .map_err(|e| format!("begin native cache recreation: {e}"))?;
        drop_cache_schema(&tx)?;
        create_cache_schema(&tx)?;
        tx.commit()
            .map_err(|e| format!("commit native cache recreation: {e}"))
    })
    .await
    .map_err(|e| format!("join native cache initialization: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_validate_cache(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_cache(&app).map(drop))
        .await
        .map_err(|e| format!("join native cache validation: {e}"))?
}

/// Rebuild only chat messages and their derived coverage state. SQLite DDL runs in one exclusive
/// transaction, so existing statements finish first and new database writers cannot interleave.
#[tauri::command]
pub(crate) async fn native_db_recreate_messages(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_cache(&app)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Exclusive)
            .map_err(|e| format!("begin message cache recreation: {e}"))?;
        tx.execute_batch(
            "DROP TABLE messages;
             DELETE FROM sync_state WHERE key LIKE 'messageCoverage:%';
             CREATE TABLE messages (
               user_id INTEGER NOT NULL,
               thread_id INTEGER NOT NULL,
               seq INTEGER NOT NULL,
               created_at INTEGER NOT NULL,
               payload_json TEXT NOT NULL,
               section_left INTEGER,
               section_right INTEGER,
               PRIMARY KEY (user_id, thread_id, seq)
             );
             CREATE INDEX messages_user_thread_seq ON messages(user_id, thread_id, seq);
             CREATE INDEX messages_section_left
               ON messages(user_id, thread_id, seq) WHERE section_left = 1;
             CREATE INDEX messages_section_right
               ON messages(user_id, thread_id, seq) WHERE section_right = 1;",
        )
        .map_err(|e| format!("recreate message cache: {e}"))?;
        tx.commit()
            .map_err(|e| format!("commit message cache recreation: {e}"))
    })
    .await
    .map_err(|e| format!("join message cache recreation: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_count_messages(
    app: tauri::AppHandle,
    user_id: i64,
) -> Result<i64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        open_cache(&app)?
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE user_id = ?1",
                [user_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("count cached messages: {e}"))
    })
    .await
    .map_err(|e| format!("join cached message count: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_get_preference(
    app: tauri::AppHandle,
    scope: String,
    key: String,
) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let value = open_preferences(&app)?
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
        open_preferences(&app)?
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
        open_preferences(&app)?
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
    thread_id: Option<i64>,
    direction: String,
    item: Option<Value>,
    user: Option<Value>,
    revision: Option<i64>,
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
                    let thread_id = op.thread_id.ok_or_else(|| "DELETE delta has no threadId".to_string())?;
                    tx.execute(
                        "DELETE FROM threads WHERE user_id = ?1 AND thread_id = ?2",
                        params![user_id, thread_id],
                    )
                    .map_err(|e| format!("apply thread delete: {e}"))?;
                }
                "ADD" => {
                    let thread_id = op.thread_id.ok_or_else(|| "ADD delta has no threadId".to_string())?;
                    let item = op.item.ok_or_else(|| "ADD delta has no item".to_string())?;
                    tx.execute(
                        "INSERT INTO threads(user_id, thread_id, payload_json) VALUES(?1, ?2, ?3)
                         ON CONFLICT(user_id, thread_id) DO UPDATE SET payload_json = excluded.payload_json",
                        params![user_id, thread_id, json_text(&item)?],
                    )
                    .map_err(|e| format!("apply thread add: {e}"))?;
                }
                "PROFILE" => {
                    let profile = op.user.ok_or_else(|| "PROFILE delta has no user".to_string())?;
                    let id = profile.get("id").and_then(Value::as_i64).ok_or_else(|| "PROFILE user has no id".to_string())?;
                    let profile_rev = profile.get("profileRev").and_then(Value::as_i64).ok_or_else(|| "PROFILE user has no profileRev".to_string())?;
                    let identity = format!("u{id}");
                    tx.execute(
                        "INSERT INTO profiles(user_id, identity, payload_json, profile_rev) VALUES(?1, ?2, ?3, ?4)
                         ON CONFLICT(user_id, identity) DO UPDATE SET payload_json=excluded.payload_json, profile_rev=excluded.profile_rev
                         WHERE excluded.profile_rev >= profiles.profile_rev",
                        params![user_id, identity, json_text(&profile)?, profile_rev],
                    ).map_err(|e| format!("apply profile state: {e}"))?;
                }
                "FRIEND_REQUEST" => {
                    let friend_revision = op.revision.ok_or_else(|| "FRIEND_REQUEST delta has no revision".to_string())?;
                    tx.execute(
                        "INSERT INTO sync_state(user_id, key, value_json) VALUES(?1, 'friendRequestStateRevision', ?2)
                         ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json",
                        params![user_id, friend_revision.to_string()],
                    )
                    .map_err(|e| format!("save friend-request state revision: {e}"))?;
                }
                other => return Err(format!("unknown thread delta direction: {other}")),
            }
        }
        tx.execute(
            "INSERT INTO sync_state(user_id, key, value_json) VALUES(?1, 'stateRevision', ?2)
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
pub(crate) async fn native_db_apply_missed_summary(
    app: tauri::AppHandle,
    user_id: i64,
    items: Vec<Value>,
    cursor: Value,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open(&app)?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("begin missed summary: {e}"))?;
        tx.execute("DELETE FROM threads WHERE user_id = ?1", params![user_id])
            .map_err(|e| format!("clear missed-summary threads: {e}"))?;
        for item in items {
            let thread_id = item
                .get("threadId")
                .and_then(Value::as_i64)
                .ok_or_else(|| "missed-summary item has no threadId".to_string())?;
            tx.execute(
                "INSERT INTO threads(user_id, thread_id, payload_json) VALUES(?1, ?2, ?3)",
                params![user_id, thread_id, json_text(&item)?],
            )
            .map_err(|e| format!("save missed-summary thread: {e}"))?;
        }
        tx.execute(
            "INSERT INTO sync_state(user_id, key, value_json) VALUES(?1, 'missedCursor', ?2)
             ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json",
            params![user_id, json_text(&cursor)?],
        )
        .map_err(|e| format!("save missed-summary cursor: {e}"))?;
        tx.commit()
            .map_err(|e| format!("commit missed summary: {e}"))
    })
    .await
    .map_err(|e| format!("join missed summary: {e}"))?
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
                   AND COALESCE(json_extract(payload_json, '$.isDeleted'), 0) != 1
                 ORDER BY seq DESC LIMIT ?4",
                anchor,
            ),
            ("asc", Some(anchor)) => (
                "SELECT payload_json FROM messages
                 WHERE user_id = ?1 AND thread_id = ?2 AND seq > ?3
                   AND COALESCE(json_extract(payload_json, '$.isDeleted'), 0) != 1
                 ORDER BY seq ASC LIMIT ?4",
                anchor,
            ),
            ("desc", None) => (
                "SELECT payload_json FROM messages
                 WHERE user_id = ?1 AND thread_id = ?2 AND seq <= ?3
                   AND COALESCE(json_extract(payload_json, '$.isDeleted'), 0) != 1
                 ORDER BY seq DESC LIMIT ?4",
                i64::MAX,
            ),
            ("asc", None) => (
                "SELECT payload_json FROM messages
                 WHERE user_id = ?1 AND thread_id = ?2 AND seq >= ?3
                   AND COALESCE(json_extract(payload_json, '$.isDeleted'), 0) != 1
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
    confirmed_section: Option<MessageSection>,
    known_newest_seq: Option<i64>,
    coverage_thread_id: Option<i64>,
) -> Result<Option<MessageCoverageState>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open(&app)?;
        let message_thread_id = messages
            .first()
            .and_then(|message| message.get("threadId"))
            .and_then(Value::as_i64);
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
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
                   created_at = CASE
                     WHEN COALESCE(json_extract(messages.payload_json, '$.isDeleted'), 0) = 1
                     THEN messages.created_at ELSE excluded.created_at END,
                   payload_json = CASE
                     WHEN COALESCE(json_extract(messages.payload_json, '$.isDeleted'), 0) = 1
                     THEN messages.payload_json ELSE excluded.payload_json END",
                params![user_id, thread_id, seq, created_at, json_text(&message)?],
            )
            .map_err(|e| format!("put message: {e}"))?;
        }
        let merged = confirmed_section
            .map(|section| merge_message_section(&tx, user_id, section))
            .transpose()?;
        let thread_id = confirmed_section
            .map(|section| section.thread_id)
            .or(coverage_thread_id)
            .or(message_thread_id);
        let coverage = thread_id
            .map(|thread_id| {
                update_message_coverage(&tx, user_id, thread_id, known_newest_seq, merged)
            })
            .transpose()?
            .flatten();
        tx.commit()
            .map_err(|e| format!("commit message write: {e}"))?;
        Ok(coverage)
    })
    .await
    .map_err(|e| format!("join message write: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_get_deleted_hwm(
    app: tauri::AppHandle,
    user_id: i64,
    thread_id: i64,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        let key = format!("deletedHwm:{thread_id}");
        let value = conn
            .query_row(
                "SELECT value_json FROM sync_state WHERE user_id=?1 AND key=?2",
                params![user_id, key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("get deleted hwm: {e}"))?;
        match value {
            Some(value) => serde_json::from_str::<String>(&value)
                .map_err(|e| format!("parse deleted hwm: {e}")),
            None => Ok("0".to_string()),
        }
    })
    .await
    .map_err(|e| format!("join deleted hwm read: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_apply_deleted_messages(
    app: tauri::AppHandle,
    user_id: i64,
    thread_id: i64,
    items: Vec<Value>,
    hwm: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open(&app)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("begin deleted-message write: {e}"))?;
        for item in items {
            let seq = item
                .get("seq")
                .and_then(Value::as_i64)
                .ok_or_else(|| "deleted message has no numeric seq".to_string())?;
            let placeholder = serde_json::json!({
                "threadId": thread_id,
                "seq": seq,
                "isDeleted": true,
                "content": "",
                "contentType": "PURE_TEXT",
                "creator": 0,
                "createdAt": 0,
                "updatedAt": 0
            });
            tx.execute(
                "INSERT INTO messages(user_id,thread_id,seq,created_at,payload_json)
                 VALUES(?1,?2,?3,0,?4)
                 ON CONFLICT(user_id,thread_id,seq) DO UPDATE SET
                   payload_json=json_set(messages.payload_json,'$.isDeleted',json('true'))",
                params![user_id, thread_id, seq, json_text(&placeholder)?],
            )
            .map_err(|e| format!("apply deleted message: {e}"))?;
        }
        tx.execute(
            "INSERT INTO sync_state(user_id,key,value_json) VALUES(?1,?2,?3)
             ON CONFLICT(user_id,key) DO UPDATE SET value_json=excluded.value_json",
            params![
                user_id,
                format!("deletedHwm:{thread_id}"),
                serde_json::to_string(&hwm).map_err(|e| format!("encode deleted hwm: {e}"))?
            ],
        )
        .map_err(|e| format!("advance deleted hwm: {e}"))?;
        tx.commit()
            .map_err(|e| format!("commit deleted-message write: {e}"))
    })
    .await
    .map_err(|e| format!("join deleted-message write: {e}"))?
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageSection {
    thread_id: i64,
    left: i64,
    right: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageCoverageState {
    thread_id: i64,
    known_newest_seq: i64,
    #[serde(default)]
    covered_tail: Option<CoveredInterval>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoveredInterval {
    left: i64,
    right: i64,
}

fn merge_message_section(
    tx: &rusqlite::Transaction<'_>,
    user_id: i64,
    section: MessageSection,
) -> Result<MessageSection, String> {
    let mut left = section.left.min(section.right);
    let mut right = section.left.max(section.right);
    let covered_tail = tx
        .query_row(
            "SELECT value_json FROM sync_state WHERE user_id=?1 AND key=?2",
            params![user_id, message_coverage_key(section.thread_id)],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("get message coverage for section merge: {e}"))?
        .map(|json| serde_json::from_str::<MessageCoverageState>(&json))
        .transpose()
        .map_err(|e| format!("parse message coverage for section merge: {e}"))?
        .and_then(|state| state.covered_tail);
    if let Some(tail) = covered_tail {
        if left >= tail.left && right <= tail.right {
            return Ok(MessageSection {
                thread_id: section.thread_id,
                left: tail.left,
                right: tail.right,
            });
        }
        if left > tail.right {
            if left == tail.right.saturating_add(1) {
                left = tail.left;
            }
            // coveredTail is the right-most persisted section. A disjoint range to its right cannot
            // meet another old section, while an adjacent range joins it directly.
        } else if right >= tail.left.saturating_sub(1) {
            // The incoming range reaches the tail from its left or starts inside it. Its right edge
            // is known without a lookup; only an incoming left edge outside the tail can connect
            // farther left.
            if left < tail.left {
                left = resolve_merged_left(tx, user_id, section.thread_id, left)?;
            } else {
                left = tail.left;
            }
            right = right.max(tail.right);
        } else {
            left = resolve_merged_left(tx, user_id, section.thread_id, left)?;
            right = resolve_merged_right(tx, user_id, section.thread_id, right)?;
        }
    } else {
        left = resolve_merged_left(tx, user_id, section.thread_id, left)?;
        right = resolve_merged_right(tx, user_id, section.thread_id, right)?;
    }
    tx.execute(
        "UPDATE messages SET section_left=NULL, section_right=NULL
         WHERE user_id=?1 AND thread_id=?2 AND seq BETWEEN ?3 AND ?4
           AND (section_left=1 OR section_right=1)",
        params![user_id, section.thread_id, left, right],
    )
    .map_err(|e| format!("clear merged message edges: {e}"))?;
    let left_updated = tx
        .execute(
            "UPDATE messages SET section_left=1
         WHERE user_id=?1 AND thread_id=?2 AND seq=?3",
            params![user_id, section.thread_id, left],
        )
        .map_err(|e| format!("set message left edge: {e}"))?;
    if left_updated != 1 {
        return Err("set message left edge affected no row".to_string());
    }
    let right_updated = tx
        .execute(
            "UPDATE messages SET section_right=1
         WHERE user_id=?1 AND thread_id=?2 AND seq=?3",
            params![user_id, section.thread_id, right],
        )
        .map_err(|e| format!("set message right edge: {e}"))?;
    if right_updated != 1 {
        return Err("set message right edge affected no row".to_string());
    }
    Ok(MessageSection {
        thread_id: section.thread_id,
        left,
        right,
    })
}

#[derive(Clone, Copy)]
struct MessageEdge {
    seq: i64,
    is_left: bool,
    is_right: bool,
}

fn nearest_message_edge(
    tx: &rusqlite::Transaction<'_>,
    user_id: i64,
    thread_id: i64,
    seq: i64,
    before: bool,
) -> Result<Option<MessageEdge>, String> {
    let comparison = if before { "<=" } else { ">=" };
    let ordering = if before { "DESC" } else { "ASC" };
    let nearest = |column: &str| -> Result<Option<i64>, String> {
        tx.query_row(
            &format!(
                "SELECT seq FROM messages
                 WHERE user_id=?1 AND thread_id=?2 AND {column}=1 AND seq {comparison} ?3
                 ORDER BY seq {ordering} LIMIT 1"
            ),
            params![user_id, thread_id, seq],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("find nearest message {column} edge: {e}"))
    };
    let left = nearest("section_left")?;
    let right = nearest("section_right")?;
    let edge = match (left, right) {
        (None, None) => None,
        (Some(seq), None) => Some(MessageEdge {
            seq,
            is_left: true,
            is_right: false,
        }),
        (None, Some(seq)) => Some(MessageEdge {
            seq,
            is_left: false,
            is_right: true,
        }),
        (Some(left), Some(right)) if left == right => Some(MessageEdge {
            seq: left,
            is_left: true,
            is_right: true,
        }),
        (Some(left), Some(right)) => {
            let pick_left = if before { left > right } else { left < right };
            Some(MessageEdge {
                seq: if pick_left { left } else { right },
                is_left: pick_left,
                is_right: !pick_left,
            })
        }
    };
    Ok(edge)
}

fn resolve_merged_left(
    tx: &rusqlite::Transaction<'_>,
    user_id: i64,
    thread_id: i64,
    seq: i64,
) -> Result<i64, String> {
    let Some(edge) = nearest_message_edge(tx, user_id, thread_id, seq, true)? else {
        return Ok(seq);
    };
    if edge.is_left && !edge.is_right {
        return Ok(edge.seq);
    }
    if edge.seq < seq.saturating_sub(1) || !edge.is_right {
        return Ok(seq);
    }
    let paired_left = tx
        .query_row(
            "SELECT seq FROM messages
             WHERE user_id=?1 AND thread_id=?2 AND section_left=1 AND seq<=?3
             ORDER BY seq DESC LIMIT 1",
            params![user_id, thread_id, edge.seq],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| format!("find paired message left edge: {e}"))?
        .ok_or_else(|| "message section right edge has no left".to_string())?;
    let matching_right = tx
        .query_row(
            "SELECT seq FROM messages
             WHERE user_id=?1 AND thread_id=?2 AND section_right=1 AND seq>=?3
             ORDER BY seq ASC LIMIT 1",
            params![user_id, thread_id, paired_left],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| format!("validate paired message right edge: {e}"))?;
    if matching_right != Some(edge.seq) {
        return Err("message section edges are not paired".to_string());
    }
    Ok(paired_left)
}

fn resolve_merged_right(
    tx: &rusqlite::Transaction<'_>,
    user_id: i64,
    thread_id: i64,
    seq: i64,
) -> Result<i64, String> {
    let Some(edge) = nearest_message_edge(tx, user_id, thread_id, seq, false)? else {
        return Ok(seq);
    };
    if edge.is_right {
        return Ok(edge.seq);
    }
    if edge.seq > seq.saturating_add(1) || !edge.is_left {
        return Ok(seq);
    }
    let paired_right = tx
        .query_row(
            "SELECT seq FROM messages
             WHERE user_id=?1 AND thread_id=?2 AND section_right=1 AND seq>=?3
             ORDER BY seq ASC LIMIT 1",
            params![user_id, thread_id, edge.seq],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| format!("find paired message right edge: {e}"))?
        .ok_or_else(|| "message section left edge has no right".to_string())?;
    let matching_left = tx
        .query_row(
            "SELECT seq FROM messages
             WHERE user_id=?1 AND thread_id=?2 AND section_left=1 AND seq<=?3
             ORDER BY seq DESC LIMIT 1",
            params![user_id, thread_id, paired_right],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| format!("validate paired message left edge: {e}"))?;
    if matching_left != Some(edge.seq) {
        return Err("message section edges are not paired".to_string());
    }
    Ok(paired_right)
}

fn message_coverage_key(thread_id: i64) -> String {
    format!("messageCoverage:{thread_id}")
}

fn update_message_coverage(
    tx: &rusqlite::Transaction<'_>,
    user_id: i64,
    thread_id: i64,
    known_newest_seq: Option<i64>,
    merged: Option<MessageSection>,
) -> Result<Option<MessageCoverageState>, String> {
    let key = message_coverage_key(thread_id);
    let old = tx
        .query_row(
            "SELECT value_json FROM sync_state WHERE user_id=?1 AND key=?2",
            params![user_id, key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("get message coverage: {e}"))?
        .map(|json| serde_json::from_str::<MessageCoverageState>(&json))
        .transpose()
        .map_err(|e| format!("parse message coverage: {e}"))?;
    let known_newest_seq = known_newest_seq
        .into_iter()
        .chain(old.map(|s| s.known_newest_seq))
        .chain(merged.map(|s| s.right))
        .max();
    let Some(known_newest_seq) = known_newest_seq else {
        return Ok(None);
    };
    let incoming = merged.map(|section| CoveredInterval {
        left: section.left,
        right: section.right,
    });
    let state = MessageCoverageState {
        thread_id,
        known_newest_seq,
        covered_tail: merge_covered_tail(old.and_then(|s| s.covered_tail), incoming),
    };
    tx.execute(
        "INSERT INTO sync_state(user_id,key,value_json) VALUES(?1,?2,?3)
         ON CONFLICT(user_id,key) DO UPDATE SET value_json=excluded.value_json",
        params![
            user_id,
            key,
            serde_json::to_string(&state)
                .map_err(|e| format!("serialize message coverage: {e}"))?
        ],
    )
    .map_err(|e| format!("put message coverage: {e}"))?;
    Ok(Some(state))
}

fn merge_covered_tail(
    current: Option<CoveredInterval>,
    incoming: Option<CoveredInterval>,
) -> Option<CoveredInterval> {
    let Some(incoming) = incoming else {
        return current;
    };
    let next = CoveredInterval {
        left: incoming.left.min(incoming.right),
        right: incoming.left.max(incoming.right),
    };
    let Some(current) = current else {
        return Some(next);
    };
    let tail = CoveredInterval {
        left: current.left.min(current.right),
        right: current.left.max(current.right),
    };
    if next.right < tail.left.saturating_sub(1) {
        return Some(tail);
    }
    if next.left > tail.right.saturating_add(1) {
        return Some(next);
    }
    Some(CoveredInterval {
        left: tail.left.min(next.left),
        right: tail.right.max(next.right),
    })
}

#[tauri::command]
pub(crate) async fn native_db_message_coverage(
    app: tauri::AppHandle,
    user_id: i64,
    thread_id: i64,
) -> Result<Option<MessageCoverageState>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let value = open(&app)?
            .query_row(
                "SELECT value_json FROM sync_state WHERE user_id=?1 AND key=?2",
                params![user_id, message_coverage_key(thread_id)],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("get message coverage: {e}"))?;
        value
            .map(|json| {
                serde_json::from_str(&json).map_err(|e| format!("parse message coverage: {e}"))
            })
            .transpose()
    })
    .await
    .map_err(|e| format!("join message coverage read: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_message_section(
    app: tauri::AppHandle,
    user_id: i64,
    thread_id: i64,
    seq: i64,
) -> Result<Option<MessageSection>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        let left = conn
            .query_row(
                "SELECT seq FROM messages WHERE user_id=?1 AND thread_id=?2
                 AND section_left=1 AND seq<=?3 ORDER BY seq DESC LIMIT 1",
                params![user_id, thread_id, seq],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|e| format!("find message left edge: {e}"))?;
        let Some(left) = left else { return Ok(None) };
        let right = conn
            .query_row(
                "SELECT seq FROM messages WHERE user_id=?1 AND thread_id=?2
                 AND section_right=1 AND seq>=?3 ORDER BY seq ASC LIMIT 1",
                params![user_id, thread_id, left],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| format!("find message right edge: {e}"))?;
        Ok((seq <= right).then_some(MessageSection {
            thread_id,
            left,
            right,
        }))
    })
    .await
    .map_err(|e| format!("join message-section read: {e}"))?
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
                 WHERE user_id = ?1 AND thread_id = ?2 AND seq = ?3
                   AND COALESCE(json_extract(payload_json, '$.isDeleted'), 0) != 1",
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
                   AND COALESCE(json_extract(payload_json, '$.isDeleted'), 0) != 1
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
        let mut conn = open(&app)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("begin delete thread messages: {e}"))?;
        tx.execute(
            "DELETE FROM messages WHERE user_id = ?1 AND thread_id = ?2",
            params![user_id, thread_id],
        )
        .map_err(|e| format!("delete thread messages: {e}"))?;
        tx.execute(
            "DELETE FROM sync_state WHERE user_id=?1 AND key=?2",
            params![user_id, message_coverage_key(thread_id)],
        )
        .map_err(|e| format!("delete message coverage: {e}"))?;
        tx.commit()
            .map_err(|e| format!("commit delete thread messages: {e}"))
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

#[cfg(test)]
#[path = "tests/native_db_tests.rs"]
mod tests;
