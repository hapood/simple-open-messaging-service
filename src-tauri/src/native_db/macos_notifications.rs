use super::DesktopNotification;
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::{mpsc, OnceLock};

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
type Completion = extern "C" fn(*mut c_void, *const c_char);

extern "C" {
    fn soms_macos_notifications_init();
    fn soms_macos_notifications_authorize(context: *mut c_void, completion: Completion);
    fn soms_macos_notification_post(
        thread: i32,
        title: *const c_char,
        body: *const c_char,
        silent: bool,
        context: *mut c_void,
        completion: Completion,
    );
    fn soms_macos_notification_remove(thread: i32);
    fn soms_macos_notifications_clear(context: *mut c_void, completion: Completion);
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

fn wait_for_completion(start: impl FnOnce(*mut c_void, Completion)) -> Result<(), String> {
    let (sender, receiver) = mpsc::channel();
    start(Box::into_raw(Box::new(sender)).cast(), completed);
    receiver
        .recv()
        .map_err(|error| format!("notification completion: {error}"))?
}

pub(crate) fn initialize(app: tauri::AppHandle) {
    let _ = APP.set(app);
    unsafe { soms_macos_notifications_init() };
}

#[no_mangle]
extern "C" fn soms_macos_notification_tapped(thread: i32) {
    if let Some(app) = APP.get() {
        if thread > 0 {
            super::tapped(app, thread);
        }
    }
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
}

pub(super) fn update(input: DesktopNotification) -> Result<(), String> {
    if input.count == 0 {
        unsafe { soms_macos_notification_remove(input.thread_id) };
        return Ok(());
    }
    let title = CString::new(input.title.replace('\0', "")).map_err(|error| error.to_string())?;
    let body = CString::new(input.body.replace('\0', "")).map_err(|error| error.to_string())?;
    wait_for_completion(|context, completion| unsafe {
        soms_macos_notification_post(
            input.thread_id,
            title.as_ptr(),
            body.as_ptr(),
            input.silent,
            context,
            completion,
        );
    })
}

pub(super) fn clear() -> Result<(), String> {
    wait_for_completion(|context, completion| unsafe {
        soms_macos_notifications_clear(context, completion);
    })
}
