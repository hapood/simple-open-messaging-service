use super::merge_cached_hello;
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
        &serde_json::json!({"userId":1,"stateRevision":5,"profileRev":2,"latestMessage":null}),
    );
    assert_eq!(get(&c)["userId"], 1);
    assert_eq!(get(&c)["stateRevision"], 5);

    merge_cached_hello(
        &c,
        "STATE_REV_UPDATED",
        &serde_json::json!({"stateRevision":6}),
    );
    assert_eq!(get(&c)["stateRevision"], 6);

    merge_cached_hello(
        &c,
        "NEW_MESSAGE",
        &serde_json::json!({"threadId":7,"seq":9,"ts":123}),
    );
    assert_eq!(get(&c)["latestMessage"]["threadId"], 7);
    assert_eq!(get(&c)["latestMessage"]["seq"], 9);
}

#[test]
fn state_revision_is_monotonic_out_of_order_dropped() {
    let c = cache();
    merge_cached_hello(
        &c,
        "HELLO",
        &serde_json::json!({"userId":1,"stateRevision":5}),
    );
    merge_cached_hello(
        &c,
        "STATE_REV_UPDATED",
        &serde_json::json!({"stateRevision":9}),
    );
    merge_cached_hello(
        &c,
        "STATE_REV_UPDATED",
        &serde_json::json!({"stateRevision":8}),
    );
    assert_eq!(get(&c)["stateRevision"], 9);
}

#[test]
fn incremental_before_hello_is_dropped_no_partial_cache() {
    let c = cache();
    merge_cached_hello(
        &c,
        "STATE_REV_UPDATED",
        &serde_json::json!({"stateRevision":6}),
    );
    assert!(c.lock().unwrap().is_none());
}
