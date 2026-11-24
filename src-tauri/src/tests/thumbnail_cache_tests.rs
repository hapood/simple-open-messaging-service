use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn server(
    status: &str,
    bytes: &[u8],
) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let hits = Arc::new(AtomicUsize::new(0));
    let count = hits.clone();
    let response = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nX-Thumbnail-Digest: {}\r\nConnection: close\r\n\r\n", bytes.len(), super::super::sha256_hex(bytes));
    let bytes = bytes.to_vec();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            count.fetch_add(1, Ordering::SeqCst);
            let mut request = [0; 4096];
            let _ = socket.read(&mut request).await;
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.write_all(&bytes).await;
        }
    });
    (address, hits, task)
}

fn output() -> PathBuf {
    std::env::temp_dir()
        .join(format!("soms-thumbnail-{}", uuid::Uuid::new_v4()))
        .join("digest.webp")
}

#[test]
fn message_coordinates_do_not_change_digest_identity() {
    let digest = "a".repeat(64);
    let path = format!("/uploads/thumbnails/aa/aa/{digest}");
    assert_eq!(
        canonical_path(&format!("{path}?threadId=1&seq=2")).unwrap(),
        path
    );
    assert!(canonical_path(&format!("/uploads/thumbnails/bb/aa/{digest}")).is_err());
}

#[tokio::test]
async fn failure_is_persisted_and_remount_does_not_contact_server() {
    let (url, hits, server) = server("404 Not Found", b"").await;
    let output = output();
    let request = || reqwest::Client::new().get(&url);
    let first = fetch(
        output.clone(),
        "session".into(),
        request(),
        CancellationToken::new(),
        || true,
    )
    .await
    .unwrap_err();
    let second = fetch(
        output.clone(),
        "session".into(),
        request(),
        CancellationToken::new(),
        || true,
    )
    .await
    .unwrap_err();
    assert_eq!(first, second);
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    assert_eq!(
        tokio::fs::read_to_string(output.with_extension("failure"))
            .await
            .unwrap(),
        first
    );
    server.abort();
    tokio::fs::remove_dir_all(output.parent().unwrap())
        .await
        .unwrap();
}

#[tokio::test]
async fn dropping_one_observer_keeps_the_single_request_alive() {
    let (url, hits, server) = server("200 OK", b"thumbnail").await;
    let output = output();
    let first = fetch(
        output.clone(),
        "session".into(),
        reqwest::Client::new().get(&url),
        CancellationToken::new(),
        || true,
    );
    let second = fetch(
        output.clone(),
        "session".into(),
        reqwest::Client::new().get(&url),
        CancellationToken::new(),
        || true,
    );
    let mut first = Box::pin(first);
    let mut second = Box::pin(second);
    assert!(futures_util::poll!(&mut first).is_pending());
    assert!(futures_util::poll!(&mut second).is_pending());
    drop(first);
    assert_eq!(second.await.unwrap(), b"thumbnail");
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    assert_eq!(
        fetch(
            output.clone(),
            "session".into(),
            reqwest::Client::new().get(&url),
            CancellationToken::new(),
            || true
        )
        .await
        .unwrap(),
        b"thumbnail"
    );
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    server.abort();
    tokio::fs::remove_dir_all(output.parent().unwrap())
        .await
        .unwrap();
}

#[tokio::test]
async fn cancelled_session_is_not_a_cached_download_failure() {
    let output = output();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(fetch(
        output.clone(),
        "session".into(),
        reqwest::Client::new().get("http://127.0.0.1:1"),
        cancel,
        || true
    )
    .await
    .is_err());
    assert!(!output.with_extension("failure").exists());
}
