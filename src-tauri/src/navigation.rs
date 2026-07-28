//! Webview navigation and system-browser boundaries.
//!
//! The main webview is privileged, so documents stay on the bundled application
//! origin. User-facing links are opened by the operating system instead.

/// Return whether a top-level document navigation may stay in the privileged webview.
///
/// Android routes this callback through
/// `RustWebViewClient.shouldOverrideUrlLoading`, so the same policy applies on
/// desktop and mobile.
pub(crate) fn is_allowed(url: &reqwest::Url) -> bool {
    let scheme = url.scheme();
    let host = url.host_str().unwrap_or("");
    scheme == "tauri" || scheme == "about" || host == "tauri.localhost"
}

/// Open a link-message target in the system browser.
#[tauri::command]
pub(crate) async fn open_external_url(
    url: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // Keep non-web schemes away from OS protocol handlers. Message parsing also
    // enforces this, but the native boundary validates every caller independently.
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("refused non-http(s) url: {url}"));
    }

    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::is_allowed;

    #[test]
    fn bundled_application_origins_are_allowed() {
        assert!(is_allowed(
            &reqwest::Url::parse("tauri://localhost/index.html").unwrap()
        ));
        assert!(is_allowed(
            &reqwest::Url::parse("http://tauri.localhost/settings").unwrap()
        ));
        assert!(is_allowed(
            &reqwest::Url::parse("about:blank").unwrap()
        ));
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
}
