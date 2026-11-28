use super::*;
use crate::login_connection::LoginConnection;
use crate::login_session_store::LoginSessionId;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn owner() -> Arc<LoginConnection> {
    let owner = LoginConnection::preparing(
        LoginSessionId::try_from(uuid::Uuid::new_v4().to_string()).unwrap(),
        rusqlite::Connection::open_in_memory().unwrap(),
    );
    owner.begin_activation().unwrap().commit("captured-token".into()).unwrap();
    owner
}

#[tokio::test]
async fn queued_proxy_cancellation_never_dispatches_and_auth_needs_no_login() {
    let held = crate::login_request::SHORT_REQUEST_SEMAPHORE.acquire_many(8).await.unwrap();
    let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = ServerSessionState::new();
    proxy.routes.replace(format!("http://{}", server.local_addr().unwrap()), None);
    let owner = owner();
    let cancel = CancellationToken::new();
    let request = perform_scheduled_http_request(None, &proxy, "GET".into(), "/api/v1/test".into(), Default::default(), None, false, true, &cancel, Some(owner.clone()), true);
    tokio::pin!(request);
    tokio::select! {
        _ = &mut request => panic!("request must wait for admission"),
        _ = tokio::task::yield_now() => {},
    }
    owner.end().unwrap();
    assert_eq!(request.await.err().unwrap(), "native login superseded");
    drop(held);
    assert!(tokio::time::timeout(Duration::from_millis(30), server.accept()).await.is_err());

    // Pre-login/authentication work has no business owner and remains callable.
    let serve = tokio::spawn(async move {
        let (mut socket, _) = server.accept().await.unwrap();
        let mut bytes = vec![0; 4096];
        let count = socket.read(&mut bytes).await.unwrap();
        assert!(!String::from_utf8_lossy(&bytes[..count]).contains("captured-token"));
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await.unwrap();
    });
    let response = perform_scheduled_http_request(None, &proxy, "GET".into(), "/api/v1/auth/test".into(), Default::default(), None, false, true, &cancel, None, true).await.unwrap();
    assert_eq!(response.status, 200);
    serve.await.unwrap();
}

#[tokio::test]
async fn owner_end_cancels_an_inflight_proxy_body_and_releases_admission() {
    let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = ServerSessionState::new();
    proxy.routes.replace(format!("http://{}", server.local_addr().unwrap()), None);
    let owner = owner();
    let (ready, received) = tokio::sync::oneshot::channel();
    let serve = tokio::spawn(async move {
        let (mut socket, _) = server.accept().await.unwrap();
        let mut bytes = vec![0; 4096];
        let count = socket.read(&mut bytes).await.unwrap();
        assert!(String::from_utf8_lossy(&bytes[..count]).contains("Bearer captured-token"));
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n").await.unwrap();
        ready.send(()).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(2), socket.read(&mut bytes)).await.unwrap();
        assert!(matches!(result, Ok(0)) || result.is_err());
    });
    let captured = owner.clone();
    let fetch = tokio::spawn(async move {
        perform_scheduled_http_request(None, &proxy, "GET".into(), "/api/v1/test".into(), Default::default(), None, false, true, &CancellationToken::new(), Some(captured), true).await
    });
    received.await.unwrap();
    owner.end().unwrap();
    assert_eq!(fetch.await.unwrap().err().unwrap(), "native login superseded");
    serve.await.unwrap();
    let _all = tokio::time::timeout(Duration::from_secs(2), crate::login_request::SHORT_REQUEST_SEMAPHORE.acquire_many(8)).await.unwrap().unwrap();
}

#[test]
fn independent_routes_are_captured_before_queueing() {
    let proxy = ServerSessionState::new();
    proxy.routes.replace("http://127.0.0.1:30101".into(), Some("http://127.0.0.1:30102".into()));
    let route = CapturedHttpRoute::capture(&proxy);
    proxy.routes.replace("http://127.0.0.1:40101".into(), None);
    assert_eq!(route.active.0, "http://127.0.0.1:30101");
    assert_eq!(route.primary.0, "http://127.0.0.1:30101");
    assert_eq!(route.secondary.unwrap().0, "http://127.0.0.1:30102");
}

#[test]
fn configuration_publication_during_capture_cannot_mix_retry_candidates() {
    let proxy = ServerSessionState::new();
    proxy.routes.replace("https://old.example".into(), Some("http://old.lan".into()));
    activate_origin(&proxy, "http://old.lan", OriginMode::Secondary);
    let (capturing, capture_started) = std::sync::mpsc::sync_channel(0);
    let (published, publication_done) = std::sync::mpsc::sync_channel(0);
    std::thread::scope(|threads| {
        let writer_proxy = proxy.clone();
        let writer = threads.spawn(move || {
            capture_started.recv_timeout(Duration::from_secs(2)).unwrap();
            // Publish while capture is still constructing its first endpoint, not after capture
            // returns. The reader must finish with the old active AND both old retry candidates.
            writer_proxy.routes.replace("https://new.example".into(), Some("http://new.lan".into()));
            published.send(()).unwrap();
        });
        let mut first = true;
        let route = CapturedHttpRoute::capture_with_client(&proxy, |origin| {
            if first {
                first = false;
                capturing.send(()).unwrap();
                publication_done.recv_timeout(Duration::from_secs(2)).unwrap();
            }
            proxy.api_client(origin)
        });
        writer.join().unwrap();
        assert_eq!(route.active.0, "http://old.lan");
        assert_eq!(route.primary.0, "https://old.example");
        assert_eq!(route.secondary.unwrap().0, "http://old.lan");
        let successor = CapturedHttpRoute::capture(&proxy);
        assert_eq!(successor.active.0, "https://new.example");
        assert_eq!(successor.primary.0, "https://new.example");
        assert_eq!(successor.secondary.unwrap().0, "http://new.lan");
    });
}

#[test]
fn cancellation_between_preparation_and_dispatch_is_retained() {
    let proxy = ServerSessionState::new();
    prepare_request(&proxy, "pending").unwrap();
    assert!(cancel_registered_request(&proxy, "pending"));
    let claimed = claim_prepared_request(&proxy, "pending".into()).unwrap();
    assert!(claimed.token().is_cancelled());
    drop(claimed);
    assert!(claim_prepared_request(&proxy, "pending".into()).is_err());
    assert!(claim_prepared_request(&proxy, "never-prepared".into()).is_err());
}

#[test]
fn bulk_and_stream_paths_do_not_consume_short_request_admission() {
    let mut headers = std::collections::HashMap::new();
    for path in ["/uploads/a", "/api/v1/upload/avatar", "/api/v1/uploads/resumable/1?part=2"] {
        assert!(!is_short_http_path(path, false, &headers));
    }
    assert!(!is_short_http_path("/api/v1/test", true, &headers));
    headers.insert("accept".into(), "text/event-stream".into());
    assert!(!is_short_http_path("/api/v1/test", false, &headers));
    assert!(is_short_http_path("/api/v1/test", false, &Default::default()));
}
