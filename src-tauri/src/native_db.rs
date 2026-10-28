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
#[cfg(any(target_os = "macos", test))]
mod desktop_badge;
#[cfg(desktop)]
pub(crate) mod desktop_notifications;
mod device_connection;
mod group_meta_store;
mod lifetime;
pub(crate) mod location;
mod login_connections;
mod lru;
#[cfg(any(target_os = "android", test))]
pub(crate) mod mentions;
pub(crate) mod messages;
pub(crate) mod namespace_feed;
pub(crate) mod namespace_subscriptions;
#[cfg(any(target_os = "android", test))]
pub(crate) mod notifications;
pub(crate) mod preferences;
pub(crate) mod profile_avatars;
pub(crate) mod profile_namespaces;
pub(crate) mod profile_subscriptions;
pub(crate) mod state_feed_sync;
mod thread_patch;
mod thread_store;
pub(crate) mod watch_ipc;
pub(crate) use client_state::chrono_millis;
#[cfg(test)]
use messages::{
    history_gap_is_owned, reduce_message_ranges, validate_message_ranges, HistoryDirection,
    MessageInterval, MessageRange, MessageRangeState, ServerMessageRange,
};

const CACHE_SCHEMA_VERSION: i64 = 1;

/// Whether one immutable login owner is still the admitted cache owner. Identity admission for
/// platform callbacks and notification batches; never opens or creates a connection.
#[cfg(any(target_os = "android", test))]
pub(crate) fn is_login_session_current(id: &crate::login_session_store::LoginSessionId) -> bool {
    login_connections::LOGIN_CONNECTIONS
        .current()
        .ok()
        .flatten()
        .is_some_and(|owner| owner.id() == id && owner.assert_active().is_ok())
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

/// Explicit application initialization, shared by the shell and headless Android bootstrap.
/// Capturing or using device preferences later never creates a connection.
pub(crate) fn initialize_preferences() -> Result<(), String> {
    device_connection::DEVICE_CONNECTION.initialize(&db_path()?)
}

pub(crate) fn preferences_connection() -> Result<&'static DeviceConnection, String> {
    device_connection::DEVICE_CONNECTION.capture()
}

/// Explicit process initialization only. Repeated shell attachment keeps the original physical
/// connection. Missing cache files are left for deliberate repair, never created by restoration.
pub(crate) fn initialize_login_cache() -> Result<(), String> {
    if login_connections::LOGIN_CONNECTIONS.current()?.is_some() {
        return Ok(());
    }
    let _replacement = lifetime::CACHE_LIFETIME.invalidate()?;
    if login_connections::LOGIN_CONNECTIONS.current()?.is_some() {
        return Ok(());
    }
    let id = preferences_connection()?.with_database(|conn| {
        Ok(crate::login_session_store::SessionStore::read(conn)?
            .and_then(|journal| journal.active_session().cloned()))
    })?;
    let Some(id) = id else { return Ok(()) };
    let path = location::directory()?.join(id.sqlite_filename());
    if !path
        .try_exists()
        .map_err(|e| format!("inspect login cache: {e}"))?
    {
        return Ok(());
    }
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("restore login cache connection: {e}"))?;
    configure(&conn)?;
    login_connections::LOGIN_CONNECTIONS.install(id, conn)?;
    Ok(())
}

/// Ordinary local commands capture this owner before scheduling; the closure receives only its
/// physical connection. Maintenance exclusion is separate from irreversible login cancellation.
fn spawn_login_database<T, F>(operation: F) -> tauri::async_runtime::JoinHandle<Result<T, String>>
where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
{
    spawn_owned_database(capture_database_work(), operation)
}

pub(crate) fn capture_database_work() -> Result<crate::login_connection::DatabaseWork, String> {
    login_connections::LOGIN_CONNECTIONS
        .capture()
        .and_then(|owner| owner.capture_database_work().map_err(|e| e.to_string()))
}

