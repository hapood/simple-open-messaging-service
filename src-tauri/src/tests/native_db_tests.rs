use super::client_state::cleanup_relationship_requests;
use super::messages::load_message_ranges;
use super::relationship_projection::{
    apply_group_request_effect, apply_relationship_intent_fact, apply_relationship_request_effect,
    materialize_group_thread_from_fact, update_live_request_projection,
};
use super::{
    decode_deleted_hwm, history_gap_is_owned, reduce_message_ranges, validate_message_ranges,
    HistoryDirection, MessageInterval, MessageRange, MessageRangeState, ServerMessageRange,
};
use rusqlite::{params, Connection};
use std::time::{SystemTime, UNIX_EPOCH};

fn message_range(left: i64, right: i64, state: MessageRangeState) -> MessageRange {
    MessageRange {
        thread_id: 42,
        left,
        right,
        state,
    }
}

fn server_range(left: i64, right: i64, state: MessageRangeState) -> ServerMessageRange {
    ServerMessageRange { left, right, state }
}

#[test]
fn native_history_gap_item_is_owned_by_the_right_hand_page() {
    assert!(!history_gap_is_owned(HistoryDirection::Older, 26, 30));
    assert!(history_gap_is_owned(HistoryDirection::Newer, 25, 30));
    assert!(history_gap_is_owned(HistoryDirection::Older, 26, 25));
    assert!(!history_gap_is_owned(HistoryDirection::Newer, 25, 25));
}

#[test]
fn native_message_range_reducer_matches_the_browser_state_transitions() {
    use MessageRangeState::{LocalCovered, ServerPending, ServerUnavailable};

    let initial = reduce_message_ranges(
        42,
        &[],
        Some(MessageInterval { left: 9, right: 50 }),
        &[server_range(19, 30, ServerPending)],
        &[10, 50],
    )
    .unwrap();
    assert_eq!(
        initial,
        vec![
            message_range(9, 19, LocalCovered),
            message_range(19, 30, ServerPending),
            message_range(30, 50, LocalCovered),
        ]
    );

    let shrunk = reduce_message_ranges(
        42,
        &initial,
        Some(MessageInterval {
            left: 19,
            right: 30,
        }),
        &[server_range(25, 30, ServerPending)],
        &[20, 25],
    )
    .unwrap();
    assert_eq!(
        shrunk,
        vec![
            message_range(9, 25, LocalCovered),
            message_range(25, 30, ServerPending),
            message_range(30, 50, LocalCovered),
        ]
    );

    let stale = reduce_message_ranges(
        42,
        &shrunk,
        Some(MessageInterval {
            left: 19,
            right: 30,
        }),
        &[server_range(19, 30, ServerPending)],
        &[],
    )
    .unwrap();
    assert_eq!(stale, shrunk);

    let unavailable = reduce_message_ranges(
        42,
        &stale,
        Some(MessageInterval {
            left: 19,
            right: 30,
        }),
        &[server_range(25, 30, ServerUnavailable)],
        &[],
    )
    .unwrap();
    assert_eq!(
        unavailable,
        vec![
            message_range(9, 25, LocalCovered),
            message_range(25, 30, ServerUnavailable),
            message_range(30, 50, LocalCovered),
        ]
    );
    assert_eq!(
        reduce_message_ranges(
            42,
            &unavailable,
            Some(MessageInterval {
                left: 19,
                right: 30,
            }),
            &[server_range(25, 30, ServerPending)],
            &[],
        )
        .unwrap(),
        unavailable
    );
}

#[test]
fn native_message_range_reducer_keeps_full_gap_boundaries_outside_the_scan() {
    assert_eq!(
        reduce_message_ranges(
            42,
            &[],
            Some(MessageInterval {
                left: 10,
                right: 20,
            }),
            &[server_range(14, 35, MessageRangeState::ServerPending)],
            &[11],
        )
        .unwrap(),
        vec![
            message_range(10, 14, MessageRangeState::LocalCovered),
            message_range(14, 35, MessageRangeState::ServerPending),
        ]
    );
}

