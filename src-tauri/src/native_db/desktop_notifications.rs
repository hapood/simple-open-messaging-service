use serde::Deserialize;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[cfg(target_os = "macos")]
#[path = "macos_notifications.rs"]
pub(crate) mod macos_platform;

#[cfg(target_os = "linux")]
#[path = "linux_notification_registry.rs"]
mod linux_registry;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingTap {
    thread_id: i32,
}

static PENDING_TAP: Mutex<Option<PendingTap>> = Mutex::new(None);

#[cfg(target_os = "windows")]
pub(crate) fn initialize_windows_links(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_deep_link::DeepLinkExt;
    fn consume(app: &tauri::AppHandle, url: &str) {
        let Some(value) = url.strip_prefix("soms-notification://thread/") else {
            return;
        };
        let Ok(thread_id) = value.parse::<i32>() else {
            return;
        };
        // Deep links are untrusted input. Accept only the exact route emitted by our toast.
        if thread_id > 0 && value == thread_id.to_string() {
            tapped(app, thread_id);
        }
    }
    let target = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            consume(&target, url.as_str());
        }
    });
    if let Some(urls) = app
        .deep_link()
        .get_current()
        .map_err(|error| error.to_string())?
    {
        for url in urls {
            consume(app, url.as_str());
        }
    }
    Ok(())
}

fn tapped(app: &tauri::AppHandle, thread_id: i32) {
    let Ok(mut pending) = PENDING_TAP.lock() else {
        return;
    };
    *pending = Some(PendingTap { thread_id });
    drop(pending);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit("desktop-notification-open", ());
}

#[tauri::command]
pub(crate) fn desktop_notification_pending() -> Result<Option<PendingTap>, String> {
    let pending = PENDING_TAP
        .lock()
        .map_err(|_| "notification tap state poisoned")?;
    Ok(pending.clone())
}

