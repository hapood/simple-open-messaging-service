use super::*;
use crate::login_connection::LoginConnection;
use crate::login_session_store::LoginSessionId;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

fn owner() -> Arc<LoginConnection> {
    let database = Connection::open_in_memory().unwrap();
    crate::native_db::create_cache_schema(&database).unwrap();
    database
        .execute_batch(
            "CREATE TEMP TABLE message_writes(seq INTEGER);
         CREATE TEMP TRIGGER message_connection_proof AFTER INSERT ON main.messages
         BEGIN INSERT INTO message_writes VALUES(NEW.seq); END;",
        )
        .unwrap();
    let id = LoginSessionId::try_from(uuid::Uuid::new_v4().to_string()).unwrap();
    let owner = LoginConnection::preparing(id, database);
    owner
        .begin_activation()
        .unwrap()
        .commit("history-token".into())
        .unwrap();
    owner
}

fn origins(proxy: &ServerSessionState, origin: &str) {
    *proxy.api_origin.lock().unwrap() = origin.into();
    *proxy.api_origin_primary.lock().unwrap() = origin.into();
    *proxy.api_origin_secondary.lock().unwrap() = None;
}

fn intent(owner: &Arc<LoginConnection>, proxy: &ServerSessionState) -> NativeHistoryIntent {
    let work = owner.capture_database_work().unwrap();
    NativeHistoryIntent {
        request: LoginRequest::capture(proxy, owner.clone()).unwrap(),
        events: crate::realtime::NativeEvents::for_database_work(None, work.clone()),
        work,
        user_id: 42,
        thread_id: 7,
    }
}

async fn read_query(socket: &mut TcpStream) -> Value {
    let mut bytes = Vec::new();
    let boundary = loop {
        if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            break index + 4;
        }
        let mut buffer = [0; 1024];
        let size = socket.read(&mut buffer).await.unwrap();
        assert_ne!(size, 0);
        bytes.extend_from_slice(&buffer[..size]);
        assert!(bytes.len() < 32768);
    };
    let headers = String::from_utf8(bytes[..boundary].to_vec())
        .unwrap()
        .to_lowercase();
    assert!(headers.starts_with("post /api/v1/query-messages http/1.1\r\n"));
    assert!(headers.contains("authorization: bearer history-token\r\n"));
    assert!(headers.contains("content-type: application/json\r\n"));
    let length: usize = headers
        .lines()
        .find_map(|line| line.strip_prefix("content-length: "))
        .unwrap()
        .parse()
        .unwrap();
    assert!(length < 32768);
    while bytes.len() < boundary + length {
        let mut buffer = [0; 1024];
        let size = socket.read(&mut buffer).await.unwrap();
        assert_ne!(size, 0);
        bytes.extend_from_slice(&buffer[..size]);
    }
    serde_json::from_slice(&bytes[boundary..boundary + length]).unwrap()
}

async fn respond(socket: &mut TcpStream, body: Value) {
    let body = body.to_string();
    socket
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len(),
            )
            .as_bytes(),
        )
        .await
        .unwrap();
}

fn cursor(before: i64) -> Value {
    json!({"code": 30006, "message": "cursor", "data": {"resumeAfter": 0, "resumeBefore": before}})
}

fn page(sequences: &[i64], scanned: i64) -> Value {
    json!({"code": 0, "message": "", "data": {
        "messages": sequences.iter().map(|seq| json!({"threadId": 7, "seq": seq, "createdAt": 1})).collect::<Vec<_>>(),
        "gaps": [], "scannedThrough": scanned, "hasMore": scanned > 1,
    }})
}

fn sequences(result: NativeHistoryResult) -> Vec<i64> {
    result
        .items
        .into_iter()
        .map(|item| match item {
            NativeHistoryItem::Message { message } => message["seq"].as_i64().unwrap(),
            NativeHistoryItem::ServerGap { .. } => panic!("unexpected gap"),
        })
        .collect()
}

