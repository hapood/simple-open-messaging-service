use super::*;
use crate::login_connection::LoginConnection;
use crate::login_session_store::LoginSessionId;
use std::sync::{mpsc, Arc};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn fixture(proxy: &ServerSessionState) -> FeedIntent {
    let database = Connection::open_in_memory().unwrap();
    super::super::create_cache_schema(&database).unwrap();
    let owner = LoginConnection::preparing(
        LoginSessionId::try_from(uuid::Uuid::new_v4().to_string()).unwrap(),
        database,
    );
    owner
        .begin_activation()
        .unwrap()
        .commit("original-token".into())
        .unwrap();
    FeedIntent::from_parts(
        42,
        owner.capture_database_work().unwrap(),
        LoginRequest::capture(proxy, owner).unwrap(),
    )
    .unwrap()
}

fn close(intent: &FeedIntent) {
    intent.work.owner().end().unwrap();
    intent.work.owner().close().unwrap();
}

async fn read_request(socket: &mut tokio::net::TcpStream) -> (String, Value) {
    let mut bytes = Vec::new();
    let header_end = loop {
        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            break end + 4;
        }
        let mut buffer = [0; 1024];
        let count = socket.read(&mut buffer).await.unwrap();
        assert_ne!(count, 0);
        bytes.extend_from_slice(&buffer[..count]);
    };
    let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
    let length: usize = headers
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| value.trim().parse().unwrap())
        .unwrap_or(0);
    while bytes.len() < header_end + length {
        let mut buffer = [0; 1024];
        let count = socket.read(&mut buffer).await.unwrap();
        assert_ne!(count, 0);
        bytes.extend_from_slice(&buffer[..count]);
    }
    (
        headers,
        if length == 0 {
            Value::Null
        } else {
            serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap()
        },
    )
}

#[tokio::test]
async fn cancellation_releases_a_waiter_without_waiting_for_the_lane() {
    for repair in [false, true] {
        let intent = fixture(&ServerSessionState::new());
        let owner = intent.work.owner().clone();
        let events = intent.events(None);
        let lane = THREAD_FEED_SYNC.lock().await;
        let mut pending = Box::pin(sync_thread_feed_intent(intent, events, 0));
        assert!(futures_util::poll!(&mut pending).is_pending());
        if repair {
            owner.invalidate_database_work().unwrap();
        } else {
            owner.end().unwrap();
        }
        let result = tokio::time::timeout(Duration::from_secs(1), pending).await;
        drop(lane);
        assert_eq!(
            result.unwrap().err().unwrap(),
            if repair {
                "native cache work superseded"
            } else {
                "native login superseded"
            }
        );
        owner.end().unwrap();
        owner.close().unwrap();
    }
}

#[tokio::test]
async fn dropping_a_commit_awaiter_does_not_hide_its_durable_page() {
    let intent = fixture(&ServerSessionState::new());
    let login = intent.work.owner().id().clone();
    let (published, observed) = mpsc::channel();
    let _subscription =
        super::super::thread_feed_commits::THREAD_FEED_COMMITS.subscribe(move |commit| {
            if commit.login == &login {
                assert_eq!(commit.user_id, 42);
                published.send(()).unwrap();
            }
        });
    let gate = super::super::lifetime::CACHE_LIFETIME.invalidate().unwrap();
    let mut pending = Box::pin(intent.commit_thread_page(intent.events(None), vec![], 1));
    assert!(futures_util::poll!(&mut pending).is_pending());
    drop(pending);
    drop(gate);
    observed.recv_timeout(Duration::from_secs(2)).unwrap();
    let cursor = intent
        .work
        .with_database(|conn| read_cursor(conn, 42))
        .unwrap();
    assert_eq!(cursor, 1);
    close(&intent);
}

#[tokio::test]
async fn queued_page_rejects_repair_or_end_without_commit_or_publication() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    for repair in [false, true] {
        let intent = fixture(&ServerSessionState::new());
        let login = intent.work.owner().id().clone();
        let publications = Arc::new(AtomicUsize::new(0));
        let count = publications.clone();
        let _subscription =
            super::super::thread_feed_commits::THREAD_FEED_COMMITS.subscribe(move |commit| {
                if commit.login == &login {
                    count.fetch_add(1, Ordering::SeqCst);
                }
            });
        let gate = super::super::lifetime::CACHE_LIFETIME.invalidate().unwrap();
        let mut pending = Box::pin(intent.commit_thread_page(intent.events(None), vec![], 1));
        assert!(futures_util::poll!(&mut pending).is_pending());
        if repair {
            intent.work.owner().invalidate_database_work().unwrap();
        } else {
            intent.work.owner().end().unwrap();
        }
        let successor = fixture(&ServerSessionState::new());
        drop(gate);
        let error = pending.await.unwrap_err();
        assert_eq!(
            error,
            if repair {
                "native cache work superseded"
            } else {
                "native login superseded"
            }
        );
        assert_eq!(publications.load(Ordering::SeqCst), 0);
        assert_eq!(
            successor
                .work
                .with_database(|conn| read_cursor(conn, 42))
                .unwrap(),
            0
        );
        if repair {
            assert_eq!(
                intent
                    .work
                    .owner()
                    .with_database(|conn| read_cursor(conn, 42))
                    .unwrap(),
                0
            );
        }
        close(&intent);
        close(&successor);
    }
}

