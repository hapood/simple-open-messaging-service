use super::*;

#[test]
fn parse_basic_event_and_json_data() {
    let f = parse_sse_frame(b"event: EXAMPLE_EVENT\nid: 0\ndata: {\"id\":5}").unwrap();
    assert_eq!(f.event, "EXAMPLE_EVENT");
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
    // A comment-only frame has no `event:` → dropped (next test). But a comment
    // INSIDE a real frame is ignored without breaking the parse.
    let f = parse_sse_frame(b": keepalive\nevent: x\ndata: 1").unwrap();
    assert_eq!(f.event, "x");
    assert_eq!(f.data, serde_json::json!(1));
}

#[test]
fn parse_frame_with_no_event_is_dropped() {
    // A comment and a bare `data:` frame have no event → None.
    assert!(parse_sse_frame(b": ignored").is_none());
    assert!(parse_sse_frame(b"data: hello").is_none());
}

#[test]
fn parse_empty_data_is_null_not_dropped() {
    // An event with empty data remains visible, with a null payload.
    let f = parse_sse_frame(b"event: HELLO\ndata:").unwrap();
    assert_eq!(f.event, "HELLO");
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