#[tokio::test]
async fn bootstrap_pages_and_cached_around_keep_one_owner_and_physical_connection() {
    let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = ServerSessionState::new();
    origins(&proxy, &format!("http://{}", server.local_addr().unwrap()));
    let owner = owner();
    let history = intent(&owner, &proxy);
    // Mutating runtime mirrors after intent creation cannot retarget any page.
    origins(&proxy, "http://127.0.0.1:1");
    *proxy.token.lock().unwrap() = Some("successor-token".into());
    let serving = tokio::spawn(async move {
        for (query, reply) in [
            (json!({"threadId": 7}), cursor(4)),
            (
                json!({"threadId": 7, "before": 4, "through": 0, "take": 3}),
                page(&[3], 3),
            ),
            (
                json!({"threadId": 7, "before": 3, "through": 0, "take": 2}),
                page(&[2, 1], 1),
            ),
        ] {
            let (mut socket, _) = server.accept().await.unwrap();
            assert_eq!(read_query(&mut socket).await, query);
            respond(&mut socket, reply).await;
        }
    });
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        history.get(NativeHistoryDemand::Latest {
            count: 3,
            known_newest_seq: None,
        }),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(sequences(result), [1, 2, 3]);
    serving.await.unwrap();
    // Both legs now use the same cached ranges without contacting the unreachable new origin.
    let result = intent(&owner, &proxy)
        .get(NativeHistoryDemand::Around {
            anchor: 2,
            older_count: 2,
            newer_count: 1,
            known_newest_seq: Some(3),
        })
        .await
        .unwrap();
    assert_eq!(sequences(result), [1, 2, 3]);
    owner
        .with_database(|conn| {
            let writes: i64 = conn
                .query_row("SELECT COUNT(*) FROM message_writes", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            assert_eq!(writes, 3);
            let ranges = load_message_ranges(conn, 42, 7)?;
            assert_eq!(ranges.len(), 1);
            assert_eq!((ranges[0].left, ranges[0].right), (0, 3));
            Ok(())
        })
        .unwrap();
}

#[tokio::test]
async fn deletion_only_sync_state_has_no_known_head() {
    let owner = owner();
    owner
        .with_database(|conn| {
            conn.execute(
                "INSERT INTO thread_sync_state(user_id,thread_id,deleted_hwm) VALUES(42,7,3)",
                [],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .unwrap();
    let work = owner.capture_database_work().unwrap();
    assert_eq!(read_native_message_head(&work, 42, 7).await.unwrap(), None);
    assert_eq!(read_native_message_head(&work, 42, 8).await.unwrap(), None);
}

#[tokio::test]
async fn cursor_recovery_reuses_the_original_request_context() {
    let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = ServerSessionState::new();
    origins(&proxy, &format!("http://{}", server.local_addr().unwrap()));
    let owner = owner();
    let history = intent(&owner, &proxy);
    let serving = tokio::spawn(async move {
        let (mut first, _) = server.accept().await.unwrap();
        assert_eq!(read_query(&mut first).await["before"], 4);
        respond(&mut first, cursor(3)).await;
        let (mut second, _) = server.accept().await.unwrap();
        assert_eq!(read_query(&mut second).await["before"], 3);
        respond(&mut second, page(&[2, 1], 1)).await;
    });
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        history.get(NativeHistoryDemand::Latest {
            count: 2,
            known_newest_seq: Some(3),
        }),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(sequences(result), [1, 2]);
    serving.await.unwrap();
}

async fn cancellation_drops_history_body(repair: bool) {
    let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = ServerSessionState::new();
    origins(&proxy, &format!("http://{}", server.local_addr().unwrap()));
    let owner = owner();
    let history = intent(&owner, &proxy);
    let (ready, waiting) = tokio::sync::oneshot::channel();
    let serving = tokio::spawn(async move {
        let (mut socket, _) = server.accept().await.unwrap();
        read_query(&mut socket).await;
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{")
            .await
            .unwrap();
        ready.send(()).unwrap();
        let mut byte = [0];
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), socket.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    });
    let fetching = tokio::spawn(history.get(NativeHistoryDemand::Latest {
        count: 1,
        known_newest_seq: Some(3),
    }));
    tokio::time::timeout(Duration::from_secs(2), waiting)
        .await
        .unwrap()
        .unwrap();
    // A suspended HTTP query holds no SQL lock.
    owner
        .with_database(|conn| {
            conn.execute("INSERT INTO message_writes VALUES(99)", [])
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
        .unwrap();
    let expected = if repair {
        owner.invalidate_database_work().unwrap();
        "native cache work superseded"
    } else {
        owner.end().unwrap();
        "native login superseded"
    };
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), fetching)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err(),
        expected
    );
    serving.await.unwrap();
    if repair {
        owner
            .with_database(|conn| {
                let count: i64 = conn
                    .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
                    .map_err(|e| e.to_string())?;
                assert_eq!(count, 0);
                Ok(())
            })
            .unwrap();
    }
}

#[tokio::test]
async fn ending_login_cancels_history_transport() {
    cancellation_drops_history_body(false).await;
}

#[tokio::test]
async fn repairing_cache_cancels_history_transport_without_ending_login() {
    cancellation_drops_history_body(true).await;
}

#[tokio::test]
async fn invalid_page_does_not_commit_messages_or_coverage() {
    let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = ServerSessionState::new();
    origins(&proxy, &format!("http://{}", server.local_addr().unwrap()));
    let owner = owner();
    let history = intent(&owner, &proxy);
    let serving = tokio::spawn(async move {
        let (mut socket, _) = server.accept().await.unwrap();
        read_query(&mut socket).await;
        let mut reply = page(&[3], 3);
        reply["data"]["messages"][0]["threadId"] = json!(99);
        respond(&mut socket, reply).await;
    });
    let error = tokio::time::timeout(
        Duration::from_secs(5),
        history.get(NativeHistoryDemand::Latest {
            count: 1,
            known_newest_seq: Some(3),
        }),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert!(error.contains("another thread"));
    serving.await.unwrap();
    owner
        .with_database(|conn| {
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            assert_eq!(count, 0);
            assert!(load_message_ranges(conn, 42, 7)?.is_empty());
            Ok(())
        })
        .unwrap();
}
