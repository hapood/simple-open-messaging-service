use super::messages::load_message_ranges;
use super::{
    history_gap_is_owned, reduce_message_ranges, validate_message_ranges, HistoryDirection,
    MessageInterval, MessageRange, MessageRangeState, ServerMessageRange,
};
use rusqlite::{params, Connection};

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
/// `client_state::ensure_thread_identity` consumes (the shape `merge_states` builds).
fn commit_test_thread_state(conn: &mut Connection, body: &serde_json::Value) {
    let snapshot: super::attention::ThreadFeedSnapshot =
        serde_json::from_value(body.clone()).unwrap();
    let tx = conn.transaction().unwrap();
    super::client_state::ensure_thread_identity(&tx, 1, &snapshot).unwrap();
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
    let stale_snapshot: super::attention::ThreadFeedSnapshot =
        serde_json::from_value(stale).unwrap();
    let tx = conn.transaction().unwrap();
    super::client_state::ensure_thread_identity(&tx, 1, &stale_snapshot).unwrap();
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
fn newer_thread_snapshot_with_lower_revision_moves_the_selection() {
    let mut conn = profile_cache_db();
    let mut high = test_thread_snapshot("P2P", 5, "ACTIVE");
    high["profileRev"] = 5.into();
    commit_test_thread_state(&mut conn, &high);
    // The rev-3 profile is cached; a newer feed position selecting it must win
    // over the locally higher rev-5 number: feed order decides, never magnitude.
    super::contacts::write_profile(
        &conn,
        1,
        &serde_json::json!({
            "account":"bob","domain":serde_json::Value::Null,
            "publisherNamespaceId":0,"profileNamespaceId":0,
            "profileRev":3,"name":"Bob Three","avatarDigest":null,"bio":"third"
        }),
    )
    .unwrap();
    commit_test_thread_state(&mut conn, &test_thread_snapshot("P2P", 6, "ACTIVE"));
    let thread = super::client_state::read_threads(&conn, 1)
        .unwrap()
        .remove(0);
    assert_eq!(thread["profileRev"], 3);
    assert_eq!(thread["profile"]["name"], "Bob Three");
    assert_eq!(thread["profile"]["bio"], "third");
    let stored: i64 = conn
        .query_row(
            "SELECT thread_profile_rev FROM threads WHERE user_id=1 AND thread_id=52",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored, 3);
}

#[test]
fn thread_ipc_selects_and_invalidates_complete_home_profile_snapshots() {
    for kind in ["P2P", "GROUP"] {
        let mut conn = profile_cache_db();
        let mut high = test_thread_snapshot(kind, 5, "ACTIVE");
        high["publisherNamespaceId"] = 7.into();
        high["profileRev"] = 5.into();
        commit_test_thread_state(&mut conn, &high);
        let account = high["profileAccount"].as_str().unwrap();
        for (revision, name, bio, digest) in [
            (5, "Rev Five", "Five bio", "a".repeat(64)),
            (3, "Rev Three", "Three bio", "b".repeat(64)),
        ] {
            super::contacts::write_profile(
                &conn,
                1,
                &serde_json::json!({
                    "account":account,"domain":null,"publisherNamespaceId":7,
                    "profileNamespaceId":0,"profileRev":revision,
                    "name":name,"bio":bio,"avatarDigest":digest
                }),
            )
            .unwrap();
        }
        let first = super::client_state::read_threads(&conn, 1)
            .unwrap()
            .remove(0);
        assert_eq!(
            first["profile"],
            serde_json::json!({
                "name":"Rev Five","bio":"Five bio","avatarDigest":"a".repeat(64)
            })
        );
        let mut lower = high.clone();
        lower["threadFeedId"] = 6.into();
        lower["profileRev"] = 3.into();
        commit_test_thread_state(&mut conn, &lower);
        let selected = super::client_state::read_threads(&conn, 1)
            .unwrap()
            .remove(0);
        assert_eq!(selected["account"], account);
        assert_eq!(selected["publisherNamespaceId"], 7);
        assert_eq!(selected["profileRev"], 3);
        assert_eq!(
            selected["profile"],
            serde_json::json!({
                "name":"Rev Three","bio":"Three bio","avatarDigest":"b".repeat(64)
            })
        );
        assert_eq!(selected.get("meta").is_some(), kind == "GROUP");
        for obsolete in [
            "group",
            "peerUser",
            "authorityNamespaceId",
            "threadProfileRev",
            "serverLastReadSeq",
            "serverUnreadCount",
            "localReadSeq",
        ] {
            assert!(selected.get(obsolete).is_none(), "IPC leaked {obsolete}");
        }
        lower["threadFeedId"] = 7.into();
        lower["profileRev"] = 2.into();
        commit_test_thread_state(&mut conn, &lower);
        let missing = super::client_state::read_threads(&conn, 1)
            .unwrap()
            .remove(0);
        assert_eq!(missing["profileRev"], 2);
        assert_eq!(
            missing["profile"],
            serde_json::json!({
                "name":account,"bio":"","avatarDigest":null
            })
        );
    }
}

#[test]
fn native_group_roster_rebuilds_through_departure_and_reestablishment() {
    let mut conn = profile_cache_db();
    commit_test_thread_state(&mut conn, &test_thread_snapshot("GROUP", 5, "ACTIVE"));
    conn.execute(
        "INSERT INTO members(user_id,thread_id,member_account,namespace_id,role)
         VALUES(1,52,'bob',0,'MEMBER')",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE group_meta SET member_count=1,feed_id='20'
        WHERE thread_id=52",
        [],
    )
    .unwrap();
    // Departure no longer vetoes local meta writes; recovery resets normally.
    commit_test_thread_state(&mut conn, &test_thread_snapshot("GROUP", 6, "READ_ONLY"));
    super::client_state::begin_group_meta_recovery(&mut conn, 1, 52, "21").unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM members", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    let thread = super::thread_store::read(&conn, 1, 52).unwrap().unwrap();
    assert_eq!(thread["meta"]["groupMetaFeedId"], "0");
    assert_eq!(thread["meta"]["recoveryThrough"], "21");
    // Re-establishment rebuilds the roster from the server's full page.
    commit_test_thread_state(&mut conn, &test_thread_snapshot("GROUP", 7, "ACTIVE"));
    let page = serde_json::from_value(serde_json::json!({
        "threadId":52,"namespaceId":0,"page":{
            "account":"!dev","mode":"full","items":[
                {"feedId":"21","createdAt":1000,"originCreatedAt":null,"operation":"MEMBER_UPSERT","body":{
                    "account":"bob","namespaceId":0,"role":"MEMBER","profileRev":3
                }}
            ],
            "hasMore":false,"scannedThrough":"21","groupMetaFeedEndId":"21"
        }
    }))
    .unwrap();
    let patch = super::client_state::apply_group_meta_page(&mut conn, 1, page)
        .unwrap()
        .unwrap();
    assert_eq!(patch.group_meta_feed_id, "21");
    assert_eq!(patch.member_count, 1);
    let thread = super::thread_store::read(&conn, 1, 52).unwrap().unwrap();
    assert_eq!(thread["meta"]["memberCount"], 1);
    assert_eq!(thread["meta"]["groupMetaFeedId"], "21");
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM members", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    super::client_state::begin_group_meta_recovery(&mut conn, 1, 52, "21").unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM members", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    let thread = super::thread_store::read(&conn, 1, 52).unwrap().unwrap();
    assert_eq!(thread["meta"]["groupMetaFeedId"], "0");
}

#[test]
fn meta_commits_and_thread_operations_never_write_each_others_table() {
    let mut conn = profile_cache_db();
    commit_test_thread_state(&mut conn, &test_thread_snapshot("GROUP", 5, "ACTIVE"));
    conn.execute_batch(
        "CREATE TEMP TRIGGER reject_thread_updates BEFORE UPDATE ON threads
         BEGIN SELECT RAISE(ABORT, 'Meta must not write thread fields'); END;",
    )
    .unwrap();
    super::client_state::begin_group_meta_recovery(&mut conn, 1, 52, "2").unwrap();
    let page = serde_json::from_value(serde_json::json!({
        "threadId":52,"namespaceId":0,"page":{
            "account":"!dev","mode":"full","hasMore":false,
            "scannedThrough":"2","groupMetaFeedEndId":"2","items":[
                {"feedId":"1","createdAt":1000,"originCreatedAt":null,"operation":"MEMBER_UPSERT","body":{
                    "account":"bob","namespaceId":0,"role":"MEMBER","profileRev":3
                }},
                {"feedId":"2","createdAt":1000,"originCreatedAt":null,"operation":"GROUP_ANNOUNCEMENT","body":{"text":"Notice"}}
            ]
        }
    }))
    .unwrap();
    super::client_state::apply_group_meta_page(&mut conn, 1, page).unwrap();
    let committed = super::thread_store::read(&conn, 1, 52).unwrap().unwrap();
    assert_eq!(committed["meta"]["memberCount"], 1);
    assert_eq!(committed["meta"]["announcementText"], "Notice");
    conn.execute_batch(
        "DROP TRIGGER reject_thread_updates;
         CREATE TEMP TRIGGER reject_meta_updates BEFORE UPDATE ON group_meta
         BEGIN SELECT RAISE(ABORT, 'thread operations must not update Meta'); END;
         CREATE TEMP TRIGGER reject_meta_inserts BEFORE INSERT ON group_meta
         BEGIN SELECT RAISE(ABORT, 'thread operations must not reinitialize Meta'); END;",
    )
    .unwrap();
    commit_test_thread_state(&mut conn, &test_thread_snapshot("GROUP", 6, "ACTIVE"));
    super::thread_patch::apply(&conn, 1, 52, &serde_json::json!({"muted":true})).unwrap();
    let restored = super::thread_store::read(&conn, 1, 52).unwrap().unwrap();
    assert_eq!(restored["meta"], committed["meta"]);
    assert_eq!(restored["muted"], true);
    assert_eq!(restored["threadFeedId"], 6);
}

#[test]
fn late_meta_page_commits_server_truth_even_after_departure() {
    let mut conn = profile_cache_db();
    commit_test_thread_state(&mut conn, &test_thread_snapshot("GROUP", 5, "ACTIVE"));
    // The HTTP page was requested while active, but the feed commits departure first.
    // The page is server truth for the group; it commits regardless of lifecycle.
    let page = serde_json::from_value(serde_json::json!({
        "threadId":52,"namespaceId":0,"page":{
            "account":"!dev","mode":"delta","hasMore":false,
            "scannedThrough":"2","groupMetaFeedEndId":"2","items":[
                {"feedId":"2","createdAt":1000,"originCreatedAt":null,"operation":"MEMBER_UPSERT","body":{
                    "account":"late","namespaceId":0,"role":"MEMBER","profileRev":3
                }}
            ]
        }
    }))
    .unwrap();
    commit_test_thread_state(&mut conn, &test_thread_snapshot("GROUP", 6, "READ_ONLY"));
    let patch = super::client_state::apply_group_meta_page(&mut conn, 1, page)
        .unwrap()
        .unwrap();
    assert_eq!(patch.group_meta_feed_id, "2");
    assert_eq!(patch.member_count, 1);
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM members", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn missing_group_meta_is_an_invariant_error_and_recovery_rolls_back() {
    let mut conn = profile_cache_db();
    commit_test_thread_state(&mut conn, &test_thread_snapshot("GROUP", 5, "ACTIVE"));
    conn.execute(
        "DELETE FROM group_meta WHERE user_id=1 AND thread_id=52",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO members(user_id,thread_id,member_account,namespace_id,role)
         VALUES(1,52,'bob',0,'MEMBER')",
        [],
    )
    .unwrap();
    assert!(super::thread_store::read(&conn, 1, 52).is_err());
    assert_eq!(
        super::client_state::begin_group_meta_recovery(&mut conn, 1, 52, "2").unwrap_err(),
        "stored group thread is missing its meta row"
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM members", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
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
    for table in ["threads", "group_meta", "thread_previews", "members"] {
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
        "INSERT INTO cache_meta(key,value_json) VALUES('schemaVersion','19')
           ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json;
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
    let mirror: super::attention::ThreadFeedSnapshot =
        serde_json::from_value(body.clone()).unwrap();
    super::client_state::ensure_thread_identity(&tx, 1, &mirror).unwrap();
    tx.commit().unwrap();
    let local: super::attention::LocalThreadAttention =
        serde_json::from_value(serde_json::json!({"threadId":90,"server":body,"localReadSeq":0}))
            .unwrap();
    super::attention::write_state(&conn, 1, &local).unwrap();
    let page = serde_json::json!([{"threadId":90,"namespaceId":7,"page":{
    "mode":"full","scannedThrough":"3","items":[
        {"feedId":"1","createdAt":1000,"originCreatedAt":null,"operation":"MEMBER_UPSERT","body":{"account":"me","namespaceId":0,"role":"ADMIN","profileRev":2}},
        {"feedId":"2","createdAt":1000,"originCreatedAt":null,"operation":"MEMBER_UPSERT","body":{"account":"other","namespaceId":7,"role":"MEMBER","profileRev":2}},
        {"feedId":"3","createdAt":1000,"originCreatedAt":null,"operation":"GROUP_PROFILE","body":{"account":"!mirror","namespaceId":7,"profileRev":4}}
    ]}}]);
    super::client_state::apply_state_feed_page(
        &mut conn,
        1,
        vec![],
        99,
        serde_json::from_value(page).unwrap(),
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
    assert_eq!(thread["publisherNamespaceId"], 7);
    assert_eq!(thread["role"], "MEMBER"); // Roster updates do not replace the thread-feed role.
    assert_eq!(thread["profileRev"], 0);
    let cursor: Option<i64> = conn
        .query_row(
            "SELECT state_feed_id FROM account_state WHERE user_id=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(cursor, Some(99));

    let delta = serde_json::json!([{"threadId":90,"namespaceId":7,"page":{
    "mode":"delta","scannedThrough":"4","items":[
        {"feedId":"4","createdAt":1000,"originCreatedAt":null,"operation":"MEMBER_UPSERT","body":{"account":"other","namespaceId":7,"role":"ADMIN","profileRev":2}}
    ]}}]);
    super::client_state::apply_state_feed_page(
        &mut conn,
        1,
        vec![],
        100,
        serde_json::from_value(delta).unwrap(),
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
