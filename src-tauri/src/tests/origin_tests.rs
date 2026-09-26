use super::*;

#[test]
fn runtime_clone_shares_session_pool_and_shell_resources() {
    let background = ProxyState::new();
    background.replace_session_token(Some("test-session".into()));
    let shell = background.clone();
    assert!(Arc::ptr_eq(&background.api_http, &shell.api_http));
    assert!(Arc::ptr_eq(&background.select_lock, &shell.select_lock));
    assert!(Arc::ptr_eq(&background.config_path, &shell.config_path));
    assert_eq!(shell.token.lock().unwrap().as_deref(), Some("test-session"));
    shell.replace_session_token(None);
    assert!(background.token.lock().unwrap().is_none());
    background.replace_session_token(Some("replacement-session".into()));
    assert_eq!(
        shell.token.lock().unwrap().as_deref(),
        Some("replacement-session")
    );
}

#[test]
fn attaching_shell_preserves_background_selected_origin() {
    let background = ProxyState::new();
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
    // Cleartext http → never strict, even for a DNS host that would be strict over https.
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
    // LAN self-hosted over HTTPS+IP → permissive (no valid cert expected for a bare-IP host).
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
    // Defensive default (matches the historical unwrap_or(true)); validate_origin gates persistence
    // so a malformed origin never reaches here in practice.
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
    // Surrounding whitespace tolerated (real input from a settings field).
    assert_eq!(
        validate_origin("  https://example.com  "),
        Some("https://example.com".to_string())
    );
}

#[test]
fn validate_origin_rejects_non_http_schemes_and_schemeless_garbage() {
    assert_eq!(validate_origin("ftp://example.com"), None);
    assert_eq!(validate_origin("file:///etc/passwd"), None);
    assert_eq!(validate_origin("example.com"), None); // no scheme → relative URL, rejected
    assert_eq!(validate_origin("garbage"), None);
    assert_eq!(validate_origin(""), None);
}

#[test]
fn origin_host_is_ip_detects_v4_v6_and_rejects_dns() {
    assert!(origin_host_is_ip("http://10.0.0.10"));
    assert!(origin_host_is_ip("https://10.0.0.5:3000"));
    assert!(origin_host_is_ip("https://[::1]:8443"));
    assert!(!origin_host_is_ip("https://example.com"));
    assert!(!origin_host_is_ip("garbage"));
}
