use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use serde_json::Value;
use std::path::PathBuf;

use device_connection::DeviceConnection;

pub(crate) mod account_state;
pub(crate) mod app_state;
pub(crate) mod attention;
#[cfg(any(target_os = "android", test))]
pub(crate) mod call_peer;
pub(crate) mod client_state;
pub(crate) mod contacts;
#[cfg(any(target_os = "macos", test))]
pub(crate) mod desktop_badge;
#[cfg(desktop)]
pub(crate) mod desktop_notifications;
mod device_connection;
mod group_meta_store;
pub(crate) mod history_ipc;
mod lifetime;
pub(crate) mod location;
mod login_connections;
mod lru;
#[cfg(any(target_os = "android", test))]
pub(crate) mod mentions;
pub(crate) mod messages;
pub(crate) mod namespace_feed;
pub(crate) mod namespace_subscriptions;
pub(crate) mod notifications;
pub(crate) mod preferences;
pub(crate) mod profile_avatars;
pub(crate) mod profile_namespaces;
pub(crate) mod profile_subscriptions;
pub(crate) mod resource_scheduler;
pub(crate) mod state_feed_sync;
mod thread_patch;
mod thread_store;
mod thread_resource_sync;
pub(crate) mod unread;
pub(crate) mod watch_ipc;
pub(crate) use client_state::chrono_millis;
#[cfg(test)]
use messages::{
    history_gap_is_owned, reduce_message_ranges, validate_message_ranges, HistoryDirection,
    MessageInterval, MessageRange, MessageRangeState, ServerMessageRange,
};

const CACHE_SCHEMA_VERSION: i64 = 2;

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

pub(crate) fn avatar_cache_path() -> Result<PathBuf, String> {
    Ok(db_path()?.with_extension("profile-avatars"))
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
/// The database start check creates missing tables and establishes the initial lifecycle.
/// Capturing or using device preferences later never creates a connection.
pub(crate) fn initialize_preferences() -> Result<(), String> {
    device_connection::DEVICE_CONNECTION.initialize(&db_path()?)?;
    let server_configured = crate::server_setup::has_persisted_configuration();
    preferences_connection()?.with_database(|conn| {
        crate::login_session_store::SessionStore::initialize(conn, server_configured)
    })
}

/// Resumes a local deletion that a previous process left unfinished. It never contacts the
/// server: the logout was already confirmed, or the user chose local deletion.
pub(crate) fn resume_local_cleanup() -> Result<(), String> {
    let preferences = preferences_connection()?;
    let pending = preferences.with_database(|conn| {
        Ok(crate::login_session_store::SessionStore::read(conn)?
            .cleaning_session()
            .cloned())
    })?;
    let Some(id) = pending else {
        return Ok(());
    };
    delete_login_cache_files(&id)?;
    preferences.with_database(|conn| {
        crate::login_session_store::SessionStore::finish_cleaning(conn)
    })?;
    Ok(())
}

/// Removes the cache of a login whose deletion is recorded as `cleaning`. A partial deletion
/// is safe to repeat.
pub(crate) fn delete_login_cache_files(
    id: &crate::login_session_store::LoginSessionId,
) -> Result<(), String> {
    let directory = location::directory()?;
    if !directory.is_absolute() {
        return Err("native cache directory must be absolute".into());
    }
    for path in id.cache_files(&directory) {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("remove ended login cache: {error}")),
        }
    }
    Ok(())
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
            .active_session()
            .cloned())
    })?;
    let Some(id) = id else { return Ok(()) };
    let path = location::directory()?.join(id.sqlite_filename());
    let database = (|| -> Result<Option<Connection>, String> {
        if !path
            .try_exists()
            .map_err(|e| format!("inspect login cache: {e}"))?
        {
            return Ok(None);
        }
        let conn = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| format!("restore login cache connection: {e}"))?;
        configure(&conn)?;
        Ok(Some(conn))
    })();
    let database = database.unwrap_or_else(|error| {
        log::warn!("login cache requires explicit repair: {error}");
        None
    });
    login_connections::LOGIN_CONNECTIONS.install_restoring(id, database)?;
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

/// The sole in-memory login authority. Capture once, then carry this owner through all work.
pub(crate) fn active_login(
) -> Result<std::sync::Arc<crate::login_connection::LoginConnection>, String> {
    login_connections::LOGIN_CONNECTIONS.capture()
}

