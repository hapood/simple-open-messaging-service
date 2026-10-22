use super::valid_source_path;

#[test]
fn native_video_source_is_confined_to_canonical_upload_paths() {
    let digest = format!("abcd{}", "ef".repeat(30));
    assert!(valid_source_path(&format!(
        "/uploads/shards/ab/cd/{digest}.mp4"
    )));
    assert!(!valid_source_path("https://example.com/video.mp4"));
    assert!(!valid_source_path("/uploads/../private/key"));
    assert!(!valid_source_path("/uploads/video.mp4?token=leak"));
    assert!(!valid_source_path("/uploads\\video.mp4"));
}
