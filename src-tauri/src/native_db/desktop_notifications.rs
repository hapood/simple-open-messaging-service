use super::notifications::delivery::{DeliveryResult, PlatformHandle};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// Adapter failures carry an explicit execution boundary, never a message prefix.
#[derive(Debug)]
pub(super) enum ExecutionFailure {
    NotExecuted(String),
    Rejected(String),
    Uncertain(String),
}

impl From<String> for ExecutionFailure {
    fn from(error: String) -> Self {
        Self::NotExecuted(error)
    }
}

impl From<&str> for ExecutionFailure {
    fn from(error: &str) -> Self {
        Self::NotExecuted(error.into())
    }
}

impl std::fmt::Display for ExecutionFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotExecuted(error) | Self::Rejected(error) | Self::Uncertain(error) => {
                error.fmt(f)
            }
        }
    }
}

impl ExecutionFailure {
    fn into_result(self) -> DeliveryResult {
        log::warn!("notification execution failed: {self}");
        match self {
            Self::NotExecuted(_) => DeliveryResult::NotExecuted,
            Self::Rejected(_) => DeliveryResult::Rejected,
            Self::Uncertain(_) => DeliveryResult::Uncertain,
        }
    }
}

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
fn parse_activation(url: &str) -> Option<(i32, String)> {
    let target = url.strip_prefix("soms-notification://thread/")?;
    let (thread, instance) = target.split_once("/card/")?;
    let id = thread.parse::<i32>().ok()?;
    let uuid = uuid::Uuid::parse_str(instance).ok()?;
    (id > 0 && thread == id.to_string() && instance == uuid.to_string())
        .then(|| (id, instance.to_owned()))
}

#[cfg(any(target_os = "windows", test))]
fn windows_observed_card(launch: &str, tag: String, group: String) -> Result<super::notifications::delivery::ObservedCard, String> {
    let (thread_id, notification_id) = parse_activation(launch).ok_or("invalid Windows notification activation")?;
    if tag != notification_id || group != "soms-messages" {
        return Err("Windows notification handle does not match activation".into());
    }
    Ok(super::notifications::delivery::ObservedCard {
        thread_id, notification_id,
        handle: PlatformHandle::Windows { tag, group },
    })
}

