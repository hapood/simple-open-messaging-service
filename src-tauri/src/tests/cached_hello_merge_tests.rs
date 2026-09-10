use super::merge_cached_hello;

#[test]
fn thread_feed_wakes_wait_for_identity_and_keep_the_highest_target() {
    let mut head = super::ThreadFeedHead::default();
    assert_eq!(
        head.accept(
            "THREAD_FEED_UPDATED",
            &serde_json::json!({"threadFeedEndId": 8})
        ),
        None
    );
    assert_eq!(
        head.accept(
            "HELLO",
            &serde_json::json!({"userId": 1, "threadFeedEndId": 3})
        ),
        Some((1, 8))
    );
    assert_eq!(
        head.accept(
            "THREAD_FEED_UPDATED",
            &serde_json::json!({"threadFeedEndId": 5})
        ),
        Some((1, 8))
    );
    assert_eq!(
        head.accept(
            "THREAD_FEED_UPDATED",
            &serde_json::json!({"threadFeedEndId": -1})
        ),
        None
    );
    assert_eq!(
        head.accept("STATE_FEED_UPDATED", &serde_json::json!({"feedId": 20})),
        None
    );
}

#[tokio::test]
async fn thread_feed_pending_wakes_coalesce_without_an_automatic_retry() {
    let (sender, mut receiver) = tokio::sync::watch::channel(None);
    sender.send_replace(Some((1, 2)));
    receiver.changed().await.unwrap();
    assert_eq!(*receiver.borrow_and_update(), Some((1, 2)));
    sender.send_replace(Some((1, 3)));
    sender.send_replace(Some((1, 4)));
    receiver.changed().await.unwrap();
    assert_eq!(*receiver.borrow_and_update(), Some((1, 4)));
    assert!(!receiver.has_changed().unwrap());
    // A subsequent event with the same target is still a new retry opportunity.
    sender.send_replace(Some((1, 4)));
    assert!(receiver.has_changed().unwrap());
}
use std::sync::{Arc, Mutex};

fn cache() -> Arc<Mutex<Option<serde_json::Value>>> {
    Arc::new(Mutex::new(None))
}

fn get(c: &Arc<Mutex<Option<serde_json::Value>>>) -> serde_json::Value {
    c.lock().unwrap().clone().unwrap()
}

#[test]
fn hello_seeds_then_incremental_frames_patch_their_fields() {
    let c = cache();
    merge_cached_hello(
        &c,
        "HELLO",
        &serde_json::json!({"userId":1,"stateFeedEndId":5,"profileRev":2}),
    );
    assert_eq!(get(&c)["userId"], 1);
    assert_eq!(get(&c)["stateFeedEndId"], 5);

    merge_cached_hello(&c, "STATE_FEED_UPDATED", &serde_json::json!({"feedId":6}));
    assert_eq!(get(&c)["stateFeedEndId"], 6);

    merge_cached_hello(
        &c,
        "UNRELATED_EVENT",
        &serde_json::json!({"threadId":7,"seq":9,"ts":123}),
    );
    assert!(get(&c).get("latestMessage").is_none());
}

#[test]
fn state_feed_id_is_monotonic_out_of_order_dropped() {
    let c = cache();
    merge_cached_hello(
        &c,
        "HELLO",
        &serde_json::json!({"userId":1,"stateFeedEndId":5}),
    );
    merge_cached_hello(&c, "STATE_FEED_UPDATED", &serde_json::json!({"feedId":9}));
    merge_cached_hello(&c, "STATE_FEED_UPDATED", &serde_json::json!({"feedId":8}));
    assert_eq!(get(&c)["stateFeedEndId"], 9);
}

#[test]
fn incremental_before_hello_is_dropped_no_partial_cache() {
    let c = cache();
    merge_cached_hello(&c, "STATE_FEED_UPDATED", &serde_json::json!({"feedId":6}));
    assert!(c.lock().unwrap().is_none());
}

#[test]
fn thread_feed_cursor_advances_independently_and_survives_older_wakes() {
    let c = cache();
    merge_cached_hello(
        &c,
        "THREAD_FEED_UPDATED",
        &serde_json::json!({"threadFeedEndId":9}),
    );
    assert!(c.lock().unwrap().is_none());
    merge_cached_hello(
        &c,
        "HELLO",
        &serde_json::json!({"userId":1,"stateFeedEndId":5,"threadFeedEndId":2}),
    );
    for head in [9, 8] {
        merge_cached_hello(
            &c,
            "THREAD_FEED_UPDATED",
            &serde_json::json!({"threadFeedEndId":head}),
        );
    }
    assert_eq!(get(&c)["threadFeedEndId"], 9);
    assert_eq!(get(&c)["stateFeedEndId"], 5);
}
