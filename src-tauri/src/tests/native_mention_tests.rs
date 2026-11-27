use super::super::profile_subscriptions::tests::{fixture, response};
use super::*;
use crate::ServerSessionState;
use std::time::Duration;
use tokio::{
    io::AsyncReadExt,
    net::{TcpListener, TcpStream},
    sync::mpsc,
};

struct Capture(mpsc::UnboundedSender<(i64, Value)>);
impl Sink for Capture {
    fn results(&self, _: i64, request: i64, metadata: String, _: Vec<Vec<u8>>) {
        let _ = self
            .0
            .send((request, serde_json::from_str(&metadata).unwrap()));
    }
}
fn seed(intent: &FeedIntent) {
    intent.work.with_database(|conn| {
        conn.execute_batch("INSERT INTO threads(
          user_id,thread_id,kind,authority_namespace_id,self_mention_namespace_id,subject_account,thread_feed_id,
          conversation_state,blocked,thread_profile_rev,
          join_request_end_feed_id,join_request_read_feed_id,group_invite_end_feed_id,
          server_last_read_seq,announcement_read_feed_id,server_unread_count,local_read_seq,role,deleted_hwm)
          VALUES(42,9,'GROUP',7,0,'!team',1,'ACTIVE',0,0,0,0,0,0,0,0,0,'OWNER',0);
          INSERT INTO profiles(user_id,publisher_namespace_id,profile_namespace_id,
            account,profile_rev,name,bio)
          VALUES(42,7,12,'bob',1,'Bob cached','');").map_err(|e| e.to_string())?;
        let roster_tables: i64 = conn.query_row("SELECT count(*) FROM sqlite_master WHERE name='members'", [], |row| row.get(0)).unwrap();
        assert_eq!(roster_tables, 0);
        Ok(())
    }).unwrap();
}
async fn setup() -> (
    TcpListener,
    FeedIntent,
    Arc<Owner>,
    mpsc::UnboundedReceiver<(i64, Value)>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = ServerSessionState::new();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    *proxy.api_origin.lock().unwrap() = origin.clone();
    *proxy.api_origin_primary.lock().unwrap() = origin;
    let intent = fixture(&proxy);
    seed(&intent);
    let (sender, received) = mpsc::unbounded_channel();
    (
        listener,
        intent,
        Owner::new(Arc::new(Capture(sender))),
        received,
    )
}
async fn request(socket: &mut TcpStream) -> (String, Value) {
    let mut bytes = Vec::new();
    loop {
        let mut chunk = [0; 4096];
        let read = socket.read(&mut chunk).await.unwrap();
        assert!(read > 0);
        bytes.extend_from_slice(&chunk[..read]);
        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&bytes[..end]).to_string();
            let length: usize = headers
                .to_lowercase()
                .lines()
                .find_map(|line| {
                    line.strip_prefix("content-length:")
                        .map(|value| value.trim().parse().unwrap())
                })
                .unwrap_or(0);
            if bytes.len() >= end + 4 + length {
                return (
                    headers,
                    serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap(),
                );
            }
        }
    }
}
fn member(account: &str, rev: i64) -> Value {
    json!({"account":account,"publisherNamespaceId":7,"profileNamespaceId":12,"profileRev":rev,"role":"MEMBER"})
}
async fn page(received: &mut mpsc::UnboundedReceiver<(i64, Value)>) -> (i64, Value) {
    tokio::time::timeout(Duration::from_secs(3), received.recv())
        .await
        .unwrap()
        .unwrap()
}
fn close(intent: &FeedIntent, owner: &Owner) {
    owner.cancel();
    intent.work.owner().end().unwrap();
    intent.work.owner().close().unwrap();
}

