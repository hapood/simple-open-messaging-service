use rusqlite::{Connection, TransactionBehavior};
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
        let mut connection =
            Connection::open(path).map_err(|e| format!("open device database: {e}"))?;
        super::configure(&connection)?;
        prepare_schema(&mut connection)?;
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

/// Initialize a fresh device database or validate the current format without changing existing
/// records. Unsupported formats are rejected, never migrated or reset. One transaction covers
/// initialization so an interrupted start cannot leave a partial schema.
fn prepare_schema(conn: &mut Connection) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("begin database start check: {e}"))?;
    let objects: Vec<(String, String)> = tx
        .prepare("SELECT name,type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .and_then(|mut statement| {
            statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect()
        })
        .map_err(|e| format!("inspect device database format: {e}"))?;
    if objects.is_empty() {
        tx.execute_batch(
            "CREATE TABLE settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
             );",
        )
        .map_err(|e| format!("create settings table: {e}"))?;
        super::app_state::ensure_schema(&tx)?;
        super::app_state::put(
            &tx,
            super::app_state::SCHEMA_VERSION_KEY,
            &super::app_state::SCHEMA_VERSION.to_string(),
        )?;
    } else {
        let expected = vec![
            ("app_state".to_string(), "table".to_string()),
            ("settings".to_string(), "table".to_string()),
        ];
        if objects != expected {
            return Err("unsupported device database format".into());
        }
        tx.prepare("SELECT key,value_json,updated_at FROM settings LIMIT 0")
            .map_err(|e| format!("unsupported device settings format: {e}"))?;
        if super::app_state::get(&tx, super::app_state::SCHEMA_VERSION_KEY)?
            != Some(super::app_state::SCHEMA_VERSION.to_string())
        {
            return Err("unsupported device app-state schema version".into());
        }
    }
    tx.commit()
        .map_err(|e| format!("commit database start check: {e}"))
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

    fn tables(conn: &Connection) -> Vec<String> {
        let mut statement = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn start_check_creates_both_tables_and_keeps_records_of_this_version() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preferences.sqlite");
        DeviceConnection::new().initialize(&path).unwrap();
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute(
                "INSERT INTO settings(key,value_json,updated_at) VALUES('theme','\"dark\"',0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO app_state(key,value) VALUES('lifecycleState','\"signed-out\"')",
                [],
            )
            .unwrap();
        }
        // The next start keeps what this version wrote.
        DeviceConnection::new().initialize(&path).unwrap();
        let conn = Connection::open(&path).unwrap();
        assert!(tables(&conn).contains(&"settings".to_string()));
        assert!(tables(&conn).contains(&"app_state".to_string()));
        let value: String = conn
            .query_row(
                "SELECT value_json FROM settings WHERE key='theme'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, "\"dark\"");
        let state: String = conn
            .query_row(
                "SELECT value FROM app_state WHERE key='lifecycleState'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "\"signed-out\"");
    }

    #[test]
    fn unsupported_app_state_versions_are_rejected_without_changing_records() {
        for version in [None, Some("99")] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("preferences.sqlite");
            DeviceConnection::new().initialize(&path).unwrap();
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "INSERT INTO settings VALUES('theme','\"dark\"',0);
                 INSERT INTO app_state VALUES('lifecycleState','\"signed-out\"');
                 DELETE FROM app_state WHERE key='schemaVersion';",
            )
            .unwrap();
            if let Some(value) = version {
                super::super::app_state::put(&conn, "schemaVersion", value).unwrap();
            }
            let database = DeviceConnection::new();
            assert_eq!(
                database.initialize(&path).unwrap_err(),
                "unsupported device app-state schema version"
            );
            assert!(database.capture().is_err());
            assert_eq!(
                super::super::app_state::get(&conn, "schemaVersion")
                    .unwrap()
                    .as_deref(),
                version
            );
            assert_eq!(
                super::super::app_state::get(&conn, "lifecycleState")
                    .unwrap()
                    .as_deref(),
                Some("\"signed-out\"")
            );
            let theme: String = conn
                .query_row(
                    "SELECT value_json FROM settings WHERE key='theme'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(theme, "\"dark\"");
        }
    }

    #[test]
    fn a_failed_start_check_leaves_the_file_untouched_and_is_retried() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preferences.sqlite");
        {
            // A view named like the table makes the first attempt fail inside its transaction.
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE blocker(value TEXT);
                 CREATE VIEW app_state AS SELECT value AS key, value FROM blocker;",
            )
            .unwrap();
        }
        let database = DeviceConnection::new();
        assert!(database.initialize(&path).is_err());
        assert!(database.capture().is_err());
        let conn = Connection::open(&path).unwrap();
        assert!(tables(&conn).contains(&"blocker".to_string()));
        assert!(!tables(&conn).contains(&"settings".to_string()));
        drop(conn);
        // After an explicit repair removes the unsupported objects, initialization can retry.
        Connection::open(&path)
            .unwrap()
            .execute_batch("DROP VIEW app_state; DROP TABLE blocker;")
            .unwrap();
        database.initialize(&path).unwrap();
        assert!(database.capture().is_ok());
    }
}