pub(crate) fn current_login(
) -> Result<Option<std::sync::Arc<crate::login_connection::LoginConnection>>, String> {
    login_connections::LOGIN_CONNECTIONS.current()
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

/// Credential validation at explicit restoration, never at ordinary command admission. The
/// credential is admitted only together with the UUID it was saved with.
#[cfg(any(target_os = "android", test))]
pub(crate) fn restore_login_credential(
    token: &str,
    session_uuid: &str,
) -> Result<Option<String>, String> {
    let id = preferences_connection()?.with_database(|conn| {
        crate::login_session_store::SessionStore::restore(conn, session_uuid)
    })?;
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

/// Reconcile the secure-store snapshot only during Android cold start, before business work.
/// A rejected or absent credential deletes the restored login's local evidence. Storage errors
/// stay retryable errors and never count as evidence that the deletion happened.
#[cfg(any(target_os = "android", test))]
pub(crate) fn reconcile_cold_start_credential(
    credential: Option<(&str, &str)>,
) -> Result<Option<std::sync::Arc<crate::login_connection::LoginConnection>>, String> {
    if let Some((token, session_uuid)) = credential.filter(|(t, u)| !t.is_empty() && !u.is_empty()) {
        if restore_login_credential(token, session_uuid)?.is_some() {
            return current_login();
        }
    }
    let owned = preferences_connection()?.with_database(|conn| {
        let record = crate::login_session_store::SessionStore::read(conn)?;
        Ok(record.state.owns_a_login().then_some(record.session).flatten())
    })?;
    // The restored owner was never admitted; nothing else refers to its cache.
    if let Some(id) = owned {
        end_login_durable(&id)?;
    }
    Ok(None)
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
pub(crate) fn release_login_connection(
    owner: &std::sync::Arc<crate::login_connection::LoginConnection>,
) -> Result<(), String> {
    login_connections::LOGIN_CONNECTIONS.release(owner)
}

/// Ends the login and deletes its local evidence: admission end, the cleaning state, cache
/// file deletion, the signed-out state. `clear_session_token`, the Android adapter's forced
/// teardown, and a credential rejected at start share this sequence. A failed deletion leaves
/// `cleaning`, so the next start resumes it. A login that never completed owns nothing durable
/// and only releases its preparation.
pub(crate) fn end_login_durable(
    id: &crate::login_session_store::LoginSessionId,
) -> Result<(), String> {
    let owner = current_login()?;
    if let Some(owner) = &owner {
        if owner.id() != id {
            return Err("native login superseded".into());
        }
        owner.end().map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        desktop_badge::reset();
    }
    let preferences = preferences_connection()?;
    let record = preferences
        .with_database(|conn| crate::login_session_store::SessionStore::read(conn))?;
    let mine = record.session.as_ref() == Some(id);
    match (record.state, mine) {
        (crate::login_session_store::LifecycleState::Active, true) => {
            preferences.with_database(|conn| {
                crate::login_session_store::SessionStore::begin_cleaning(conn, id)
            })?;
        }
        (crate::login_session_store::LifecycleState::Cleaning, true) => {}
        (state, _) if state.owns_a_login() => return Err("native login superseded".into()),
        _ => {
            return match &owner {
                Some(owner) => release_login_connection(owner),
                None => Ok(()),
            };
        }
    }
    // A cache file cannot be removed on every platform while a connection still holds it.
    if let Some(owner) = &owner {
        release_login_connection(owner)?;
    }
    delete_login_cache_files(id)?;
    preferences.with_database(|conn| {
        crate::login_session_store::SessionStore::finish_cleaning(conn)
    })?;
    Ok(())
}

/// End the current login only when it matches `id`; a superseded or absent login is a no-op.
/// Callers must have proven knowledge of the epoch UUID (renderer capture, or a server-forced
/// teardown carrying the UUID) before ending anything.
pub(crate) fn end_current_login_if_matching(
    id: &crate::login_session_store::LoginSessionId,
) -> Result<(), String> {
    match current_login()? {
        Some(owner) if owner.id() == id => end_login_durable(id),
        _ => Ok(()),
    }
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
        "thread_resource_sync",
        "group_meta",
        "thread_previews",
        "profiles",
        "account_state",
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
    thread_store::validate_schema(conn)?;
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
        "state_feed_target",
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
          state_feed_target INTEGER NOT NULL DEFAULT 0 CHECK(state_feed_target >= 0),
          profile_namespace_change_end_id INTEGER CHECK(profile_namespace_change_end_id >= 0),
          intent_request_end_id INTEGER CHECK(intent_request_end_id >= 0),
          intent_request_read_id INTEGER CHECK(intent_request_read_id >= 0),
          intent_request_optimistic_read_id INTEGER CHECK(intent_request_optimistic_read_id >= 0),
          CHECK ((intent_request_end_id IS NULL) = (intent_request_read_id IS NULL)),
          CHECK (intent_request_read_id <= intent_request_end_id)
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
    conn.execute_batch(thread_resource_sync::SCHEMA).map_err(|e| e.to_string())?;
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
    crate::send_outbox::SendOutboxStorage::initialize(conn)?;
    crate::download_history::DownloadHistoryStorage::initialize(conn)?;
    Ok(())
}

fn recreate_cache_schema(conn: &mut Connection) -> Result<(), String> {
    // Full recreation discards all per-login database contents, including pending sends.
    // The login journal and device preferences live in a separate database. Enumerate actual
    // objects so no obsolete data survive repair. TEMP objects belong to
    // the retained physical connection and are not part of the persistent cache schema.
    if !conn.is_autocommit() {
        return Err("native cache recreation requires no active transaction".into());
    }
    let foreign_keys: bool = conn
        .pragma_query_value(None, "foreign_keys", |row| row.get(0))
        .map_err(|e| format!("read cache foreign key setting: {e}"))?;
    // Disable before beginning the transaction: unknown dependencies (including cycles and
    // missing referenced tables) must not prevent throwing away the entire disposable schema.
    conn.pragma_update(None, "foreign_keys", false)
        .map_err(|e| format!("disable cache foreign keys: {e}"))?;
    let result = (|| {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Exclusive)
            .map_err(|e| format!("begin native cache recreation: {e}"))?;
        let objects = tx
            .prepare(
                "SELECT type,name FROM main.sqlite_schema
                 WHERE type IN ('view','table') AND name NOT GLOB 'sqlite_*'
                 ORDER BY type DESC, name",
            )
            .map_err(|e| format!("inspect native cache objects: {e}"))?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("read native cache objects: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("decode native cache objects: {e}"))?;
        let owned = if objects.iter().any(|(_, name)| name == "owned_send_resources") {
            tx.prepare("SELECT path FROM owned_send_resources ORDER BY path")
                .map_err(|e| format!("inspect owned recordings: {e}"))?
                .query_map([], |row| row.get(0))
                .map_err(|e| format!("read owned recordings: {e}"))?
                .collect::<Result<Vec<String>, _>>()
                .map_err(|e| format!("decode owned recordings: {e}"))?
        } else {
            Vec::new()
        };
        for (kind, name) in objects {
            // Dropping tables also removes their indexes and triggers. Quote identifiers from
            // the database, and qualify main so a TEMP name cannot shadow a persistent object.
            let name = name.replace('"', "\"\"");
            tx.execute_batch(&format!("DROP {kind} IF EXISTS main.\"{name}\";"))
                .map_err(|e| format!("drop native cache object: {e}"))?;
        }
        create_cache_schema(&tx)?;
        tx.commit()
            .map_err(|e| format!("commit native cache recreation: {e}"))?;
        crate::send_outbox::release_owned_recordings(owned)
    })();
    // Restore enforcement after either commit or rollback before the owner can admit work.
    let restored = conn
        .pragma_update(None, "foreign_keys", foreign_keys)
        .map_err(|e| format!("restore cache foreign keys: {e}"));
    restored?;
    result
}

/// Fresh-login preparation, run BEFORE the authentication request. Signing in is not recorded:
/// while the app is signed out, a login owner that is already installed is this process's
/// unactivated preparation and is reused. Otherwise an admitted login is ended, an unfinished
/// local deletion is resumed, and a new UUID and cache file are created. Credentials are not
/// involved, so a process that dies here next starts signed out.
#[tauri::command]
pub(crate) async fn native_db_begin_login(
    state: tauri::State<'_, crate::ServerSessionState>,
) -> Result<String, String> {
    let guard = state
        .auth_lifecycle
        .enter(crate::auth_lifecycle::Phase::Login)?;
    let preferences = preferences_connection()?;
    let id = tauri::async_runtime::spawn_blocking(move || {
        // A preparation of an older server configuration is never reused: a late authentication
        // response may still carry its UUID.
        let id = prepare_fresh_login(preferences, &guard)?;
        guard.register_login(&id)?;
        Ok::<_, String>(id)
    })
    .await
    .map_err(|e| format!("join native fresh-login preparation: {e}"))??;
    crate::realtime::runtime().refresh_login_work();
    Ok(id)
}

fn prepare_fresh_login(
    preferences: &DeviceConnection,
    guard: &crate::auth_lifecycle::TransitionGuard,
) -> Result<String, String> {
    let current = login_connections::LOGIN_CONNECTIONS.current()?;
    let reusable = preferences.with_database(|conn| {
        Ok(matches!(
            crate::login_session_store::SessionStore::read(conn)?.state,
            crate::login_session_store::LifecycleState::Unconfigured
                | crate::login_session_store::LifecycleState::SignedOut
        ))
    })?;
    // Authentication retries and QR polling reuse this process's unactivated preparation: the
    // same UUID, cache file and connection. It is never a login; nothing durable records it.
    if reusable {
        if let Some(owner) = current
            .as_ref()
            .filter(|owner| !guard.is_superseded(&owner.id().to_string()))
        {
            return Ok(String::from(owner.id().clone()));
        }
    }
    // Hold the lifetime write guard until the ended login's files are gone and the new cache
    // file is installed.
    if let Some(owner) = &current {
        owner.end().map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        desktop_badge::reset();
    }
    let _lifetime = lifetime::CACHE_LIFETIME.invalidate()?;
    if let Some(owner) = &current {
        login_connections::LOGIN_CONNECTIONS.release(owner)?;
    }
    preferences.with_database(|conn| {
        let directory = location::directory()?;
        let record = crate::login_session_store::SessionStore::read(conn)?;
        // A login replaced without a logout passes through the same local deletion, and a
        // deletion the previous process left unfinished resumes here as well as at start.
        let pending = match (record.state, record.session.clone()) {
            (
                crate::login_session_store::LifecycleState::Active,
                Some(id),
            ) => {
                crate::login_session_store::SessionStore::begin_cleaning(conn, &id)?;
                Some(id)
            }
            (crate::login_session_store::LifecycleState::Cleaning, id) => id,
            _ => None,
        };
        if let Some(id) = pending {
            delete_login_cache_files(&id)?;
            crate::login_session_store::SessionStore::finish_cleaning(conn)?;
        }
        let id = crate::login_session_store::LoginSessionId::new();
        delete_login_cache_files(&id)?;
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

            .active_session()
            .cloned()
            .ok_or_else(|| "no native login to repair".to_string())
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lifetime = lifetime::CACHE_LIFETIME.invalidate()?;
        preferences.with_database(|conn| {
            let current = crate::login_session_store::SessionStore::read(conn)?
                .active_session()
                .cloned();
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
            .initialize_missing_cache(|| {
                let directory = location::directory()?;
                let path = directory.join(owner.id().sqlite_filename());
                let open = || -> Result<Connection, String> {
                    let conn = Connection::open(&path)
                        .map_err(|e| format!("open login cache for repair: {e}"))?;
                    configure(&conn)?;
                    Ok(conn)
                };
                match open() {
                    Ok(conn) => Ok(conn),
                    Err(error) => {
                        // This is the explicit disposable-cache repair boundary, never restoration.
                        // A corrupt SQLite header cannot be healed by schema DDL.
                        log::warn!("recreating unreadable login cache: {error}");
                        for file in owner.id().cache_files(&directory) {
                            match std::fs::remove_file(file) {
                                Ok(()) => {}
                                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                                Err(error) => {
                                    return Err(format!("remove corrupt login cache: {error}"))
                                }
                            }
                        }
                        open()
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        owner
            .with_initialization_database(|conn| {
                recreate_cache_schema(conn)?;
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
            .with_initialization_database(|conn| {
                validate_cache_schema(conn)?;
                crate::send_outbox::SendOutboxStorage::initialize(conn)?;
                crate::download_history::DownloadHistoryStorage::initialize(conn)?;
                Ok(())
            })
            .map_err(|e| match e {
                crate::login_connection::ConnectionError::Operation(message) => format!("SESSION_DATABASE_ERROR:{message}"),
                crate::login_connection::ConnectionError::Closed => "SESSION_DATABASE_ERROR:cache is unavailable".into(),
                other => other.to_string(),
            })
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
                    "CREATE TEMP TABLE retained_message_tombs AS
               SELECT * FROM messages WHERE json_extract(payload_json, '$.contentType') = 'TOMB';
             DROP TABLE messages;
             DROP TABLE IF EXISTS message_ranges;
             CREATE TABLE messages (
               user_id INTEGER NOT NULL,
               thread_id INTEGER NOT NULL,
               seq INTEGER NOT NULL,
               created_at INTEGER NOT NULL,
               payload_json TEXT NOT NULL,
               PRIMARY KEY (user_id, thread_id, seq)
             );
             INSERT INTO messages SELECT * FROM retained_message_tombs;
             DROP TABLE retained_message_tombs;
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
               ON message_ranges(user_id, thread_id, right_inclusive);",
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
            "SELECT COUNT(*) FROM messages WHERE user_id = ?1
             AND COALESCE(json_extract(payload_json, '$.isDeleted'), 0) != 1",
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
                let owned = crate::send_outbox::SendOutboxStorage::new(&tx).clear()?;
                crate::download_history::DownloadHistoryStorage::new(&tx).clear()?;
                for table in [
                    "thread_previews",
                    "threads",
                    "thread_resource_sync",
                    "profile_tombs",
                    "profile_namespace_tombs",
                    "profile_namespaces",
                    "profiles",
                    "account_state",
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
                crate::send_outbox::release_owned_recordings(owned)?;
                profile_avatars::clear_user(user_id)
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("join user clear: {e}"))?
}

/// Recovery carries the failed restore's identity, never authority inferred from the current slot.
/// The caller retains auth admission and the replacement fence through all physical effects.
fn reset_frontend_storage(
    expected: Option<crate::login_session_store::LoginSessionId>,
    _guard: crate::auth_lifecycle::TransitionGuard,
) -> Result<(), String> {
    let _replacement = lifetime::CACHE_LIFETIME.invalidate()?;
    let owner = login_connections::LOGIN_CONNECTIONS.current()?;
    let expected = expected.ok_or("SESSION_SUPERSEDED")?;
    // The captured UUID must still own the slot even when the journal itself is unreadable.
    validate_recovery_owner(Some(&expected), owner.as_deref())?;
    reset_frontend_storage_owned(owner, &_guard)
}

/// Only callers already holding the replacement fence and validated recovery authority enter here.
fn reset_frontend_storage_owned(
    owner: Option<std::sync::Arc<crate::login_connection::LoginConnection>>,
    _guard: &crate::auth_lifecycle::TransitionGuard,
) -> Result<(), String> {
    let configured = crate::server_setup::has_persisted_configuration();
    if let Some(owner) = owner {
        owner.end().map_err(|e| e.to_string())?;
        // Release drains notification delivery before closing the connection.
        login_connections::LOGIN_CONNECTIONS.release(&owner)?;
    }
    delete_login_cache_files(&crate::login_session_store::LoginSessionId::new())?;
    preferences_connection()?.with_database(|conn| {
        // Server selection is installation state, not failed-login recovery data.
        conn.execute_batch("DELETE FROM settings; DELETE FROM app_state WHERE key != 'serverConfig';")
            .map_err(|e| format!("clear device database: {e}"))?;
        app_state::put(conn, app_state::SCHEMA_VERSION_KEY, &app_state::SCHEMA_VERSION.to_string())?;
        crate::login_session_store::SessionStore::initialize(conn, configured)
    })
}

/// The original restore command may recover an ownerless damaged journal only while retaining
/// the same auth admission that observed the database error. This is not a public reset permit.
pub(crate) fn restore_session_journal(
    session_uuid: &str,
    guard: &crate::auth_lifecycle::TransitionGuard,
) -> Result<Option<String>, String> {
    let _replacement = lifetime::CACHE_LIFETIME.invalidate()?;
    let owner = login_connections::LOGIN_CONNECTIONS.current()?;
    let preferences = preferences_connection()?;
    // Only the database operation's error reaches recovery. Admission/slot/transport errors above
    // propagate unchanged; a healthy journal rejecting a stale credential never deletes anything.
    let restored = preferences.with_database(|conn| {
        Ok(crate::login_session_store::SessionStore::restore(conn, session_uuid))
    })?;
    match restored {
        Ok(id) => Ok(id.map(String::from)),
        Err(_database_error) => {
            if owner.is_some() {
                let expected = crate::login_session_store::LoginSessionId::try_from(session_uuid.to_owned())?;
                validate_recovery_owner(Some(&expected), owner.as_deref())?;
            }
            // The fence spans both the observation and cleanup. No owner can be installed between
            // an ownerless corruption check and deletion of the fixed cache filename.
            reset_frontend_storage_owned(owner, guard)?;
            Ok(None)
        }
    }
}

fn validate_recovery_owner(
    expected: Option<&crate::login_session_store::LoginSessionId>,
    owner: Option<&crate::login_connection::LoginConnection>,
) -> Result<(), String> {
    // Unknown credentials are not permission to reset a currently owned store. Ended owners
    // also reject recovery: logout, including its retained revocation decision, owns cleanup.
    let matches = match expected {
        Some(id) => owner.is_some_and(|owner| {
            owner.id() == id && !owner.cancellation().is_cancelled()
        }),
        None => false,
    };
    if matches { Ok(()) } else { Err("SESSION_SUPERSEDED".into()) }
}

#[tauri::command]
pub(crate) async fn native_reset_frontend_storage(
    session_uuid: Option<String>,
    state: tauri::State<'_, crate::ServerSessionState>,
) -> Result<(), String> {
    let expected = session_uuid.map(crate::login_session_store::LoginSessionId::try_from).transpose()?;
    // Acquire before scheduling, and move the permit into the worker. Dropping the IPC waiter
    // cannot admit a login while a delayed deletion can still remove the fixed cache filename.
    let guard = state.auth_lifecycle.enter(crate::auth_lifecycle::Phase::Login)?;
    tauri::async_runtime::spawn_blocking(move || reset_frontend_storage(expected, guard))
        .await
        .map_err(|e| format!("join frontend storage reset: {e}"))?
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
                 DELETE FROM thread_resource_sync;
                 DELETE FROM profiles;
                 DELETE FROM account_state;
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
pub(crate) fn shared_test_location() -> &'static tempfile::TempDir {
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
    fn restoration_recovery_rejects_unknown_successor_and_ended_owners() {
        let old = LoginSessionId::new();
        let next = LoginSessionId::new();
        let owner = crate::login_connection::LoginConnection::restoring(old.clone(), None);
        assert!(validate_recovery_owner(Some(&old), Some(&owner)).is_ok());
        assert!(validate_recovery_owner(None, None).is_err());
        assert!(validate_recovery_owner(None, Some(&owner)).is_err());
        assert!(validate_recovery_owner(Some(&next), Some(&owner)).is_err());
        owner.end().unwrap();
        assert!(validate_recovery_owner(Some(&old), Some(&owner)).is_err());
    }

    #[test]
    fn original_restore_recovers_corruption_without_authorizing_stale_credentials() {
        let _filesystem = FILESYSTEM_TEST_LOCK.lock().unwrap();
        let directory = shared_test_location();
        assert!(current_login().unwrap().is_none());
        let preferences = preferences_connection().unwrap();
        preferences.with_database(|conn| {
            conn.execute_batch("DELETE FROM app_state; DELETE FROM settings;").map_err(|e| e.to_string())?;
            app_state::put(conn, app_state::SCHEMA_VERSION_KEY, &app_state::SCHEMA_VERSION.to_string())?;
            app_state::put(conn, "serverConfig", "{\"primary\":\"https://preserved.test\"}")?;
            SessionStore::initialize(conn, true)
        }).unwrap();
        let lifecycle = std::sync::Arc::new(crate::auth_lifecycle::AuthLifecycle::default());
        let guard = lifecycle.enter(crate::auth_lifecycle::Phase::Login).unwrap();
        let stale = LoginSessionId::new();
        let cache = directory.path().join(stale.sqlite_filename());
        std::fs::write(&cache, b"old cache").unwrap();
        // A healthy signed-out journal plus residual credential is not corruption.
        assert!(restore_session_journal(&stale.to_string(), &guard).unwrap().is_none());
        assert!(cache.exists());
        drop(guard);
        let guard = lifecycle.enter(crate::auth_lifecycle::Phase::Login).unwrap();
        assert!(reset_frontend_storage(None, guard).is_err());
        assert!(cache.exists());
        preferences.with_database(|conn| app_state::put(conn, "lifecycleState", "\"damaged\"")).unwrap();
        let guard = lifecycle.enter(crate::auth_lifecycle::Phase::Login).unwrap();
        assert!(restore_session_journal(&stale.to_string(), &guard).unwrap().is_none());
        assert!(!cache.exists());
        preferences.with_database(|conn| {
            assert_eq!(SessionStore::read(conn)?.state, crate::login_session_store::LifecycleState::SignedOut);
            assert_eq!(app_state::get(conn, app_state::SCHEMA_VERSION_KEY)?, Some(app_state::SCHEMA_VERSION.to_string()));
            assert!(app_state::get(conn, "serverConfig")?.is_some());
            Ok(())
        }).unwrap();
        let id = LoginSessionId::try_from(prepare_fresh_login(preferences, &guard).unwrap()).unwrap();
        let owner = current_login().unwrap().unwrap();
        preferences.with_database(|conn| app_state::put(conn, "lifecycleState", "\"damaged\"")).unwrap();
        // The failed original credential cannot reset a different prepared owner.
        assert!(restore_session_journal(&stale.to_string(), &guard).is_err());
        assert!(!owner.cancellation().is_cancelled());
        assert!(cache.exists());
        assert!(restore_session_journal(&id.to_string(), &guard).unwrap().is_none());
        assert!(owner.cancellation().is_cancelled());
        assert!(current_login().unwrap().is_none());
        assert!(!cache.exists());
        preferences.with_database(|conn| app_state::remove(conn, "serverConfig")).unwrap();
    }

    #[test]
    fn per_login_cache_files_follow_the_login_journal() {
        let _filesystem = FILESYSTEM_TEST_LOCK.lock().unwrap();
        let temp = shared_test_location();

        // Startup creates only the device connection, even without a login journal. A TEMP trigger
        // proves that ordinary IPC preference commands use this same physical connection.
        let startup = preferences_connection().unwrap();
        startup
            .with_database(|conn| {
                crate::native_db::app_state::put(
                    conn,
                    "lifecycleState",
                    "\"unconfigured\"",
                )?;
                crate::native_db::app_state::remove(conn, "sessionUuid")?;
                assert_eq!(
                    SessionStore::read(conn)?.state,
                    crate::login_session_store::LifecycleState::Unconfigured
                );
                conn.execute_batch(
                    "CREATE TEMP TABLE connection_events(key TEXT);
                 CREATE TEMP TRIGGER preference_connection_proof
                 AFTER INSERT ON main.settings
                 BEGIN INSERT INTO connection_events VALUES(NEW.key); END;",
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        initialize_preferences().unwrap(); // Shell attachment must not reconnect after headless init.
        initialize_login_cache().unwrap();
        assert!(reconcile_cold_start_credential(None).unwrap().is_none());
        assert!(reconcile_cold_start_credential(Some((
            "residual-token",
            "11111111-2222-4d9e-af01-234567890abc"
        )))
        .unwrap()
        .is_none());
        assert!(login_connections::LOGIN_CONNECTIONS
            .current()
            .unwrap()
            .is_none());
        tauri::async_runtime::block_on(async {
            preferences::native_db_put_preference(
                "connection-proof".into(),
                Value::Bool(true),
            )
            .await
            .unwrap();
            assert_eq!(
                preferences::native_db_get_preference("connection-proof".into())
                    .await
                    .unwrap(),
                Some(Value::Bool(true))
            );
            preferences::native_db_delete_preference("connection-proof".into())
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
        let lifecycle = std::sync::Arc::new(crate::auth_lifecycle::AuthLifecycle::default());
        let guard = lifecycle
            .enter(crate::auth_lifecycle::Phase::Login)
            .unwrap();
        let first = LoginSessionId::try_from(
            prepare_fresh_login(preferences_connection().unwrap(), &guard).unwrap(),
        )
        .unwrap();
        drop(guard);
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
        first_owner
            .begin_activation()
            .unwrap()
            .commit("secret-one".into())
            .unwrap();
        preferences_connection()
            .unwrap()
            .with_database(|conn| SessionStore::activate(conn, &first))
            .unwrap();
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
                    "INSERT INTO settings(key,value_json,updated_at)
             VALUES('theme','\"dark\"',0)",
                    [],
                )
                .unwrap();
                SessionStore::activate(conn, &first).unwrap();
                Ok(())
            })
            .unwrap();
        assert_eq!(
            restore_login_credential("secret-one", &first.to_string()).unwrap(),
            Some(String::from(first.clone()))
        );
        assert_eq!(
            restore_login_credential("residual-token", "11111111-2222-4d9e-af01-234567890abc")
                .unwrap(),
            None
        );
        assert!(std::sync::Arc::ptr_eq(
            &first_owner,
            &login_connection(&first).unwrap()
        ));
        // Schema repair is cache-only: keep the admitted owner, credential and durable journal,
        // but invalidate queued database work and discard every obsolete persistent object.
        let stale_work = capture_database_work().unwrap();
        first_owner
            .with_initialization_database(|conn| {
                conn.execute_batch(
                    "UPDATE cache_meta SET value_json='1' WHERE key='schemaVersion';
                 CREATE TABLE obsolete_cache(value TEXT);
                 INSERT INTO obsolete_cache VALUES('discard');",
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        assert!(tauri::async_runtime::block_on(native_db_validate_cache()).is_err());
        tauri::async_runtime::block_on(native_db_recreate_cache()).unwrap();
        tauri::async_runtime::block_on(native_db_validate_cache()).unwrap();
        assert!(stale_work.assert_current().is_err());
        assert!(std::sync::Arc::ptr_eq(
            &first_owner,
            &active_login().unwrap()
        ));
        assert_eq!(first_owner.credential().unwrap(), "secret-one");
        first_owner
            .with_initialization_database(|conn| {
                let obsolete: bool = conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='obsolete_cache')",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                assert!(!obsolete);
                Ok(())
            })
            .unwrap();
        preferences
            .with_database(|conn| {
                assert_eq!(
                    SessionStore::restore(conn, &first.to_string())?,
                    Some(first.clone())
                );
                let theme: String = conn.query_row(
                "SELECT value_json FROM settings WHERE key='theme'",
                [], |row| row.get(0),
            ).map_err(|e| e.to_string())?;
                assert_eq!(theme, "\"dark\"");
                Ok(())
            })
            .unwrap();
        // Process restart with a missing cache retains the login identity and credential. The
        // existing frontend validate/recreate flow repairs it without replacing the owner or epoch.
        first_owner.end().unwrap();
        release_login_connection(&first_owner).unwrap();
        for file in first.cache_files(temp.path()) {
            if file.exists() {
                std::fs::remove_file(file).unwrap();
            }
        }
        initialize_login_cache().unwrap();
        assert!(!first_file.exists());
        let first_owner = reconcile_cold_start_credential(Some((
            "secret-one",
            &first.to_string(),
        )))
        .unwrap()
        .unwrap();
        assert!(first_owner.assert_active().is_ok());
        assert_eq!(first_owner.id(), &first);
        assert_eq!(first_owner.credential().unwrap(), "secret-one");
        assert!(capture_database_work().is_err());
        assert!(tauri::async_runtime::block_on(native_db_validate_cache()).is_err());
        tauri::async_runtime::block_on(native_db_recreate_cache()).unwrap();
        assert!(std::sync::Arc::ptr_eq(
            &first_owner,
            &active_login().unwrap()
        ));
        assert!(capture_database_work().is_ok());
        tauri::async_runtime::block_on(native_db_validate_cache()).unwrap();
        preferences
            .with_database(|conn| {
                // Logout: the lifecycle records cleaning ownership, the cache file stays on disk.
                SessionStore::begin_cleaning(conn, &first).unwrap();
                SessionStore::finish_cleaning(conn).unwrap();
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
        let guard = lifecycle
            .enter(crate::auth_lifecycle::Phase::Login)
            .unwrap();
        let second = LoginSessionId::try_from(
            prepare_fresh_login(preferences_connection().unwrap(), &guard).unwrap(),
        )
        .unwrap();
        drop(guard);
        assert_ne!(first, second);
        assert!(temp.path().join(second.sqlite_filename()).exists());
        let second_owner = login_connection(&second).unwrap();
        assert!(!std::sync::Arc::ptr_eq(&first_owner, &second_owner));
        assert!(first_owner.credential().is_err());
        release_login_connection(&first_owner).unwrap();
        assert!(std::sync::Arc::ptr_eq(
            &second_owner,
            &login_connection(&second).unwrap()
        ));

        // Simulated process shutdown releases the unactivated preparation; nothing durable
        // recorded it, so initialization leaves no active connection.
        second_owner.end().unwrap();
        release_login_connection(&second_owner).unwrap();
        initialize_login_cache().unwrap();
        assert!(login_connections::LOGIN_CONNECTIONS
            .current()
            .unwrap()
            .is_none());

        preferences
            .with_database(|conn| {
                let theme: String = conn
            .query_row(
                "SELECT value_json FROM settings WHERE key='theme'",
                [],
                |row| row.get(0),
            )
            .unwrap();
                assert_eq!(theme, "\"dark\"");
                let state: String = conn
                    .query_row(
                        "SELECT value FROM app_state
                 WHERE key='lifecycleState'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(state, "\"signed-out\"");
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

        // A new process prepares a fresh unactivated session, and authentication retries /
        // QR polling keep reusing that preparation: the same UUID, cache file, and connection.
        let guard = lifecycle
            .enter(crate::auth_lifecycle::Phase::Login)
            .unwrap();
        let second = LoginSessionId::try_from(
            prepare_fresh_login(preferences_connection().unwrap(), &guard).unwrap(),
        )
        .unwrap();

        // Authentication retries and QR polling keep reusing the unactivated preparation: the
        // same UUID, the same cache file, the same physical connection, no retired entries.
        let session_files = |dir: &std::path::Path| -> Vec<String> {
            let mut names: Vec<String> = std::fs::read_dir(dir)
                .unwrap()
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| name == "soms-session.sqlite")
                .collect();
            names.sort();
            names
        };
        let second_owner = login_connection(&second).unwrap();
        let files_at_preparation = session_files(temp.path());
        assert_eq!(files_at_preparation.len(), 1);
        for _ in 0..3 {
            assert_eq!(
                prepare_fresh_login(preferences_connection().unwrap(), &guard).unwrap(),
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
                let record = SessionStore::read(conn)?;
                assert_eq!(
                    record.state,
                    crate::login_session_store::LifecycleState::SignedOut
                );
                assert!(record.active_session().is_none());
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
                SessionStore::activate(conn, &second).unwrap();
                Ok(())
            })
            .unwrap();
        let third = LoginSessionId::try_from(
            prepare_fresh_login(preferences_connection().unwrap(), &guard).unwrap(),
        )
        .unwrap();
        drop(guard);
        assert_ne!(second, third);
        assert!(temp.path().join(third.sqlite_filename()).exists());
        let third_owner = login_connection(&third).unwrap();
        third_owner.end().unwrap();
        release_login_connection(&third_owner).unwrap();

        verify_cold_start_reconciliation(temp.path());
    }

    fn verify_cold_start_reconciliation(directory: &std::path::Path) {
        let preferences = preferences_connection().unwrap();
        let config = r#"{"primary":"https://chat.example.com","secondary":"https://lan.example.com"}"#;
        preferences
            .with_database(|conn| app_state::put(conn, "serverConfig", config))
            .unwrap();

        // The secure-store snapshot is authoritative only at cold start. Both an installed
        // restoring owner and a journal without an owner must be retired on credential loss.
        for install_owner in [true, false] {
            for token in [None, Some(""), Some("residual-token")] {
                let lifecycle = std::sync::Arc::new(crate::auth_lifecycle::AuthLifecycle::default());
                let guard = lifecycle
                    .enter(crate::auth_lifecycle::Phase::Login)
                    .unwrap();
                let id = LoginSessionId::try_from(
                    prepare_fresh_login(preferences, &guard).unwrap(),
                )
                .unwrap();
                drop(guard);
                let owner = login_connection(&id).unwrap();
                preferences
                    .with_database(|conn| SessionStore::activate(conn, &id))
                    .unwrap();
                owner.end().unwrap();
                release_login_connection(&owner).unwrap();
                if install_owner {
                    initialize_login_cache().unwrap();
                }
                let restored = current_login().unwrap();
                let wrong_uuid = "11111111-2222-4d9e-af01-234567890abc";
                assert!(reconcile_cold_start_credential(token.map(|t| (t, wrong_uuid)))
                    .unwrap()
                    .is_none());
                assert!(current_login().unwrap().is_none());
                if let Some(owner) = restored {
                    assert!(owner.begin_activation().is_err());
                }
                preferences
                    .with_database(|conn| {
                        let record = SessionStore::read(conn)?;
                        assert_eq!(
                            record.state,
                            crate::login_session_store::LifecycleState::SignedOut
                        );
                        assert!(record.active_session().is_none());
                        assert!(SessionStore::restore(conn, &id.to_string())?.is_none());
                        Ok(())
                    })
                    .unwrap();
                assert!(!directory.join(id.sqlite_filename()).exists());
                initialize_login_cache().unwrap();
                assert!(current_login().unwrap().is_none());
                // Repeated initialization cannot revive an ended login or lose its cleanup plan.
                assert!(reconcile_cold_start_credential(token.map(|t| (t, wrong_uuid)))
                    .unwrap()
                    .is_none());
                assert_eq!(
                    preferences
                        .with_database(|conn| app_state::get(conn, "serverConfig"))
                        .unwrap()
                        .as_deref(),
                    Some(config)
                );
                let state = crate::ServerSessionState::new();
                crate::server_setup::restore(&state).unwrap();
                assert_eq!(
                    *state.api_origin_primary.lock().unwrap(),
                    "https://chat.example.com"
                );
                assert_eq!(
                    state.api_origin_secondary.lock().unwrap().as_deref(),
                    Some("https://lan.example.com")
                );
            }
        }

        let lifecycle = std::sync::Arc::new(crate::auth_lifecycle::AuthLifecycle::default());
        let guard = lifecycle
            .enter(crate::auth_lifecycle::Phase::Login)
            .unwrap();
        let id = LoginSessionId::try_from(prepare_fresh_login(preferences, &guard).unwrap()).unwrap();
        drop(guard);
        let owner = login_connection(&id).unwrap();
        preferences
            .with_database(|conn| SessionStore::activate(conn, &id))
            .unwrap();
        owner.end().unwrap();
        release_login_connection(&owner).unwrap();
        // A valid journal without an owner is not credential loss or a bootstrap error.
        assert!(reconcile_cold_start_credential(Some(("secret", &id.to_string())))
            .unwrap()
            .is_none());
        preferences
            .with_database(|conn| {
                assert_eq!(SessionStore::restore(conn, &id.to_string())?, Some(id.clone()));
                Ok(())
            })
            .unwrap();
        initialize_login_cache().unwrap();
        let owner = current_login().unwrap().unwrap();

        // Inject a database read failure without changing the durable journal. Retrying must
        // activate the same owner, not discover a login ended by a failed validation attempt.
        preferences.with_database(|conn| {
            conn.execute_batch("CREATE TEMP VIEW app_state AS SELECT * FROM unavailable_preferences;")
                .map_err(|e| e.to_string())
        }).unwrap();
        assert!(reconcile_cold_start_credential(Some(("secret", &id.to_string()))).is_err());
        preferences
            .with_database(|conn| {
                conn.execute_batch("DROP VIEW temp.app_state;")
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        // An in-progress activation is likewise retryable, not a rejected credential.
        let activation = owner.begin_activation().unwrap();
        assert!(reconcile_cold_start_credential(Some(("secret", &id.to_string()))).is_err());
        drop(activation);
        let restored = reconcile_cold_start_credential(Some(("secret", &id.to_string())))
            .unwrap()
            .unwrap();
        assert!(std::sync::Arc::ptr_eq(&owner, &restored));
        assert!(restored.assert_active().is_ok());
        assert_eq!(restored.credential().unwrap(), "secret");
        // Ordinary restoration probes must still not invalidate an already active runtime.
        assert!(restore_login_credential("residual-token", "11111111-2222-4d9e-af01-234567890abc")
            .unwrap()
            .is_none());
        assert!(owner.assert_active().is_ok());
        preferences
            .with_database(|conn| SessionStore::begin_cleaning(conn, &id))
            .unwrap();
        assert!(reconcile_cold_start_credential(Some(("secret", &id.to_string())))
            .unwrap()
            .is_none());
        preferences
            .with_database(|conn| {
                assert_eq!(
                    SessionStore::read(conn)?.state,
                    crate::login_session_store::LifecycleState::SignedOut
                );
                Ok(())
            })
            .unwrap();
        end_login_durable(&id).unwrap();
        preferences
            .with_database(|conn| {
                conn.execute("DELETE FROM app_state WHERE key='serverConfig'", [])
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            })
            .unwrap();
    }

    #[test]
    fn forced_teardown_ends_the_matching_login_before_the_storage_lane_clears() {
        let _filesystem = FILESYSTEM_TEST_LOCK.lock().unwrap();
        let _temp = shared_test_location();

        // An admitted login with a durable journal, as a running native session has. The
        // journal records activation before the owner commits its credential.
        let lifecycle = std::sync::Arc::new(crate::auth_lifecycle::AuthLifecycle::default());
        let guard = lifecycle
            .enter(crate::auth_lifecycle::Phase::Login)
            .unwrap();
        let uuid = prepare_fresh_login(preferences_connection().unwrap(), &guard).unwrap();
        drop(guard);
        let id = LoginSessionId::try_from(uuid).unwrap();
        let owner = login_connection(&id).unwrap();
        preferences_connection()
            .unwrap()
            .with_database(|conn| SessionStore::activate(conn, &id))
            .unwrap();
        owner
            .begin_activation()
            .unwrap()
            .commit("secret".into())
            .unwrap();

        // The adapter's forced-teardown ordering (FORCE_LOGOUT): a matching UUID ends the
        // durable login first — epoch, journal, slot — so the storage lane's gated clear then
        // succeeds instead of refusing an admitted login and stranding a revoked credential.
        end_current_login_if_matching(&id).unwrap();
        assert!(owner.assert_active().is_err());
        assert!(login_connections::LOGIN_CONNECTIONS
            .current()
            .unwrap()
            .is_none());
        preferences_connection()
            .unwrap()
            .with_database(|conn| {
                let record = SessionStore::read(conn)?;
                assert_eq!(
                    record.state,
                    crate::login_session_store::LifecycleState::SignedOut
                );
                assert_eq!(record.active_session(), None);
                Ok(())
            })
            .unwrap();
        crate::credential_storage::clear(|| Ok(())).unwrap();

        // A stale business completion must not end the successor's runtime owner.
        let guard = lifecycle
            .enter(crate::auth_lifecycle::Phase::Login)
            .unwrap();
        let successor_uuid = prepare_fresh_login(preferences_connection().unwrap(), &guard).unwrap();
        drop(guard);
        let successor = LoginSessionId::try_from(successor_uuid).unwrap();
        let successor_owner = login_connection(&successor).unwrap();
        preferences_connection()
            .unwrap()
            .with_database(|conn| SessionStore::activate(conn, &successor))
            .unwrap();
        successor_owner
            .begin_activation()
            .unwrap()
            .commit("next".into())
            .unwrap();
        end_current_login_if_matching(&id).unwrap(); // mismatched UUID: deliberate no-op
        assert!(successor_owner.assert_active().is_ok());
        preferences_connection()
            .unwrap()
            .with_database(|conn| {
                assert_eq!(SessionStore::read(conn)?.active_session(), Some(&successor));
                Ok(())
            })
            .unwrap();
        end_current_login_if_matching(&successor).unwrap();
        assert!(successor_owner.assert_active().is_err());

        // Leave the current lifecycle signed out and remove test session caches.
        for entry in std::fs::read_dir(_temp.path()).unwrap() {
            let path = entry.unwrap().path();
            let is_session_cache = path
                .file_name()
                .map(|name| name.to_string_lossy() == "soms-session.sqlite")
                .unwrap_or(false);
            if is_session_cache {
                std::fs::remove_file(&path).unwrap();
            }
        }
    }
}
