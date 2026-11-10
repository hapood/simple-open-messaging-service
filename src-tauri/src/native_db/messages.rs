use std::collections::BTreeSet;

#[cfg(test)]
#[path = "../tests/native_deletion_baseline_tests.rs"]
mod deletion_baseline_tests;
#[cfg(test)]
#[path = "../tests/native_history_owner_tests.rs"]
mod owner_tests;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;

fn emit_message_commit(events: &crate::realtime::NativeEvents, user_id: i64, thread_id: i64) {
    let _ = events.emit(
        "soms-sse-event",
        serde_json::json!({
            "event": "LOCAL_MESSAGE_DB_COMMITTED", "status": 0,
            "message": "local message cache committed",
            "data": { "userId": user_id, "threadId": thread_id },
        }),
    );
}

use super::{json_text, parse_json};
use crate::login_connection::DatabaseWork;
use crate::login_request::LoginRequest;
use crate::ServerSessionState;

/// One renderer/native history demand owns all local reads, bootstrap, recovery and page requests.
/// Construct before scheduling the returned history future; no later step resolves a current login.
pub(super) struct NativeHistoryIntent {
    work: DatabaseWork,
    request: LoginRequest,
    events: crate::realtime::NativeEvents,
    user_id: i64,
    thread_id: i64,
}

impl NativeHistoryIntent {
    pub(super) fn capture(
        app: Option<&tauri::AppHandle>,
        proxy: &ServerSessionState,
        user_id: i64,
        thread_id: i64,
    ) -> Result<Self, String> {
        if user_id <= 0 || thread_id <= 0 {
            return Err("native history demand has an invalid owner or thread".into());
        }
        let work = super::capture_database_work()?;
        let request = LoginRequest::capture(proxy, work.owner().clone())?;
        let events = crate::realtime::NativeEvents::for_database_work(app, work.clone());
        work.assert_current().map_err(|e| e.to_string())?;
        Ok(Self {
            work,
            request,
            events,
            user_id,
            thread_id,
        })
    }
}

pub(super) fn normalize_message_creator(message: &mut Value) {
    if let Some(creator) = message.get_mut("creator").and_then(Value::as_object_mut) {
        // Creator is a coordinate-only address, not a display/routing snapshot.
        creator.remove("domain");
    }
}

fn message_tomb(thread_id: i64, seq: i64, reason: &str) -> Result<Value, String> {
    if thread_id <= 0 || seq <= 0 {
        return Err("message has invalid coordinates".into());
    }
    if !matches!(reason, "USER_RETRACTION" | "MODERATION_REMOVAL") {
        return Err("invalid message deletion type".into());
    }
    Ok(serde_json::json!({
        "threadId": thread_id, "seq": seq,
        "contentType": "TOMB", "isDeleted": true, "deletionType": reason,
    }))
}

fn prepare_message(mut message: Value) -> Result<Value, String> {
    let thread_id = message
        .get("threadId")
        .and_then(Value::as_i64)
        .filter(|id| *id > 0)
        .ok_or("message has invalid threadId")?;
    let seq = message_seq(&message, thread_id)?;
    if message.get("contentType").and_then(Value::as_str) == Some("TOMB") {
        let reason = message
            .get("deletionType")
            .and_then(Value::as_str)
            .ok_or("tomb has no deletion type")?;
        return message_tomb(thread_id, seq, reason);
    }
    if message.get("isDeleted").and_then(Value::as_bool) == Some(true) {
        return Err("deleted messages must use the TOMB contract".into());
    }
    normalize_message_creator(&mut message);
    Ok(message)
}

/// No slot reads or merges: deletion feeds replace every matched row with anonymous coordinates.
fn upsert_message_batch(
    tx: &rusqlite::Transaction<'_>,
    user_id: i64,
    messages: &[Value],
) -> Result<(), String> {
    if user_id <= 0 {
        return Err("message has invalid owner".into());
    }
    let mut statement = tx
        .prepare(
            "INSERT INTO messages(user_id, thread_id, seq, created_at, payload_json)
         SELECT ?1, json_extract(value, '$.threadId'), json_extract(value, '$.seq'),
                COALESCE(json_extract(value, '$.createdAt'), 0), value
         FROM json_each(?2) WHERE 1
         ON CONFLICT(user_id, thread_id, seq) DO UPDATE SET
           created_at=excluded.created_at, payload_json=excluded.payload_json",
        )
        .map_err(|e| format!("prepare message batch: {e}"))?;
    // Bound serialized statement size without imposing SQLite's per-variable limit on a page.
    for chunk in messages.chunks(256) {
        statement
            .execute(params![
                user_id,
                serde_json::to_string(chunk).map_err(|e| e.to_string())?
            ])
            .map_err(|e| format!("write message batch: {e}"))?;
    }
    Ok(())
}

