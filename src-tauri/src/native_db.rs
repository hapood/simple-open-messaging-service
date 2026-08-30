use rusqlite::{
    params, Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeSet, path::PathBuf};
use tauri::Manager;

use crate::{perform_api_request, ProxyState};

const DB_FILENAME: &str = "soms-local.sqlite3";
const CACHE_SCHEMA_VERSION: i64 = 13;

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
        "users",
        "groups",
        "members",
        "friend_requests",
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
        "friend_requests_direction_status",
        "users_address",
        "users_id",
        "groups_id",
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
        CREATE TABLE IF NOT EXISTS users (
          user_id INTEGER NOT NULL,
          account TEXT NOT NULL,
          domain TEXT NOT NULL,
          source_domain TEXT NOT NULL,
          namespace_id INTEGER NOT NULL,
          surrogate_id INTEGER,
          payload_json TEXT NOT NULL,
          profile_rev INTEGER NOT NULL,
          PRIMARY KEY (user_id, account, domain, source_domain, namespace_id),
          FOREIGN KEY (user_id, source_domain, namespace_id)
            REFERENCES namespaces(user_id, domain, namespace_id)
        );
        CREATE INDEX IF NOT EXISTS users_address
          ON users(user_id, account, domain, namespace_id);
        CREATE INDEX IF NOT EXISTS users_id
          ON users(user_id, surrogate_id) WHERE surrogate_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS groups (
          user_id INTEGER NOT NULL,
          account TEXT NOT NULL,
          domain TEXT NOT NULL,
          namespace_id INTEGER NOT NULL,
          surrogate_id INTEGER,
          payload_json TEXT NOT NULL,
          profile_rev INTEGER NOT NULL,
          PRIMARY KEY (user_id, account, domain, namespace_id),
          FOREIGN KEY (user_id, domain, namespace_id)
            REFERENCES namespaces(user_id, domain, namespace_id)
        );
        CREATE INDEX IF NOT EXISTS groups_id
          ON groups(user_id, surrogate_id) WHERE surrogate_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS members (
          user_id INTEGER NOT NULL,
          thread_id INTEGER NOT NULL,
          member_account TEXT NOT NULL,
          member_domain TEXT NOT NULL,
          source_domain TEXT NOT NULL,
          namespace_id INTEGER NOT NULL,
          role TEXT NOT NULL,
          left_state INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (user_id, thread_id, member_account, member_domain, source_domain, namespace_id),
          FOREIGN KEY (user_id, source_domain, namespace_id)
            REFERENCES namespaces(user_id, domain, namespace_id)
        );
        CREATE INDEX IF NOT EXISTS members_thread
          ON members(user_id, thread_id, left_state, namespace_id, source_domain, member_domain, member_account);
        CREATE INDEX IF NOT EXISTS members_search
          ON members(user_id, thread_id, member_account, member_domain, source_domain, namespace_id);
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
        CREATE TRIGGER IF NOT EXISTS users_namespace_before_insert
        BEFORE INSERT ON users BEGIN
          UPDATE namespaces SET status='ARCHIVED'
          WHERE user_id=NEW.user_id AND domain=NEW.source_domain
            AND namespace_id<NEW.namespace_id;
          INSERT OR IGNORE INTO namespaces(user_id,namespace_id,domain,status)
          VALUES(NEW.user_id,NEW.namespace_id,NEW.source_domain,
            CASE WHEN NEW.namespace_id=0 OR NOT EXISTS(
              SELECT 1 FROM namespaces WHERE user_id=NEW.user_id
                AND domain=NEW.source_domain AND namespace_id>NEW.namespace_id
            ) THEN 'ACTIVE' ELSE 'ARCHIVED' END);
        END;
        CREATE TRIGGER IF NOT EXISTS groups_namespace_before_insert
        BEFORE INSERT ON groups BEGIN
          UPDATE namespaces SET status='ARCHIVED'
          WHERE user_id=NEW.user_id AND domain=NEW.domain
            AND namespace_id<NEW.namespace_id;
          INSERT OR IGNORE INTO namespaces(user_id,namespace_id,domain,status)
          VALUES(NEW.user_id,NEW.namespace_id,NEW.domain,
            CASE WHEN NEW.namespace_id=0 OR NOT EXISTS(
              SELECT 1 FROM namespaces WHERE user_id=NEW.user_id
                AND domain=NEW.domain AND namespace_id>NEW.namespace_id
            ) THEN 'ACTIVE' ELSE 'ARCHIVED' END);
        END;
        CREATE TRIGGER IF NOT EXISTS members_namespace_before_insert
        BEFORE INSERT ON members BEGIN
          UPDATE namespaces SET status='ARCHIVED'
          WHERE user_id=NEW.user_id AND domain=NEW.source_domain
            AND namespace_id<NEW.namespace_id;
          INSERT OR IGNORE INTO namespaces(user_id,namespace_id,domain,status)
          VALUES(NEW.user_id,NEW.namespace_id,NEW.source_domain,
            CASE WHEN NEW.namespace_id=0 OR NOT EXISTS(
              SELECT 1 FROM namespaces WHERE user_id=NEW.user_id
                AND domain=NEW.source_domain AND namespace_id>NEW.namespace_id
            ) THEN 'ACTIVE' ELSE 'ARCHIVED' END);
        END;
        CREATE TABLE IF NOT EXISTS friend_requests (
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
        CREATE INDEX IF NOT EXISTS friend_requests_direction_status
          ON friend_requests(
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

fn save_request_projection(
    tx: &Transaction<'_>,
    user_id: i64,
    key: &str,
    payload: &Value,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO friend_requests(user_id, stable_key, payload_json) VALUES(?1, ?2, ?3)
         ON CONFLICT(user_id, stable_key) DO UPDATE SET payload_json=excluded.payload_json",
        params![user_id, key, json_text(payload)?],
    )
    .map_err(|e| format!("save friend-request projection: {e}"))?;
    Ok(())
}

fn intent_is_effective(value: Option<&Value>, now: i64) -> bool {
    match value
        .and_then(|intent| intent.get("status"))
        .and_then(Value::as_str)
    {
        Some("ACCEPTED") => true,
        Some("REQUESTED") => value
            .and_then(|intent| intent.get("expiresAt"))
            .and_then(Value::as_i64)
            .is_some_and(|expires_at| expires_at > now),
        _ => false,
    }
}

fn relationship_intent_key(
    namespace_id: i64,
    account: &str,
    domain: &str,
    subject_account: &str,
    subject_domain: &str,
) -> String {
    format!("{namespace_id}\0{domain}\0{account}->{subject_domain}\0{subject_account}")
}

fn apply_relationship_intent_fact(
    tx: &Transaction<'_>,
    user_id: i64,
    namespace_id: i64,
    account: &str,
    domain: &str,
    subject_account: &str,
    subject_domain: &str,
    body: &Value,
) -> Result<bool, String> {
    let now = chrono_millis();
    let status = body
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| "relationship intent has no status".to_string())?;
    let expires_at = body.get("expiresAt").and_then(Value::as_i64);
    let key = relationship_intent_key(
        namespace_id,
        account,
        domain,
        subject_account,
        subject_domain,
    );
    let reverse_key = relationship_intent_key(
        namespace_id,
        subject_account,
        subject_domain,
        account,
        domain,
    );
    let fact = serde_json::json!({
        "status": status,
        "expiresAt": expires_at,
        "localThreadId": body.get("localThreadId")
            .or_else(|| body.get("threadId"))
            .cloned()
            .unwrap_or(Value::Null),
        "updatedAt": now,
    });
    tx.execute(
        "INSERT INTO relationship_intents(user_id,stable_key,reverse_key,payload_json)
             VALUES(?1,?2,?3,?4)
             ON CONFLICT(user_id,stable_key) DO UPDATE SET
               reverse_key=excluded.reverse_key,payload_json=excluded.payload_json",
        params![user_id, key, reverse_key, json_text(&fact)?],
    )
    .map_err(|e| format!("save relationship intent fact: {e}"))?;
    let read_fact = |fact_key: &str| -> Result<Option<Value>, String> {
        tx.query_row(
            "SELECT payload_json FROM relationship_intents WHERE user_id=?1 AND stable_key=?2",
            params![user_id, fact_key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("read relationship intent fact: {e}"))?
        .map(parse_json)
        .transpose()
    };
    let first = read_fact(&key)?;
    let second = read_fact(&reverse_key)?;
    Ok(intent_is_effective(first.as_ref(), now)
        && intent_is_effective(second.as_ref(), now)
        && [first.as_ref(), second.as_ref()]
            .into_iter()
            .flatten()
            .any(|fact| fact.get("status").and_then(Value::as_str) == Some("ACCEPTED")))
}

fn update_live_request_projection(
    tx: &Transaction<'_>,
    user_id: i64,
    key: &str,
    status: &str,
    now: i64,
) -> Result<(), String> {
    let current: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM friend_requests WHERE user_id=?1 AND stable_key=?2",
            params![user_id, key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("read request projection effect target: {e}"))?;
    let Some(mut projection) = current.map(parse_json).transpose()? else {
        return Ok(());
    };
    if projection.get("status").and_then(Value::as_str) != Some("REQUESTED")
        || !projection
            .get("expiresAt")
            .and_then(Value::as_i64)
            .is_some_and(|expires_at| expires_at > now)
    {
        return Ok(());
    }
    projection["status"] = Value::String(status.into());
    projection["updatedAt"] = Value::from(now);
    save_request_projection(tx, user_id, key, &projection)
}

fn apply_friend_request_effect(
    tx: &Transaction<'_>,
    user_id: i64,
    revision: i64,
    namespace_id: i64,
    account: &str,
    domain: &str,
    subject_account: &str,
    subject_domain: &str,
    body: &Value,
) -> Result<(), String> {
    let now = chrono_millis();
    let status = body.get("status").and_then(Value::as_str).unwrap_or("");
    let direction = body.get("direction").and_then(Value::as_str).unwrap_or("");
    if status == "ACCEPTED" && direction == "OUTGOING" {
        return Ok(());
    }
    let reverse = status == "ACCEPTED";
    let authored = if reverse {
        relationship_intent_key(
            namespace_id,
            subject_account,
            subject_domain,
            account,
            domain,
        )
    } else {
        relationship_intent_key(
            namespace_id,
            account,
            domain,
            subject_account,
            subject_domain,
        )
    };
    let key = format!(
        "friend:{namespace_id}:{}",
        json_text(&Value::String(authored))?
    );
    if status != "REQUESTED" {
        return update_live_request_projection(tx, user_id, &key, status, now);
    }
    let requested_at = body.get("requestedAt").and_then(Value::as_i64).unwrap_or(0);
    let Some(expires_at) = body
        .get("expiresAt")
        .and_then(Value::as_i64)
        .map(|value| value.min(requested_at.saturating_add(604_800_000)))
        .filter(|value| *value > now)
    else {
        return Ok(());
    };
    let prior_actionable: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM friend_requests
             WHERE user_id=?1 AND stable_key=?2
               AND json_extract(payload_json,'$.status')='REQUESTED')",
            params![user_id, key],
            |row| row.get(0),
        )
        .map_err(|e| format!("read request projection actionability: {e}"))?;
    let mut peer = body.get("peer").cloned().unwrap_or(Value::Null);
    if let Some(peer_object) = peer.as_object_mut() {
        let peer_namespace_id =
            if peer_object.get("domain").and_then(Value::as_str) == Some("local") {
                0
            } else {
                namespace_id
            };
        peer_object.insert("namespaceId".into(), Value::from(peer_namespace_id));
    }
    let projection = serde_json::json!({
        "key": key,
        "namespaceId": namespace_id,
        "kind": "FRIEND",
        "bucket": if direction == "INCOMING" { "RECEIVED" } else { "SENT" },
        "direction": direction,
        "status": "REQUESTED",
        "expiresAt": expires_at,
        "localThreadId": body.get("localThreadId").cloned().unwrap_or(Value::Null),
        "inviteId": body.get("inviteId").cloned().unwrap_or(Value::Null),
        "note": body.get("note").cloned().unwrap_or(Value::String(String::new())),
        "requestedAt": requested_at,
        "peer": peer,
        "requestedSort": requested_at,
        "updatedAt": now,
    });
    save_request_projection(tx, user_id, &key, &projection)?;
    if direction == "INCOMING" && !prior_actionable {
        tx.execute(
            "INSERT INTO sync_state(user_id,key,value_json) VALUES(?1,'friendRequestStateRevision',?2)
             ON CONFLICT(user_id,key) DO UPDATE SET value_json=excluded.value_json",
            params![user_id, revision.to_string()],
        )
        .map_err(|e| format!("save friend-request unread revision: {e}"))?;
    }
    Ok(())
}

