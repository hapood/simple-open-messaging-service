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
        let mut slot = self
            .0
            .lock()
            .map_err(|_| "login connection slot poisoned")?;
        if slot.is_some() {
            return Err("release the previous login connection before initialization".into());
        }
        let owner = LoginConnection::preparing(id, database);
        *slot = Some(owner.clone());
        Ok(owner)
    }

    /// Called after synchronous end, off the runtime executor. No slot lock is held while SQL
    /// drains. A close failure leaves the ended owner installed for an explicit retry.
    pub(super) fn release(&self, owner: &Arc<LoginConnection>) -> Result<(), String> {
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
