use super::*;
use crate::{
    login_connection::LoginConnection, login_request::LoginRequest,
    login_session_store::LoginSessionId, ServerSessionState,
};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

pub(crate) fn fixture(proxy: &ServerSessionState) -> FeedIntent {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    crate::native_db::create_cache_schema(&conn).unwrap();
    let owner = LoginConnection::preparing(
        LoginSessionId::try_from(uuid::Uuid::new_v4().to_string()).unwrap(),
        conn,
    );
    owner
        .begin_activation()
        .unwrap()
        .commit("profile-token".into())
        .unwrap();
    FeedIntent::from_parts(
        42,
        owner.capture_database_work().unwrap(),
        LoginRequest::capture(proxy, owner.clone()).unwrap(),
    )
    .unwrap()
}
fn demand() -> Value {
    json!({"publisherNamespaceId":7,"lookup":"GROUP_MEMBER_PROFILE","groupAccount":"!team",
        "target":{"profileNamespaceId":12,"account":"alice","rev":3}})
}
fn key() -> Value {
    json!({"publisherNamespaceId":7,"profileNamespaceId":12,"account":"alice","rev":3})
}
pub(crate) async fn request(socket: &mut TcpStream) {
    let mut bytes = Vec::new();
    loop {
        let mut chunk = [0; 4096];
        let read = socket.read(&mut chunk).await.unwrap();
        assert!(read > 0);
        bytes.extend_from_slice(&chunk[..read]);
        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    line.strip_prefix("content-length:")
                        .map(|value| value.trim().parse().unwrap())
                })
                .unwrap_or(0);
            if bytes.len() >= end + 4 + length {
                break;
            }
        }
    }
}
pub(crate) async fn response(socket: &mut TcpStream, data: Value) {
    let body = json!({"code":0,"data":data}).to_string();
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

#[tokio::test]
async fn shared_pending_demand_survives_one_consumers_release() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = ServerSessionState::new();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    *proxy.api_origin.lock().unwrap() = origin.clone();
    *proxy.api_origin_primary.lock().unwrap() = origin;
    let intent = fixture(&proxy);
    let count = Arc::new(AtomicUsize::new(0));
    let calls = count.clone();
    let (pending, received) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        calls.fetch_add(1, Ordering::SeqCst);
        response(&mut socket, json!({"status":"PENDING","key":key()})).await;
        drop(socket);
        pending.send(()).unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        calls.fetch_add(1, Ordering::SeqCst);
        response(
            &mut socket,
            json!({"status":"READY","profile":{
            "publisherNamespaceId":7,"profileNamespaceId":12,"account":"alice","rev":3,
            "name":"Alice","bio":"","avatarBase64":null}}),
        )
        .await;
    });
    let first = subscribe(intent.clone(), demand()).unwrap();
    let second = subscribe(intent.clone(), demand()).unwrap();
    assert!(Arc::ptr_eq(&first._flight, &second._flight));
    tokio::time::timeout(Duration::from_secs(3), received)
        .await
        .unwrap()
        .unwrap();
    drop(first);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    wake(42, "PROFILE_AVAILABLE", &key());
    let profile = tokio::time::timeout(Duration::from_secs(3), second.ready())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(profile["name"], "Alice");
    assert_eq!(profile["profileRev"], 3);
    assert_eq!(count.load(Ordering::SeqCst), 2);
    server.await.unwrap();
    intent.work.owner().end().unwrap();
    intent.work.owner().close().unwrap();
}

#[tokio::test]
async fn simultaneous_releases_remove_the_flight_before_a_replacement_subscribes() {
    let intent = fixture(&ServerSessionState::new());
    for index in 0..32 {
        let mut request = demand();
        request["target"]["account"] = json!(format!("alice{index}"));
        let first = subscribe(intent.clone(), request.clone()).unwrap();
        let second = subscribe(intent.clone(), request.clone()).unwrap();
        let key = first.key.clone();
        let previous = first._flight.clone();
        let barrier = std::sync::Barrier::new(3);
        std::thread::scope(|threads| {
            threads.spawn(|| {
                barrier.wait();
                drop(first);
            });
            threads.spawn(|| {
                barrier.wait();
                drop(second);
            });
            barrier.wait();
        });
        assert!(!FLIGHTS.get().unwrap().lock().unwrap().contains_key(&key));
        let replacement = subscribe(intent.clone(), request).unwrap();
        assert!(!Arc::ptr_eq(&previous, &replacement._flight));
        drop(replacement);
    }
    intent.work.owner().end().unwrap();
    intent.work.owner().close().unwrap();
}

#[tokio::test]
async fn last_release_removes_the_flight_and_session_end_finishes_consumers() {
    let intent = fixture(&ServerSessionState::new());
    let first = subscribe(intent.clone(), demand()).unwrap();
    let old = first._flight.clone();
    drop(first);
    let second = subscribe(intent.clone(), demand()).unwrap();
    assert!(!Arc::ptr_eq(&old, &second._flight));
    intent.work.owner().end().unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(3), second.ready())
        .await
        .unwrap()
        .is_err());
    intent.work.owner().close().unwrap();
}
