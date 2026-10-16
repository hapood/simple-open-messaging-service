use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;

fn preserve_thread_profile(incoming: &mut Value, current: &Value) {
    if incoming["type"] != current["type"]
        || !matches!(incoming["type"].as_str(), Some("P2P" | "GROUP"))
    {
        return;
    }
    let field = if incoming["type"] == "P2P" {
        "peerUser"
    } else {
        "group"
    };
    if ["account", "namespaceId"]
        .iter()
        .any(|key| incoming[field][*key] != current[field][*key])
        || current["profileRev"].as_i64().unwrap_or(0)
            <= incoming["profileRev"].as_i64().unwrap_or(0)
    {
        return;
    }
    incoming["profileRev"] = current["profileRev"].clone();
    for key in ["name", "avatar", "bio", "description"] {
        if let Some(value) = current[field].get(key) {
            incoming[field][key] = value.clone();
        }
    }
}

use super::open;
use super::relationship_projection::{
    apply_group_request_effect, apply_relationship_request_effect, update_live_request_projection,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientStateFeedItem {
    pub(super) feed_id: Option<i64>,
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
    pub(super) namespace_id: i64,
    pub(super) page: ClientGroupMetaPage,
}

/// One announcement fact exactly as materialized into the thread row.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GroupMetaAnnouncement {
    pub(super) feed_id: String,
    pub(super) text: Option<String>,
}

/// Group Meta facts one committed page materialized into the thread row, carried on the
/// LOCAL_GROUP_META_COMMITTED event so the renderer patches its in-memory conversation
/// without re-reading the database. `group_meta_recovery_through` is the recovery window
/// boundary: present while a full recovery is open, cleared when it completes.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GroupMetaCommitPatch {
    pub(super) thread_id: i64,
    pub(super) group_meta_feed_id: String,
    pub(super) member_count: i64,
    pub(super) announcement: Option<GroupMetaAnnouncement>,
    pub(super) group_meta_recovery_through: Option<String>,
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