#[cfg(target_os = "windows")]
pub(crate) fn restore_windows_cards(app: &tauri::AppHandle, owner: std::sync::Arc<crate::login_connection::LoginConnection>)
    -> Result<Vec<super::notifications::delivery::ObservedCard>, String> {
    windows_platform::restore_cards(app, owner)
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
        if let Some((thread_id, instance)) = parse_activation(url) {
            if let Ok(owner) = super::active_login() {
                if let Ok(mut state) = owner.notification_delivery.lock() {
                    state.dismissed(thread_id, &instance);
                }
            }
            windows_platform::retire_subscription(&instance);
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
pub(crate) fn desktop_notification_acknowledge(id: String, thread_id: i32) -> Result<(), String> {
    let mut pending = PENDING_TAP
        .lock()
        .map_err(|_| "notification tap state poisoned")?;
    if pending
        .as_ref()
        .is_some_and(|tap| tap.id == id && tap.thread_id == thread_id)
    {
        *pending = None;
    }
    Ok(())
}

#[cfg(test)]
mod execution_tests {
    use super::*;

    #[test]
    fn failure_classification_does_not_depend_on_diagnostic_text() {
        assert!(matches!(
            ExecutionFailure::NotExecuted("uncertain notification: allocation failed".into())
                .into_result(),
            DeliveryResult::NotExecuted,
        ));
        assert!(matches!(
            ExecutionFailure::Rejected("join desktop notification: denied".into()).into_result(),
            DeliveryResult::Rejected,
        ));
        assert!(matches!(
            ExecutionFailure::Uncertain("connection lost".into()).into_result(),
            DeliveryResult::Uncertain,
        ));
    }

    #[test]
    fn preparation_errors_are_not_platform_rejections() {
        assert!(matches!(
            ExecutionFailure::from("owner ended").into_result(),
            DeliveryResult::NotExecuted
        ));
        assert!(matches!(
            ExecutionFailure::from(String::from("invalid coordinates")).into_result(),
            DeliveryResult::NotExecuted
        ));
    }
}

#[cfg(test)]
mod navigation_tests {
    use super::*;

    #[test]
    fn history_observation_requires_the_exact_activation_handle() {
        let instance = uuid::Uuid::new_v4().to_string();
        let launch = format!("soms-notification://thread/7/card/{instance}");
        let card = windows_observed_card(&launch, instance.clone(), "soms-messages".into()).unwrap();
        assert_eq!(card.thread_id, 7);
        assert_eq!(card.notification_id, instance);
        assert_eq!(card.handle, PlatformHandle::Windows { tag: instance.clone(), group: "soms-messages".into() });
        assert!(windows_observed_card(&launch, uuid::Uuid::new_v4().to_string(), "soms-messages".into()).is_err());
        assert!(windows_observed_card(&launch, instance.clone(), "other".into()).is_err());
        assert!(windows_observed_card("soms-notification://thread/7", instance, "soms-messages".into()).is_err());
    }

    #[test]
    fn activation_requires_a_canonical_thread_target() {
        let instance = "550e8400-e29b-41d4-a716-446655440000";
        assert_eq!(
            parse_activation(&format!("soms-notification://thread/7/card/{instance}")),
            Some((7, instance.into()))
        );
        for suffix in ["", "?x=1", "#fragment", "/extra"] {
            let invalid = if suffix.is_empty() {
                "bad".to_owned()
            } else {
                format!("{instance}{suffix}")
            };
            assert_eq!(
                parse_activation(&format!("soms-notification://thread/7/card/{invalid}")),
                None
            );
        }
        for thread in ["0", "07", "-1", "2147483648"] {
            assert_eq!(
                parse_activation(&format!(
                    "soms-notification://thread/{thread}/card/{instance}"
                )),
                None
            );
        }
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
    operation_id: String,
    notification_id: Option<String>,
    previous_handle: Option<super::notifications::delivery::PlatformHandle>,
    thread_id: i32,
    title: String,
    body: String,
    count: i64,
    silent: bool,
}

#[cfg(target_os = "linux")]
mod platform {
    use super::DesktopNotification;
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    struct Card {
        operation_id: String,
        listener: tauri::async_runtime::JoinHandle<()>,
    }

    fn cards() -> &'static Mutex<HashMap<i32, Card>> {
        static CARDS: OnceLock<Mutex<HashMap<i32, Card>>> = OnceLock::new();
        CARDS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub(super) fn update(
        app: tauri::AppHandle,
        input: DesktopNotification,
        owner: std::sync::Arc<crate::login_connection::LoginConnection>,
    ) -> Result<
        Option<super::super::notifications::delivery::PlatformHandle>,
        super::ExecutionFailure,
    > {
        let mut cards = cards().lock().map_err(|_| "notification state poisoned")?;
        let session = super::linux_registry::Session::connect()?;
        let mut registry = session.load()?;
        if input.count == 0 {
            let target = match &input.previous_handle {
                Some(super::super::notifications::delivery::PlatformHandle::Linux {
                    daemon,
                    id,
                }) if daemon == &session.identity() => Some(*id),
                Some(super::super::notifications::delivery::PlatformHandle::Linux { .. }) => None,
                Some(_) => return Err("unexpected Linux notification handle".into()),
                // Startup does not adopt persisted handles: their OS presence is unknown.
                None => None,
            };
            if let Some(id) = target {
                session.close(id)?;
            }
            if let Some(card) = cards.remove(&input.thread_id) {
                card.listener.abort();
            }
            registry.ids.remove(&input.thread_id);
            session.save(&registry);
            return Ok(None);
        }
        let previous_id = match &input.previous_handle {
            Some(super::super::notifications::delivery::PlatformHandle::Linux { daemon, id })
                if daemon == &session.identity() =>
            {
                *id
            }
            Some(super::super::notifications::delivery::PlatformHandle::Linux { .. }) => 0,
            Some(_) => return Err("unexpected Linux notification handle".into()),
            // No accepted handle in this process means a new OS notification.
            None => 0,
        };
        let instance = input
            .notification_id
            .clone()
            .ok_or("missing notification instance")?;
        let signals = session.signals()?;
        // A successful reply from the captured unique daemon establishes acceptance.
        // Later daemon changes or local persistence failures do not undo that fact.
        let handle = session.notify(previous_id, &input.title, &input.body, input.silent)?;
        registry.ids.insert(input.thread_id, handle);
        session.save(&registry);
        let published_handle = super::super::notifications::delivery::PlatformHandle::Linux {
            daemon: session.identity(),
            id: handle,
        };
        let thread_id = input.thread_id;
        let daemon = session.identity();
        let operation_id = input.operation_id.clone();
        let resource_operation = operation_id.clone();
        let listener = session.listen(signals, handle, move |clicked| {
            if clicked {
                super::tapped(&app, thread_id);
            } else {
                if let Ok(mut state) = owner.notification_delivery.lock() {
                    state.dismissed_operation(thread_id, &instance, &operation_id);
                }
                let daemon = daemon.clone();
                let operation = operation_id.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    // Numeric IDs are reusable. Retire only this daemon's exact handle.
                    let Ok(mut resources) = self::cards().lock() else {
                        return;
                    };
                    if !resources
                        .get(&thread_id)
                        .is_some_and(|resource| resource.operation_id == operation)
                    {
                        return;
                    }
                    let Ok(session) = super::linux_registry::Session::connect() else {
                        return;
                    };
                    if session.identity() != daemon {
                        return;
                    }
                    let Ok(mut registry) = session.load() else {
                        return;
                    };
                    if registry.ids.get(&thread_id) == Some(&handle) {
                        registry.ids.remove(&thread_id);
                        session.save(&registry);
                    }
                    resources.remove(&thread_id);
                });
            }
        });
        if let Some(previous) = cards.insert(
            thread_id,
            Card {
                operation_id: resource_operation,
                listener,
            },
        ) {
            previous.listener.abort();
        }
        Ok(Some(published_handle))
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
                error = Some(failure.to_string());
                true
            }
        });
        session.save(&registry);
        error.map_or(Ok(()), Err)
    }
}