/// Filesystem and platform work retains admission without acquiring a SQLite connection or lock.
fn spawn_owned_work<T, F>(
    work: crate::login_connection::DatabaseWork,
    operation: F,
) -> tauri::async_runtime::JoinHandle<Result<T, String>>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        work.assert_current().map_err(|e| e.to_string())?;
        let result = operation();
        work.assert_current().map_err(|e| e.to_string())?;
        result
    })
}

/// Multi-await domain operations pass the owner captured at their original intent, never the slot.
fn spawn_owned_database<T, F>(
    work: Result<crate::login_connection::DatabaseWork, String>,
    operation: F,
) -> tauri::async_runtime::JoinHandle<Result<T, String>>
where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let work = work?;
        with_owned_database(&work, operation)
    })
}

pub(crate) fn with_owned_database<T>(
    work: &crate::login_connection::DatabaseWork,
    operation: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    lifetime::CACHE_LIFETIME
        .with_cache_access(|| work.with_database(operation).map_err(|e| e.to_string()))
}

/// Credential validation at explicit restoration, never at ordinary command admission.
#[cfg(any(target_os = "android", test))]
pub(crate) fn restore_login_credential(token: &str) -> Result<Option<String>, String> {
    let id = preferences_connection()?
        .with_database(|conn| crate::login_session_store::SessionStore::restore(conn, token))?;
    let Some(id) = id else { return Ok(None) };
    if let Some(owner) = login_connections::LOGIN_CONNECTIONS.current()? {
        if owner.id() != &id {
            return Err("native login superseded".into());
        }
        if owner.credential().ok().as_deref() != Some(token) {
            owner
                .begin_activation()
                .map_err(|e| e.to_string())?
                .commit(token.to_string())
                .map_err(|e| e.to_string())?;
        }
        owner.assert_active().map_err(|e| e.to_string())?;
    }
    Ok(Some(String::from(id)))
}

pub(crate) fn login_connection(
    id: &crate::login_session_store::LoginSessionId,
) -> Result<std::sync::Arc<crate::login_connection::LoginConnection>, String> {
    let owner = login_connections::LOGIN_CONNECTIONS
        .current()?
        .ok_or("no native login connection initialized")?;
    if owner.id() != id {
        return Err("native login superseded".into());
    }
    Ok(owner)
}

/// End admission before scheduling SQL drain. The captured owner survives asynchronous cleanup;
/// a late release cannot close or remove a successor's connection.
pub(crate) fn end_login_connection(
    id: &crate::login_session_store::LoginSessionId,
) -> Result<std::sync::Arc<crate::login_connection::LoginConnection>, String> {
    let owner = login_connection(id)?;
    owner.end().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    desktop_badge::reset();
    Ok(owner)
}

pub(crate) fn release_login_connection(
    owner: &std::sync::Arc<crate::login_connection::LoginConnection>,
) -> Result<(), String> {
    login_connections::LOGIN_CONNECTIONS.release(owner)
}

