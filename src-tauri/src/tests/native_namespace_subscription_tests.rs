use super::*;
use crate::native_db::profile_subscriptions::tests::{fixture, request, response};
use crate::ServerSessionState;
use rusqlite::{params, OptionalExtension};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
    sync::oneshot,
};

fn pair(publisher: i64) -> ProfileNamespacePair {
    ProfileNamespacePair {
        publisher_namespace_id: publisher,
        profile_namespace_id: 2,
    }
}

/// Bypass the commit guard: tests must be able to plant any coordinates,
/// including regressed ones the durable layer would refuse.
async fn force_row(
    intent: &FeedIntent,
    publisher: i64,
    domain: &str,
    change_seq: i64,
    update_feed_id: i64,
    expired: bool,
) {
    let domain = domain.to_owned();
    intent
        .db(move |conn| {
            conn.execute(
                "INSERT OR REPLACE INTO profile_namespaces(
                   user_id,publisher_namespace_id,profile_namespace_id,domain,root_public_key,
                   update_feed_id,change_seq,expired,status,refreshed_at
                 ) VALUES(42,?1,2,?2,'key',?3,?4,?5,'ACTIVE',0)",
                params![
                    publisher,
                    domain,
                    update_feed_id,
                    change_seq,
                    expired as i64
                ],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
        .unwrap();
}

async fn raw_response(socket: &mut TcpStream, body: String) {
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

async fn wait_ready(subscription: &mut WatchSubscription) -> ProfileNamespaceBinding {
    loop {
        if let NamespaceWatch::Ready { binding } = subscription.state() {
            return binding;
        }
        assert!(
            subscription.changed().await,
            "namespace flight ended before a ready state"
        );
    }
}

#[tokio::test]
async fn namespace_watch_emits_empty_then_ready_and_lru_short_circuits_rewatch() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = ServerSessionState::new();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    *proxy.api_origin.lock().unwrap() = origin.clone();
    *proxy.api_origin_primary.lock().unwrap() = origin;
    let intent = fixture(&proxy);
    let count = Arc::new(AtomicUsize::new(0));
    let calls = count.clone();
    let (release, gated) = oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        calls.fetch_add(1, Ordering::SeqCst);
        // Hold the answer so the pre-resolution Empty frame is observable.
        gated.await.unwrap();
        response(
            &mut socket,
            json!({"status":"READY","entry":{
                "publisherNamespaceId":7,"profileNamespaceId":2,"domain":"chat.test",
                "rootPublicKey":"key","updateFeedId":4,"expired":false,"status":"ACTIVE"}}),
        )
        .await;
    });
    let mut subscription = watch(intent.clone(), pair(7)).unwrap();
    assert!(matches!(subscription.state(), NamespaceWatch::Empty));
    release.send(()).unwrap();
    let binding = wait_ready(&mut subscription).await;
    assert_eq!(binding.domain.as_deref(), Some("chat.test"));
    assert_eq!((binding.change_seq, binding.update_feed_id), (0, 4));
    drop(subscription);
    // The settled binding is in the LRU: a re-watch answers synchronously
    // with Ready and starts no second resolve round.
    let mut rewatch = watch(intent.clone(), pair(7)).unwrap();
    assert!(matches!(rewatch.state(), NamespaceWatch::Ready { .. }));
    assert_eq!(count.load(Ordering::SeqCst), 1);
    drop(rewatch);
    server.await.unwrap();
    intent.work.owner().end().unwrap();
    intent.work.owner().close().unwrap();
}

