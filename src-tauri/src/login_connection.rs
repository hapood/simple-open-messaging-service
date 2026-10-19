use crate::login_session_store::LoginSessionId;
use rusqlite::Connection;
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc, Mutex,
};
use tokio_util::sync::CancellationToken;

const PREPARING: u8 = 0;
const ACTIVATING: u8 = 1;
const ACTIVE: u8 = 2;
const ENDED: u8 = 3;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ConnectionError {
    Superseded,
    NotActive,
    ActivationInProgress,
    EmptyCredential,
    Closed,
    CacheReset,
    Poisoned,
    Operation(String),
}

impl std::fmt::Display for ConnectionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Superseded => f.write_str("native login superseded"),
            Self::NotActive => f.write_str("native login is not active"),
            Self::ActivationInProgress => f.write_str("native login activation already started"),
            Self::EmptyCredential => f.write_str("empty native login credential"),
            Self::Closed => f.write_str("native login connection is closed"),
            Self::CacheReset => f.write_str("native cache work superseded"),
            Self::Poisoned => f.write_str("native login connection lock poisoned"),
            Self::Operation(error) => f.write_str(error),
        }
    }
}

impl std::error::Error for ConnectionError {}

/// One login's immutable resource owner. Created only at a lifecycle initialization boundary;
/// ordinary operations receive an Arc captured at intent time, never a path or an opener.
///
/// Database and credential locks are separate: ending admission never waits for SQLite I/O.
/// Network work holds the owner, not a database lock. The physical connection is never replaced.
pub(crate) struct LoginConnection {
    id: LoginSessionId,
    phase: AtomicU8,
    cancellation: CancellationToken,
    cache_work: Mutex<CancellationToken>,
    database: Mutex<Option<Connection>>,
    credential: Mutex<Option<String>>,
}

impl LoginConnection {
    /// Consumes the single physical connection initialized for this UUID. No opener is retained,
    /// so neither an operation nor an old Arc can reopen a closed database.
    pub(crate) fn preparing(id: LoginSessionId, database: Connection) -> Arc<Self> {
        let cancellation = CancellationToken::new();
        Arc::new(Self {
            id,
            phase: AtomicU8::new(PREPARING),
            cache_work: Mutex::new(cancellation.child_token()),
            cancellation,
            database: Mutex::new(Some(database)),
            credential: Mutex::new(None),
        })
    }

    pub(crate) fn id(&self) -> &LoginSessionId {
        &self.id
    }

    pub(crate) fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    /// Cache/schema maintenance has a separate cancellation domain. It never changes login UUID,
    /// credential or physical connection, and is not advanced by token installation.
    pub(crate) fn capture_database_work(self: &Arc<Self>) -> Result<DatabaseWork, ConnectionError> {
        self.assert_active()?;
        let cancellation = self
            .cache_work
            .lock()
            .map_err(|_| ConnectionError::Poisoned)?
            .clone();
        let work = DatabaseWork {
            owner: self.clone(),
            cancellation,
        };
        work.assert_current()?;
        Ok(work)
    }

    pub(crate) fn invalidate_database_work(&self) -> Result<(), ConnectionError> {
        let mut work = self
            .cache_work
            .lock()
            .map_err(|_| ConnectionError::Poisoned)?;
        work.cancel();
        *work = self.cancellation.child_token();
        Ok(())
    }

    pub(crate) fn assert_active(&self) -> Result<(), ConnectionError> {
        match self.phase.load(Ordering::Acquire) {
            ACTIVE => Ok(()),
            ENDED => Err(ConnectionError::Superseded),
            _ => Err(ConnectionError::NotActive),
        }
    }

    /// Carry this permit through journal activation and platform work without holding a lifecycle
    /// mutex. A durable activation's completion cannot reactivate an owner ended in the meantime.
    pub(crate) fn begin_activation(self: &Arc<Self>) -> Result<ActivationPermit, ConnectionError> {
        self.phase
            .compare_exchange(PREPARING, ACTIVATING, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|phase| {
                if phase == ENDED {
                    ConnectionError::Superseded
                } else {
                    ConnectionError::ActivationInProgress
                }
            })?;
        Ok(ActivationPermit {
            owner: self.clone(),
            committed: false,
        })
    }

