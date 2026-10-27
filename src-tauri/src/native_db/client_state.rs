use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientStateFeedItem {
    pub(super) feed_id: Option<i64>,
    body: IncomingRequestHead,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IncomingRequestHead {
    request_end_id: String,
    request_read_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientGroupMetaApply {
    pub(super) thread_id: i64,
    pub(super) namespace_id: i64,
    pub(super) page: ClientGroupMetaPage,
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
    pub(super) announcement_feed_id: Option<String>,
    pub(super) announcement_text: Option<String>,
    pub(super) announcement_created_at: Option<i64>,
    pub(super) announcement_origin_created_at: Option<i64>,
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
    /// Server copy creation time in epoch milliseconds.
    pub(super) created_at: i64,
    /// Origin publication time; null when the serving server authored the fact.
    pub(super) origin_created_at: Option<i64>,
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
        .prepare("SELECT thread_id FROM threads WHERE user_id=?1 ORDER BY thread_id")
        .map_err(|e| format!("prepare thread read: {e}"))?;
    let rows = stmt
        .query_map([user_id], |row| row.get::<_, i64>(0))
        .map_err(|e| format!("query threads: {e}"))?;
    rows.map(|row| {
        let id = row.map_err(|e| format!("read thread: {e}"))?;
        let mut item = super::thread_store::read(conn, user_id, id)?
            .ok_or("thread structure missing while reading list")?;
        super::thread_store::apply_selected_profile(conn, user_id, id, &mut item)?;
        let object = item.as_object_mut().ok_or("invalid thread structure")?;
        for private_field in [
            "tombstoneEndSeq",
            "serverLastReadSeq",
            "serverUnreadCount",
            "lastMentionSeq",
            "localReadSeq",
        ] {
            object.remove(private_field);
        }
        Ok(item)
    })
    .collect()
}

#[tauri::command]
pub(crate) async fn native_db_threads(user_id: i64) -> Result<Vec<Value>, String> {
    super::spawn_login_database(move |conn| read_threads(conn, user_id))
        .await
        .map_err(|e| format!("join thread read: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_patch_thread(
    user_id: i64,
    thread_id: i64,
    patch: Value,
) -> Result<(), String> {
    super::spawn_login_database(move |conn| {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("begin local thread patch: {e}"))?;
        super::thread_patch::apply(&tx, user_id, thread_id, &patch)?;
        tx.commit()
            .map_err(|e| format!("commit local thread patch: {e}"))
    })
    .await
    .map_err(|e| format!("join local thread patch: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_delete_thread(user_id: i64, thread_id: i64) -> Result<(), String> {
    super::spawn_login_database(move |conn| delete_thread(conn, user_id, thread_id))
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
    let changed = tx
        .execute(
            "UPDATE group_meta SET member_count=0, feed_id='0',
      recovery_through=?3,
      recovery_announcement_feed_id=NULL, recovery_announcement_text=NULL,
      recovery_announcement_created_at=NULL, recovery_announcement_origin_created_at=NULL
      WHERE user_id=?1 AND thread_id=?2",
            params![user_id, thread_id, through],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("stored group thread is missing its meta row".into());
    }
    tx.commit().map_err(|e| e.to_string())
}

pub(super) fn apply_state_feed_page(
    conn: &mut Connection,
    user_id: i64,
    items: Vec<ClientStateFeedItem>,
    feed_id: i64,
    group_meta: Vec<ClientGroupMetaApply>,
) -> Result<Vec<GroupMetaCommitPatch>, String> {
    apply_state_feed_page_with_resume(conn, user_id, items, feed_id, group_meta, None)
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
    full_through: Option<Option<i64>>,
) -> Result<Vec<GroupMetaCommitPatch>, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("begin state-feed page: {e}"))?;
    let mut patches: Vec<GroupMetaCommitPatch> = Vec::new();
    for update in group_meta {
        if update.namespace_id < 0 {
            return Err("group-meta publisher namespace must be non-negative".into());
        }
        if update.page.mode != "full" && update.page.mode != "delta" {
            return Err("group-meta mode must be full or delta".into());
        }
        let mut meta = super::group_meta_store::read(&tx, user_id, update.thread_id)?;
        for item in update.page.items {
            if item.created_at < 0 {
                return Err("group-meta item createdAt must be non-negative".into());
            }
            if let Some(origin) = item.origin_created_at {
                if origin < 0 {
                    return Err("group-meta item originCreatedAt must be non-negative".into());
                }
            }
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
                if update.page.mode == "full" {
                    meta.recovery_announcement_feed_id = Some(item.feed_id);
                    meta.recovery_announcement_text = text.as_str().map(str::to_owned);
                    meta.recovery_announcement_created_at = Some(item.created_at);
                    meta.recovery_announcement_origin_created_at = item.origin_created_at;
                } else {
                    meta.announcement_feed_id = Some(item.feed_id);
                    meta.announcement_text = text.as_str().map(str::to_owned);
                    meta.announcement_created_at = Some(item.created_at);
                    meta.announcement_origin_created_at = item.origin_created_at;
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
        meta.member_count = tx
            .query_row(
                "SELECT COUNT(*) FROM members WHERE user_id=?1 AND thread_id=?2 AND left_state=0",
                params![user_id, update.thread_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("count current group members: {e}"))?;
        if update.page.mode == "full" && !update.page.has_more {
            meta.announcement_feed_id = meta.recovery_announcement_feed_id.take();
            meta.announcement_text = meta.recovery_announcement_text.take();
            meta.announcement_created_at = meta.recovery_announcement_created_at.take();
            meta.announcement_origin_created_at =
                meta.recovery_announcement_origin_created_at.take();
        }
        if !update.page.has_more {
            meta.recovery_through = None;
            meta.recovery_announcement_feed_id = None;
            meta.recovery_announcement_text = None;
            meta.recovery_announcement_created_at = None;
            meta.recovery_announcement_origin_created_at = None;
        }
        meta.feed_id = update.page.scanned_through;
        super::group_meta_store::commit(&tx, user_id, update.thread_id, &meta)?;
        patches.push(GroupMetaCommitPatch {
            thread_id: update.thread_id,
            group_meta_feed_id: meta.feed_id,
            member_count: meta.member_count,
            announcement_feed_id: meta.announcement_feed_id,
            announcement_text: meta.announcement_text,
            announcement_created_at: meta.announcement_created_at,
            announcement_origin_created_at: meta.announcement_origin_created_at,
            group_meta_recovery_through: meta.recovery_through,
        });
    }
    for op in &items {
        let end = super::account_state::request_id_to_sqlite(&op.body.request_end_id)?;
        let read = super::account_state::request_id_to_sqlite(&op.body.request_read_id)?;
        if read > end {
            return Err("request read ID exceeds end ID".into());
        }
        tx.execute(
            "INSERT INTO account_state(user_id,intent_request_end_id,intent_request_read_id)
             VALUES(?1,?2,?3) ON CONFLICT(user_id) DO UPDATE SET
             intent_request_end_id=excluded.intent_request_end_id,
             intent_request_read_id=excluded.intent_request_read_id,
             intent_request_optimistic_read_id=CASE
               WHEN account_state.intent_request_optimistic_read_id <= excluded.intent_request_read_id
               THEN NULL ELSE account_state.intent_request_optimistic_read_id END",
            params![user_id, end, read],
        ).map_err(|e| format!("save incoming request head: {e}"))?;
    }
    match full_through {
        Some(Some(boundary)) if boundary > feed_id => {
            tx.execute(
                "INSERT INTO account_state(user_id,state_feed_full_through) VALUES(?1,?2)
                 ON CONFLICT(user_id) DO UPDATE SET state_feed_full_through=excluded.state_feed_full_through",
                params![user_id, boundary],
            ).map_err(|e| format!("save state-feed full boundary: {e}"))?;
        }
        Some(Some(_)) => return Err("invalid state-feed full boundary".into()),
        Some(None) => {
            tx.execute(
                "UPDATE account_state SET state_feed_full_through=NULL WHERE user_id=?1",
                [user_id],
            )
            .map_err(|e| format!("finish state-feed full snapshot: {e}"))?;
        }
        None => {}
    }
    tx.execute(
        "INSERT INTO account_state(user_id,state_feed_id) VALUES(?1,?2)
             ON CONFLICT(user_id) DO UPDATE SET state_feed_id=excluded.state_feed_id",
        params![user_id, feed_id],
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
            "SELECT COALESCE(state_feed_id,0) FROM account_state WHERE user_id=?1",
            [user_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| format!("read state-feed cursor for group meta: {e}"))?
        .unwrap_or(0);
    let patches = apply_state_feed_page(conn, user_id, Vec::new(), feed_id, vec![update])?;
    Ok(patches.into_iter().next())
}

/// The current account's server snapshot is the sole authority for conversation visibility.
/// Validate established identity or initialize a new thread. Existing rows are
/// updated only by the field-scoped attention/feed commit in the same transaction.
/// Initialize a thread's identity row once from its validated feed snapshot,
/// or verify that a newer feed page kept the conversation identity stable.
/// Older or equal feed positions are no-ops; all other mutations of existing
/// threads go through operation-scoped commits.
pub(super) fn ensure_thread_identity(
    tx: &rusqlite::Transaction<'_>,
    user_id: i64,
    snapshot: &super::attention::ThreadFeedSnapshot,
) -> Result<(), String> {
    let previous: Option<(i64, String, String, i64)> = tx
        .query_row(
            "SELECT thread_feed_id,kind,subject_account,authority_namespace_id
         FROM threads WHERE user_id=?1 AND thread_id=?2",
            params![user_id, snapshot.thread_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|e| format!("read thread identity: {e}"))?;
    if let Some((old_feed, old_kind, old_account, old_namespace)) = previous {
        if old_feed >= i64::from(snapshot.thread_feed_id) {
            return Ok(());
        }
        if old_kind != snapshot.kind {
            return Err("thread type changed".into());
        }
        if old_account != snapshot.subject_account
            || old_namespace != i64::from(snapshot.authority_namespace_id)
        {
            return Err("thread feed changed a conversation identity".into());
        }
        return Ok(());
    }
    super::thread_store::insert(tx, user_id, snapshot, snapshot.last_read_seq)
}
