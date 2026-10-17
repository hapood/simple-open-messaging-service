use super::client_state::cleanup_relationship_requests;
use super::messages::load_message_ranges;
use super::relationship_projection::{
    apply_group_request_effect, apply_relationship_request_effect, update_live_request_projection,
};
use super::{
    history_gap_is_owned, reduce_message_ranges, validate_message_ranges, HistoryDirection,
    MessageInterval, MessageRange, MessageRangeState, ServerMessageRange,
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

fn test_thread_snapshot(kind: &str, feed: i64, lifecycle: &str) -> serde_json::Value {
    let (account, role) = if kind == "GROUP" {
        ("!dev", serde_json::json!("MEMBER"))
    } else {
        ("bob", serde_json::Value::Null)
    };
    // The wire shape of /thread-feed (shared/thread-attention.ts), not the nested
    // structural shape `apply_thread_state` consumes.
    serde_json::json!({
        "threadId":52,"threadFeedId":feed,"type":kind,"publisherNamespaceId":0,
        "selfMentionNamespaceId": if kind == "GROUP" { serde_json::json!(0) } else { serde_json::Value::Null },
        "conversationState":lifecycle,"blocked":lifecycle == "READ_ONLY","role":role,
        "profileAccount":account,"profileRev":3,
        "alias":null,"messageEndSeq":0,"tombstoneEndSeq":0,
        "groupMetaFeedEndId":null,"joinRequestEndFeedId":0,"joinRequestReadFeedId":-1,
        "groupInviteEndFeedId":0,"lastReadSeq":0,"announcementReadFeedId":0,
        "unreadCount":0,"lastMentionSeq":null,"previews":[],
    })
}

/// Translate a wire thread-feed snapshot into the nested structural shape
/// `client_state::apply_thread_state` consumes (the shape `merge_states` builds).
fn nested_state_body(wire: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "type": wire["type"], "threadId": wire["threadId"],
        "authorityNamespaceId": wire["publisherNamespaceId"],
        "selfMentionNamespaceId": wire["selfMentionNamespaceId"],
        "conversationState": wire["conversationState"], "blocked": wire["blocked"],
        "role": wire["role"],
        "profile": {"account": wire["profileAccount"], "namespaceId": wire["publisherNamespaceId"],
                    "profileRev": wire["profileRev"]},
        "alias": wire["alias"], "threadProfileRev": wire["profileRev"],
        "messageEndSeq": wire["messageEndSeq"], "tombstoneEndSeq": wire["tombstoneEndSeq"],
        "groupMetaFeedEndId": wire["groupMetaFeedEndId"],
        "joinRequestEndFeedId": wire["joinRequestEndFeedId"],
        "joinRequestReadFeedId": wire["joinRequestReadFeedId"],
        "groupInviteEndFeedId": wire["groupInviteEndFeedId"],
        "lastReadSeq": wire["lastReadSeq"], "announcementReadFeedId": wire["announcementReadFeedId"],
        "unreadCount": wire["unreadCount"], "lastMentionSeq": wire["lastMentionSeq"],
    })
}

fn commit_test_thread_state(conn: &mut Connection, body: &serde_json::Value) {
    let tx = conn.transaction().unwrap();
    let nested = nested_state_body(body);
    super::client_state::apply_thread_state(
        &tx,
        1,
        &nested,
        body["threadFeedId"].as_i64().unwrap(),
    )
    .unwrap();
    tx.commit().unwrap();
    let local: super::attention::LocalThreadAttention =
        serde_json::from_value(serde_json::json!({"threadId":52,"server":body,"localReadSeq":0}))
            .unwrap();
    super::attention::write_state(conn, 1, &local).unwrap();
}

#[test]
fn native_thread_state_restores_history_and_ignores_old_snapshots() {
    let mut conn = profile_cache_db();
    commit_test_thread_state(&mut conn, &test_thread_snapshot("P2P", 5, "ACTIVE"));
    conn.execute(
        "UPDATE threads SET last_message_at=900,unread_count=4 WHERE thread_id=52",
        [],
    )
    .unwrap();
    commit_test_thread_state(&mut conn, &test_thread_snapshot("P2P", 6, "READ_ONLY"));
    let mut stale = test_thread_snapshot("P2P", 5, "ACTIVE");
    stale["profileRev"] = 99.into();
    let tx = conn.transaction().unwrap();
    super::client_state::apply_thread_state(&tx, 1, &nested_state_body(&stale), 5).unwrap();
    tx.commit().unwrap();
    let thread = super::client_state::read_threads(&conn, 1)
        .unwrap()
        .remove(0);
    assert_eq!(thread["conversationState"], "READ_ONLY");
    assert_eq!(thread["profileRev"], 3);
    assert_eq!(thread["blocked"], true);
    assert_eq!(thread["lastMessageAt"], 900);
    assert_eq!(thread["unreadCount"], 4);
}

