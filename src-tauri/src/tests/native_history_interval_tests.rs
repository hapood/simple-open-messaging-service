use super::*;
use crate::login_connection::LoginConnection;
use crate::login_session_store::LoginSessionId;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn intent(origin: &str) -> NativeHistoryIntent {
    let conn = Connection::open_in_memory().unwrap();
    crate::native_db::create_cache_schema(&conn).unwrap();
    crate::native_db::thread_store::insert_test_thread(&conn, 42, 7, 3);
    conn.execute("INSERT INTO message_ranges(user_id,thread_id,left_exclusive,right_inclusive,state) VALUES(42,7,0,100,'SERVER_PENDING')", []).unwrap();
    let owner = LoginConnection::preparing(
        LoginSessionId::try_from(uuid::Uuid::new_v4().to_string()).unwrap(),
        conn,
    );
    owner
        .begin_activation()
        .unwrap()
        .commit("interval-token".into())
        .unwrap();
    let proxy = ServerSessionState::new();
    proxy.routes.replace(origin.into(), None);
    let work = owner.capture_database_work().unwrap();
    NativeHistoryIntent {
        request: LoginRequest::capture(&proxy, owner).unwrap(),
        events: crate::realtime::NativeEvents::for_database_work(None, work.clone()),
        work,
        user_id: 42,
        thread_id: 7,
    }
}

async fn server(body: Value) -> (String, tokio::task::JoinHandle<Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let boundary = loop {
            let mut buf = [0; 1024];
            let n = socket.read(&mut buf).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buf[..n]);
            if let Some(i) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                break i + 4;
            }
        };
        let header = String::from_utf8_lossy(&bytes[..boundary]).to_lowercase();
        assert!(header.starts_with("post /api/v1/query-messages "));
        let len: usize = header
            .lines()
            .find_map(|l| l.strip_prefix("content-length: "))
            .unwrap()
            .parse()
            .unwrap();
        while bytes.len() < boundary + len {
            let mut buf = [0; 1024];
            let n = socket.read(&mut buf).await.unwrap();
            bytes.extend_from_slice(&buf[..n]);
        }
        let query = serde_json::from_slice(&bytes[boundary..boundary + len]).unwrap();
        let body = body.to_string();
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
        query
    });
    (origin, task)
}

#[tokio::test]
async fn pending_interval_is_refreshed_once_and_only_committed_scan_is_emitted() {
    let (origin, query) = server(json!({"code":0,"message":"","data":{
        "messages":[{"threadId":7,"seq":79,"createdAt":1}],
        "gaps":[{"startSeq":71,"endSeq":78,"recoverable":true}],
        "scannedThrough":71,"hasMore":true
    }}))
    .await;
    let mut intent = intent(&origin);
    let page = intent
        .refresh_interval(
            MessageInterval {
                left: 20,
                right: 80,
            },
            HistoryDirection::Older,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        query.await.unwrap(),
        json!({"threadId":7,"before":81,"through":21,"take":50})
    );
    assert_eq!((page.left, page.right), (70, 80));
    assert_eq!(page.items.len(), 2);
    let ranges = intent
        .work
        .with_database(|conn| load_message_ranges(conn, 42, 7))
        .unwrap();
    assert!(ranges
        .iter()
        .any(|r| r.left == 0 && r.right == 78 && r.state == MessageRangeState::ServerPending));
    assert!(ranges
        .iter()
        .any(|r| r.left == 80 && r.right == 100 && r.state == MessageRangeState::ServerPending));
}

