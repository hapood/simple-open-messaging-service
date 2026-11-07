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

}

#[cfg(any(target_os = "windows", test))]
fn parse_activation(url: &str) -> Option<i32> {
    let thread = url.strip_prefix("soms-notification://thread/")?;
    let id = thread.parse::<i32>().ok()?;
    (id > 0 && thread == id.to_string()).then_some(id)
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
        if let Some(thread_id) = parse_activation(url) {
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
    if thread_id <= 0 {
        return;
    }
    let Ok(mut pending) = PENDING_TAP.lock() else {
        return;
    };
    *pending = Some(PendingTap {
        id: next_tap_id(),
        thread_id,
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
pub(crate) fn desktop_notification_acknowledge(
    id: String,
    thread_id: i32,
) -> Result<(), String> {
    let mut pending = PENDING_TAP
        .lock()
        .map_err(|_| "notification tap state poisoned")?;
    if pending.as_ref().is_some_and(|tap| {
        tap.id == id && tap.thread_id == thread_id
    }) {
        *pending = None;
    }
    Ok(())
}

#[cfg(test)]
mod navigation_tests {
    use super::*;

    #[test]
    fn activation_requires_a_canonical_thread_target() {
        assert_eq!(parse_activation("soms-notification://thread/7"), Some(7));
        for url in [
            "soms-notification://thread/0",
            "soms-notification://thread/07",
            "soms-notification://thread/7?x=1",
            "soms-notification://thread/7#fragment",
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
            id: new_id.clone(),
            thread_id: 7,
        });
        desktop_notification_acknowledge(old_id, 7).unwrap();
        assert_eq!(desktop_notification_pending().unwrap().unwrap().id, new_id);
        desktop_notification_acknowledge(new_id.clone(), 9).unwrap();
        assert!(desktop_notification_pending().unwrap().is_some());
        desktop_notification_acknowledge(new_id, 7).unwrap();
        assert!(desktop_notification_pending().unwrap().is_none());
    }
}

pub(crate) struct DesktopNotification {
    notification_id: Option<String>,
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
        let activation = format!("soms-notification://thread/{}", input.thread_id);
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
pub(crate) async fn desktop_badge_refresh(
    app: tauri::AppHandle,
    session_uuid: String,
    user_id: i64,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        super::desktop_badge::refresh(app, session_uuid, user_id).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, session_uuid, user_id);
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DesktopNotificationPermission {
    Unsupported,
    NotDetermined,
    Denied,
    Authorized,
    Provisional,
    Unknown,
}

#[cfg(any(target_os = "macos", test))]
impl DesktopNotificationPermission {
    fn should_request_initial_authorization(self) -> bool {
        matches!(self, Self::NotDetermined)
    }
}

#[cfg(any(target_os = "macos", test))]
fn permission_from_macos_status(status: i32) -> DesktopNotificationPermission {
    match status {
        0 => DesktopNotificationPermission::NotDetermined,
        1 => DesktopNotificationPermission::Denied,
        2 => DesktopNotificationPermission::Authorized,
        3 => DesktopNotificationPermission::Provisional,
        _ => DesktopNotificationPermission::Unknown,
    }
}

#[tauri::command]
pub(crate) async fn desktop_notification_permission(
) -> Result<DesktopNotificationPermission, String> {
    #[cfg(target_os = "macos")]
    {
        macos_platform::permission().await
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(DesktopNotificationPermission::Unsupported)
    }
}

#[tauri::command]
pub(crate) async fn desktop_notification_request_permission(
) -> Result<DesktopNotificationPermission, String> {
    #[cfg(target_os = "macos")]
    {
        // A denial is a permission state, not a transport failure. Re-query after the prompt.
        let result = macos_platform::authorize().await;
        let permission = macos_platform::permission().await?;
        if permission == DesktopNotificationPermission::Denied {
            return Ok(permission);
        }
        result?;
        Ok(permission)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(DesktopNotificationPermission::Unsupported)
    }
}

#[tauri::command]
pub(crate) async fn desktop_notification_open_settings(
    app: tauri::AppHandle,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_opener::OpenerExt;
        // This command accepts no URL from the webview.
        app.opener()
            .open_url(
                "x-apple.systempreferences:com.apple.preference.notifications",
                None::<&str>,
            )
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("notification settings are not supported on this platform".into())
    }
}

#[cfg(test)]
mod permission_tests {
    use super::*;

    #[test]
    fn initial_authorization_only_requests_an_undetermined_permission() {
        use DesktopNotificationPermission::*;

        assert!(NotDetermined.should_request_initial_authorization());
        for permission in [Unsupported, Denied, Authorized, Provisional, Unknown] {
            assert!(
                !permission.should_request_initial_authorization(),
                "must not request initial authorization for {permission:?}"
            );
        }
    }

    #[test]
    fn macos_permission_states_are_explicit_and_unknown_is_not_authorized() {
        assert_eq!(
            permission_from_macos_status(0),
            DesktopNotificationPermission::NotDetermined
        );
        assert_eq!(
            permission_from_macos_status(1),
            DesktopNotificationPermission::Denied
        );
        assert_eq!(
            permission_from_macos_status(2),
            DesktopNotificationPermission::Authorized
        );
        assert_eq!(
            permission_from_macos_status(3),
            DesktopNotificationPermission::Provisional
        );
        assert_eq!(
            permission_from_macos_status(99),
            DesktopNotificationPermission::Unknown
        );
        assert_eq!(
            serde_json::to_string(&permission_from_macos_status(0)).unwrap(),
            "\"notDetermined\""
        );
    }
}

#[tauri::command]
pub(crate) async fn desktop_notification_presentation_changed(
    app: tauri::AppHandle,
) -> Result<(), String> {
    let facts = presentation_facts(&app);
    let Some(thread_id) = super::notifications::content::visible_thread(facts) else {
        return Ok(());
    };
    let work = super::capture_database_work()?;
    #[cfg(not(target_os = "macos"))]
    work.owner().notification_dismissed(thread_id).map_err(|e| e.to_string())?;
    deliver_command(app, work, super::notifications::content::NotificationCommand::Remove { thread_id }).await
}

/// Native synchronization supplies the captured work and its assembled thread projections.
pub(crate) async fn deliver_batch(
    app: tauri::AppHandle,
    work: crate::login_connection::DatabaseWork,
    batch: super::notifications::NotificationBatch,
) -> Result<(), String> {
    let presentation = super::notifications::presentation::prepare_batch(
        work.clone(), &batch, presentation_facts(&app), true,
    ).await?;
    let mut failures = Vec::new();
    for command in presentation.commands {
        work.assert_current().map_err(|e| e.to_string())?;
        if let Err(error) = deliver_command(app.clone(), work.clone(), command).await {
            failures.push(error);
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!("notification batch delivery failed: {}", failures.join("; ")))
    }
}

/// Observe OS window state and reuse the existing native open-thread fact. This
/// adapter reports facts only; shared Rust policy decides notification suppression.
pub(crate) fn presentation_facts(
    app: &tauri::AppHandle,
) -> super::notifications::content::PresentationFacts {
    use tauri::Manager;
    let window = app.get_webview_window("main");
    super::notifications::content::PresentationFacts {
        visible: window.as_ref().is_some_and(|window| {
            window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true)
        }),
        focused: window.as_ref().is_some_and(|window| window.is_focused().unwrap_or(false)),
        open_thread: super::attention::open_thread_id().and_then(|id| i32::try_from(id).ok()),
    }
}

/// Execute an already-decided native notification command. Platforms do not rebuild
/// previews, inspect unread state, or make privacy/sound decisions here.
pub(crate) async fn deliver_command(
    app: tauri::AppHandle,
    work: crate::login_connection::DatabaseWork,
    command: super::notifications::content::NotificationCommand,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    return execute_command(app, work, command, None).await;
    #[cfg(target_os = "macos")]
    {
        // The task owns execution through acknowledgement even if its caller stops waiting.
        tauri::async_runtime::spawn(async move {
            use super::notifications::{alert::AlertPolicy, content::NotificationCommand, delivery::{DeliveryResult, PlatformHandle}};
            let owner = work.owner().clone();
            let _lane = owner.notification_delivery_lane.lock().await;
            work.assert_current().map_err(|e| e.to_string())?;
            let policy = super::preferences::read_notification_preference("notificationAlertPolicy")?;
            let policy = AlertPolicy::from_preference(policy.as_deref())?;
            let command = super::notifications::content::observe_before_delivery(command, presentation_facts(&app));
            let prepared = owner.notification_delivery.lock().map_err(|_| "notification state poisoned")?
                .prepare(command, policy, true, std::time::Instant::now()).map_err(str::to_owned)?;
            let os_identifier = match &prepared.previous_handle {
                Some(PlatformHandle::Macos { identifier }) => Some(identifier.clone()),
                Some(_) => return Err("unexpected macOS notification handle".into()),
                None => prepared.notification_id.as_deref().map(macos_platform::identifier),
            };
            let handle = match &prepared.command {
                NotificationCommand::Show(_) => Some(PlatformHandle::Macos {
                    identifier: os_identifier.clone().ok_or("missing notification instance")?,
                }),
                _ => None,
            };
            let result = execute_command(app, work, prepared.command, os_identifier).await;
            let outcome = match &result {
                Ok(()) => DeliveryResult::Accepted { handle },
                Err(error) if error.starts_with("join desktop notification:") => DeliveryResult::Uncertain,
                Err(_) => DeliveryResult::Rejected,
            };
            owner.notification_delivery.lock().map_err(|_| "notification state poisoned")?
                .complete(&prepared.operation_id, outcome, std::time::Instant::now()).map_err(str::to_owned)?;
            result
        }).await.map_err(|e| format!("join notification transaction: {e}"))?
    }
}

async fn execute_command(
    app: tauri::AppHandle,
    work: crate::login_connection::DatabaseWork,
    command: super::notifications::content::NotificationCommand,
    notification_id: Option<String>,
) -> Result<(), String> {
    use super::notifications::content::NotificationCommand;
    let request = match command {
        NotificationCommand::Remove { thread_id } => DesktopNotification {
            notification_id,
            thread_id,
            title: String::new(),
            body: String::new(),
            count: 0,
            silent: true,
        },
        NotificationCommand::Show(content) => DesktopNotification {
            notification_id,
            thread_id: content.thread_id,
            title: content.title,
            body: content.body,
            count: content.count,
            silent: content.silent,
        },
    };
    deliver_notification(app, work, request).await
}

/// Host-owned delivery uses the original database work captured by synchronization.
/// It never reconstructs ownership from mutable renderer or global session state.
async fn deliver_notification(
    app: tauri::AppHandle,
    work: crate::login_connection::DatabaseWork,
    notification: DesktopNotification,
) -> Result<(), String> {
    if notification.thread_id <= 0 || notification.count < 0 {
        return Err("invalid desktop notification coordinates".into());
    }
    work.assert_current().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    if notification.count > 0 {
        macos_platform::authorize().await?;
    }
    super::spawn_owned_work(work, move || {
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
    tauri::async_runtime::spawn_blocking(move || clear_notifications(&app, reset_navigation))
        .await
        .map_err(|error| format!("join desktop notification clear: {error}"))?
}

/// Called by the logout cleanup task before releasing authentication admission.
pub(crate) fn clear_notifications(
    app: &tauri::AppHandle,
    reset_navigation: bool,
) -> Result<(), String> {
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
        windows_platform::clear(app)
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        macos_platform::clear()
    }
}