#[test]
fn native_message_ranges_persist_canonical_reducer_output() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE message_ranges(
           user_id INTEGER NOT NULL,
           thread_id INTEGER NOT NULL,
           left_exclusive INTEGER NOT NULL,
           right_inclusive INTEGER NOT NULL,
           state TEXT NOT NULL,
           PRIMARY KEY(user_id,thread_id,left_exclusive)
         );",
    )
    .unwrap();
    let ranges = [
        MessageRange {
            thread_id: 42,
            left: 9,
            right: 19,
            state: MessageRangeState::LocalCovered,
        },
        MessageRange {
            thread_id: 42,
            left: 19,
            right: 30,
            state: MessageRangeState::ServerPending,
        },
    ];
    validate_message_ranges(42, &ranges).unwrap();
    for range in ranges {
        conn.execute(
            "INSERT INTO message_ranges VALUES(1,?1,?2,?3,?4)",
            params![
                range.thread_id,
                range.left,
                range.right,
                range.state.as_str()
            ],
        )
        .unwrap();
    }
    assert_eq!(load_message_ranges(&conn, 1, 42).unwrap(), ranges);

    let invalid = [
        ranges[0],
        MessageRange {
            state: ranges[0].state,
            ..ranges[1]
        },
    ];
    assert!(validate_message_ranges(42, &invalid).is_err());
}

#[test]
fn deleted_hwm_accepts_only_non_negative_integer_json() {
    assert_eq!(decode_deleted_hwm("12").unwrap(), 12);
    assert!(decode_deleted_hwm("\"12\"").is_err());
    assert!(decode_deleted_hwm("\"0\"").is_err());
    assert!(decode_deleted_hwm("\"012\"").is_err());
    assert!(decode_deleted_hwm("-1").is_err());
}

#[test]
fn native_group_intents_materialize_the_conversation_before_group_meta() {
    let mut conn = request_connection();
    conn.execute_batch(
        "CREATE TABLE threads(
           user_id INTEGER NOT NULL, thread_id INTEGER NOT NULL, payload_json TEXT NOT NULL,
           PRIMARY KEY(user_id, thread_id)
         );",
    )
    .unwrap();
    let group = serde_json::json!({
        "account": "!dev", "domain": "", "isLocal": true, "name": "dev",
        "avatar": "", "description": "", "profileRev": 1
    });
    let tx = conn.transaction().unwrap();
    let active = apply_relationship_intent_fact(
        &tx,
        1,
        0,
        "!dev",
        "",
        "alice",
        "",
        &serde_json::json!({
            "status": "ACCEPTED", "note": "", "requestedAt": 1,
            "expiresAt": null, "threadId": 12, "group": group
        }),
    )
    .unwrap();
    apply_group_request_effect(
        &tx,
        1,
        10,
        0,
        "!dev",
        "",
        "INCOMING",
        &serde_json::json!({
            "status": "ACCEPTED", "note": "", "requestedAt": 1,
            "expiresAt": null, "threadId": 12, "group": group
        }),
    )
    .unwrap();
    materialize_group_thread_from_fact(
        &tx,
        1,
        "!dev",
        "",
        0,
        &serde_json::json!({
            "threadId": 12, "group": group
        }),
        active,
    )
    .unwrap();
    let active = apply_relationship_intent_fact(
        &tx,
        1,
        0,
        "alice",
        "",
        "!dev",
        "",
        &serde_json::json!({
            "status": "ACCEPTED", "note": "", "requestedAt": 1,
            "expiresAt": null, "threadId": 12, "group": group
        }),
    )
    .unwrap();
    apply_group_request_effect(
        &tx,
        1,
        11,
        0,
        "!dev",
        "",
        "OUTGOING",
        &serde_json::json!({
            "status": "ACCEPTED", "note": "", "requestedAt": 1,
            "expiresAt": null, "threadId": 12, "group": group
        }),
    )
    .unwrap();
    materialize_group_thread_from_fact(
        &tx,
        1,
        "!dev",
        "",
        0,
        &serde_json::json!({
            "threadId": 12, "group": group
        }),
        active,
    )
    .unwrap();
    tx.commit().unwrap();

    let payload: String = conn
        .query_row(
            "SELECT payload_json FROM threads WHERE user_id=1 AND thread_id=12",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let thread: serde_json::Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(thread["type"], "GROUP");
    assert_eq!(thread["group"]["account"], "!dev");
}

fn request_connection() -> Connection {
    let conn = Connection::open_in_memory().expect("open request sqlite");
    conn.execute_batch(
        "CREATE TABLE relationship_requests(
           user_id INTEGER NOT NULL, stable_key TEXT NOT NULL, payload_json TEXT NOT NULL,
           PRIMARY KEY(user_id, stable_key)
         );
         CREATE TABLE relationship_intents(
           user_id INTEGER NOT NULL, stable_key TEXT NOT NULL, reverse_key TEXT NOT NULL,
           payload_json TEXT NOT NULL, PRIMARY KEY(user_id, stable_key)
         );
         CREATE TABLE sync_state(
           user_id INTEGER NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
           PRIMARY KEY(user_id, key)
         );",
    )
    .expect("create request schema");
    conn
}