#[tokio::test]
async fn full_intersecting_gaps_are_clipped_without_changing_outside_coverage() {
    let (origin, query) = server(json!({"code":0,"message":"","data":{
        "messages":[{"threadId":7,"seq":76,"createdAt":1}],
        "gaps":[
            {"startSeq":1,"endSeq":74,"recoverable":false},
            {"startSeq":78,"endSeq":100,"recoverable":false}
        ],
        "scannedThrough":71,"hasMore":true
    }}))
    .await;
    let mut intent = intent(&origin);
    commit_native_message_page(
        intent.work.clone(),
        42,
        7,
        Some(MessageInterval { left: 0, right: 20 }),
        vec![json!({"threadId":7,"seq":10,"createdAt":1,"content":"outside-left"})],
        vec![],
        None,
    )
    .await
    .unwrap();
    commit_native_message_page(
        intent.work.clone(),
        42,
        7,
        Some(MessageInterval {
            left: 80,
            right: 100,
        }),
        vec![json!({"threadId":7,"seq":90,"createdAt":1,"content":"outside-right"})],
        vec![],
        None,
    )
    .await
    .unwrap();
    let page = intent
        .refresh_interval(
            MessageInterval {
                left: 20,
                right: 80,
            },
            HistoryDirection::Older,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        query.await.unwrap(),
        json!({"threadId":7,"before":81,"through":21,"take":50})
    );
    let page = serde_json::to_value(page).unwrap();
    assert_eq!(page["left"], 70);
    assert_eq!(page["right"], 80);
    assert_eq!(
        page["items"][0],
        json!({"kind":"serverGap","left":70,"right":74,"state":"SERVER_UNAVAILABLE"})
    );
    assert_eq!(page["items"][1]["message"]["seq"], 76);
    assert_eq!(
        page["items"][2],
        json!({"kind":"serverGap","left":77,"right":80,"state":"SERVER_UNAVAILABLE"})
    );
    let ranges = intent
        .work
        .with_database(|conn| load_message_ranges(conn, 42, 7))
        .unwrap();
    assert_eq!(
        ranges
            .iter()
            .map(|r| (r.left, r.right, r.state))
            .collect::<Vec<_>>(),
        vec![
            (0, 20, MessageRangeState::LocalCovered),
            (20, 70, MessageRangeState::ServerPending),
            (70, 74, MessageRangeState::ServerUnavailable),
            (74, 77, MessageRangeState::LocalCovered),
            (77, 80, MessageRangeState::ServerUnavailable),
            (80, 100, MessageRangeState::LocalCovered),
        ]
    );
    let outside = intent
        .work
        .with_database(|conn| load_live_messages_by_seqs(conn, 42, 7, &[10, 90]))
        .unwrap();
    assert_eq!(outside[0]["content"], "outside-left");
    assert_eq!(outside[1]["content"], "outside-right");
}

#[tokio::test]
async fn invalid_or_disjoint_wire_gaps_do_not_change_cache() {
    for gap in [
        json!({"startSeq":0,"endSeq":75,"recoverable":true}),
        json!({"startSeq":76,"endSeq":75,"recoverable":true}),
        json!({"startSeq":1,"endSeq":70,"recoverable":true}),
        json!({"startSeq":81,"endSeq":100,"recoverable":true}),
        json!({"startSeq":71,"endSeq":9_007_199_254_740_992i64,"recoverable":true}),
    ] {
        let (origin, query) = server(json!({"code":0,"message":"","data":{
            "messages":[],"gaps":[gap],"scannedThrough":71,"hasMore":true
        }}))
        .await;
        let mut intent = intent(&origin);
        assert!(intent
            .refresh_interval(
                MessageInterval {
                    left: 20,
                    right: 80
                },
                HistoryDirection::Older,
            )
            .await
            .is_err());
        query.await.unwrap();
        let ranges = intent
            .work
            .with_database(|conn| load_message_ranges(conn, 42, 7))
            .unwrap();
        assert_eq!(ranges.len(), 1);
        assert_eq!(
            (ranges[0].left, ranges[0].right, ranges[0].state),
            (0, 100, MessageRangeState::ServerPending)
        );
    }
}

#[tokio::test]
async fn out_of_interval_page_does_not_change_cache() {
    let (origin, query) = server(json!({"code":0,"message":"","data":{
        "messages":[],"gaps":[],"scannedThrough":1,"hasMore":false
    }}))
    .await;
    let mut intent = intent(&origin);
    assert!(intent
        .refresh_interval(
            MessageInterval {
                left: 20,
                right: 80
            },
            HistoryDirection::Older,
        )
        .await
        .is_err());
    query.await.unwrap();
    let ranges = intent
        .work
        .with_database(|conn| load_message_ranges(conn, 42, 7))
        .unwrap();
    assert_eq!(ranges.len(), 1);
    assert_eq!((ranges[0].left, ranges[0].right), (0, 100));
}

