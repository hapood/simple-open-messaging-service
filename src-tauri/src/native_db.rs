use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub(crate) mod attention;
#[cfg(any(target_os = "android", test))]
pub(crate) mod call_peer;
pub(crate) mod client_state;
pub(crate) mod contacts;
#[cfg(desktop)]
pub(crate) mod desktop_notifications;
mod lifetime;
pub(crate) mod location;
pub(crate) mod messages;
#[cfg(any(target_os = "android", test))]
pub(crate) mod notifications;
pub(crate) mod preferences;
pub(crate) mod profile_avatars;
pub(crate) mod profile_namespaces;
mod relationship_projection;
mod request_store;
pub(crate) mod state_feed_sync;
mod thread_feed_commits;
mod thread_store;
pub(crate) use client_state::chrono_millis;
#[cfg(test)]
use messages::{
    history_gap_is_owned, reduce_message_ranges, validate_message_ranges, HistoryDirection,
    MessageInterval, MessageRange, MessageRangeState, ServerMessageRange,
};

const CACHE_SCHEMA_VERSION: i64 = 1;

pub(crate) fn invalidate_account_work() -> Result<(), String> {
    drop(lifetime::CACHE_LIFETIME.invalidate()?);
    Ok(())
}

pub(crate) fn capture_account_epoch() -> Result<u64, String> {
    lifetime::CACHE_LIFETIME.capture()
}

pub(crate) fn is_account_epoch_current(epoch: u64) -> bool {
    lifetime::CACHE_LIFETIME.is_current(epoch)
}

fn db_path() -> Result<PathBuf, String> {
    Ok(location::path()?.to_path_buf())
}

fn configure(conn: &Connection) -> Result<(), String> {
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("configure native db: {e}"))?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("configure native db: {e}"))
}

/// Device preferences must be available before authentication. This is the only ordinary open path
/// allowed to create the SQLite file, and it creates only the device-scoped preference table.
fn open_preferences() -> Result<Connection, String> {
    let conn = Connection::open(db_path()?).map_err(|e| format!("open preference db: {e}"))?;
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
/// Login-authority open path: the preferences file exists by the time any login transition runs
/// (first fresh login creates it here). Never opens or repairs the account cache schema.
pub(crate) fn open_preferences_for_authority() -> Result<Connection, String> {
    open_preferences()
}

/// Open an already-initialized account cache. Unlike `Connection::open`, this cannot create a missing
/// database file and never repairs missing tables during a read/write command.
fn open_cache() -> Result<Connection, String> {
    let mut conn = Connection::open_with_flags(
        db_path()?,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("open existing native cache: {e}"))?;
    configure(&conn)?;
    validate_cache_schema(&conn)?;
    // Message rows and coverage are rebuildable; drop the old contextual URLs once, then
    // refetch canonical content without touching account metadata or device preferences.
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| format!("read media content cache version: {e}"))?;
    if version == 0 {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("begin media content cache cleanup: {e}"))?;
        let current: i64 = tx
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|e| format!("recheck media content cache version: {e}"))?;
        if current == 0 {
            tx.execute_batch(
                "DELETE FROM messages;
                 DELETE FROM message_ranges;
                 DELETE FROM thread_sync_state;
                 PRAGMA user_version = 1;",
            )
            .map_err(|e| format!("clean contextual media cache: {e}"))?;
        }
        tx.commit()
            .map_err(|e| format!("commit media content cache cleanup: {e}"))?;
    }
    Ok(conn)
}

