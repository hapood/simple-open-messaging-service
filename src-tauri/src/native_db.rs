use rusqlite::{
    params, Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tauri::Manager;

const DB_FILENAME: &str = "soms-local.sqlite3";
const CACHE_SCHEMA_VERSION: i64 = 5;

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
        "thread_participants",
        "friend_requests",
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
        "friend_requests_direction_status",
        "thread_participants_identity",
        "thread_participants_search",
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
        CREATE TABLE IF NOT EXISTS thread_participants (
          user_id INTEGER NOT NULL,
          thread_id INTEGER NOT NULL,
          member_user_id INTEGER NOT NULL,
          member_account TEXT NOT NULL,
          member_domain TEXT NOT NULL,
          role TEXT NOT NULL,
          display_name TEXT NOT NULL,
          avatar TEXT NOT NULL,
          profile_rev INTEGER NOT NULL,
          PRIMARY KEY (user_id, thread_id, member_user_id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS thread_participants_identity
          ON thread_participants(user_id, thread_id, member_domain, member_account);
        CREATE INDEX IF NOT EXISTS thread_participants_search
          ON thread_participants(user_id, thread_id, display_name, member_account, member_user_id);
        CREATE TABLE IF NOT EXISTS friend_requests (
          user_id INTEGER NOT NULL,
          stable_key TEXT NOT NULL,
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
         DROP TABLE IF EXISTS thread_participants;
         DROP TABLE IF EXISTS friend_intents;
         DROP TABLE IF EXISTS friend_requests;
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

fn friend_pair_key(
    account: &str,
    domain: &str,
    subject_account: &str,
    subject_domain: &str,
) -> Result<String, String> {
    let mut endpoints = vec![
        format!("{domain}\0{account}"),
        format!("{subject_domain}\0{subject_account}"),
    ];
    endpoints.sort();
    Ok(format!(
        "friend:{}",
        json_text(&serde_json::json!(endpoints))?
    ))
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

fn apply_group_relationship_intent(
    tx: &Transaction<'_>,
    user_id: i64,
    revision: i64,
    account: &str,
    domain: &str,
    subject_account: &str,
    subject_domain: &str,
    body: &Value,
) -> Result<(), String> {
    let now = chrono_millis();
    let group_authored = account.starts_with('!');
    let (group_account, group_domain, direction) = if group_authored {
        (account, domain, "INCOMING")
    } else {
        (subject_account, subject_domain, "OUTGOING")
    };
    let key = format!("group:{group_domain}\0{group_account}");
    let current: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM friend_requests WHERE user_id=?1 AND stable_key=?2",
            params![user_id, key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("read group relationship projection: {e}"))?;
    let prior = current.map(parse_json).transpose()?;
    let prior_actionable = prior.as_ref().is_some_and(|value| {
        value.get("direction").and_then(Value::as_str) == Some("INCOMING")
            && value.get("status").and_then(Value::as_str) == Some("REQUESTED")
    });
    let status = body
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| "group relationship intent has no status".to_string())?;
    let thread_id = body
        .get("threadId")
        .and_then(Value::as_i64)
        .ok_or_else(|| "group relationship intent has no threadId".to_string())?;
    let group = body
        .get("group")
        .cloned()
        .ok_or_else(|| "group relationship intent has no group".to_string())?;
    let mut projection = prior.unwrap_or_else(|| {
        serde_json::json!({
            "key": key,
            "kind": "GROUP",
            "bucket": if direction == "INCOMING" { "RECEIVED" } else { "SENT" },
            "direction": direction,
            "status": null,
            "local": null,
            "remote": null,
            "locallyAccepted": false,
            "localThreadId": thread_id,
            "inviteId": group_account,
            "note": body.get("note").cloned().unwrap_or(Value::String(String::new())),
            "requestedAt": body.get("requestedAt").cloned().unwrap_or(Value::from(0)),
            "group": group,
            "sourceLabel": if group.get("isLocal").and_then(Value::as_bool) == Some(true) { "local" } else { group_domain },
            "requestedSort": body.get("requestedAt").cloned().unwrap_or(Value::from(0)),
            "updatedAt": now,
        })
    });
    let object = projection
        .as_object_mut()
        .ok_or_else(|| "group relationship projection is not an object".to_string())?;
    let expires_at = match (
        body.get("requestedAt").and_then(Value::as_i64),
        body.get("expiresAt").and_then(Value::as_i64),
    ) {
        (Some(requested_at), Some(expires_at)) => {
            Value::from(expires_at.min(requested_at + 604_800_000))
        }
        _ => Value::Null,
    };
    object.insert(
        if direction == "OUTGOING" {
            "local"
        } else {
            "remote"
        }
        .into(),
        serde_json::json!({ "status": status, "expiresAt": expires_at }),
    );
    object.insert("group".into(), group.clone());
    object.insert("localThreadId".into(), Value::from(thread_id));
    object.insert("updatedAt".into(), Value::from(now));

    let local = object.get("local");
    let remote = object.get("remote");
    let active = intent_is_effective(local, now)
        && intent_is_effective(remote, now)
        && [local, remote]
            .into_iter()
            .flatten()
            .any(|intent| intent.get("status").and_then(Value::as_str) == Some("ACCEPTED"));
    if active {
        object.insert("status".into(), Value::Null);
        let group_object = group.as_object().cloned().unwrap_or_default();
        let thread = serde_json::json!({
            "threadId": thread_id,
            "type": "GROUP",
            "role": null,
            "lastMessageAt": null,
            "lastMessageSeq": null,
            "muted": false,
            "blocked": false,
            "pinned": false,
            "pinnedAt": null,
            "clearedSeq": null,
            "alias": null,
            "conversationState": "ACTIVE",
            "lastReadSeq": null,
            "unreadCount": 0,
            "mentionUnread": [],
            "lastMessagePreview": null,
            "lastMessageSenderId": null,
            "group": {
                "id": thread_id,
                "account": group_object.get("account").cloned().unwrap_or(Value::String(group_account.into())),
                "name": group_object.get("name").cloned().unwrap_or(Value::String(group_account.into())),
                "ownerId": 0,
                "avatar": group_object.get("avatar").cloned().unwrap_or(Value::String(String::new())),
                "description": group_object.get("description").cloned().unwrap_or(Value::String(String::new())),
                "domain": group_object.get("domain").cloned().unwrap_or(Value::String(group_domain.into())),
                "threadId": thread_id,
                "createdAt": 0,
                "updatedAt": 0,
                "profileRev": group_object.get("profileRev").cloned().unwrap_or(Value::from(0)),
                "dissolvedAt": null,
                "memberCount": 0,
                "groupMetaFeedId": "0"
            }
        });
        tx.execute(
            "INSERT INTO threads(user_id,thread_id,payload_json) VALUES(?1,?2,?3)
             ON CONFLICT(user_id,thread_id) DO NOTHING",
            params![user_id, thread_id, json_text(&thread)?],
        )
        .map_err(|e| format!("materialize group thread projection: {e}"))?;
        let identity = format!("pending-group:{group_domain}\0{group_account}");
        tx.execute(
            "DELETE FROM profiles WHERE user_id=?1 AND identity=?2",
            params![user_id, identity],
        )
        .map_err(|e| format!("delete activated group profile: {e}"))?;
    } else if status == "REQUESTED"
        && body
            .get("expiresAt")
            .and_then(Value::as_i64)
            .is_some_and(|value| value > now)
    {
        object.insert("direction".into(), Value::String(direction.into()));
        object.insert(
            "status".into(),
            if direction == "INCOMING" {
                Value::String("REQUESTED".into())
            } else {
                Value::Null
            },
        );
    } else if status == "REVOKED" {
        object.insert("status".into(), Value::String("REVOKED".into()));
    }
    let actionable = object.get("direction").and_then(Value::as_str) == Some("INCOMING")
        && object.get("status").and_then(Value::as_str) == Some("REQUESTED");
    save_request_projection(tx, user_id, &key, &projection)?;
    if actionable && !prior_actionable {
        tx.execute(
            "INSERT INTO sync_state(user_id,key,value_json) VALUES(?1,'friendRequestStateRevision',?2)
             ON CONFLICT(user_id,key) DO UPDATE SET value_json=excluded.value_json",
            params![user_id, revision.to_string()],
        )
        .map_err(|e| format!("save group-request unread revision: {e}"))?;
    }
    Ok(())
}

fn apply_friend_request_intent(
    tx: &Transaction<'_>,
    user_id: i64,
    revision: i64,
    account: &str,
    domain: &str,
    subject_account: &str,
    subject_domain: &str,
    body: &Value,
) -> Result<(), String> {
    let now = chrono_millis();
    let key = friend_pair_key(account, domain, subject_account, subject_domain)?;
    let current: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM friend_requests WHERE user_id=?1 AND stable_key=?2",
            params![user_id, key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("read friend-request projection: {e}"))?;
    let prior = current.map(parse_json).transpose()?;
    let prior_actionable = prior.as_ref().is_some_and(|value| {
        value.get("direction").and_then(Value::as_str) == Some("INCOMING")
            && value.get("status").and_then(Value::as_str) == Some("REQUESTED")
    });
    let direction = body
        .get("direction")
        .and_then(Value::as_str)
        .ok_or_else(|| "friend intent has no direction".to_string())?;
    let intent_status = body
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| "friend intent has no status".to_string())?;
    let mut payload = prior.unwrap_or_else(|| {
        serde_json::json!({
            "key": key,
            "kind": "FRIEND",
            "bucket": if direction == "INCOMING" { "RECEIVED" } else { "SENT" },
            "direction": direction,
            "status": intent_status,
            "local": null,
            "remote": null,
            "locallyAccepted": false,
            "localThreadId": body.get("localThreadId").cloned().unwrap_or(Value::Null),
            "note": body.get("note").cloned().unwrap_or(Value::String(String::new())),
            "requestedAt": body.get("requestedAt").cloned().unwrap_or(Value::from(0)),
            "peer": body.get("peer").cloned().unwrap_or(Value::Null),
            "requestedSort": body.get("requestedAt").cloned().unwrap_or(Value::from(0)),
            "updatedAt": now,
        })
    });
    let object = payload
        .as_object_mut()
        .ok_or_else(|| "friend-request projection is not an object".to_string())?;
    if !object.contains_key("bucket") {
        let bucket = if object.get("direction").and_then(Value::as_str) == Some("INCOMING") {
            "RECEIVED"
        } else {
            "SENT"
        };
        object.insert("bucket".into(), Value::String(bucket.into()));
    }
    let intent_field = if direction == "OUTGOING" {
        "local"
    } else {
        "remote"
    };
    object.insert(
        intent_field.into(),
        serde_json::json!({
            "status": intent_status,
            "expiresAt": body.get("expiresAt").cloned().unwrap_or(Value::Null),
        }),
    );
    object.insert("updatedAt".into(), Value::from(now));
    if let Some(local_thread_id) = body.get("localThreadId").and_then(Value::as_i64) {
        object.insert("localThreadId".into(), Value::from(local_thread_id));
    }
    if intent_status == "REQUESTED" {
        object.insert("direction".into(), Value::String(direction.into()));
        for field in ["inviteId", "note", "requestedAt", "peer"] {
            if let Some(value) = body.get(field) {
                object.insert(field.into(), value.clone());
            }
        }
        object.insert(
            "requestedSort".into(),
            body.get("requestedAt").cloned().unwrap_or(Value::from(0)),
        );
        if let (Some(requested_at), Some(expires_at)) = (
            body.get("requestedAt").and_then(Value::as_i64),
            body.get("expiresAt").and_then(Value::as_i64),
        ) {
            if let Some(intent) = object.get_mut(intent_field).and_then(Value::as_object_mut) {
                intent.insert(
                    "expiresAt".into(),
                    Value::from(expires_at.min(requested_at + 604_800_000)),
                );
            }
        }
    }
    let local = object
        .get("local")
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let remote = object
        .get("remote")
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    if local.as_deref() == Some("ACCEPTED") && remote.as_deref() == Some("ACCEPTED") {
        if object.get("bucket").and_then(Value::as_str) == Some("RECEIVED") {
            object.insert("direction".into(), Value::String("INCOMING".into()));
            object.insert("status".into(), Value::String("ACCEPTED".into()));
        } else {
            object.insert("direction".into(), Value::String("OUTGOING".into()));
            object.insert("status".into(), Value::Null);
        }
        save_request_projection(tx, user_id, &key, &payload)?;
        return Ok(());
    }
    if remote.as_deref() == Some("REVOKED") {
        if local.as_deref() == Some("REQUESTED") {
            object.insert("direction".into(), Value::String("OUTGOING".into()));
            object.insert("bucket".into(), Value::String("SENT".into()));
            object.insert("status".into(), Value::String("REVOKED".into()));
            save_request_projection(tx, user_id, &key, &payload)?;
            return Ok(());
        }
        if object.get("bucket").and_then(Value::as_str) == Some("RECEIVED") {
            object.insert("direction".into(), Value::String("INCOMING".into()));
            object.insert("status".into(), Value::String("REVOKED".into()));
        } else {
            object.insert("status".into(), Value::Null);
        }
        save_request_projection(tx, user_id, &key, &payload)?;
        return Ok(());
    }
    if local.as_deref() == Some("REVOKED")
        && object.get("bucket").and_then(Value::as_str) == Some("RECEIVED")
    {
        object.insert("direction".into(), Value::String("INCOMING".into()));
        object.insert("status".into(), Value::String("REVOKED".into()));
        save_request_projection(tx, user_id, &key, &payload)?;
        return Ok(());
    }
    let remote_valid = object
        .get("remote")
        .and_then(|value| value.get("expiresAt"))
        .and_then(Value::as_i64)
        .is_some_and(|value| value > now);
    let local_valid = object
        .get("local")
        .and_then(|value| value.get("expiresAt"))
        .and_then(Value::as_i64)
        .is_some_and(|value| value > now);
    let locally_accepted = object
        .get("locallyAccepted")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if remote.as_deref() == Some("REQUESTED") && remote_valid {
        object.insert("direction".into(), Value::String("INCOMING".into()));
        object.insert(
            "status".into(),
            Value::String(
                if locally_accepted || local.as_deref() == Some("ACCEPTED") {
                    "ACCEPTED"
                } else {
                    "REQUESTED"
                }
                .into(),
            ),
        );
    } else if local.as_deref() == Some("REQUESTED") && local_valid {
        object.insert("direction".into(), Value::String("OUTGOING".into()));
        object.insert(
            "status".into(),
            Value::String(
                if remote.as_deref() == Some("ACCEPTED") {
                    ""
                } else {
                    "REQUESTED"
                }
                .into(),
            ),
        );
        if remote.as_deref() == Some("ACCEPTED") {
            object.insert("status".into(), Value::Null);
        }
    } else if object.get("direction").and_then(Value::as_str) == Some("OUTGOING")
        && local.as_deref() == Some("REVOKED")
    {
        object.insert("status".into(), Value::String("REVOKED".into()));
    } else if local.as_deref() == Some("ACCEPTED") || remote.as_deref() == Some("ACCEPTED") {
        object.insert("direction".into(), Value::String("OUTGOING".into()));
        object.insert("status".into(), Value::Null);
    } else {
        tx.execute(
            "DELETE FROM friend_requests WHERE user_id=?1 AND stable_key=?2",
            params![user_id, key],
        )
        .map_err(|e| format!("delete terminal friend-request projection: {e}"))?;
        return Ok(());
    }
    let actionable = object.get("direction").and_then(Value::as_str) == Some("INCOMING")
        && object.get("status").and_then(Value::as_str) == Some("REQUESTED");
    save_request_projection(tx, user_id, &key, &payload)?;
    if actionable && !prior_actionable {
        tx.execute(
            "INSERT INTO sync_state(user_id,key,value_json) VALUES(?1,'friendRequestStateRevision',?2)
             ON CONFLICT(user_id,key) DO UPDATE SET value_json=excluded.value_json",
            params![user_id, revision.to_string()],
        ).map_err(|e| format!("save friend-request unread revision: {e}"))?;
    }
    Ok(())
}

fn apply_friend_thread_projection(
    tx: &Transaction<'_>,
    user_id: i64,
    account: &str,
    domain: &str,
    subject_account: &str,
    subject_domain: &str,
) -> Result<(), String> {
    let key = friend_pair_key(account, domain, subject_account, subject_domain)?;
    let payload: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM friend_requests WHERE user_id=?1 AND stable_key=?2",
            params![user_id, key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("read friend thread projection: {e}"))?;
    let Some(projection) = payload.map(parse_json).transpose()? else {
        return Ok(());
    };
    let Some(thread_id) = projection.get("localThreadId").and_then(Value::as_i64) else {
        return Ok(());
    };
    if thread_id < 1 {
        return Ok(());
    }
    let now = chrono_millis();
    let effective = |field: &str| {
        let intent = projection.get(field);
        intent
            .and_then(|value| value.get("status"))
            .and_then(Value::as_str)
            == Some("ACCEPTED")
            || (intent
                .and_then(|value| value.get("status"))
                .and_then(Value::as_str)
                == Some("REQUESTED")
                && intent
                    .and_then(|value| value.get("expiresAt"))
                    .and_then(Value::as_i64)
                    .is_some_and(|expiry| expiry > now))
    };
    let local = projection
        .get("local")
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str);
    let remote = projection
        .get("remote")
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str);
    let active = effective("local")
        && effective("remote")
        && (local == Some("ACCEPTED") || remote == Some("ACCEPTED"));
    let existing: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM threads WHERE user_id=?1 AND thread_id=?2",
            params![user_id, thread_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("read projected friend thread: {e}"))?;
    if let Some(existing) = existing {
        let mut thread = parse_json(existing)?;
        if thread.get("type").and_then(Value::as_str) == Some("P2P") {
            thread["friendshipActive"] = Value::Bool(active);
            thread["conversationState"] =
                Value::String(if active { "ACTIVE" } else { "READ_ONLY" }.into());
            if let Some(peer) = projection.get("peer") {
                thread["peerUser"] = peer.clone();
            }
            tx.execute(
                "UPDATE threads SET payload_json=?3 WHERE user_id=?1 AND thread_id=?2",
                params![user_id, thread_id, json_text(&thread)?],
            )
            .map_err(|e| format!("update projected friend thread: {e}"))?;
        }
    } else if active {
        let mut peer = projection.get("peer").cloned().unwrap_or(Value::Null);
        if let Some(peer) = peer.as_object_mut() {
            peer.entry("isGroup").or_insert(Value::Bool(false));
            peer.entry("profileRev").or_insert(Value::from(0));
            peer.entry("createdAt").or_insert(Value::from(0));
            peer.entry("updatedAt").or_insert(Value::from(0));
            peer.entry("isDeleted").or_insert(Value::Bool(false));
        }
        let thread = serde_json::json!({
            "threadId": thread_id,
            "type": "P2P",
            "role": null,
            "lastMessageAt": null,
            "lastMessageSeq": null,
            "muted": false,
            "blocked": false,
            "pinned": false,
            "pinnedAt": null,
            "clearedSeq": null,
            "alias": null,
            "peerUser": peer,
            "friendshipActive": true,
            "conversationState": "ACTIVE",
            "lastReadSeq": null,
            "unreadCount": 0,
            "mentionUnread": [],
            "lastMessagePreview": null,
            "lastMessageSenderId": null,
        });
        tx.execute(
            "INSERT INTO threads(user_id,thread_id,payload_json) VALUES(?1,?2,?3)",
            params![user_id, thread_id, json_text(&thread)?],
        )
        .map_err(|e| format!("insert projected friend thread: {e}"))?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientStateFeedItem {
    feed_id: Option<i64>,
    account: Option<String>,
    domain: Option<String>,
    event_type: Option<String>,
    subject_account: Option<String>,
    subject_domain: Option<String>,
    body: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientGroupMetaApply {
    thread_id: i64,
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
                   AND (json_extract(payload_json, '$.status') = 'REQUESTED'
                     OR (?2 = 'RECEIVED' AND json_extract(payload_json, '$.status') = 'ACCEPTED')
                     OR json_extract(payload_json, '$.status') = 'REVOKED')
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
                   AND (json_extract(payload_json, '$.status') = 'REQUESTED'
                     OR (?2 = 'RECEIVED' AND json_extract(payload_json, '$.status') = 'ACCEPTED')
                     OR json_extract(payload_json, '$.status') = 'REVOKED')",
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
        let conn = open(&app)?;
        let current: Option<String> = conn
            .query_row(
                "SELECT payload_json FROM friend_requests WHERE user_id=?1 AND stable_key=?2",
                params![user_id, key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("read friend request for accept: {e}"))?;
        let Some(current) = current else {
            return Ok(());
        };
        let mut payload = parse_json(current)?;
        let object = payload
            .as_object_mut()
            .ok_or_else(|| "friend request is not an object".to_string())?;
        object.insert("direction".into(), Value::String("INCOMING".into()));
        object.insert("status".into(), Value::String("ACCEPTED".into()));
        object.insert("locallyAccepted".into(), Value::Bool(true));
        object.insert("updatedAt".into(), Value::from(chrono_millis()));
        conn.execute(
            "UPDATE friend_requests SET payload_json=?3 WHERE user_id=?1 AND stable_key=?2",
            params![user_id, key, json_text(&payload)?],
        )
        .map_err(|e| format!("mark friend request accepted: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("join mark friend request accepted: {e}"))?
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
    conn.execute(
            "DELETE FROM profiles
             WHERE user_id=?1
               AND json_extract(payload_json, '$.source') IN ('OUTGOING_FRIEND_REQUEST', 'GROUP_INVITE')
               AND CAST(json_extract(payload_json, '$.expiresAt') AS INTEGER) <= ?2",
            params![user_id, now],
        )
        .map_err(|e| format!("cleanup expired request profiles: {e}"))?;
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
        let tx = conn.transaction().map_err(|e| format!("begin state-feed page: {e}"))?;
        if reset_projection {
            tx.execute("DELETE FROM friend_requests WHERE user_id=?1", [user_id])
                .map_err(|e| format!("clear state-feed friend requests: {e}"))?;
            tx.execute("DELETE FROM thread_participants WHERE user_id=?1", [user_id])
                .map_err(|e| format!("clear state-feed thread participants: {e}"))?;
            tx.execute(
                "DELETE FROM profiles
                 WHERE user_id=?1 AND json_extract(payload_json, '$.source') IN (
                   'OUTGOING_FRIEND_REQUEST', 'GROUP_INVITE'
                 )",
                [user_id],
            )
            .map_err(|e| format!("clear state-feed pending profiles: {e}"))?;
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
            if !account.starts_with('!') && !subject_account.starts_with('!') {
                continue;
            }
            apply_group_relationship_intent(
                &tx,
                user_id,
                op.feed_id.ok_or_else(|| "state-feed item has no feedId".to_string())?,
                account,
                op.domain.as_deref().unwrap_or(""),
                subject_account,
                op.subject_domain.as_deref().unwrap_or(""),
                op.body
                    .as_ref()
                    .ok_or_else(|| "group relationship intent has no body".to_string())?,
            )?;
        }
        for update in group_meta {
            let payload: Option<String> = tx.query_row(
                "SELECT payload_json FROM threads WHERE user_id=?1 AND thread_id=?2",
                params![user_id, update.thread_id], |row| row.get(0),
            ).optional().map_err(|e| format!("read group thread: {e}"))?;
            let mut thread = payload.map(parse_json).transpose()?;
            let mut member_count = if update.page.mode == "full" {
                tx.execute(
                    "DELETE FROM thread_participants WHERE user_id=?1 AND thread_id=?2",
                    params![user_id, update.thread_id],
                ).map_err(|e| format!("clear full group roster: {e}"))?;
                0_i64
            } else {
                thread.as_ref()
                    .and_then(|value| value.get("group"))
                    .and_then(|group| group.get("memberCount"))
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
            };
            for item in update.page.items {
                if item.operation == "DELETE" {
                    let changed = tx.execute(
                        "DELETE FROM thread_participants
                         WHERE user_id=?1 AND thread_id=?2 AND member_domain=?3 AND member_account=?4",
                        params![user_id, update.thread_id, item.domain, item.account],
                    ).map_err(|e| format!("delete group member: {e}"))?;
                    if changed > 0 { member_count -= 1; }
                    continue;
                }
                let member_user_id = item.body.get("userId").and_then(Value::as_i64)
                    .ok_or_else(|| "group-meta UPSERT has no userId".to_string())?;
                let existed: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM thread_participants
                     WHERE user_id=?1 AND thread_id=?2 AND member_user_id=?3)",
                    params![user_id, update.thread_id, member_user_id],
                    |row| row.get(0),
                ).map_err(|e| format!("read group member: {e}"))?;
                tx.execute(
                    "INSERT INTO thread_participants(
                       user_id,thread_id,member_user_id,member_account,member_domain,
                       role,display_name,avatar,profile_rev
                     ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
                     ON CONFLICT(user_id,thread_id,member_user_id) DO UPDATE SET
                       member_account=excluded.member_account,member_domain=excluded.member_domain,
                       role=excluded.role,display_name=excluded.display_name,
                       avatar=excluded.avatar,profile_rev=excluded.profile_rev",
                    params![
                        user_id, update.thread_id, member_user_id, item.account, item.domain,
                        item.body.get("role").and_then(Value::as_str).unwrap_or("MEMBER"),
                        item.body.get("displayName").and_then(Value::as_str).unwrap_or(""),
                        item.body.get("avatar").and_then(Value::as_str).unwrap_or(""),
                        item.body.get("profileRev").and_then(Value::as_i64).unwrap_or(0),
                    ],
                ).map_err(|e| format!("upsert group member: {e}"))?;
                if !existed { member_count += 1; }
            }
            if let Some(mut thread) = thread.take() {
                let self_role: Option<String> = tx.query_row(
                    "SELECT role FROM thread_participants
                     WHERE user_id=?1 AND thread_id=?2 AND member_user_id=?1",
                    params![user_id, update.thread_id],
                    |row| row.get(0),
                ).optional().map_err(|e| format!("read current group role: {e}"))?;
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
                "RELATIONSHIP_INTENT" => {
                    let item_feed_id = op.feed_id.ok_or_else(|| "state-feed item has no feedId".to_string())?;
                    let account = op.account.ok_or_else(|| "CLIENT_STATE has no account".to_string())?;
                    let domain = op.domain.ok_or_else(|| "CLIENT_STATE has no domain".to_string())?;
                    let subject_account = op.subject_account.ok_or_else(|| "CLIENT_STATE has no subjectAccount".to_string())?;
                    let subject_domain = op.subject_domain.ok_or_else(|| "CLIENT_STATE has no subjectDomain".to_string())?;
                    let body = op.body.ok_or_else(|| "CLIENT_STATE has no body".to_string())?;
                    if account.starts_with('!') || subject_account.starts_with('!') {
                        continue;
                    }
                    if account.starts_with('!') {
                        let key = format!("group:{domain}\0{account}");
                        let status = body.get("status").and_then(Value::as_str).unwrap_or("");
                        let direction = body.get("direction").and_then(Value::as_str).unwrap_or("INCOMING");
                        let expires_at = body.get("expiresAt").and_then(Value::as_i64);
                        let current_payload: Option<String> = tx.query_row(
                            "SELECT payload_json FROM friend_requests WHERE user_id=?1 AND stable_key=?2",
                            params![user_id, key], |row| row.get(0)
                        ).optional().map_err(|e| format!("read group-request projection: {e}"))?;
                        let current = current_payload.map(parse_json).transpose()?;
                        let current_status = current.as_ref().and_then(|value| value.get("status")).and_then(Value::as_str);
                        if status == "REQUESTED" && expires_at.is_some_and(|value| value > chrono_millis()) {
                            let group = body.get("group").cloned().unwrap_or(Value::Null);
                            let requested_at = body.get("requestedAt").and_then(Value::as_i64).unwrap_or(0);
                            let bounded_expires_at = expires_at
                                .map(|value| value.min(requested_at.saturating_add(604_800_000)));
                            let projection = serde_json::json!({
                                "key": key, "kind": "GROUP",
                                "bucket": if direction == "INCOMING" { "RECEIVED" } else { "SENT" },
                                "direction": direction,
                                "status": if current_status == Some("ACCEPTED") { "ACCEPTED" } else { "REQUESTED" },
                                "local": if direction == "OUTGOING" {
                                    serde_json::json!({ "status": "REQUESTED", "expiresAt": bounded_expires_at })
                                } else { Value::Null },
                                "remote": if direction == "INCOMING" {
                                    serde_json::json!({ "status": "REQUESTED", "expiresAt": bounded_expires_at })
                                } else { Value::Null },
                                "locallyAccepted": current_status == Some("ACCEPTED"),
                                "inviteId": account, "note": body.get("note").cloned().unwrap_or(Value::String(String::new())),
                                "requestedAt": requested_at,
                                "group": group, "requestedSort": requested_at, "updatedAt": chrono_millis()
                            });
                            save_request_projection(&tx, user_id, &key, &projection)?;
                            if let Some(group_object) = group.as_object() {
                                let group_account = group_object.get("account").and_then(Value::as_str).unwrap_or("");
                                let group_domain = group_object.get("domain").and_then(Value::as_str).unwrap_or("");
                                let identity = format!("pending-group:{group_domain}\0{group_account}");
                                let profile = serde_json::json!({
                                    "identity": identity, "id": 0, "kind": "group",
                                    "name": group_object.get("name").cloned().unwrap_or(Value::String(String::new())),
                                    "account": group_account,
                                    "avatar": group_object.get("avatar").cloned().unwrap_or(Value::String(String::new())),
                                    "bio": group_object.get("description").cloned().unwrap_or(Value::String(String::new())),
                                    "domain": group_domain,
                                    "profileRev": group_object.get("profileRev").cloned().unwrap_or(Value::from(0)),
                                    "source": "GROUP_INVITE", "expiresAt": bounded_expires_at,
                                });
                                tx.execute(
                                    "INSERT INTO profiles(user_id,identity,payload_json,profile_rev) VALUES(?1,?2,?3,0)
                                     ON CONFLICT(user_id,identity) DO UPDATE SET payload_json=excluded.payload_json",
                                    params![user_id, identity, json_text(&profile)?],
                                ).map_err(|e| format!("cache group-request profile: {e}"))?;
                            }
                            if current_status.is_none() && direction == "INCOMING" {
                                tx.execute(
                                    "INSERT INTO sync_state(user_id,key,value_json) VALUES(?1,'friendRequestStateRevision',?2)
                                     ON CONFLICT(user_id,key) DO UPDATE SET value_json=excluded.value_json",
                                    params![user_id, item_feed_id.to_string()],
                                ).map_err(|e| format!("save group-request unread revision: {e}"))?;
                            }
                        } else if status == "REVOKED" {
                            if let Some(mut projection) = current {
                                if projection.get("bucket").is_none() {
                                    let bucket = if projection.get("direction").and_then(Value::as_str) == Some("INCOMING") {
                                        "RECEIVED"
                                    } else {
                                        "SENT"
                                    };
                                    projection["bucket"] = Value::String(bucket.into());
                                }
                                projection["status"] = Value::String("REVOKED".into());
                                projection["updatedAt"] = Value::from(chrono_millis());
                                if direction == "OUTGOING" {
                                    projection["local"] = serde_json::json!({
                                        "status": "REVOKED", "expiresAt": null
                                    });
                                } else {
                                    projection["remote"] = serde_json::json!({
                                        "status": "REVOKED", "expiresAt": null
                                    });
                                }
                                save_request_projection(&tx, user_id, &key, &projection)?;
                            }
                        } else {
                            if let Some(group) = current.as_ref().and_then(|value| value.get("group")) {
                                let group_account = group.get("account").and_then(Value::as_str).unwrap_or("");
                                let group_domain = group.get("domain").and_then(Value::as_str).unwrap_or("");
                                let identity = format!("pending-group:{group_domain}\0{group_account}");
                                tx.execute("DELETE FROM profiles WHERE user_id=?1 AND identity=?2", params![user_id, identity])
                                    .map_err(|e| format!("delete terminal group-request profile: {e}"))?;
                            }
                            tx.execute("DELETE FROM friend_requests WHERE user_id=?1 AND stable_key=?2", params![user_id, key])
                                .map_err(|e| format!("delete terminal group request: {e}"))?;
                        }
                        continue;
                    }
                    apply_friend_request_intent(
                        &tx, user_id, item_feed_id, &account, &domain,
                        &subject_account, &subject_domain, &body,
                    )?;
                    apply_friend_thread_projection(
                        &tx, user_id, &account, &domain,
                        &subject_account, &subject_domain,
                    )?;
                    let direction = body.get("direction").and_then(Value::as_str).unwrap_or("");
                    let outgoing_requested = direction == "OUTGOING"
                        && body.get("status").and_then(Value::as_str) == Some("REQUESTED");
                    let expires_at = body
                        .get("requestedAt")
                        .and_then(Value::as_i64)
                        .zip(body.get("expiresAt").and_then(Value::as_i64))
                        .map(|(requested_at, expires_at)| {
                            expires_at.min(requested_at + 604_800_000)
                        });
                    if outgoing_requested {
                        if let Some(expires_at) = expires_at {
                            let peer = body.get("peer").and_then(Value::as_object).cloned().unwrap_or_default();
                            let peer_account = peer
                                .get("account")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            let peer_domain = peer
                                .get("domain")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            if !peer_account.is_empty() && !peer_domain.is_empty() {
                                let identity = format!("pending:{peer_domain}\0{peer_account}");
                                let profile = serde_json::json!({
                                    "identity": identity,
                                    "id": 0,
                                    "kind": "user",
                                    "name": peer.get("name").and_then(Value::as_str).filter(|v| !v.is_empty()).unwrap_or(peer_account),
                                    "account": peer_account,
                                    "avatar": peer.get("avatar").and_then(Value::as_str).unwrap_or(""),
                                    "bio": peer.get("bio").and_then(Value::as_str).unwrap_or(""),
                                    "domain": peer_domain,
                                    "profileRev": 0,
                                    "source": "OUTGOING_FRIEND_REQUEST",
                                    "expiresAt": expires_at,
                                });
                                tx.execute(
                                    "INSERT INTO profiles(user_id, identity, payload_json, profile_rev)
                                     VALUES(?1, ?2, ?3, 0)
                                     ON CONFLICT(user_id, identity) DO UPDATE SET
                                       payload_json=excluded.payload_json",
                                    params![user_id, identity, json_text(&profile)?],
                                )
                                .map_err(|e| format!("cache pending friend profile: {e}"))?;
                            }
                        }
                    }
                }
                "PROFILE" => {
                    let account = op.account.ok_or_else(|| "PROFILE has no account".to_string())?;
                    let domain = op.domain.ok_or_else(|| "PROFILE has no domain".to_string())?;
                    let body = op.body.ok_or_else(|| "PROFILE has no body".to_string())?;
                    let profile_rev = body.get("profileRev").and_then(Value::as_i64)
                        .ok_or_else(|| "PROFILE has no profileRev".to_string())?;
                    tx.execute(
                        "UPDATE profiles SET
                           payload_json=json_set(payload_json,
                             '$.name', ?4, '$.avatar', ?5, '$.bio', ?6, '$.profileRev', ?7),
                           profile_rev=?7
                         WHERE user_id=?1
                           AND json_extract(payload_json, '$.account')=?2
                           AND json_extract(payload_json, '$.domain')=?3
                           AND profile_rev <= ?7",
                        params![
                            user_id, account, domain,
                            body.get("displayName").and_then(Value::as_str).unwrap_or(""),
                            body.get("avatar").and_then(Value::as_str).unwrap_or(""),
                            body.get("bio").and_then(Value::as_str).unwrap_or(""),
                            profile_rev,
                        ],
                    ).map_err(|e| format!("apply profile state: {e}"))?;
                    let mut statement = tx.prepare(
                        "SELECT thread_id,payload_json FROM threads
                         WHERE user_id=?1 AND (
                           (json_extract(payload_json,'$.type')='P2P'
                            AND json_extract(payload_json,'$.peerUser.account')=?2
                            AND COALESCE(json_extract(payload_json,'$.peerUser.domain'),'')=?3)
                           OR (json_extract(payload_json,'$.type')='GROUP'
                            AND json_extract(payload_json,'$.group.account')=?2
                            AND COALESCE(json_extract(payload_json,'$.group.domain'),'')=?3))",
                    ).map_err(|e| format!("prepare profile thread projection: {e}"))?;
                    let rows = statement.query_map(params![user_id, account, domain], |row| {
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
        tx.commit().map_err(|e| format!("commit state-feed page: {e}"))
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
pub(crate) async fn native_db_query_group_members(
    app: tauri::AppHandle,
    user_id: i64,
    thread_id: i64,
    after_user_id: i64,
    take: i64,
    search: String,
) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        let mut statement = conn
            .prepare(
                "SELECT json_object(
                   'threadId', thread_id, 'userId', member_user_id,
                   'memberAccount', member_account, 'memberDomain', member_domain,
                   'role', role, 'displayName', display_name,
                   'avatar', avatar, 'profileRev', profile_rev
                 )
                 FROM thread_participants
                 WHERE user_id=?1 AND thread_id=?2 AND member_user_id>?3
                   AND (?4='' OR instr(lower(display_name), lower(?4))>0
                                OR instr(lower(member_account), lower(?4))>0)
                 ORDER BY member_user_id LIMIT ?5",
            )
            .map_err(|e| format!("prepare group member page: {e}"))?;
        let rows = statement
            .query_map(
                params![user_id, thread_id, after_user_id, search, take],
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
