use super::*;
use serde_json::json;

fn owner() -> std::sync::Arc<crate::login_connection::LoginConnection> {
    let conn = Connection::open_in_memory().unwrap();
    crate::native_db::create_cache_schema(&conn).unwrap();
    crate::native_db::thread_store::insert_test_thread(&conn, 1, 42, 0);
    let owner = crate::login_connection::LoginConnection::preparing(
        crate::login_session_store::LoginSessionId::try_from(uuid::Uuid::new_v4().to_string())
            .unwrap(),
        conn,
    );
    owner
        .begin_activation()
        .unwrap()
        .commit("token".into())
        .unwrap();
    owner
}

fn body(seq: i64) -> Value {
    json!({"threadId":42,"seq":seq,"createdAt":100,"updatedAt":101,
        "creator":{"account":"alice","namespaceId":0},"profileRev":3,
        "contentType":"TEXT","content":"private body","isDeleted":false})
}

async fn page(
    owner: &std::sync::Arc<crate::login_connection::LoginConnection>,
    messages: Vec<Value>,
) -> Result<CommittedMessagePage, String> {
    commit_native_message_page(
        owner.capture_database_work().unwrap(),
        1,
        42,
        Some(MessageInterval { left: 0, right: 10 }),
        messages,
        vec![],
        None,
    )
    .await
}

async fn delete(owner: &std::sync::Arc<crate::login_connection::LoginConnection>) {
    apply_deleted_messages(
        owner.capture_database_work().unwrap(),
        1,
        42,
        vec![json!({"threadId":42,"messageSeq":4,"deletionSeq":1,"type":"USER_RETRACTION"})],
        1,
    )
    .await
    .unwrap();
}

