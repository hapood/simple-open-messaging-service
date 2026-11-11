use super::Stage;
use std::ffi::c_void;

extern "C" {
    fn soms_windows_launch_install(
        window: *mut c_void,
        dark: bool,
        reveal: f64,
        delay: f64,
        brand: f64,
    ) -> bool;
    fn soms_windows_launch_raise(window: *mut c_void);
    fn soms_windows_launch_present(
        window: *mut c_void,
        stage: i32,
        dark: bool,
        finished: bool,
        fade: f64,
    );
}

// Native handles never leave the UI thread. The parent window owns the child
// overlay, and its destruction cancels all presentation timers.
pub(super) fn install(window: *mut c_void, dark: bool) -> tauri::Result<()> {
    if unsafe { soms_windows_launch_install(window, dark, 320.0, 100.0, 220.0) } {
        Ok(())
    } else {
        Err(std::io::Error::other("could not create Windows launch presentation").into())
    }
}
pub(super) fn raise(window: *mut c_void) {
    unsafe { soms_windows_launch_raise(window) };
}
pub(super) fn present(window: *mut c_void, stage: Stage, dark: bool, finished: bool) {
    let stage = match stage {
        Stage::Preparing => 0,
        Stage::Session => 1,
        Stage::Config => 2,
        Stage::Interface => 3,
        Stage::Slow => 4,
        Stage::Failed => 5,
    };
    unsafe { soms_windows_launch_present(window, stage, dark, finished, 180.0) };
}
