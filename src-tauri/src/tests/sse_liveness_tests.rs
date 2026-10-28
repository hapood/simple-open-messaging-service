use super::{parse_sse_frame, ReceiveDeadline, SSE_HEARTBEAT_EVENT, SSE_IDLE_TIMEOUT};
use futures_util::FutureExt;
use std::time::Duration;

#[tokio::test(start_paused = true)]
async fn silent_stream_expires_at_thirty_seconds() {
    let mut idle = ReceiveDeadline::new();
    tokio::time::advance(SSE_IDLE_TIMEOUT - Duration::from_millis(1)).await;
    assert!(idle.expired().now_or_never().is_none());
    tokio::time::advance(Duration::from_millis(1)).await;
    assert!(idle.expired().now_or_never().is_some());
}

#[tokio::test(start_paused = true)]
async fn bytes_renew_the_deadline_but_empty_chunks_and_control_wakes_do_not() {
    let mut idle = ReceiveDeadline::new();
    for _ in 0..6 {
        tokio::time::advance(Duration::from_secs(10)).await;
        assert!(idle.expired().now_or_never().is_none());
        idle.received(1);
    }
    for _ in 0..29 {
        tokio::time::advance(Duration::from_secs(1)).await;
        // Cancelling the select branch on a control wake must not restart its timer.
        assert!(idle.expired().now_or_never().is_none());
        idle.received(0);
    }
    tokio::time::advance(Duration::from_secs(1)).await;
    assert!(idle.expired().now_or_never().is_some());
}

#[tokio::test(start_paused = true)]
async fn replacement_attempt_has_its_own_deadline() {
    let old = ReceiveDeadline::new();
    tokio::time::advance(Duration::from_secs(20)).await;
    drop(old);
    let mut next = ReceiveDeadline::new();
    tokio::time::advance(Duration::from_secs(10)).await;
    assert!(next.expired().now_or_never().is_none());
    tokio::time::advance(Duration::from_secs(20)).await;
    assert!(next.expired().now_or_never().is_some());
}

#[test]
fn heartbeat_is_not_a_domain_event() {
    let frame = format!("event: {SSE_HEARTBEAT_EVENT}\ndata: {{}}\n");
    assert!(parse_sse_frame(frame.as_bytes()).is_none());
    assert!(parse_sse_frame(b"event: HELLO\ndata: {}").is_some());
}
