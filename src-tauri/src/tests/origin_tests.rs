use super::*;

#[test]
fn admitted_token_updates_require_matching_owner_and_do_not_clear_successor() {
    let _lock = crate::native_db::FILESYSTEM_TEST_LOCK.lock().unwrap();
    let state = ServerSessionState::new();
    let id1 =
        crate::login_session_store::LoginSessionId::try_from(uuid::Uuid::new_v4().to_string())
            .unwrap();
    let id2 =
        crate::login_session_store::LoginSessionId::try_from(uuid::Uuid::new_v4().to_string())
            .unwrap();

    let owner1 = crate::native_db::install_test_login_connection(
        id1.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
    )
    .unwrap();
    owner1
        .begin_activation()
        .unwrap()
        .commit("token-1".into())
        .unwrap();

    // Setting token without setting state.login_session fails with superseded.
    assert_eq!(
        state
            .update_session_token_admitted(Some("token-1".into()), &id1.to_string())
            .unwrap_err(),
        "native login superseded"
    );

    // Set state.login_session to id1.
    *state.login_session.lock().unwrap() = Some(id1.clone());

    // Mismatched token fails.
    assert_eq!(
        state
            .update_session_token_admitted(Some("wrong-token".into()), &id1.to_string())
            .unwrap_err(),
        "credential mismatch"
    );

    // Matching token succeeds.
    state
        .update_session_token_admitted(Some("token-1".into()), &id1.to_string())
        .unwrap();
    assert_eq!(state.token.lock().unwrap().as_deref(), Some("token-1"));

    // Residual token clear while active session is present fails.
    assert_eq!(
        state.clear_residual_token().unwrap_err(),
        "cannot clear residual token while a login session is active"
    );

    // Transition to successor id2.
    owner1.end().unwrap();
    crate::native_db::release_login_connection(&owner1).unwrap();

    let owner2 = crate::native_db::install_test_login_connection(
        id2.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
    )
    .unwrap();
    owner2
        .begin_activation()
        .unwrap()
        .commit("token-2".into())
        .unwrap();
    *state.login_session.lock().unwrap() = Some(id2.clone());
    state
        .update_session_token_admitted(Some("token-2".into()), &id2.to_string())
        .unwrap();
    assert_eq!(state.token.lock().unwrap().as_deref(), Some("token-2"));

    // A delayed clear for old id1 arrives: it must NOT clear successor id2's token or session!
    state
        .update_session_token_admitted(None, &id1.to_string())
        .unwrap();
    assert_eq!(state.token.lock().unwrap().as_deref(), Some("token-2"));
    assert_eq!(state.login_session.lock().unwrap().as_ref(), Some(&id2));

    // A delayed set for old id1 arrives: it must fail and not overwrite id2!
    assert_eq!(
        state
            .update_session_token_admitted(Some("token-1".into()), &id1.to_string())
            .unwrap_err(),
        "native login superseded"
    );
    assert_eq!(state.token.lock().unwrap().as_deref(), Some("token-2"));

    // Clear matching id2 succeeds.
    state
        .update_session_token_admitted(None, &id2.to_string())
        .unwrap();
    assert!(state.token.lock().unwrap().is_none());
    assert!(state.login_session.lock().unwrap().is_none());

    // Residual token clear now succeeds when signed out.
    assert!(state.clear_residual_token().is_ok());

    owner2.end().unwrap();
    crate::native_db::release_login_connection(&owner2).unwrap();
}

#[test]
fn runtime_clone_shares_session_pool_and_shell_resources() {
    let background = ServerSessionState::new();
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
