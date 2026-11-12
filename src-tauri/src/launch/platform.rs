//! Compile-time selection of the native renderer. No lifecycle decisions live here.

use super::Stage;

#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod renderer;
#[cfg(target_os = "windows")]
#[path = "windows.rs"]
mod renderer;

#[cfg(target_os = "macos")]
fn native_handle(window: &tauri::Window) -> tauri::Result<*mut std::ffi::c_void> {
    window.ns_window()
}

#[cfg(target_os = "windows")]
fn native_handle(window: &tauri::Window) -> tauri::Result<*mut std::ffi::c_void> {
    Ok(window.hwnd()?.0 as _)
}

pub(super) fn install(window: &tauri::Window, dark: bool) -> tauri::Result<()> {
    renderer::install(native_handle(window)?, dark)
}

pub(super) fn raise(window: &tauri::Window) -> tauri::Result<()> {
    renderer::raise(native_handle(window)?);
    Ok(())
}

pub(super) fn present(
    window: &tauri::Window,
    stage: Stage,
    dark: bool,
    finished: bool,
) -> tauri::Result<()> {
    renderer::present(native_handle(window)?, stage, dark, finished);
    Ok(())
}