fn raw(conn: &Connection, seq: i64) -> Value {
    parse_json(
        conn.query_row(
            "SELECT payload_json FROM messages WHERE user_id=1 AND thread_id=42 AND seq=?1",
            [seq],
            |r| r.get(0),
        )
        .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn arrival_orders_never_hydrate_and_deletions_are_not_timeline_messages() {
    for deletion_first in [false, true] {
        let owner = owner();
        if deletion_first {
            delete(&owner).await;
        }
        let result = page(&owner, vec![body(4)]).await.unwrap();
        assert_eq!(result.messages.len(), usize::from(!deletion_first));
        if !deletion_first {
            delete(&owner).await;
        }
        assert!(page(&owner, vec![body(4)])
            .await
            .unwrap()
            .messages
            .is_empty());
        delete(&owner).await;
        owner
            .with_database(|conn| {
                let expected = message_tomb(42, 4, "USER_RETRACTION")?;
                assert_eq!(raw(conn, 4), expected);
                assert_eq!(
                    load_message_deletions(conn, 1, 42, vec![4, 4, 5])?,
                    vec![MessageDeletion {
                        seq: 4,
                        deletion_type: MessageDeletionType::UserRetraction
                    }]
                );
                assert!(load_origin_message(conn, 1, 42, 0, 4)?.is_none());
                assert_eq!(
                    count_unread_message_slots(
                        conn,
                        1,
                        42,
                        0,
                        10,
                        &MessageCountOwner {
                            account: "me".into(),
                            namespace_id: 0
                        }
                    )?,
                    0
                );
                Ok(())
            })
            .unwrap();
        let work = owner.capture_database_work().unwrap();
        assert!(
            query_native_messages(&work, 1, 42, HistoryDirection::Older, 11, 0, 10)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            query_native_messages(&work, 1, 42, HistoryDirection::Newer, 0, 10, 10)
                .await
                .unwrap()
                .is_empty()
        );
        reset_thread_message_cache(&owner, 1, 42).unwrap();
        owner
            .with_database(|conn| {
                assert!(load_message_ranges(conn, 1, 42)?.is_empty());
                assert_eq!(read_deleted_hwm(conn, 1, 42)?, Some(1));
                assert_eq!(raw(conn, 4), message_tomb(42, 4, "USER_RETRACTION")?);
                Ok(())
            })
            .unwrap();
        assert!(page(&owner, vec![body(4)])
            .await
            .unwrap()
            .messages
            .is_empty());
    }
}

#[tokio::test]
async fn current_coverage_protects_existing_rows_and_absences_and_raw_page_is_validated() {
    let owner = owner();
    page(&owner, vec![body(4)]).await.unwrap();
    let mut replacement = body(4);
    replacement["content"] = json!("late changed content");
    let result = page(&owner, vec![replacement.clone(), body(5)])
        .await
        .unwrap();
    assert_eq!(result.messages, vec![body(4)]);
    assert!(page(&owner, vec![body(4), body(4)])
        .await
        .unwrap_err()
        .contains("duplicate"));
    assert!(commit_native_message_page(
        owner.capture_database_work().unwrap(),
        1,
        42,
        Some(MessageInterval { left: 0, right: 10 }),
        vec![body(4)],
        vec![ServerMessageRange {
            left: 3,
            right: 4,
            state: MessageRangeState::ServerPending
        }],
        None,
    )
    .await
    .unwrap_err()
    .contains("overlaps a server gap"));
    replacement["isDeleted"] = json!(true);
    assert!(page(&owner, vec![replacement])
        .await
        .unwrap_err()
        .contains("TOMB contract"));
    owner
        .with_database(|conn| {
            assert_eq!(raw(conn, 4), body(4));
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                1
            );
            Ok(())
        })
        .unwrap();
}

#[tokio::test]
async fn page_returns_only_stored_live_values_for_response_coordinates() {
    let owner = owner();
    page(&owner, vec![body(4), body(6)]).await.unwrap();
    let mut replacement = body(6);
    replacement["content"] = json!("late changed content");
    assert_eq!(
        page(&owner, vec![replacement, body(5)])
            .await
            .unwrap()
            .messages,
        vec![body(6)]
    );
    assert_eq!(
        page(&owner, vec![body(6), body(4)])
            .await
            .unwrap()
            .messages,
        vec![body(6), body(4)]
    );
    assert!(page(&owner, vec![]).await.unwrap().messages.is_empty());
}

#[tokio::test]
async fn cached_batches_filter_current_coverage_and_tombs_but_allow_both_server_gaps() {
    let owner = owner();
    delete(&owner).await;
    owner
        .with_database(|conn| {
            conn.execute_batch(
                "INSERT INTO message_ranges VALUES(1,42,0,2,'LOCAL_COVERED');
            INSERT INTO message_ranges VALUES(1,42,2,3,'SERVER_PENDING');
            INSERT INTO message_ranges VALUES(1,42,4,5,'SERVER_UNAVAILABLE');",
            )
            .unwrap();
            let tx = conn.transaction().unwrap();
            put_cached_messages(&tx, 1, (1..=6).map(body).collect())?;
            tx.commit().unwrap();
            assert_eq!(raw(conn, 4), message_tomb(42, 4, "USER_RETRACTION")?);
            let visible = load_live_messages_by_seqs(conn, 1, 42, &[1, 2, 3, 4, 5, 6])?;
            assert_eq!(visible, vec![body(3), body(5), body(6)]);
            Ok(())
        })
        .unwrap();
}

#[tokio::test]
async fn query_tombs_are_normalized_to_invisible_coordinate_markers() {
    let owner = owner();
    let mut tomb = body(4);
    tomb["contentType"] = json!("TOMB");
    tomb["isDeleted"] = json!(true);
    tomb["deletionType"] = json!("MODERATION_REMOVAL");
    assert!(page(&owner, vec![tomb]).await.unwrap().messages.is_empty());
    owner
        .with_database(|conn| {
            assert_eq!(raw(conn, 4), message_tomb(42, 4, "MODERATION_REMOVAL")?);
            assert_eq!(
                count_unread_message_slots(
                    conn,
                    1,
                    42,
                    0,
                    10,
                    &MessageCountOwner {
                        account: "me".into(),
                        namespace_id: 0
                    }
                )?,
                0
            );
            Ok(())
        })
        .unwrap();
}

#[tokio::test]
async fn invalid_deletion_batch_and_failed_page_roll_back_all_writes() {
    let owner = owner();
    let error = apply_deleted_messages(
        owner.capture_database_work().unwrap(),
        1,
        42,
        vec![
            json!({"threadId":42,"messageSeq":4,"deletionSeq":1,"type":"USER_RETRACTION"}),
            json!({"threadId":42,"messageSeq":5,"deletionSeq":2,"type":"INVALID"}),
        ],
        2,
    )
    .await
    .unwrap_err();
    assert!(error.contains("deletion type"));
    owner.with_database(|conn| {
        assert_eq!(read_deleted_hwm(conn, 1, 42)?, Some(0));
        assert!(load_message_deletions(conn, 1, 42, vec![4,5])?.is_empty());
        conn.execute_batch("CREATE TEMP TRIGGER fail_range BEFORE INSERT ON message_ranges BEGIN SELECT RAISE(ABORT, 'fail range'); END;").unwrap();
        Ok(())
    }).unwrap();
    assert!(page(&owner, vec![body(4)])
        .await
        .unwrap_err()
        .contains("fail range"));
    owner
        .with_database(|conn| {
            assert!(load_live_messages_by_seqs(conn, 1, 42, &[4])?.is_empty());
            assert!(load_message_ranges(conn, 1, 42)?.is_empty());
            Ok(())
        })
        .unwrap();
}

#[tokio::test]
async fn parallel_body_and_deletion_commits_use_the_same_physical_exclusion() {
    let owner = owner();
    let (body_result, ()) = tokio::join!(page(&owner, vec![body(4)]), delete(&owner));
    body_result.unwrap();
    owner
        .with_database(|conn| {
            assert_eq!(raw(conn, 4), message_tomb(42, 4, "USER_RETRACTION")?);
            assert_eq!(read_deleted_hwm(conn, 1, 42)?, Some(1));
            assert_eq!(
                load_message_ranges(conn, 1, 42)?[0].state,
                MessageRangeState::LocalCovered
            );
            Ok(())
        })
        .unwrap();
}

#[tokio::test]
async fn covered_system_profile_correction_survives_refill_without_merge() {
    let owner = owner();
    let mut system = body(4);
    system["contentType"] = json!("SYSTEM");
    page(&owner, vec![system.clone()]).await.unwrap();
    owner
        .with_database(|conn| {
            assert!(correct_system_message_profile(
                conn, 1, 42, 4, "alice", 7, 0, 2
            )?);
            Ok(())
        })
        .unwrap();
    let result = page(&owner, vec![system]).await.unwrap();
    assert_eq!(
        result.messages[0]["localSystemProfileRevs"]["[7,0,\"alice\"]"],
        2
    );
}

#[tokio::test]
async fn unread_counts_only_non_self_non_deleted_messages_without_a_page_limit() {
    let owner = owner();
    owner
        .with_database(|conn| {
            let tx = conn.transaction().unwrap();
            let mut messages: Vec<_> = (1..=120).map(body).collect();
            messages[0]["creator"] = json!({"account":"me","namespaceId":0});
            messages[1]["creator"] = json!({"account":"me","namespaceId":2});
            messages[2]["creator"] = Value::Null;
            messages[3] = message_tomb(42, 4, "USER_RETRACTION")?;
            put_cached_messages(&tx, 1, messages)?;
            tx.commit().unwrap();
            let owner = MessageCountOwner {
                account: "me".into(),
                namespace_id: 0,
            };
            assert_eq!(
                count_unread_message_slots(conn, 1, 42, 0, 120, &owner)?,
                118
            );
            assert_eq!(count_unread_message_slots(conn, 1, 42, 1, 4, &owner)?, 2);
            assert_eq!(count_unread_message_slots(conn, 1, 42, 4, 4, &owner)?, 0);
            assert_eq!(count_unread_message_slots(conn, 2, 42, 0, 120, &owner)?, 0);
            assert_eq!(count_unread_message_slots(conn, 1, 99, 0, 120, &owner)?, 0);
            assert!(count_unread_message_slots(conn, 1, 42, 5, 4, &owner).is_err());
            Ok(())
        })
        .unwrap();
}
