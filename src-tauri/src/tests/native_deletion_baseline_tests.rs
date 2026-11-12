use super::*;
use serde_json::json;

fn database() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::native_db::create_cache_schema(&conn).unwrap();
    conn
}

fn initialize(conn: &mut Connection, snapshot: i64) -> Option<i64> {
    let tx = conn.transaction().unwrap();
    crate::native_db::thread_store::insert_test_thread(&tx, 42, 7, snapshot);
    let result = read_deleted_hwm(&tx, 42, 7).unwrap();
    tx.commit().unwrap();
    result
}

fn owner(conn: Connection) -> std::sync::Arc<crate::login_connection::LoginConnection> {
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

#[test]
fn fresh_creation_uses_server_baseline_and_preserves_progress() {
    for end in [0, 17] {
        let mut conn = database();
        assert_eq!(initialize(&mut conn, end), Some(end));
        assert_eq!(read_deleted_hwm(&conn, 42, 7).unwrap(), Some(end));
    }
}

#[test]
fn thread_progress_accepts_monotone_message_head() {
    let mut conn = database();
    initialize(&mut conn, 17);
    let tx = conn.transaction().unwrap();
    update_message_head(&tx, 42, 7, 8).unwrap();
    update_message_head(&tx, 42, 7, 3).unwrap();
    tx.commit().unwrap();
    let values: (i64, i64, i64) = conn
        .query_row(
            "SELECT deleted_hwm,message_head,message_end_seq FROM threads",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(values, (17, 8, 0));
}

#[tokio::test]
async fn body_writes_do_not_initialize_and_deletion_writes_reject_missing_progress() {
    let owner = owner(database());
    for head in [None, Some(3)] {
        let error = commit_native_message_page(
            owner.capture_database_work().unwrap(),
            42,
            7,
            Some(MessageInterval { left: 0, right: 3 }),
            vec![json!({"threadId":7,"seq":1,"createdAt":1})],
            vec![],
            head,
        )
        .await
        .unwrap_err();
        assert_eq!(error, "thread message progress is not initialized");
    }
    let error = apply_deleted_messages(
        owner.capture_database_work().unwrap(),
        42,
        7,
        vec![json!({"threadId":7,"deletionSeq":1,"messageSeq":1,"type":"USER_RETRACTION"})],
        1,
    )
    .await
    .unwrap_err();
    assert!(error.contains("thread deletion progress is not initialized"));
    owner
        .with_database(|conn| {
            assert_eq!(read_deleted_hwm(conn, 42, 7)?, None);
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
                .unwrap();
            assert_eq!(
                count, 0,
                "missing thread must roll back body and tomb writes"
            );
            Ok(())
        })
        .unwrap();
}

#[tokio::test]
async fn body_clear_preserves_cursor_and_stub_without_cancelling_parallel_work() {
    let mut conn = database();
    initialize(&mut conn, 17);
    let owner = owner(conn);
    owner
        .with_database(|conn| {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            update_message_head(&tx, 42, 7, 50)?;
            tx.commit().map_err(|e| e.to_string())
        })
        .unwrap();
    let work = owner.capture_database_work().unwrap();
    apply_deleted_messages(
        work.clone(),
        42,
        7,
        vec![json!({"threadId":7,"deletionSeq":18,"messageSeq":2,"type":"USER_RETRACTION"})],
        18,
    )
    .await
    .unwrap();
    reset_thread_message_cache(&owner, 42, 7).unwrap();
    assert!(!work.cancellation().is_cancelled());
    assert_eq!(
        read_native_message_head(&work, 42, 7).await.unwrap(),
        Some(50)
    );
    commit_native_message_page(
        work.clone(),
        42,
        7,
        Some(MessageInterval { left: 0, right: 3 }),
        vec![
            json!({"threadId":7,"seq":2,"createdAt":1,"contentType":"TEXT","content":"late body"}),
        ],
        vec![],
        Some(3),
    )
    .await
    .unwrap();
    apply_deleted_messages(work, 42, 7, vec![], 16)
        .await
        .unwrap();
    owner
        .with_database(|conn| {
            assert_eq!(read_deleted_hwm(conn, 42, 7)?, Some(18));
            let raw: String = conn
                .query_row(
                    "SELECT payload_json FROM messages WHERE user_id=42 AND thread_id=7 AND seq=2",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            let tomb: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(tomb["contentType"], "TOMB");
            assert!(tomb.get("content").is_none());
            Ok(())
        })
        .unwrap();
}