#[cfg(target_os = "windows")]
mod windows_platform {
    use super::DesktopNotification;
    use windows::{
        core::HSTRING,
        Data::Xml::Dom::XmlDocument,
        Foundation::TypedEventHandler,
        UI::Notifications::{
            ToastDismissalReason, ToastDismissedEventArgs, ToastNotification,
            ToastNotificationManager,
        },
    };

    const GROUP: &str = "soms-messages";

    pub(super) fn restore_cards(
        app: &tauri::AppHandle,
        owner: std::sync::Arc<crate::login_connection::LoginConnection>,
    ) -> Result<Vec<super::super::notifications::delivery::ObservedCard>, String> {
        let app_id = HSTRING::from(app.config().identifier.as_str());
        let history = ToastNotificationManager::History().map_err(|e| e.to_string())?;
        let items = history.GetHistoryWithId(&app_id).map_err(|e| e.to_string())?;
        let mut cards = Vec::new();
        let mut toasts = std::collections::HashMap::new();
        for index in 0..items.Size().map_err(|e| e.to_string())? {
            let toast = items.GetAt(index).map_err(|e| e.to_string())?;
            let group = toast.Group().map_err(|e| e.to_string())?.to_string();
            if group != GROUP { continue; }
            let tag = toast.Tag().map_err(|e| e.to_string())?.to_string();
            let launch = toast.Content().and_then(|xml| xml.DocumentElement())
                .and_then(|root| root.GetAttribute(&HSTRING::from("launch")))
                .map_err(|e| e.to_string())?.to_string();
            let card = super::windows_observed_card(&launch, tag, group)?;
            toasts.insert(card.notification_id.clone(), toast);
            cards.push(card);
        }
        let (retained, surplus) = super::super::notifications::delivery::select_restored_cards(cards);
        for card in surplus {
            let super::super::notifications::delivery::PlatformHandle::Windows { tag, group } = card.handle else {
                return Err("unexpected Windows notification handle".into());
            };
            history.RemoveGroupedTagWithId(&HSTRING::from(tag), &HSTRING::from(group), &app_id)
                .map_err(|e| e.to_string())?;
        }
        for card in &retained {
            let toast = toasts.remove(&card.notification_id).ok_or("missing captured Windows notification")?;
            let instance = card.notification_id.clone();
            let thread = card.thread_id;
            let observer = owner.clone();
            let dismissed = toast.Dismissed(&TypedEventHandler::<ToastNotification, ToastDismissedEventArgs>::new(move |_, args| {
                if let Some(args) = args.as_ref() {
                    if args.Reason()? == ToastDismissalReason::UserCanceled {
                        if let Ok(mut state) = observer.notification_delivery.lock() {
                            state.dismissed_imported(thread, &instance);
                        }
                    }
                }
                Ok(())
            })).map_err(|e| e.to_string())?;
            let previous = subscriptions().lock().unwrap_or_else(|e| e.into_inner()).insert(
                card.notification_id.clone(), Subscription { toast, dismissed, operation_id: None },
            );
            drop(previous);
        }
        Ok(retained)
    }

