use super::*;

/// A unique temp path per pid + counter so parallel test processes don't collide.
fn tmp_path(label: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!(
        "soms-trim-{}-{}-{}.log",
        std::process::id(),
        n,
        label
    ))
}

#[test]
fn trim_drops_oldest_lines_on_a_boundary_keeps_an_exact_tail() {
    // Five 11-byte lines ("0123456789\n"); keep ~2 lines worth so the front two+ are dropped.
    let content: Vec<u8> = b"0123456789\n".repeat(5); // 55 bytes
    let path = tmp_path("basic");
    fs::write(&path, &content).unwrap();
    trim_webview_console_front(&path, 22);
    let result = fs::read(&path).unwrap();
    assert!(result.len() < content.len(), "trim must drop bytes");
    assert!(
        result.starts_with(b"0123456789\n"),
        "the kept head must begin on a line boundary (a whole line), never mid-line"
    );
    assert!(
        content.ends_with(&result),
        "the kept bytes must be an exact tail of the original — no line mutated, none invented"
    );
    let _ = fs::remove_file(&path);
}

#[test]
fn trim_is_a_noop_when_already_at_or_under_cap() {
    let path = tmp_path("noop");
    fs::write(&path, b"short\n").unwrap();
    trim_webview_console_front(&path, 100);
    assert_eq!(fs::read(&path).unwrap(), b"short\n");
    let _ = fs::remove_file(&path);
}

#[test]
fn trim_a_missing_file_is_silent() {
    // A nonexistent path must never panic (best-effort contract — diagnostics must not break the app).
    trim_webview_console_front(&tmp_path("missing"), 10);
}