    /// Explicit cache initialization/validation only. Preparing owners admit no business work, but
    /// lifecycle restoration must validate their schema before credential activation.
    pub(crate) fn with_initialization_database<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, ConnectionError> {
        let check = || {
            if self.phase.load(Ordering::Acquire) == ENDED {
                Err(ConnectionError::Superseded)
            } else {
                Ok(())
            }
        };
        check()?;
        let mut database = self
            .database
            .lock()
            .map_err(|_| ConnectionError::Poisoned)?;
        check()?;
        let result = operation(database.as_mut().ok_or(ConnectionError::Closed)?);
        check()?;
        result.map_err(ConnectionError::Operation)
    }

    /// Execute against the already-owned physical connection. The callback cannot retain a borrowed
    /// SQLite reference. Check again after obtaining the lock, since the operation may have queued
    /// behind another transaction while logout ended admission.
    pub(crate) fn with_database<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, ConnectionError> {
        self.assert_active()?;
        let mut database = self
            .database
            .lock()
            .map_err(|_| ConnectionError::Poisoned)?;
        self.assert_active()?;
        let result = operation(database.as_mut().ok_or(ConnectionError::Closed)?);
        // A transaction admitted before end may finish on its original database, but cannot publish
        // a successful result after end. Closing drains it before fresh-login cache deletion.
        self.assert_active()?;
        result.map_err(ConnectionError::Operation)
    }

    pub(crate) fn credential(&self) -> Result<String, ConnectionError> {
        self.assert_active()?;
        let credential = self
            .credential
            .lock()
            .map_err(|_| ConnectionError::Poisoned)?;
        self.assert_active()?;
        credential.clone().ok_or(ConnectionError::NotActive)
    }

    /// Synchronous, irreversible cancellation. No SQLite or platform operation runs here.
    /// Clears the owner-held credential; repeated end calls are idempotent.
    pub(crate) fn end(&self) -> Result<(), ConnectionError> {
        self.phase.store(ENDED, Ordering::Release);
        self.cancellation.cancel();
        self.credential
            .lock()
            .map_err(|_| ConnectionError::Poisoned)?
            .take();
        Ok(())
    }

    /// Resource release only: never deletes a file. Run off the UI/runtime executor, after end.
    /// A failed close retains the connection for retry without restoring admission.
    pub(crate) fn close(&self) -> Result<(), ConnectionError> {
        if self.phase.load(Ordering::Acquire) != ENDED {
            return Err(ConnectionError::NotActive);
        }
        let mut database = self
            .database
            .lock()
            .map_err(|_| ConnectionError::Poisoned)?;
        if let Some(connection) = database.take() {
            if let Err((connection, error)) = connection.close() {
                *database = Some(connection);
                return Err(ConnectionError::Operation(format!(
                    "close native login database: {error}"
                )));
            }
        }
        Ok(())
    }
}

/// A captured view of one login's cache. A deliberate repair cancels the old view while retaining
/// the login owner; ending the login cancels all views through the parent token.
#[derive(Clone)]
pub(crate) struct DatabaseWork {
    owner: Arc<LoginConnection>,
    cancellation: CancellationToken,
}

impl DatabaseWork {
    pub(crate) fn owner(&self) -> &Arc<LoginConnection> {
        &self.owner
    }

    pub(crate) fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub(crate) fn assert_current(&self) -> Result<(), ConnectionError> {
        self.owner.assert_active()?;
        if self.cancellation.is_cancelled() {
            return Err(ConnectionError::CacheReset);
        }
        Ok(())
    }

    pub(crate) fn with_database<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, ConnectionError> {
        self.assert_current()?;
        let result = self.owner.with_database(|conn| {
            self.assert_current().map_err(|e| e.to_string())?;
            operation(conn)
        });
        self.assert_current()?;
        result
    }
}

pub(crate) struct ActivationPermit {
    owner: Arc<LoginConnection>,
    committed: bool,
}

impl ActivationPermit {
    pub(crate) fn commit(mut self, token: String) -> Result<(), ConnectionError> {
        if token.is_empty() {
            return Err(ConnectionError::EmptyCredential);
        }
        let mut credential = self
            .owner
            .credential
            .lock()
            .map_err(|_| ConnectionError::Poisoned)?;
        if self.owner.phase.load(Ordering::Acquire) == ENDED {
            return Err(ConnectionError::Superseded);
        }
        *credential = Some(token);
        if self
            .owner
            .phase
            .compare_exchange(ACTIVATING, ACTIVE, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            *credential = None;
            return Err(ConnectionError::Superseded);
        }
        self.committed = true;
        Ok(())
    }
}