#[cfg(test)]
pub(crate) fn install_test_login_connection(
    id: crate::login_session_store::LoginSessionId,
    database: Connection,
) -> Result<std::sync::Arc<crate::login_connection::LoginConnection>, String> {
    login_connections::LOGIN_CONNECTIONS.install(id, database)
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
        "group_meta",
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
    conn.execute_batch(group_meta_store::SCHEMA)
        .map_err(|e| format!("initialize group meta cache: {e}"))?;
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
         DROP TABLE IF EXISTS group_meta;
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
/// While the journal still holds an unactivated preparation, the command is idempotent:
/// authentication retries and QR polling reuse that UUID, its file and its connection.
#[tauri::command]
pub(crate) async fn native_db_begin_login(
    state: tauri::State<'_, crate::ServerSessionState>,
) -> Result<String, String> {
    let guard = state
        .auth_lifecycle
        .enter(crate::auth_lifecycle::Phase::Login)?;
    let preferences = preferences_connection()?;
    let id = tauri::async_runtime::spawn_blocking(move || {
        // Never reuse an old server's UUID: a late authentication response may still carry it.
        preferences.with_database(|conn| {
            let preparing = crate::login_session_store::SessionStore::read(conn)?
                .and_then(|journal| journal.preparing_session().cloned());
            if preparing
                .as_ref()
                .is_some_and(|id| guard.is_superseded(&id.to_string()))
            {
                crate::login_session_store::SessionStore::end_current(conn)?;
            }
            Ok(())
        })?;
        let id = prepare_fresh_login(preferences)?;
        guard.register_login(&id)?;
        Ok::<_, String>(id)
    })
    .await
    .map_err(|e| format!("join native fresh-login preparation: {e}"))??;
    crate::realtime::runtime().refresh_login_work();
    Ok(id)
}

fn prepare_fresh_login(preferences: &DeviceConnection) -> Result<String, String> {
    // Authentication retries and QR polling reuse one unactivated preparation: the same UUID,
    // the same cache file and, while still installed, the same physical connection. Only an
    // ended or activated login, or an undeletable retired cache, runs the full boundary below.
    // The durable journal owns the preparing identity; activation always writes the journal
    // before committing an owner credential, so a preparing journal admits no credential.
    let preparing = preferences.with_database(|conn| {
        Ok(crate::login_session_store::SessionStore::read(conn)?
            .and_then(|journal| journal.preparing_session().cloned()))
    })?;
    if let Some(id) = preparing {
        let current = login_connections::LOGIN_CONNECTIONS.current()?;
        if current.as_ref().is_some_and(|owner| owner.id() == &id) {
            return Ok(String::from(id));
        }
        if let Some(owner) = current {
            // A mismatched handle is stale and admits no business work; end it before draining
            // under the lifetime guard, exactly like the full boundary.
            owner.end().map_err(|e| e.to_string())?;
            #[cfg(target_os = "macos")]
            desktop_badge::reset();
        }
        let _lifetime = lifetime::CACHE_LIFETIME.invalidate()?;
        if let Some(owner) = login_connections::LOGIN_CONNECTIONS.current()? {
            login_connections::LOGIN_CONNECTIONS.release(&owner)?;
        }
        // Re-establish the preparation's own file: an existing file is restored as-is, exactly
        // like shell initialization (its schema came from the first preparation); a missing
        // file — a crash between the journal write and file creation — is healed by creating
        // it and applying the schema. No retired cache exists to delete and no avatar of this
        // login was written while it stayed unactivated.
        let directory = location::directory()?;
        let cache = directory.join(id.sqlite_filename());
        let existed = cache
            .try_exists()
            .map_err(|e| format!("inspect preparing login cache: {e}"))?;
        let conn = Connection::open_with_flags(
            &cache,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_CREATE,
        )
        .map_err(|e| format!("open preparing login cache: {e}"))?;
        configure(&conn)?;
        if !existed {
            create_cache_schema(&conn)?;
        }
        login_connections::LOGIN_CONNECTIONS.install(id.clone(), conn)?;
        return Ok(String::from(id));
    }
    // Hold the lifetime write guard until the new cache file is active and the journal is settled.
    if let Some(owner) = login_connections::LOGIN_CONNECTIONS.current()? {
        owner.end().map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        desktop_badge::reset();
    }
    let _lifetime = lifetime::CACHE_LIFETIME.invalidate()?;
    if let Some(owner) = login_connections::LOGIN_CONNECTIONS.current()? {
        login_connections::LOGIN_CONNECTIONS.release(&owner)?;
    }
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
        profile_avatars::clear()?;
        login_connections::LOGIN_CONNECTIONS.install(id.clone(), conn)?;
        Ok(String::from(id))
    })
}