/// The login's single SQLite connection mutex encloses this entire read/filter/write transaction,
/// including tomb feeds and body eviction. A second per-thread mutex adds no exclusion. Never move
/// these reads outside the owned database callback or open a parallel physical connection.
fn insert_uncovered_messages(
    tx: &rusqlite::Transaction<'_>,
    user_id: i64,
    thread_id: i64,
    current: &[MessageRange],
    messages: Vec<Value>,
) -> Result<(), String> {
    let mut candidates: Vec<Value> = messages
        .into_iter()
        .filter(|message| {
            let seq = message["seq"]
                .as_i64()
                .expect("validated message coordinate");
            !range_containing(current, seq)
                .is_some_and(|range| range.state == MessageRangeState::LocalCovered)
        })
        .collect();
    let seqs = candidates
        .iter()
        .map(|message| message["seq"].as_i64().unwrap())
        .collect();
    let tombs: BTreeSet<i64> = load_message_deletions(tx, user_id, thread_id, seqs)?
        .into_iter()
        .map(|deletion| deletion.seq)
        .collect();
    candidates.retain(|message| !tombs.contains(&message["seq"].as_i64().unwrap()));
    upsert_message_batch(tx, user_id, &candidates)
}

#[cfg(test)]
#[path = "../tests/native_message_write_tests.rs"]
mod tomb_tests;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MessageCountOwner {
    pub(super) account: String,
    pub(super) namespace_id: i32,
}

/// Count non-self message slots, not sequence distance. Deletion markers are not messages and
/// contribute zero, independently of any identity or timestamp in an incoming server tomb.
pub(super) fn count_unread_message_slots(
    conn: &Connection,
    user_id: i64,
    thread_id: i32,
    after_seq: i32,
    through_seq: i32,
    owner: &MessageCountOwner,
) -> Result<i64, String> {
    if user_id <= 0
        || thread_id <= 0
        || after_seq < 0
        || through_seq < after_seq
        || owner.account.is_empty()
        || owner.namespace_id < 0
    {
        return Err("invalid unread message count range or identity".into());
    }
    let namespace = owner.namespace_id;
    conn.query_row(
        "SELECT COUNT(*) FROM messages
         WHERE user_id=?1 AND thread_id=?2 AND seq>?3 AND seq<=?4
           AND COALESCE(json_extract(payload_json, '$.isDeleted'), 0) != 1
           AND json_type(payload_json, '$.creator') IN ('object', 'null')
           AND NOT COALESCE(
             json_extract(payload_json, '$.creator.account')=?5
             AND json_extract(payload_json, '$.creator.namespaceId')=?6, 0)",
        params![
            user_id,
            thread_id,
            after_seq,
            through_seq,
            owner.account,
            namespace
        ],
        |row| row.get(0),
    )
    .map_err(|e| format!("count unread message slots: {e}"))
}

