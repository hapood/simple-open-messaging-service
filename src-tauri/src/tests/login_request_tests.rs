use super::*;
use crate::login_session_store::LoginSessionId;
use rusqlite::Connection;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

fn owner() -> Arc<LoginConnection> {
    let id = LoginSessionId::try_from(uuid::Uuid::new_v4().to_string()).unwrap();
    let owner = LoginConnection::preparing(id, Connection::open_in_memory().unwrap());
    owner
        .begin_activation()
        .unwrap()
        .commit("original-token".into())
        .unwrap();
    owner
}

#[test]
fn a_request_cannot_be_paired_with_another_physical_owner_even_for_the_same_uuid() {
    let original = owner();
    let request = LoginRequest::capture(&ServerSessionState::new(), original.clone()).unwrap();
    let restored =
        LoginConnection::preparing(original.id().clone(), Connection::open_in_memory().unwrap());
    restored
        .begin_activation()
        .unwrap()
        .commit("new-token".into())
        .unwrap();
    assert!(request.assert_owner(&original).is_ok());
    assert_eq!(
        request.assert_owner(&restored).unwrap_err(),
        "native request owner mismatch"
    );
    original.end().unwrap();
    original.close().unwrap();
    restored.end().unwrap();
    restored.close().unwrap();
}

fn origins(proxy: &ServerSessionState, primary: &str, secondary: Option<String>) {
    *proxy.api_origin.lock().unwrap() = primary.into();
    *proxy.api_origin_primary.lock().unwrap() = primary.into();
    *proxy.api_origin_secondary.lock().unwrap() = secondary;
}

async fn read_request(socket: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
        let mut buffer = [0; 1024];
        let count = socket.read(&mut buffer).await.unwrap();
        assert_ne!(count, 0);
        bytes.extend_from_slice(&buffer[..count]);
    }
    String::from_utf8(bytes).unwrap()
}

async fn respond(socket: &mut TcpStream, status: &str, body: &str) {
    socket
        .write_all(
            format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn captured_request_never_reads_successor_origin_or_credential() {
    let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", server.local_addr().unwrap());
    let successor = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let successor_origin = format!("http://{}", successor.local_addr().unwrap());
    let proxy = ServerSessionState::new();
    origins(&proxy, &origin, None);
    let owner = owner();
    let mut request = LoginRequest::capture(&proxy, owner.clone()).unwrap();
    origins(&proxy, &successor_origin, None);
    *proxy.token.lock().unwrap() = Some("successor-token".into());
    let serve = tokio::spawn(async move {
        let (mut socket, _) = server.accept().await.unwrap();
        let headers = read_request(&mut socket).await;
        assert!(headers.starts_with("GET /owned HTTP/1.1"));
        assert!(headers
            .to_lowercase()
            .contains("authorization: bearer original-token\r\n"));
        assert!(!headers.contains("successor-token"));
        respond(&mut socket, "200 OK", "original").await;
    });
    let response = request.get("/owned".into()).await.unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.body, "original");
    serve.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), successor.accept())
            .await
            .is_err()
    );
    owner.end().unwrap();
    assert_eq!(
        request
            .get("/must-not-dispatch".into())
            .await
            .err()
            .unwrap(),
        "native login superseded"
    );
}

#[tokio::test]
async fn end_cancels_the_socket_while_waiting_for_a_body_without_holding_sql() {
    let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = ServerSessionState::new();
    origins(
        &proxy,
        &format!("http://{}", server.local_addr().unwrap()),
        None,
    );
    let owner = owner();
    let mut request = LoginRequest::capture(&proxy, owner.clone()).unwrap();
    let (headers_sent, ready) = tokio::sync::oneshot::channel();
    let serve = tokio::spawn(async move {
        let (mut socket, _) = server.accept().await.unwrap();
        read_request(&mut socket).await;
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n")
            .await
            .unwrap();
        headers_sent.send(()).unwrap();
        let mut rest = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), socket.read_to_end(&mut rest))
            .await
            .expect("owner cancellation must close the actual socket")
            .unwrap();
    });
    let fetching = tokio::spawn(async move { request.get("/silent-body".into()).await });
    tokio::time::timeout(Duration::from_secs(2), ready)
        .await
        .unwrap()
        .unwrap();
    owner
        .with_database(|conn| {
            conn.execute_batch("CREATE TEMP TABLE no_network_lock(value INTEGER);")
                .map_err(|e| e.to_string())
        })
        .unwrap();
    owner.end().unwrap();
    let response = tokio::time::timeout(Duration::from_secs(2), fetching)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.err().unwrap(), "native login superseded");
    serve.await.unwrap();
    owner.close().unwrap();
}

async fn verify_captured_failover(post_query: bool) {
    let unavailable = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let primary = format!("http://{}", unavailable.local_addr().unwrap());
    drop(unavailable);
    let fallback = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let secondary = format!("http://{}", fallback.local_addr().unwrap());
    let successor = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let successor_origin = format!("http://{}", successor.local_addr().unwrap());
    let proxy = ServerSessionState::new();
    origins(&proxy, &primary, Some(secondary));
    let owner = owner();
    let mut request = LoginRequest::capture(&proxy, owner).unwrap();
    origins(&proxy, &successor_origin, None);
    *proxy.token.lock().unwrap() = Some("successor-token".into());
    let serve = tokio::spawn(async move {
        let (mut probe, _) = fallback.accept().await.unwrap();
        let headers = read_request(&mut probe).await;
        assert!(headers.starts_with("GET /api/v1/client/compat HTTP/1.1"));
        assert!(!headers.to_lowercase().contains("authorization:"));
        respond(
            &mut probe,
            "200 OK",
            r#"{"code":0,"data":{"apiVersion":1}}"#,
        )
        .await;
        drop(probe);
        let (mut replay, _) = fallback.accept().await.unwrap();
        let headers = read_request(&mut replay).await;
        let method = if post_query { "POST" } else { "GET" };
        assert!(headers.starts_with(&format!("{method} /owned-retry HTTP/1.1")));
        if post_query {
            let expected = br#"{"threadId":7,"before":4,"take":3}"#;
            let mut body = headers
                .split_once("\r\n\r\n")
                .unwrap()
                .1
                .as_bytes()
                .to_vec();
            assert!(body.len() <= expected.len());
            let mut remaining = vec![0; expected.len() - body.len()];
            replay.read_exact(&mut remaining).await.unwrap();
            body.extend_from_slice(&remaining);
            assert_eq!(body, expected);
            assert!(headers
                .to_lowercase()
                .contains("content-type: application/json\r\n"));
        }
        assert!(headers
            .to_lowercase()
            .contains("authorization: bearer original-token\r\n"));
        respond(&mut replay, "200 OK", "replayed").await;
    });
    let response = tokio::time::timeout(Duration::from_secs(5), async {
        if post_query {
            request
                .post_query(
                    "/owned-retry".into(),
                    br#"{"threadId":7,"before":4,"take":3}"#.to_vec(),
                )
                .await
        } else {
            request.get("/owned-retry".into()).await
        }
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(response.body, "replayed");
    serve.await.unwrap();
    assert_eq!(*proxy.api_origin.lock().unwrap(), successor_origin);
    assert_eq!(
        proxy.token.lock().unwrap().as_deref(),
        Some("successor-token")
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(50), successor.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn failover_reuses_only_captured_candidates_and_token_without_global_publication() {
    verify_captured_failover(false).await;
}

#[tokio::test]
async fn read_only_post_failover_replays_original_json_and_captured_credential() {
    verify_captured_failover(true).await;
}
