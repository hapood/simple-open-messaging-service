use super::{DesktopNotification, ExecutionFailure};
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::{mpsc, OnceLock};

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
type Completion = extern "C" fn(*mut c_void, *const c_char);

extern "C" {
    fn soms_macos_notifications_init();
    fn soms_macos_notifications_status(
        context: *mut c_void,
        completion: extern "C" fn(*mut c_void, i32),
    );
    fn soms_macos_notifications_authorize(context: *mut c_void, completion: Completion);
    fn soms_macos_notification_post(
        thread: i32,
        notification_id: *const c_char,
        title: *const c_char,
        body: *const c_char,
        silent: bool,
        context: *mut c_void,
        completion: Completion,
    );
    fn soms_macos_notification_remove(notification_id: *const c_char);
    fn soms_macos_notifications_clear(context: *mut c_void, completion: Completion);
    fn soms_macos_notifications_current(
        context: *mut c_void,
        completion: extern "C" fn(*mut c_void, *const c_char, *const c_char),
    );
}

extern "C" fn completed(context: *mut c_void, error: *const c_char) {
    // The native completion owns this box and calls back exactly once.
    let sender = unsafe { Box::from_raw(context.cast::<mpsc::Sender<Result<(), String>>>()) };
    let result = if error.is_null() {
        Ok(())
    } else {
        Err(unsafe { CStr::from_ptr(error) }
            .to_string_lossy()
            .into_owned())
    };
    let _ = sender.send(result);
}

fn wait_for_completion(
    start: impl FnOnce(*mut c_void, Completion),
) -> Result<(), ExecutionFailure> {
    let (sender, receiver) = mpsc::channel();
    start(Box::into_raw(Box::new(sender)).cast(), completed);
    receiver
        .recv()
        .map_err(|error| ExecutionFailure::Uncertain(format!("notification completion: {error}")))?
        .map_err(ExecutionFailure::Rejected)
}

extern "C" fn current_completed(context: *mut c_void, json: *const c_char, error: *const c_char) {
    let sender = unsafe { Box::from_raw(context.cast::<mpsc::Sender<Result<String, String>>>()) };
    let result = if !error.is_null() {
        Err(unsafe { CStr::from_ptr(error) }
            .to_string_lossy()
            .into_owned())
    } else if json.is_null() {
        Err("missing macOS notification observation".into())
    } else {
        unsafe { CStr::from_ptr(json) }
            .to_str()
            .map(str::to_owned)
            .map_err(|e| e.to_string())
    };
    let _ = sender.send(result);
}

/// Called on the storage initialization thread, before the WebView and HELLO.
pub(crate) fn restore_cards(
) -> Result<Vec<super::super::notifications::delivery::ObservedCard>, String> {
    let (sender, receiver) = mpsc::channel::<Result<String, String>>();
    unsafe {
        soms_macos_notifications_current(Box::into_raw(Box::new(sender)).cast(), current_completed);
    }
    let json = receiver.recv().map_err(|e| e.to_string())??;
    let observed = super::super::notifications::macos_observation::decode(&json)?;
    let (retained, surplus) =
        super::super::notifications::delivery::select_restored_cards(observed);
    for card in surplus {
        let super::super::notifications::delivery::PlatformHandle::Macos { identifier } =
            card.handle
        else {
            return Err("unexpected macOS notification handle".into());
        };
        let identifier = CString::new(identifier).map_err(|e| e.to_string())?;
        unsafe {
            soms_macos_notification_remove(identifier.as_ptr());
        }
    }
    Ok(retained)
}

pub(crate) fn initialize(app: tauri::AppHandle) {
    super::super::desktop_badge::initialize(app.clone());
    let _ = APP.set(app);
    unsafe { soms_macos_notifications_init() };
    // Ask only on first use; a previous refusal must be changed in System Settings.
    // Authorization runs without blocking the event loop or holding account locks.
    tauri::async_runtime::spawn(async {
        if let Err(error) = request_initial_authorization().await {
            log::warn!("initial notification authorization failed: {error}");
        }
    });
}