fn apply_group_request_effect(
    tx: &Transaction<'_>,
    user_id: i64,
    revision: i64,
    namespace_id: i64,
    group_account: &str,
    group_domain: &str,
    direction: &str,
    body: &Value,
) -> Result<(), String> {
    let now = chrono_millis();
    let status = body.get("status").and_then(Value::as_str).unwrap_or("");
    if status == "ACCEPTED" && direction == "OUTGOING" {
        return Ok(());
    }
    let target_direction = if status == "ACCEPTED" {
        "OUTGOING"
    } else {
        direction
    };
    let key = format!("group:{namespace_id}:{group_domain}\0{group_account}:{target_direction}");
    if status != "REQUESTED" {
        return update_live_request_projection(tx, user_id, &key, status, now);
    }
    let requested_at = body.get("requestedAt").and_then(Value::as_i64).unwrap_or(0);
    let Some(expires_at) = body
        .get("expiresAt")
        .and_then(Value::as_i64)
        .map(|value| value.min(requested_at.saturating_add(604_800_000)))
        .filter(|value| *value > now)
    else {
        return Ok(());
    };
    let mut group = body.get("group").cloned().unwrap_or(Value::Null);
    if let Some(group_object) = group.as_object_mut() {
        let group_namespace_id = if group_domain == "local" {
            0
        } else {
            namespace_id
        };
        group_object.insert("namespaceId".into(), Value::from(group_namespace_id));
    }
    let projection = serde_json::json!({
        "key": key,
        "namespaceId": namespace_id,
        "kind": "GROUP",
        "bucket": if direction == "INCOMING" { "RECEIVED" } else { "SENT" },
        "direction": direction,
        "status": "REQUESTED",
        "expiresAt": expires_at,
        "localThreadId": body.get("threadId").cloned().unwrap_or(Value::Null),
        "inviteId": group_account,
        "note": body.get("note").cloned().unwrap_or(Value::String(String::new())),
        "requestedAt": requested_at,
        "group": group,
        "sourceLabel": if body.get("group").and_then(|group| group.get("isLocal")).and_then(Value::as_bool) == Some(true) { "local" } else { group_domain },
        "requestedSort": requested_at,
        "updatedAt": now,
    });
    let prior_actionable: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM friend_requests
             WHERE user_id=?1 AND stable_key=?2
               AND json_extract(payload_json,'$.status')='REQUESTED')",
            params![user_id, key],
            |row| row.get(0),
        )
        .map_err(|e| format!("read group request projection actionability: {e}"))?;
    save_request_projection(tx, user_id, &key, &projection)?;
    if direction == "INCOMING" && !prior_actionable {
        tx.execute(
            "INSERT INTO sync_state(user_id,key,value_json) VALUES(?1,'friendRequestStateRevision',?2)
             ON CONFLICT(user_id,key) DO UPDATE SET value_json=excluded.value_json",
            params![user_id, revision.to_string()],
        )
        .map_err(|e| format!("save group-request unread revision: {e}"))?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientStateFeedItem {
    feed_id: Option<i64>,
    account: Option<String>,
    domain: Option<String>,
    namespace_id: i64,
    event_type: Option<String>,
    subject_account: Option<String>,
    subject_domain: Option<String>,
    body: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientGroupMetaApply {
    thread_id: i64,
    source_server: String,
    namespace_id: i64,
    page: ClientGroupMetaPage,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientGroupMetaPage {
    mode: String,
    items: Vec<ClientGroupMetaItem>,
    scanned_through: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientGroupMetaItem {
    account: String,
    domain: String,
    namespace_id: i64,
    operation: String,
    body: Value,
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

fn materialize_group_thread_from_fact(
    tx: &Transaction<'_>,
    user_id: i64,
    group_account: &str,
    group_domain: &str,
    namespace_id: i64,
    body: &Value,
    active: bool,
) -> Result<(), String> {
    if !active {
        return Ok(());
    }
    let Some(thread_id) = body.get("threadId").and_then(Value::as_i64) else {
        return Ok(());
    };
    let group = body.get("group").cloned().unwrap_or(Value::Null);
    let group_object = group.as_object().cloned().unwrap_or_default();
    let group_namespace_id = if group_domain == "local" {
        0
    } else {
        namespace_id
    };
    let thread = serde_json::json!({
        "threadId": thread_id, "authorityNamespaceId": group_namespace_id,
        "type": "GROUP", "role": null,
        "lastMessageAt": null, "lastMessageSeq": null, "muted": false,
        "blocked": false, "pinned": false, "pinnedAt": null,
        "clearedSeq": null, "alias": null, "conversationState": "ACTIVE",
        "lastReadSeq": null, "unreadCount": 0, "mentionUnread": [],
        "lastMessagePreview": null, "lastMessageSenderId": null,
        "group": {
            "id": thread_id,
            "account": group_object.get("account").cloned().unwrap_or(Value::String(group_account.into())),
            "name": group_object.get("name").cloned().unwrap_or(Value::String(group_account.into())),
            "ownerId": 0,
            "avatar": group_object.get("avatar").cloned().unwrap_or(Value::String(String::new())),
            "description": group_object.get("description").cloned().unwrap_or(Value::String(String::new())),
            "domain": group_object.get("domain").cloned().unwrap_or(Value::String(group_domain.into())),
            "namespaceId": group_namespace_id,
            "threadId": thread_id, "createdAt": 0, "updatedAt": 0,
            "profileRev": group_object.get("profileRev").cloned().unwrap_or(Value::from(0)),
            "dissolvedAt": null, "memberCount": 0, "groupMetaFeedId": "0"
        }
    });
    tx.execute(
        "INSERT INTO threads(user_id,thread_id,payload_json) VALUES(?1,?2,?3)
         ON CONFLICT(user_id,thread_id) DO NOTHING",
        params![user_id, thread_id, json_text(&thread)?],
    )
    .map_err(|e| format!("materialize group thread from relationship facts: {e}"))?;
    Ok(())
}

fn apply_friend_thread_from_facts(
    tx: &Transaction<'_>,
    user_id: i64,
    namespace_id: i64,
    body: &Value,
    active: bool,
) -> Result<(), String> {
    let Some(thread_id) = body.get("localThreadId").and_then(Value::as_i64) else {
        return Ok(());
    };
    let existing: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM threads WHERE user_id=?1 AND thread_id=?2",
            params![user_id, thread_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("read friend thread projection: {e}"))?;
    if let Some(existing) = existing {
        let mut thread = parse_json(existing)?;
        if thread.get("type").and_then(Value::as_str) == Some("P2P") {
            thread["friendshipActive"] = Value::Bool(active);
            thread["conversationState"] =
                Value::String(if active { "ACTIVE" } else { "READ_ONLY" }.into());
            if let Some(peer) = body.get("peer") {
                let mut peer = peer.clone();
                if let Some(peer_object) = peer.as_object_mut() {
                    let peer_namespace_id =
                        if peer_object.get("domain").and_then(Value::as_str) == Some("local") {
                            0
                        } else {
                            namespace_id
                        };
                    peer_object.insert("namespaceId".into(), Value::from(peer_namespace_id));
                }
                thread["peerUser"] = peer;
            }
            tx.execute(
                "UPDATE threads SET payload_json=?3 WHERE user_id=?1 AND thread_id=?2",
                params![user_id, thread_id, json_text(&thread)?],
            )
            .map_err(|e| format!("update friend thread from relationship facts: {e}"))?;
        }
    } else if active {
        let mut peer = body.get("peer").cloned().unwrap_or(Value::Null);
        if let Some(peer) = peer.as_object_mut() {
            let peer_namespace_id = if peer.get("domain").and_then(Value::as_str) == Some("local") {
                0
            } else {
                namespace_id
            };
            peer.insert("namespaceId".into(), Value::from(peer_namespace_id));
            peer.entry("isGroup").or_insert(Value::Bool(false));
            peer.entry("profileRev").or_insert(Value::from(0));
            peer.entry("createdAt").or_insert(Value::from(0));
            peer.entry("updatedAt").or_insert(Value::from(0));
            peer.entry("isDeleted").or_insert(Value::Bool(false));
        }
        let thread = serde_json::json!({
            "threadId": thread_id, "authorityNamespaceId": peer.get("namespaceId").cloned().unwrap_or(Value::from(0)),
            "type": "P2P", "role": null,
            "lastMessageAt": null, "lastMessageSeq": null, "muted": false,
            "blocked": false, "pinned": false, "pinnedAt": null,
            "clearedSeq": null, "alias": null, "peerUser": peer,
            "friendshipActive": true, "conversationState": "ACTIVE",
            "lastReadSeq": null, "unreadCount": 0, "mentionUnread": [],
            "lastMessagePreview": null, "lastMessageSenderId": null,
        });
        tx.execute(
            "INSERT INTO threads(user_id,thread_id,payload_json) VALUES(?1,?2,?3)",
            params![user_id, thread_id, json_text(&thread)?],
        )
        .map_err(|e| format!("insert friend thread from relationship facts: {e}"))?;
    }
    Ok(())
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
pub(crate) async fn native_db_namespaces(
    app: tauri::AppHandle,
    user_id: i64,
) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        let mut stmt = conn
            .prepare(
                "SELECT domain,namespace_id,status
                 FROM namespaces WHERE user_id=?1 ORDER BY domain,namespace_id",
            )
            .map_err(|e| format!("prepare namespace read: {e}"))?;
        let rows = stmt
            .query_map([user_id], |row| {
                Ok(serde_json::json!({
                    "domain": row.get::<_, String>(0)?,
                    "namespaceId": row.get::<_, i64>(1)?,
                    "status": row.get::<_, String>(2)?,
                }))
            })
            .map_err(|e| format!("query namespaces: {e}"))?;
        rows.map(|row| row.map_err(|e| format!("read namespace: {e}")))
            .collect()
    })
    .await
    .map_err(|e| format!("join namespace read: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_archive_namespace(
    app: tauri::AppHandle,
    user_id: i64,
    domain: String,
    namespace_id: i64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if namespace_id == 0 {
            return Ok(());
        }
        let mut conn = open(&app)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("begin namespace archive: {e}"))?;
        tx.execute(
            "UPDATE namespaces SET status='ARCHIVED'
             WHERE user_id=?1 AND domain=?2 AND namespace_id=?3",
            params![user_id, domain, namespace_id],
        )
        .map_err(|e| format!("archive namespace: {e}"))?;
        tx.commit()
            .map_err(|e| format!("commit namespace archive: {e}"))
    })
    .await
    .map_err(|e| format!("join namespace archive: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_list_friend_requests(
    app: tauri::AppHandle,
    user_id: i64,
) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        let mut stmt = conn
            .prepare("SELECT payload_json FROM friend_requests WHERE user_id = ?1")
            .map_err(|e| format!("prepare friend-request read: {e}"))?;
        let rows = stmt
            .query_map([user_id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("query friend intents: {e}"))?;
        rows.map(|row| {
            row.map_err(|e| format!("read friend intent: {e}"))
                .and_then(parse_json)
        })
        .collect()
    })
    .await
    .map_err(|e| format!("join friend-intent read: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_page_friend_requests(
    app: tauri::AppHandle,
    user_id: i64,
    bucket: String,
    cursor: Option<String>,
    take: i64,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        let parsed_cursor = cursor
            .as_deref()
            .map(serde_json::from_str::<Value>)
            .transpose()
            .map_err(|e| format!("parse friend-intent cursor: {e}"))?;
        let cursor_time = parsed_cursor
            .as_ref()
            .and_then(|value| value.get(0))
            .and_then(Value::as_i64)
            .unwrap_or(i64::MAX);
        let cursor_key = parsed_cursor
            .as_ref()
            .and_then(|value| value.get(1))
            .and_then(Value::as_str)
            .unwrap_or("\u{10ffff}");
        let mut stmt = conn
            .prepare(
                "SELECT payload_json FROM friend_requests
                 WHERE user_id = ?1
                   AND json_extract(payload_json, '$.bucket') = ?2
                   AND json_extract(payload_json, '$.status') IN ('REQUESTED','ACCEPTED','REVOKED')
                   AND (?3 = 0 OR CAST(json_extract(payload_json, '$.requestedSort') AS INTEGER) < ?4
                     OR (CAST(json_extract(payload_json, '$.requestedSort') AS INTEGER) = ?4
                       AND stable_key < ?5))
                 ORDER BY CAST(json_extract(payload_json, '$.requestedSort') AS INTEGER) DESC,
                          stable_key DESC
                 LIMIT ?6",
            )
            .map_err(|e| format!("prepare paged friend-intent read: {e}"))?;
        let rows = stmt
            .query_map(
                params![
                    user_id,
                    bucket,
                    if parsed_cursor.is_some() { 1 } else { 0 },
                    cursor_time,
                    cursor_key,
                    take.clamp(1, 100)
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(|e| format!("query paged friend intents: {e}"))?;
        let items = rows
            .map(|row| {
                row.map_err(|e| format!("read paged friend intent: {e}"))
                    .and_then(parse_json)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let total = conn
            .query_row(
                "SELECT COUNT(*) FROM friend_requests
                 WHERE user_id = ?1
                   AND json_extract(payload_json, '$.bucket') = ?2
                   AND json_extract(payload_json, '$.status') IN ('REQUESTED','ACCEPTED','REVOKED')",
                params![user_id, bucket],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| format!("count friend intents: {e}"))?;
        let actionable_total = conn
            .query_row(
                "SELECT COUNT(*) FROM friend_requests
                 WHERE user_id = ?1
                   AND json_extract(payload_json, '$.bucket') = ?2
                   AND json_extract(payload_json, '$.status') = 'REQUESTED'",
                params![user_id, bucket],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| format!("count actionable friend requests: {e}"))?;
        Ok(serde_json::json!({ "items": items, "total": total, "actionableTotal": actionable_total }))
    })
    .await
    .map_err(|e| format!("join paged friend-intent read: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_mark_friend_request_accepted(
    app: tauri::AppHandle,
    user_id: i64,
    key: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open(&app)?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("begin friend-request projection update: {e}"))?;
        update_live_request_projection(&tx, user_id, &key, "ACCEPTED", chrono_millis())?;
        tx.commit()
            .map_err(|e| format!("commit friend-request projection update: {e}"))
    })
    .await
    .map_err(|e| format!("join friend-request projection update: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_cleanup_friend_requests(
    app: tauri::AppHandle,
    user_id: i64,
    now: i64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        cleanup_friend_requests(&conn, user_id, now)
    })
    .await
    .map_err(|e| format!("join friend-request cleanup: {e}"))?
}

fn cleanup_friend_requests(conn: &Connection, user_id: i64, now: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM friend_requests
             WHERE user_id=?1
               AND CAST(json_extract(payload_json, '$.updatedAt') AS INTEGER) <= ?2 - 604800000",
        params![user_id, now],
    )
    .map_err(|e| format!("cleanup expired friend requests: {e}"))?;
    Ok(())
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
pub(crate) async fn native_db_apply_state_feed_page(
    app: tauri::AppHandle,
    user_id: i64,
    feed_id: i64,
    items: Vec<ClientStateFeedItem>,
    group_meta: Vec<ClientGroupMetaApply>,
    reset_projection: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open(&app)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("begin state-feed page: {e}"))?;
        if reset_projection {
            tx.execute("DELETE FROM friend_requests WHERE user_id=?1", [user_id])
                .map_err(|e| format!("clear state-feed friend requests: {e}"))?;
            tx.execute("DELETE FROM relationship_intents WHERE user_id=?1", [user_id])
                .map_err(|e| format!("clear state-feed relationship intents: {e}"))?;
            tx.execute("DELETE FROM members WHERE user_id=?1", [user_id])
                .map_err(|e| format!("clear state-feed members: {e}"))?;
            let mut statement = tx
                .prepare(
                    "SELECT thread_id,payload_json FROM threads
                     WHERE user_id=?1",
                )
                .map_err(|e| format!("prepare state-feed thread reset: {e}"))?;
            let rows = statement
                .query_map([user_id], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| format!("read state-feed threads for reset: {e}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("collect state-feed threads for reset: {e}"))?;
            drop(statement);
            for (thread_id, payload) in rows {
                let mut thread = parse_json(payload)?;
                if let Some(object) = thread.as_object_mut() {
                    object.insert("blocked".into(), Value::Bool(false));
                    if object.get("type").and_then(Value::as_str) == Some("P2P") {
                        object.insert("friendshipActive".into(), Value::Bool(false));
                        object.insert(
                            "conversationState".into(),
                            Value::String("READ_ONLY".into()),
                        );
                    }
                }
                tx.execute(
                    "UPDATE threads SET payload_json=?3 WHERE user_id=?1 AND thread_id=?2",
                    params![user_id, thread_id, json_text(&thread)?],
                )
                .map_err(|e| format!("reset state-feed thread projection: {e}"))?;
            }
        }
        for op in &items {
            if op.event_type.as_deref() != Some("RELATIONSHIP_INTENT") {
                continue;
            }
            let account = op.account.as_deref().unwrap_or("");
            let subject_account = op.subject_account.as_deref().unwrap_or("");
            let body = op
                .body
                .as_ref()
                .ok_or_else(|| "relationship intent has no body".to_string())?;
            let active = apply_relationship_intent_fact(
                &tx,
                user_id,
                op.namespace_id,
                account,
                op.domain.as_deref().unwrap_or(""),
                subject_account,
                op.subject_domain.as_deref().unwrap_or(""),
                body,
            )?;
            if account.starts_with('!') || subject_account.starts_with('!') {
                let group_authored = account.starts_with('!');
                let (group_account, group_domain, direction) = if group_authored {
                    (account, op.domain.as_deref().unwrap_or(""), "INCOMING")
                } else {
                    (subject_account, op.subject_domain.as_deref().unwrap_or(""), "OUTGOING")
                };
                apply_group_request_effect(
                    &tx,
                    user_id,
                    op.feed_id.ok_or_else(|| "state-feed item has no feedId".to_string())?,
                    op.namespace_id,
                    group_account,
                    group_domain,
                    direction,
                    body,
                )?;
                materialize_group_thread_from_fact(
                    &tx,
                    user_id,
                    group_account,
                    group_domain,
                    op.namespace_id,
                    body,
                    active,
                )?;
                if !active {
                    if let Some(thread_id) = body.get("threadId").and_then(Value::as_i64) {
                        tx.execute(
                            "DELETE FROM members WHERE user_id=?1 AND thread_id=?2",
                            params![user_id, thread_id],
                        )
                        .map_err(|e| format!("delete revoked group roster: {e}"))?;
                        tx.execute(
                            "DELETE FROM threads WHERE user_id=?1 AND thread_id=?2",
                            params![user_id, thread_id],
                        )
                        .map_err(|e| format!("delete revoked group thread: {e}"))?;
                    }
                }
            } else {
                apply_friend_request_effect(
                    &tx,
                    user_id,
                    op.feed_id
                        .ok_or_else(|| "state-feed item has no feedId".to_string())?,
                    op.namespace_id,
                    account,
                    op.domain.as_deref().unwrap_or(""),
                    subject_account,
                    op.subject_domain.as_deref().unwrap_or(""),
                    body,
                )?;
                apply_friend_thread_from_facts(
                    &tx,
                    user_id,
                    op.namespace_id,
                    body,
                    active,
                )?;
            }
        }
        for update in group_meta {
            if update.source_server.is_empty() {
                return Err("group-meta sourceServer must be canonical and non-empty".into());
            }
            if update.namespace_id <= 0 {
                return Err("group-meta source namespace must be positive".into());
            }
            if update.page.mode != "full" && update.page.mode != "delta" {
                return Err("group-meta mode must be full or delta".into());
            }
            let source_server = update.source_server;
            let payload: Option<String> = tx.query_row(
                "SELECT payload_json FROM threads WHERE user_id=?1 AND thread_id=?2",
                params![user_id, update.thread_id], |row| row.get(0),
            ).optional().map_err(|e| format!("read group thread: {e}"))?;
            if payload.is_none() {
                continue;
            }
            let mut thread = payload.map(parse_json).transpose()?;
            let now = chrono_millis();
            for item in update.page.items {
                if item.namespace_id < 0 {
                    return Err("group-meta member namespace must be non-negative".into());
                }
                if item.operation == "DEPART" {
                    tx.execute(
                        "UPDATE members SET left_state=1
                         WHERE user_id=?1 AND thread_id=?2 AND member_account=?3
                           AND member_domain=?4 AND source_domain=?5 AND namespace_id=?6",
                        params![user_id, update.thread_id, item.account, item.domain, source_server, item.namespace_id],
                    ).map_err(|e| format!("depart group member: {e}"))?;
                    continue;
                }
                if item.operation != "UPSERT" {
                    return Err("group-meta operation must be UPSERT or DEPART".into());
                }
                let profile_rev = item.body.get("profileRev").and_then(Value::as_i64)
                    .ok_or_else(|| "group-meta UPSERT has no profileRev".to_string())?;
                let profile = serde_json::json!({
                    "account": item.account,
                    "domain": item.domain,
                    "sourceDomain": source_server,
                    "namespaceId": item.namespace_id,
                    "name": item.body.get("displayName").cloned().unwrap_or(Value::String(String::new())),
                    "avatar": item.body.get("avatar").and_then(Value::as_str).unwrap_or(""),
                    "bio": "",
                    "availability": "AVAILABLE",
                    "profileRev": profile_rev,
                    "createdAt": now,
                    "updatedAt": now,
                });
                tx.execute(
                    "INSERT INTO users(user_id,account,domain,source_domain,namespace_id,surrogate_id,payload_json,profile_rev)
                     VALUES(?1,?2,?3,?4,?5,NULL,?6,?7)
                     ON CONFLICT(user_id,account,domain,source_domain,namespace_id) DO UPDATE SET
                       payload_json=excluded.payload_json,profile_rev=excluded.profile_rev
                     WHERE excluded.profile_rev >= users.profile_rev",
                    params![
                        user_id, item.account, item.domain, source_server,
                        item.namespace_id, json_text(&profile)?, profile_rev,
                    ],
                ).map_err(|e| format!("upsert group member user: {e}"))?;
                tx.execute(
                    "INSERT INTO members(
                       user_id,thread_id,member_account,member_domain,source_domain,namespace_id,role,left_state
                     ) VALUES(?1,?2,?3,?4,?5,?6,?7,0)
                     ON CONFLICT(user_id,thread_id,member_account,member_domain,source_domain,namespace_id)
                     DO UPDATE SET role=excluded.role,left_state=0",
                    params![
                        user_id, update.thread_id, item.account, item.domain, source_server,
                        item.namespace_id,
                        item.body.get("role").and_then(Value::as_str).unwrap_or("MEMBER"),
                    ],
                ).map_err(|e| format!("upsert group member: {e}"))?;
            }
            if let Some(mut thread) = thread.take() {
                let self_role: Option<String> = tx.query_row(
                    "SELECT member.role FROM members member
                     JOIN users self_user ON self_user.user_id=member.user_id
                       AND self_user.surrogate_id=member.user_id
                     WHERE member.user_id=?1 AND member.thread_id=?2 AND member.left_state=0
                       AND member.member_account=self_user.account
                       AND member.member_domain=self_user.domain
                       AND member.namespace_id=self_user.namespace_id
                     LIMIT 1",
                    params![user_id, update.thread_id],
                    |row| row.get(0),
                ).optional().map_err(|e| format!("read current group role: {e}"))?;
                let member_count: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM members WHERE user_id=?1 AND thread_id=?2 AND left_state=0",
                    params![user_id, update.thread_id], |row| row.get(0),
                ).map_err(|e| format!("count current group members: {e}"))?;
                if let Some(object) = thread.as_object_mut() {
                    object.insert(
                        "role".into(),
                        self_role.map(Value::String).unwrap_or(Value::Null),
                    );
                }
                if let Some(group) = thread.get_mut("group").and_then(Value::as_object_mut) {
                    group.remove("members");
                    group.insert("memberCount".into(), Value::from(member_count.max(0)));
                    group.insert("groupMetaFeedId".into(), Value::String(update.page.scanned_through));
                }
                tx.execute(
                    "UPDATE threads SET payload_json=?3 WHERE user_id=?1 AND thread_id=?2",
                    params![user_id, update.thread_id, json_text(&thread)?],
                ).map_err(|e| format!("update group thread metadata: {e}"))?;
            }
        }
        for op in items {
            match op.event_type.as_deref().unwrap_or("") {
                "RELATIONSHIP_INTENT" => {},
                "PROFILE" => {
                    let account = op.account.ok_or_else(|| "PROFILE has no account".to_string())?;
                    let domain = op.domain.ok_or_else(|| "PROFILE has no domain".to_string())?;
                    let namespace_id = op.namespace_id;
                    let body = op.body.ok_or_else(|| "PROFILE has no body".to_string())?;
                    let profile_rev = body.get("profileRev").and_then(Value::as_i64)
                        .ok_or_else(|| "PROFILE has no profileRev".to_string())?;
                    let now = chrono_millis();
                    if account.starts_with('!') {
                        let profile = serde_json::json!({
                            "account": account, "domain": domain,
                            "namespaceId": namespace_id,
                            "name": body.get("displayName").cloned().unwrap_or(Value::String(String::new())),
                            "avatar": body.get("avatar").and_then(Value::as_str).unwrap_or(""),
                            "description": body.get("bio").cloned().unwrap_or(Value::String(String::new())),
                            "profileRev": profile_rev, "createdAt": now, "updatedAt": now,
                            "dissolvedAt": Value::Null,
                        });
                        tx.execute(
                            "INSERT INTO groups(user_id,account,domain,namespace_id,surrogate_id,payload_json,profile_rev)
                             VALUES(?1,?2,?3,?4,NULL,?5,?6)
                             ON CONFLICT(user_id,account,domain,namespace_id) DO UPDATE SET
                               payload_json=excluded.payload_json,profile_rev=excluded.profile_rev
                             WHERE excluded.profile_rev >= groups.profile_rev",
                            params![user_id, account, domain, namespace_id, json_text(&profile)?, profile_rev],
                        ).map_err(|e| format!("apply group profile state: {e}"))?;
                    } else {
                        let profile = serde_json::json!({
                            "account": account, "domain": domain, "sourceDomain": domain,
                            "namespaceId": namespace_id,
                            "name": body.get("displayName").cloned().unwrap_or(Value::String(String::new())),
                            "avatar": body.get("avatar").and_then(Value::as_str).unwrap_or(""),
                            "bio": body.get("bio").cloned().unwrap_or(Value::String(String::new())),
                            "availability": "AVAILABLE", "profileRev": profile_rev,
                            "createdAt": now, "updatedAt": now,
                        });
                        tx.execute(
                            "INSERT INTO users(user_id,account,domain,source_domain,namespace_id,surrogate_id,payload_json,profile_rev)
                             VALUES(?1,?2,?3,?3,?4,NULL,?5,?6)
                             ON CONFLICT(user_id,account,domain,source_domain,namespace_id) DO UPDATE SET
                               payload_json=excluded.payload_json,profile_rev=excluded.profile_rev
                             WHERE excluded.profile_rev >= users.profile_rev",
                            params![user_id, account, domain, namespace_id, json_text(&profile)?, profile_rev],
                        ).map_err(|e| format!("apply user profile state: {e}"))?;
                    }
                    tx.execute(
                        "UPDATE friend_requests SET
                           payload_json=json_set(payload_json,
                             '$.group.name', ?4,
                             '$.group.avatar', ?5,
                             '$.group.description', ?6,
                             '$.group.profileRev', ?7,
                             '$.group.namespaceId', ?8)
                         WHERE user_id=?1
                           AND json_extract(payload_json, '$.kind')='GROUP'
                           AND json_extract(payload_json, '$.group.account')=?2
                           AND json_extract(payload_json, '$.group.domain')=?3
                           AND json_extract(payload_json, '$.group.namespaceId')=?8
                           AND COALESCE(json_extract(payload_json, '$.group.profileRev'), 0) <= ?7",
                        params![
                            user_id, account, domain,
                            body.get("displayName").and_then(Value::as_str).unwrap_or(""),
                            body.get("avatar").and_then(Value::as_str).unwrap_or(""),
                            body.get("bio").and_then(Value::as_str).unwrap_or(""),
                            profile_rev,
                            namespace_id,
                        ],
                    ).map_err(|e| format!("apply group request profile state: {e}"))?;
                    let mut statement = tx.prepare(
                        "SELECT thread_id,payload_json FROM threads
                         WHERE user_id=?1 AND (
                           (json_extract(payload_json,'$.type')='P2P'
                            AND json_extract(payload_json,'$.peerUser.account')=?2
                            AND COALESCE(json_extract(payload_json,'$.peerUser.domain'),'')=?3
                            AND json_extract(payload_json,'$.peerUser.namespaceId')=?4)
                           OR (json_extract(payload_json,'$.type')='GROUP'
                            AND json_extract(payload_json,'$.group.account')=?2
                            AND COALESCE(json_extract(payload_json,'$.group.domain'),'')=?3
                            AND json_extract(payload_json,'$.group.namespaceId')=?4))",
                    ).map_err(|e| format!("prepare profile thread projection: {e}"))?;
                    let rows = statement.query_map(params![user_id, account, domain, namespace_id], |row| {
                        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                    }).map_err(|e| format!("query profile thread projection: {e}"))?;
                    let mut replacements = Vec::new();
                    for row in rows {
                        let (thread_id, payload) = row.map_err(|e| format!("read profile thread projection: {e}"))?;
                        let mut thread = parse_json(payload)?;
                        let is_p2p = thread.get("type").and_then(Value::as_str) == Some("P2P");
                        let target = if is_p2p {
                            thread.get_mut("peerUser")
                        } else {
                            thread.get_mut("group")
                        };
                        if let Some(target) = target.and_then(Value::as_object_mut) {
                            let current = target.get("profileRev").and_then(Value::as_i64).unwrap_or(0);
                            if profile_rev >= current {
                                target.insert("name".into(), body.get("displayName").cloned().unwrap_or(Value::String(String::new())));
                                target.insert(
                                    "avatar".into(),
                                    Value::String(body.get("avatar").and_then(Value::as_str).unwrap_or("").to_string()),
                                );
                                target.insert("profileRev".into(), Value::from(profile_rev));
                                if is_p2p {
                                    target.insert("bio".into(), body.get("bio").cloned().unwrap_or(Value::String(String::new())));
                                } else {
                                    target.insert("description".into(), body.get("bio").cloned().unwrap_or(Value::String(String::new())));
                                }
                                replacements.push((thread_id, json_text(&thread)?));
                            }
                        }
                    }
                    drop(statement);
                    for (thread_id, payload) in replacements {
                        tx.execute(
                            "UPDATE threads SET payload_json=?3 WHERE user_id=?1 AND thread_id=?2",
                            params![user_id, thread_id, payload],
                        ).map_err(|e| format!("update profile thread projection: {e}"))?;
                    }
                }
                "THREAD_BLOCK" => {
                    let body = op
                        .body
                        .ok_or_else(|| "THREAD_BLOCK has no body".to_string())?;
                    let thread_id = body
                        .get("threadId")
                        .and_then(Value::as_i64)
                        .ok_or_else(|| "THREAD_BLOCK has no threadId".to_string())?;
                    let blocked = body
                        .get("blocked")
                        .and_then(Value::as_bool)
                        .ok_or_else(|| "THREAD_BLOCK has no blocked flag".to_string())?;
                    let payload: Option<String> = tx
                        .query_row(
                            "SELECT payload_json FROM threads WHERE user_id=?1 AND thread_id=?2",
                            params![user_id, thread_id],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(|e| format!("read thread block projection: {e}"))?;
                    if let Some(payload) = payload {
                        let mut thread = parse_json(payload)?;
                        if let Some(object) = thread.as_object_mut() {
                            object.insert("blocked".into(), Value::Bool(blocked));
                        }
                        tx.execute(
                            "UPDATE threads SET payload_json=?3 WHERE user_id=?1 AND thread_id=?2",
                            params![user_id, thread_id, json_text(&thread)?],
                        )
                        .map_err(|e| format!("apply thread block projection: {e}"))?;
                    }
                }
                "INCOMING_INVITE_HEAD" => {
                    let body = op
                        .body
                        .ok_or_else(|| "INCOMING_INVITE_HEAD has no body".to_string())?;
                    let read_through = body
                        .get("readThroughFeedId")
                        .and_then(Value::as_i64)
                        .filter(|value| *value >= 0)
                        .ok_or_else(|| {
                            "INCOMING_INVITE_HEAD has no valid readThroughFeedId".to_string()
                        })?;
                    tx.execute(
                        "INSERT INTO sync_state(user_id,key,value_json) VALUES(?1,'incomingInviteHead',?2)
                         ON CONFLICT(user_id,key) DO UPDATE SET value_json=excluded.value_json",
                        params![user_id, serde_json::json!({
                            "readThroughFeedId": read_through
                        }).to_string()],
                    )
                    .map_err(|e| format!("save incoming-invitation read watermark: {e}"))?;
                }
                "GROUP_META_FEED_HEAD" | "GROUP_JOIN_REQUEST_HEAD" => {}
                other => return Err(format!("unknown state-feed event type: {other}")),
            }
        }
        tx.execute(
            "INSERT INTO sync_state(user_id, key, value_json) VALUES(?1, 'stateFeedId', ?2)
             ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json",
            params![user_id, feed_id.to_string()],
        )
        .map_err(|e| format!("save thread revision: {e}"))?;
        tx.commit().map_err(|e| format!("commit state-feed page: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("join state-feed page: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_apply_catch_up(
    app: tauri::AppHandle,
    user_id: i64,
    items: Vec<Value>,
    cursor: i64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open(&app)?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("begin catch-up: {e}"))?;
        tx.execute("DELETE FROM threads WHERE user_id = ?1", params![user_id])
            .map_err(|e| format!("clear catch-up threads: {e}"))?;
        for item in items {
            let thread_id = item
                .get("threadId")
                .and_then(Value::as_i64)
                .ok_or_else(|| "catch-up item has no threadId".to_string())?;
            tx.execute(
                "INSERT INTO threads(user_id, thread_id, payload_json) VALUES(?1, ?2, ?3)",
                params![user_id, thread_id, json_text(&item)?],
            )
            .map_err(|e| format!("save catch-up thread: {e}"))?;
        }
        tx.execute(
            "INSERT INTO sync_state(user_id, key, value_json) VALUES(?1, 'messageFeedCursor', ?2)
             ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json",
            params![user_id, cursor.to_string()],
        )
        .map_err(|e| format!("save catch-up cursor: {e}"))?;
        tx.commit().map_err(|e| format!("commit catch-up: {e}"))
    })
    .await
    .map_err(|e| format!("join catch-up: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_get_profile(
    app: tauri::AppHandle,
    user_id: i64,
    identity: String,
) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        let value = if let Some(rest) = identity.strip_prefix("a:") {
            let mut parts = rest.split('\0');
            let domain = parts.next().unwrap_or("");
            let account = parts.next().unwrap_or("");
            conn.query_row(
                "SELECT payload_json FROM users WHERE user_id=?1 AND account=?2 AND domain=?3 AND source_domain=?3",
                params![user_id, account, domain], |row| row.get::<_, String>(0),
            ).optional()
        } else if let Some(raw) = identity.strip_prefix('u') {
            conn.query_row(
                "SELECT payload_json FROM users WHERE user_id=?1 AND surrogate_id=?2 LIMIT 1",
                params![user_id, raw.parse::<i64>().unwrap_or(0)], |row| row.get::<_, String>(0),
            ).optional()
        } else if let Some(raw) = identity.strip_prefix('g') {
            conn.query_row(
                "SELECT payload_json FROM groups WHERE user_id=?1 AND surrogate_id=?2 LIMIT 1",
                params![user_id, raw.parse::<i64>().unwrap_or(0)], |row| row.get::<_, String>(0),
            ).optional()
        } else {
            Ok(None)
        }.map_err(|e| format!("get profile: {e}"))?;
        let Some(payload) = value else { return Ok(None); };
        let record = parse_json(payload)?;
        Ok(Some(serde_json::json!({
            "identity": identity,
            "id": record.get("id").cloned().unwrap_or(Value::from(0)),
            "kind": if identity.starts_with('g') { "group" } else { "user" },
            "name": record.get("name").cloned().unwrap_or(Value::String(String::new())),
            "account": record.get("account").cloned().unwrap_or(Value::String(String::new())),
            "avatar": record.get("avatar").cloned().unwrap_or(Value::String(String::new())),
            "bio": record.get("bio").or_else(|| record.get("description")).cloned().unwrap_or(Value::String(String::new())),
            "domain": record.get("domain").cloned().unwrap_or(Value::String(String::new())),
            "sourceServer": record.get("sourceDomain").or_else(|| record.get("domain")).cloned().unwrap_or(Value::String(String::new())),
            "namespaceId": record.get("namespaceId").cloned().unwrap_or(Value::from(0)),
            "profileRev": record.get("profileRev").cloned().unwrap_or(Value::from(0)),
        })))
    })
    .await
    .map_err(|e| format!("join profile read: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_get_user(
    app: tauri::AppHandle,
    user_id: i64,
    account: String,
    domain: String,
    source_domain: String,
    namespace_id: i64,
) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let value = open(&app)?
            .query_row(
                "SELECT payload_json FROM users
             WHERE user_id=?1 AND account=?2 AND domain=?3 AND source_domain=?4 AND namespace_id=?5",
                params![user_id, account, domain, source_domain, namespace_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("get user: {e}"))?;
        value.map(parse_json).transpose()
    })
    .await
    .map_err(|e| format!("join user read: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_get_group_member(
    app: tauri::AppHandle,
    user_id: i64,
    thread_id: i64,
    account: String,
    domain: String,
    source_domain: String,
    namespace_id: i64,
) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let value = open(&app)?.query_row(
            "SELECT json_object(
               'threadId',member.thread_id,'account',member.member_account,
               'domain',member.member_domain,'sourceDomain',member.source_domain,
               'namespaceId',member.namespace_id,
               'role',member.role,'left',json('false'),
               'user',json(identity.payload_json))
             FROM members member JOIN users identity
               ON identity.user_id=member.user_id AND identity.account=member.member_account
              AND identity.domain=member.member_domain AND identity.source_domain=member.source_domain
              AND identity.namespace_id=member.namespace_id
             WHERE member.user_id=?1 AND member.thread_id=?2 AND member.member_account=?3
               AND member.member_domain=?4 AND member.source_domain=?5 AND member.namespace_id=?6
               AND member.left_state=0",
            params![user_id,thread_id,account,domain,source_domain,namespace_id],
            |row| row.get::<_, String>(0),
        ).optional().map_err(|e| format!("get group member: {e}"))?;
        value.map(parse_json).transpose()
    }).await.map_err(|e| format!("join group member read: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_query_group_members(
    app: tauri::AppHandle,
    user_id: i64,
    thread_id: i64,
    after_identity: String,
    take: i64,
    search: String,
) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        let mut cursor = after_identity.split('\0');
        let after_namespace = cursor.next().unwrap_or("0").parse::<i64>().unwrap_or(0);
        let after_source = cursor.next().unwrap_or("");
        let after_domain = cursor.next().unwrap_or("");
        let after_account = cursor.next().unwrap_or("");
        let mut statement = conn
            .prepare(
                "SELECT json_object(
                   'threadId', member.thread_id,
                   'account', member.member_account, 'domain', member.member_domain,
                   'sourceDomain', member.source_domain, 'namespaceId', member.namespace_id,
                   'role', member.role,
                   'left', json('false'),
                   'user', json(identity.payload_json)
                 )
                 FROM members member JOIN users identity
                   ON identity.user_id=member.user_id
                  AND identity.account=member.member_account
                  AND identity.domain=member.member_domain
                  AND identity.source_domain=member.source_domain
                  AND identity.namespace_id=member.namespace_id
                 WHERE member.user_id=?1 AND member.thread_id=?2 AND member.left_state=0
                   AND (member.namespace_id,member.source_domain,member.member_domain,member.member_account)>(?3,?4,?5,?6)
                   AND (?7='' OR instr(lower(json_extract(identity.payload_json,'$.name')),lower(?7))>0
                                OR instr(lower(member.member_account),lower(?7))>0)
                 ORDER BY member.namespace_id,member.source_domain,member.member_domain,member.member_account LIMIT ?8",
            )
            .map_err(|e| format!("prepare group member page: {e}"))?;
        let rows = statement
            .query_map(
                params![user_id, thread_id, after_namespace, after_source, after_domain, after_account, search, take],
                |row| row.get::<_, String>(0),
            )
            .map_err(|e| format!("query group member page: {e}"))?;
        let mut values = Vec::new();
        for row in rows {
            values.push(
                row.map_err(|e| format!("read group member row: {e}"))
                    .and_then(parse_json)?,
            );
        }
        Ok(values)
    })
    .await
    .map_err(|e| format!("join group member page: {e}"))?
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
        let _ = identity;
        let conn = open(&app)?;
        let account = profile.get("account").and_then(Value::as_str).unwrap_or("");
        let domain = profile.get("domain").and_then(Value::as_str).unwrap_or("");
        let namespace_id = profile.get("namespaceId").and_then(Value::as_i64)
            .ok_or_else(|| "profile has no namespaceId".to_string())?;
        let surrogate_id = profile.get("id").and_then(Value::as_i64).filter(|id| *id > 0);
        let now = chrono_millis();
        let changed = if profile.get("kind").and_then(Value::as_str) == Some("group") {
            let record = serde_json::json!({
                "id": surrogate_id, "account": account, "domain": domain,
                "namespaceId": namespace_id,
                "name": profile.get("name").cloned().unwrap_or(Value::String(String::new())),
                "avatar": profile.get("avatar").cloned().unwrap_or(Value::String(String::new())),
                "description": profile.get("bio").cloned().unwrap_or(Value::String(String::new())),
                "profileRev": profile_rev, "createdAt": now, "updatedAt": now,
                "dissolvedAt": Value::Null,
            });
            conn.execute(
                "INSERT INTO groups(user_id,account,domain,namespace_id,surrogate_id,payload_json,profile_rev)
                 VALUES(?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(user_id,account,domain,namespace_id) DO UPDATE SET
                   surrogate_id=COALESCE(excluded.surrogate_id,groups.surrogate_id),
                   payload_json=excluded.payload_json,profile_rev=excluded.profile_rev
                 WHERE excluded.profile_rev >= groups.profile_rev",
                params![user_id,account,domain,namespace_id,surrogate_id,json_text(&record)?,profile_rev],
            )
        } else {
            let source = profile.get("sourceServer").and_then(Value::as_str).unwrap_or(domain);
            let record = serde_json::json!({
                "id": surrogate_id, "account": account, "domain": domain, "sourceDomain": source,
                "namespaceId": namespace_id,
                "name": profile.get("name").cloned().unwrap_or(Value::String(String::new())),
                "avatar": profile.get("avatar").cloned().unwrap_or(Value::String(String::new())),
                "bio": profile.get("bio").cloned().unwrap_or(Value::String(String::new())),
                "availability": "AVAILABLE", "profileRev": profile_rev,
                "createdAt": now, "updatedAt": now,
            });
            conn.execute(
                "INSERT INTO users(user_id,account,domain,source_domain,namespace_id,surrogate_id,payload_json,profile_rev)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
                 ON CONFLICT(user_id,account,domain,source_domain,namespace_id) DO UPDATE SET
                   surrogate_id=COALESCE(excluded.surrogate_id,users.surrogate_id),
                   payload_json=excluded.payload_json,profile_rev=excluded.profile_rev
                 WHERE excluded.profile_rev >= users.profile_rev",
                params![user_id,account,domain,source,namespace_id,surrogate_id,json_text(&record)?,profile_rev],
            )
        }
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum MessageRangeState {
    LocalCovered,
    ServerPending,
    ServerUnavailable,
}

impl MessageRangeState {
    fn as_str(self) -> &'static str {
        match self {
            Self::LocalCovered => "LOCAL_COVERED",
            Self::ServerPending => "SERVER_PENDING",
            Self::ServerUnavailable => "SERVER_UNAVAILABLE",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "LOCAL_COVERED" => Ok(Self::LocalCovered),
            "SERVER_PENDING" => Ok(Self::ServerPending),
            "SERVER_UNAVAILABLE" => Ok(Self::ServerUnavailable),
            _ => Err(format!("invalid message range state: {value}")),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageRange {
    thread_id: i64,
    left: i64,
    right: i64,
    state: MessageRangeState,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageInterval {
    left: i64,
    right: i64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerMessageRange {
    left: i64,
    right: i64,
    state: MessageRangeState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommittedMessagePage {
    messages: Vec<Value>,
    ranges: Vec<MessageRange>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum NativeHistoryDemand {
    Latest {
        count: i64,
    },
    Around {
        anchor: i64,
        older_count: i64,
        newer_count: i64,
    },
    Older {
        before: i64,
        count: i64,
    },
    Newer {
        after: i64,
        count: i64,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum NativeHistoryItem {
    Message {
        message: Value,
    },
    ServerGap {
        left: i64,
        right: i64,
        state: MessageRangeState,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeHistoryResult {
    items: Vec<NativeHistoryItem>,
    has_older: bool,
    has_newer: bool,
    failed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageHistoryGapWire {
    start_seq: i64,
    end_seq: i64,
    recoverable: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageQueryPageWire {
    messages: Vec<Value>,
    #[serde(default)]
    gaps: Vec<MessageHistoryGapWire>,
    scanned_through: i64,
    has_more: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageCursorWire {
    resume_after: i64,
    resume_before: i64,
}

#[derive(Debug, Deserialize)]
struct ApiEnvelope {
    code: i64,
    message: String,
    data: Option<Value>,
}

enum MessageBackendResponse {
    Page(MessageQueryPageWire),
    Cursor(MessageCursorWire),
}

fn load_message_ranges(
    conn: &Connection,
    user_id: i64,
    thread_id: i64,
) -> Result<Vec<MessageRange>, String> {
    let mut statement = conn
        .prepare(
            "SELECT left_exclusive, right_inclusive, state
             FROM message_ranges
             WHERE user_id=?1 AND thread_id=?2
             ORDER BY left_exclusive ASC",
        )
        .map_err(|e| format!("prepare message range query: {e}"))?;
    let rows = statement
        .query_map(params![user_id, thread_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| format!("query message ranges: {e}"))?;
    rows.map(|row| {
        let (left, right, state) = row.map_err(|e| format!("read message range: {e}"))?;
        Ok(MessageRange {
            thread_id,
            left,
            right,
            state: MessageRangeState::parse(&state)?,
        })
    })
    .collect()
}

fn validate_message_ranges(thread_id: i64, ranges: &[MessageRange]) -> Result<(), String> {
    let mut previous: Option<MessageRange> = None;
    for range in ranges {
        if range.thread_id != thread_id {
            return Err("invalid canonical message range".to_string());
        }
        validate_interval(
            MessageInterval {
                left: range.left,
                right: range.right,
            },
            "stored message range",
        )?;
        if let Some(previous) = previous {
            if range.left < previous.right
                || (range.left == previous.right && range.state == previous.state)
            {
                return Err("message ranges are not canonical".to_string());
            }
        }
        previous = Some(*range);
    }
    Ok(())
}

fn validate_interval(interval: MessageInterval, label: &str) -> Result<(), String> {
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    if interval.left < 0 || interval.right <= interval.left || interval.right > MAX_SAFE_INTEGER {
        return Err(format!(
            "invalid {label} interval ({},{}]",
            interval.left, interval.right
        ));
    }
    Ok(())
}

fn interval_contains(interval: MessageInterval, left: i64, right: i64) -> bool {
    interval.left <= left && interval.right >= right
}

fn intervals_overlap(a: MessageInterval, b: MessageInterval) -> bool {
    a.left < b.right && a.right > b.left
}

fn resolve_message_range_state(
    current: Option<MessageRangeState>,
    incoming: Option<MessageRangeState>,
) -> Option<MessageRangeState> {
    match incoming {
        None => current,
        Some(MessageRangeState::LocalCovered) => Some(MessageRangeState::LocalCovered),
        Some(MessageRangeState::ServerPending) => match current {
            Some(MessageRangeState::LocalCovered | MessageRangeState::ServerUnavailable) => current,
            _ => Some(MessageRangeState::ServerPending),
        },
        Some(MessageRangeState::ServerUnavailable) => match current {
            Some(MessageRangeState::LocalCovered) => current,
            _ => Some(MessageRangeState::ServerUnavailable),
        },
    }
}

fn reduce_message_ranges(
    thread_id: i64,
    current: &[MessageRange],
    scan: Option<MessageInterval>,
    gaps: &[ServerMessageRange],
    message_seqs: &[i64],
) -> Result<Vec<MessageRange>, String> {
    validate_message_ranges(thread_id, current)?;
    let Some(scan) = scan else {
        if !gaps.is_empty() || !message_seqs.is_empty() {
            return Err("an empty message scan cannot contain messages or gaps".to_string());
        }
        return Ok(current.to_vec());
    };
    validate_interval(scan, "message scan")?;

    let mut previous_gap: Option<ServerMessageRange> = None;
    for gap in gaps {
        let interval = MessageInterval {
            left: gap.left,
            right: gap.right,
        };
        validate_interval(interval, "server gap")?;
        if gap.state == MessageRangeState::LocalCovered {
            return Err("server gap cannot be local coverage".to_string());
        }
        if !intervals_overlap(interval, scan) {
            return Err("server gap does not intersect the actual scan".to_string());
        }
        if previous_gap.is_some_and(|previous| gap.left < previous.right) {
            return Err("server gaps overlap or are not sorted".to_string());
        }
        previous_gap = Some(*gap);
    }

    let mut unique_message_seqs = BTreeSet::new();
    for seq in message_seqs {
        if *seq <= 0 || *seq <= scan.left || *seq > scan.right {
            return Err(format!("message sequence {seq} is outside the actual scan"));
        }
        if !unique_message_seqs.insert(*seq) {
            return Err(format!("duplicate message sequence: {seq}"));
        }
        if gaps.iter().any(|gap| *seq > gap.left && *seq <= gap.right) {
            return Err(format!("message sequence {seq} overlaps a server gap"));
        }
    }

    let mut boundaries = BTreeSet::from([scan.left, scan.right]);
    for range in current {
        boundaries.insert(range.left);
        boundaries.insert(range.right);
    }
    for gap in gaps {
        boundaries.insert(gap.left);
        boundaries.insert(gap.right);
    }
    let boundaries: Vec<_> = boundaries.into_iter().collect();
    let mut output: Vec<MessageRange> = Vec::new();
    for pair in boundaries.windows(2) {
        let left = pair[0];
        let right = pair[1];
        let current_state = current
            .iter()
            .find(|range| {
                interval_contains(
                    MessageInterval {
                        left: range.left,
                        right: range.right,
                    },
                    left,
                    right,
                )
            })
            .map(|range| range.state);
        let returned_gap = gaps.iter().find(|gap| {
            interval_contains(
                MessageInterval {
                    left: gap.left,
                    right: gap.right,
                },
                left,
                right,
            )
        });
        let incoming = returned_gap.map(|gap| gap.state).or_else(|| {
            interval_contains(scan, left, right).then_some(MessageRangeState::LocalCovered)
        });
        let Some(state) = resolve_message_range_state(current_state, incoming) else {
            continue;
        };
        if let Some(previous) = output.last_mut() {
            if previous.right == left && previous.state == state {
                previous.right = right;
                continue;
            }
        }
        output.push(MessageRange {
            thread_id,
            left,
            right,
            state,
        });
    }
    Ok(output)
}

async fn query_message_backend(
    app: &tauri::AppHandle,
    proxy: &ProxyState,
    body: Value,
) -> Result<MessageBackendResponse, String> {
    let response = perform_api_request(
        app,
        proxy,
        "POST".to_string(),
        "/api/v1/query-messages".to_string(),
        std::collections::HashMap::from([
            ("content-type".to_string(), "application/json".to_string()),
            ("accept".to_string(), "application/json".to_string()),
        ]),
        Some(
            serde_json::to_vec(&body)
                .map_err(|error| format!("serialize native message query: {error}"))?,
        ),
        true,
    )
    .await?;
    if !(200..300).contains(&response.status) {
        return Err(format!(
            "message query returned HTTP status {}",
            response.status
        ));
    }
    let envelope: ApiEnvelope = serde_json::from_str(&response.body)
        .map_err(|error| format!("parse message query envelope: {error}"))?;
    match (envelope.code, envelope.data) {
        (0, Some(data)) => serde_json::from_value(data)
            .map(MessageBackendResponse::Page)
            .map_err(|error| format!("parse message query page: {error}")),
        (30006, Some(data)) => serde_json::from_value(data)
            .map(MessageBackendResponse::Cursor)
            .map_err(|error| format!("parse message cursor recovery: {error}")),
        (code, _) => Err(format!(
            "message query business failure {code}: {}",
            envelope.message
        )),
    }
}

fn wire_gaps_to_ranges(
    gaps: Vec<MessageHistoryGapWire>,
) -> Result<Vec<ServerMessageRange>, String> {
    gaps.into_iter()
        .map(|gap| {
            if gap.start_seq <= 0 || gap.end_seq < gap.start_seq {
                return Err("backend returned an invalid message gap".to_string());
            }
            Ok(ServerMessageRange {
                left: gap.start_seq - 1,
                right: gap.end_seq,
                state: if gap.recoverable {
                    MessageRangeState::ServerPending
                } else {
                    MessageRangeState::ServerUnavailable
                },
            })
        })
        .collect()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HistoryDirection {
    Older,
    Newer,
}

struct DirectionalWalk {
    items: Vec<NativeHistoryItem>,
    has_more: bool,
}

async fn read_native_message_ranges(
    app: &tauri::AppHandle,
    user_id: i64,
    thread_id: i64,
) -> Result<Vec<MessageRange>, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        load_message_ranges(&conn, user_id, thread_id)
    })
    .await
    .map_err(|error| format!("join native message range read: {error}"))?
}

async fn read_native_message_head(
    app: &tauri::AppHandle,
    user_id: i64,
    thread_id: i64,
) -> Result<Option<i64>, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let value = open(&app)?
            .query_row(
                "SELECT value_json FROM sync_state WHERE user_id=?1 AND key=?2",
                params![user_id, message_head_key(thread_id)],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("read native message head: {error}"))?;
        value
            .map(|json| parse_json(json))
            .transpose()?
            .map(|value| {
                value
                    .get("knownNewestSeq")
                    .and_then(Value::as_i64)
                    .filter(|seq| *seq >= 0)
                    .ok_or_else(|| "native message head is invalid".to_string())
            })
            .transpose()
    })
    .await
    .map_err(|error| format!("join native message head read: {error}"))?
}

async fn query_native_messages(
    app: &tauri::AppHandle,
    user_id: i64,
    thread_id: i64,
    direction: HistoryDirection,
    cursor: i64,
    boundary: i64,
    take: usize,
) -> Result<Vec<Value>, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        let (sql, params) = match direction {
            HistoryDirection::Older => (
                "SELECT payload_json FROM messages
                 WHERE user_id=?1 AND thread_id=?2 AND seq<?3 AND seq>?4
                   AND COALESCE(json_extract(payload_json, '$.isDeleted'), 0) != 1
                 ORDER BY seq DESC LIMIT ?5",
                params![user_id, thread_id, cursor, boundary, take as i64],
            ),
            HistoryDirection::Newer => (
                "SELECT payload_json FROM messages
                 WHERE user_id=?1 AND thread_id=?2 AND seq>?3 AND seq<=?4
                   AND COALESCE(json_extract(payload_json, '$.isDeleted'), 0) != 1
                 ORDER BY seq ASC LIMIT ?5",
                params![user_id, thread_id, cursor, boundary, take as i64],
            ),
        };
        let mut statement = conn
            .prepare(sql)
            .map_err(|error| format!("prepare native history message query: {error}"))?;
        let rows = statement
            .query_map(params, |row| row.get::<_, String>(0))
            .map_err(|error| format!("query native history messages: {error}"))?;
        rows.map(|row| {
            row.map_err(|error| format!("read native history message: {error}"))
                .and_then(parse_json)
        })
        .collect()
    })
    .await
    .map_err(|error| format!("join native history message query: {error}"))?
}

fn message_seq(message: &Value, thread_id: i64) -> Result<i64, String> {
    if message.get("threadId").and_then(Value::as_i64) != Some(thread_id) {
        return Err("history message belongs to another thread".to_string());
    }
    message
        .get("seq")
        .and_then(Value::as_i64)
        .filter(|seq| *seq > 0)
        .ok_or_else(|| "history message has an invalid sequence".to_string())
}

fn range_containing(ranges: &[MessageRange], coordinate: i64) -> Option<MessageRange> {
    ranges
        .iter()
        .copied()
        .find(|range| coordinate > range.left && coordinate <= range.right)
}

fn scan_for_page(
    direction: HistoryDirection,
    cursor: i64,
    scanned_through: i64,
) -> Result<Option<MessageInterval>, String> {
    match direction {
        HistoryDirection::Older if scanned_through < cursor => Ok(Some(MessageInterval {
            left: scanned_through - 1,
            right: cursor - 1,
        })),
        HistoryDirection::Newer if scanned_through > cursor => Ok(Some(MessageInterval {
            left: cursor,
            right: scanned_through,
        })),
        _ if scanned_through == cursor => Ok(None),
        _ => Err("backend message scan cursor moved in the wrong direction".to_string()),
    }
}

fn page_items(
    thread_id: i64,
    direction: HistoryDirection,
    scan: MessageInterval,
    messages: Vec<Value>,
    gaps: &[ServerMessageRange],
) -> Result<Vec<NativeHistoryItem>, String> {
    let mut positioned = Vec::<(i64, NativeHistoryItem)>::new();
    for message in messages {
        let seq = message_seq(&message, thread_id)?;
        if seq <= scan.left || seq > scan.right {
            return Err("committed message is outside its scan".to_string());
        }
        positioned.push((seq, NativeHistoryItem::Message { message }));
    }
    for gap in gaps {
        if gap.right > scan.left && gap.right <= scan.right {
            positioned.push((
                gap.right,
                NativeHistoryItem::ServerGap {
                    left: gap.left,
                    right: gap.right,
                    state: gap.state,
                },
            ));
        }
    }
    positioned.sort_by(|left, right| match direction {
        HistoryDirection::Older => right.0.cmp(&left.0),
        HistoryDirection::Newer => left.0.cmp(&right.0),
    });
    Ok(positioned.into_iter().map(|(_, item)| item).collect())
}

fn cursor_after_item(direction: HistoryDirection, item: &NativeHistoryItem) -> i64 {
    match (direction, item) {
        (HistoryDirection::Older, NativeHistoryItem::Message { message })
        | (HistoryDirection::Newer, NativeHistoryItem::Message { message }) => message
            .get("seq")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        (HistoryDirection::Older, NativeHistoryItem::ServerGap { left, .. }) => left + 1,
        (HistoryDirection::Newer, NativeHistoryItem::ServerGap { right, .. }) => *right,
    }
}

fn history_gap_is_owned(direction: HistoryDirection, seam: i64, gap_right: i64) -> bool {
    match direction {
        HistoryDirection::Older => gap_right < seam,
        HistoryDirection::Newer => gap_right > seam,
    }
}

async fn bootstrap_message_bounds(
    app: &tauri::AppHandle,
    proxy: &ProxyState,
    thread_id: i64,
) -> Result<(i64, i64), String> {
    match query_message_backend(app, proxy, serde_json::json!({ "threadId": thread_id })).await? {
        MessageBackendResponse::Cursor(cursor)
            if cursor.resume_after >= 0 && cursor.resume_before > cursor.resume_after =>
        {
            Ok((cursor.resume_after, cursor.resume_before - 1))
        }
        MessageBackendResponse::Cursor(_) => {
            Err("backend returned invalid message bounds".to_string())
        }
        MessageBackendResponse::Page(_) => {
            Err("message bootstrap unexpectedly returned a page".to_string())
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn walk_native_history(
    app: &tauri::AppHandle,
    proxy: &ProxyState,
    user_id: i64,
    thread_id: i64,
    direction: HistoryDirection,
    mut cursor: i64,
    count: i64,
    mut lower: i64,
    mut upper: i64,
    known_newest: Option<i64>,
) -> Result<DirectionalWalk, String> {
    // A gap item belongs to the left-open/right-closed source page containing its inclusive right
    // endpoint. In particular, the older leg of an around read must skip a gap that crosses the anchor;
    // the newer leg owns that item and the renderer must never deduplicate source seams.
    let ownership_seam = cursor;
    if count <= 0 {
        return Ok(DirectionalWalk {
            items: Vec::new(),
            has_more: match direction {
                HistoryDirection::Older => cursor > lower + 1,
                HistoryDirection::Newer => cursor < upper,
            },
        });
    }
    let mut ranges = read_native_message_ranges(app, user_id, thread_id).await?;
    let mut items = Vec::new();
    let mut remaining = count as usize;

    for _ in 0..1024 {
        let at_boundary = match direction {
            HistoryDirection::Older => cursor <= lower + 1,
            HistoryDirection::Newer => cursor >= upper,
        };
        if at_boundary || remaining == 0 {
            return Ok(DirectionalWalk {
                items,
                has_more: !at_boundary,
            });
        }

        let next_coordinate = match direction {
            HistoryDirection::Older => cursor - 1,
            HistoryDirection::Newer => cursor + 1,
        };
        if let Some(range) = range_containing(&ranges, next_coordinate) {
            match range.state {
                MessageRangeState::LocalCovered => {
                    let boundary = match direction {
                        HistoryDirection::Older => range.left,
                        HistoryDirection::Newer => range.right,
                    };
                    let cached = query_native_messages(
                        app, user_id, thread_id, direction, cursor, boundary, remaining,
                    )
                    .await?;
                    for message in cached {
                        cursor = message_seq(&message, thread_id)?;
                        items.push(NativeHistoryItem::Message { message });
                        remaining -= 1;
                        if remaining == 0 {
                            return Ok(DirectionalWalk {
                                items,
                                has_more: match direction {
                                    HistoryDirection::Older => cursor > lower + 1,
                                    HistoryDirection::Newer => cursor < upper,
                                },
                            });
                        }
                    }
                    cursor = match direction {
                        HistoryDirection::Older => range.left + 1,
                        HistoryDirection::Newer => range.right,
                    };
                    continue;
                }
                MessageRangeState::ServerPending | MessageRangeState::ServerUnavailable => {
                    let owns_item = history_gap_is_owned(direction, ownership_seam, range.right);
                    if owns_item {
                        items.push(NativeHistoryItem::ServerGap {
                            left: range.left,
                            right: range.right,
                            state: range.state,
                        });
                        remaining -= 1;
                    }
                    cursor = match direction {
                        HistoryDirection::Older => range.left + 1,
                        HistoryDirection::Newer => range.right,
                    };
                    continue;
                }
            }
        }

        let optimistic_boundary = match direction {
            HistoryDirection::Older => lower,
            HistoryDirection::Newer => upper,
        };
        let optimistic = query_native_messages(
            app,
            user_id,
            thread_id,
            direction,
            cursor,
            optimistic_boundary,
            remaining,
        )
        .await?;
        let provisional = if optimistic.len() == remaining {
            optimistic
                .last()
                .map(|message| message_seq(message, thread_id))
                .transpose()?
                .unwrap_or(optimistic_boundary)
        } else {
            optimistic_boundary
        };
        let classified_boundary = match direction {
            HistoryDirection::Older => ranges
                .iter()
                .filter(|range| range.left < cursor - 1 && range.right > provisional)
                .max_by_key(|range| range.right)
                .map(|range| range.right + 1),
            HistoryDirection::Newer => ranges
                .iter()
                .filter(|range| range.right > cursor && range.left < provisional)
                .min_by_key(|range| range.left)
                .map(|range| range.left),
        };
        let through = classified_boundary.unwrap_or(provisional);
        let no_scan = match direction {
            HistoryDirection::Older => through >= cursor,
            HistoryDirection::Newer => through <= cursor,
        };
        if no_scan {
            return Err("native history walker made no coordinate progress".to_string());
        }
        let body = match direction {
            HistoryDirection::Older => serde_json::json!({
                "threadId": thread_id,
                "before": cursor,
                "through": through,
                "take": remaining.min(50),
            }),
            HistoryDirection::Newer => serde_json::json!({
                "threadId": thread_id,
                "after": cursor,
                "through": through,
                "take": remaining.min(50),
            }),
        };
        let page = match query_message_backend(app, proxy, body).await? {
            MessageBackendResponse::Cursor(recovery) => {
                if recovery.resume_after < 0 || recovery.resume_before <= recovery.resume_after {
                    return Err("backend returned invalid cursor recovery bounds".to_string());
                }
                lower = lower.max(recovery.resume_after);
                upper = upper.min(recovery.resume_before - 1);
                cursor = match direction {
                    HistoryDirection::Older => cursor.min(recovery.resume_before),
                    HistoryDirection::Newer => cursor.max(recovery.resume_after),
                };
                continue;
            }
            MessageBackendResponse::Page(page) => page,
        };
        let _backend_has_more = page.has_more;
        let scan = scan_for_page(direction, cursor, page.scanned_through)?;
        let gaps = wire_gaps_to_ranges(page.gaps)?;
        let committed = commit_native_message_page(
            app.clone(),
            user_id,
            thread_id,
            scan,
            page.messages,
            gaps.clone(),
            known_newest,
        )
        .await?;
        ranges = committed.ranges;
        let Some(scan) = scan else {
            return Ok(DirectionalWalk {
                items,
                has_more: false,
            });
        };
        let direct = page_items(thread_id, direction, scan, committed.messages, &gaps)?;
        if direct.len() >= remaining {
            for item in direct.into_iter().take(remaining) {
                cursor = cursor_after_item(direction, &item);
                items.push(item);
            }
            return Ok(DirectionalWalk {
                items,
                has_more: match direction {
                    HistoryDirection::Older => cursor > lower + 1,
                    HistoryDirection::Newer => cursor < upper,
                },
            });
        }
        remaining -= direct.len();
        for item in direct {
            items.push(item);
        }
        cursor = page.scanned_through;
    }
    Err("native history walker exceeded its progress limit".to_string())
}

pub(crate) async fn commit_native_message_page(
    app: tauri::AppHandle,
    user_id: i64,
    thread_id: i64,
    scan: Option<MessageInterval>,
    messages: Vec<Value>,
    gaps: Vec<ServerMessageRange>,
    known_newest_seq: Option<i64>,
) -> Result<CommittedMessagePage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if known_newest_seq.is_some_and(|seq| seq < 0) {
            return Err("known newest message sequence is invalid".to_string());
        }
        let message_seqs = messages
            .iter()
            .map(|message| {
                let message_thread_id = message
                    .get("threadId")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| "message has no numeric threadId".to_string())?;
                let seq = message
                    .get("seq")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| "message has no numeric seq".to_string())?;
                if message_thread_id != thread_id {
                    return Err("message page contains a message from another thread".to_string());
                }
                Ok(seq)
            })
            .collect::<Result<Vec<_>, String>>()?;
        let mut conn = open(&app)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("begin message page commit: {e}"))?;
        let current = load_message_ranges(&tx, user_id, thread_id)?;
        let ranges = reduce_message_ranges(thread_id, &current, scan, &gaps, &message_seqs)?;

        let mut committed_messages = Vec::with_capacity(messages.len());
        for message in messages {
            let message_thread_id = message
                .get("threadId")
                .and_then(Value::as_i64)
                .ok_or_else(|| "message has no numeric threadId".to_string())?;
            let seq = message
                .get("seq")
                .and_then(Value::as_i64)
                .ok_or_else(|| "message has no numeric seq".to_string())?;
            if message_thread_id != thread_id || seq <= 0 {
                return Err("message page contains an invalid message coordinate".to_string());
            }
            let existing_deleted = tx
                .query_row(
                    "SELECT COALESCE(json_extract(payload_json, '$.isDeleted'), 0)
                     FROM messages WHERE user_id=?1 AND thread_id=?2 AND seq=?3",
                    params![user_id, thread_id, seq],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(|e| format!("read existing message before page commit: {e}"))?
                == Some(1);
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
            .map_err(|e| format!("put committed page message: {e}"))?;
            if !existing_deleted {
                committed_messages.push(message);
            }
        }

        tx.execute(
            "DELETE FROM message_ranges WHERE user_id=?1 AND thread_id=?2",
            params![user_id, thread_id],
        )
        .map_err(|e| format!("replace message ranges: {e}"))?;
        for range in &ranges {
            tx.execute(
                "INSERT INTO message_ranges(
                   user_id, thread_id, left_exclusive, right_inclusive, state
                 ) VALUES(?1,?2,?3,?4,?5)",
                params![
                    user_id,
                    thread_id,
                    range.left,
                    range.right,
                    range.state.as_str()
                ],
            )
            .map_err(|e| format!("insert canonical message range: {e}"))?;
        }

        if let Some(incoming) = known_newest_seq {
            update_message_head(&tx, user_id, thread_id, incoming)?;
        }
        tx.commit()
            .map_err(|e| format!("commit message page: {e}"))?;
        Ok(CommittedMessagePage {
            messages: committed_messages,
            ranges,
        })
    })
    .await
    .map_err(|e| format!("join message page commit: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_message_history_get(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ProxyState>,
    user_id: i64,
    thread_id: i64,
    cleared_through_seq: Option<i64>,
    demand: NativeHistoryDemand,
) -> Result<NativeHistoryResult, String> {
    if user_id <= 0 || thread_id <= 0 {
        return Err("native history demand has an invalid owner or thread".to_string());
    }
    let lower = cleared_through_seq.unwrap_or_default().max(0);
    let validate_count = |count: i64| -> Result<i64, String> {
        if (0..=200).contains(&count) {
            Ok(count)
        } else {
            Err("native history demand count is outside 0..200".to_string())
        }
    };
    match demand {
        NativeHistoryDemand::Latest { count } => {
            let count = validate_count(count)?;
            let (server_lower, upper) = bootstrap_message_bounds(&app, &proxy, thread_id).await?;
            let lower = lower.max(server_lower);
            let mut page = walk_native_history(
                &app,
                &proxy,
                user_id,
                thread_id,
                HistoryDirection::Older,
                upper + 1,
                count,
                lower,
                upper,
                Some(upper),
            )
            .await?;
            page.items.reverse();
            Ok(NativeHistoryResult {
                items: page.items,
                has_older: page.has_more,
                has_newer: false,
                failed: false,
            })
        }
        NativeHistoryDemand::Around {
            anchor,
            older_count,
            newer_count,
        } => {
            if anchor <= 0 {
                return Err("native around demand has an invalid anchor".to_string());
            }
            let older_count = validate_count(older_count)?;
            let newer_count = validate_count(newer_count)?;
            let (server_lower, upper) = bootstrap_message_bounds(&app, &proxy, thread_id).await?;
            let lower = lower.max(server_lower);
            let mut older = walk_native_history(
                &app,
                &proxy,
                user_id,
                thread_id,
                HistoryDirection::Older,
                anchor + 1,
                older_count,
                lower,
                upper,
                Some(upper),
            )
            .await?;
            let newer = walk_native_history(
                &app,
                &proxy,
                user_id,
                thread_id,
                HistoryDirection::Newer,
                anchor,
                newer_count,
                lower,
                upper,
                Some(upper),
            )
            .await?;
            older.items.reverse();
            older.items.extend(newer.items);
            Ok(NativeHistoryResult {
                items: older.items,
                has_older: older.has_more,
                has_newer: newer.has_more,
                failed: false,
            })
        }
        NativeHistoryDemand::Older { before, count } => {
            if before <= 0 {
                return Err("native older demand has an invalid cursor".to_string());
            }
            let count = validate_count(count)?;
            let known_newest = read_native_message_head(&app, user_id, thread_id).await?;
            let upper = known_newest.unwrap_or(before - 1).max(lower);
            let mut page = walk_native_history(
                &app,
                &proxy,
                user_id,
                thread_id,
                HistoryDirection::Older,
                before,
                count,
                lower,
                upper,
                known_newest,
            )
            .await?;
            page.items.reverse();
            Ok(NativeHistoryResult {
                items: page.items,
                has_older: page.has_more,
                has_newer: before <= upper,
                failed: false,
            })
        }
        NativeHistoryDemand::Newer { after, count } => {
            if after < 0 {
                return Err("native newer demand has an invalid cursor".to_string());
            }
            let count = validate_count(count)?;
            let (server_lower, upper) =
                match read_native_message_head(&app, user_id, thread_id).await? {
                    Some(upper) => (lower, upper),
                    None => bootstrap_message_bounds(&app, &proxy, thread_id).await?,
                };
            let lower = lower.max(server_lower);
            let page = walk_native_history(
                &app,
                &proxy,
                user_id,
                thread_id,
                HistoryDirection::Newer,
                after,
                count,
                lower,
                upper,
                Some(upper),
            )
            .await?;
            Ok(NativeHistoryResult {
                items: page.items,
                has_older: after > lower,
                has_newer: page.has_more,
                failed: false,
            })
        }
    }
}

#[tauri::command]
pub(crate) async fn native_db_put_cached_messages(
    app: tauri::AppHandle,
    user_id: i64,
    messages: Vec<Value>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open(&app)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("begin cached message write: {error}"))?;
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
            .map_err(|error| format!("put cached message: {error}"))?;
        }
        tx.commit()
            .map_err(|error| format!("commit cached message write: {error}"))
    })
    .await
    .map_err(|error| format!("join cached message write: {error}"))?
}

#[tauri::command]
pub(crate) async fn native_db_put_message_head(
    app: tauri::AppHandle,
    user_id: i64,
    thread_id: i64,
    known_newest_seq: i64,
) -> Result<(), String> {
    if user_id <= 0 || thread_id <= 0 || known_newest_seq < 0 {
        return Err("invalid native message head".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open(&app)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("begin message head write: {error}"))?;
        update_message_head(&tx, user_id, thread_id, known_newest_seq)?;
        tx.commit()
            .map_err(|error| format!("commit message head write: {error}"))
    })
    .await
    .map_err(|error| format!("join message head write: {error}"))?
}

fn decode_deleted_hwm(value_json: &str) -> Result<(i64, bool), String> {
    let value: Value =
        serde_json::from_str(value_json).map_err(|e| format!("parse deleted hwm: {e}"))?;
    let (hwm, legacy_string) = match value {
        Value::Number(value) => (value.as_i64(), false),
        Value::String(value)
            if value == "0"
                || (!value.starts_with('0') && value.chars().all(|ch| ch.is_ascii_digit())) =>
        {
            (value.parse::<i64>().ok(), true)
        }
        _ => (None, false),
    };
    match hwm {
        Some(hwm) if hwm >= 0 => Ok((hwm, legacy_string)),
        _ => Err("deleted hwm must be a non-negative integer".to_string()),
    }
}

#[tauri::command]
pub(crate) async fn native_db_get_deleted_hwm(
    app: tauri::AppHandle,
    user_id: i64,
    thread_id: i64,
) -> Result<i64, String> {
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
            Some(value) => {
                let (hwm, legacy_string) = decode_deleted_hwm(&value)?;
                if legacy_string {
                    conn.execute(
                        "UPDATE sync_state SET value_json=?3 WHERE user_id=?1 AND key=?2",
                        params![user_id, key, hwm.to_string()],
                    )
                    .map_err(|e| format!("normalize deleted hwm: {e}"))?;
                }
                Ok(hwm)
            }
            None => Ok(0),
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
    hwm: i64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if hwm < 0 {
            return Err("deleted hwm must be a non-negative integer".to_string());
        }
        let mut conn = open(&app)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("begin deleted-message write: {e}"))?;
        for item in items {
            let item_thread_id = item
                .get("threadId")
                .and_then(Value::as_i64)
                .ok_or_else(|| "deleted message has no numeric threadId".to_string())?;
            let deletion_seq = item
                .get("deletionSeq")
                .and_then(Value::as_i64)
                .ok_or_else(|| "deleted message has no numeric deletionSeq".to_string())?;
            let message_seq = item
                .get("messageSeq")
                .and_then(Value::as_i64)
                .ok_or_else(|| "deleted message has no numeric messageSeq".to_string())?;
            if item_thread_id != thread_id
                || deletion_seq < 1
                || deletion_seq > hwm
                || message_seq < 1
            {
                return Err("deleted message has invalid coordinates".to_string());
            }
            let placeholder = serde_json::json!({
                "threadId": thread_id,
                "seq": message_seq,
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
                params![user_id, thread_id, message_seq, json_text(&placeholder)?],
            )
            .map_err(|e| format!("apply deleted message: {e}"))?;
        }
        tx.execute(
            "INSERT INTO sync_state(user_id,key,value_json) VALUES(?1,?2,?3)
             ON CONFLICT(user_id,key) DO UPDATE SET value_json=excluded.value_json",
            params![user_id, format!("deletedHwm:{thread_id}"), hwm.to_string()],
        )
        .map_err(|e| format!("advance deleted hwm: {e}"))?;
        tx.commit()
            .map_err(|e| format!("commit deleted-message write: {e}"))
    })
    .await
    .map_err(|e| format!("join deleted-message write: {e}"))?
}