// Account-cache commands use the strict existing-schema path. Kept as a short local alias so every
// command below cannot accidentally regain rusqlite's create-on-open behavior.
fn open() -> Result<Connection, String> {
    open_cache()
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
        "profile_namespaces",
        "profile_namespace_tombs",
        "profile_tombs",
        "threads",
        "thread_previews",
        "profiles",
        "members",
        "relationship_requests",
        "sync_state",
        "thread_sync_state",
        "notification_global_state",
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
        "relationship_requests_direction_status",
        "profiles_address_revision",
        "members_thread",
        "members_search",
        "messages_user_thread_seq",
        "messages_by_origin",
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
        CREATE TABLE IF NOT EXISTS profile_namespaces (
          user_id INTEGER NOT NULL,
          publisher_namespace_id INTEGER NOT NULL,
          profile_namespace_id INTEGER NOT NULL,
          domain TEXT,
          root_public_key TEXT,
          update_feed_id INTEGER NOT NULL,
          change_seq INTEGER NOT NULL,
          expired INTEGER NOT NULL CHECK(expired IN (0, 1)),
          status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'ARCHIVED')),
          refreshed_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, publisher_namespace_id, profile_namespace_id)
        );
        CREATE TABLE IF NOT EXISTS profile_namespace_tombs (
          user_id INTEGER NOT NULL,
          publisher_namespace_id INTEGER NOT NULL,
          profile_namespace_id INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, publisher_namespace_id, profile_namespace_id)
        );
        CREATE TABLE IF NOT EXISTS profile_tombs (
          user_id INTEGER NOT NULL,
          publisher_namespace_id INTEGER NOT NULL,
          profile_namespace_id INTEGER NOT NULL,
          account TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, publisher_namespace_id, profile_namespace_id, account)
        );
        CREATE TABLE IF NOT EXISTS profiles (
          user_id INTEGER NOT NULL,
          publisher_namespace_id INTEGER NOT NULL,
          profile_namespace_id INTEGER NOT NULL,
          account TEXT NOT NULL,
          profile_rev INTEGER NOT NULL CHECK(profile_rev > 0),
          name TEXT NOT NULL,
          avatar_digest TEXT,
          bio TEXT NOT NULL,
          PRIMARY KEY (user_id, publisher_namespace_id, profile_namespace_id, account, profile_rev)
        );
        CREATE INDEX IF NOT EXISTS profiles_address_revision
          ON profiles(user_id, publisher_namespace_id, profile_namespace_id, account, profile_rev);
        CREATE TABLE IF NOT EXISTS members (
          user_id INTEGER NOT NULL,
          thread_id INTEGER NOT NULL,
          member_account TEXT NOT NULL,
          namespace_id INTEGER NOT NULL,
          role TEXT NOT NULL,
          left_state INTEGER NOT NULL DEFAULT 0,
          profile_rev INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (user_id, thread_id, member_account, namespace_id)
        );
        CREATE INDEX IF NOT EXISTS members_thread
          ON members(user_id, thread_id, left_state, namespace_id, member_account);
        CREATE INDEX IF NOT EXISTS members_search
          ON members(user_id, thread_id, member_account, namespace_id);
        CREATE TABLE IF NOT EXISTS relationship_requests (
          user_id INTEGER NOT NULL,
          stable_key TEXT NOT NULL,
          namespace_id INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('FRIEND', 'GROUP')),
          bucket TEXT NOT NULL CHECK(bucket IN ('RECEIVED', 'SENT')),
          direction TEXT NOT NULL CHECK(direction IN ('INCOMING', 'OUTGOING')),
          status TEXT NOT NULL CHECK(status IN ('REQUESTED', 'ACCEPTED', 'WITHDRAWN', 'REJECTED', 'EXPIRED')),
          expires_at INTEGER NOT NULL,
          local_thread_id INTEGER,
          note TEXT NOT NULL,
          requested_at INTEGER NOT NULL,
          requested_sort INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          source_label TEXT,
          subject_id INTEGER,
          subject_account TEXT,
          subject_namespace_id INTEGER,
          subject_avatar TEXT,
          subject_bio TEXT,
          subject_profile_rev INTEGER,
          snapshot_json TEXT CHECK(snapshot_json IS NULL OR json_valid(snapshot_json)),
          PRIMARY KEY (user_id, stable_key)
        );
        CREATE INDEX IF NOT EXISTS relationship_requests_direction_status
          ON relationship_requests(
            user_id, direction, status, requested_sort DESC, stable_key DESC
          );
        CREATE TABLE IF NOT EXISTS sync_state (
          user_id INTEGER NOT NULL,
          key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          PRIMARY KEY (user_id, key)
        );
        CREATE TABLE IF NOT EXISTS thread_sync_state (
          user_id INTEGER NOT NULL,
          thread_id INTEGER NOT NULL,
          message_head INTEGER,
          deleted_hwm INTEGER,
          PRIMARY KEY (user_id, thread_id),
          CHECK (message_head IS NULL OR message_head >= 0),
          CHECK (deleted_hwm IS NULL OR deleted_hwm >= 0)
        );
        CREATE TABLE IF NOT EXISTS notification_global_state (
          account_id INTEGER PRIMARY KEY,
          cursor_thread_id INTEGER,
          cursor_seq INTEGER,
          updated_at INTEGER NOT NULL
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
        CREATE INDEX IF NOT EXISTS messages_by_origin
          ON messages(user_id, thread_id,
            json_extract(payload_json, '$.publisherNamespaceId'),
            json_extract(payload_json, '$.originSeq'));
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
    conn.execute_batch(thread_store::SCHEMA)
        .map_err(|e| format!("initialize typed thread cache: {e}"))?;
    conn.execute_batch(thread_store::PREVIEW_SCHEMA)
        .map_err(|e| format!("initialize typed thread previews: {e}"))?;
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
        "DROP TABLE IF EXISTS thread_previews;
         DROP TABLE IF EXISTS thread_states;
         DROP TABLE IF EXISTS attention_states;
         DROP TABLE IF EXISTS threads;
         DROP TABLE IF EXISTS profiles;
         DROP TABLE IF EXISTS profile_tombs;
         DROP TABLE IF EXISTS profile_namespace_tombs;
         DROP TABLE IF EXISTS profile_namespaces;
         DROP TABLE IF EXISTS thread_participants;
         DROP TABLE IF EXISTS users;
         DROP TABLE IF EXISTS groups;
         DROP TABLE IF EXISTS members;
         DROP TABLE IF EXISTS friend_intents;
         DROP TABLE IF EXISTS friend_requests;
         DROP TABLE IF EXISTS relationship_requests;
         DROP TABLE IF EXISTS relationship_intents;
         DROP TABLE IF EXISTS sync_state;
         DROP TABLE IF EXISTS thread_sync_state;
         DROP TABLE IF EXISTS notification_global_state;
         DROP TABLE IF EXISTS notification_feed_state;
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
/// Fresh-login preparation, run BEFORE the authentication request. Releases admitted cache work,
/// resets the shared cache schema, performs the deferred deletion of retired login caches recorded by
/// previous logouts, and mints the new login UUID. Credentials are not involved; `prepare` still
/// refuses while any retired cache remains undeletable, so a failed cleanup blocks authentication.
#[tauri::command]
pub(crate) async fn native_db_begin_login() -> Result<String, String> {
    let id = tauri::async_runtime::spawn_blocking(move || {
        // Hold the lifetime write guard until the schema reset and journal transitions finish.
        let _lifetime = lifetime::CACHE_LIFETIME.invalidate()?;
        let mut conn = open_preferences()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Exclusive)
            .map_err(|e| format!("begin native fresh-login preparation: {e}"))?;
        drop_cache_schema(&tx)?;
        create_cache_schema(&tx)?;
        tx.commit()
            .map_err(|e| format!("commit native fresh-login preparation: {e}"))?;
        crate::login_session_store::SessionStore::end_current(&mut conn)?;
        let retired: Vec<_> = crate::login_session_store::SessionStore::read(&conn)?
            .map(|journal| journal.pending_cleanup().to_vec())
            .unwrap_or_default();
        if let Some(directory) = db_path()?.parent().map(Path::to_path_buf) {
            for id in retired {
                crate::login_session_store::SessionStore::delete_retired_cache(
                    &mut conn,
                    &directory,
                    &id,
                )?;
            }
        }
        crate::login_session_store::SessionStore::finish_ending(&mut conn, None)?;
        crate::login_session_store::SessionStore::acknowledge_legacy_cleanup(&mut conn)?;
        profile_avatars::clear()?;
        crate::login_session_store::SessionStore::prepare(&mut conn).map(String::from)
    })
    .await
    .map_err(|e| format!("join native fresh-login preparation: {e}"))??;
    crate::realtime::runtime().refresh_account_epoch();
    Ok(id)
}

