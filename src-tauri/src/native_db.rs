use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use serde_json::Value;
use std::path::PathBuf;

use device_connection::DeviceConnection;

pub(crate) mod account_state;
pub(crate) mod attention;
#[cfg(any(target_os = "android", test))]
pub(crate) mod call_peer;
pub(crate) mod client_state;
pub(crate) mod contacts;
#[cfg(desktop)]
pub(crate) mod desktop_notifications;
mod device_connection;
mod lifetime;
pub(crate) mod location;
pub(crate) mod messages;
#[cfg(any(target_os = "android", test))]
pub(crate) mod notifications;
pub(crate) mod preferences;
pub(crate) mod profile_avatars;
pub(crate) mod profile_namespaces;
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

/// The active per-login cache file. Resolved from the durable login journal; never a fixed name.
fn cache_path() -> Result<PathBuf, String> {
    location::active_cache_path()
}

fn configure(conn: &Connection) -> Result<(), String> {
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("configure native db: {e}"))?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("configure native db: {e}"))
}

/// Explicit application initialization, shared by the shell and headless Android bootstrap.
/// Capturing or using device preferences later never creates a connection.
pub(crate) fn initialize_preferences() -> Result<(), String> {
    device_connection::DEVICE_CONNECTION.initialize(&db_path()?)
}

pub(crate) fn preferences_connection() -> Result<&'static DeviceConnection, String> {
    device_connection::DEVICE_CONNECTION.capture()
}