fn friend_body(direction: &str, status: &str, expires_at: Option<i64>) -> serde_json::Value {
    let requested_at = expires_at.map(|value| value - 60_000);
    serde_json::json!({
        "direction": direction,
        "status": status,
        "localThreadId": 7,
        "note": "hello",
        "requestedAt": if status == "REQUESTED" { serde_json::Value::from(requested_at.unwrap()) } else { serde_json::Value::Null },
        "expiresAt": expires_at,
        "peer": {
            "id": 2, "account": "peer", "name": "Peer", "avatar": "", "bio": "",
            "domain": "peer.test"
        }
    })
}

#[test]
fn native_projection_ignores_a_local_revoke_for_a_received_request() {
    let mut conn = request_connection();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let tx = conn.transaction().unwrap();
    apply_relationship_request_effect(
        &tx,
        1,
        10,
        12,
        "peer",
        "peer.test",
        "me",
        "local.test",
        &friend_body("INCOMING", "REQUESTED", Some(now + 60_000)),
    )
    .unwrap();
    apply_relationship_request_effect(
        &tx,
        1,
        11,
        12,
        "me",
        "local.test",
        "peer",
        "peer.test",
        &friend_body("OUTGOING", "REVOKED", None),
    )
    .unwrap();
    tx.commit().unwrap();

    let payload: String = conn
        .query_row(
            "SELECT payload_json FROM relationship_requests",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let projection: serde_json::Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(projection["bucket"], "RECEIVED");
    assert_eq!(projection["status"], "REQUESTED");
    assert_eq!(projection["requestedSort"], now);
    let revision: String = conn
        .query_row(
            "SELECT value_json FROM sync_state WHERE key='relationshipRequestStateRevision'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(revision, "10");
}

#[test]
fn native_projection_persists_a_local_accept_side_effect() {
    let mut conn = request_connection();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let tx = conn.transaction().unwrap();
    apply_relationship_request_effect(
        &tx,
        1,
        10,
        12,
        "peer",
        "peer.test",
        "me",
        "local.test",
        &friend_body("INCOMING", "REQUESTED", Some(now + 60_000)),
    )
    .unwrap();
    let key: String = tx
        .query_row("SELECT stable_key FROM relationship_requests", [], |row| {
            row.get(0)
        })
        .unwrap();
    update_live_request_projection(&tx, 1, &key, "ACCEPTED", now + 1).unwrap();
    tx.commit().unwrap();

    let payload: String = conn
        .query_row(
            "SELECT payload_json FROM relationship_requests",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let projection: serde_json::Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(projection["bucket"], "RECEIVED");
    assert_eq!(projection["direction"], "INCOMING");
    assert_eq!(projection["status"], "ACCEPTED");
}

#[test]
fn native_cleanup_removes_expired_request_projections_after_retention() {
    let conn = request_connection();
    conn.execute(
        "INSERT INTO relationship_requests VALUES(1,'friend:test',?1)",
        [serde_json::json!({
            "direction": "OUTGOING",
            "status": "REQUESTED",
            "expiresAt": 10,
            "updatedAt": 0
        })
        .to_string()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO relationship_requests VALUES(1,'group:test',?1)",
        [serde_json::json!({
            "direction": "INCOMING",
            "status": "REQUESTED",
            "expiresAt": 10,
            "updatedAt": 0
        })
        .to_string()],
    )
    .unwrap();
    cleanup_relationship_requests(&conn, 1, 10).unwrap();

    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM relationship_requests", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        2
    );
    cleanup_relationship_requests(&conn, 1, 604_800_000).unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM relationship_requests", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        0
    );
}

#[test]
fn quote_tombstones_are_scoped_to_user_and_thread() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"CREATE TABLE messages (
        user_id INTEGER, thread_id INTEGER, seq INTEGER, payload_json TEXT,
        PRIMARY KEY(user_id, thread_id, seq)
    );
    INSERT INTO messages VALUES (1, 42, 4, '{"isDeleted":true}');
    INSERT INTO messages VALUES (1, 42, 5, '{"isDeleted":false,"content":"body"}');
    INSERT INTO messages VALUES (1, 42, 6, '{"isDeleted":true,"content":"old"}');
    INSERT INTO messages VALUES (2, 42, 7, '{"isDeleted":true}');
    INSERT INTO messages VALUES (1, 99, 8, '{"isDeleted":true}');"#,
    )
    .unwrap();
    assert_eq!(
        super::messages::load_deleted_message_seqs(&conn, 1, 42, vec![4, 4, 5, 6, 7, 8, 9])
            .unwrap(),
        vec![4, 6]
    );
}