#[tokio::test]
async fn mounted_stream_notification_commits_then_publishes_over_ipc() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let mut history = intent(&origin);
    let cancel = history.isolate_consumer();
    let work = history.work.clone();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        let size = stream.read(&mut request).await.unwrap();
        let headers = String::from_utf8_lossy(&request[..size]);
        assert!(headers
            .starts_with("GET /api/v1/message/history-interval?threadId=7&left=20&right=80 "));
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\nevent: MESSAGE_HISTORY_INTERVAL\ndata: {\"threadId\":7,\"left\":20,\"right\":80}\n\n").await.unwrap();
        let (mut page_socket, _) = listener.accept().await.unwrap();
        let size = page_socket.read(&mut request).await.unwrap();
        assert!(
            String::from_utf8_lossy(&request[..size]).starts_with("POST /api/v1/query-messages ")
        );
        let body = json!({"code":0,"message":"","data":{
            "messages":[{"threadId":7,"seq":79,"createdAt":1}],
            "gaps":[],"scannedThrough":71,"hasMore":true
        }})
        .to_string();
        page_socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        // Keep the SSE mount open until the consumer explicitly cancels.
        let mut byte = [0; 1];
        stream.read(&mut byte).await.unwrap();
    });
    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let channel = tauri::ipc::Channel::new(move |body| {
        send.send(body.deserialize::<Value>().unwrap()).unwrap();
        Ok(())
    });
    let task_cancel = cancel.clone();
    let task = tokio::spawn(async move {
        crate::native_db::history_ipc::run_until_cancelled(
            &task_cancel,
            history.watch_interval(20, 80, HistoryDirection::Older, channel),
        )
        .await
    });
    let page = tokio::time::timeout(std::time::Duration::from_secs(5), receive.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(page["state"], "page");
    assert_eq!(page["page"]["left"], 70);
    assert_eq!(page["page"]["right"], 80);
    assert_eq!(page["page"]["items"][0]["message"]["seq"], 79);
    assert_eq!(
        work.with_database(|conn| conn
            .query_row("SELECT count(*) FROM messages WHERE seq=79", [], |row| row
                .get::<_, i64>(
                0
            ))
            .map_err(|e| e.to_string()))
            .unwrap(),
        1
    );
    cancel.cancel();
    assert!(task.await.unwrap().is_none());
    server.await.unwrap();
}

#[test]
fn coordinates_are_clipped_and_bursts_coalesce() {
    let bounds = MessageInterval {
        left: 20,
        right: 80,
    };
    assert!(notification(&json!({"threadId":8,"left":20,"right":80}), 7, bounds).is_none());
    let interval = notification(&json!({"threadId":7,"left":0,"right":100}), 7, bounds).unwrap();
    assert_eq!((interval.left, interval.right), (20, 80));
    let dirty = DirtyInterval::default();
    dirty.mark(MessageInterval {
        left: 20,
        right: 40,
    });
    dirty.mark(MessageInterval {
        left: 30,
        right: 80,
    });
    let interval = dirty.take().unwrap();
    assert_eq!((interval.left, interval.right), (20, 80));
    assert!(dirty.take().is_none());
}

#[tokio::test]
async fn consumer_cancellation_fences_queued_database_commit_without_ending_session() {
    let mut intent = intent("http://127.0.0.1:1");
    let token = intent.isolate_consumer();
    let owner = intent.work.owner().clone();
    token.cancel();
    let result = commit_native_message_page(
        intent.work.clone(),
        42,
        7,
        Some(MessageInterval {
            left: 20,
            right: 80,
        }),
        vec![],
        vec![],
        None,
    )
    .await;
    assert!(result.is_err());
    owner.assert_active().unwrap();
    owner
        .capture_database_work()
        .unwrap()
        .assert_current()
        .unwrap();
}