#[tauri::command]
pub(crate) async fn native_db_count_unread_message_slots(
    user_id: i64,
    thread_id: i32,
    after_seq: i32,
    through_seq: i32,
    owner: MessageCountOwner,
) -> Result<i64, String> {
    super::spawn_login_database(move |conn| {
        count_unread_message_slots(conn, user_id, thread_id, after_seq, through_seq, &owner)
    })
    .await
    .map_err(|e| format!("join unread message count: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_query_messages(
    user_id: i64,
    thread_id: i64,
    anchor: Option<i64>,
    order_by: String,
    take: i64,
) -> Result<Vec<Value>, String> {
    super::spawn_login_database(move |conn| {
        let (sql, bound) = match (order_by.as_str(), anchor) {
            ("desc", Some(anchor)) => (
                "SELECT payload_json FROM messages
                 WHERE user_id = ?1 AND thread_id = ?2 AND seq < ?3
                   AND json_type(payload_json, '$.createdAt') IS NOT NULL
                    AND COALESCE(json_extract(payload_json, '$.isDeleted'), 0) != 1
                 ORDER BY seq DESC LIMIT ?4",
                anchor,
            ),
            ("asc", Some(anchor)) => (
                "SELECT payload_json FROM messages
                 WHERE user_id = ?1 AND thread_id = ?2 AND seq > ?3
                   AND json_type(payload_json, '$.createdAt') IS NOT NULL
                    AND COALESCE(json_extract(payload_json, '$.isDeleted'), 0) != 1
                 ORDER BY seq ASC LIMIT ?4",
                anchor,
            ),
            ("desc", None) => (
                "SELECT payload_json FROM messages
                 WHERE user_id = ?1 AND thread_id = ?2 AND seq <= ?3
                   AND json_type(payload_json, '$.createdAt') IS NOT NULL
                    AND COALESCE(json_extract(payload_json, '$.isDeleted'), 0) != 1
                 ORDER BY seq DESC LIMIT ?4",
                i64::MAX,
            ),
            ("asc", None) => (
                "SELECT payload_json FROM messages
                 WHERE user_id = ?1 AND thread_id = ?2 AND seq >= ?3
                   AND json_type(payload_json, '$.createdAt') IS NOT NULL
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
    pub(super) fn as_str(self) -> &'static str {
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
    pub(crate) thread_id: i64,
    pub(crate) left: i64,
    pub(crate) right: i64,
    pub(crate) state: MessageRangeState,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageInterval {
    pub(crate) left: i64,
    pub(crate) right: i64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerMessageRange {
    pub(crate) left: i64,
    pub(crate) right: i64,
    pub(crate) state: MessageRangeState,
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
    LocalLatest {
        count: i64,
    },
    Latest {
        count: i64,
        known_newest_seq: Option<i64>,
    },
    Around {
        anchor: i64,
        older_count: i64,
        newer_count: i64,
        known_newest_seq: Option<i64>,
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

pub(super) fn load_message_ranges(
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

pub(crate) fn validate_message_ranges(
    thread_id: i64,
    ranges: &[MessageRange],
) -> Result<(), String> {
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

pub(crate) fn reduce_message_ranges(
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
    work: &DatabaseWork,
    request: &mut LoginRequest,
    body: Value,
) -> Result<MessageBackendResponse, String> {
    work.assert_current().map_err(|e| e.to_string())?;
    let body = serde_json::to_vec(&body)
        .map_err(|error| format!("serialize native message query: {error}"))?;
    let cancellation = work.cancellation();
    let response = tokio::select! {
        biased;
        _ = cancellation.cancelled() => {
            work.assert_current().map_err(|e| e.to_string())?;
            return Err("native cache work superseded".into());
        }
        response = request.post_query("/api/v1/query-messages".into(), body) => response?,
    };
    work.assert_current().map_err(|e| e.to_string())?;
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
pub(crate) enum HistoryDirection {
    Older,
    Newer,
}

struct DirectionalWalk {
    items: Vec<NativeHistoryItem>,
    has_more: bool,
}

async fn read_native_message_ranges(
    work: &DatabaseWork,
    user_id: i64,
    thread_id: i64,
) -> Result<Vec<MessageRange>, String> {
    super::spawn_owned_database(Ok(work.clone()), move |conn| {
        load_message_ranges(conn, user_id, thread_id)
    })
    .await
    .map_err(|error| format!("join native message range read: {error}"))?
}

async fn read_native_message_head(
    work: &DatabaseWork,
    user_id: i64,
    thread_id: i64,
) -> Result<Option<i64>, String> {
    super::spawn_owned_database(Ok(work.clone()), move |conn| {
        let head: Option<i64> = conn
            .query_row(
                "SELECT message_head FROM threads WHERE user_id=?1 AND thread_id=?2",
                params![user_id, thread_id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()
            .map_err(|error| format!("read native message head: {error}"))?
            .ok_or("thread message progress is not initialized")?;
        Ok(head)
    })
    .await
    .map_err(|error| format!("join native message head read: {error}"))?
}

async fn query_native_messages(
    work: &DatabaseWork,
    user_id: i64,
    thread_id: i64,
    direction: HistoryDirection,
    cursor: i64,
    boundary: i64,
    take: usize,
) -> Result<Vec<Value>, String> {
    super::spawn_owned_database(Ok(work.clone()), move |conn| {
        let (sql, params) = match direction {
            HistoryDirection::Older => (
                "SELECT payload_json FROM messages
                 WHERE user_id=?1 AND thread_id=?2 AND seq<?3 AND seq>?4
                   AND json_type(payload_json, '$.createdAt') IS NOT NULL
                    AND COALESCE(json_extract(payload_json, '$.isDeleted'), 0) != 1
                 ORDER BY seq DESC LIMIT ?5",
                params![user_id, thread_id, cursor, boundary, take as i64],
            ),
            HistoryDirection::Newer => (
                "SELECT payload_json FROM messages
                 WHERE user_id=?1 AND thread_id=?2 AND seq>?3 AND seq<=?4
                   AND json_type(payload_json, '$.createdAt') IS NOT NULL
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

fn load_live_messages_by_seqs(
    conn: &Connection,
    user_id: i64,
    thread_id: i64,
    seqs: &[i64],
) -> Result<Vec<Value>, String> {
    let mut statement = conn
        .prepare(
            "SELECT payload_json FROM json_each(?3) AS requested
         JOIN messages ON seq=requested.value
         WHERE user_id=?1 AND thread_id=?2
           AND json_type(payload_json, '$.createdAt') IS NOT NULL
           AND COALESCE(json_extract(payload_json, '$.isDeleted'), 0) != 1
         ORDER BY CAST(requested.key AS INTEGER)",
        )
        .map_err(|e| format!("prepare committed message lookup: {e}"))?;
    let rows = statement
        .query_map(
            params![
                user_id,
                thread_id,
                serde_json::to_string(seqs).map_err(|e| e.to_string())?
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| format!("query committed messages: {e}"))?;
    rows.map(|row| {
        row.map_err(|e| format!("read committed message: {e}"))
            .and_then(parse_json)
    })
    .collect()
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

pub(crate) fn history_gap_is_owned(direction: HistoryDirection, seam: i64, gap_right: i64) -> bool {
    match direction {
        HistoryDirection::Older => gap_right < seam,
        HistoryDirection::Newer => gap_right > seam,
    }
}

async fn bootstrap_message_bounds(
    work: &DatabaseWork,
    request: &mut LoginRequest,
    thread_id: i64,
) -> Result<(i64, i64), String> {
    match query_message_backend(work, request, serde_json::json!({ "threadId": thread_id })).await?
    {
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

async fn walk_native_history(
    intent: &mut NativeHistoryIntent,
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
    let work = intent.work.clone();
    let user_id = intent.user_id;
    let thread_id = intent.thread_id;
    work.assert_current().map_err(|e| e.to_string())?;
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
    let mut ranges = read_native_message_ranges(&work, user_id, thread_id).await?;
    let mut items = Vec::new();
    let mut remaining = count as usize;

    for _ in 0..1024 {
        work.assert_current().map_err(|e| e.to_string())?;
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
                        &work, user_id, thread_id, direction, cursor, boundary, remaining,
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
            &work,
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
        let page = match query_message_backend(&work, &mut intent.request, body).await? {
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
            work.clone(),
            user_id,
            thread_id,
            scan,
            page.messages,
            gaps.clone(),
            known_newest,
        )
        .await?;
        work.assert_current().map_err(|e| e.to_string())?;
        emit_message_commit(&intent.events, user_id, thread_id);
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
    work: DatabaseWork,
    user_id: i64,
    thread_id: i64,
    scan: Option<MessageInterval>,
    messages: Vec<Value>,
    gaps: Vec<ServerMessageRange>,
    known_newest_seq: Option<i64>,
) -> Result<CommittedMessagePage, String> {
    super::spawn_owned_database(Ok(work), move |conn| {
        if known_newest_seq.is_some_and(|seq| seq < 0) {
            return Err("known newest message sequence is invalid".to_string());
        }
        if user_id <= 0 || thread_id <= 0 {
            return Err("message page has invalid owner or thread".into());
        }
        // Validate the raw response, including rows that coverage or tombs will later exclude.
        let messages = messages
            .into_iter()
            .map(prepare_message)
            .collect::<Result<Vec<_>, _>>()?;
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
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("begin message page commit: {e}"))?;
        if read_deleted_hwm(&tx, user_id, thread_id)?.is_none() {
            return Err("thread message progress is not initialized".into());
        }
        let current = load_message_ranges(&tx, user_id, thread_id)?;
        let ranges = reduce_message_ranges(thread_id, &current, scan, &gaps, &message_seqs)?;

        insert_uncovered_messages(&tx, user_id, thread_id, &current, messages)?;
        // Return stored live values for response coordinates only: preserve covered local values
        // without exposing deletion markers or adding other cached messages from the scan.
        let committed_messages =
            load_live_messages_by_seqs(&tx, user_id, thread_id, &message_seqs)?;

        tx.execute(
            "DELETE FROM message_ranges WHERE user_id=?1 AND thread_id=?2",
            params![user_id, thread_id],
        )
        .map_err(|e| format!("replace message ranges: {e}"))?;
        tx.execute(
            "INSERT INTO message_ranges(
               user_id, thread_id, left_exclusive, right_inclusive, state
             ) SELECT ?1, ?2, json_extract(value, '$.left'), json_extract(value, '$.right'),
                      json_extract(value, '$.state') FROM json_each(?3)",
            params![
                user_id,
                thread_id,
                serde_json::to_string(&ranges).map_err(|e| e.to_string())?
            ],
        )
        .map_err(|e| format!("insert canonical message ranges: {e}"))?;

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

impl NativeHistoryIntent {
    pub(super) async fn get(
        mut self,
        demand: NativeHistoryDemand,
    ) -> Result<NativeHistoryResult, String> {
        let work = self.work.clone();
        work.assert_current().map_err(|e| e.to_string())?;
        let user_id = self.user_id;
        let thread_id = self.thread_id;
        let lower = 0;
        let validate_count = |count: i64| -> Result<i64, String> {
            if (0..=200).contains(&count) {
                Ok(count)
            } else {
                Err("native history demand count is outside 0..200".to_string())
            }
        };
        let result = match demand {
            NativeHistoryDemand::LocalLatest { count } => {
                let count = validate_count(count)?;
                let mut messages = query_native_messages(
                    &work,
                    user_id,
                    thread_id,
                    HistoryDirection::Older,
                    i64::MAX,
                    0,
                    count as usize,
                )
                .await?;
                messages.reverse();
                Ok(NativeHistoryResult {
                    items: messages
                        .into_iter()
                        .map(|message| NativeHistoryItem::Message { message })
                        .collect(),
                    // Local absence does not establish either server boundary.
                    has_older: true,
                    has_newer: true,
                    failed: false,
                })
            }
            NativeHistoryDemand::Latest {
                count,
                known_newest_seq,
            } => {
                let count = validate_count(count)?;
                let (server_lower, upper) = match known_newest_seq {
                    Some(seq) if seq >= 0 => (lower, seq),
                    Some(_) => {
                        return Err("native latest demand has an invalid newest hint".to_string())
                    }
                    None => bootstrap_message_bounds(&work, &mut self.request, thread_id).await?,
                };
                let lower = lower.max(server_lower);
                let mut page = walk_native_history(
                    &mut self,
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
                known_newest_seq,
            } => {
                if anchor <= 0 {
                    return Err("native around demand has an invalid anchor".to_string());
                }
                let older_count = validate_count(older_count)?;
                let newer_count = validate_count(newer_count)?;
                let (server_lower, upper) = match known_newest_seq {
                    Some(seq) if seq >= 0 => (lower, seq),
                    Some(_) => {
                        return Err("native around demand has an invalid newest hint".to_string())
                    }
                    None => bootstrap_message_bounds(&work, &mut self.request, thread_id).await?,
                };
                let lower = lower.max(server_lower);
                let mut older = walk_native_history(
                    &mut self,
                    HistoryDirection::Older,
                    anchor + 1,
                    older_count,
                    lower,
                    upper,
                    Some(upper),
                )
                .await?;
                let newer = walk_native_history(
                    &mut self,
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
                let known_newest = read_native_message_head(&work, user_id, thread_id).await?;
                let upper = known_newest.unwrap_or(before - 1).max(lower);
                let mut page = walk_native_history(
                    &mut self,
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
                    match read_native_message_head(&work, user_id, thread_id).await? {
                        Some(upper) => (lower, upper),
                        None => {
                            bootstrap_message_bounds(&work, &mut self.request, thread_id).await?
                        }
                    };
                let lower = lower.max(server_lower);
                let page = walk_native_history(
                    &mut self,
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
        };
        work.assert_current().map_err(|e| e.to_string())?;
        result
    }
}

fn put_cached_messages(
    tx: &rusqlite::Transaction<'_>,
    user_id: i64,
    messages: Vec<Value>,
) -> Result<(), String> {
    if user_id <= 0 {
        return Err("message has invalid owner".into());
    }
    let mut by_thread = std::collections::BTreeMap::<i64, Vec<Value>>::new();
    let mut coordinates = BTreeSet::new();
    for message in messages {
        let message = prepare_message(message)?;
        let thread_id = message["threadId"].as_i64().unwrap();
        let seq = message["seq"].as_i64().unwrap();
        if !coordinates.insert((thread_id, seq)) {
            return Err("duplicate cached message coordinate".into());
        }
        by_thread.entry(thread_id).or_default().push(message);
    }
    for (thread_id, messages) in by_thread {
        let current = load_message_ranges(tx, user_id, thread_id)?;
        validate_message_ranges(thread_id, &current)?;
        insert_uncovered_messages(tx, user_id, thread_id, &current, messages)?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn native_db_put_cached_messages(
    app: tauri::AppHandle,
    user_id: i64,
    messages: Vec<Value>,
) -> Result<(), String> {
    let work = super::capture_database_work()?;
    let commit_events = crate::realtime::NativeEvents::for_database_work(Some(&app), work.clone());
    let thread_ids: BTreeSet<i64> = messages
        .iter()
        .filter_map(|message| message.get("threadId").and_then(Value::as_i64))
        .collect();
    super::spawn_owned_database(Ok(work.clone()), move |conn| {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("begin cached message write: {error}"))?;
        put_cached_messages(&tx, user_id, messages)?;
        tx.commit()
            .map_err(|error| format!("commit cached message write: {error}"))
    })
    .await
    .map_err(|error| format!("join cached message write: {error}"))??;
    work.assert_current().map_err(|e| e.to_string())?;
    for thread_id in thread_ids {
        emit_message_commit(&commit_events, user_id, thread_id);
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn native_db_put_message_head(
    user_id: i64,
    thread_id: i64,
    known_newest_seq: i64,
) -> Result<(), String> {
    if user_id <= 0 || thread_id <= 0 || known_newest_seq < 0 {
        return Err("invalid native message head".to_string());
    }
    super::spawn_login_database(move |conn| {
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

pub(super) fn read_deleted_hwm(
    conn: &Connection,
    user_id: i64,
    thread_id: i64,
) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT deleted_hwm FROM threads WHERE user_id=?1 AND thread_id=?2",
        params![user_id, thread_id],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map_err(|e| format!("get deleted hwm: {e}"))
}

#[tauri::command]
pub(crate) async fn native_db_get_deleted_hwm(user_id: i64, thread_id: i64) -> Result<i64, String> {
    super::spawn_login_database(move |conn| {
        read_deleted_hwm(conn, user_id, thread_id)?
            .ok_or_else(|| "thread deletion progress is not initialized".to_string())
    })
    .await
    .map_err(|e| format!("join deleted hwm read: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_apply_deleted_messages(
    user_id: i64,
    thread_id: i64,
    items: Vec<Value>,
    hwm: i64,
) -> Result<(), String> {
    let work = super::capture_database_work()?;
    apply_deleted_messages(work, user_id, thread_id, items, hwm).await
}

/// A tombstone drain applies pages through the login it captured at its start, never the
/// slot's current owner at each page boundary.
pub(super) async fn apply_deleted_messages(
    work: crate::login_connection::DatabaseWork,
    user_id: i64,
    thread_id: i64,
    items: Vec<Value>,
    hwm: i64,
) -> Result<(), String> {
    super::spawn_owned_database(Ok(work), move |conn| {
        if user_id <= 0 || thread_id <= 0 || hwm < 0 {
            return Err("invalid deletion owner, thread or high-water mark".to_string());
        }
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("begin deleted-message write: {e}"))?;
        let mut tombs = Vec::with_capacity(items.len());
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
            let reason = item
                .get("type")
                .and_then(Value::as_str)
                .ok_or_else(|| "deleted message has no deletion type".to_string())?;
            tombs.push(message_tomb(thread_id, message_seq, reason)?);
        }
        upsert_message_batch(&tx, user_id, &tombs)?;
        let updated = tx
            .execute(
                "UPDATE threads SET deleted_hwm=MAX(deleted_hwm,?3)
             WHERE user_id=?1 AND thread_id=?2",
                params![user_id, thread_id, hwm],
            )
            .map_err(|e| format!("advance deleted hwm: {e}"))?;
        if updated != 1 {
            return Err("thread deletion progress is not initialized".to_string());
        }
        tx.commit()
            .map_err(|e| format!("commit deleted-message write: {e}"))
    })
    .await
    .map_err(|e| format!("join deleted-message write: {e}"))?
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
    let updated = tx
        .execute(
            "UPDATE threads SET message_head=CASE
           WHEN message_head IS NULL THEN ?3 ELSE MAX(message_head,?3) END
         WHERE user_id=?1 AND thread_id=?2",
            params![user_id, thread_id, incoming],
        )
        .map_err(|error| format!("put message head: {error}"))?;
    if updated != 1 {
        return Err("thread message progress is not initialized".into());
    }
    Ok(())
}

#[derive(Debug, Eq, PartialEq, Serialize)]
pub(crate) enum MessageDeletionType {
    #[serde(rename = "USER_RETRACTION")]
    UserRetraction,
    #[serde(rename = "MODERATION_REMOVAL")]
    ModerationRemoval,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
pub(crate) struct MessageDeletion {
    pub(crate) seq: i64,
    #[serde(rename = "type")]
    pub(crate) deletion_type: MessageDeletionType,
}

pub(crate) fn load_message_deletions(
    conn: &Connection,
    user_id: i64,
    thread_id: i64,
    seqs: Vec<i64>,
) -> Result<Vec<MessageDeletion>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT seq, json_extract(payload_json, '$.deletionType') FROM messages
             WHERE user_id = ?1 AND thread_id = ?2
             AND seq IN (SELECT value FROM json_each(?3))
             AND json_extract(payload_json, '$.contentType') = 'TOMB'
             ORDER BY seq",
        )
        .map_err(|e| format!("prepare tombstone read: {e}"))?;
    let rows = stmt
        .query_map(
            params![
                user_id,
                thread_id,
                serde_json::to_string(&seqs).map_err(|e| e.to_string())?
            ],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|e| format!("query tombstones: {e}"))?;
    rows.map(|row| {
        let (seq, reason) = row.map_err(|e| format!("read tombstone: {e}"))?;
        let deletion_type = match reason.as_str() {
            "USER_RETRACTION" => MessageDeletionType::UserRetraction,
            "MODERATION_REMOVAL" => MessageDeletionType::ModerationRemoval,
            _ => return Err("stored tomb has invalid deletion type".into()),
        };
        Ok(MessageDeletion { seq, deletion_type })
    })
    .collect()
}

#[tauri::command]
pub(crate) async fn native_db_get_message_deletions(
    user_id: i64,
    thread_id: i64,
    seqs: Vec<i64>,
) -> Result<Vec<MessageDeletion>, String> {
    super::spawn_login_database(move |conn| load_message_deletions(conn, user_id, thread_id, seqs))
        .await
        .map_err(|e| format!("join tombstone read: {e}"))?
}

fn load_origin_message(
    conn: &Connection,
    user_id: i64,
    thread_id: i64,
    namespace_id: i64,
    origin_seq: i64,
) -> Result<Option<Value>, String> {
    let query = if namespace_id == 0 {
        "SELECT payload_json FROM messages WHERE user_id=?1 AND thread_id=?2
         AND ?3=0 AND seq=?4 AND COALESCE(json_extract(payload_json, '$.isDeleted'), 0) != 1"
    } else {
        "SELECT payload_json FROM messages WHERE user_id=?1 AND thread_id=?2
         AND json_extract(payload_json, '$.publisherNamespaceId')=?3
         AND json_extract(payload_json, '$.originSeq')=?4
         AND COALESCE(json_extract(payload_json, '$.isDeleted'), 0) != 1"
    };
    let value = conn
        .query_row(
            query,
            params![user_id, thread_id, namespace_id, origin_seq],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("get origin message: {e}"))?;
    value.map(parse_json).transpose()
}

#[tauri::command]
pub(crate) async fn native_db_get_message_by_origin(
    user_id: i64,
    thread_id: i64,
    namespace_id: i64,
    origin_seq: i64,
) -> Result<Option<Value>, String> {
    if user_id <= 0 || thread_id <= 0 || namespace_id < 0 || origin_seq <= 0 {
        return Err("invalid origin message coordinate".into());
    }
    super::spawn_login_database(move |conn| {
        load_origin_message(conn, user_id, thread_id, namespace_id, origin_seq)
    })
    .await
    .map_err(|e| format!("join origin message read: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_get_message(
    user_id: i64,
    thread_id: i64,
    seq: i64,
) -> Result<Option<Value>, String> {
    super::spawn_login_database(move |conn| {
        let value = conn
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
    user_id: i64,
    thread_ids: Vec<i64>,
) -> Result<Vec<Value>, String> {
    super::spawn_login_database(move |conn| {
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
pub(crate) async fn native_db_correct_system_message_profile(
    user_id: i64,
    thread_id: i64,
    seq: i64,
    account: String,
    publisher_namespace_id: i64,
    profile_namespace_id: i64,
    profile_rev: i64,
) -> Result<bool, String> {
    if user_id < 1
        || thread_id < 1
        || seq < 1
        || account.is_empty()
        || publisher_namespace_id < 0
        || profile_namespace_id < 0
        || profile_rev < 1
    {
        return Err("invalid system profile correction".into());
    }
    super::spawn_login_database(move |conn| {
        correct_system_message_profile(
            conn,
            user_id,
            thread_id,
            seq,
            &account,
            publisher_namespace_id,
            profile_namespace_id,
            profile_rev,
        )
    })
    .await
    .map_err(|e| format!("join system profile correction: {e}"))?
}

fn correct_system_message_profile(
    conn: &mut Connection,
    user_id: i64,
    thread_id: i64,
    seq: i64,
    account: &str,
    publisher_namespace_id: i64,
    profile_namespace_id: i64,
    profile_rev: i64,
) -> Result<bool, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("begin system profile correction: {e}"))?;
    let existing: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM messages WHERE user_id=?1 AND thread_id=?2 AND seq=?3",
            params![user_id, thread_id, seq],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("read system message: {e}"))?;
    let Some(mut message) = existing.map(parse_json).transpose()? else {
        return Ok(false);
    };
    if message.get("contentType").and_then(Value::as_str) != Some("SYSTEM")
        || message.get("isDeleted").and_then(Value::as_bool) == Some(true)
    {
        return Ok(false);
    }
    let participant =
        serde_json::to_string(&(publisher_namespace_id, profile_namespace_id, account))
            .map_err(|e| format!("encode system participant: {e}"))?;
    let revisions = message
        .as_object_mut()
        .ok_or("invalid system message")?
        .entry("localSystemProfileRevs")
        .or_insert_with(|| serde_json::json!({}));
    let map = revisions
        .as_object_mut()
        .ok_or("invalid system profile revisions")?;
    if map.get(&participant).and_then(Value::as_i64) == Some(profile_rev) {
        return Ok(false);
    }
    map.insert(participant, Value::from(profile_rev));
    tx.execute(
        "UPDATE messages SET payload_json=?4 WHERE user_id=?1 AND thread_id=?2 AND seq=?3",
        params![user_id, thread_id, seq, json_text(&message)?],
    )
    .map_err(|e| format!("write system profile correction: {e}"))?;
    tx.commit()
        .map_err(|e| format!("commit system profile correction: {e}"))?;
    Ok(true)
}

#[tauri::command]
pub(crate) async fn native_db_delete_messages_by_thread(
    user_id: i64,
    thread_id: i64,
) -> Result<(), String> {
    let owner = super::login_connections::LOGIN_CONNECTIONS.capture()?;
    tauri::async_runtime::spawn_blocking(move || {
        reset_thread_message_cache(&owner, user_id, thread_id)
    })
    .await
    .map_err(|e| format!("join thread-message delete: {e}"))?
}

fn reset_thread_message_cache(
    owner: &crate::login_connection::LoginConnection,
    user_id: i64,
    thread_id: i64,
) -> Result<(), String> {
    // Tomb stubs are synchronization facts, not disposable bodies. Retain them
    // with the deletion cursor so an in-flight body cannot resurrect a deletion.
    owner
        .with_database(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| format!("begin delete thread messages: {e}"))?;
            tx.execute(
                "DELETE FROM messages WHERE user_id = ?1 AND thread_id = ?2
             AND COALESCE(json_extract(payload_json, '$.contentType'), '') != 'TOMB'",
                params![user_id, thread_id],
            )
            .map_err(|e| format!("delete thread messages: {e}"))?;
            tx.execute(
                "DELETE FROM message_ranges WHERE user_id = ?1 AND thread_id = ?2",
                params![user_id, thread_id],
            )
            .map_err(|e| format!("delete thread message ranges: {e}"))?;
            // Thread-owned progress outlives disposable message bodies.
            tx.commit()
                .map_err(|e| format!("commit delete thread messages: {e}"))
        })
        .map_err(|e| e.to_string())
}