    // Retain WinRT event subscriptions only; all card and alert policy stays in Rust's owner.
    struct Subscription {
        toast: ToastNotification,
        dismissed: i64,
        operation_id: Option<String>,
    }
    impl Drop for Subscription {
        fn drop(&mut self) {
            let _ = self.toast.RemoveDismissed(self.dismissed);
        }
    }
    fn subscriptions() -> &'static std::sync::Mutex<std::collections::HashMap<String, Subscription>>
    {
        static SUBSCRIPTIONS: std::sync::OnceLock<
            std::sync::Mutex<std::collections::HashMap<String, Subscription>>,
        > = std::sync::OnceLock::new();
        SUBSCRIPTIONS.get_or_init(Default::default)
    }

    pub(super) fn retire_subscription(instance: &str) {
        let retired = subscriptions()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(instance);
        drop(retired);
    }

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

    pub(super) fn update(
        app: tauri::AppHandle,
        input: DesktopNotification,
        owner: std::sync::Arc<crate::login_connection::LoginConnection>,
    ) -> Result<
        Option<super::super::notifications::delivery::PlatformHandle>,
        super::ExecutionFailure,
    > {
        let handle = if input.count > 0 {
            Some(
                super::super::notifications::delivery::PlatformHandle::Windows {
                    tag: input
                        .notification_id
                        .clone()
                        .ok_or("missing notification instance")?,
                    group: GROUP.into(),
                },
            )
        } else {
            None
        };
        if input.notification_id.is_none() {
            return Ok(None);
        }
        let mut submitted = false;
        update_inner(app, input, owner, &mut submitted).map_err(|error| {
            if submitted {
                super::ExecutionFailure::Uncertain(error.to_string())
            } else {
                super::ExecutionFailure::NotExecuted(error.to_string())
            }
        })?;
        Ok(handle)
    }

