use super::*;

#[test]
fn runtime_clone_reads_the_single_login_owner() {
    let _lock = crate::native_db::FILESYSTEM_TEST_LOCK.lock().unwrap();
    let background = ServerSessionState::new();
    let shell = background.clone();
    assert!(Arc::ptr_eq(&background.api_http, &shell.api_http));
    assert!(Arc::ptr_eq(&background.select_lock, &shell.select_lock));
    assert!(Arc::ptr_eq(&background.config_path, &shell.config_path));
    assert!(shell.session_token().is_none());
    let id = crate::login_session_store::LoginSessionId::try_from(uuid::Uuid::new_v4().to_string())
        .unwrap();
    let owner = crate::native_db::install_test_login_connection(
        id,
        rusqlite::Connection::open_in_memory().unwrap(),
    )
    .unwrap();
    assert!(shell.session_token().is_none());
    owner
        .begin_activation()
        .unwrap()
        .commit("original-token".into())
        .unwrap();
    assert_eq!(
        background.session_token().as_deref(),
        Some("original-token")
    );
    assert_eq!(shell.session_token().as_deref(), Some("original-token"));
    owner.end().unwrap();
    assert!(shell.session_token().is_none());
    crate::native_db::release_login_connection(&owner).unwrap();
}

#[test]
fn attaching_shell_preserves_background_selected_origin() {
    let background = ServerSessionState::new();
    activate_origin(
        &background,
        "https://secondary.example",
        OriginMode::Secondary,
    );
    let shell = background.clone();
    assert_eq!(
        *shell.api_origin.lock().unwrap(),
        "https://secondary.example"
    );
    assert_eq!(*shell.origin_mode.lock().unwrap(), OriginMode::Secondary);
}

#[test]
fn tls_posture_https_dns_host_is_strict() {
    assert_eq!(tls_posture_for("https://example.com"), TlsPosture::Strict);
    assert_eq!(
        tls_posture_for("https://soms.example.com:8443/api"),
        TlsPosture::Strict
    );
}

#[test]
fn tls_posture_http_scheme_is_permissive_regardless_of_host() {
    assert_eq!(
        tls_posture_for("http://example.com"),
        TlsPosture::Permissive
    );
    assert_eq!(
        tls_posture_for("http://10.0.0.5:3000"),
        TlsPosture::Permissive
    );
}

#[test]
fn tls_posture_ip_host_is_permissive_even_over_https() {
    assert_eq!(tls_posture_for("https://10.0.0.5"), TlsPosture::Permissive);
    assert_eq!(
        tls_posture_for("https://10.0.0.8:8443"),
        TlsPosture::Permissive
    );
    assert_eq!(
        tls_posture_for("https://[::1]:3000"),
        TlsPosture::Permissive
    );
}

#[test]
fn tls_posture_unparseable_origin_is_permissive() {
    assert_eq!(tls_posture_for("not a url"), TlsPosture::Permissive);
    assert_eq!(tls_posture_for(""), TlsPosture::Permissive);
}

#[test]
fn validate_origin_accepts_http_https_and_strips_trailing_slash() {
    assert_eq!(
        validate_origin("https://example.com/"),
        Some("https://example.com".to_string())
    );
    assert_eq!(
        validate_origin("http://10.0.0.5:3000"),
        Some("http://10.0.0.5:3000".to_string())
    );
    assert_eq!(
        validate_origin("  https://example.com  "),
        Some("https://example.com".to_string())
    );
}

#[test]
fn validate_origin_rejects_non_http_schemes_and_schemeless_garbage() {
    for value in [
        "ftp://example.com",
        "file:///etc/passwd",
        "example.com",
        "garbage",
        "",
    ] {
        assert_eq!(validate_origin(value), None);
    }
}

#[test]
fn origin_host_is_ip_detects_v4_v6_and_rejects_dns() {
    assert!(origin_host_is_ip("http://10.0.0.10"));
    assert!(origin_host_is_ip("https://10.0.0.5:3000"));
    assert!(origin_host_is_ip("https://[::1]:8443"));
    assert!(!origin_host_is_ip("https://example.com"));
    assert!(!origin_host_is_ip("garbage"));
}
