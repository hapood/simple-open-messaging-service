use super::super::profile_subscriptions::tests::fixture;
use super::*;
use crate::ServerSessionState;
use std::time::Duration;
use tokio::sync::mpsc;

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
          conversation_state,blocked,thread_profile_rev,message_end_seq,tombstone_end_seq,
          join_request_end_feed_id,join_request_read_feed_id,group_invite_end_feed_id,
          server_last_read_seq,announcement_read_feed_id,server_unread_count,local_read_seq,role)
          VALUES(42,9,'GROUP',7,0,'!team',1,'ACTIVE',0,0,0,0,0,0,0,0,0,0,0,'OWNER');
          INSERT INTO account_state(user_id,self_profile_json) VALUES(42,'{\"account\":\"self\"}');
          INSERT INTO members(user_id,thread_id,member_account,namespace_id,role,profile_rev)
          VALUES(42,9,'self',0,'OWNER',1),(42,9,'alice',12,'MEMBER',3),
                (42,9,'bob',12,'MEMBER',1),(42,9,'carol',12,'MEMBER',0),
                (42,9,'dave',12,'MEMBER',0),(42,9,'eric',12,'MEMBER',0);
          INSERT INTO profiles(user_id,publisher_namespace_id,profile_namespace_id,
            account,profile_rev,name,bio)
          VALUES(42,7,12,'bob',1,'Bob cached','');").map_err(|e| e.to_string())
    }).unwrap();
}

#[tokio::test]
async fn initial_page_is_local_bounded_and_cached_item_does_not_wait_for_another_demand() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = ServerSessionState::new();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    *proxy.api_origin.lock().unwrap() = origin.clone();
    *proxy.api_origin_primary.lock().unwrap() = origin;
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        super::super::profile_subscriptions::tests::request(&mut socket).await;
        super::super::profile_subscriptions::tests::response(
            &mut socket,
            json!({
                "status":"PENDING", "key":{"publisherNamespaceId":7,
                    "profileNamespaceId":12,"account":"alice","rev":3}
            }),
        )
        .await;
    });
    let intent = fixture(&proxy);
    seed(&intent);
    let (sender, mut received) = mpsc::unbounded_channel();
    let owner = Owner::new(Arc::new(Capture(sender)));
    owner
        .start(intent.clone(), 9, 1, 1, "".into(), "Everyone".into())
        .unwrap();
    let (_, initial) = tokio::time::timeout(Duration::from_secs(3), received.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(initial["items"].as_array().unwrap().len(), 5);
    assert_eq!(initial["items"][0]["kind"], "all");
    assert_eq!(initial["items"][1]["id"], "12/alice");
    assert_eq!(initial["items"][2]["label"], "Bob cached");
    assert!(initial["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["id"] != "0/self"));
    let (_, incremental) = tokio::time::timeout(Duration::from_secs(3), received.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(incremental["items"][2]["label"], "Bob cached");
    tokio::time::timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
    // A later roster selection must not retarget this page's pinned demand.
    intent
        .work
        .with_database(|conn| {
            conn.execute(
                "UPDATE members SET profile_rev=4 WHERE member_account='alice'",
                [],
            )
            .map_err(|e| e.to_string())?;
            contacts::write_profile(
                conn,
                42,
                &json!({
                    "publisherNamespaceId":7,"profileNamespaceId":12,"namespaceId":12,
                    "account":"alice","profileRev":3,"name":"Alice pinned",
                    "bio":"","avatarDigest":null
                }),
            )?;
            Ok(())
        })
        .unwrap();
    profile_subscriptions::wake(
        42,
        "PROFILE_AVAILABLE",
        &json!({
            "publisherNamespaceId":7,"profileNamespaceId":12,"account":"alice","rev":3
        }),
    );
    let (_, pinned) = tokio::time::timeout(Duration::from_secs(3), received.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pinned["items"][1]["label"], "Alice pinned");
    // A replacement selects its own page and removes the old consumers.
    owner
        .start(intent.clone(), 9, 1, 2, "car".into(), "Everyone".into())
        .unwrap();
    loop {
        let (request, page) = tokio::time::timeout(Duration::from_secs(3), received.recv())
            .await
            .unwrap()
            .unwrap();
        if request != 2 {
            continue;
        }
        assert_eq!(page["items"].as_array().unwrap().len(), 1);
        assert_eq!(page["items"][0]["id"], "12/carol");
        break;
    }
    owner.cancel();
    intent.work.owner().end().unwrap();
    intent.work.owner().close().unwrap();
}

#[tokio::test]
async fn audience_permission_search_and_five_member_budget_match_the_web_rules() {
    let intent = fixture(&ServerSessionState::new());
    seed(&intent);
    // Keep the test entirely local; these rows need no profile demand.
    intent
        .work
        .with_database(|conn| {
            conn.execute("UPDATE members SET profile_rev=0", [])
                .map_err(|e| e.to_string())?;
            conn.execute("UPDATE threads SET role='MEMBER'", [])
                .map_err(|e| e.to_string())?;
            Ok(())
        })
        .unwrap();
    let (sender, mut received) = mpsc::unbounded_channel();
    let owner = Owner::new(Arc::new(Capture(sender)));
    owner
        .start(intent.clone(), 9, 1, 1, "".into(), "Everyone".into())
        .unwrap();
    let (_, page) = tokio::time::timeout(Duration::from_secs(3), received.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(), 5);
    assert!(page["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["kind"] == "user"));
    intent
        .work
        .with_database(|conn| {
            conn.execute("UPDATE threads SET role='ADMIN'", [])
                .map_err(|e| e.to_string())?;
            Ok(())
        })
        .unwrap();
    owner
        .start(intent.clone(), 9, 1, 2, "EVER".into(), "Everyone".into())
        .unwrap();
    let (_, page) = tokio::time::timeout(Duration::from_secs(3), received.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["kind"], "all");
    owner.cancel();
    intent.work.owner().end().unwrap();
    intent.work.owner().close().unwrap();
}
