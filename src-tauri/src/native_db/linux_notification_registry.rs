use super::ExecutionFailure;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const SERVICE: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";
const KEY: &str = "linux-message-notifications";

fn submission_failure(error: zbus::Error) -> ExecutionFailure {
    // The bus can report a missing reply as a method error even after the daemon
    // executed the request. Only a definite failure reply establishes rejection.
    match &error {
        zbus::Error::MethodError(name, ..)
            if !matches!(
                name.as_str(),
                "org.freedesktop.DBus.Error.NoReply"
                    | "org.freedesktop.DBus.Error.Timeout"
                    | "org.freedesktop.DBus.Error.TimedOut"
                    | "org.freedesktop.DBus.Error.Disconnected"
            ) =>
        {
            ExecutionFailure::Rejected(error.to_string())
        }
        _ => ExecutionFailure::Uncertain(error.to_string()),
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub(super) struct Registry {
    bus: String,
    owner: String,
    pub(super) ids: BTreeMap<i32, u32>,
}

// Once loaded, live handles are authoritative for this process. A failed disk
// write must not make a later operation reload an already-retired handle.
#[derive(Default)]
struct RegistryCache(Option<Registry>);

impl RegistryCache {
    fn load(
        &mut self,
        read: impl FnOnce() -> Result<Registry, String>,
    ) -> Result<Registry, String> {
        if let Some(registry) = &self.0 {
            return Ok(registry.clone());
        }
        let registry = read()?;
        self.0 = Some(registry.clone());
        Ok(registry)
    }

    fn save(
        &mut self,
        registry: &Registry,
        write: impl FnOnce(&Registry) -> Result<(), String>,
    ) -> Result<(), String> {
        self.0 = Some(registry.clone());
        write(registry)
    }
}

#[cfg(test)]
mod tests {
    use super::{submission_failure, ExecutionFailure, Registry, RegistryCache};

    #[test]
    fn bus_generated_missing_reply_errors_do_not_prove_rejection() {
        for name in [
            "org.freedesktop.DBus.Error.NoReply",
            "org.freedesktop.DBus.Error.Timeout",
            "org.freedesktop.DBus.Error.TimedOut",
            "org.freedesktop.DBus.Error.Disconnected",
        ] {
            assert!(matches!(
                submission_failure(method_error(name)),
                ExecutionFailure::Uncertain(_)
            ));
        }
        assert!(matches!(
            submission_failure(method_error("org.freedesktop.DBus.Error.AccessDenied")),
            ExecutionFailure::Rejected(_)
        ));
    }

    fn method_error(name: &str) -> zbus::Error {
        let message =
            zbus::message::Message::method_call("/org/freedesktop/Notifications", "Notify")
                .unwrap()
                .build(&())
                .unwrap();
        zbus::Error::MethodError(name.try_into().unwrap(), None, message)
    }

    #[test]
    fn failed_delete_persistence_does_not_reload_retired_handle() {
        let mut cache = RegistryCache::default();
        let mut registry = Registry::default();
        registry.ids.insert(7, 42);
        cache.load(|| Ok(registry.clone())).unwrap();
        registry.ids.remove(&7);
        assert!(cache
            .save(&registry, |_| Err("disk unavailable".into()))
            .is_err());
        let live = cache
            .load(|| panic!("must not reload stale disk state"))
            .unwrap();
        assert!(!live.ids.contains_key(&7));
        cache
            .save(&live, |saved| {
                assert!(saved.ids.is_empty());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn failed_show_persistence_keeps_the_accepted_platform_handle() {
        let mut cache = RegistryCache::default();
        let mut registry = Registry::default();
        registry.ids.insert(7, 42);
        assert!(cache
            .save(&registry, |_| Err("disk unavailable".into()))
            .is_err());
        let mut live = cache.load(|| panic!("must use accepted handle")).unwrap();
        assert_eq!(live.ids.get(&7), Some(&42));
        live.ids.insert(8, 43);
        cache
            .save(&live, |saved| {
                assert_eq!(saved.ids.get(&7), Some(&42));
                assert_eq!(saved.ids.get(&8), Some(&43));
                Ok(())
            })
            .unwrap();
    }
}

fn cache() -> &'static std::sync::Mutex<RegistryCache> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<RegistryCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

pub(super) struct Session {
    connection: zbus::blocking::Connection,
    bus: String,
    owner: String,
}

impl Session {
    pub(super) fn connect() -> Result<Self, String> {
        let connection = zbus::blocking::Connection::session().map_err(|e| e.to_string())?;
        let proxy = zbus::blocking::Proxy::new(&connection, SERVICE, PATH, SERVICE)
            .map_err(|e| e.to_string())?;
        // Activate the service before resolving its unique owner. Version/name alone are not an identity.
        let _: (String, String, String, String) = proxy
            .call("GetServerInformation", &())
            .map_err(|e| e.to_string())?;
        let dbus = zbus::blocking::fdo::DBusProxy::new(&connection).map_err(|e| e.to_string())?;
        let bus = dbus.get_id().map_err(|e| e.to_string())?.to_string();
        let owner = dbus
            .get_name_owner(
                SERVICE
                    .try_into()
                    .map_err(|e: zbus::names::Error| e.to_string())?,
            )
            .map_err(|e| e.to_string())?
            .to_string();
        Ok(Self {
            connection,
            bus,
            owner,
        })
    }

    pub(super) fn notify(
        &self,
        replaces: u32,
        title: &str,
        body: &str,
        silent: bool,
    ) -> Result<u32, ExecutionFailure> {
        let proxy =
            zbus::blocking::Proxy::new(&self.connection, self.owner.as_str(), PATH, SERVICE)
                .map_err(|e| e.to_string())?;
        let hints = std::collections::HashMap::from([(
            "suppress-sound",
            zbus::zvariant::Value::from(silent),
        )]);
        proxy
            .call(
                "Notify",
                &(
                    "SOMS",
                    replaces,
                    "",
                    title,
                    body,
                    vec!["default", ""],
                    hints,
                    -1i32,
                ),
            )
            .map_err(submission_failure)
    }

    /// Install the signal match before Notify, so an immediate close is not lost.
    pub(super) fn signals(&self) -> Result<zbus::proxy::SignalStream<'static>, String> {
        tauri::async_runtime::block_on(async {
            let proxy =
                zbus::Proxy::new(self.connection.inner(), self.owner.as_str(), PATH, SERVICE)
                    .await?;
            proxy.receive_all_signals().await
        })
        .map_err(|e| e.to_string())
    }

    pub(super) fn listen(
        &self,
        mut signals: zbus::proxy::SignalStream<'static>,
        id: u32,
        mut observation: impl FnMut(bool) + Send + 'static,
    ) -> tauri::async_runtime::JoinHandle<()> {
        tauri::async_runtime::spawn(async move {
            use futures_util::StreamExt;
            while let Some(signal) = signals.next().await {
                match signal.header().member().map(|member| member.as_str()) {
                    Some("ActionInvoked") => {
                        if let Ok((target, action)) = signal.body().deserialize::<(u32, String)>() {
                            if target == id && action == "default" {
                                observation(true);
                            }
                        }
                    }
                    Some("NotificationClosed") => {
                        if let Ok((target, _reason)) = signal.body().deserialize::<(u32, u32)>() {
                            if target == id {
                                observation(false);
                                break;
                            }
                        }
                    }
                    _ => {}
                }
            }
        })
    }

    pub(super) fn identity(&self) -> String {
        format!("{}/{}", self.bus, self.owner)
    }

    pub(super) fn load(&self) -> Result<Registry, String> {
        let mut registry = cache().lock().unwrap_or_else(|e| e.into_inner()).load(|| {
            let value = tauri::async_runtime::block_on(
                super::super::preferences::native_db_get_preference("device".into(), KEY.into()),
            )?;
            value
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| format!("notification registry: {e}"))
                .map(Option::unwrap_or_default)
        })?;
        if registry.bus != self.bus || registry.owner != self.owner {
            registry = Registry {
                bus: self.bus.clone(),
                owner: self.owner.clone(),
                ids: BTreeMap::new(),
            };
        }
        Ok(registry)
    }

    /// Persist bookkeeping separately from the already-accepted OS operation.
    /// Keep the live snapshot even on failure; subsequent writes retry the full snapshot.
    pub(super) fn save(&self, registry: &Registry) {
        let result = cache()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .save(registry, |registry| {
                tauri::async_runtime::block_on(super::super::preferences::native_db_put_preference(
                    "device".into(),
                    KEY.into(),
                    serde_json::to_value(registry).map_err(|e| e.to_string())?,
                ))
            });
        if let Err(error) = result {
            log::warn!("notification registry persistence failed; live handles retained: {error}");
        }
    }

    pub(super) fn close(&self, id: u32) -> Result<(), ExecutionFailure> {
        // Address the recorded unique owner, never a replacement notification daemon.
        let proxy =
            zbus::blocking::Proxy::new(&self.connection, self.owner.as_str(), PATH, SERVICE)
                .map_err(|e| e.to_string())?;
        proxy
            .call::<_, _, ()>("CloseNotification", &(id))
            .map_err(submission_failure)
    }
}