async fn request_initial_authorization() -> Result<(), String> {
    if !permission().await?.should_request_initial_authorization() {
        return Ok(());
    }
    authorize().await
}

#[no_mangle]
extern "C" fn soms_macos_notification_tapped(thread: i32, notification_id: *const c_char) {
    if !retire_instance(thread, notification_id) {
        return;
    }
    if let Some(app) = APP.get() {
        super::tapped(app, thread);
    }
}

#[no_mangle]
extern "C" fn soms_macos_notification_dismissed(thread: i32, notification_id: *const c_char) {
    retire_instance(thread, notification_id);
}

fn retire_instance(thread: i32, notification_id: *const c_char) -> bool {
    if thread <= 0 || notification_id.is_null() {
        return false;
    }
    let Ok(identifier) = (unsafe { CStr::from_ptr(notification_id) }).to_str() else {
        return false;
    };
    let Some(id) = instance_id(identifier) else {
        return false;
    };
    if let Ok(owner) = super::super::active_login() {
        if let Ok(mut delivery) = owner.notification_delivery.lock() {
            delivery.dismissed(thread, id);
        }
    }
    true
}

extern "C" fn status_completed(context: *mut c_void, status: i32) {
    // The native completion owns this box and calls back exactly once.
    let sender = unsafe { Box::from_raw(context.cast::<mpsc::Sender<i32>>()) };
    let _ = sender.send(status);
}

pub(super) async fn permission() -> Result<super::DesktopNotificationPermission, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (sender, receiver) = mpsc::channel::<i32>();
        unsafe {
            soms_macos_notifications_status(
                Box::into_raw(Box::new(sender)).cast(),
                status_completed,
            );
        }
        let status = receiver.recv().map_err(|error| error.to_string())?;
        Ok(super::permission_from_macos_status(status))
    })
    .await
    .map_err(|error| format!("notification permission: {error}"))?
}

/// Permission prompts must never hold the account lifetime read guard.
pub(super) async fn authorize() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        wait_for_completion(|context, completion| unsafe {
            soms_macos_notifications_authorize(context, completion);
        })
    })
    .await
    .map_err(|error| format!("notification authorization: {error}"))?
    .map_err(|error| error.to_string())
}

fn instance_id(identifier: &str) -> Option<&str> {
    let id = identifier.strip_prefix("soms-thread-")?;
    let parsed = uuid::Uuid::parse_str(id).ok()?;
    (parsed.to_string() == id).then_some(id)
}

pub(super) fn identifier(instance: &str) -> String {
    format!("soms-thread-{instance}")
}

pub(super) fn update(input: DesktopNotification) -> Result<(), ExecutionFailure> {
    let Some(id) = input.notification_id else {
        return if input.count == 0 {
            Ok(())
        } else {
            Err("missing notification instance".into())
        };
    };
    let id = CString::new(id).map_err(|error| error.to_string())?;
    if input.count == 0 {
        unsafe { soms_macos_notification_remove(id.as_ptr()) };
        return Ok(());
    }
    let title = CString::new(input.title.replace('\0', "")).map_err(|error| error.to_string())?;
    let body = CString::new(input.body.replace('\0', "")).map_err(|error| error.to_string())?;
    wait_for_completion(|context, completion| unsafe {
        soms_macos_notification_post(
            input.thread_id,
            id.as_ptr(),
            title.as_ptr(),
            body.as_ptr(),
            input.silent,
            context,
            completion,
        );
    })
}

#[cfg(test)]
mod instance_tests {
    use super::*;

    #[test]
    fn system_identifier_roundtrips_only_canonical_instance_ids() {
        let id = "b70b8f27-293e-42d1-86d4-24055d649480";
        assert_eq!(instance_id(&identifier(id)), Some(id));
        for value in [
            "soms-thread-7",
            "soms-thread-",
            "other-card",
            "soms-thread-B70B8F27-293E-42D1-86D4-24055D649480",
        ] {
            assert_eq!(instance_id(value), None);
        }
    }
}

pub(super) fn clear() -> Result<(), String> {
    wait_for_completion(|context, completion| unsafe {
        soms_macos_notifications_clear(context, completion);
    })
    .map_err(|error| error.to_string())
}
