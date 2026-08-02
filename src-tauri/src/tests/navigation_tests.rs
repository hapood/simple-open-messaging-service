use super::is_allowed;

#[test]
fn bundled_application_origins_are_allowed() {
    assert!(is_allowed(
        &reqwest::Url::parse("tauri://localhost/index.html").unwrap()
    ));
    assert!(is_allowed(
        &reqwest::Url::parse("http://tauri.localhost/settings").unwrap()
    ));
    assert!(is_allowed(&reqwest::Url::parse("about:blank").unwrap()));
}

#[test]
fn remote_documents_are_rejected() {
    assert!(!is_allowed(
        &reqwest::Url::parse("https://example.com/").unwrap()
    ));
    assert!(!is_allowed(
        &reqwest::Url::parse("http://192.0.2.1/").unwrap()
    ));
}
