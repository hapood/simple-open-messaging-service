use super::*;
use serde_json::json;

/// Exercise real IPC entry points on the lifecycle test's owner, including TEMP state that
/// would be absent if any command silently opened another physical SQLite connection.
pub(super) async fn verify_owned_local_commands() {
    let owner = login_connections::LOGIN_CONNECTIONS.capture().unwrap();
    owner
        .with_database(|conn| {
            conn.execute_batch(
                "CREATE TEMP TABLE namespace_writes(value INTEGER);
             CREATE TEMP TRIGGER namespace_connection_proof AFTER INSERT ON main.profile_namespaces
             BEGIN INSERT INTO namespace_writes VALUES(NEW.profile_namespace_id); END;",
            )
            .map_err(|e| e.to_string())
        })
        .unwrap();
    messages::native_db_put_message_head(42, 7, 10)
        .await
        .unwrap();
    messages::native_db_apply_deleted_messages(
        42,
        7,
        vec![json!({
            "threadId": 7, "deletionSeq": 1, "messageSeq": 8, "type": "USER_RETRACTION",
        })],
        1,
    )
    .await
    .unwrap();
    assert_eq!(messages::native_db_get_deleted_hwm(42, 7).await.unwrap(), 1);
    assert_eq!(
        messages::native_db_get_deleted_message_seqs(42, 7, vec![8])
            .await
            .unwrap(),
        vec![8]
    );
    assert_eq!(native_db_count_messages(42).await.unwrap(), 1);
    assert!(messages::native_db_get_message(42, 7, 8)
        .await
        .unwrap()
        .is_none());
    assert!(messages::native_db_get_message_by_origin(42, 7, 0, 8)
        .await
        .unwrap()
        .is_none());
    assert!(messages::native_db_newest_messages(42, vec![7])
        .await
        .unwrap()
        .is_empty());
    assert!(
        messages::native_db_query_messages(42, 7, None, "desc".into(), 20)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        messages::native_db_count_unread_message_slots(
            42,
            7,
            0,
            10,
            messages::MessageCountOwner {
                account: "me".into(),
                namespace_id: 0
            }
        )
        .await
        .unwrap(),
        0
    );
    assert!(
        !messages::native_db_correct_system_message_profile(42, 7, 8, "peer".into(), 0, 0, 1)
            .await
            .unwrap()
    );
    messages::native_db_delete_messages_by_thread(42, 7)
        .await
        .unwrap();
    assert_eq!(native_db_count_messages(42).await.unwrap(), 0);
    let pair = json!({"publisherNamespaceId": 0, "profileNamespaceId": 7});
    profile_namespaces::native_db_commit_profile_namespace_bindings(
        42,
        vec![serde_json::from_value(json!({
            "publisherNamespaceId": 0, "profileNamespaceId": 7,
            "domain": "peer.test", "rootPublicKey": null,
            "updateFeedId": 1, "expired": false, "status": "ACTIVE",
        }))
        .unwrap()],
        1,
    )
    .await
    .unwrap();
    let bindings = profile_namespaces::native_db_profile_namespace_bindings(
        42,
        vec![serde_json::from_value(pair.clone()).unwrap()],
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(bindings).unwrap()[0]["domain"],
        "peer.test"
    );
    profile_namespaces::native_db_apply_profile_namespace_changes(42, vec![])
        .await
        .unwrap();
    profile_namespaces::native_db_write_profile_tomb(
        42,
        serde_json::from_value(json!({
            "publisherNamespaceId": 0, "profileNamespaceId": 7, "account": "missing",
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    profile_namespaces::native_db_write_profile_namespace_tomb(
        42,
        serde_json::from_value(pair).unwrap(),
    )
    .await
    .unwrap();
    assert!(contacts::native_db_get_profile(
        42,
        serde_json::from_value(json!({
            "publisherNamespaceId": 0,
            "target": {"profileNamespaceId": 0, "account": "missing", "rev": 1},
        }))
        .unwrap()
    )
    .await
    .unwrap()
    .is_none());
    assert!(
        contacts::native_db_get_group_member(42, 7, "missing".into(), 0)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        contacts::native_db_query_group_members(42, 7, "[0,\"\"]".into(), 20, "".into())
            .await
            .unwrap()
            .is_empty()
    );
    assert!(client_state::native_db_threads(42)
        .await
        .unwrap()
        .is_empty());
    client_state::native_db_delete_thread(42, 7).await.unwrap();
    assert_eq!(
        client_state::native_db_patch_thread(42, 7, json!({"muted":true}))
            .await
            .unwrap_err(),
        "cannot patch thread before feed state exists"
    );
    owner
        .with_database(|conn| {
            let writes: i64 = conn
                .query_row("SELECT COUNT(*) FROM namespace_writes", [], |row| {
                    row.get(0)
                })
                .map_err(|e| e.to_string())?;
            assert_eq!(writes, 1);
            conn.execute_batch(
                "DROP TRIGGER namespace_connection_proof; DROP TABLE namespace_writes;",
            )
            .map_err(|e| e.to_string())
        })
        .unwrap();

    let proxy = crate::ServerSessionState::new();
    let old_sync = state_feed_sync::synchronize(&proxy, 42, 1);
    let old_view = owner.capture_database_work().unwrap();
    native_db_recreate_messages().await.unwrap();
    assert!(old_view.assert_current().is_err());
    assert_eq!(old_sync.await.unwrap_err(), "native cache work superseded");
    native_db_validate_cache().await.unwrap();
    assert_eq!(owner.credential().unwrap(), "secret-one");
    assert!(std::sync::Arc::ptr_eq(
        &owner,
        &login_connections::LOGIN_CONNECTIONS.capture().unwrap()
    ));

    let before_clear = owner.capture_database_work().unwrap();
    let delayed_thread_feed =
        attention::NativeThreadFeedIntent::capture(None, &crate::ServerSessionState::new(), 42, 0)
            .unwrap()
            .synchronize();
    let delayed_notifications =
        notifications::synchronize(&crate::ServerSessionState::new(), 42, 0);
    native_db_clear_user(42).await.unwrap();
    assert!(before_clear.assert_current().is_err());
    assert_eq!(
        delayed_thread_feed.await.err().unwrap(),
        "native cache work superseded"
    );
    assert_eq!(
        delayed_notifications.await.err().unwrap(),
        "native cache work superseded"
    );
    account_state::native_db_initialize_account_state(42)
        .await
        .unwrap();
    let before_clear_all = owner.capture_database_work().unwrap();
    native_db_clear_all().await.unwrap();
    assert!(before_clear_all.assert_current().is_err());
    account_state::native_db_initialize_account_state(42)
        .await
        .unwrap();
    verify_state_feed_pages_on_captured_connection(&owner).await;
}

async fn verify_state_feed_pages_on_captured_connection(
    owner: &std::sync::Arc<crate::login_connection::LoginConnection>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", server.local_addr().unwrap());
    let proxy = crate::ServerSessionState::new();
    *proxy.api_origin.lock().unwrap() = origin.clone();
    *proxy.api_origin_primary.lock().unwrap() = origin;
    owner
        .with_database(|conn| {
            conn.execute_batch(
                "CREATE TEMP TABLE state_page_commits(feed_id INTEGER);
             CREATE TEMP TRIGGER state_page_connection_proof
             AFTER UPDATE OF state_feed_id ON main.account_state
             BEGIN INSERT INTO state_page_commits VALUES(NEW.state_feed_id); END;",
            )
            .map_err(|e| e.to_string())
        })
        .unwrap();
    let serving = tokio::spawn(async move {
        for after in 0..2 {
            let (mut socket, _) = server.accept().await.unwrap();
            let mut bytes = Vec::new();
            while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                let mut buffer = [0; 1024];
                let size = socket.read(&mut buffer).await.unwrap();
                assert_ne!(size, 0);
                bytes.extend_from_slice(&buffer[..size]);
            }
            let headers = String::from_utf8(bytes).unwrap();
            assert!(headers.starts_with(&format!(
                "GET /api/v1/user/state-feed?mode=full&after={after}&through=2&take=100 HTTP/1.1"
            )));
            assert!(headers
                .to_lowercase()
                .contains("authorization: bearer secret-one\r\n"));
            let scanned = after + 1;
            let body = json!({"code": 0, "data": {
                "mode": "full", "scannedThrough": scanned, "stateFeedEndId": 2,
                "hasMore": scanned < 2,
                "items": [{"feedId": scanned, "body": {
                    "requestEndId": scanned.to_string(), "requestReadId": "0",
                }}],
            }})
            .to_string();
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        }
    });
    let cursor = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        state_feed_sync::synchronize(&proxy, 42, 2),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(cursor, 2);
    serving.await.unwrap();
    owner.with_database(|conn| {
        let coordinates: (i64, Option<i64>, i64) = conn.query_row(
            "SELECT state_feed_id,state_feed_full_through,intent_request_end_id FROM account_state WHERE user_id=42",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).map_err(|e| e.to_string())?;
        assert_eq!(coordinates, (2, None, 2));
        let commits: i64 = conn.query_row("SELECT COUNT(*) FROM state_page_commits", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        assert_eq!(commits, 2);
        conn.execute_batch("DROP TRIGGER state_page_connection_proof; DROP TABLE state_page_commits;")
            .map_err(|e| e.to_string())
    }).unwrap();
}

/// Poll the public command futures through admission while SQL is deliberately blocked. Ending
/// the captured owner must reject all queued commands, even though its file still exists.
pub(super) fn verify_queued_commands_end_before_sql() {
    tauri::async_runtime::block_on(async {
        let owner = login_connections::LOGIN_CONNECTIONS.capture().unwrap();
        let proxy = crate::ServerSessionState::new();
        // Deliberately do not poll this future until a successor is installed. Its owner must
        // already be fixed at the call site, before any scheduling or lane wait.
        let old_state_feed = state_feed_sync::synchronize(&proxy, 42, 1);
        let old_thread_feed = attention::NativeThreadFeedIntent::capture(None, &proxy, 42, 0)
            .unwrap()
            .synchronize();
        let old_notifications = notifications::synchronize(&proxy, 42, 0);
        let old_history = messages::NativeHistoryIntent::capture(None, &proxy, 42, 7)
            .unwrap()
            .get(messages::NativeHistoryDemand::Latest {
                count: 1,
                known_newest_seq: Some(8),
            });
        let mut page_commit = Box::pin(messages::commit_native_message_page(
            owner.capture_database_work().unwrap(),
            42,
            7,
            Some(messages::MessageInterval { left: 7, right: 8 }),
            vec![json!({"threadId": 7, "seq": 8, "createdAt": 1})],
            vec![],
            Some(8),
        ));
        let fence = lifetime::CACHE_LIFETIME.invalidate().unwrap();
        let mut threads = Box::pin(client_state::native_db_threads(42));
        let mut delete = Box::pin(client_state::native_db_delete_thread(42, 7));
        let mut bindings = Box::pin(profile_namespaces::native_db_profile_namespace_bindings(
            42,
            vec![],
        ));
        let mut member = Box::pin(contacts::native_db_get_group_member(
            42,
            7,
            "missing".into(),
            0,
        ));
        let mut message_head = Box::pin(messages::native_db_put_message_head(42, 7, 99));
        let mut message_read = Box::pin(messages::native_db_get_message(42, 7, 8));
        assert!(futures_util::poll!(&mut page_commit).is_pending());
        assert!(futures_util::poll!(&mut message_head).is_pending());
        assert!(futures_util::poll!(&mut message_read).is_pending());
        assert!(futures_util::poll!(&mut threads).is_pending());
        assert!(futures_util::poll!(&mut delete).is_pending());
        assert!(futures_util::poll!(&mut bindings).is_pending());
        assert!(futures_util::poll!(&mut member).is_pending());
        owner.end().unwrap();
        release_login_connection(&owner).unwrap();
        let next_database = Connection::open_in_memory().unwrap();
        create_cache_schema(&next_database).unwrap();
        let next_id =
            crate::login_session_store::LoginSessionId::try_from(uuid::Uuid::new_v4().to_string())
                .unwrap();
        let successor = login_connections::LOGIN_CONNECTIONS
            .install(next_id, next_database)
            .unwrap();
        successor
            .begin_activation()
            .unwrap()
            .commit("successor-token".into())
            .unwrap();
        drop(fence);
        assert_eq!(old_state_feed.await.unwrap_err(), "native login superseded");
        assert_eq!(
            old_thread_feed.await.err().unwrap(),
            "native login superseded"
        );
        assert_eq!(
            old_notifications.await.err().unwrap(),
            "native login superseded"
        );
        assert_eq!(old_history.await.unwrap_err(), "native login superseded");
        assert_eq!(page_commit.await.err().unwrap(), "native login superseded");
        assert_eq!(
            state_feed_sync::synchronize(&proxy, 42, 0).await.unwrap(),
            0
        );
        assert_eq!(message_head.await.unwrap_err(), "native login superseded");
        assert_eq!(message_read.await.unwrap_err(), "native login superseded");
        assert_eq!(threads.await.unwrap_err(), "native login superseded");
        assert_eq!(delete.await.unwrap_err(), "native login superseded");
        assert_eq!(bindings.await.unwrap_err(), "native login superseded");
        assert_eq!(member.await.unwrap_err(), "native login superseded");
        assert_eq!(successor.credential().unwrap(), "successor-token");
        assert!(std::sync::Arc::ptr_eq(
            &successor,
            &login_connections::LOGIN_CONNECTIONS.capture().unwrap()
        ));
        assert!(client_state::native_db_threads(42)
            .await
            .unwrap()
            .is_empty());
        successor
            .with_database(|conn| {
                let count: i64 = conn
                    .query_row("SELECT COUNT(*) FROM thread_sync_state", [], |row| {
                        row.get(0)
                    })
                    .map_err(|e| e.to_string())?;
                assert_eq!(count, 0);
                for table in ["messages", "message_ranges"] {
                    let count: i64 = conn
                        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                            row.get(0)
                        })
                        .map_err(|e| e.to_string())?;
                    assert_eq!(count, 0);
                }
                Ok(())
            })
            .unwrap();
        successor.end().unwrap();
        release_login_connection(&successor).unwrap();
    });
}
