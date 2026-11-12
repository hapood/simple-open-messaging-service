//! Native launch presentation. Rust owns readiness, expiry and window lifetime; adapters only draw.

use serde::Deserialize;
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod platform;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Stage {
    Preparing,
    Session,
    Config,
    Interface,
    Slow,
    Failed,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Update {
    Stage { stage: Stage },
    Theme { dark: bool },
    Ready,
    Failed,
}

#[derive(Debug)]
struct Launch {
    generation: String,
    stage: Stage,
    dark: bool,
    finished: bool,
    closed: bool,
}

impl Launch {
    fn apply(&mut self, generation: &str, update: Update) -> bool {
        if self.generation != generation || self.finished || self.closed {
            return false;
        }
        match update {
            Update::Theme { dark } => self.dark = dark,
            Update::Stage { stage } if self.stage != Stage::Failed => self.stage = stage,
            Update::Ready if self.stage != Stage::Failed => self.finished = true,
            Update::Failed => self.stage = Stage::Failed,
            _ => return false,
        }
        true
    }
}

#[derive(Clone, Default)]
pub(crate) struct LaunchState(
    Arc<Mutex<Option<Launch>>>,
    tokio_util::sync::CancellationToken,
);

/// The caller is injected by Tauri, not supplied by JavaScript. Only the primary local WebView can
/// report presentation facts, and a late callback cannot affect a closed or completed launch.
#[tauri::command]
pub(crate) async fn launch_update(
    webview: tauri::Webview,
    state: tauri::State<'_, LaunchState>,
    generation: String,
    update: Update,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("launch updates require the main webview".into());
    }
    dispatch(
        webview.app_handle(),
        state.inner().clone(),
        generation,
        update,
    )
}

fn dispatch(
    app: &tauri::AppHandle,
    state: LaunchState,
    generation: String,
    update: Update,
) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let presentation = {
            let mut guard = state.0.lock().expect("launch state");
            let Some(launch) = guard.as_mut() else { return };
            if !launch.apply(&generation, update) {
                return;
            }
            (launch.stage, launch.dark, launch.finished)
        };
        if presentation.2 || presentation.0 == Stage::Failed {
            state.1.cancel();
        }
        log::debug!(
            "launch presentation: {:?}, ready={}",
            presentation.0,
            presentation.2
        );
        // Never hold the lifecycle lock across a platform call.
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(window) = handle.get_window("main") {
            if let Err(error) = platform::present(&window, presentation.0, presentation.1, presentation.2) {
                log::error!("launch presentation failed: {error}");
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let _ = (handle, presentation);
    })
    .map_err(|error| error.to_string())
}

/// Build only an OS window. No WebKit, database, keychain or network operation precedes its logo.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn create_window(app: &tauri::App) -> tauri::Result<tauri::Window> {
    use tauri::window::WindowBuilder;
    let window = WindowBuilder::new(app, "main")
        .title("SOMS")
        .inner_size(1200.0, 800.0)
        .min_inner_size(390.0, 600.0)
        .visible(false)
        .build()?;
    let dark = window.theme()? == tauri::Theme::Dark;
    let state = app.state::<LaunchState>().inner().clone();
    let generation = uuid::Uuid::new_v4().to_string();
    *state.0.lock().expect("launch state") = Some(Launch {
        generation: generation.clone(),
        stage: Stage::Preparing,
        dark,
        finished: false,
        closed: false,
    });
    platform::install(&window, dark)?;
    let closed = state.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Some(launch) = closed.0.lock().expect("launch state").as_mut() {
                launch.closed = true;
            }
            closed.1.cancel();
        }
    });
    window.show()?;
    log::debug!("native launch window shown before WebView creation");
    // A slow launch remains covered. A timeout changes the status, never exposes an unpainted WebView.
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = state.1.cancelled() => return,
            _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {}
        }
        let _ = dispatch(
            &handle,
            state,
            generation,
            Update::Stage { stage: Stage::Slow },
        );
    });
    Ok(window)
}

/// Attach the one privileged WebView underneath the existing native overlay.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn attach_webview(window: &tauri::Window) -> tauri::Result<()> {
    let generation = {
        let state = window.state::<LaunchState>();
        let guard = state.0.lock().expect("launch state");
        let Some(launch) = guard.as_ref().filter(|launch| !launch.closed) else {
            return Ok(());
        };
        launch.generation.clone()
    };
    let webview =
        tauri::webview::WebviewBuilder::new("main", tauri::WebviewUrl::App("index.html".into()))
            .on_navigation(crate::navigation::is_allowed)
            .initialization_script(format!(
                "window.__SOMS_LAUNCH_GENERATION__ = {};",
                serde_json::to_string(&generation).expect("serialize launch generation"),
            ))
            .auto_resize();
    window.add_child(
        webview,
        tauri::LogicalPosition::new(0.0, 0.0),
        window.inner_size()?,
    )?;
    // Restore overlay stacking before the platform can display a WebView initialization frame.
    platform::raise(window)?;
    log::debug!("primary WebView attached beneath native launch layer");
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn failed(app: &tauri::AppHandle, error: &str) {
    log::error!("native launch failed: {error}");
    let state = app.state::<LaunchState>().inner().clone();
    let generation = state
        .0
        .lock()
        .expect("launch state")
        .as_ref()
        .map(|s| s.generation.clone());
    if let Some(generation) = generation {
        let _ = dispatch(app, state, generation, Update::Failed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch() -> Launch {
        Launch {
            generation: "current".into(),
            stage: Stage::Preparing,
            dark: false,
            finished: false,
            closed: false,
        }
    }

    #[test]
    fn stale_and_closed_updates_are_ignored() {
        let mut launch = launch();
        assert!(!launch.apply("old", Update::Ready));
        launch.closed = true;
        assert!(!launch.apply("current", Update::Ready));
        assert!(!launch.finished);
    }

    #[test]
    fn slow_launch_stays_covered_until_ready() {
        let mut launch = launch();
        assert!(launch.apply("current", Update::Stage { stage: Stage::Slow }));
        assert!(!launch.finished);
        assert!(launch.apply("current", Update::Ready));
        assert!(!launch.apply("current", Update::Ready));
        assert!(!launch.apply(
            "current",
            Update::Stage {
                stage: Stage::Session
            }
        ));
    }

    #[test]
    fn failure_does_not_reveal_a_broken_page() {
        let mut launch = launch();
        assert!(launch.apply("current", Update::Failed));
        assert!(!launch.apply("current", Update::Ready));
        assert!(!launch.apply("current", Update::Stage { stage: Stage::Slow }));
        assert!(launch.apply("current", Update::Theme { dark: true }));
        assert_eq!(launch.stage, Stage::Failed);
        assert!(!launch.finished);
    }
}
