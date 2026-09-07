use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::Value;

use super::relationship_projection::{
    apply_friend_thread_from_facts, apply_group_request_effect, apply_relationship_intent_fact,
    apply_relationship_request_effect, materialize_group_thread_from_fact,
    update_live_request_projection,
};
use super::{json_text, open, parse_json};

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
    #[serde(default)]
    account: String,
    #[serde(default)]
    domain: String,
    #[serde(default)]
    namespace_id: i64,
    operation: String,
    body: Value,
}

pub(crate) fn chrono_millis() -> i64 {
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
pub(crate) async fn native_db_list_relationship_requests(
    app: tauri::AppHandle,
    user_id: i64,
) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        let mut stmt = conn
            .prepare("SELECT payload_json FROM relationship_requests WHERE user_id = ?1")
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
pub(crate) async fn native_db_page_relationship_requests(
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
                "SELECT payload_json FROM relationship_requests
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
                "SELECT COUNT(*) FROM relationship_requests
                 WHERE user_id = ?1
                   AND json_extract(payload_json, '$.bucket') = ?2
                   AND json_extract(payload_json, '$.status') IN ('REQUESTED','ACCEPTED','REVOKED')",
                params![user_id, bucket],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| format!("count friend intents: {e}"))?;
        let actionable_total = conn
            .query_row(
                "SELECT COUNT(*) FROM relationship_requests
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
pub(crate) async fn native_db_mark_relationship_request_accepted(
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
pub(crate) async fn native_db_cleanup_relationship_requests(
    app: tauri::AppHandle,
    user_id: i64,
    now: i64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        cleanup_relationship_requests(&conn, user_id, now)
    })
    .await
    .map_err(|e| format!("join friend-request cleanup: {e}"))?
}

pub(super) fn cleanup_relationship_requests(
    conn: &Connection,
    user_id: i64,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM relationship_requests
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
        apply_state_feed_page(
            &mut open(&app)?,
            user_id,
            items,
            feed_id,
            group_meta,
            reset_projection,
        )
    })
    .await
    .map_err(|e| format!("join state-feed page: {e}"))?
}

