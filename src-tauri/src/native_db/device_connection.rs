use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

struct Initialized {
    path: PathBuf,
    connection: Connection,
}

/// The process-scoped device database. Its SQL resource lock protects initialization and SQL only;
/// callers capture a reference before scheduling and never hold this lock over network waits.
/// Ordinary access cannot create or reopen the physical connection.
pub(crate) struct DeviceConnection {
    initialized: AtomicBool,
    database: Mutex<Option<Initialized>>,
}

impl DeviceConnection {
    pub(crate) const fn new() -> Self {
        Self {
            initialized: AtomicBool::new(false),
            database: Mutex::new(None),
        }
    }

    /// Explicit application initialization only. A failed initialization is retryable; a successful
    /// initialization is idempotent and cannot switch files or establish another connection.
    pub(crate) fn initialize(&self, path: &Path) -> Result<(), String> {
        if !path.is_absolute() {
            return Err("device database path must be absolute".into());
        }
        let mut database = self
            .database
            .lock()
            .map_err(|_| "device database lock poisoned")?;
        if let Some(initialized) = database.as_ref() {
            return if initialized.path == path {
                Ok(())
            } else {
                Err("device database already initialized with a different file".into())
            };
        }
        let connection =
            Connection::open(path).map_err(|e| format!("open device database: {e}"))?;
        super::configure(&connection)?;
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS client_preferences (
               scope TEXT NOT NULL,
               key TEXT NOT NULL,
               value_json TEXT NOT NULL,
               updated_at INTEGER NOT NULL,
               PRIMARY KEY (scope, key)
             );",
            )
            .map_err(|e| format!("initialize device database: {e}"))?;
        *database = Some(Initialized {
            path: path.to_path_buf(),
            connection,
        });
        self.initialized.store(true, Ordering::Release);
        Ok(())
    }

    pub(crate) fn capture(&self) -> Result<&Self, String> {
        if !self.initialized.load(Ordering::Acquire) {
            return Err("device database is not initialized".into());
        }
        Ok(self)
    }

    pub(crate) fn with_database<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut database = self
            .database
            .lock()
            .map_err(|_| "device database lock poisoned")?;
        let initialized = database
            .as_mut()
            .ok_or("device database is not initialized")?;
        operation(&mut initialized.connection)
    }
}

pub(super) static DEVICE_CONNECTION: DeviceConnection = DeviceConnection::new();

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_capture_and_access_never_initialize_a_connection() {
        let database = DeviceConnection::new();
        assert!(database.capture().is_err());
        assert!(database
            .with_database::<()>(|_| panic!("must not execute before initialization"))
            .is_err());
    }

    #[test]
    fn repeated_initialization_keeps_the_same_physical_connection() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preferences.sqlite");
        let database = DeviceConnection::new();
        database.initialize(&path).unwrap();
        let captured = database.capture().unwrap();
        captured.with_database(|conn| {
            // TEMP tables belong to a physical connection, not to the database file.
            conn.execute_batch("CREATE TEMP TABLE connection_identity(value TEXT); INSERT INTO connection_identity VALUES('original');")
                .map_err(|e| e.to_string())
        }).unwrap();
        database.initialize(&path).unwrap();
        let value: String = captured
            .with_database(|conn| {
                conn.query_row("SELECT value FROM connection_identity", [], |row| {
                    row.get(0)
                })
                .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(value, "original");
        assert!(std::ptr::eq(captured, database.capture().unwrap()));
        assert!(database
            .initialize(&directory.path().join("other.sqlite"))
            .is_err());
        assert!(!directory.path().join("other.sqlite").exists());
    }

    #[test]
    fn failed_initialization_can_retry_without_an_implicit_open_on_access() {
        let directory = tempfile::tempdir().unwrap();
        let database = DeviceConnection::new();
        assert!(database
            .initialize(&directory.path().join("missing/preferences.sqlite"))
            .is_err());
        assert!(database.capture().is_err());
        database
            .initialize(&directory.path().join("preferences.sqlite"))
            .unwrap();
        assert!(database.capture().is_ok());
    }

    #[test]
    fn simultaneous_initializers_do_not_establish_multiple_connections() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preferences.sqlite");
        let database = std::sync::Arc::new(DeviceConnection::new());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = (0..2).map(|_| {
            let database = database.clone();
            let barrier = barrier.clone();
            let path = path.clone();
            std::thread::spawn(move || {
                barrier.wait();
                database.initialize(&path).unwrap();
                database.with_database(|conn| {
                    conn.execute_batch("CREATE TEMP TABLE IF NOT EXISTS initialization_count(value INTEGER); INSERT INTO initialization_count VALUES(1);")
                        .map_err(|e| e.to_string())
                }).unwrap();
            })
        }).collect();
        for worker in workers {
            worker.join().unwrap();
        }
        let count: i64 = database
            .with_database(|conn| {
                conn.query_row("SELECT COUNT(*) FROM initialization_count", [], |row| {
                    row.get(0)
                })
                .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(count, 2);
    }
}