/// Open an already-initialized account cache. Unlike `Connection::open`, this cannot create a missing
/// database file and never repairs missing tables during a read/write command.
fn open_cache() -> Result<Connection, String> {
    let mut conn = Connection::open_with_flags(
        cache_path()?,
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
            "SELECT CAST(value_json AS INTEGER) FROM cache_meta WHERE key='schemaVersion'",
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
        "account_state",
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
    let columns = conn
        .prepare("SELECT name FROM pragma_table_info('account_state')")
        .map_err(|e| format!("inspect account state layout: {e}"))?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("read account state layout: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("decode account state layout: {e}"))?;
    let expected = [
        "user_id",
        "schema_version",
        "self_profile_json",
        "self_identity_json",
        "composer_drafts_json",
        "thread_feed_cursor",
        "state_feed_id",
        "state_feed_full_through",
        "profile_namespace_change_end_id",
        "intent_request_end_id",
        "intent_request_read_id",
        "intent_request_optimistic_read_id",
    ];
    if columns.iter().map(String::as_str).collect::<Vec<_>>() != expected {
        return Err("incompatible account state layout".into());
    }
    for index in [
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
        CREATE TABLE IF NOT EXISTS account_state (
          user_id INTEGER PRIMARY KEY,
          schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
          self_profile_json TEXT CHECK(self_profile_json IS NULL OR
            (json_valid(self_profile_json) AND json_type(self_profile_json) = 'object')),
          self_identity_json TEXT CHECK(self_identity_json IS NULL OR
            (json_valid(self_identity_json) AND json_type(self_identity_json) = 'object')),
          composer_drafts_json TEXT NOT NULL DEFAULT '[]'
            CHECK(json_valid(composer_drafts_json) AND json_type(composer_drafts_json) = 'array'),
          thread_feed_cursor INTEGER CHECK(thread_feed_cursor >= 0),
          state_feed_id INTEGER CHECK(state_feed_id >= 0),
          state_feed_full_through INTEGER CHECK(state_feed_full_through >= 0),
          profile_namespace_change_end_id INTEGER CHECK(profile_namespace_change_end_id >= 0),
          intent_request_end_id INTEGER CHECK(intent_request_end_id >= 0),
          intent_request_read_id INTEGER CHECK(intent_request_read_id >= 0),
          intent_request_optimistic_read_id INTEGER CHECK(intent_request_optimistic_read_id >= 0),
          CHECK ((intent_request_end_id IS NULL) = (intent_request_read_id IS NULL)),
          CHECK (intent_request_read_id <= intent_request_end_id)
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
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS cache_meta (
           key TEXT NOT NULL PRIMARY KEY,
           value_json TEXT NOT NULL
         );",
    )
    .map_err(|e| format!("initialize cache metadata: {e}"))?;
    conn.execute(
        "INSERT INTO cache_meta(key,value_json) VALUES('schemaVersion',?1)
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
        params![CACHE_SCHEMA_VERSION.to_string()],
    )
    .map_err(|e| format!("set native cache schema version: {e}"))?;
    Ok(())
}

fn drop_cache_schema(conn: &Connection) -> Result<(), String> {
    // Exactly the tables the current schema creates (root schema + thread store + attention's
    // lazily created thread_states). No obsolete-generation table names: a per-login cache file
    // is always created by this schema generation.
    conn.execute_batch(
        "DROP TABLE IF EXISTS thread_previews;
         DROP TABLE IF EXISTS thread_states;
         DROP TABLE IF EXISTS threads;
         DROP TABLE IF EXISTS profiles;
         DROP TABLE IF EXISTS profile_tombs;
         DROP TABLE IF EXISTS profile_namespace_tombs;
         DROP TABLE IF EXISTS profile_namespaces;
         DROP TABLE IF EXISTS members;
         DROP TABLE IF EXISTS account_state;
         DROP TABLE IF EXISTS thread_sync_state;
         DROP TABLE IF EXISTS notification_global_state;
         DROP TABLE IF EXISTS messages;
         DROP TABLE IF EXISTS message_ranges;
         DROP TABLE IF EXISTS cache_meta;",
    )
    .map_err(|e| format!("drop native cache: {e}"))
}

/// Fresh-login preparation, run BEFORE the authentication request. Releases admitted cache work,
/// deletes the retired per-login cache files recorded by previous logouts, mints the new login
/// UUID, and creates its dedicated cache file. Credentials are not involved; `prepare` still
/// refuses while any retired cache remains undeletable, so a failed cleanup blocks authentication.
#[tauri::command]
pub(crate) async fn native_db_begin_login() -> Result<String, String> {
    let preferences = preferences_connection()?;
    let id = tauri::async_runtime::spawn_blocking(move || prepare_fresh_login(preferences))
        .await
        .map_err(|e| format!("join native fresh-login preparation: {e}"))??;
    crate::realtime::runtime().refresh_account_epoch();
    Ok(id)
}

fn prepare_fresh_login(preferences: &DeviceConnection) -> Result<String, String> {
    // Hold the lifetime write guard until the new cache file is active and the journal is settled.
    let _lifetime = lifetime::CACHE_LIFETIME.invalidate()?;
    preferences.with_database(|preferences| {
        // End any still-admitted login: its cache file becomes pending cleanup, deleted below.
        crate::login_session_store::SessionStore::end_current(preferences)?;
        let retired: Vec<_> = crate::login_session_store::SessionStore::read(preferences)?
            .map(|journal| journal.pending_cleanup().to_vec())
            .unwrap_or_default();
        let directory = location::directory()?;
        for id in &retired {
            crate::login_session_store::SessionStore::delete_retired_cache(
                preferences,
                &directory,
                id,
            )?;
        }
        crate::login_session_store::SessionStore::finish_ending(preferences, None)?;
        let id = crate::login_session_store::SessionStore::prepare(preferences)?;
        let cache = directory.join(id.sqlite_filename());
        let conn = Connection::open(&cache).map_err(|e| format!("create login cache file: {e}"))?;
        configure(&conn)?;
        create_cache_schema(&conn)?;
        location::activate_cache(cache);
        profile_avatars::clear()?;
        Ok(String::from(id))
    })
}

/// Repair the ACTIVE login's cache file (damaged/missing schema): same UUID, fresh tables.
#[tauri::command]
pub(crate) async fn native_db_recreate_cache() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lifetime = lifetime::CACHE_LIFETIME.invalidate()?;
        // Creating is intentional: a missing active file is repairable state for the SAME login.
        let mut conn = Connection::open(cache_path()?)
            .map_err(|e| format!("open login cache for repair: {e}"))?;
        configure(&conn)?;
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
            "account_state",
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
        let path = cache_path()?;
        if path.exists() {
            let conn = open()?;
            conn.execute_batch(
                "DELETE FROM thread_previews;
                 DELETE FROM threads;
                 DELETE FROM profiles;
                 DELETE FROM members;
                 DELETE FROM account_state;
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

/// The process-wide location static admits exactly one directory; every test that needs the real
/// filesystem (per-login cache files, avatar store) shares this single instance.
#[cfg(test)]
fn shared_test_location() -> &'static tempfile::TempDir {
    static DIRECTORY: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
    let directory = DIRECTORY.get_or_init(|| tempfile::tempdir().unwrap());
    location::initialize(directory.path()).unwrap();
    initialize_preferences().unwrap();
    directory
}

/// One sequential test owns the process-wide location statics: initialize() is OnceLock-guarded,
/// so the whole cache-file lifecycle runs inside a single test function.
#[cfg(test)]
mod login_cache_tests {
    use super::location;
    use super::*;
    use crate::login_session_store::{LoginSessionId, SessionStore};

    #[test]
    fn per_login_cache_files_follow_the_login_journal() {
        let temp = shared_test_location();
        location::reset_active_cache_for_tests();

        // Startup creates only the device connection, even without a login journal. A TEMP trigger
        // proves that ordinary IPC preference commands use this same physical connection.
        let startup = preferences_connection().unwrap();
        startup
            .with_database(|conn| {
                assert!(SessionStore::read(conn)?.is_none());
                conn.execute_batch(
                    "CREATE TEMP TABLE connection_events(key TEXT);
                 CREATE TEMP TRIGGER preference_connection_proof
                 AFTER INSERT ON main.client_preferences
                 BEGIN INSERT INTO connection_events VALUES(NEW.key); END;",
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        initialize_preferences().unwrap(); // Shell attachment must not reconnect after headless init.
        tauri::async_runtime::block_on(async {
            preferences::native_db_put_preference(
                "device".into(),
                "connection-proof".into(),
                Value::Bool(true),
            )
            .await
            .unwrap();
            assert_eq!(
                preferences::native_db_get_preference("device".into(), "connection-proof".into())
                    .await
                    .unwrap(),
                Some(Value::Bool(true))
            );
            preferences::native_db_delete_preference("device".into(), "connection-proof".into())
                .await
                .unwrap();
        });
        startup
            .with_database(|conn| {
                let events: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM connection_events WHERE key='connection-proof'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                assert_eq!(events, 1);
                conn.execute_batch(
                    "DROP TRIGGER preference_connection_proof; DROP TABLE connection_events;",
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();

        // Fresh login #1: a UUID-named cache file is created and activated.
        let first = LoginSessionId::try_from(
            prepare_fresh_login(preferences_connection().unwrap()).unwrap(),
        )
        .unwrap();
        let first_file = temp.path().join(first.sqlite_filename());
        assert!(first_file.exists());
        assert_eq!(location::active_cache_path().unwrap(), first_file);
        open().unwrap(); // cache commands validate the active file's schema.

        // Preferences live in the shared file and survive every cache transition.
        let preferences = preferences_connection().unwrap();
        preferences
            .with_database(|conn| {
                conn.execute(
                    "INSERT INTO client_preferences(scope,key,value_json,updated_at)
             VALUES('device','theme','\"dark\"',0)",
                    [],
                )
                .unwrap();
                SessionStore::activate(conn, &first, "secret-one").unwrap();

                // Logout: the journal records cleanup ownership, the cache file stays on disk.
                SessionStore::end(conn, Some(&first)).unwrap();
                SessionStore::finish_ending(conn, Some(&first)).unwrap();
                Ok(())
            })
            .unwrap();
        assert!(first_file.exists());
        location::reset_active_cache_for_tests();
        assert!(location::active_cache_path().is_err()); // signed out: no active cache

        // Fresh login #2: deletes the retired file, mints a new UUID and file.
        let second = LoginSessionId::try_from(
            prepare_fresh_login(preferences_connection().unwrap()).unwrap(),
        )
        .unwrap();
        assert_ne!(first, second);
        assert!(!first_file.exists());
        assert!(temp.path().join(second.sqlite_filename()).exists());
        open().unwrap();

        // Simulated restart: the active file is re-resolved from the durable journal alone.
        location::reset_active_cache_for_tests();
        assert_eq!(
            location::active_cache_path().unwrap(),
            temp.path().join(second.sqlite_filename())
        );

        preferences
            .with_database(|conn| {
                let theme: String = conn
            .query_row(
                "SELECT value_json FROM client_preferences WHERE scope='device' AND key='theme'",
                [],
                |row| row.get(0),
            )
            .unwrap();
                assert_eq!(theme, "\"dark\"");
                let raw: String = conn
                    .query_row(
                        "SELECT value_json FROM client_preferences
                 WHERE scope='device' AND key='soms.native-login-session.v1'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert!(!raw.contains("secret-one"));
                // The cache schema lives in the login's own file, not the shared preferences file.
                let cache_tables: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='messages'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(cache_tables, 0);
                Ok(())
            })
            .unwrap();
    }
}