pub(super) fn read_threads(conn: &Connection, user_id: i64) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT thread_id,thread_feed_id,thread_profile_rev,alias,
                blocked,conversation_state
         FROM threads WHERE user_id=?1 ORDER BY thread_id",
        )
        .map_err(|e| format!("prepare thread read: {e}"))?;
    let rows = stmt
        .query_map([user_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, bool>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(|e| format!("query threads: {e}"))?;
    rows.map(|row| {
        let (id, feed_id, revision, alias, blocked, lifecycle) =
            row.map_err(|e| format!("read thread: {e}"))?;
        let mut item = super::thread_store::read(conn, user_id, id)?
            .ok_or("thread structure missing while reading list")?;
        super::thread_store::apply_selected_profile(conn, user_id, id, &mut item)?;
        item["threadFeedId"] = feed_id.into();
        item["profileRev"] = revision.into();
        item["alias"] = serde_json::json!(alias);
        item["blocked"] = blocked.into();
        item["conversationState"] = lifecycle.clone().into();
        if lifecycle == "ACTIVE" && item["type"] == "P2P" {
            item["friendshipActive"] = true.into();
        } else if item["type"] == "P2P" {
            item["friendshipActive"] = false.into();
        }
        Ok(item)
    })
    .collect()
}

#[tauri::command]
pub(crate) async fn native_db_threads(user_id: i64) -> Result<Vec<Value>, String> {
    super::lifetime::spawn(move || read_threads(&open()?, user_id))
        .await
        .map_err(|e| format!("join thread read: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_list_relationship_requests(
    user_id: i64,
) -> Result<Vec<Value>, String> {
    super::lifetime::spawn(move || {
        let mut conn = open()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("begin request read: {e}"))?;
        let mut stmt = tx
            .prepare("SELECT stable_key FROM relationship_requests WHERE user_id = ?1")
            .map_err(|e| format!("prepare friend-request read: {e}"))?;
        let keys = stmt
            .query_map([user_id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("query friend intents: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read friend intent keys: {e}"))?;
        drop(stmt);
        let items = keys
            .into_iter()
            .map(|key| {
                super::request_store::read(&tx, user_id, &key)?
                    .ok_or_else(|| format!("request projection disappeared: {key}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        tx.commit()
            .map_err(|e| format!("finish request read: {e}"))?;
        Ok(items)
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
        page_relationship_requests(&mut open()?, user_id, &bucket, cursor.as_deref(), take)
    })
    .await
    .map_err(|e| format!("join paged friend-intent read: {e}"))?
}

pub(super) fn page_relationship_requests(
    conn: &mut Connection,
    user_id: i64,
    bucket: &str,
    cursor: Option<&str>,
    take: i64,
) -> Result<Value, String> {
    let parsed_cursor = cursor
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
    let tx = conn
        .transaction()
        .map_err(|e| format!("begin request page: {e}"))?;
    let mut stmt = tx
        .prepare(
            "SELECT stable_key FROM relationship_requests
                 WHERE user_id = ?1
                   AND bucket = ?2
                   AND status IN ('REQUESTED','ACCEPTED','WITHDRAWN','REJECTED','EXPIRED')
                   AND (?3 = 0 OR requested_sort < ?4
                     OR (requested_sort = ?4 AND stable_key < ?5))
                 ORDER BY requested_sort DESC, stable_key DESC LIMIT ?6",
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
    let keys = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read paged friend intent keys: {e}"))?;
    drop(stmt);
    let items = keys
        .into_iter()
        .map(|key| {
            super::request_store::read(&tx, user_id, &key)?
                .ok_or_else(|| format!("request projection disappeared: {key}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let total = tx
        .query_row(
            "SELECT COUNT(*) FROM relationship_requests
                 WHERE user_id = ?1
                   AND bucket = ?2
                   AND status IN ('REQUESTED','ACCEPTED','WITHDRAWN','REJECTED','EXPIRED')",
            params![user_id, bucket],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("count friend intents: {e}"))?;
    let actionable_total = tx
        .query_row(
            "SELECT COUNT(*) FROM relationship_requests
                 WHERE user_id = ?1
                   AND bucket = ?2
                   AND status = 'REQUESTED'",
            params![user_id, bucket],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("count actionable friend requests: {e}"))?;
    tx.commit()
        .map_err(|e| format!("finish request page: {e}"))?;
    Ok(serde_json::json!({ "items": items, "total": total, "actionableTotal": actionable_total }))
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
               AND updated_at <= ?2 - 604800000",
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
        let mut conn = open()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("begin thread write: {e}"))?;
        let mut item = item;
        let (feed_id, revision) = presentation_state(&tx, user_id, thread_id, &item)?;
        if item
            .get("threadFeedId")
            .and_then(Value::as_i64)
            .is_some_and(|id| id < feed_id)
        {
            return Ok(());
        }
        let mut current = super::thread_store::read(&tx, user_id, thread_id)?
            .ok_or("thread presentation has no matching feed state")?;
        current["profileRev"] = revision.into();
        item["profileRev"] = revision.into();
        preserve_thread_profile(&mut item, &current);
        copy_presentation_state(&mut item, &current);
        super::thread_store::write(&tx, user_id, thread_id, &item)?;
        tx.commit().map_err(|e| format!("commit thread write: {e}"))
    })
    .await
    .map_err(|e| format!("join thread write: {e}"))?
}

fn copy_presentation_state(item: &mut Value, current: &Value) {
    for key in [
        "threadFeedId",
        "conversationState",
        "blocked",
        "role",
        "alias",
        "threadProfileRev",
        "messageEndSeq",
        "tombstoneEndSeq",
        "groupMetaFeedEndId",
        "joinRequestEndFeedId",
        "joinRequestReadFeedId",
        "groupInviteEndFeedId",
        "serverLastReadSeq",
        "announcementReadFeedId",
        "serverUnreadCount",
        "lastMentionSeq",
        "localReadSeq",
    ] {
        item[key] = current[key].clone();
    }
}

/// Presentation writes cannot create a conversation or select a different profile
/// identity/revision than the committed thread-feed row.
fn presentation_state(
    conn: &Connection,
    user_id: i64,
    thread_id: i64,
    item: &Value,
) -> Result<(i64, i64), String> {
    let state: Option<(i64, i64, String, i64, String, i64)> = conn
        .query_row(
            "SELECT thread_feed_id,thread_profile_rev,kind,authority_namespace_id,
                    subject_account,subject_namespace_id
             FROM threads WHERE user_id=?1 AND thread_id=?2",
            params![user_id, thread_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("read stored thread selection: {e}"))?;
    let (feed_id, revision, kind, namespace, account, subject_namespace) =
        state.ok_or("thread presentation has no matching feed state")?;
    let subject = match item.get("type").and_then(Value::as_str) {
        Some("GROUP") => &item["group"],
        Some("P2P") => &item["peerUser"],
        _ => return Err("invalid thread type".into()),
    };
    if item["threadId"].as_i64() != Some(thread_id)
        || item["type"].as_str() != Some(kind.as_str())
        || item["authorityNamespaceId"].as_i64() != Some(namespace)
        || subject["account"].as_str() != Some(account.as_str())
        || subject["namespaceId"].as_i64() != Some(subject_namespace)
    {
        return Err("thread presentation identity differs from feed state".into());
    }
    Ok((feed_id, revision))
}

#[cfg(test)]
mod presentation_state_tests {
    use super::*;

    #[test]
    fn rejects_threads_without_matching_feed_identity() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE threads(
               user_id INTEGER,thread_id INTEGER,thread_feed_id INTEGER,thread_profile_rev INTEGER,
               kind TEXT,authority_namespace_id INTEGER,subject_account TEXT,
               subject_namespace_id INTEGER
             );",
        )
        .unwrap();
        let peer = serde_json::json!({
            "threadId":7,"type":"P2P","authorityNamespaceId":0,
            "peerUser":{"account":"peer","namespaceId":0}
        });
        assert!(presentation_state(&conn, 1, 7, &peer).is_err());
        conn.execute("INSERT INTO threads VALUES(1,7,3,4,'P2P',0,'peer',0)", [])
            .unwrap();
        assert_eq!(presentation_state(&conn, 1, 7, &peer).unwrap(), (3, 4));
        let mut wrong = peer;
        wrong["peerUser"]["domain"] = "display.test".into();
        assert_eq!(presentation_state(&conn, 1, 7, &wrong).unwrap(), (3, 4));
        wrong["peerUser"]["account"] = "other".into();
        assert!(presentation_state(&conn, 1, 7, &wrong).is_err());
    }
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
        let mut previous = std::collections::HashMap::new();
        {
            let mut select = tx
                .prepare("SELECT thread_id FROM threads WHERE user_id=?1")
                .map_err(|e| format!("read previous threads: {e}"))?;
            let ids = select
                .query_map([user_id], |row| row.get::<_, i64>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            for id in ids {
                if let Some(mut item) = super::thread_store::read(&tx, user_id, id)? {
                    let rev: Option<i64> = tx.query_row(
                        "SELECT thread_profile_rev FROM threads WHERE user_id=?1 AND thread_id=?2",
                        params![user_id, id], |row| row.get(0),
                    ).optional().map_err(|e| e.to_string())?;
                    if let Some(rev) = rev {
                        item["profileRev"] = rev.into();
                    }
                    previous.insert(id, item);
                }
            }
        }
        for mut item in items {
            let thread_id = item
                .get("threadId")
                .and_then(Value::as_i64)
                .ok_or_else(|| "thread item has no numeric threadId".to_string())?;
            let (_, revision) = presentation_state(&tx, user_id, thread_id, &item)?;
            let current = previous
                .get(&thread_id)
                .ok_or("thread presentation has no matching feed state")?;
            item["profileRev"] = revision.into();
            preserve_thread_profile(&mut item, current);
            copy_presentation_state(&mut item, current);
            super::thread_store::write(&tx, user_id, thread_id, &item)?;
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
        let mut conn = open()?;
        delete_thread(&mut conn, user_id, thread_id)
    })
    .await
    .map_err(|e| format!("join delete thread: {e}"))?
}

pub(super) fn delete_thread(
    conn: &mut Connection,
    user_id: i64,
    thread_id: i64,
) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("begin delete thread: {e}"))?;
    tx.execute(
        "DELETE FROM thread_previews WHERE user_id=?1 AND thread_id=?2",
        params![user_id, thread_id],
    )
    .map_err(|e| format!("delete thread preview: {e}"))?;
    tx.execute(
        "DELETE FROM members WHERE user_id=?1 AND thread_id=?2",
        params![user_id, thread_id],
    )
    .map_err(|e| format!("delete thread roster: {e}"))?;
    tx.execute(
        "DELETE FROM threads WHERE user_id=?1 AND thread_id=?2",
        params![user_id, thread_id],
    )
    .map_err(|e| format!("delete thread structure: {e}"))?;
    tx.commit()
        .map_err(|e| format!("commit delete thread: {e}"))
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
    tx.execute(
        "UPDATE threads SET group_member_count=0, group_meta_feed_id='0',
      group_meta_recovery_through=?3,
      group_recovery_announcement_feed_id=NULL, group_recovery_announcement_text=NULL
      WHERE user_id=?1 AND thread_id=?2 AND kind='GROUP'",
        params![user_id, thread_id, through],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub(super) fn apply_state_feed_page(
    conn: &mut Connection,
    user_id: i64,
    items: Vec<ClientStateFeedItem>,
    feed_id: i64,
    group_meta: Vec<ClientGroupMetaApply>,
    reset_projection: bool,
) -> Result<Vec<GroupMetaCommitPatch>, String> {
    apply_state_feed_page_with_resume(
        conn,
        user_id,
        items,
        feed_id,
        group_meta,
        reset_projection,
        None,
    )
}

/// The native executor persists its full-snapshot boundary with the page and cursor. `None`
/// leaves this independent recovery marker alone (e.g. a group-meta-only write); `Some(None)`
/// removes it only when the last full page has committed.
pub(super) fn apply_state_feed_page_with_resume(
    conn: &mut Connection,
    user_id: i64,
    items: Vec<ClientStateFeedItem>,
    feed_id: i64,
    group_meta: Vec<ClientGroupMetaApply>,
    reset_projection: bool,
    full_through: Option<Option<i64>>,
) -> Result<Vec<GroupMetaCommitPatch>, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("begin state-feed page: {e}"))?;
    if reset_projection {
        tx.execute(
            "DELETE FROM relationship_requests WHERE user_id=?1",
            [user_id],
        )
        .map_err(|e| format!("clear state-feed friend requests: {e}"))?;
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
    let mut patches: Vec<GroupMetaCommitPatch> = Vec::new();
    for update in group_meta {
        if update.namespace_id < 0 {
            return Err("group-meta publisher namespace must be non-negative".into());
        }
        if update.page.mode != "full" && update.page.mode != "delta" {
            return Err("group-meta mode must be full or delta".into());
        }
        let mut thread = super::thread_store::read(&tx, user_id, update.thread_id)?;
        let lifecycle: Option<String> = tx
            .query_row(
                "SELECT conversation_state FROM threads WHERE user_id=?1 AND thread_id=?2",
                params![user_id, update.thread_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("read group lifecycle: {e}"))?;
        if thread
            .as_ref()
            .and_then(|v| v.get("type"))
            .and_then(Value::as_str)
            != Some("GROUP")
            || lifecycle.as_deref() != Some("ACTIVE")
        {
            continue;
        }
        for item in update.page.items {
            if item.operation == "GROUP_ANNOUNCEMENT" {
                let text = item
                    .body
                    .get("text")
                    .ok_or("GROUP_ANNOUNCEMENT has no text")?;
                if !text.is_null()
                    && !text.as_str().is_some_and(|value| {
                        let count = value.chars().count();
                        (1..=4096).contains(&count)
                    })
                {
                    return Err("invalid GROUP_ANNOUNCEMENT text".into());
                }
                let announcement = serde_json::json!({ "feedId": item.feed_id, "text": text });
                if update.page.mode == "full" {
                    if let Some(object) = thread.as_mut().and_then(Value::as_object_mut) {
                        object.insert("groupMetaRecoveryAnnouncement".into(), announcement);
                    }
                } else if let Some(group) = thread
                    .as_mut()
                    .and_then(|value| value.get_mut("group"))
                    .and_then(Value::as_object_mut)
                {
                    group.insert("announcement".into(), announcement);
                }
                continue;
            }
            if item.operation == "GROUP_PROFILE" {
                item.body
                    .get("profileRev")
                    .and_then(Value::as_i64)
                    .filter(|rev| *rev >= 0)
                    .ok_or("GROUP_PROFILE has no valid profileRev")?;
                // The complete thread feed selects the avatar revision. Meta may
                // arrive first, so it cannot write a competing version into threads.
                continue;
            }
            let body = item.body;
            let account = body
                .get("account")
                .and_then(Value::as_str)
                .ok_or("group-meta member has no account")?;
            let namespace_id = body
                .get("namespaceId")
                .and_then(Value::as_i64)
                .ok_or("group-meta member has no namespaceId")?;
            if account.is_empty() {
                return Err("group-meta member has no subject account".into());
            }
            if namespace_id < 0 {
                return Err("group-meta member namespace must be non-negative".into());
            }
            if item.operation == "MEMBER_DEPART" {
                tx.execute(
                    "UPDATE members SET left_state=1
                         WHERE user_id=?1 AND thread_id=?2 AND member_account=?3
                           AND namespace_id=?4",
                    params![user_id, update.thread_id, account, namespace_id],
                )
                .map_err(|e| format!("depart group member: {e}"))?;
                continue;
            }
            if item.operation != "MEMBER_UPSERT" {
                return Err("group-meta operation must be MEMBER_UPSERT or MEMBER_DEPART".into());
            }
            let profile_rev = body
                .get("profileRev")
                .and_then(Value::as_i64)
                .ok_or_else(|| "group-meta MEMBER_UPSERT has no profileRev".to_string())?;
            tx.execute(
                "INSERT INTO members(
                       user_id,thread_id,member_account,namespace_id,role,left_state,
                       profile_rev
                     ) VALUES(?1,?2,?3,?4,?5,0,?6)
                     ON CONFLICT(user_id,thread_id,member_account,namespace_id)
                     DO UPDATE SET role=excluded.role,left_state=0,
                       profile_rev=excluded.profile_rev",
                params![
                    user_id,
                    update.thread_id,
                    account,
                    namespace_id,
                    body.get("role").and_then(Value::as_str).unwrap_or("MEMBER"),
                    profile_rev,
                ],
            )
            .map_err(|e| format!("upsert group member: {e}"))?;
        }
        if let Some(mut thread) = thread.take() {
            let recovered_announcement = if update.page.mode == "full" && !update.page.has_more {
                Some(
                    thread
                        .get("groupMetaRecoveryAnnouncement")
                        .cloned()
                        .unwrap_or(Value::Null),
                )
            } else {
                None
            };
            let member_count: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM members WHERE user_id=?1 AND thread_id=?2 AND left_state=0",
                    params![user_id, update.thread_id], |row| row.get(0),
                ).map_err(|e| format!("count current group members: {e}"))?;
            if let Some(object) = thread.as_object_mut() {
                // The complete thread feed owns the local user's role. Roster
                // events only update individual member rows, including self.
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
                    Value::String(update.page.scanned_through.clone()),
                );
            }
            super::thread_store::write(&tx, user_id, update.thread_id, &thread)?;
            patches.push(GroupMetaCommitPatch {
                thread_id: update.thread_id,
                group_meta_feed_id: update.page.scanned_through.clone(),
                member_count: member_count.max(0),
                announcement: thread
                    .pointer("/group/announcement")
                    .and_then(Value::as_object)
                    .map(|object| GroupMetaAnnouncement {
                        feed_id: object
                            .get("feedId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        text: object
                            .get("text")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    }),
                group_meta_recovery_through: thread
                    .get("groupMetaRecoveryThrough")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            });
        }
    }
    for op in &items {
        match op.event_type.as_deref().unwrap_or("") {
            "RELATIONSHIP_INTENT" => {}
            "INCOMING_INVITE_HEAD" => {
                let body = op
                    .body
                    .as_ref()
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
    if reset_projection {
        tx.execute(
            "DELETE FROM sync_state WHERE user_id=?1 AND key='relationshipIntentStateRevision'",
            [user_id],
        )
        .map_err(|e| format!("reset relationship intent revision: {e}"))?;
    }
    if let Some(revision) = items
        .iter()
        .filter(|item| item.event_type.as_deref() == Some("RELATIONSHIP_INTENT"))
        .filter_map(|item| item.feed_id)
        .max()
    {
        tx.execute(
            "INSERT INTO sync_state(user_id,key,value_json) VALUES(?1,'relationshipIntentStateRevision',?2)
             ON CONFLICT(user_id,key) DO UPDATE SET value_json=CAST(MAX(CAST(sync_state.value_json AS INTEGER),CAST(excluded.value_json AS INTEGER)) AS TEXT)",
            params![user_id, revision.to_string()],
        ).map_err(|e| format!("save relationship intent revision: {e}"))?;
    }
    match full_through {
        Some(Some(boundary)) if boundary > feed_id => {
            tx.execute(
                "INSERT INTO sync_state(user_id,key,value_json) VALUES(?1,'stateFeedFullThrough',?2)
                 ON CONFLICT(user_id,key) DO UPDATE SET value_json=excluded.value_json",
                params![user_id, boundary.to_string()],
            ).map_err(|e| format!("save state-feed full boundary: {e}"))?;
        }
        Some(Some(_)) => return Err("invalid state-feed full boundary".into()),
        Some(None) => {
            tx.execute(
                "DELETE FROM sync_state WHERE user_id=?1 AND key='stateFeedFullThrough'",
                [user_id],
            )
            .map_err(|e| format!("finish state-feed full snapshot: {e}"))?;
        }
        None => {}
    }
    tx.execute(
        "INSERT INTO sync_state(user_id, key, value_json) VALUES(?1, 'stateFeedId', ?2)
             ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json",
        params![user_id, feed_id.to_string()],
    )
    .map_err(|e| format!("save thread revision: {e}"))?;
    tx.commit()
        .map_err(|e| format!("commit state-feed page: {e}"))?;
    Ok(patches)
}

pub(super) fn apply_group_meta_page(
    conn: &mut Connection,
    user_id: i64,
    update: ClientGroupMetaApply,
) -> Result<Option<GroupMetaCommitPatch>, String> {
    let feed_id = conn
        .query_row(
            "SELECT CAST(value_json AS INTEGER) FROM sync_state WHERE user_id=?1 AND key='stateFeedId'",
            [user_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| format!("read state-feed cursor for group meta: {e}"))?
        .unwrap_or(0);
    let patches = apply_state_feed_page(conn, user_id, Vec::new(), feed_id, vec![update], false)?;
    Ok(patches.into_iter().next())
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
    body.get("selfMentionNamespaceId")
        .ok_or("thread state self mention namespace missing")?;
    let profile = body.get("profile").ok_or("thread state profile missing")?;
    profile
        .get("account")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or("invalid profile account")?;
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
    if body.get("authorityNamespaceId").and_then(Value::as_i64) != Some(namespace) {
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
    let previous = super::thread_store::read(tx, user_id, thread_id)?;
    let old_state: Option<(i64, i64)> = tx.query_row(
        "SELECT thread_feed_id,thread_profile_rev FROM threads WHERE user_id=?1 AND thread_id=?2",
        params![user_id, thread_id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(|e| e.to_string())?;
    let mut thread = previous.unwrap_or_else(|| serde_json::json!({
        "threadId": thread_id, "type": kind, "role": null, "lastMessageAt": null, "lastMessageSeq": null,
        "muted": false, "pinned": false, "pinnedAt": null,
        "lastReadSeq": null, "unreadCount": 0, "mentionUnread": [], "lastMessagePreview": null,
        "lastMessageSenderAccount": null, "lastMessageSenderNamespaceId": null
    }));
    if old_state.is_some_and(|(old_feed, _)| old_feed >= feed_id) {
        return Ok(());
    }
    if let Some((_, revision)) = old_state {
        thread["profileRev"] = revision.into();
    }
    if thread.get("type").and_then(Value::as_str) != Some(kind) {
        return Err("thread type changed".into());
    }
    let field = if kind == "P2P" { "peerUser" } else { "group" };
    let same_address = ["account", "namespaceId"]
        .iter()
        .all(|key| thread[field].get(*key) == profile.get(*key));
    if old_state.is_some() && !same_address {
        return Err("thread feed changed a conversation identity".into());
    }
    let preserve_message = kind == "P2P"
        && same_address
        && (thread
            .get("peerProfileMessageSeq")
            .and_then(Value::as_i64)
            .is_some()
            || thread["profileRev"].as_i64().unwrap_or(0)
                > profile["profileRev"].as_i64().unwrap_or(0));
    // Group Meta exclusively owns the materialized group presentation. Relationship state only
    // creates the initial structural reference and must never rewind an already-applied Meta page.
    let preserve_group = kind == "GROUP" && thread.get("group").is_some();
    if !preserve_message && !preserve_group {
        let mut presentation = thread.get(field).cloned().unwrap_or_else(|| serde_json::json!({
            "id": if kind == "GROUP" { thread_id } else { 0 },
        "createdAt": 0, "updatedAt": 0, "memberCount": 0, "groupMetaFeedId": "0", "isGroup": kind == "GROUP", "isDeleted": false
        }));
        let same = ["account", "namespaceId"]
            .iter()
            .all(|key| presentation.get(*key) == profile.get(*key))
            && thread.get("profileRev") == profile.get("profileRev");
        let object = presentation
            .as_object_mut()
            .ok_or("invalid thread presentation")?;
        for key in ["account", "namespaceId"] {
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
        thread["profileRev"] = profile["profileRev"].clone();
    }
    for key in [
        "authorityNamespaceId",
        "selfMentionNamespaceId",
        "blocked",
        "role",
        "conversationState",
    ] {
        thread[key] = body[key].clone();
    }
    thread["threadFeedId"] = Value::from(feed_id);
    for (stored, wire) in [
        ("alias", "alias"),
        ("threadProfileRev", "threadProfileRev"),
        ("messageEndSeq", "messageEndSeq"),
        ("tombstoneEndSeq", "tombstoneEndSeq"),
        ("groupMetaFeedEndId", "groupMetaFeedEndId"),
        ("joinRequestEndFeedId", "joinRequestEndFeedId"),
        ("joinRequestReadFeedId", "joinRequestReadFeedId"),
        ("groupInviteEndFeedId", "groupInviteEndFeedId"),
        ("serverLastReadSeq", "lastReadSeq"),
        ("announcementReadFeedId", "announcementReadFeedId"),
        ("serverUnreadCount", "unreadCount"),
        ("lastMentionSeq", "lastMentionSeq"),
    ] {
        thread[stored] = body
            .get(wire)
            .ok_or_else(|| format!("thread snapshot has no {wire}"))?
            .clone();
    }
    if old_state.is_none() {
        thread["localReadSeq"] = thread["serverLastReadSeq"].clone();
    }
    thread["visible"] = Value::Bool(true);
    if kind == "P2P" {
        thread["friendshipActive"] = Value::Bool(state == "ACTIVE");
    } else if thread.get("groupMetaRecoveryThrough").is_none() {
        thread["groupMetaRecoveryThrough"] = Value::Null;
    }
    super::thread_store::write(tx, user_id, thread_id, &thread)?;
    Ok(())
}
