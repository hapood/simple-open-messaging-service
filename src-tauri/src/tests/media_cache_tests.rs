#[cfg(desktop)]
use super::sanitize_filename;
use super::{
    cache_key, expected_digest, intersecting_missing_ranges, merge_range, missing_ranges,
    remove_range, requested_range, valid_download_task_id, validate_path, CacheMeta, CachedRange,
};

#[test]
fn media_path_gate_rejects_traversal_and_non_upload_routes() {
    assert!(validate_path("/uploads/photo.jpg").is_ok());
    assert!(validate_path("/api/v1/users").is_err());
    assert!(validate_path("/uploads/../secret").is_err());
    assert!(validate_path("/uploads\\secret").is_err());
}

#[test]
fn native_download_task_ids_are_bounded_and_event_safe() {
    assert!(valid_download_task_id("media-0123_ab"));
    assert!(!valid_download_task_id(""));
    assert!(!valid_download_task_id("space is not allowed"));
    assert!(!valid_download_task_id(&"x".repeat(129)));
}

#[test]
fn cache_namespace_changes_with_origin_and_session() {
    let base = cache_key("https://one.example", Some("token-a"), "/uploads/a.jpg");
    assert_ne!(
        base,
        cache_key("https://two.example", Some("token-a"), "/uploads/a.jpg")
    );
    assert_ne!(
        base,
        cache_key("https://one.example", Some("token-b"), "/uploads/a.jpg")
    );
}

#[test]
fn sparse_ranges_merge_and_report_only_the_holes() {
    let mut ranges = vec![
        CachedRange { start: 0, end: 20 },
        CachedRange { start: 40, end: 45 },
    ];
    merge_range(&mut ranges, CachedRange { start: 18, end: 30 });
    let meta = CacheMeta {
        content_type: Some("video/mp4".into()),
        size: 50,
        complete: false,
        ranges,
        validator: Some("\"v1\"".into()),
        blocks: Vec::new(),
    };
    assert_eq!(
        missing_ranges(&meta),
        vec![
            CachedRange { start: 30, end: 40 },
            CachedRange { start: 45, end: 50 },
        ]
    );
}

#[test]
fn parses_open_and_suffix_http_ranges() {
    assert_eq!(
        requested_range("bytes=20-", 100),
        Some(CachedRange {
            start: 20,
            end: 100
        })
    );
    assert_eq!(
        requested_range("bytes=-10", 100),
        Some(CachedRange {
            start: 90,
            end: 100
        })
    );
}

#[test]
fn overlapping_player_request_fetches_only_its_holes() {
    let meta = CacheMeta {
        content_type: Some("video/mp4".into()),
        size: 100,
        complete: false,
        ranges: vec![
            CachedRange { start: 0, end: 20 },
            CachedRange { start: 30, end: 40 },
        ],
        validator: Some("\"v1\"".into()),
        blocks: Vec::new(),
    };
    assert_eq!(
        intersecting_missing_ranges(&meta, CachedRange { start: 10, end: 35 }),
        vec![CachedRange { start: 20, end: 30 }]
    );
}

#[test]
fn corrupt_block_is_removed_without_discarding_good_coverage() {
    let mut ranges = vec![CachedRange { start: 0, end: 100 }];
    remove_range(&mut ranges, CachedRange { start: 20, end: 30 });
    assert_eq!(
        ranges,
        vec![
            CachedRange { start: 0, end: 20 },
            CachedRange {
                start: 30,
                end: 100
            },
        ]
    );
}

#[test]
fn extracts_authoritative_digest_only_from_cas_filename() {
    let digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    let path = format!("/uploads/shards/01/23/{digest}.mp4?download=1");
    assert_eq!(expected_digest(&path), Some(digest));
    assert_eq!(expected_digest("/uploads/avatars/user.webp"), None);
}

#[tokio::test]
async fn sparse_range_writes_preserve_other_segments() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("sparse.bin");
    // Start with a missing file, then fill disjoint ranges in reverse order.
    super::write_file_range(&path, CachedRange { start: 8, end: 12 }, 12, b"tail")
        .await
        .unwrap();
    super::write_file_range(&path, CachedRange { start: 0, end: 4 }, 12, b"head")
        .await
        .unwrap();
    assert_eq!(tokio::fs::read(&path).await.unwrap(), b"head\0\0\0\0tail");
}

#[tokio::test]
async fn streamed_range_writes_preserve_other_segments() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("sparse.bin");
    tokio::fs::write(&path, b"head----tail").await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut headers = Vec::new();
        while !headers.ends_with(b"\r\n\r\n") {
            headers.push(socket.read_u8().await.unwrap());
        }
        socket
            .write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 4\r\nContent-Range: bytes 4-7/12\r\nConnection: close\r\n\r\nbody")
            .await
            .unwrap();
    });
    let response = reqwest::Client::new().get(origin).send().await.unwrap();
    super::stream_response_range(
        response,
        &path,
        CachedRange { start: 4, end: 8 },
        12,
        None,
        8,
    )
    .await
    .unwrap();
    assert_eq!(tokio::fs::read(&path).await.unwrap(), b"headbodytail");
    server.await.unwrap();
}

#[cfg(desktop)]
#[test]
fn desktop_filename_is_confined_to_its_basename() {
    assert_eq!(sanitize_filename("../../photo.jpg"), "photo.jpg");
    assert_eq!(sanitize_filename(""), "download");
}
