use super::{is_spa_route_key, read_active_web_state, ACTIVE_STATE_FILENAME};
use std::fs;

#[test]
fn angular_history_routes_use_the_active_entry_document() {
    assert!(is_spa_route_key(""));
    assert!(is_spa_route_key("/"));
    assert!(is_spa_route_key("/auth/login"));
    assert!(is_spa_route_key("settings/devices/"));
}

#[test]
fn static_asset_requests_do_not_fall_back_to_the_entry_document() {
    assert!(!is_spa_route_key("index.html"));
    assert!(!is_spa_route_key("/main-ABC123.js"));
    assert!(!is_spa_route_key("assets/icons/app.svg"));
}

#[test]
fn active_web_state_reads_version_and_hash_together() {
    let root = std::env::temp_dir().join(format!(
        "soms-active-web-state-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_nanos(),
    ));
    fs::create_dir_all(&root).expect("create temp web root");
    fs::write(
        root.join(ACTIVE_STATE_FILENAME),
        r#"{"version":"0.2.0","sha256":"ABCDEF"}"#,
    )
    .expect("write active state");

    let state = read_active_web_state(&root).expect("read active state");
    assert_eq!(state.version, "0.2.0");
    assert_eq!(state.sha256, "ABCDEF");

    fs::remove_dir_all(&root).expect("remove temp web root");
}

#[test]
fn active_web_state_rejects_partial_or_invalid_state() {
    let root = std::env::temp_dir().join(format!(
        "soms-invalid-active-web-state-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_nanos(),
    ));
    fs::create_dir_all(&root).expect("create temp web root");

    fs::write(root.join(ACTIVE_STATE_FILENAME), r#"{"version":"0.2.0"}"#)
        .expect("write partial active state");
    assert!(read_active_web_state(&root).is_none());

    fs::write(
        root.join(ACTIVE_STATE_FILENAME),
        r#"{"version":"","sha256":"abc"}"#,
    )
    .expect("write empty-version active state");
    assert!(read_active_web_state(&root).is_none());

    fs::remove_dir_all(&root).expect("remove temp web root");
}