    fn update_inner(
        app: tauri::AppHandle,
        input: DesktopNotification,
        owner: std::sync::Arc<crate::login_connection::LoginConnection>,
        submitted: &mut bool,
    ) -> windows::core::Result<()> {
        let app_id = HSTRING::from(app.config().identifier.as_str());
        let (tag, group) = match &input.previous_handle {
            Some(super::super::notifications::delivery::PlatformHandle::Windows { tag, group }) => {
                (HSTRING::from(tag.as_str()), HSTRING::from(group.as_str()))
            }
            _ => (
                HSTRING::from(input.notification_id.as_deref().unwrap_or_default()),
                HSTRING::from(GROUP),
            ),
        };
        if input.count == 0 {
            let history = ToastNotificationManager::History()?;
            *submitted = true;
            history.RemoveGroupedTagWithId(&tag, &group, &app_id)?;
            let retired = subscriptions()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(input.notification_id.as_deref().unwrap_or_default());
            drop(retired);
            return Ok(());
        }
        let activation = format!(
            "soms-notification://thread/{}/card/{}",
            input.thread_id,
            input.notification_id.as_deref().unwrap_or_default()
        );
        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(format!(
            "<toast activationType=\"protocol\" launch=\"{}\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual>{}</toast>",
            xml_text(activation.as_str()), xml_text(&input.title), xml_text(&input.body),
            if input.silent { "<audio silent=\"true\"/>" } else { "" },
        )))?;
        let toast = ToastNotification::CreateToastNotification(&xml)?;
        toast.SetTag(&tag)?;
        toast.SetGroup(&group)?;
        let instance = input.notification_id.clone().unwrap_or_default();
        let callback_instance = instance.clone();
        let thread_id = input.thread_id;
        let operation_id = input.operation_id;
        let resource_operation = operation_id.clone();
        let retired = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let callback_retired = retired.clone();
        let dismissed = toast.Dismissed(&TypedEventHandler::<
            ToastNotification,
            ToastDismissedEventArgs,
        >::new(move |_, args| {
            // A timed-out banner can remain in Action Center. Only an explicit user
            // dismissal establishes that this card has been removed.
            if let Some(args) = args.as_ref() {
                if args.Reason()? == ToastDismissalReason::UserCanceled {
                    callback_retired.store(true, std::sync::atomic::Ordering::Release);
                    if let Ok(mut state) = owner.notification_delivery.lock() {
                        state.dismissed_operation(thread_id, &callback_instance, &operation_id);
                    }
                    let instance = callback_instance.clone();
                    let operation = operation_id.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        let retired = {
                            let mut resources =
                                subscriptions().lock().unwrap_or_else(|e| e.into_inner());
                            if resources
                                .get(&instance)
                                .is_some_and(|r| r.operation_id.as_deref() == Some(operation.as_str()))
                            {
                                resources.remove(&instance)
                            } else {
                                None
                            }
                        };
                        drop(retired);
                    });
                }
            }
            Ok(())
        }))?;
        let subscription = Subscription {
            toast,
            dismissed,
            operation_id: Some(resource_operation),
        };
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&app_id)?;
        *submitted = true;
        notifier.Show(&subscription.toast)?;
        let previous = {
            let mut resources = subscriptions().lock().unwrap_or_else(|e| e.into_inner());
            if retired.load(std::sync::atomic::Ordering::Acquire) {
                // A callback may run inside Show, before resource registration.
                drop(resources);
                drop(subscription);
                return Ok(());
            }
            resources.insert(instance, subscription)
        };
        drop(previous);
        Ok(())
    }

    pub(super) fn clear(app: &tauri::AppHandle) -> Result<(), String> {
        (|| -> windows::core::Result<()> {
            ToastNotificationManager::History()?.RemoveGroupWithId(
                &HSTRING::from(GROUP),
                &HSTRING::from(app.config().identifier.as_str()),
            )?;
            let retired =
                std::mem::take(&mut *subscriptions().lock().unwrap_or_else(|e| e.into_inner()));
            drop(retired);
            Ok(())
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
    deliver_command(
        app,
        work,
        super::notifications::content::NotificationCommand::Remove { thread_id },
    )
    .await
}

/// Native synchronization supplies the captured work and its assembled thread projections.
pub(crate) async fn deliver_batch(
    app: tauri::AppHandle,
    batch: super::notifications::NotificationBatch,
) -> Result<(), String> {
    let work = batch.work.clone().ok_or("notification batch has no captured work")?;
    let observed_app = app.clone();
    super::notifications::runtime::deliver_batch(
        batch,
        true,
        super::notifications::runtime::Platform {
            facts: move || Ok(presentation_facts(&observed_app)),
            execute: move |prepared, _avatars| {
                // Shared orchestration calls adapters on its blocking execution thread.
                Ok(match tauri::async_runtime::block_on(execute_command(
                    app.clone(), work.clone(), prepared,
                )) {
                    Ok(handle) => super::notifications::delivery::DeliveryResult::Accepted { handle },
                    Err(error) => error.into_result(),
                })
            },
        },
    ).await
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
        focused: window
            .as_ref()
            .is_some_and(|window| window.is_focused().unwrap_or(false)),
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
    {
        use super::notifications::{
            alert::AlertPolicy,
            delivery::{self, DeliveryResult},
        };
        let policy = super::preferences::read_notification_preference("notificationAlertPolicy")?;
        let policy = AlertPolicy::from_preference(policy.as_deref())?;
        let observed_app = app.clone();
        delivery::deliver(
            work.clone(),
            command,
            policy,
            true,
            move || Ok(presentation_facts(&observed_app)),
            move |prepared| async move {
                Ok(match execute_command(app, work, prepared).await {
                    Ok(handle) => DeliveryResult::Accepted { handle },
                    Err(error) => error.into_result(),
                })
            },
        )
        .await
    }
}

async fn execute_command(
    app: tauri::AppHandle,
    work: crate::login_connection::DatabaseWork,
    prepared: super::notifications::delivery::PreparedDelivery,
) -> Result<Option<PlatformHandle>, ExecutionFailure> {
    use super::notifications::content::NotificationCommand;
    let notification_id = prepared.notification_id;
    #[cfg(target_os = "macos")]
    let notification_id = match &prepared.previous_handle {
        Some(super::notifications::delivery::PlatformHandle::Macos { identifier }) => {
            Some(identifier.clone())
        }
        Some(_) => return Err("unexpected macOS notification handle".into()),
        None => notification_id.as_deref().map(macos_platform::identifier),
    };
    let request = match prepared.command {
        NotificationCommand::Remove { thread_id } => DesktopNotification {
            operation_id: prepared.operation_id,
            previous_handle: prepared.previous_handle,
            notification_id,
            thread_id,
            title: String::new(),
            body: String::new(),
            count: 0,
            silent: true,
        },
        NotificationCommand::Show(content) => DesktopNotification {
            operation_id: prepared.operation_id,
            previous_handle: prepared.previous_handle,
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
) -> Result<Option<PlatformHandle>, ExecutionFailure> {
    if notification.thread_id <= 0 || notification.count < 0 {
        return Err("invalid desktop notification coordinates".into());
    }
    work.assert_current().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    if notification.count > 0 {
        macos_platform::authorize().await?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        work.assert_current().map_err(|e| e.to_string())?;
        #[cfg(target_os = "linux")]
        {
            platform::update(app, notification, work.owner().clone())
        }
        #[cfg(target_os = "windows")]
        {
            windows_platform::update(app, notification, work.owner().clone())
        }
        #[cfg(target_os = "macos")]
        {
            let _ = app;
            let handle = if notification.count > 0 {
                Some(super::notifications::delivery::PlatformHandle::Macos {
                    identifier: notification
                        .notification_id
                        .clone()
                        .ok_or("missing notification instance")?,
                })
            } else {
                None
            };
            macos_platform::update(notification)?;
            Ok(handle)
        }
    })
    .await
    .map_err(|error| ExecutionFailure::Uncertain(format!("join desktop notification: {error}")))?
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