impl Drop for ActivationPermit {
    fn drop(&mut self) {
        if !self.committed {
            // Persistence failure permits a retry on this preparation, but never reverses end.
            let _ = self.owner.phase.compare_exchange(
                ACTIVATING,
                PREPARING,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn preparing() -> Arc<LoginConnection> {
        let database = Connection::open_in_memory().unwrap();
        database
            .execute_batch("CREATE TABLE entries(value TEXT NOT NULL);")
            .unwrap();
        let id = LoginSessionId::try_from(uuid::Uuid::new_v4().to_string()).unwrap();
        LoginConnection::preparing(id, database)
    }

    fn active(token: &str) -> Arc<LoginConnection> {
        let conn = preparing();
        conn.begin_activation()
            .unwrap()
            .commit(token.into())
            .unwrap();
        conn
    }

    #[test]
    fn preparation_cannot_admit_business_operations_or_credentials() {
        let conn = preparing();
        assert_eq!(
            conn.with_database(|_| Ok(())).unwrap_err(),
            ConnectionError::NotActive
        );
        assert_eq!(conn.credential().unwrap_err(), ConnectionError::NotActive);
        assert_eq!(conn.close().unwrap_err(), ConnectionError::NotActive);
    }

    #[test]
    fn initialization_uses_the_same_connection_without_admitting_business_work() {
        let conn = preparing();
        conn.with_initialization_database(|db| {
            db.execute_batch("CREATE TEMP TABLE proof(value INTEGER); INSERT INTO proof VALUES(9);")
                .map_err(|e| e.to_string())
        })
        .unwrap();
        assert_eq!(
            conn.with_database(|_| Ok(())).unwrap_err(),
            ConnectionError::NotActive
        );
        conn.begin_activation()
            .unwrap()
            .commit("token".into())
            .unwrap();
        let value = conn
            .with_database(|db| {
                db.query_row("SELECT value FROM proof", [], |row| row.get::<_, i64>(0))
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(value, 9);
        conn.end().unwrap();
        assert_eq!(
            conn.with_initialization_database(|_| Ok(())).unwrap_err(),
            ConnectionError::Superseded
        );
    }

    #[test]
    fn cache_reset_cancels_old_work_without_changing_login_or_connection() {
        let owner = active("same-token");
        owner
            .with_database(|conn| {
                conn.execute_batch("CREATE TEMP TABLE retained(value INTEGER);")
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        let old = owner.capture_database_work().unwrap();
        owner.invalidate_database_work().unwrap();
        assert!(old.cancellation().is_cancelled());
        assert_eq!(
            old.with_database(|_| Ok(())).unwrap_err(),
            ConnectionError::CacheReset
        );
        assert_eq!(owner.credential().unwrap(), "same-token");
        assert!(!owner.cancellation().is_cancelled());
        let next = owner.capture_database_work().unwrap();
        next.with_database(|conn| {
            conn.execute("INSERT INTO retained VALUES(1)", [])
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
        .unwrap();
        owner.end().unwrap();
        assert!(next.cancellation().is_cancelled());
        owner.invalidate_database_work().unwrap();
        assert!(matches!(
            owner.capture_database_work(),
            Err(ConnectionError::Superseded)
        ));
    }

    #[test]
    fn all_operations_use_the_same_physical_connection() {
        let conn = active("original");
        conn.with_database(|db| {
            db.execute("INSERT INTO entries VALUES('one')", [])
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
        .unwrap();
        let count: i64 = conn
            .with_database(|db| {
                db.query_row("SELECT COUNT(*) FROM entries", [], |row| row.get(0))
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(conn.credential().unwrap(), "original");
    }

    #[test]
    fn late_activation_cannot_revive_an_ended_connection() {
        let conn = preparing();
        let permit = conn.begin_activation().unwrap();
        conn.end().unwrap();
        assert_eq!(
            permit.commit("late-token".into()).unwrap_err(),
            ConnectionError::Superseded
        );
        assert_eq!(
            conn.assert_active().unwrap_err(),
            ConnectionError::Superseded
        );
        conn.end().unwrap();
        conn.close().unwrap();
    }

    #[test]
    fn failed_activation_retries_without_replacing_the_connection() {
        let conn = preparing();
        let permit = conn.begin_activation().unwrap();
        assert!(matches!(
            conn.begin_activation(),
            Err(ConnectionError::ActivationInProgress)
        ));
        drop(permit);
        assert_eq!(
            conn.begin_activation()
                .unwrap()
                .commit(String::new())
                .unwrap_err(),
            ConnectionError::EmptyCredential
        );
        conn.begin_activation()
            .unwrap()
            .commit("retry".into())
            .unwrap();
        assert_eq!(conn.credential().unwrap(), "retry");
    }

    #[test]
    fn end_takes_only_the_original_credential_once_and_never_touches_a_successor() {
        let old = active("old-token");
        assert_eq!(old.credential().unwrap(), "old-token");
        old.end().unwrap();
        old.close().unwrap();
        let next = active("new-token");
        // The slot is emptied by the first end; a repeated end cannot mint another copy.
        assert!(old.credential().is_err());
        old.end().unwrap();
        assert!(old.cancellation().is_cancelled());
        assert!(!next.cancellation().is_cancelled());
        assert_eq!(next.credential().unwrap(), "new-token");
        assert_eq!(
            old.with_database::<()>(|_| panic!("ended database must not be entered"))
                .unwrap_err(),
            ConnectionError::Superseded
        );
        assert!(next.assert_active().is_ok());
        old.close().unwrap();
    }

    #[test]
    fn end_does_not_wait_for_sql_and_an_old_transaction_cannot_publish_success() {
        let conn = active("original");
        let operation = conn.clone();
        let (entered, ready) = mpsc::channel();
        let (release, blocked) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            operation.with_database(|db| {
                entered.send(()).unwrap();
                blocked.recv().unwrap();
                db.execute("INSERT INTO entries VALUES('old')", [])
                    .map_err(|e| e.to_string())?;
                Ok(())
            })
        });
        ready.recv().unwrap();
        // The SQL callback is still blocked. End must not acquire its database lock.
        assert_eq!(conn.credential().unwrap(), "original");
        conn.end().unwrap();
        assert!(conn.cancellation().is_cancelled());
        release.send(()).unwrap();
        assert_eq!(
            worker.join().unwrap().unwrap_err(),
            ConnectionError::Superseded
        );
        conn.close().unwrap();
    }

    #[tokio::test]
    async fn a_queued_operation_carries_its_original_connection_not_the_successor() {
        let original = active("old-token");
        // Hold only the SQL lock: the queued task cannot execute its callback yet.
        let database = original.database.lock().unwrap();
        let queued = {
            let original = original.clone();
            tauri::async_runtime::spawn_blocking(move || {
                original.with_database(|db| {
                    db.execute("INSERT INTO entries VALUES('obsolete')", [])
                        .map_err(|e| e.to_string())?;
                    Ok(())
                })
            })
        };
        original.end().unwrap();
        drop(database);
        original.close().unwrap();
        let successor = active("new-token");
        assert_eq!(
            queued.await.unwrap().unwrap_err(),
            ConnectionError::Superseded
        );
        let count: i64 = successor
            .with_database(|db| {
                db.query_row("SELECT COUNT(*) FROM entries", [], |row| row.get(0))
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(count, 0);
        assert_eq!(successor.credential().unwrap(), "new-token");
    }

    #[test]
    fn release_retains_the_uuid_file_until_explicit_fresh_login_cleanup() {
        let directory = tempfile::tempdir().unwrap();
        let id = LoginSessionId::try_from(uuid::Uuid::new_v4().to_string()).unwrap();
        let path = directory.path().join(id.sqlite_filename());
        let conn = LoginConnection::preparing(id, Connection::open(&path).unwrap());
        conn.begin_activation()
            .unwrap()
            .commit("token".into())
            .unwrap();
        conn.end().unwrap();
        conn.close().unwrap();
        assert!(path.exists());
        assert_eq!(
            conn.with_database(|_| Ok(())).unwrap_err(),
            ConnectionError::Superseded
        );
        assert!(path.exists());
    }
}
