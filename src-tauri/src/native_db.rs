use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use std::path::PathBuf;
use tauri::Manager;

pub(crate) mod avatars;
pub(crate) mod client_state;
pub(crate) mod contacts;
pub(crate) mod messages;
pub(crate) mod preferences;
mod relationship_projection;
pub(crate) use client_state::chrono_millis;
#[cfg(test)]
use messages::{
    decode_deleted_hwm, history_gap_is_owned, reduce_message_ranges, validate_message_ranges,
    HistoryDirection, MessageInterval, MessageRange, MessageRangeState, ServerMessageRange,
};

const DB_FILENAME: &str = "soms-local.sqlite3";
const CACHE_SCHEMA_VERSION: i64 = 17;

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
        "namespaces",
        "threads",
        "profiles",
        "members",
        "relationship_requests",
        "relationship_intents",
        "sync_state",
        "notification_global_state",
        "notification_thread_state",
        "avatars",
        "messages",
        "message_ranges",
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
        "namespaces_domain_status",
        "relationship_requests_direction_status",
        "profiles_address_revision",
        "members_thread",
        "members_search",
        "messages_user_thread_seq",
        "message_ranges_by_right",
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
        CREATE TABLE IF NOT EXISTS namespaces (
          user_id INTEGER NOT NULL,
          namespace_id INTEGER NOT NULL,
          domain TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'ARCHIVED')),
          PRIMARY KEY (user_id, namespace_id),
          UNIQUE (user_id, domain, namespace_id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS namespaces_domain_status
          ON namespaces(user_id, domain) WHERE status='ACTIVE';
        CREATE TABLE IF NOT EXISTS threads (
          user_id INTEGER NOT NULL,
          thread_id INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          authority_namespace_id INTEGER GENERATED ALWAYS AS
            (CAST(json_extract(payload_json, '$.authorityNamespaceId') AS INTEGER)) STORED NOT NULL,
          authority_domain TEXT GENERATED ALWAYS AS
            (CASE json_extract(payload_json, '$.type')
              WHEN 'P2P' THEN json_extract(payload_json, '$.peerUser.domain')
              ELSE json_extract(payload_json, '$.group.domain') END) STORED NOT NULL,
          PRIMARY KEY (user_id, thread_id),
          FOREIGN KEY (user_id, authority_domain, authority_namespace_id)
            REFERENCES namespaces(user_id, domain, namespace_id)
        );
        CREATE TABLE IF NOT EXISTS profiles (
          user_id INTEGER NOT NULL,
          account TEXT NOT NULL,
          domain TEXT NOT NULL,
          namespace_id INTEGER NOT NULL,
          profile_rev INTEGER NOT NULL CHECK(profile_rev > 0),
          payload_json TEXT NOT NULL,
          PRIMARY KEY (user_id, account, domain, namespace_id, profile_rev),
          FOREIGN KEY (user_id, namespace_id) REFERENCES namespaces(user_id, namespace_id)
        );
        CREATE INDEX IF NOT EXISTS profiles_address_revision
          ON profiles(user_id, account, domain, namespace_id, profile_rev);
        CREATE TABLE IF NOT EXISTS members (
          user_id INTEGER NOT NULL,
          thread_id INTEGER NOT NULL,
          member_account TEXT NOT NULL,
          member_domain TEXT NOT NULL,
          namespace_id INTEGER NOT NULL,
          role TEXT NOT NULL,
          left_state INTEGER NOT NULL DEFAULT 0,
          profile_rev INTEGER NOT NULL DEFAULT 0,
          profile_message_seq INTEGER,
          PRIMARY KEY (user_id, thread_id, member_account, member_domain, namespace_id),
          FOREIGN KEY (user_id, namespace_id)
            REFERENCES namespaces(user_id, namespace_id)
        );
        CREATE INDEX IF NOT EXISTS members_thread
          ON members(user_id, thread_id, left_state, namespace_id, member_domain, member_account);
        CREATE INDEX IF NOT EXISTS members_search
          ON members(user_id, thread_id, member_account, member_domain, namespace_id);
        CREATE TRIGGER IF NOT EXISTS threads_namespace_before_insert
        BEFORE INSERT ON threads BEGIN
          UPDATE namespaces SET status='ARCHIVED'
          WHERE user_id=NEW.user_id
            AND domain=CASE json_extract(NEW.payload_json, '$.type')
              WHEN 'P2P' THEN json_extract(NEW.payload_json, '$.peerUser.domain')
              ELSE json_extract(NEW.payload_json, '$.group.domain') END
            AND namespace_id<CAST(json_extract(NEW.payload_json, '$.authorityNamespaceId') AS INTEGER);
          INSERT OR IGNORE INTO namespaces(user_id,namespace_id,domain,status)
          VALUES(
            NEW.user_id,
            CAST(json_extract(NEW.payload_json, '$.authorityNamespaceId') AS INTEGER),
            CASE json_extract(NEW.payload_json, '$.type')
              WHEN 'P2P' THEN json_extract(NEW.payload_json, '$.peerUser.domain')
              ELSE json_extract(NEW.payload_json, '$.group.domain') END,
            CASE
              WHEN CAST(json_extract(NEW.payload_json, '$.authorityNamespaceId') AS INTEGER)=0
                OR NOT EXISTS(
                  SELECT 1 FROM namespaces
                  WHERE user_id=NEW.user_id
                    AND domain=CASE json_extract(NEW.payload_json, '$.type')
                      WHEN 'P2P' THEN json_extract(NEW.payload_json, '$.peerUser.domain')
                      ELSE json_extract(NEW.payload_json, '$.group.domain') END
                    AND namespace_id>CAST(json_extract(NEW.payload_json, '$.authorityNamespaceId') AS INTEGER)
                )
              THEN 'ACTIVE' ELSE 'ARCHIVED' END
          );
        END;
        CREATE TABLE IF NOT EXISTS relationship_requests (
          user_id INTEGER NOT NULL,
          stable_key TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (user_id, stable_key)
        );
        CREATE TABLE IF NOT EXISTS relationship_intents (
          user_id INTEGER NOT NULL,
          stable_key TEXT NOT NULL,
          reverse_key TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (user_id, stable_key)
        );
        CREATE INDEX IF NOT EXISTS relationship_requests_direction_status
          ON relationship_requests(
            user_id,
            json_extract(payload_json, '$.direction'),
            json_extract(payload_json, '$.status'),
            CAST(json_extract(payload_json, '$.requestedSort') AS INTEGER) DESC,
            stable_key DESC
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
          PRIMARY KEY (user_id, thread_id, seq)
        );
        CREATE INDEX IF NOT EXISTS messages_user_thread_seq
          ON messages(user_id, thread_id, seq);
        CREATE TABLE IF NOT EXISTS message_ranges (
          user_id INTEGER NOT NULL,
          thread_id INTEGER NOT NULL,
          left_exclusive INTEGER NOT NULL,
          right_inclusive INTEGER NOT NULL,
          state TEXT NOT NULL CHECK(state IN (
            'LOCAL_COVERED', 'SERVER_PENDING', 'SERVER_UNAVAILABLE'
          )),
          PRIMARY KEY (user_id, thread_id, left_exclusive),
          CHECK(left_exclusive >= 0 AND right_inclusive > left_exclusive)
        );
        CREATE INDEX IF NOT EXISTS message_ranges_by_right
          ON message_ranges(user_id, thread_id, right_inclusive);
        ",
    )
    .map_err(|e| format!("initialize native cache: {e}"))?;
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
         DROP TABLE IF EXISTS thread_participants;
         DROP TABLE IF EXISTS users;
         DROP TABLE IF EXISTS groups;
         DROP TABLE IF EXISTS members;
         DROP TABLE IF EXISTS namespaces;
         DROP TABLE IF EXISTS friend_intents;
         DROP TABLE IF EXISTS friend_requests;
         DROP TABLE IF EXISTS relationship_requests;
         DROP TABLE IF EXISTS relationship_intents;
         DROP TABLE IF EXISTS sync_state;
         DROP TABLE IF EXISTS notification_global_state;
         DROP TABLE IF EXISTS notification_thread_state;
         DROP TABLE IF EXISTS avatars;
         DROP TABLE IF EXISTS messages;
         DROP TABLE IF EXISTS message_ranges;
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
             DROP TABLE IF EXISTS message_ranges;
             DELETE FROM sync_state WHERE key LIKE 'messageHead:%';
             CREATE TABLE messages (
               user_id INTEGER NOT NULL,
               thread_id INTEGER NOT NULL,
               seq INTEGER NOT NULL,
               created_at INTEGER NOT NULL,
               payload_json TEXT NOT NULL,
               PRIMARY KEY (user_id, thread_id, seq)
             );
             CREATE INDEX messages_user_thread_seq ON messages(user_id, thread_id, seq);
             CREATE TABLE message_ranges (
               user_id INTEGER NOT NULL,
               thread_id INTEGER NOT NULL,
               left_exclusive INTEGER NOT NULL,
               right_inclusive INTEGER NOT NULL,
               state TEXT NOT NULL CHECK(state IN (
                 'LOCAL_COVERED', 'SERVER_PENDING', 'SERVER_UNAVAILABLE'
               )),
               PRIMARY KEY (user_id, thread_id, left_exclusive),
               CHECK(left_exclusive >= 0 AND right_inclusive > left_exclusive)
             );
             CREATE INDEX message_ranges_by_right
               ON message_ranges(user_id, thread_id, right_inclusive);",
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

fn json_text(value: &Value) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| format!("encode native db value: {e}"))
}

fn parse_json(value: String) -> Result<Value, String> {
    serde_json::from_str(&value).map_err(|e| format!("decode native db value: {e}"))
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
pub(crate) async fn native_db_clear_user(
    app: tauri::AppHandle,
    user_id: i64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open(&app)?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("begin user clear: {e}"))?;
        for table in [
            "threads",
            "profiles",
            "members",
            "relationship_requests",
            "relationship_intents",
            "sync_state",
            "avatars",
            "messages",
            "message_ranges",
        ] {
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
                "DELETE FROM threads;
                 DELETE FROM profiles;
                 DELETE FROM members;
                 DELETE FROM relationship_requests;
                 DELETE FROM relationship_intents;
                 DELETE FROM sync_state;
                 DELETE FROM avatars;
                 DELETE FROM messages;
                 DELETE FROM message_ranges;
                 VACUUM;",
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