#[tokio::test]
async fn server_page_is_bounded_excludes_self_and_profiles_resolve_independently() {
    let (listener, intent, owner, mut received) = setup().await;
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let (headers, body) = request(&mut socket).await;
        assert!(headers.starts_with("POST /api/v1/group/members "));
        assert!(headers
            .to_lowercase()
            .contains("authorization: bearer profile-token"));
        assert_eq!(body, json!({"threadId":9,"take":4,"excludeSelf":true}));
        response(&mut socket, json!({"items":[member("alice",3),member("bob",1),member("carol",0),member("dave",0)],"nextCursor":"more-server-members"})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let (headers, body) = request(&mut socket).await;
        assert!(headers.starts_with("POST /api/v1/user/profile-resolution "));
        assert_eq!(
            body,
            json!({"publisherNamespaceId":7,"lookup":"ACCOUNT_PROFILE",
            "target":{"profileNamespaceId":12,"account":"alice","rev":3}})
        );
        response(&mut socket, json!({"status":"PENDING","key":{"publisherNamespaceId":7,"profileNamespaceId":12,"account":"alice","rev":3}})).await;
        // nextCursor must not cause a second roster request or drain the group.
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
    owner
        .start(intent.clone(), 9, 1, 1, "  ".into(), "Everyone".into())
        .unwrap();
    let (_, initial) = page(&mut received).await;
    assert_eq!(initial["items"].as_array().unwrap().len(), 5);
    assert_eq!(initial["items"][0]["kind"], "all");
    assert_eq!(initial["items"][1]["id"], "12/alice");
    assert_eq!(initial["items"][2]["label"], "Bob cached");
    assert!(initial["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["id"] != "0/self"));
    let (_, cached) = page(&mut received).await;
    assert_eq!(cached["items"][2]["label"], "Bob cached");
    server.await.unwrap();
    intent
        .work
        .with_database(|conn| {
            for (rev, name) in [(4, "Wrong revision"), (3, "Alice pinned")] {
                contacts::write_profile(
                    conn,
                    42,
                    &json!({"publisherNamespaceId":7,"profileNamespaceId":12,
                "account":"alice","profileRev":rev,"name":name,"bio":"","avatarDigest":null}),
                )?;
            }
            Ok(())
        })
        .unwrap();
    profile_subscriptions::wake(
        42,
        "PROFILE_AVAILABLE",
        &json!({"publisherNamespaceId":7,"profileNamespaceId":12,"account":"alice","rev":3}),
    );
    let (_, pinned) = page(&mut received).await;
    assert_eq!(pinned["items"][1]["label"], "Alice pinned");
    close(&intent, &owner);
}

#[tokio::test]
async fn search_is_literal_trimmed_and_audience_permission_controls_the_budget() {
    let (listener, intent, owner, mut received) = setup().await;
    intent
        .work
        .with_database(|conn| {
            conn.execute("UPDATE threads SET role='MEMBER'", [])
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
        .unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let (_, body) = request(&mut socket).await;
        assert_eq!(
            body,
            json!({"threadId":9,"take":5,"excludeSelf":true,"search":"A%_lice"})
        );
        response(
            &mut socket,
            json!({"items":[member("server-match",0)],"nextCursor":null}),
        )
        .await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let (_, body) = request(&mut socket).await;
        assert_eq!(
            body,
            json!({"threadId":9,"take":4,"excludeSelf":true,"search":"EVER"})
        );
        response(&mut socket, json!({"items":[],"nextCursor":null})).await;
    });
    owner
        .start(
            intent.clone(),
            9,
            1,
            1,
            " A%_lice ".into(),
            "Everyone".into(),
        )
        .unwrap();
    let (_, first) = page(&mut received).await;
    assert_eq!(first["items"].as_array().unwrap().len(), 1);
    assert_eq!(first["items"][0]["id"], "12/server-match");
    intent
        .work
        .with_database(|conn| {
            conn.execute("UPDATE threads SET role='ADMIN'", [])
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
        .unwrap();
    owner
        .start(intent.clone(), 9, 1, 2, "EVER".into(), "Everyone".into())
        .unwrap();
    let (request, second) = page(&mut received).await;
    assert_eq!(request, 2);
    assert_eq!(second["items"].as_array().unwrap().len(), 1);
    assert_eq!(second["items"][0]["kind"], "all");
    server.await.unwrap();
    close(&intent, &owner);
}

#[tokio::test]
async fn empty_and_failed_queries_clear_suggestions_without_a_local_fallback() {
    use tokio::io::AsyncWriteExt;
    for (status, body) in [
        (200, json!({"code":0,"data":{"items":[],"nextCursor":null}})),
        (403, json!({"code":403,"message":"forbidden"})),
        (200, json!({"code":500,"message":"not ready"})),
        (
            200,
            json!({"code":0,"data":{"items":[{"account":"invalid"}]}}),
        ),
        (
            200,
            json!({"code":0,"data":{"items":vec![member("excess",0);6]}}),
        ),
    ] {
        let (listener, intent, owner, mut received) = setup().await;
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            request(&mut socket).await;
            let body = body.to_string();
            socket.write_all(format!("HTTP/1.1 {status} Result\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        });
        // Nonmatching audience label means even the successful empty page is empty.
        owner
            .start(intent.clone(), 9, 1, 1, "missing".into(), "Everyone".into())
            .unwrap();
        assert_eq!(page(&mut received).await.1["items"], json!([]));
        server.await.unwrap();
        close(&intent, &owner);
    }
}

#[tokio::test]
async fn replacing_a_query_cancels_the_stalled_socket_and_only_publishes_the_new_page() {
    let (listener, intent, owner, mut received) = setup().await;
    owner
        .start(intent.clone(), 9, 1, 1, "old".into(), "Everyone".into())
        .unwrap();
    let (mut old, _) = listener.accept().await.unwrap();
    request(&mut old).await;
    owner
        .start(intent.clone(), 9, 1, 2, "new".into(), "Everyone".into())
        .unwrap();
    let mut byte = [0];
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), old.read(&mut byte))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    let (mut new, _) = listener.accept().await.unwrap();
    assert_eq!(request(&mut new).await.1["search"], "new");
    response(
        &mut new,
        json!({"items":[member("new",0)],"nextCursor":null}),
    )
    .await;
    let (request, result) = page(&mut received).await;
    assert_eq!(request, 2);
    assert_eq!(result["items"][0]["id"], "12/new");
    assert!(received.try_recv().is_err());
    close(&intent, &owner);
}

#[tokio::test]
async fn ended_login_or_cache_repair_cancels_roster_io_and_cannot_publish_to_a_successor() {
    for repair in [false, true] {
        let (listener, intent, owner, mut received) = setup().await;
        owner
            .start(intent.clone(), 9, 1, 1, "old".into(), "Everyone".into())
            .unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        if repair {
            intent.work.owner().invalidate_database_work().unwrap();
        } else {
            intent.work.owner().end().unwrap();
        }
        let successor = fixture(&ServerSessionState::new());
        let mut byte = [0];
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), socket.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(100), received.recv())
                .await
                .is_err()
        );
        assert!(successor.work.assert_current().is_ok());
        successor.work.owner().end().unwrap();
        successor.work.owner().close().unwrap();
        close(&intent, &owner);
    }
}
