use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::Value;

use super::relationship_projection::{
    apply_group_request_effect, apply_relationship_request_effect, update_live_request_projection,
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
    pub(super) thread_id: i64,
    pub(super) source_server: String,
    pub(super) namespace_id: i64,
    pub(super) page: ClientGroupMetaPage,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientGroupMetaPage {
    #[serde(default)]
    pub(super) account: String,
    pub(super) mode: String,
    pub(super) items: Vec<ClientGroupMetaItem>,
    pub(super) scanned_through: String,
    #[serde(default)]
    pub(super) group_meta_feed_end_id: String,
    #[serde(default)]
    pub(super) has_more: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientGroupMetaItem {
    pub(super) feed_id: String,
    #[serde(default)]
    pub(super) account: String,
    #[serde(default)]
    pub(super) domain: String,
    #[serde(default)]
    pub(super) namespace_id: i64,
    pub(super) operation: String,
    #[serde(default)]
    pub(super) body: Value,
}

pub(crate) fn chrono_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[tauri::command]
pub(crate) async fn native_db_threads(user_id: i64) -> Result<Vec<Value>, String> {
    super::lifetime::spawn(move || {
        let conn = open()?;
        let mut stmt = conn
            .prepare("SELECT json_set(t.payload_json, '$.alias', json_extract(s.payload_json, '$.server.alias'))
              FROM threads t LEFT JOIN thread_states s ON s.user_id=t.user_id AND s.thread_id=t.thread_id
              WHERE t.user_id = ?1 AND COALESCE(json_extract(t.payload_json, '$.visible'), 1) = 1")
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
pub(crate) async fn native_db_namespaces(user_id: i64) -> Result<Vec<Value>, String> {
    super::lifetime::spawn(move || {
        let conn = open()?;
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
    user_id: i64,
    domain: String,
    namespace_id: i64,
) -> Result<(), String> {
    super::lifetime::spawn(move || {
        if namespace_id == 0 {
            return Ok(());
        }
        let mut conn = open()?;
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
    user_id: i64,
) -> Result<Vec<Value>, String> {
    super::lifetime::spawn(move || {
        let conn = open()?;
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
    user_id: i64,
    bucket: String,
    cursor: Option<String>,
    take: i64,
) -> Result<Value, String> {
    super::lifetime::spawn(move || {
        let conn = open()?;
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
                   AND json_extract(payload_json, '$.status') IN ('REQUESTED','ACCEPTED','WITHDRAWN','REJECTED','EXPIRED')
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
                   AND json_extract(payload_json, '$.status') IN ('REQUESTED','ACCEPTED','WITHDRAWN','REJECTED','EXPIRED')",
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
    user_id: i64,
    key: String,
) -> Result<(), String> {
    super::lifetime::spawn(move || {
        let mut conn = open()?;
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
    user_id: i64,
    now: i64,
) -> Result<(), String> {
    super::lifetime::spawn(move || {
        let conn = open()?;
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
    user_id: i64,
    thread_id: i64,
    item: Value,
) -> Result<(), String> {
    super::lifetime::spawn(move || {
        open()?
            .execute(
                "INSERT INTO threads(user_id, thread_id, payload_json) VALUES(?1, ?2, ?3)
                 ON CONFLICT(user_id, thread_id) DO UPDATE SET payload_json = excluded.payload_json
                 WHERE COALESCE(json_extract(threads.payload_json, '$.threadStateFeedId'), 0) <= COALESCE(json_extract(excluded.payload_json, '$.threadStateFeedId'), 0)",
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
    user_id: i64,
    items: Vec<Value>,
) -> Result<(), String> {
    super::lifetime::spawn(move || {
        let mut conn = open()?;
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
pub(crate) async fn native_db_delete_thread(user_id: i64, thread_id: i64) -> Result<(), String> {
    super::lifetime::spawn(move || {
        open()?
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

pub(super) fn begin_group_meta_recovery(
    conn: &mut Connection,
    user_id: i64,
    thread_id: i64,
    through: &str,
) -> Result<(), String> {
    through
        .parse::<u64>()
        .map_err(|_| "invalid group-meta recovery boundary".to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM members WHERE user_id=?1 AND thread_id=?2",
        params![user_id, thread_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("UPDATE threads SET payload_json=json_set(payload_json, '$.group.memberCount', 0, '$.group.groupMetaFeedId', '0', '$.groupMetaRecoveryThrough', ?3, '$.groupMetaRecoveryAnnouncement', null)
      WHERE user_id=?1 AND thread_id=?2 AND json_extract(payload_json, '$.type')='GROUP'", params![user_id, thread_id, through]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn native_db_apply_state_feed_page(
    user_id: i64,
    feed_id: i64,
    items: Vec<ClientStateFeedItem>,
    reset_projection: bool,
) -> Result<(), String> {
    super::lifetime::spawn(move || {
        apply_state_feed_page(
            &mut open()?,
            user_id,
            items,
            feed_id,
            Vec::new(),
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
                object.insert("visible".into(), Value::Bool(false));
                object.remove("threadStateFeedId");
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
        }
    }
    for op in &items {
        if op.event_type.as_deref() == Some("THREAD_STATE") {
            apply_thread_state(
                &tx,
                user_id,
                op.body.as_ref().ok_or("THREAD_STATE has no body")?,
                op.feed_id.ok_or("THREAD_STATE has no feedId")?,
            )?;
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
        if thread
            .as_ref()
            .and_then(|v| v.get("type"))
            .and_then(Value::as_str)
            != Some("GROUP")
            || thread
                .as_ref()
                .and_then(|v| v.get("conversationState"))
                .and_then(Value::as_str)
                == Some("READ_ONLY")
        {
            continue;
        }
        for mut item in update.page.items {
            if item.operation == "GROUP_ANNOUNCEMENT" {
                let text = item.body.get("text").ok_or("GROUP_ANNOUNCEMENT has no text")?;
                if !text.is_null() && !text.as_str().is_some_and(|value| {
                    let count = value.chars().count();
                    (1..=4096).contains(&count)
                }) {
                    return Err("invalid GROUP_ANNOUNCEMENT text".into());
                }
                let announcement = serde_json::json!({ "feedId": item.feed_id, "text": text });
                if update.page.mode == "full" {
                    if let Some(object) = thread.as_mut().and_then(Value::as_object_mut) {
                        object.insert("groupMetaRecoveryAnnouncement".into(), announcement);
                    }
                } else if let Some(group) = thread.as_mut().and_then(|value| value.get_mut("group"))
                    .and_then(Value::as_object_mut) {
                    group.insert("announcement".into(), announcement);
                }
                continue;
            }
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
            tx.execute(
                    "INSERT INTO members(
                       user_id,thread_id,member_account,member_domain,namespace_id,role,left_state,
                       profile_rev,profile_message_seq
                     ) VALUES(?1,?2,?3,?4,?5,?6,0,?7,?8)
                     ON CONFLICT(user_id,thread_id,member_account,member_domain,namespace_id)
                     DO UPDATE SET role=excluded.role,left_state=0,
                       profile_rev=CASE WHEN members.left_state=0 AND members.profile_message_seq IS NOT NULL
                         THEN members.profile_rev ELSE excluded.profile_rev END,
                       profile_message_seq=CASE WHEN members.left_state=0
                         THEN members.profile_message_seq ELSE NULL END",
                    params![
                        user_id, update.thread_id, item.account, item.domain, item.namespace_id,
                        item.body.get("role").and_then(Value::as_str).unwrap_or("MEMBER"),
                        profile_rev,
                        Option::<i64>::None,
                    ],
                ).map_err(|e| format!("upsert group member: {e}"))?;
        }
        if let Some(mut thread) = thread.take() {
            let recovered_announcement = if update.page.mode == "full" && !update.page.has_more {
                Some(thread.get("groupMetaRecoveryAnnouncement").cloned().unwrap_or(Value::Null))
            } else { None };
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
                if !update.page.has_more {
                    object.insert("groupMetaRecoveryThrough".into(), Value::Null);
                    object.remove("groupMetaRecoveryAnnouncement");
                }
            }
            if let Some(group) = thread.get_mut("group").and_then(Value::as_object_mut) {
                group.remove("members");
                if let Some(announcement) = recovered_announcement {
                    group.insert("announcement".into(), announcement);
                }
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
            "THREAD_STATE" => {}
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

pub(super) fn apply_group_meta_page(
    conn: &mut Connection,
    user_id: i64,
    update: ClientGroupMetaApply,
) -> Result<(), String> {
    let feed_id = conn
        .query_row(
            "SELECT CAST(value_json AS INTEGER) FROM sync_state WHERE user_id=?1 AND key='stateFeedId'",
            [user_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| format!("read state-feed cursor for group meta: {e}"))?
        .unwrap_or(0);
    apply_state_feed_page(conn, user_id, Vec::new(), feed_id, vec![update], false)
}

/// The current account's server snapshot is the sole authority for conversation visibility.
pub(super) fn apply_thread_state(
    tx: &rusqlite::Transaction<'_>,
    user_id: i64,
    body: &Value,
    feed_id: i64,
) -> Result<(), String> {
    let thread_id = body
        .get("threadId")
        .and_then(Value::as_i64)
        .filter(|v| *v > 0)
        .ok_or("invalid thread state id")?;
    let kind = body
        .get("type")
        .and_then(Value::as_str)
        .filter(|v| matches!(*v, "P2P" | "GROUP"))
        .ok_or("invalid thread state type")?;
    let state = body
        .get("conversationState")
        .and_then(Value::as_str)
        .filter(|v| matches!(*v, "ACTIVE" | "READ_ONLY"))
        .ok_or("invalid thread state lifecycle")?;
    let profile = body.get("profile").ok_or("thread state profile missing")?;
    profile
        .get("account")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or("invalid profile account")?;
    let domain = profile
        .get("domain")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or("invalid profile domain")?;
    let namespace = profile
        .get("namespaceId")
        .and_then(Value::as_i64)
        .filter(|v| *v >= 0)
        .ok_or("invalid profile namespace")?;
    profile
        .get("profileRev")
        .and_then(Value::as_i64)
        .filter(|v| *v >= 0)
        .ok_or("invalid profile revision")?;
    if body.get("authorityNamespaceId").and_then(Value::as_i64) != Some(namespace)
        || (domain == "local" && namespace != 0)
        || (domain != "local" && namespace == 0)
    {
        return Err("invalid thread authority namespace".into());
    }
    if body.get("role") != Some(&Value::Null)
        && !(kind == "GROUP"
            && matches!(
                body.get("role").and_then(Value::as_str),
                Some("OWNER" | "ADMIN" | "MEMBER")
            ))
    {
        return Err("invalid thread role".into());
    }
    if feed_id < 1 {
        return Err("invalid thread state feed id".into());
    }
    body.get("blocked")
        .and_then(Value::as_bool)
        .ok_or("invalid thread blocked flag")?;
    body.get("establishedAt")
        .and_then(Value::as_i64)
        .filter(|v| *v >= 0)
        .ok_or("invalid establishment time")?;
    if namespace > 0 {
        super::contacts::register_namespace(tx, user_id, namespace, domain)?;
    }
    let previous: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM threads WHERE user_id=?1 AND thread_id=?2",
            params![user_id, thread_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let previous = previous.map(parse_json).transpose()?;
    let thread_feed_id = previous
        .as_ref()
        .and_then(|item| item.get("threadFeedId"))
        .and_then(Value::as_i64);
    let mut thread = previous.filter(|item| item.get("type").and_then(Value::as_str) != Some("PENDING")).unwrap_or_else(|| serde_json::json!({
        "threadId": thread_id, "type": kind, "role": null, "lastMessageAt": null, "lastMessageSeq": null,
        "muted": false, "pinned": false, "pinnedAt": null,
        "lastReadSeq": null, "unreadCount": 0, "mentionUnread": [], "lastMessagePreview": null, "lastMessageSenderId": null
    }));
    if thread
        .get("threadStateFeedId")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        >= feed_id
    {
        return Ok(());
    }
    if thread.get("type").and_then(Value::as_str) != Some(kind) {
        return Err("thread type changed".into());
    }
    let field = if kind == "P2P" { "peerUser" } else { "group" };
    let preserve_message = kind == "P2P"
        && thread
            .get("peerProfileMessageSeq")
            .and_then(Value::as_i64)
            .is_some();
    // Group Meta exclusively owns the materialized group presentation. Relationship state only
    // creates the initial structural reference and must never rewind an already-applied Meta page.
    let preserve_group = kind == "GROUP" && thread.get("group").is_some();
    if !preserve_message && !preserve_group {
        let mut presentation = thread.get(field).cloned().unwrap_or_else(|| serde_json::json!({
            "id": if kind == "GROUP" { thread_id } else { 0 }, "ownerId": 0,
        "createdAt": 0, "updatedAt": 0, "memberCount": 0, "groupMetaFeedId": "0", "isGroup": kind == "GROUP", "isDeleted": false
        }));
        let same = ["account", "domain", "namespaceId", "profileRev"]
            .iter()
            .all(|key| presentation.get(*key) == profile.get(*key));
        let object = presentation
            .as_object_mut()
            .ok_or("invalid thread presentation")?;
        for key in ["account", "domain", "namespaceId", "profileRev"] {
            object.insert(key.into(), profile[key].clone());
        }
        if !same {
            for (key, value) in [
                ("name", ""),
                ("avatar", ""),
                ("bio", ""),
                ("description", ""),
            ] {
                object.insert(key.into(), Value::String(value.into()));
            }
        }
        thread[field] = presentation;
    }
    for key in [
        "authorityNamespaceId",
        "blocked",
        "role",
        "conversationState",
    ] {
        thread[key] = body[key].clone();
    }
    if let Some(thread_feed_id) = thread_feed_id {
        thread["threadFeedId"] = Value::from(thread_feed_id);
    }
    thread["visible"] = Value::Bool(true);
    thread["threadStateFeedId"] = Value::from(feed_id);
    if kind == "P2P" {
        thread["friendshipActive"] = Value::Bool(state == "ACTIVE");
    } else if thread.get("groupMetaRecoveryThrough").is_none() {
        thread["groupMetaRecoveryThrough"] = Value::Null;
    }
    tx.execute("INSERT INTO threads(user_id,thread_id,payload_json) VALUES(?1,?2,?3) ON CONFLICT(user_id,thread_id) DO UPDATE SET payload_json=excluded.payload_json", params![user_id, thread_id, json_text(&thread)?]).map_err(|e| e.to_string())?;
    Ok(())
}
