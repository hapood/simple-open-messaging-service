use super::{playback_range, valid_source_path};

#[test]
fn playback_ranges_are_bounded_before_materializing_video_bytes() {
    assert_eq!(playback_range("bytes=0-"), "bytes=0-1048575");
    assert_eq!(playback_range("bytes=1048576-"), "bytes=1048576-2097151");
    assert_eq!(playback_range("bytes=0-253769002"), "bytes=0-1048575");
    assert_eq!(playback_range("bytes=10-20"), "bytes=10-20");
    assert_eq!(playback_range("bytes=-1024"), "bytes=-1024");
    assert_eq!(playback_range("bytes=20-10"), "bytes=20-10");
    assert_eq!(playback_range("bytes=0-10,20-30"), "bytes=0-10,20-30");
}

#[test]
fn native_video_source_is_confined_to_canonical_upload_paths() {
    let digest = format!("abcd{}", "ef".repeat(30));
    assert!(valid_source_path(&format!(
        "/uploads/msg-assets/ab/cd/{digest}"
    )));
    assert!(valid_source_path(&format!(
        "/uploads/msg-assets/ab/cd/{digest}?threadId=1&seq=6"
    )));
    assert!(!valid_source_path(&format!(
        "/uploads/msg-assets/ab/cd/{digest}?threadId=1&seq=6&token=leak"
    )));
    assert!(!valid_source_path(&format!(
        "/uploads/msg-assets/aa/cd/{digest}"
    )));
    assert!(!valid_source_path("https://example.com/video.mp4"));
    assert!(!valid_source_path("/uploads/../private/key"));
    assert!(!valid_source_path("/uploads/video.mp4?token=leak"));
    assert!(!valid_source_path("/uploads\\video.mp4"));
}