fn message_head_key(thread_id: i64) -> String {
    format!("messageHead:{thread_id}")
}

fn update_message_head(
    tx: &rusqlite::Transaction<'_>,
    user_id: i64,
    thread_id: i64,
    incoming: i64,
) -> Result<(), String> {
    if incoming < 0 {
        return Err("known newest message sequence is invalid".to_string());
    }
    let key = message_head_key(thread_id);
    let old = tx
        .query_row(
            "SELECT value_json FROM sync_state WHERE user_id=?1 AND key=?2",
            params![user_id, key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("read message head: {error}"))?
        .map(|json| parse_json(json).map_err(|error| format!("parse message head: {error}")))
        .transpose()?
        .and_then(|value| value.get("knownNewestSeq").and_then(Value::as_i64))
        .unwrap_or_default();
    let value = serde_json::json!({
        "threadId": thread_id,
        "knownNewestSeq": incoming.max(old),
    });
    tx.execute(
        "INSERT INTO sync_state(user_id,key,value_json) VALUES(?1,?2,?3)
         ON CONFLICT(user_id,key) DO UPDATE SET value_json=excluded.value_json",
        params![user_id, key, json_text(&value)?],
    )
    .map_err(|error| format!("put message head: {error}"))?;
    Ok(())
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
            "DELETE FROM message_ranges WHERE user_id = ?1 AND thread_id = ?2",
            params![user_id, thread_id],
        )
        .map_err(|e| format!("delete thread message ranges: {e}"))?;
        tx.execute(
            "DELETE FROM sync_state WHERE user_id=?1 AND key=?2",
            params![user_id, message_head_key(thread_id)],
        )
        .map_err(|e| format!("delete message head: {e}"))?;
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
        for table in [
            "threads",
            "users",
            "groups",
            "members",
            "friend_requests",
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
                 DELETE FROM users;
                 DELETE FROM groups;
                 DELETE FROM members;
                 DELETE FROM friend_requests;
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
