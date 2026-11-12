use crate::login_connection::LoginConnection;
use crate::login_session_store::LoginSessionId;
use rusqlite::Connection;
use std::sync::{Arc, Mutex};

/// The slot publishes existing owners; it never opens a database. Explicit lifecycle callers
/// serialize initialization and replacement with the cache replacement fence.
pub(super) struct LoginConnections(Mutex<Option<Arc<LoginConnection>>>);

impl LoginConnections {
    pub(super) const fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub(super) fn current(&self) -> Result<Option<Arc<LoginConnection>>, String> {
        Ok(self
            .0
            .lock()
            .map_err(|_| "login connection slot poisoned")?
            .clone())
    }

    pub(super) fn capture(&self) -> Result<Arc<LoginConnection>, String> {
        let owner = self
            .current()?
            .ok_or("no native login connection initialized")?;
        owner.assert_active().map_err(|e| e.to_string())?;
        Ok(owner)
    }

    pub(super) fn install(
        &self,
        id: LoginSessionId,
        database: Connection,
    ) -> Result<Arc<LoginConnection>, String> {
        self.install_restoring(id, Some(database))
    }

    pub(super) fn install_restoring(
        &self,
        id: LoginSessionId,
        database: Option<Connection>,
    ) -> Result<Arc<LoginConnection>, String> {
        let mut slot = self
            .0
            .lock()
            .map_err(|_| "login connection slot poisoned")?;
        if slot.is_some() {
            return Err("release the previous login connection before initialization".into());
        }
        let owner = LoginConnection::restoring(id, database);
        *slot = Some(owner.clone());
        Ok(owner)
    }

    /// Called after synchronous end, off the runtime executor. No slot lock is held while SQL
    /// drains. A close failure leaves the ended owner installed for an explicit retry.
    pub(super) fn release(&self, owner: &Arc<LoginConnection>) -> Result<(), String> {
        // The existing credential/notification cleanup follows owner release. Drain
        // submitted platform commands first so none can publish after that cleanup.
        let _notifications = match owner.notification_delivery_lane.try_lock() {
            Ok(lane) => lane,
            Err(_) if tokio::runtime::Handle::try_current().is_ok() => {
                return Err("notification delivery must drain off the async executor".into());
            }
            Err(_) => owner.notification_delivery_lane.blocking_lock(),
        };
        owner.close().map_err(|e| e.to_string())?;
        let mut slot = self
            .0
            .lock()
            .map_err(|_| "login connection slot poisoned")?;
        if slot
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, owner))
        {
            *slot = None;
        }
        Ok(())
    }
}

pub(super) static LOGIN_CONNECTIONS: LoginConnections = LoginConnections::new();

#[cfg(test)]
mod tests {
    use super::*;

    fn install(slot: &LoginConnections) -> Arc<LoginConnection> {
        let id = LoginSessionId::try_from(uuid::Uuid::new_v4().to_string()).unwrap();
        let owner = slot
            .install(id, Connection::open_in_memory().unwrap())
            .unwrap();
        owner
            .begin_activation()
            .unwrap()
            .commit("credential".into())
            .unwrap();
        owner
    }

    #[test]
    fn capture_reuses_owner_and_late_release_cannot_remove_successor() {
        let slot = LoginConnections::new();
        assert!(slot.capture().is_err());
        let old = install(&slot);
        assert!(Arc::ptr_eq(&old, &slot.capture().unwrap()));
        old.end().unwrap();
        assert!(slot.capture().is_err());
        slot.release(&old).unwrap();
        let next = install(&slot);
        slot.release(&old).unwrap();
        assert!(Arc::ptr_eq(&next, &slot.capture().unwrap()));
        assert!(old.credential().is_err());
    }

    #[tokio::test]
    async fn release_waits_for_submitted_notification_before_removing_owner() {
        let slot = std::sync::Arc::new(LoginConnections::new());
        let old = install(&slot);
        let in_flight = old.notification_delivery_lane.lock().await;
        old.end().unwrap();
        // A runtime caller must never block its executor while the operation drains.
        assert!(slot.release(&old).is_err());
        assert!(slot.current().unwrap().is_some());
        let releasing_slot = slot.clone();
        let releasing_owner = old.clone();
        let released = tokio::task::spawn_blocking(move || releasing_slot.release(&releasing_owner));
        drop(in_flight);
        released.await.unwrap().unwrap();
        assert!(slot.current().unwrap().is_none());
    }

    #[test]
    fn replacement_cannot_displace_an_owner_before_release() {
        let slot = LoginConnections::new();
        let old = install(&slot);
        let id = LoginSessionId::try_from(uuid::Uuid::new_v4().to_string()).unwrap();
        assert!(slot
            .install(id, Connection::open_in_memory().unwrap())
            .is_err());
        assert!(slot.release(&old).is_err());
        assert!(Arc::ptr_eq(&old, &slot.capture().unwrap()));
    }
}
