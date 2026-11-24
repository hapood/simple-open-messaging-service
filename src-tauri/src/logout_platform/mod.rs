//! Explicit OS cleanup adapters used by the shared logout coordinator.
#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "android")]
pub(crate) use android::{cleanup, initialize};

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
mod desktop;
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub(crate) use desktop::cleanup;