fn profile_cache_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE client_preferences(scope TEXT,key TEXT,value_json TEXT,updated_at INTEGER,PRIMARY KEY(scope,key));").unwrap();
    super::create_cache_schema(&conn).unwrap();
    super::validate_cache_schema(&conn).unwrap();
    conn
}

#[test]
fn native_profiles_keep_exact_revisions_and_local_subject_coordinates() {
    use super::contacts::{register_namespace, write_profile};
    let conn = profile_cache_db();
    register_namespace(&conn, 1, 0, "local").unwrap();
    register_namespace(&conn, 1, 7, "authority.test").unwrap();
    for (domain, namespace, rev, name) in [
        ("local", 7, 3, "New"),
        ("own.test", 0, 2, "Old"),
        ("third.test", 7, 3, "Mirror"),
    ] {
        write_profile(&conn, 1, &serde_json::json!({"account":"alice","domain":domain,"namespaceId":namespace,"profileRev":rev,"name":name,"avatar":"","bio":""})).unwrap();
    }
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM profiles", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 3);
    let names: String = conn.query_row("SELECT group_concat(name, ',') FROM (SELECT json_extract(payload_json,'$.name') name FROM profiles WHERE domain='local' AND namespace_id=0 ORDER BY profile_rev)", [], |row| row.get(0)).unwrap();
    assert_eq!(names, "Old,New");
    let old_tables: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('users','groups')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(old_tables, 0);
}

#[test]
fn native_group_meta_localizes_subjects_preserves_source_and_commits_cursor() {
    let mut conn = profile_cache_db();
    conn.execute("INSERT INTO threads(user_id,thread_id,payload_json) VALUES(1,90,?1)", [serde_json::json!({"threadId":90,"type":"GROUP","authorityNamespaceId":7,"group":{"account":"!mirror","domain":"authority.test","namespaceId":7,"profileRev":1}}).to_string()]).unwrap();
    let page = serde_json::json!([{"threadId":90,"sourceServer":"authority.test","namespaceId":7,"page":{
    "mode":"full","scannedThrough":"3","items":[
        {"operation":"UPSERT","account":"me","domain":"local","namespaceId":7,"body":{"role":"MEMBER","profileRev":2,"profileResolved":false}},
        {"operation":"UPSERT","account":"other","domain":"third.test","namespaceId":7,"body":{"role":"MEMBER","profileRev":2,"displayName":"Other","bio":""}},
        {"operation":"GROUP_PROFILE","body":{"profileRev":4}}
    ]}}]);
    super::client_state::apply_state_feed_page(
        &mut conn,
        1,
        vec![],
        99,
        serde_json::from_value(page).unwrap(),
        false,
    )
    .unwrap();
    let local_ns: i64 = conn
        .query_row(
            "SELECT namespace_id FROM members WHERE member_account='me'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(local_ns, 0);
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM members", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 2);
    let profiles: i64 = conn
        .query_row("SELECT COUNT(*) FROM profiles", [], |row| row.get(0))
        .unwrap();
    assert_eq!(profiles, 1);
    let source: String = conn
        .query_row(
            "SELECT domain FROM namespaces WHERE user_id=1 AND namespace_id=7",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(source, "authority.test");
    let payload: String = conn
        .query_row("SELECT payload_json FROM threads", [], |row| row.get(0))
        .unwrap();
    let thread: serde_json::Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(thread["authorityNamespaceId"], 7);
    assert_eq!(thread["group"]["profileRev"], 4);
    let cursor: String = conn
        .query_row(
            "SELECT value_json FROM sync_state WHERE key='stateFeedId'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(cursor, "99");
}

#[test]
fn native_message_creator_localization_preserves_message_source() {
    let mut message = serde_json::json!({"sourceNamespaceId":7,"creator":{"account":"me","domain":"local","namespaceId":7}});
    super::messages::normalize_message_creator(&mut message);
    assert_eq!(message["creator"]["namespaceId"], 0);
    assert_eq!(message["creator"]["domain"], "local");
    assert_eq!(message["sourceNamespaceId"], 7);
    let mut foreign =
        serde_json::json!({"creator":{"account":"other","domain":"third.test","namespaceId":7}});
    let original = foreign.clone();
    super::messages::normalize_message_creator(&mut foreign);
    assert_eq!(foreign, original);
}
