use super::Stage;
use std::ffi::c_void;

extern "C" {
    fn soms_launch_install(
        window: *mut c_void,
        dark: bool,
        reveal_ms: f64,
        brand_delay_ms: f64,
        brand_ms: f64,
    );
    fn soms_launch_raise(window: *mut c_void);
    fn soms_launch_present(
        window: *mut c_void,
        stage: i32,
        dark: bool,
        finished: bool,
        fade_ms: f64,
    );
}

// All entry points are called on Tauri's main thread. The NSWindow owns its overlay; no native
// pointer is retained by Rust or sent to a worker, and late updates are gated by the launch state.
pub(super) fn install(window: *mut c_void, dark: bool) {
    unsafe { soms_launch_install(window, dark, 320.0, 100.0, 220.0) };
}

pub(super) fn raise(window: *mut c_void) {
    unsafe { soms_launch_raise(window) };
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
    unsafe { soms_launch_present(window, stage, dark, finished, 180.0) };
}