#[tauri::command]
pub(crate) async fn native_db_recreate_cache() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lifetime = lifetime::CACHE_LIFETIME.invalidate()?;
        let mut conn = open_preferences()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Exclusive)
            .map_err(|e| format!("begin native cache recreation: {e}"))?;
        drop_cache_schema(&tx)?;
        create_cache_schema(&tx)?;
        tx.commit()
            .map_err(|e| format!("commit native cache recreation: {e}"))?;
        profile_avatars::clear()
    })
    .await
    .map_err(|e| format!("join native cache initialization: {e}"))??;
    // The database lifetime lock has been released. Same-token restoration needs a fresh worker
    // generation; the OS service owner and its connectivity registration remain unchanged.
    crate::realtime::runtime().refresh_account_epoch();
    Ok(())
}

#[tauri::command]
pub(crate) async fn native_db_validate_cache() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_cache().map(drop))
        .await
        .map_err(|e| format!("join native cache validation: {e}"))?
}

/// Rebuild only chat messages and their derived coverage state. SQLite DDL runs in one exclusive
/// transaction, so existing statements finish first and new database writers cannot interleave.
#[tauri::command]
pub(crate) async fn native_db_recreate_messages() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lifetime = lifetime::CACHE_LIFETIME.invalidate()?;
        let mut conn = open_cache()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Exclusive)
            .map_err(|e| format!("begin message cache recreation: {e}"))?;
        tx.execute_batch(
            "DROP TABLE messages;
             DROP TABLE IF EXISTS message_ranges;
             DROP TABLE IF EXISTS thread_sync_state;
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
               ON message_ranges(user_id, thread_id, right_inclusive);
             CREATE TABLE thread_sync_state (
               user_id INTEGER NOT NULL,
               thread_id INTEGER NOT NULL,
               message_head INTEGER,
               deleted_hwm INTEGER,
               PRIMARY KEY (user_id, thread_id),
               CHECK (message_head IS NULL OR message_head >= 0),
               CHECK (deleted_hwm IS NULL OR deleted_hwm >= 0)
             );",
        )
        .map_err(|e| format!("recreate message cache: {e}"))?;
        tx.commit()
            .map_err(|e| format!("commit message cache recreation: {e}"))
    })
    .await
    .map_err(|e| format!("join message cache recreation: {e}"))??;
    crate::realtime::runtime().refresh_account_epoch();
    Ok(())
}

