use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use super::open;
use crate::{proxy::perform_api_request_with_events, ProxyState};

// All native feed consumers share cursor ownership, including notification wakes.
// This is not the cache lifetime lock: network waits must not block account cleanup.
static THREAD_FEED_SYNC: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn feed_request(cursor: i32, through: i32, preview_count: u8) -> Result<Vec<u8>, String> {
    if !matches!(preview_count, 1 | 5) {
        return Err("invalid thread feed preview count".into());
    }
    serde_json::to_vec(&serde_json::json!({
        "after": cursor, "through": through, "take": 100, "previewCount": preview_count,
    }))
    .map_err(|e| format!("encode thread feed request: {e}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadFeedPage {
    items: Vec<ThreadFeedSnapshot>,
    scanned_through: i32,
    through: i32,
    thread_feed_end_id: i32,
    has_more: bool,
}

#[derive(Deserialize)]
struct ThreadFeedResponse {
    code: i32,
    data: Option<ThreadFeedPage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadFeedSyncResult {
    pub(super) states: Vec<LocalThreadAttention>,
    pub(crate) cursor: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

fn validate_page(page: &ThreadFeedPage, after: i32, through: i32) -> Result<(), String> {
    if page.through != through
        || page.scanned_through <= after
        || page.scanned_through > through
        || page.thread_feed_end_id < through
        || (!page.has_more && page.scanned_through != through)
    {
        return Err("invalid thread feed page boundary".into());
    }
    let mut previous = after;
    for state in &page.items {
        validate_snapshot(state)?;
        if state.thread_feed_id <= previous || state.thread_feed_id > page.scanned_through {
            return Err("unordered thread feed page".into());
        }
        previous = state.thread_feed_id;
    }
    Ok(())
}

fn validate_sync_page(
    page: &ThreadFeedPage,
    after: i32,
    through: Option<i32>,
) -> Result<(), String> {
    let empty_poll = through.is_none()
        && page.through == after
        && page.scanned_through == after
        && page.thread_feed_end_id == after
        && page.items.is_empty()
        && !page.has_more;
    if empty_poll {
        Ok(())
    } else {
        validate_page(page, after, through.unwrap_or(page.through))
    }
}

/// The source executor owns HTTP pagination and atomic snapshot/cursor commits without a renderer.
#[tauri::command]
pub(crate) async fn native_thread_feed_sync(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ProxyState>,
    user_id: i64,
    target: i32,
    after: i32,
) -> Result<ThreadFeedSyncResult, String> {
    if after < 0 {
        return Err("invalid applied thread feed cursor".into());
    }
    let epoch = super::lifetime::CACHE_LIFETIME.capture()?;
    let result = sync_thread_feed(Some(&app), &proxy, user_id, target, 1).await?;
    super::lifetime::spawn_at(Ok(epoch), move || {
        let mut changes = read_feed_changes(&mut open()?, user_id, after)?;
        changes.error = result.error;
        Ok(changes)
    })
    .await
    .map_err(|e| format!("join thread feed changes: {e}"))?
}

fn read_feed_changes(
    conn: &mut Connection,
    user_id: i64,
    after: i32,
) -> Result<ThreadFeedSyncResult, String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("begin thread feed changes: {e}"))?;
    let cursor = read_cursor(&tx, user_id)?;
    let states = read_states(&tx, user_id)?
        .into_iter()
        .filter(|state| {
            state.server.as_ref().is_some_and(|server| {
                server.thread_feed_id > after && server.thread_feed_id <= cursor
            })
        })
        .collect();
    tx.commit()
        .map_err(|e| format!("finish thread feed changes: {e}"))?;
    Ok(ThreadFeedSyncResult {
        states,
        cursor,
        error: None,
    })
}

#[tauri::command]
pub(crate) async fn native_thread_feed_changes(
    user_id: i64,
    after: i32,
) -> Result<ThreadFeedSyncResult, String> {
    if user_id <= 0 || after < 0 {
        return Err("invalid thread feed changes request".into());
    }
    super::lifetime::spawn(move || read_feed_changes(&mut open()?, user_id, after))
        .await
        .map_err(|e| format!("join thread feed changes: {e}"))?
}

pub(crate) async fn sync_thread_feed(
    app: Option<&tauri::AppHandle>,
    proxy: &ProxyState,
    user_id: i64,
    target: i32,
    preview_count: u8,
) -> Result<ThreadFeedSyncResult, String> {
    if user_id <= 0 || target < -1 {
        return Err("invalid thread feed owner or target".into());
    }
    let epoch = super::lifetime::CACHE_LIFETIME.capture()?;
    if !matches!(preview_count, 1 | 5) {
        return Err("invalid thread feed preview count".into());
    }
    let _sync = THREAD_FEED_SYNC.lock().await;
    drop(super::lifetime::CACHE_LIFETIME.admit(epoch)?);
    let mut cursor = super::lifetime::spawn_at(Ok(epoch), move || {
        let conn = open()?;
        read_cursor(&conn, user_id)
    })
    .await
    .map_err(|e| format!("join thread feed cursor read: {e}"))??;
    let mut states = BTreeMap::new();
    // Only scheduled polling lacks a wake head. Its first page discovers the server boundary.
    let mut target = (target >= 0).then_some(target);
    let outcome: Result<(), String> = async {
        while target.is_none_or(|target| cursor < target) {
            drop(super::lifetime::CACHE_LIFETIME.admit(epoch)?);
            let through = target;
            let response = perform_api_request_with_events(
                app,
                proxy,
                "POST".into(),
                "/api/v1/thread/feed-delta".into(),
                std::collections::HashMap::from([(
                    "content-type".into(),
                    "application/json".into(),
                )]),
                Some(if let Some(through) = through {
                    feed_request(cursor, through, preview_count)?
                } else {
                    serde_json::to_vec(&serde_json::json!({"after":cursor,"take":100,"previewCount":preview_count})).map_err(|e| e.to_string())?
                }),
                true,
            )
            .await?;
            if !(200..300).contains(&response.status) {
                return Err(format!("thread feed HTTP {}", response.status));
            }
            let envelope: ThreadFeedResponse = serde_json::from_str(&response.body)
                .map_err(|e| format!("decode thread feed response: {e}"))?;
            if envelope.code != 0 {
                return Err("thread feed query failed".into());
            }
            let page = envelope.data.ok_or("missing thread feed page")?;
            validate_sync_page(&page, cursor, through)?;
            let scanned = page.scanned_through;
            let head = page.thread_feed_end_id;
            let merged = super::lifetime::spawn_at(Ok(epoch), move || {
                merge_states(&mut open()?, user_id, page.items, Some(scanned))
            })
            .await
            .map_err(|e| format!("join thread feed merge: {e}"))??;
            for state in merged {
                states.insert(state.thread_id, state);
            }
            cursor = scanned;
            target = Some(target.unwrap_or(head).max(head));
        }
        Ok(())
    }
    .await;
    drop(super::lifetime::CACHE_LIFETIME.admit(epoch)?);
    // A later network failure must not hide earlier committed pages from the live renderer.
    Ok(ThreadFeedSyncResult {
        states: states.into_values().collect(),
        cursor,
        error: outcome.err(),
    })
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ThreadFeedSnapshot {
    pub(super) thread_id: i32,
    pub(super) thread_feed_id: i32,
    pub(super) message_end_seq: i32,
    pub(super) tombstone_end_seq: i32,
    pub(super) group_meta_feed_end_id: Option<String>,
    pub(super) last_read_seq: i32,
    pub(super) unread_count: i32,
    pub(super) last_mention_seq: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) previews: Option<Vec<serde_json::Value>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocalThreadAttention {
    pub(super) thread_id: i32,
    pub(super) server: Option<ThreadFeedSnapshot>,
    pub(super) local_read_seq: Option<i32>,
}

fn validate_snapshot(state: &ThreadFeedSnapshot) -> Result<(), String> {
    if state.thread_id <= 0
        || state.thread_feed_id < 0
        || state.message_end_seq < 0
        || state.tombstone_end_seq < 0
        || state.last_read_seq < 0
        || state.unread_count < 0
        || state.last_mention_seq.is_some_and(|seq| seq <= 0)
    {
        return Err("invalid attention snapshot".into());
    }
    Ok(())
}

pub(super) fn read_state(
    conn: &Connection,
    user_id: i64,
    thread_id: i32,
) -> Result<LocalThreadAttention, String> {
    let payload: Option<String> = conn
        .query_row(
            "SELECT payload_json FROM thread_states WHERE user_id=?1 AND thread_id=?2",
            params![user_id, thread_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("read attention: {e}"))?;
    match payload {
        Some(payload) => {
            serde_json::from_str(&payload).map_err(|e| format!("decode attention: {e}"))
        }
        None => Ok(LocalThreadAttention {
            thread_id,
            server: None,
            local_read_seq: None,
        }),
    }
}

fn write_state(
    conn: &Connection,
    user_id: i64,
    state: &LocalThreadAttention,
) -> Result<(), String> {
    let mut stored = state.clone();
    if let Some(previews) = stored
        .server
        .as_mut()
        .and_then(|server| server.previews.as_mut())
    {
        let latest = previews
            .iter()
            .max_by_key(|preview| preview["seq"].as_i64().unwrap_or(0))
            .cloned();
        *previews = latest.into_iter().collect();
    }
    conn.execute(
        "INSERT OR IGNORE INTO threads(user_id,thread_id,payload_json) VALUES(?1,?2,?3)",
        params![
            user_id,
            state.thread_id,
            serde_json::json!({"threadId": state.thread_id, "type": "PENDING", "visible": false})
                .to_string()
        ],
    )
    .map_err(|e| format!("write pending thread: {e}"))?;
    let payload = serde_json::to_string(&stored).map_err(|e| format!("encode attention: {e}"))?;
    conn.execute(
        "INSERT INTO thread_states(user_id,thread_id,payload_json) VALUES(?1,?2,?3)
         ON CONFLICT(user_id,thread_id) DO UPDATE SET payload_json=excluded.payload_json",
        params![user_id, state.thread_id, payload],
    )
    .map_err(|e| format!("write attention: {e}"))?;
    Ok(())
}

fn merge_states(
    conn: &mut Connection,
    user_id: i64,
    states: Vec<ThreadFeedSnapshot>,
    cursor: Option<i32>,
) -> Result<Vec<LocalThreadAttention>, String> {
    for state in &states {
        validate_snapshot(state)?;
    }
    if cursor.is_some_and(|cursor| cursor < 0) {
        return Err("invalid attention feed cursor".into());
    }
    // Serialize read-modify-write with WebView and background notification writers.
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("begin attention merge: {e}"))?;
    let mut merged = BTreeMap::new();
    for snapshot in states {
        let mut state = read_state(&tx, user_id, snapshot.thread_id)?;
        if state
            .server
            .as_ref()
            .is_none_or(|old| snapshot.thread_feed_id > old.thread_feed_id)
        {
            if state.local_read_seq.is_none() {
                state.local_read_seq = Some(snapshot.last_read_seq);
            }
            state.server = Some(snapshot);
            write_state(&tx, user_id, &state)?;
        }
        merged.insert(state.thread_id, state);
    }
    if let Some(cursor) = cursor {
        tx.execute(
            "INSERT INTO sync_state(user_id,key,value_json) VALUES(?1,'threadFeedCursor',?2)
             ON CONFLICT(user_id,key) DO UPDATE SET value_json=
               CAST(MAX(CAST(sync_state.value_json AS INTEGER),CAST(excluded.value_json AS INTEGER)) AS TEXT)",
            params![user_id, cursor.to_string()],
        ).map_err(|e| format!("write attention cursor: {e}"))?;
    }
    tx.commit()
        .map_err(|e| format!("commit attention merge: {e}"))?;
    Ok(merged.into_values().collect())
}

fn advance_read(
    conn: &mut Connection,
    user_id: i64,
    thread_id: i32,
    seq: i32,
) -> Result<LocalThreadAttention, String> {
    if thread_id <= 0 || seq < 0 {
        return Err("invalid local attention position".into());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("begin attention read: {e}"))?;
    let mut state = read_state(&tx, user_id, thread_id)?;
    if state.local_read_seq.is_none_or(|old| seq > old) {
        state.local_read_seq = Some(seq);
        write_state(&tx, user_id, &state)?;
    }
    tx.commit()
        .map_err(|e| format!("commit attention read: {e}"))?;
    Ok(state)
}

#[tauri::command]
pub(crate) async fn native_db_thread_states(
    user_id: i64,
) -> Result<Vec<LocalThreadAttention>, String> {
    super::lifetime::spawn(move || {
        let conn = open()?;
        read_states(&conn, user_id)
    })
    .await
    .map_err(|e| format!("join attention query: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_merge_thread_states(
    user_id: i64,
    states: Vec<ThreadFeedSnapshot>,
    scanned_through: Option<i32>,
) -> Result<Vec<LocalThreadAttention>, String> {
    super::lifetime::spawn(move || merge_states(&mut open()?, user_id, states, scanned_through))
        .await
        .map_err(|e| format!("join attention merge: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_advance_thread_read(
    user_id: i64,
    thread_id: i32,
    seq: i32,
) -> Result<LocalThreadAttention, String> {
    super::lifetime::spawn(move || advance_read(&mut open()?, user_id, thread_id, seq))
        .await
        .map_err(|e| format!("join attention read: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polling_accepts_an_empty_current_head_but_not_a_stalled_incremental_page() {
        let mut page = ThreadFeedPage {
            items: vec![],
            scanned_through: 5,
            through: 5,
            thread_feed_end_id: 5,
            has_more: false,
        };
        assert!(validate_sync_page(&page, 5, None).is_ok());
        assert!(validate_sync_page(&page, 5, Some(5)).is_err());
        page.has_more = true;
        assert!(validate_sync_page(&page, 5, None).is_err());
        page.has_more = false;
        page.thread_feed_end_id = 6;
        assert!(validate_sync_page(&page, 5, None).is_err());
    }

    #[test]
    fn notification_previews_are_returned_but_only_latest_is_persisted() {
        let mut conn = db();
        let mut snapshot = snapshot(1, 0);
        snapshot.previews = Some(vec![
            serde_json::json!({"seq": 4}),
            serde_json::json!({"seq": 9}),
            serde_json::json!({"seq": 6}),
        ]);
        let merged = merge_states(&mut conn, 1, vec![snapshot], Some(1)).unwrap();
        assert_eq!(
            merged[0]
                .server
                .as_ref()
                .unwrap()
                .previews
                .as_ref()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            read_state(&conn, 1, 7)
                .unwrap()
                .server
                .unwrap()
                .previews
                .unwrap(),
            vec![serde_json::json!({"seq": 9})]
        );
    }

    #[test]
    fn normal_and_notification_requests_share_the_same_feed_contract() {
        for count in [1, 5] {
            let body: serde_json::Value =
                serde_json::from_slice(&feed_request(3, 8, count).unwrap()).unwrap();
            assert_eq!(
                body,
                serde_json::json!({
                    "after": 3, "through": 8, "take": 100, "previewCount": count,
                })
            );
        }
        for count in [0, 2, 6] {
            assert!(feed_request(3, 8, count).is_err());
        }
    }

    #[test]
    fn renderer_reads_background_progress_from_its_own_applied_cursor() {
        let mut conn = db();
        merge_states(&mut conn, 1, vec![snapshot(1, 0)], Some(1)).unwrap();
        merge_states(&mut conn, 1, vec![snapshot(3, 0)], Some(3)).unwrap();
        let changes = read_feed_changes(&mut conn, 1, 1).unwrap();
        assert_eq!(changes.cursor, 3);
        assert_eq!(changes.states.len(), 1);
        assert_eq!(changes.states[0].server.as_ref().unwrap().thread_feed_id, 3);
        assert!(read_feed_changes(&mut conn, 1, 3)
            .unwrap()
            .states
            .is_empty());
        assert!(read_feed_changes(&mut conn, 2, 0)
            .unwrap()
            .states
            .is_empty());
    }

    #[test]
    fn thread_feed_page_requires_progress_and_ordered_compacted_items() {
        let mut page = ThreadFeedPage {
            items: vec![snapshot(1, 0), snapshot(2, 0)],
            scanned_through: 2,
            through: 2,
            thread_feed_end_id: 3,
            has_more: false,
        };
        assert!(validate_page(&page, 0, 2).is_ok());
        page.items.reverse();
        assert!(validate_page(&page, 0, 2).is_err());
        page.items.clear();
        assert!(validate_page(&page, 0, 2).is_ok());
        assert!(validate_page(&page, 2, 2).is_err());
        page.scanned_through = 1;
        assert!(validate_page(&page, 0, 2).is_err());
        page.has_more = true;
        assert!(validate_page(&page, 0, 2).is_ok());
    }

    #[test]
    fn cache_schema_rebuild_recreates_attention_without_preserving_old_rows() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE client_preferences(scope TEXT,key TEXT,value_json TEXT,updated_at INTEGER,PRIMARY KEY(scope,key));").unwrap();
        super::super::create_cache_schema(&conn).unwrap();
        super::super::validate_cache_schema(&conn).unwrap();
        advance_read(&mut conn, 1, 7, 105).unwrap();
        super::super::drop_cache_schema(&conn).unwrap();
        super::super::create_cache_schema(&conn).unwrap();
        super::super::validate_cache_schema(&conn).unwrap();
        assert_eq!(read_state(&conn, 1, 7).unwrap().local_read_seq, None);
    }

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE threads(user_id INTEGER,thread_id INTEGER,payload_json TEXT,PRIMARY KEY(user_id,thread_id)); CREATE TABLE thread_states(user_id INTEGER,thread_id INTEGER,payload_json TEXT,PRIMARY KEY(user_id,thread_id));
            CREATE TABLE sync_state(user_id INTEGER,key TEXT,value_json TEXT,PRIMARY KEY(user_id,key));").unwrap();
        conn
    }
    fn snapshot(feed: i32, seq: i32) -> ThreadFeedSnapshot {
        ThreadFeedSnapshot {
            thread_id: 7,
            thread_feed_id: feed,
            message_end_seq: 200,
            tombstone_end_seq: 0,
            group_meta_feed_end_id: None,
            last_read_seq: seq,
            unread_count: 8,
            last_mention_seq: None,
            previews: None,
        }
    }
    #[test]
    fn snapshot_merge_preserves_local_position_and_orders_by_feed() {
        let mut conn = db();
        advance_read(&mut conn, 1, 7, 105).unwrap();
        for (feed, seq) in [(2, 110), (1, 120), (2, 130), (3, 95)] {
            merge_states(&mut conn, 1, vec![snapshot(feed, seq)], None).unwrap();
        }
        let state = read_state(&conn, 1, 7).unwrap();
        assert_eq!(state.local_read_seq, Some(105));
        assert_eq!(state.server, Some(snapshot(3, 95)));
        assert_eq!(advance_read(&mut conn, 1, 7, 100).unwrap(), state);
        assert_eq!(read_state(&conn, 2, 7).unwrap().server, None);
    }
    #[test]
    fn partial_snapshots_do_not_advance_cursor_and_empty_pages_can() {
        let mut conn = db();
        merge_states(&mut conn, 1, vec![snapshot(50, 100)], None).unwrap();
        let count: i32 = conn
            .query_row("SELECT count(*) FROM sync_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        for cursor in [20, 10, 30] {
            merge_states(&mut conn, 1, vec![], Some(cursor)).unwrap();
        }
        let cursor: String = conn
            .query_row("SELECT value_json FROM sync_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cursor, "30");
        assert_eq!(read_state(&conn, 1, 7).unwrap().local_read_seq, Some(100));
    }
    #[test]
    fn failed_cursor_write_rolls_back_rows() {
        let mut conn = db();
        conn.execute_batch("CREATE TRIGGER fail_cursor BEFORE INSERT ON sync_state BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
        assert!(merge_states(&mut conn, 1, vec![snapshot(1, 100)], Some(1)).is_err());
        assert_eq!(read_state(&conn, 1, 7).unwrap().server, None);
    }
}

fn read_cursor(conn: &Connection, user_id: i64) -> Result<i32, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value_json FROM sync_state WHERE user_id=?1 AND key='threadFeedCursor'",
            [user_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("read thread feed cursor: {e}"))?;
    let cursor = match raw {
        Some(value) => serde_json::from_str::<i32>(&value)
            .map_err(|e| format!("decode thread feed cursor: {e}"))?,
        None => 0,
    };
    if cursor < 0 {
        return Err("invalid local thread feed cursor".into());
    }
    Ok(cursor)
}

fn read_states(conn: &Connection, user_id: i64) -> Result<Vec<LocalThreadAttention>, String> {
    let mut query = conn
        .prepare("SELECT payload_json FROM thread_states WHERE user_id=?1 ORDER BY thread_id")
        .map_err(|e| format!("prepare attention query: {e}"))?;
    let rows = query
        .query_map([user_id], |row| row.get::<_, String>(0))
        .map_err(|e| format!("query attention: {e}"))?;
    rows.map(|row| {
        let payload = row.map_err(|e| format!("read attention row: {e}"))?;
        serde_json::from_str(&payload).map_err(|e| format!("decode attention row: {e}"))
    })
    .collect()
}
