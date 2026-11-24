//! OS observation adapters. Platform selection stays at this boundary.
use super::delivery::ObservedCard;

// Adapters construct only the capability result their OS supports. Keep both
// outcomes in the shared contract so unsupported is distinct from an empty list.
#[allow(dead_code)]
pub(crate) enum CardObservation {
    Unsupported,
    Supported(Vec<ObservedCard>),
}

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "macos")]
pub(crate) use macos::{badge_refresh, permission, request_permission, open_settings};
#[cfg(target_os = "windows")]
pub(crate) use windows::{badge_refresh, permission, request_permission, open_settings};
#[cfg(target_os = "linux")]
pub(crate) use linux::{badge_refresh, permission, request_permission, open_settings};

#[cfg(target_os = "android")]
pub(crate) use android::observe;
#[cfg(target_os = "macos")]
pub(crate) use macos::observe;
#[cfg(target_os = "windows")]
pub(crate) use windows::observe;
#[cfg(target_os = "linux")]
pub(crate) use linux::observe;