async fn paged_feed(invalid_second: bool) {
    let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", server.local_addr().unwrap());
    let proxy = ServerSessionState::new();
    *proxy.api_origin.lock().unwrap() = origin.clone();
    *proxy.api_origin_primary.lock().unwrap() = origin;
    let intent = fixture(&proxy);
    let owner = intent.work.owner().clone();
    owner.with_database(|conn| {
        conn.execute_batch(
            "CREATE TEMP TABLE thread_pages(cursor INTEGER);
             CREATE TEMP TRIGGER insert_connection_proof AFTER INSERT ON main.account_state
             WHEN NEW.thread_feed_cursor IS NOT NULL
             BEGIN INSERT INTO thread_pages VALUES(NEW.thread_feed_cursor); END;
             CREATE TEMP TRIGGER update_connection_proof AFTER UPDATE OF thread_feed_cursor ON main.account_state
             BEGIN INSERT INTO thread_pages VALUES(NEW.thread_feed_cursor); END;"
        ).map_err(|e| e.to_string())
    }).unwrap();
    // Mutating global routing/credentials after capture cannot change either page request.
    *proxy.api_origin.lock().unwrap() = "http://127.0.0.1:9".into();
    *proxy.api_origin_primary.lock().unwrap() = "http://127.0.0.1:9".into();
    *proxy.token.lock().unwrap() = Some("successor-token".into());
    let serving = tokio::spawn(async move {
        let (mut socket, _) = server.accept().await.unwrap();
        let (headers, _) = read_request(&mut socket).await;
        assert!(headers.starts_with(
            "GET /api/v1/user/state-feed?mode=full&after=0&through=1&take=100 HTTP/1.1\r\n"
        ));
        assert!(headers
            .to_ascii_lowercase()
            .contains("authorization: bearer original-token\r\n"));
        let body = serde_json::json!({"code": 0, "data": {
            "mode": "full", "items": [], "scannedThrough": 1,
            "stateFeedEndId": 1, "hasMore": false,
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
        drop(socket);
        for after in 0..2 {
            let (mut socket, _) = server.accept().await.unwrap();
            let (headers, body) = read_request(&mut socket).await;
            assert!(headers.starts_with("POST /api/v1/thread-feed HTTP/1.1\r\n"));
            assert!(headers
                .to_ascii_lowercase()
                .contains("authorization: bearer original-token\r\n"));
            assert_eq!(body["after"], after);
            assert_eq!(body["through"], 2);
            let scanned = after + 1;
            let body = serde_json::json!({"code": 0, "data": {
                "items": [], "scannedThrough": scanned,
                "through": if invalid_second && after == 1 { 1 } else { 2 },
                "threadFeedEndId": 2, "hasMore": scanned < 2,
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
    let events = intent.events(None);
    let demand = NativeThreadFeedIntent {
        feed: intent,
        events,
        target: 2,
    };
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), demand.state_barrier(1))
            .await
            .unwrap()
            .unwrap(),
        1
    );
    let result = tokio::time::timeout(Duration::from_secs(5), demand.synchronize())
        .await
        .unwrap()
        .unwrap();
    serving.await.unwrap();
    assert_eq!(result.cursor, if invalid_second { 1 } else { 2 });
    assert_eq!(result.error.is_some(), invalid_second);
    owner
        .with_database(|conn| {
            let cursors: Vec<i32> = conn
                .prepare("SELECT cursor FROM thread_pages ORDER BY cursor")
                .map_err(|e| e.to_string())?
                .query_map([], |row| row.get(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?;
            assert_eq!(cursors, if invalid_second { vec![1] } else { vec![1, 2] });
            assert_eq!(read_cursor(conn, 42)?, result.cursor);
            Ok(())
        })
        .unwrap();
    owner.end().unwrap();
    owner.close().unwrap();
}

#[tokio::test]
async fn page_requests_retain_original_bearer_endpoint_and_physical_connection() {
    paged_feed(false).await;
}

#[tokio::test]
async fn a_bad_later_page_preserves_the_prior_committed_cursor() {
    paged_feed(true).await;
}

#[tokio::test]
async fn end_and_repair_close_an_actual_stalled_feed_response() {
    for repair in [false, true] {
        let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", server.local_addr().unwrap());
        let proxy = ServerSessionState::new();
        *proxy.api_origin.lock().unwrap() = origin.clone();
        *proxy.api_origin_primary.lock().unwrap() = origin;
        let mut intent = fixture(&proxy);
        let owner = intent.work.owner().clone();
        let (started, ready) = tokio::sync::oneshot::channel();
        let serving = tokio::spawn(async move {
            let (mut socket, _) = server.accept().await.unwrap();
            let _ = read_request(&mut socket).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{")
                .await
                .unwrap();
            started.send(()).unwrap();
            let mut byte = [0; 1];
            let count = tokio::time::timeout(Duration::from_secs(2), socket.read(&mut byte))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(count, 0, "cancelled body must close its TCP connection");
        });
        let pending = tokio::spawn(async move {
            intent
                .post_query("/api/v1/thread-feed".into(), b"{}".to_vec())
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), ready)
            .await
            .unwrap()
            .unwrap();
        if repair {
            owner.invalidate_database_work().unwrap();
        } else {
            owner.end().unwrap();
        }
        let error = tokio::time::timeout(Duration::from_secs(2), pending)
            .await
            .unwrap()
            .unwrap()
            .err()
            .unwrap();
        assert_eq!(
            error,
            if repair {
                "native cache work superseded"
            } else {
                "native login superseded"
            }
        );
        serving.await.unwrap();
        owner.end().unwrap();
        owner.close().unwrap();
    }
}