#[tauri::command]
pub(crate) fn desktop_notification_acknowledge(thread_id: i32) -> Result<(), String> {
    let mut pending = PENDING_TAP
        .lock()
        .map_err(|_| "notification tap state poisoned")?;
    if pending
        .as_ref()
        .is_some_and(|tap| tap.thread_id == thread_id)
    {
        *pending = None;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopNotification {
    thread_id: i32,
    title: String,
    body: String,
    count: i64,
    silent: bool,
}

#[cfg(target_os = "linux")]
mod platform {
    use super::DesktopNotification;
    use notify_rust::{Hint, Notification, NotificationHandle, NotificationResponse};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex, OnceLock};

    struct Card {
        _handle: Arc<NotificationHandle>,
        listener: tauri::async_runtime::JoinHandle<()>,
    }

    fn cards() -> &'static Mutex<HashMap<i32, Card>> {
        static CARDS: OnceLock<Mutex<HashMap<i32, Card>>> = OnceLock::new();
        CARDS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub(super) fn update(app: tauri::AppHandle, input: DesktopNotification) -> Result<(), String> {
        let mut cards = cards().lock().map_err(|_| "notification state poisoned")?;
        let session = super::linux_registry::Session::connect()?;
        let mut registry = session.load()?;
        if input.count == 0 {
            if let Some(id) = registry.ids.get(&input.thread_id) {
                session.close(*id)?;
            }
            if let Some(card) = cards.remove(&input.thread_id) {
                card.listener.abort();
            }
            registry.ids.remove(&input.thread_id);
            return session.save(&registry);
        }
        let mut notification = Notification::new();
        notification
            .appname("SOMS")
            .summary(&input.title)
            .body(&input.body)
            .action("default", "")
            .hint(Hint::SuppressSound(input.silent));
        if let Some(id) = registry.ids.get(&input.thread_id) {
            // Close through the unique daemon owner. Never send an old ID as replaces_id
            // to a well-known name that could have changed owners immediately before Notify.
            session.close(*id)?;
        }
        let handle = Arc::new(notification.show().map_err(|error| error.to_string())?);
        if !session.unchanged()? {
            return Err("notification service changed while posting".into());
        }
        registry.ids.insert(input.thread_id, handle.id());
        if let Err(error) = session.save(&registry) {
            let _ = session.close(handle.id());
            return Err(error);
        }
        let waiting = Arc::clone(&handle);
        let thread_id = input.thread_id;
        let listener = tauri::async_runtime::spawn(async move {
            waiting
                .wait_for_action_async(|response| {
                    if matches!(response, NotificationResponse::Default) {
                        super::tapped(&app, thread_id);
                    }
                })
                .await;
        });
        if let Some(previous) = cards.insert(
            thread_id,
            Card {
                _handle: handle,
                listener,
            },
        ) {
            previous.listener.abort();
        }
        Ok(())
    }

    pub(super) fn clear() -> Result<(), String> {
        let mut cards = cards().lock().map_err(|_| "notification state poisoned")?;
        let session = super::linux_registry::Session::connect()?;
        let mut registry = session.load()?;
        for (_, card) in cards.drain() {
            card.listener.abort();
        }
        let mut error = None;
        registry.ids.retain(|_, id| match session.close(*id) {
            Ok(()) => false,
            Err(failure) => {
                error = Some(failure);
                true
            }
        });
        session.save(&registry)?;
        error.map_or(Ok(()), Err)
    }
}

#[cfg(target_os = "windows")]
mod windows_platform {
    use super::DesktopNotification;
    use windows::{
        core::HSTRING,
        Data::Xml::Dom::XmlDocument,
        UI::Notifications::{ToastNotification, ToastNotificationManager},
    };

    const GROUP: &str = "soms-messages";

    fn xml_text(value: &str) -> String {
        value
            .chars()
            .filter(|c| {
                matches!(*c, '\t' | '\n' | '\r')
                    || ('\u{20}'..='\u{d7ff}').contains(c)
                    || ('\u{e000}'..='\u{fffd}').contains(c)
                    || *c >= '\u{10000}'
            })
            .collect::<String>()
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }

    pub(super) fn update(app: tauri::AppHandle, input: DesktopNotification) -> Result<(), String> {
        update_inner(app, input).map_err(|error| error.to_string())
    }

    fn update_inner(
        app: tauri::AppHandle,
        input: DesktopNotification,
    ) -> windows::core::Result<()> {
        let app_id = HSTRING::from(app.config().identifier.as_str());
        let tag = HSTRING::from(input.thread_id.to_string());
        let group = HSTRING::from(GROUP);
        if input.count == 0 {
            return ToastNotificationManager::History()?
                .RemoveGroupedTagWithId(&tag, &group, &app_id);
        }
        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(format!(
            "<toast activationType=\"protocol\" launch=\"soms-notification://thread/{}\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual>{}</toast>",
            input.thread_id, xml_text(&input.title), xml_text(&input.body),
            if input.silent { "<audio silent=\"true\"/>" } else { "" },
        )))?;
        let toast = ToastNotification::CreateToastNotification(&xml)?;
        toast.SetTag(&tag)?;
        toast.SetGroup(&group)?;
        ToastNotificationManager::CreateToastNotifierWithId(&app_id)?.Show(&toast)
    }

    pub(super) fn clear(app: &tauri::AppHandle) -> Result<(), String> {
        (|| -> windows::core::Result<()> {
            ToastNotificationManager::History()?.RemoveGroupWithId(
                &HSTRING::from(GROUP),
                &HSTRING::from(app.config().identifier.as_str()),
            )
        })()
        .map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub(crate) async fn desktop_notification_update(
    app: tauri::AppHandle,
    notification: DesktopNotification,
) -> Result<(), String> {
    if notification.thread_id <= 0 || notification.count < 0 {
        return Err("invalid desktop notification coordinates".into());
    }
    // Share the account-cache lifetime: queued work cannot post after session invalidation.
    let epoch = super::lifetime::CACHE_LIFETIME.capture()?;
    #[cfg(target_os = "macos")]
    if notification.count > 0 {
        macos_platform::authorize().await?;
    }
    super::lifetime::spawn_at(Ok(epoch), move || {
        #[cfg(target_os = "linux")]
        {
            platform::update(app, notification)
        }
        #[cfg(target_os = "windows")]
        {
            windows_platform::update(app, notification)
        }
        #[cfg(target_os = "macos")]
        {
            let _ = app;
            macos_platform::update(notification)
        }
    })
    .await
    .map_err(|error| format!("join desktop notification: {error}"))?
}

#[tauri::command]
pub(crate) async fn desktop_notifications_clear(
    app: tauri::AppHandle,
    reset_navigation: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if reset_navigation {
            *PENDING_TAP
                .lock()
                .map_err(|_| "notification tap state poisoned")? = None;
        }
        #[cfg(target_os = "linux")]
        {
            let _ = app;
            platform::clear()
        }
        #[cfg(target_os = "windows")]
        {
            windows_platform::clear(&app)
        }
        #[cfg(target_os = "macos")]
        {
            let _ = app;
            macos_platform::clear()
        }
    })
    .await
    .map_err(|error| format!("join desktop notification clear: {error}"))?
}
