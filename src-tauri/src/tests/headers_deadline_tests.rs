use super::*;
use crate::proxy::{send_with_headers_deadline, HeadersError};

/// A peer that completes the TCP handshake then never sends a byte — reqwest is "connected" but
/// waits for headers that never arrive, so the deadline fires.
struct SilentPeer {
    _addr: std::net::SocketAddr,
    _thread: std::thread::JoinHandle<()>,
}

impl SilentPeer {
    fn spawn() -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        // Accept and then hold the socket open without responding: `io::copy` from the stream blocks
        // until the client closes (which happens when the deadline drops the reqwest future), so the
        // thread ends cleanly with the test — no leak.
        let thread = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let _ = std::io::copy(&mut stream, &mut std::io::sink());
            }
        });
        Self {
            _addr: addr,
            _thread: thread,
        }
    }
}

#[tokio::test]
async fn deadline_yields_timeout_when_upstream_accepts_but_never_responds() {
    let peer = SilentPeer::spawn();
    let client = reqwest::Client::new();
    let url = format!("http://{}/", peer._addr);
    let outcome = send_with_headers_deadline(client.get(&url), Duration::from_millis(200)).await;
    assert!(
        matches!(outcome, Err(HeadersError::Timeout)),
        "a silent upstream past the deadline must be Timeout (→504), got {outcome:?}"
    );
}

#[tokio::test]
async fn deadline_yields_send_failed_for_an_unreachable_host() {
    // A port with no listener on the loopback → ECONNREFUSED at connect (a SendFailed, NOT a Timeout)
    // — this is the case that must stay an `Err` (→ JS "network"), proving the 504 path is gated to
    // connected-but-silent only. Bind+drop to claim a free port, then connect to the now-closed port.
    let addr = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    // (listener dropped here — port closed)
    let client = reqwest::Client::new();
    let url = format!("http://{addr}/");
    let outcome = send_with_headers_deadline(client.get(&url), Duration::from_secs(2)).await;
    assert!(
        matches!(outcome, Err(HeadersError::SendFailed(_))),
        "an unreachable host must be SendFailed (→network), not Timeout, got {outcome:?}"
    );
}
