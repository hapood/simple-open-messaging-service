use super::*;
use crate::native_db::profile_namespaces::{
    read_bindings, ProfileNamespaceBinding, ProfileNamespacePair,
};
use crate::{
    login_connection::LoginConnection, login_request::LoginRequest,
    login_session_store::LoginSessionId, ServerSessionState,
};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

type Owned = (
    Arc<LoginConnection>,
    crate::login_connection::DatabaseWork,
    LoginRequest,
);

fn owned(proxy: &ServerSessionState) -> Owned {
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
    (
        owner.clone(),
        owner.capture_database_work().unwrap(),
        LoginRequest::capture(proxy, owner).unwrap(),
    )
}

async fn read_request(socket: &mut TcpStream) -> String {
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
                return headers;
            }
        }
    }
}

async fn respond(socket: &mut TcpStream, data: Value) {
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

fn pair() -> ProfileNamespacePair {
    ProfileNamespacePair {
        publisher_namespace_id: 7,
        profile_namespace_id: 2,
    }
}

async fn read_row(work: &crate::login_connection::DatabaseWork) -> Option<ProfileNamespaceBinding> {
    spawn_owned_database(Ok(work.clone()), move |conn| {
        let mut rows = read_bindings(conn, 42, &[pair()])?;
        Ok(rows.pop())
    })
    .await
    .unwrap()
    .unwrap()
}

#[tokio::test]
async fn drain_applies_pages_advances_the_cursor_and_warms_bindings() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = ServerSessionState::new();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    *proxy.api_origin.lock().unwrap() = origin.clone();
    *proxy.api_origin_primary.lock().unwrap() = origin;
    let (owner, work, request) = owned(&proxy);
    // Seed a live binding an older change coordinate; the page's change 5
    // must expire it, and the warm round must converge it again.
    spawn_owned_database(Ok(work.clone()), |conn| {
        conn.execute(
            "INSERT INTO profile_namespaces(
               user_id,publisher_namespace_id,profile_namespace_id,domain,root_public_key,
               update_feed_id,change_seq,expired,status,refreshed_at
             ) VALUES(42,7,2,'stale.test','key',2,3,0,'ACTIVE',0)",
            [],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .unwrap()
    .unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let headers = read_request(&mut socket).await;
        assert!(headers.contains("get /api/v1/user/profile-namespace-feed?after=0&take=100"));
        respond(
            &mut socket,
            json!({
                "items":[{"publisherNamespaceId":7,"profileNamespaceId":2,"changeId":5}],
                "scannedThrough":5,"endId":5,"hasMore":false}),
        )
        .await;
        drop(socket);
        // The warmed undemanded pair resolves through the shared flight.
        let (mut socket, _) = listener.accept().await.unwrap();
        let headers = read_request(&mut socket).await;
        assert!(headers.contains("post /api/v1/profile-namespaces/resolve"));
        respond(
            &mut socket,
            json!({"status":"READY","entry":{
                "publisherNamespaceId":7,"profileNamespaceId":2,"domain":"chat.test",
                "rootPublicKey":"key","updateFeedId":4,"expired":false,"status":"ACTIVE"}}),
        )
        .await;
    });
    synchronize_owned(work.clone(), request, 42).await.unwrap();
    let cursor: i64 = spawn_owned_database(Ok(work.clone()), move |conn| {
        conn.query_row(
            "SELECT COALESCE(profile_namespace_change_end_id,0)
             FROM account_state WHERE user_id=42",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(cursor, 5);
    // The warm round is fire-and-forget; poll until the binding converged.
    let converged = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(row) = read_row(&work).await {
                if !row.expired && row.domain.as_deref() == Some("chat.test") {
                    assert_eq!((row.change_seq, row.update_feed_id), (5, 4));
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await;
    assert!(converged.is_ok(), "warmed binding did not converge");
    server.await.unwrap();
    owner.end().unwrap();
    owner.close().unwrap();
}

#[test]
fn drain_rejects_pages_that_skip_or_rewind_coordinates() {
    let page = |scanned: i64, change: i64| Page {
        items: vec![ProfileNamespaceChange {
            publisher_namespace_id: 7,
            profile_namespace_id: 2,
            change_id: change,
        }],
        scanned_through: scanned,
        end_id: scanned,
        has_more: false,
    };
    assert!(validate(&page(5, 5), 0).is_ok());
    assert!(
        validate(&page(5, 3), 0).is_ok(),
        "older change inside the window is legal"
    );
    assert!(
        validate(&page(5, 0), 0).is_err(),
        "change at or below `after`"
    );
    assert!(validate(&page(5, 6), 0).is_err(), "change beyond the scan");
    assert!(validate(&page(4, 4), 4).is_err(), "scan did not advance");
}
