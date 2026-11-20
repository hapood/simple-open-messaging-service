use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredDownloadRecord {
    pub id: String,
    pub thread_id: i64,
    pub path: String,
    pub filename: String,
    pub mime_type: String,
    pub phase: String,
    pub error: Option<String>,
    pub destination: Option<String>,
    pub loaded: i64,
    pub total: Option<i64>,
}

pub struct DownloadHistoryStorage<'a> {
    connection: &'a Connection,
}

impl<'a> DownloadHistoryStorage<'a> {
    pub fn new(connection: &'a Connection) -> Self {
        Self { connection }
    }

    pub fn initialize(connection: &Connection) -> Result<(), String> {
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS download_history (
                    id TEXT PRIMARY KEY NOT NULL,
                    thread_id INTEGER NOT NULL,
                    path TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    mime_type TEXT NOT NULL,
                    phase TEXT NOT NULL,
                    error TEXT,
                    destination TEXT,
                    loaded INTEGER NOT NULL,
                    total INTEGER
                );",
            )
            .map_err(|error| format!("initialize download history: {error}"))
    }

    pub fn put(&self, record: &StoredDownloadRecord) -> Result<(), String> {
        if record.phase != "completed" && record.phase != "failed" {
            return Err("download history only stores completed or failed records".into());
        }
        self.connection.execute(
            "INSERT INTO download_history(id,thread_id,path,filename,mime_type,phase,error,destination,loaded,total)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
             ON CONFLICT(id) DO UPDATE SET
               thread_id=excluded.thread_id, path=excluded.path, filename=excluded.filename,
               mime_type=excluded.mime_type, phase=excluded.phase, error=excluded.error,
               destination=excluded.destination, loaded=excluded.loaded, total=excluded.total",
            params![
                record.id, record.thread_id, record.path, record.filename, record.mime_type,
                record.phase, record.error, record.destination, record.loaded, record.total,
            ],
        ).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<StoredDownloadRecord>, String> {
        let mut query = self.connection.prepare(
            "SELECT id,thread_id,path,filename,mime_type,phase,error,destination,loaded,total
             FROM download_history ORDER BY rowid",
        ).map_err(|error| error.to_string())?;
        let rows = query.query_map([], |row| {
            Ok(StoredDownloadRecord {
                id: row.get(0)?,
                thread_id: row.get(1)?,
                path: row.get(2)?,
                filename: row.get(3)?,
                mime_type: row.get(4)?,
                phase: row.get(5)?,
                error: row.get(6)?,
                destination: row.get(7)?,
                loaded: row.get(8)?,
                total: row.get(9)?,
            })
        }).map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        self.connection.execute("DELETE FROM download_history WHERE id=?1", [id])
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn clear(&self) -> Result<Vec<String>, String> {
        let destinations = self.list()?.into_iter().filter_map(|record| record.destination).collect();
        self.connection.execute("DELETE FROM download_history", [])
            .map_err(|error| error.to_string())?;
        Ok(destinations)
    }
}

/// Deletes only a regular file. Content URIs and links are left for the platform owner.
pub fn delete_recorded_file(path: &str) -> Result<(), String> {
    if path.starts_with("content://") {
        return Ok(());
    }
    let candidate = std::path::Path::new(path);
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("stat download destination: {error}")),
    };
    if !metadata.file_type().is_file() {
        return Err("refusing to delete a download destination that is not a regular file".into());
    }
    std::fs::remove_file(candidate).map_err(|error| format!("delete download destination: {error}"))
}