pub(super) fn apply_state_feed_page(
    conn: &mut Connection,
    user_id: i64,
    items: Vec<ClientStateFeedItem>,
    feed_id: i64,
    group_meta: Vec<ClientGroupMetaApply>,
    reset_projection: bool,
) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("begin state-feed page: {e}"))?;
    super::contacts::register_namespace(&tx, user_id, 0, "local")?;
    if reset_projection {
        tx.execute(
            "DELETE FROM relationship_requests WHERE user_id=?1",
            [user_id],
        )
        .map_err(|e| format!("clear state-feed friend requests: {e}"))?;
        tx.execute(
            "DELETE FROM relationship_intents WHERE user_id=?1",
            [user_id],
        )
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
                (
                    subject_account,
                    op.subject_domain.as_deref().unwrap_or(""),
                    "OUTGOING",
                )
            };
            apply_group_request_effect(
                &tx,
                user_id,
                op.feed_id
                    .ok_or_else(|| "state-feed item has no feedId".to_string())?,
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
            apply_relationship_request_effect(
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
            apply_friend_thread_from_facts(&tx, user_id, op.namespace_id, body, active)?;
        }
    }
    for update in group_meta {
        if update.source_server.is_empty() {
            return Err("group-meta sourceServer must be canonical and non-empty".into());
        }
        if update.namespace_id < 0 {
            return Err("group-meta source namespace must be non-negative".into());
        }
        if update.page.mode != "full" && update.page.mode != "delta" {
            return Err("group-meta mode must be full or delta".into());
        }
        super::contacts::register_namespace(
            &tx,
            user_id,
            update.namespace_id,
            &update.source_server,
        )?;
        let payload: Option<String> = tx
            .query_row(
                "SELECT payload_json FROM threads WHERE user_id=?1 AND thread_id=?2",
                params![user_id, update.thread_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("read group thread: {e}"))?;
        if payload.is_none() {
            continue;
        }
        let mut thread = payload.map(parse_json).transpose()?;
        for mut item in update.page.items {
            if item.operation == "GROUP_PROFILE" {
                if let Some(group) = thread
                    .as_mut()
                    .and_then(|thread| thread.get_mut("group"))
                    .and_then(Value::as_object_mut)
                {
                    group.insert(
                        "profileRev".into(),
                        item.body
                            .get("profileRev")
                            .cloned()
                            .ok_or("GROUP_PROFILE has no profileRev")?,
                    );
                }
                continue;
            }
            if item.account.is_empty() || item.domain.is_empty() {
                return Err("group-meta member has no subject address".into());
            }
            if item.domain == "local" || item.namespace_id == 0 {
                item.domain = "local".into();
                item.namespace_id = 0;
            }
            if item.namespace_id < 0 {
                return Err("group-meta member namespace must be non-negative".into());
            }
            let source = if item.namespace_id == update.namespace_id {
                &update.source_server
            } else {
                &item.domain
            };
            super::contacts::register_namespace(&tx, user_id, item.namespace_id, source)?;
            if item.operation == "DEPART" {
                tx.execute(
                    "UPDATE members SET left_state=1
                         WHERE user_id=?1 AND thread_id=?2 AND member_account=?3
                           AND member_domain=?4 AND namespace_id=?5",
                    params![
                        user_id,
                        update.thread_id,
                        item.account,
                        item.domain,
                        item.namespace_id
                    ],
                )
                .map_err(|e| format!("depart group member: {e}"))?;
                continue;
            }
            if item.operation != "UPSERT" {
                return Err("group-meta operation must be UPSERT or DEPART".into());
            }
            let profile_rev = item
                .body
                .get("profileRev")
                .and_then(Value::as_i64)
                .ok_or_else(|| "group-meta UPSERT has no profileRev".to_string())?;
            let profile_message_seq = item.body.get("profileMessageSeq").and_then(Value::as_i64);
            let profile_resolved = item
                .body
                .get("profileResolved")
                .and_then(Value::as_bool)
                .unwrap_or_else(|| {
                    item.body
                        .get("displayName")
                        .and_then(Value::as_str)
                        .is_some()
                });
            if profile_resolved {
                let profile = serde_json::json!({
                    "account": item.account,
                    "domain": item.domain,
                    "namespaceId": item.namespace_id,
                    "name": item.body.get("displayName").cloned().unwrap_or(Value::String(String::new())),
                    "avatar": item.body.get("avatar").and_then(Value::as_str).unwrap_or(""),
                    "bio": item.body.get("bio").and_then(Value::as_str).unwrap_or(""),
                    "availability": "AVAILABLE",
                    "profileRev": profile_rev,
                });
                super::contacts::write_profile(&tx, user_id, &profile)?;
            }
            tx.execute(
                    "INSERT INTO members(
                       user_id,thread_id,member_account,member_domain,namespace_id,role,left_state,
                       profile_rev,profile_message_seq
                     ) VALUES(?1,?2,?3,?4,?5,?6,0,?7,?8)
                     ON CONFLICT(user_id,thread_id,member_account,member_domain,namespace_id)
                     DO UPDATE SET role=excluded.role,left_state=0,
                       profile_rev=excluded.profile_rev,profile_message_seq=excluded.profile_message_seq",
                    params![
                        user_id, update.thread_id, item.account, item.domain, item.namespace_id,
                        item.body.get("role").and_then(Value::as_str).unwrap_or("MEMBER"),
                        profile_rev,
                        profile_message_seq,
                    ],
                ).map_err(|e| format!("upsert group member: {e}"))?;
        }
        if let Some(mut thread) = thread.take() {
            let self_role: Option<String> = tx.query_row(
                    "SELECT member.role FROM members member
                     JOIN sync_state self_user ON self_user.user_id=member.user_id AND self_user.key='selfIdentity'
                     WHERE member.user_id=?1 AND member.thread_id=?2 AND member.left_state=0
                       AND member.member_account=json_extract(self_user.value_json,'$.account')
                       AND member.member_domain='local'
                       AND member.namespace_id=0
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
                group.insert(
                    "groupMetaFeedId".into(),
                    Value::String(update.page.scanned_through),
                );
            }
            tx.execute(
                "UPDATE threads SET payload_json=?3 WHERE user_id=?1 AND thread_id=?2",
                params![user_id, update.thread_id, json_text(&thread)?],
            )
            .map_err(|e| format!("update group thread metadata: {e}"))?;
        }
    }
    for op in items {
        match op.event_type.as_deref().unwrap_or("") {
            "RELATIONSHIP_INTENT" => {}
            "PROFILE" => {
                let account = op
                    .account
                    .ok_or_else(|| "PROFILE has no account".to_string())?;
                let domain = op
                    .domain
                    .ok_or_else(|| "PROFILE has no domain".to_string())?;
                let (domain, namespace_id) = if domain == "local" || op.namespace_id == 0 {
                    ("local".to_string(), 0)
                } else {
                    (domain, op.namespace_id)
                };
                let body = op.body.ok_or_else(|| "PROFILE has no body".to_string())?;
                let profile_rev = body
                    .get("profileRev")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| "PROFILE has no profileRev".to_string())?;
                if body.get("displayName").and_then(Value::as_str).is_some() && profile_rev > 0 {
                    super::contacts::write_profile(
                        &tx,
                        user_id,
                        &serde_json::json!({
                            "account": account, "domain": domain, "namespaceId": namespace_id,
                            "profileRev": profile_rev, "name": body.get("displayName"),
                            "avatar": body.get("avatar").and_then(Value::as_str).unwrap_or(""),
                            "bio": body.get("bio").and_then(Value::as_str).unwrap_or("") }),
                    )?;
                }
                tx.execute(
                    "UPDATE relationship_requests SET
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
                        user_id,
                        account,
                        domain,
                        body.get("displayName")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                        body.get("avatar").and_then(Value::as_str).unwrap_or(""),
                        body.get("bio").and_then(Value::as_str).unwrap_or(""),
                        profile_rev,
                        namespace_id,
                    ],
                )
                .map_err(|e| format!("apply group request profile state: {e}"))?;
                let mut statement = tx
                    .prepare(
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
                    )
                    .map_err(|e| format!("prepare profile thread projection: {e}"))?;
                let rows = statement
                    .query_map(params![user_id, account, domain, namespace_id], |row| {
                        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(|e| format!("query profile thread projection: {e}"))?;
                let mut replacements = Vec::new();
                for row in rows {
                    let (thread_id, payload) =
                        row.map_err(|e| format!("read profile thread projection: {e}"))?;
                    let mut thread = parse_json(payload)?;
                    let is_p2p = thread.get("type").and_then(Value::as_str) == Some("P2P");
                    if is_p2p
                        && thread
                            .get("peerProfileMessageSeq")
                            .and_then(Value::as_i64)
                            .is_some()
                    {
                        continue;
                    }
                    let target = if is_p2p {
                        thread.get_mut("peerUser")
                    } else {
                        thread.get_mut("group")
                    };
                    if let Some(target) = target.and_then(Value::as_object_mut) {
                        let current = target
                            .get("profileRev")
                            .and_then(Value::as_i64)
                            .unwrap_or(0);
                        if (is_p2p && profile_rev == current) || (!is_p2p && profile_rev >= current)
                        {
                            target.insert(
                                "name".into(),
                                body.get("displayName")
                                    .cloned()
                                    .unwrap_or(Value::String(String::new())),
                            );
                            target.insert(
                                "avatar".into(),
                                Value::String(
                                    body.get("avatar")
                                        .and_then(Value::as_str)
                                        .unwrap_or("")
                                        .to_string(),
                                ),
                            );
                            target.insert("profileRev".into(), Value::from(profile_rev));
                            if is_p2p {
                                target.insert(
                                    "bio".into(),
                                    body.get("bio")
                                        .cloned()
                                        .unwrap_or(Value::String(String::new())),
                                );
                            } else {
                                target.insert(
                                    "description".into(),
                                    body.get("bio")
                                        .cloned()
                                        .unwrap_or(Value::String(String::new())),
                                );
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
                    )
                    .map_err(|e| format!("update profile thread projection: {e}"))?;
                }
            }
            "THREAD_CONTENT_HEAD" => {
                let body = op
                    .body
                    .ok_or_else(|| "THREAD_CONTENT_HEAD has no body".to_string())?;
                let thread_id = body
                    .get("threadId")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| "THREAD_CONTENT_HEAD has no threadId".to_string())?;
                let message_end_seq = body
                    .get("messageEndSeq")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| "THREAD_CONTENT_HEAD has no messageEndSeq".to_string())?;
                let tombstone_end_seq = body
                    .get("tombstoneEndSeq")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| "THREAD_CONTENT_HEAD has no tombstoneEndSeq".to_string())?;
                let payload: Option<String> = tx
                    .query_row(
                        "SELECT payload_json FROM threads WHERE user_id=?1 AND thread_id=?2",
                        params![user_id, thread_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|e| format!("read thread content projection: {e}"))?;
                if let Some(payload) = payload {
                    let mut thread = parse_json(payload)?;
                    if let Some(object) = thread.as_object_mut() {
                        object.insert("lastMessageSeq".into(), Value::from(message_end_seq));
                        object.insert("tombstoneEndSeq".into(), Value::from(tombstone_end_seq));
                    }
                    tx.execute(
                        "UPDATE threads SET payload_json=?3 WHERE user_id=?1 AND thread_id=?2",
                        params![user_id, thread_id, json_text(&thread)?],
                    )
                    .map_err(|e| format!("apply thread content projection: {e}"))?;
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
                        "INSERT INTO sync_state(user_id,key,value_json) VALUES(?1,'relationshipRequestReadHead',?2)
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
    tx.commit()
        .map_err(|e| format!("commit state-feed page: {e}"))?;
    Ok(())
}
