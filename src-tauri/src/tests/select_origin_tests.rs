use super::*;

/// The correctness boundary for origin fallback: a connect-level failure (ECONNREFUSED on a closed
/// loopback port) must classify as a network failure → a select_origin re-race candidate. An HTTP
/// status (incl. 401) never reaches `is_network_failure` (it's an `Ok(Response)`, not an `Err`), so
/// fallback never triggers on a reachable server. Bind+drop to claim a free port, then connect to it.
#[tokio::test]
async fn is_network_failure_classifies_a_connect_failure_as_switchable() {
    let addr = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    // listener dropped here — port is closed → ECONNREFUSED at connect
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let err = client
        .get(format!("http://{addr}/api/v1/health"))
        .send()
        .await
        .expect_err("connecting to a closed port must error");
    assert!(
        is_network_failure(&err),
        "a connect failure must be a network failure: {err}"
    );
    // Sanity: the closed-port case is a CONNECT failure specifically (the boundary is is_connect || is_timeout).
    assert!(
        err.is_connect(),
        "expected is_connect for ECONNREFUSED: {err}"
    );
}