#[tokio::test]
async fn namespace_watch_re_emits_guarded_updates_on_wake() {
    let intent = fixture(&ServerSessionState::new());
    force_row(&intent, 7, "before.test", 5, 7, false).await;
    let mut subscription = watch(intent.clone(), pair(7)).unwrap();
    let binding = wait_ready(&mut subscription).await;
    assert_eq!(binding.domain.as_deref(), Some("before.test"));

    // An advanced change coordinate lands.
    force_row(&intent, 7, "after.test", 6, 7, false).await;
    wake(42, &[pair(7)]);
    assert!(
        subscription.changed().await,
        "advanced binding must re-emit"
    );
    match subscription.state() {
        NamespaceWatch::Ready { binding } => {
            assert_eq!(binding.domain.as_deref(), Some("after.test"))
        }
        other => panic!("advanced binding must be Ready, got {other:?}"),
    }

    // A regressed coordinate drops: no emission within a quiet window.
    force_row(&intent, 7, "stale.test", 5, 9, false).await;
    wake(42, &[pair(7)]);
    assert!(
        tokio::time::timeout(Duration::from_millis(150), subscription.changed())
            .await
            .is_err(),
        "regressed binding must not re-emit"
    );

    // Equal coordinates allow a display-field refresh in place.
    force_row(&intent, 7, "equal.test", 6, 7, false).await;
    wake(42, &[pair(7)]);
    assert!(subscription.changed().await, "equal binding must re-emit");
    match subscription.state() {
        NamespaceWatch::Ready { binding } => {
            assert_eq!(binding.domain.as_deref(), Some("equal.test"))
        }
        other => panic!("equal binding must be Ready, got {other:?}"),
    }
    drop(subscription);
    intent.work.owner().end().unwrap();
    intent.work.owner().close().unwrap();
}

#[tokio::test]
async fn namespace_pending_round_resolves_after_a_wake() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = ServerSessionState::new();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    *proxy.api_origin.lock().unwrap() = origin.clone();
    *proxy.api_origin_primary.lock().unwrap() = origin;
    let intent = fixture(&proxy);
    let (released, received) = oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response(&mut socket, json!({"status":"PENDING"})).await;
        drop(socket);
        released.send(()).unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response(
            &mut socket,
            json!({"status":"READY","entry":{
                "publisherNamespaceId":8,"profileNamespaceId":2,"domain":"woken.test",
                "rootPublicKey":"key","updateFeedId":9,"expired":false,"status":"ACTIVE"}}),
        )
        .await;
    });
    let mut subscription = watch(intent.clone(), pair(8)).unwrap();
    tokio::time::timeout(Duration::from_secs(3), received)
        .await
        .unwrap()
        .unwrap();
    // The PENDING round waits for a wake; a lost wake would only expire after
    // the TTL, so this also proves the wake path retries the resolve round.
    wake(42, &[pair(8)]);
    let binding = wait_ready(&mut subscription).await;
    assert_eq!(binding.domain.as_deref(), Some("woken.test"));
    drop(subscription);
    server.await.unwrap();
    intent.work.owner().end().unwrap();
    intent.work.owner().close().unwrap();
}

#[tokio::test]
async fn namespace_unrecoverable_answer_writes_a_tomb_and_ends_terminal() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = ServerSessionState::new();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    *proxy.api_origin.lock().unwrap() = origin.clone();
    *proxy.api_origin_primary.lock().unwrap() = origin;
    let intent = fixture(&proxy);
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        raw_response(&mut socket, r#"{"code":50032}"#.to_owned()).await;
    });
    let mut subscription = watch(intent.clone(), pair(9)).unwrap();
    loop {
        assert!(subscription.changed().await, "flight ended unexpectedly");
        if let NamespaceWatch::Unrecoverable = subscription.state() {
            break;
        }
    }
    let tomb: Option<i64> = intent
        .db(|conn| {
            conn.query_row(
                "SELECT created_at FROM profile_namespace_tombs
                 WHERE user_id=42 AND publisher_namespace_id=9 AND profile_namespace_id=2",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())
        })
        .await
        .unwrap();
    assert!(tomb.is_some(), "unrecoverable answer must persist a tomb");
    drop(subscription);
    server.await.unwrap();
    intent.work.owner().end().unwrap();
    intent.work.owner().close().unwrap();
}

#[tokio::test]
async fn namespace_last_consumer_release_detaches_the_flight() {
    let intent = fixture(&ServerSessionState::new());
    let first = watch(intent.clone(), pair(10)).unwrap();
    let second = watch(intent.clone(), pair(10)).unwrap();
    assert!(Arc::ptr_eq(&first._flight, &second._flight));
    let key = first.key.clone();
    drop(first);
    drop(second);
    assert!(
        !FLIGHTS.get().unwrap().lock().unwrap().contains_key(&key),
        "last consumer release must deregister the flight"
    );
    intent.work.owner().end().unwrap();
    intent.work.owner().close().unwrap();
}
