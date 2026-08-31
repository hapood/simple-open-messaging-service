use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use super::{chrono_millis, json_text, open, parse_json};

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
