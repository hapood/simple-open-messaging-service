use std::collections::BTreeSet;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{json_text, open, parse_json};
use crate::{perform_api_request, ProxyState};

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
pub(crate) enum HistoryDirection {
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

pub(crate) fn history_gap_is_owned(direction: HistoryDirection, seam: i64, gap_right: i64) -> bool {
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
    demand: NativeHistoryDemand,
) -> Result<NativeHistoryResult, String> {
    if user_id <= 0 || thread_id <= 0 {
        return Err("native history demand has an invalid owner or thread".to_string());
    }
    let lower = 0;
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

pub(crate) fn decode_deleted_hwm(value_json: &str) -> Result<i64, String> {
    let value: Value =
        serde_json::from_str(value_json).map_err(|e| format!("parse deleted hwm: {e}"))?;
    match value.as_i64() {
        Some(hwm) if hwm >= 0 => Ok(hwm),
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
            Some(value) => decode_deleted_hwm(&value),
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

pub(crate) fn load_deleted_message_seqs(
    conn: &Connection,
    user_id: i64,
    thread_id: i64,
    seqs: Vec<i64>,
) -> Result<Vec<i64>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT seq FROM messages WHERE user_id = ?1 AND thread_id = ?2 AND seq = ?3
             AND json_extract(payload_json, '$.isDeleted') = 1",
        )
        .map_err(|e| format!("prepare tombstone read: {e}"))?;
    let mut deleted = Vec::new();
    for seq in seqs.into_iter().collect::<BTreeSet<_>>() {
        if let Some(seq) = stmt
            .query_row(params![user_id, thread_id, seq], |row| row.get(0))
            .optional()
            .map_err(|e| format!("read tombstone: {e}"))?
        {
            deleted.push(seq);
        }
    }
    Ok(deleted)
}

#[tauri::command]
pub(crate) async fn native_db_get_deleted_message_seqs(
    app: tauri::AppHandle,
    user_id: i64,
    thread_id: i64,
    seqs: Vec<i64>,
) -> Result<Vec<i64>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        load_deleted_message_seqs(&open(&app)?, user_id, thread_id, seqs)
    })
    .await
    .map_err(|e| format!("join tombstone read: {e}"))?
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
