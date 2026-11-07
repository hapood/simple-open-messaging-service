/// Window lifecycle policy is separate from application exit: explicit Quit is not intercepted.
pub(crate) fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    #[cfg(desktop)]
    if should_observe_presentation(window.label(), event) {
        use tauri::Manager;
        let app = window.app_handle().clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = crate::native_db::desktop_notifications::desktop_notification_presentation_changed(app).await {
                log::warn!("window notification observation failed: {error}");
            }
        });
    }
    #[cfg(target_os = "macos")]
    handle_macos_window_event(window, event);
    #[cfg(not(target_os = "macos"))]
    let _ = (window, event);
}

#[cfg(any(desktop, test))]
fn should_observe_presentation(label: &str, event: &tauri::WindowEvent) -> bool {
    label == "main" && matches!(event, tauri::WindowEvent::Focused(true))
}

#[cfg(target_os = "macos")]
fn handle_macos_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if !is_persistent_window(window.label()) {
        return;
    }
    let tauri::WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    // Keep the chat runtime alive even if the OS cannot minimize the window.
    api.prevent_close();
    if let Err(error) = window.minimize() {
        log::warn!("could not minimize main window: {error}");
    }
}

#[cfg(any(target_os = "macos", test))]
fn is_persistent_window(label: &str) -> bool {
    label == "main"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_main_window_focus_gain_wakes_notification_policy() {
        assert!(should_observe_presentation("main", &tauri::WindowEvent::Focused(true)));
        assert!(!should_observe_presentation("main", &tauri::WindowEvent::Focused(false)));
        assert!(!should_observe_presentation("settings", &tauri::WindowEvent::Focused(true)));
    }

    #[test]
    fn only_the_main_window_is_kept_alive_on_close() {
        assert!(is_persistent_window("main"));
        assert!(!is_persistent_window("settings"));
        assert!(!is_persistent_window(""));
    }
}