#[test]
fn native_read_only_and_reestablishment_preserve_group_roster() {
    let mut conn = profile_cache_db();
    commit_test_thread_state(&mut conn, &test_thread_snapshot("GROUP", 5, "ACTIVE"));
    conn.execute(
        "INSERT INTO members(user_id,thread_id,member_account,namespace_id,role)
         VALUES(1,52,'bob',0,'MEMBER')",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE threads SET group_member_count=1,group_meta_feed_id='20'
        WHERE thread_id=52",
        [],
    )
    .unwrap();
    for (feed, lifecycle) in [(6, "READ_ONLY"), (7, "ACTIVE")] {
        commit_test_thread_state(&mut conn, &test_thread_snapshot("GROUP", feed, lifecycle));
        if lifecycle == "READ_ONLY" {
            let retained = super::thread_store::read(&conn, 1, 52).unwrap();
            super::client_state::begin_group_meta_recovery(&mut conn, 1, 52, "21").unwrap();
            let page = serde_json::from_value(serde_json::json!({
                "threadId":52,"namespaceId":0,"page":{
                    "account":"!dev","mode":"full","items":[],
                    "hasMore":false,"scannedThrough":"21","groupMetaFeedEndId":"21"
                }
            }))
            .unwrap();
            assert!(
                super::client_state::apply_group_meta_page(&mut conn, 1, page)
                    .unwrap()
                    .is_none()
            );
            assert_eq!(super::thread_store::read(&conn, 1, 52).unwrap(), retained);
        }
        let thread = super::thread_store::read(&conn, 1, 52).unwrap().unwrap();
        assert_eq!(thread["group"]["memberCount"], 1);
        assert_eq!(thread["group"]["groupMetaFeedId"], "20");
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM members", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    super::client_state::begin_group_meta_recovery(&mut conn, 1, 52, "21").unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM members", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    let thread = super::thread_store::read(&conn, 1, 52).unwrap().unwrap();
    assert_eq!(thread["group"]["groupMetaFeedId"], "0");
}

#[test]
fn deleting_a_thread_clears_its_state_preview_and_roster_together() {
    let mut conn = profile_cache_db();
    let mut snapshot = test_thread_snapshot("GROUP", 5, "ACTIVE");
    snapshot["previews"] = serde_json::json!([{
        "seq": 2, "createdAt": "2026-01-01T00:00:00Z",
        "sender": {"account":"bob","profileNamespaceId":0,"profileRev":1},
        "status":"LIVE", "text":"hello"
    }]);
    commit_test_thread_state(&mut conn, &snapshot);
    conn.execute(
        "INSERT INTO members(user_id,thread_id,member_account,namespace_id,role)
         VALUES(1,52,'bob',0,'MEMBER')",
        [],
    )
    .unwrap();
    super::client_state::delete_thread(&mut conn, 1, 52).unwrap();
    for table in ["threads", "thread_previews", "members"] {
        let count: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE user_id=1 AND thread_id=52"),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "{table} retained an orphan row");
    }
}

fn request_connection() -> Connection {
    profile_cache_db()
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

    let key: String = conn
        .query_row("SELECT stable_key FROM relationship_requests", [], |row| {
            row.get(0)
        })
        .unwrap();
    let projection = super::request_store::read(&conn, 1, &key).unwrap().unwrap();
    assert_eq!(projection["bucket"], "RECEIVED");
    assert_eq!(projection["status"], "REQUESTED");
    assert_eq!(projection["requestedSort"], now);
    assert_eq!(
        projection["peer"],
        serde_json::json!({
            "id":2, "account":"peer", "domain":"peer.test", "namespaceId":12,
            "name":"Peer", "avatar":"", "bio":"",
        })
    );
    assert!(projection.get("group").is_none());
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

    let projection = super::request_store::read(&conn, 1, &key).unwrap().unwrap();
    assert_eq!(projection["bucket"], "RECEIVED");
    assert_eq!(projection["direction"], "INCOMING");
    assert_eq!(projection["status"], "ACCEPTED");
    let page = super::client_state::page_relationship_requests(&mut conn, 1, "RECEIVED", None, 10)
        .unwrap();
    assert_eq!(page["total"], 1);
    assert_eq!(page["actionableTotal"], 0);
    assert_eq!(page["items"][0], projection);
}

#[test]
fn native_projection_uses_request_metadata_for_revocation() {
    let mut conn = request_connection();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let tx = conn.transaction().unwrap();
    apply_relationship_request_effect(
        &tx,
        1,
        1,
        12,
        "peer",
        "peer.test",
        "me",
        "local.test",
        &friend_body("INCOMING", "REQUESTED", Some(now + 60_000)),
    )
    .unwrap();
    let mut body = friend_body("OUTGOING", "REVOKED", None);
    body["requestStatus"] = serde_json::json!("REJECTED");
    body["requestDirection"] = serde_json::json!("INCOMING");
    apply_relationship_request_effect(
        &tx,
        1,
        1,
        12,
        "me",
        "local.test",
        "peer",
        "peer.test",
        &body,
    )
    .unwrap();
    tx.commit().unwrap();

    let key: String = conn
        .query_row("SELECT stable_key FROM relationship_requests", [], |row| {
            row.get(0)
        })
        .unwrap();
    let projection = super::request_store::read(&conn, 1, &key).unwrap().unwrap();
    assert_eq!(projection["status"], "REJECTED");
}

#[test]
fn native_group_request_projection_reconstructs_typed_subject() {
    let mut conn = request_connection();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let tx = conn.transaction().unwrap();
    apply_group_request_effect(
        &tx,
        1,
        4,
        12,
        "!team",
        "remote.test",
        "INCOMING",
        &serde_json::json!({
            "status": "REQUESTED", "requestedAt": now, "expiresAt": now + 60_000,
            "threadId": 42, "note": "Welcome", "group": {
                "account": "!team", "domain": "remote.test", "isLocal": false,
                "name": "Team", "avatar": "", "description": "About",
                "profileRev": 3
            }
        }),
    )
    .unwrap();
    tx.commit().unwrap();
    let key: String = conn
        .query_row("SELECT stable_key FROM relationship_requests", [], |row| {
            row.get(0)
        })
        .unwrap();
    let value = super::request_store::read(&conn, 1, &key).unwrap().unwrap();
    assert_eq!(
        value["group"],
        serde_json::json!({
            "account":"!team", "domain":"remote.test", "namespaceId":12,
            "isLocal":false, "name":"Team", "avatar":"", "description":"About",
            "profileRev":3,
        })
    );
    assert_eq!(value["sourceLabel"], "remote.test");
    assert!(value.get("peer").is_none());
    let page = super::client_state::page_relationship_requests(&mut conn, 1, "RECEIVED", None, 10)
        .unwrap();
    assert_eq!(page["total"], 1);
    assert_eq!(page["actionableTotal"], 1);
    assert_eq!(page["items"][0], value);
    let columns = conn
        .prepare("PRAGMA table_info(relationship_requests)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(!columns.contains(&"payload_json".to_string()));
}

#[test]
fn native_cleanup_removes_expired_request_projections_after_retention() {
    let conn = request_connection();
    for (key, kind, direction) in [
        ("friend:test", "FRIEND", "OUTGOING"),
        ("group:test", "GROUP", "INCOMING"),
    ] {
        conn.execute(
            "INSERT INTO relationship_requests(user_id,stable_key,namespace_id,kind,bucket,direction,status,expires_at,note,requested_at,requested_sort,updated_at)
             VALUES(1,?1,0,?2,'SENT',?3,'REQUESTED',10,'',0,0,0)",
            rusqlite::params![key, kind, direction],
        ).unwrap();
    }
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
    INSERT INTO messages VALUES (1, 42, 4, '{"isDeleted":true,"contentType":"TOMB","deletionType":"USER_RETRACTION"}');
    INSERT INTO messages VALUES (1, 42, 5, '{"isDeleted":false,"content":"body"}');
    INSERT INTO messages VALUES (1, 42, 6, '{"isDeleted":true,"contentType":"TOMB","deletionType":"MODERATION_REMOVAL"}');
    INSERT INTO messages VALUES (2, 42, 7, '{"isDeleted":true,"contentType":"TOMB","deletionType":"USER_RETRACTION"}');
    INSERT INTO messages VALUES (1, 99, 8, '{"isDeleted":true,"contentType":"TOMB","deletionType":"USER_RETRACTION"}');"#,
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
fn old_message_cache_is_rejected_and_rebuilt_without_importing_bodies() {
    let conn = profile_cache_db();
    conn.execute_batch(
        "UPDATE client_preferences SET value_json='19' WHERE scope='cache' AND key='schemaVersion';
         INSERT INTO messages VALUES(1,42,4,100,'{\"isDeleted\":true,\"content\":\"old body\"}');",
    )
    .unwrap();
    assert!(super::validate_cache_schema(&conn)
        .unwrap_err()
        .contains("schema version mismatch"));
    super::drop_cache_schema(&conn).unwrap();
    super::create_cache_schema(&conn).unwrap();
    super::validate_cache_schema(&conn).unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM messages", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn native_profiles_keep_exact_revisions_and_local_subject_coordinates() {
    use super::contacts::{read_profile, register_namespace, write_profile};
    let conn = profile_cache_db();
    register_namespace(&conn, 1, 0, "own.test").unwrap();
    register_namespace(&conn, 1, 7, "authority.test").unwrap();
    for (domain, publisher, profile_namespace, rev, name) in [
        ("authority.test", 7, 0, 3, "New"),
        ("own.test", 0, 0, 2, "Old"),
        ("third.test", 7, 8, 3, "Mirror"),
    ] {
        write_profile(&conn, 1, &serde_json::json!({"account":"alice","domain":domain,"publisherNamespaceId":publisher,"profileNamespaceId":profile_namespace,"profileRev":rev,"name":name,"avatarDigest":null,"bio":""})).unwrap();
    }
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM profiles", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 3);
    let names: String = conn.query_row("SELECT group_concat(profile.name, ',' ORDER BY profile.profile_rev) FROM profiles profile WHERE profile.profile_namespace_id=0", [], |row| row.get(0)).unwrap();
    assert_eq!(names, "Old,New");
    let revision = read_profile(&conn, 1, 7, 0, "alice", 3).unwrap().unwrap();
    assert_eq!(
        revision,
        serde_json::json!({
            "account":"alice", "domain":"authority.test", "namespaceId":0,
            "publisherNamespaceId":7, "profileNamespaceId":0,
            "profileRev":3, "name":"New", "avatarDigest":null, "bio":"",
        })
    );
    assert!(!write_profile(&conn, 1, &revision).unwrap());
    let mut conflict = revision;
    conflict["name"] = serde_json::json!("Changed");
    assert!(write_profile(&conn, 1, &conflict).is_err());
    let columns = conn
        .prepare("PRAGMA table_info(profiles)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(!columns.contains(&"payload_json".to_string()));
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
fn native_profile_cache_rejects_missing_text_instead_of_synthesizing_it() {
    let conn = profile_cache_db();
    for missing in ["name", "bio"] {
        let mut profile = serde_json::json!({"account":"alice","domain":"local","namespaceId":0,"profileRev":1,"name":"Alice","avatarDigest":null,"bio":""});
        profile.as_object_mut().unwrap().remove(missing);
        assert!(super::contacts::write_profile(&conn, 1, &profile).is_err());
    }
    let count: i64 = conn
        .query_row("SELECT count(*) FROM profiles", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn native_profile_cache_rejects_a_different_avatar_for_one_revision() {
    let conn = profile_cache_db();
    super::contacts::register_namespace(&conn, 1, 0, "local").unwrap();
    let profile = serde_json::json!({"account":"alice","domain":"local","publisherNamespaceId":0,"profileNamespaceId":0,
        "profileRev":1,"name":"Alice","avatarDigest":"a","bio":""});
    assert!(super::contacts::write_profile(&conn, 1, &profile).unwrap());
    let changed = serde_json::json!({"account":"alice","domain":"local","publisherNamespaceId":0,"profileNamespaceId":0,
        "profileRev":1,"name":"Alice","avatarDigest":null,"bio":""});
    assert!(super::contacts::write_profile(&conn, 1, &changed).is_err());
}

#[test]
fn native_group_meta_preserves_member_addresses_and_commits_cursor() {
    let mut conn = profile_cache_db();
    let body = serde_json::json!({
        "threadId":90,"threadFeedId":1,"type":"GROUP","publisherNamespaceId":7,
        "selfMentionNamespaceId":12,
        "conversationState":"ACTIVE","blocked":false,"role":"MEMBER",
        "profileAccount":"!mirror","profileRev":0,
        "alias":null,"messageEndSeq":0,"tombstoneEndSeq":0,
        "groupMetaFeedEndId":null,"joinRequestEndFeedId":0,"joinRequestReadFeedId":-1,
        "groupInviteEndFeedId":0,"lastReadSeq":0,"announcementReadFeedId":0,
        "unreadCount":0,"lastMentionSeq":null,"previews":[],
    });
    let tx = conn.transaction().unwrap();
    super::client_state::apply_thread_state(&tx, 1, &nested_state_body(&body), 1).unwrap();
    tx.commit().unwrap();
    let local: super::attention::LocalThreadAttention =
        serde_json::from_value(serde_json::json!({"threadId":90,"server":body,"localReadSeq":0}))
            .unwrap();
    super::attention::write_state(&conn, 1, &local).unwrap();
    let page = serde_json::json!([{"threadId":90,"namespaceId":7,"page":{
    "mode":"full","scannedThrough":"3","items":[
        {"feedId":"1","operation":"MEMBER_UPSERT","body":{"account":"me","namespaceId":0,"role":"ADMIN","profileRev":2}},
        {"feedId":"2","operation":"MEMBER_UPSERT","body":{"account":"other","namespaceId":7,"role":"MEMBER","profileRev":2}},
        {"feedId":"3","operation":"GROUP_PROFILE","body":{"account":"!mirror","namespaceId":7,"profileRev":4}}
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
    let home_binding: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM profile_namespaces WHERE user_id=1 AND publisher_namespace_id=0 AND profile_namespace_id=0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(home_binding, 0);
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM members", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 2);
    let profiles: i64 = conn
        .query_row("SELECT COUNT(*) FROM profiles", [], |row| row.get(0))
        .unwrap();
    assert_eq!(profiles, 0);
    let source_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM profile_namespaces WHERE user_id=1 AND publisher_namespace_id=7 AND profile_namespace_id=7",
            [],
            |row| row.get(0),
        )
        .unwrap();
    // Coordinate-only feed and roster references do not invent display bindings.
    assert_eq!(source_count, 0);
    let thread = super::thread_store::read(&conn, 1, 90).unwrap().unwrap();
    assert_eq!(thread["authorityNamespaceId"], 7);
    assert_eq!(thread["role"], "MEMBER"); // Roster updates do not replace the thread-feed role.
    assert!(thread.get("profileRev").is_none());
    let cursor: String = conn
        .query_row(
            "SELECT value_json FROM sync_state WHERE key='stateFeedId'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(cursor, "99");

    let delta = serde_json::json!([{"threadId":90,"namespaceId":7,"page":{
    "mode":"delta","scannedThrough":"4","items":[
        {"feedId":"4","operation":"MEMBER_UPSERT","body":{"account":"other","namespaceId":7,"role":"ADMIN","profileRev":2}}
    ]}}]);
    super::client_state::apply_state_feed_page(
        &mut conn,
        1,
        vec![],
        100,
        serde_json::from_value(delta).unwrap(),
        false,
    )
    .unwrap();
    // A Meta fact selects the profile revision directly; no message anchor
    // competes with it.
    let (rev, role): (i64, String) = conn
        .query_row(
            "SELECT profile_rev, role FROM members WHERE member_account='other'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((rev, role.as_str()), (2, "ADMIN"));
}

#[test]
fn native_message_creator_cleanup_preserves_publisher_space_profile_coordinates() {
    let mut message = serde_json::json!({"publisherNamespaceId":7,"profileNamespaceId":2,
        "profileRev":3,"creator":{"account":"me","domain":"local","namespaceId":0}});
    super::messages::normalize_message_creator(&mut message);
    assert_eq!(message["creator"]["namespaceId"], 0);
    assert!(message["creator"].get("domain").is_none());
    assert_eq!(message["publisherNamespaceId"], 7);
    assert_eq!(message["profileNamespaceId"], 2);
    assert_eq!(message["profileRev"], 3);
    let mut foreign = serde_json::json!({"creator":{"account":"other","namespaceId":7}});
    let original = foreign.clone();
    super::messages::normalize_message_creator(&mut foreign);
    assert_eq!(foreign, original);
}
