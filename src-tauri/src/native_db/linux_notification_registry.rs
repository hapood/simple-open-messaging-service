use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const SERVICE: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";
const KEY: &str = "linux-message-notifications";

#[derive(Default, Serialize, Deserialize)]
pub(super) struct Registry {
    bus: String,
    owner: String,
    pub(super) ids: BTreeMap<i32, u32>,
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

    pub(super) fn load(&self) -> Result<Registry, String> {
        let value = tauri::async_runtime::block_on(
            super::super::preferences::native_db_get_preference("device".into(), KEY.into()),
        )?;
        let mut registry: Registry = value
            .map(serde_json::from_value)
            .transpose()
            .map_err(|e| format!("notification registry: {e}"))?
            .unwrap_or_default();
        if registry.bus != self.bus || registry.owner != self.owner {
            registry = Registry {
                bus: self.bus.clone(),
                owner: self.owner.clone(),
                ids: BTreeMap::new(),
            };
        }
        Ok(registry)
    }

    pub(super) fn save(&self, registry: &Registry) -> Result<(), String> {
        tauri::async_runtime::block_on(super::super::preferences::native_db_put_preference(
            "device".into(),
            KEY.into(),
            serde_json::to_value(registry).map_err(|e| e.to_string())?,
        ))
    }

    pub(super) fn unchanged(&self) -> Result<bool, String> {
        let dbus =
            zbus::blocking::fdo::DBusProxy::new(&self.connection).map_err(|e| e.to_string())?;
        Ok(dbus
            .get_name_owner(
                SERVICE
                    .try_into()
                    .map_err(|e: zbus::names::Error| e.to_string())?,
            )
            .map_err(|e| e.to_string())?
            .as_str()
            == self.owner)
    }

    pub(super) fn close(&self, id: u32) -> Result<(), String> {
        // Address the recorded unique owner, never a replacement notification daemon.
        let proxy =
            zbus::blocking::Proxy::new(&self.connection, self.owner.as_str(), PATH, SERVICE)
                .map_err(|e| e.to_string())?;
        proxy
            .call::<_, _, ()>("CloseNotification", &(id))
            .map_err(|e| e.to_string())
    }
}