/// Repair the captured login's cache (damaged/missing schema), retaining its physical connection
/// when it exists. Only this explicit lifecycle operation may create a missing file.
#[tauri::command]
pub(crate) async fn native_db_recreate_cache() -> Result<(), String> {
    let owner = login_connections::LOGIN_CONNECTIONS.current()?;
    let preferences = preferences_connection()?;
    let id = preferences.with_database(|conn| {
        crate::login_session_store::SessionStore::read(conn)?
            .and_then(|journal| journal.active_session().cloned())
            .ok_or_else(|| "no native login to repair".to_string())
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lifetime = lifetime::CACHE_LIFETIME.invalidate()?;
        preferences.with_database(|conn| {
            let current = crate::login_session_store::SessionStore::read(conn)?
                .and_then(|journal| journal.active_session().cloned());
            if current.as_ref() != Some(&id) {
                return Err("native login superseded".into());
            }
            Ok(())
        })?;
        let owner = match owner {
            Some(owner) => {
                if owner.id() != &id {
                    return Err("native login superseded".into());
                }
                owner
            }
            None => {
                let conn = Connection::open(location::directory()?.join(id.sqlite_filename()))
                    .map_err(|e| format!("open login cache for repair: {e}"))?;
                configure(&conn)?;
                login_connections::LOGIN_CONNECTIONS.install(id, conn)?
            }
        };
        owner
            .invalidate_database_work()
            .map_err(|e| e.to_string())?;
        owner
            .with_initialization_database(|conn| {
                let tx = conn
                    .transaction_with_behavior(TransactionBehavior::Exclusive)
                    .map_err(|e| format!("begin native cache recreation: {e}"))?;
                drop_cache_schema(&tx)?;
                create_cache_schema(&tx)?;
                tx.commit()
                    .map_err(|e| format!("commit native cache recreation: {e}"))?;
                profile_avatars::clear()
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("join native cache initialization: {e}"))??;
    // The maintenance lock has been released. Repair needs a fresh cache view and worker;
    // the OS service owner and its connectivity registration remain unchanged.
    crate::realtime::runtime().refresh_login_work();
    Ok(())
}

#[tauri::command]
pub(crate) async fn native_db_validate_cache() -> Result<(), String> {
    let owner = login_connections::LOGIN_CONNECTIONS
        .current()?
        .ok_or("no native login connection initialized")?;
    tauri::async_runtime::spawn_blocking(move || {
        owner
            .with_initialization_database(|conn| validate_cache_schema(conn))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("join native cache validation: {e}"))?
}

/// Rebuild only chat messages and their derived coverage state. SQLite DDL runs in one exclusive
/// transaction, so existing statements finish first and new database writers cannot interleave.
#[tauri::command]
pub(crate) async fn native_db_recreate_messages() -> Result<(), String> {
    let owner = login_connections::LOGIN_CONNECTIONS.capture()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lifetime = lifetime::CACHE_LIFETIME.invalidate()?;
        owner
            .invalidate_database_work()
            .map_err(|e| e.to_string())?;
        owner
            .with_database(|conn| {
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
             CREATE INDEX messages_by_origin ON messages(user_id, thread_id,
               json_extract(payload_json, '$.publisherNamespaceId'),
               json_extract(payload_json, '$.originSeq'));
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
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("join message cache recreation: {e}"))??;
    crate::realtime::runtime().refresh_login_work();
    Ok(())
}

#[tauri::command]
pub(crate) async fn native_db_count_messages(user_id: i64) -> Result<i64, String> {
    spawn_login_database(move |conn| {
        conn.query_row(
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
    let owner = login_connections::LOGIN_CONNECTIONS.capture()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lifetime = lifetime::CACHE_LIFETIME.invalidate()?;
        owner
            .invalidate_database_work()
            .map_err(|e| e.to_string())?;
        owner
            .with_database(|conn| {
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
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("join user clear: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_clear_all() -> Result<(), String> {
    let owner = login_connections::LOGIN_CONNECTIONS.capture()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lifetime = lifetime::CACHE_LIFETIME.invalidate()?;
        owner
            .invalidate_database_work()
            .map_err(|e| e.to_string())?;
        owner
            .with_database(|conn| {
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
                profile_avatars::clear()
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("join native db clear: {e}"))?
}

#[cfg(test)]
#[path = "tests/native_login_command_tests.rs"]
mod login_command_tests;
#[cfg(test)]
#[path = "tests/native_owned_work_tests.rs"]
mod owned_work_tests;
#[cfg(test)]
#[path = "tests/native_db_tests.rs"]
mod tests;

/// The process-wide location static admits exactly one directory; every test that needs the real
/// filesystem (per-login cache files, avatar store) shares this single instance.
#[cfg(test)]
pub(crate) static FILESYSTEM_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
    use super::*;
    use crate::login_session_store::{LoginSessionId, SessionStore};

    #[test]
    fn per_login_cache_files_follow_the_login_journal() {
        let _filesystem = FILESYSTEM_TEST_LOCK.lock().unwrap();
        let temp = shared_test_location();

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
        initialize_login_cache().unwrap();
        assert!(login_connections::LOGIN_CONNECTIONS
            .current()
            .unwrap()
            .is_none());
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
        let first_owner = login_connection(&first).unwrap();
        assert!(!is_login_session_current(&first));
        first_owner.with_initialization_database(|conn| {
            conn.execute_batch("CREATE TEMP TABLE owner_probe(value INTEGER); INSERT INTO owner_probe VALUES(17);").map_err(|e| e.to_string())
        }).unwrap();
        initialize_login_cache().unwrap();
        assert!(std::sync::Arc::ptr_eq(
            &first_owner,
            &login_connection(&first).unwrap()
        ));
        tauri::async_runtime::block_on(native_db_validate_cache()).unwrap();
        tauri::async_runtime::block_on(native_db_recreate_cache()).unwrap();
        first_owner
            .with_initialization_database(|conn| {
                let value: i64 = conn
                    .query_row("SELECT value FROM owner_probe", [], |row| row.get(0))
                    .map_err(|e| e.to_string())?;
                assert_eq!(value, 17); // Repair changes schema, not the physical connection.
                Ok(())
            })
            .unwrap();
        first_owner
            .begin_activation()
            .unwrap()
            .commit("secret-one".into())
            .unwrap();
        assert!(is_login_session_current(&first));
        tauri::async_runtime::block_on(async {
            account_state::native_db_initialize_account_state(42)
                .await
                .unwrap();
            let proof = spawn_login_database(|conn| {
                conn.query_row("SELECT value FROM owner_probe", [], |row| {
                    row.get::<_, i64>(0)
                })
                .map_err(|e| e.to_string())
            })
            .await
            .unwrap()
            .unwrap();
            assert_eq!(proof, 17);
            account_state::native_db_read_account_state(42)
                .await
                .unwrap();
            login_command_tests::verify_owned_local_commands().await;
        });

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
                Ok(())
            })
            .unwrap();
        assert_eq!(
            restore_login_credential("secret-one").unwrap(),
            Some(String::from(first.clone()))
        );
        assert_eq!(restore_login_credential("residual-token").unwrap(), None);
        assert!(std::sync::Arc::ptr_eq(
            &first_owner,
            &login_connection(&first).unwrap()
        ));
        preferences
            .with_database(|conn| {
                // Logout: the journal records cleanup ownership, the cache file stays on disk.
                SessionStore::end(conn, Some(&first)).unwrap();
                SessionStore::finish_ending(conn, Some(&first)).unwrap();
                Ok(())
            })
            .unwrap();
        login_command_tests::verify_queued_commands_end_before_sql();
        assert!(!is_login_session_current(&first));
        first_owner.end().unwrap();
        release_login_connection(&first_owner).unwrap();
        assert!(first_file.exists());
        assert!(first_owner
            .with_initialization_database(|_| Ok(()))
            .is_err());
        initialize_login_cache().unwrap();
        assert!(login_connections::LOGIN_CONNECTIONS
            .current()
            .unwrap()
            .is_none());

        // Fresh login #2: deletes the retired file, mints a new UUID and file.
        let second = LoginSessionId::try_from(
            prepare_fresh_login(preferences_connection().unwrap()).unwrap(),
        )
        .unwrap();
        assert_ne!(first, second);
        assert!(!first_file.exists());
        assert!(temp.path().join(second.sqlite_filename()).exists());
        let second_owner = login_connection(&second).unwrap();
        assert!(!std::sync::Arc::ptr_eq(&first_owner, &second_owner));
        assert!(first_owner.credential().is_err());
        release_login_connection(&first_owner).unwrap();
        assert!(std::sync::Arc::ptr_eq(
            &second_owner,
            &login_connection(&second).unwrap()
        ));

        // Simulated process shutdown releases the connection without ending the durable login.
        // The next explicit initialization restores the UUID from the journal, not a current path.
        second_owner.end().unwrap();
        release_login_connection(&second_owner).unwrap();
        initialize_login_cache().unwrap();
        assert_eq!(
            login_connections::LOGIN_CONNECTIONS
                .current()
                .unwrap()
                .unwrap()
                .id(),
            &second
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
        let restored_owner = login_connections::LOGIN_CONNECTIONS
            .current()
            .unwrap()
            .unwrap();
        restored_owner.end().unwrap();
        release_login_connection(&restored_owner).unwrap();

        // The journal never activated the second login, so the next authentication attempt —
        // a password retry or a QR poll — reuses that preparation instead of minting another
        // login: the same UUID, and its file is re-established after the released connection.
        assert_eq!(
            prepare_fresh_login(preferences_connection().unwrap()).unwrap(),
            String::from(second.clone())
        );

        // Authentication retries and QR polling keep reusing the unactivated preparation: the
        // same UUID, the same cache file, the same physical connection, no retired entries.
        let session_files = |dir: &std::path::Path| -> Vec<String> {
            let mut names: Vec<String> = std::fs::read_dir(dir)
                .unwrap()
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| name.starts_with("soms-session-") && name.ends_with(".sqlite"))
                .collect();
            names.sort();
            names
        };
        let second_owner = login_connection(&second).unwrap();
        let files_at_preparation = session_files(temp.path());
        assert_eq!(files_at_preparation.len(), 1);
        for _ in 0..3 {
            assert_eq!(
                prepare_fresh_login(preferences_connection().unwrap()).unwrap(),
                String::from(second.clone())
            );
            assert!(std::sync::Arc::ptr_eq(
                &second_owner,
                &login_connection(&second).unwrap()
            ));
            assert_eq!(session_files(temp.path()), files_at_preparation);
        }
        preferences
            .with_database(|conn| {
                let journal = SessionStore::read(conn)?.unwrap();
                assert_eq!(journal.active_session(), Some(&second));
                assert!(journal.pending_cleanup().is_empty());
                Ok(())
            })
            .unwrap();

        // Once activated, the next preparation runs the full boundary again: a fresh UUID,
        // the activated file retired and deleted.
        second_owner
            .begin_activation()
            .unwrap()
            .commit("secret-two".into())
            .unwrap();
        preferences
            .with_database(|conn| {
                SessionStore::activate(conn, &second, "secret-two").unwrap();
                Ok(())
            })
            .unwrap();
        let third = LoginSessionId::try_from(
            prepare_fresh_login(preferences_connection().unwrap()).unwrap(),
        )
        .unwrap();
        assert_ne!(second, third);
        assert!(!temp.path().join(second.sqlite_filename()).exists());
        assert!(temp.path().join(third.sqlite_filename()).exists());
        let third_owner = login_connection(&third).unwrap();
        third_owner.end().unwrap();
        release_login_connection(&third_owner).unwrap();
    }
}
