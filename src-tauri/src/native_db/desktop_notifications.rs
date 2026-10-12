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
    id: String,
    thread_id: i32,
    session_id: i32,
    origin: String,
}

#[cfg(any(target_os = "windows", test))]
fn parse_activation(url: &str) -> Option<(i32, i32, String)> {
    let (route, _) = url.split_once('?')?;
    let parsed = reqwest::Url::parse(url).ok()?;
    if parsed.fragment().is_some() { return None; }
    let pairs: Vec<_> = parsed.query_pairs().collect();
    if pairs.len() != 1 || pairs[0].0 != "origin" || pairs[0].1.is_empty() { return None; }
    let origin = pairs[0].1.to_string();
    let path = route.strip_prefix("soms-notification://session/")?;
    let (session, thread) = path.split_once("/thread/")?;
    let session_id = session.parse::<i32>().ok()?;
    let thread_id = thread.parse::<i32>().ok()?;
    (session_id > 0 && thread_id > 0 && session == session_id.to_string() && thread == thread_id.to_string())
        .then_some((session_id, thread_id, origin))
}

static PENDING_TAP: Mutex<Option<PendingTap>> = Mutex::new(None);

fn next_tap_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed).to_string()
}

#[cfg(target_os = "windows")]
pub(crate) fn initialize_windows_links(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_deep_link::DeepLinkExt;
    fn consume(app: &tauri::AppHandle, url: &str) {
        // Reject old account/unscoped links; only the exact session-scoped route is accepted.
        if let Some((session_id, thread_id, origin)) = parse_activation(url) {
            tapped(app, thread_id, session_id, &origin);
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

fn tapped(app: &tauri::AppHandle, thread_id: i32, session_id: i32, origin: &str) {
    if thread_id <= 0 || session_id <= 0 || origin.is_empty() { return; }
    let state = app.state::<crate::ServerSessionState>();
    if *state.api_origin_primary.lock().expect("primary origin lock") != origin { return; }
    let Ok(mut pending) = PENDING_TAP.lock() else {
        return;
    };
    *pending = Some(PendingTap {
        id: next_tap_id(),
        thread_id,
        session_id,
        origin: origin.to_string(),
    });
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
pub(crate) fn desktop_notification_acknowledge(id: String, thread_id: i32, session_id: i32) -> Result<(), String> {
    let mut pending = PENDING_TAP
        .lock()
        .map_err(|_| "notification tap state poisoned")?;
    if pending
        .as_ref()
        .is_some_and(|tap| tap.id == id && tap.thread_id == thread_id && tap.session_id == session_id)
    {
        *pending = None;
    }
    Ok(())
}

#[cfg(test)]
mod navigation_tests {
    use super::*;

    #[test]
    fn activation_requires_exact_session_scope() {
        assert_eq!(parse_activation("soms-notification://session/11/thread/7?origin=https%3A%2F%2Fprimary"), Some((11, 7, "https://primary".into())));
        for url in [
            "soms-notification://thread/7",
            "soms-notification://account/11/thread/7?origin=https%3A%2F%2Fprimary",
            "soms-notification://session/11/thread/7",
            "soms-notification://session/0/thread/7?origin=https%3A%2F%2Fprimary",
            "soms-notification://session/11/thread/07?origin=https%3A%2F%2Fprimary",
            "soms-notification://session/11/thread/7?x=1",
            "soms-notification://session/11/thread/7?origin=",
            "soms-notification://session/11/thread/7?origin=https%3A%2F%2Fprimary&origin=other",
            "soms-notification://session/11/thread/7?origin=https%3A%2F%2Fprimary#fragment",
        ] {
            assert_eq!(parse_activation(url), None);
        }
    }

    #[test]
    fn acknowledgement_is_exact_even_for_repeated_taps_on_one_thread() {
        let old_id = next_tap_id();
        let new_id = next_tap_id();
        assert_ne!(old_id, new_id);
        *PENDING_TAP.lock().unwrap() = Some(PendingTap {
            id: new_id.clone(), thread_id: 7, session_id: 11, origin: "https://primary".into(),
        });
        desktop_notification_acknowledge(old_id, 7, 11).unwrap();
        assert_eq!(desktop_notification_pending().unwrap().unwrap().id, new_id);
        desktop_notification_acknowledge(new_id.clone(), 9, 11).unwrap();
        assert!(desktop_notification_pending().unwrap().is_some());
        desktop_notification_acknowledge(new_id.clone(), 7, 12).unwrap();
        assert_eq!(desktop_notification_pending().unwrap().unwrap().session_id, 11);
        desktop_notification_acknowledge(new_id, 7, 11).unwrap();
        assert!(desktop_notification_pending().unwrap().is_none());
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopNotification {
    thread_id: i32,
    session_id: i32,
    origin: String,
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
        let session_id = input.session_id;
        let origin = input.origin;
        let listener = tauri::async_runtime::spawn(async move {
            waiting
                .wait_for_action_async(|response| {
                    if matches!(response, NotificationResponse::Default) {
                        super::tapped(&app, thread_id, session_id, &origin);
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
        let mut activation = reqwest::Url::parse(&format!("soms-notification://session/{}/thread/{}", input.session_id, input.thread_id)).expect("notification URL");
        activation.query_pairs_mut().append_pair("origin", &input.origin);
        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(format!(
            "<toast activationType=\"protocol\" launch=\"{}\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual>{}</toast>",
            xml_text(activation.as_str()), xml_text(&input.title), xml_text(&input.body),
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
    if notification.thread_id <= 0 || notification.count < 0 ||
        (notification.count > 0 && (notification.session_id <= 0 || notification.origin.is_empty())) {
        return Err("invalid desktop notification coordinates".into());
    }
    // Share the account-cache lifetime: queued work cannot post after session invalidation.
    let epoch = super::lifetime::CACHE_LIFETIME.capture()?;
    #[cfg(target_os = "macos")]
    if notification.count > 0 {
        macos_platform::authorize().await?;
    }
    super::lifetime::spawn_at(Ok(epoch), move || {
        if notification.count > 0 && *app.state::<crate::ServerSessionState>().api_origin_primary.lock().expect("primary origin lock") != notification.origin {
            return Err("notification origin expired".into());
        }
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