#[tauri::command]
pub(crate) async fn native_db_count_messages(user_id: i64) -> Result<i64, String> {
    lifetime::spawn(move || {
        open_cache()?
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
pub(crate) async fn native_db_get_meta(user_id: i64, key: String) -> Result<Option<Value>, String> {
    lifetime::spawn(move || {
        let value = open()?
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
    user_id: i64,
    key: String,
    value: Value,
) -> Result<(), String> {
    lifetime::spawn(move || {
        open()?
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
pub(crate) async fn native_db_clear_user(user_id: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lifetime = lifetime::CACHE_LIFETIME.invalidate()?;
        let mut conn = open()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("begin user clear: {e}"))?;
        for table in [
            "thread_previews",
            "threads",
            "profile_tombs",
            "profile_namespace_tombs",
            "profile_namespaces",
            "profiles",
            "members",
            "relationship_requests",
            "sync_state",
            "thread_sync_state",
            "messages",
            "message_ranges",
        ] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE user_id = ?1"),
                [user_id],
            )
            .map_err(|e| format!("clear {table}: {e}"))?;
        }
        tx.commit().map_err(|e| format!("commit user clear: {e}"))?;
        profile_avatars::clear_user(user_id)
    })
    .await
    .map_err(|e| format!("join user clear: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_clear_all() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lifetime = lifetime::CACHE_LIFETIME.invalidate()?;
        let path = db_path()?;
        if path.exists() {
            let conn = open()?;
            conn.execute_batch(
                "DELETE FROM thread_previews;
                 DELETE FROM threads;
                 DELETE FROM profiles;
                 DELETE FROM members;
                 DELETE FROM relationship_requests;
                 DELETE FROM sync_state;
                 DELETE FROM thread_sync_state;
                 DELETE FROM messages;
                 DELETE FROM message_ranges;
                 VACUUM;",
            )
            .map_err(|e| format!("clear native db: {e}"))?;
        }
        profile_avatars::clear()
    })
    .await
    .map_err(|e| format!("join native db clear: {e}"))?
}

#[cfg(test)]
#[path = "tests/native_db_tests.rs"]
mod tests;
