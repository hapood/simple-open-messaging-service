use super::*;

#[test]
fn line_end_at_handles_all_forms() {
    assert_eq!(line_end_at(b"a\nb", 1), (true, 1)); // \n
    assert_eq!(line_end_at(b"a\rb", 1), (true, 1)); // \r alone
    assert_eq!(line_end_at(b"a\r\nb", 1), (true, 2)); // \r\n (one logical end, len 2)
    assert_eq!(line_end_at(b"ab", 0), (false, 1)); // ordinary byte
    assert_eq!(line_end_at(b"a", 9), (false, 1)); // past end is safe (no panic)
}

#[test]
fn take_frame_lf_boundary_consumes_through_it() {
    let mut buf = b"event: ping\ndata: {}\n\nrest".to_vec();
    let frame = take_sse_frame(&mut buf).expect("complete frame");
    assert_eq!(frame, b"event: ping\ndata: {}"); // content, boundary NOT included
    assert_eq!(buf, b"rest"); // boundary consumed, remainder stays
}

#[test]
fn take_frame_crlf_boundary() {
    let mut buf = b"event: x\r\ndata: 1\r\n\r\nz".to_vec();
    let frame = take_sse_frame(&mut buf).expect("complete frame");
    assert_eq!(frame, b"event: x\r\ndata: 1");
    assert_eq!(buf, b"z");
}

#[test]
fn take_frame_returns_none_and_leaves_buf_when_incomplete() {
    let mut buf = b"event: ping\ndata: {}".to_vec(); // no blank-line terminator yet
    assert!(take_sse_frame(&mut buf).is_none());
    assert_eq!(
        buf, b"event: ping\ndata: {}",
        "incomplete buffer must be untouched"
    ); // chunk-split safe
}

#[test]
fn take_frame_drains_multiple_frames_in_order() {
    let mut buf = b":comment\n\nevent:b\ndata:c\n\n".to_vec();
    let f1 = take_sse_frame(&mut buf).unwrap();
    let f2 = take_sse_frame(&mut buf).unwrap();
    assert!(take_sse_frame(&mut buf).is_none());
    assert_eq!(f1, b":comment");
    assert_eq!(f2, b"event:b\ndata:c");
}

#[test]
fn parse_basic_event_and_json_data() {
    let f = parse_sse_frame(b"event: NEW_MESSAGE\ndata: {\"id\":5}").unwrap();
    assert_eq!(f.event, "NEW_MESSAGE");
    assert_eq!(f.data, serde_json::json!({"id": 5}));
}

#[test]
fn parse_multi_data_lines_join_with_newline_before_json() {
    // A frame split across two `data:` lines must join with `\n` then parse — the value can wrap.
    let f = parse_sse_frame(b"event: x\ndata: {\"a\":\ndata: 1}").unwrap();
    assert_eq!(f.data, serde_json::json!({"a": 1}));
}

#[test]
fn parse_strips_exactly_one_leading_space_after_colon() {
    // `event: x` (one space) → "x". `data: {}` (one space) → "{}".
    let f = parse_sse_frame(b"event: x\ndata: {}").unwrap();
    assert_eq!(f.event, "x");
    assert_eq!(f.data, serde_json::json!({}));
}

#[test]
fn parse_comment_line_is_ignored_but_event_still_parsed() {
    // The leading `: connected` heartbeat frame has no `event:` → dropped (next test). But a comment
    // INSIDE a real frame is ignored without breaking the parse.
    let f = parse_sse_frame(b": keepalive\nevent: x\ndata: 1").unwrap();
    assert_eq!(f.event, "x");
    assert_eq!(f.data, serde_json::json!(1));
}

#[test]
fn parse_frame_with_no_event_is_dropped() {
    // The connect heartbeat (`: connected`) and a bare `data:` frame have no event → None.
    assert!(parse_sse_frame(b": connected").is_none());
    assert!(parse_sse_frame(b"data: hello").is_none());
}

#[test]
fn parse_empty_data_is_null_not_dropped() {
    // `event: ping\ndata:` → event kept, data Null. Critical: a ping must NOT be dropped (it arms the
    // watchdog), so empty data must yield Null, not None.
    let f = parse_sse_frame(b"event: ping\ndata:").unwrap();
    assert_eq!(f.event, "ping");
    assert!(f.data.is_null());
}

#[test]
fn parse_malformed_json_data_drops_the_frame_keeps_stream_alive() {
    // A bad payload returns None (drop the frame) — NOT a throw that kills the stream (the JS worker's
    // JSON.parse fragility we deliberately did not port).
    assert!(parse_sse_frame(b"event: x\ndata: {not json").is_none());
}

#[test]
fn parse_force_logout_carries_message_for_extraction() {
    // parse_sse_frame returns the structure; open_one_stream extracts data.message into the reason.
    let f = parse_sse_frame(b"event: FORCE_LOGOUT\ndata: {\"message\":\"device_revoke\"}").unwrap();
    assert_eq!(f.event, "FORCE_LOGOUT");
    let reason = f.data.get("message").and_then(|v| v.as_str());
    assert_eq!(reason, Some("device_revoke"));
}
