//! Durable pending sends, kept separately from rebuildable chat caches.
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredSendTask {
    pub client_message_id: String,
    pub thread_id: i64,
    pub item: StoredSendContent,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredSendFile {
    pub part_id: String,
    /// Original filesystem path or platform resource URI; never a copied staging resource.
    pub path: String,
    pub name: String,
    /// Preserve the exact upload admission parameter across retries.
    pub mime_type: String,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub(crate) enum UploadIntent { IMAGE, VIDEO, AUDIO, FILE }

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub(crate) struct StoredGroupFile {
    pub intent: UploadIntent,
    #[serde(flatten)]
    pub file: StoredSendFile,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContactTarget {
    pub account: String,
    pub namespace_id: i64,
    pub profile_rev: i64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ForwardSource {
    pub thread_id: i64,
    pub seq: i64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub(crate) enum ForwardMode { DIRECT, HISTORY }

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", deny_unknown_fields)]
pub(crate) enum StoredSendContent {
    #[serde(rename = "PURE_TEXT")]
    Text { content: String },
    #[serde(rename = "LINK")]
    Link { #[serde(rename = "generationId")] generation_id: String },
    #[serde(rename = "CONTACT_CARD")]
    ContactCard { target: ContactTarget },
    #[serde(rename = "FORWARD")]
    Forward { #[serde(rename = "sourceMessages")] source_messages: Vec<ForwardSource>, mode: ForwardMode },
    #[serde(rename = "IMAGE")]
    Image { file: StoredSendFile },
    #[serde(rename = "VIDEO")]
    Video { file: StoredSendFile },
    #[serde(rename = "AUDIO")]
    Audio { file: StoredSendFile },
    #[serde(rename = "FILE")]
    File { file: StoredSendFile },
    #[serde(rename = "GALLERY")]
    Gallery { files: Vec<StoredGroupFile> },
}

pub(crate) struct SendOutboxStorage<'a> { connection: &'a Connection }

impl<'a> SendOutboxStorage<'a> {
    pub(crate) fn new(connection: &'a Connection) -> Self {
        Self { connection }
    }

    /// Connection admission, durability settings and lifetime belong to the database manager.
    pub(crate) fn initialize(connection: &'a Connection) -> Result<Self, String> {
        connection.execute_batch("CREATE TABLE IF NOT EXISTS pending_sends (
                client_message_id TEXT PRIMARY KEY NOT NULL,
                thread_id INTEGER NOT NULL,
                item TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS owned_send_resources (
                client_message_id TEXT NOT NULL,
                path TEXT NOT NULL,
                PRIMARY KEY (client_message_id, path)
            );
        ").map_err(|e| e.to_string())?;
        Ok(Self { connection })
    }

    /// Only an app-generated recording may be registered. User-selected paths stay references.
    pub(crate) fn register_owned_recording(&self, client_message_id: &str, path: &std::path::Path) -> Result<(), String> {
        let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if !metadata.file_type().is_file() { return Err("recording is not a regular file".into()); }
        let canonical = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
        let owned_root = canonical.parent().and_then(|parent| parent.file_name()).is_some_and(|name| name == "pending-uploads")
            && canonical.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("voice-") && name.ends_with(".m4a"));
        if !owned_root { return Err("recording is outside the owned upload directory".into()); }
        let text = canonical.to_str().ok_or("recording path is not valid Unicode")?;
        self.connection.execute(
            "INSERT OR IGNORE INTO owned_send_resources(client_message_id, path) VALUES (?1, ?2)",
            params![client_message_id, text],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub(crate) fn owned_recordings(&self, client_message_id: &str) -> Result<Vec<String>, String> {
        let mut query = self.connection.prepare(
            "SELECT path FROM owned_send_resources WHERE client_message_id=?1 ORDER BY path",
        ).map_err(|e| e.to_string())?;
        let rows = query.query_map([client_message_id], |row| row.get(0)).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Resource files must already be durable before this insert is admitted.
    pub(crate) fn enqueue(&self, task: &StoredSendTask) -> Result<(), String> {
        for file in task.item.files() {
            validate_file_reference(&file.path)?;
        }
        let item = serde_json::to_string(&task.item).map_err(|e| e.to_string())?;
        self.connection.execute("INSERT INTO pending_sends(client_message_id,thread_id,item) VALUES (?1,?2,?3)", params![task.client_message_id, task.thread_id, item]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub(crate) fn get(&self, client_message_id: &str) -> Result<Option<StoredSendTask>, String> {
        use rusqlite::OptionalExtension;
        let row = self.connection.query_row(
            "SELECT thread_id,item FROM pending_sends WHERE client_message_id=?1",
            [client_message_id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        ).optional().map_err(|e| e.to_string())?;
        row.map(|(thread_id, item)| Ok(StoredSendTask {
            client_message_id: client_message_id.to_owned(), thread_id,
            item: serde_json::from_str(&item).map_err(|e| e.to_string())?,
        })).transpose()
    }

    /// Reading never changes durable data. The runtime initializes recovered tasks as failed.
    pub(crate) fn list(&self) -> Result<Vec<StoredSendTask>, String> {
        let mut query = self.connection.prepare("SELECT client_message_id,thread_id,item FROM pending_sends ORDER BY rowid").map_err(|e| e.to_string())?;
        let rows = query.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?))).map_err(|e| e.to_string())?;
        rows.map(|row| {
            let (client_message_id, thread_id, item) = row.map_err(|e| e.to_string())?;
            Ok(StoredSendTask { client_message_id, thread_id, item: serde_json::from_str(&item).map_err(|e| e.to_string())? })
        }).collect()
    }

    /// One snapshot supplies the keep-set for an upload-directory maintenance operation.
    pub(crate) fn referenced_files(&self) -> Result<std::collections::BTreeSet<String>, String> {
        let mut files = std::collections::BTreeSet::new();
        for task in self.list()? {
            for file in task.item.files() {
                validate_file_reference(&file.path)?;
                files.insert(file.path.clone());
            }
        }
        Ok(files)
    }

    pub(crate) fn remove(&self, cid: &str) -> Result<Vec<String>, String> {
        let owned = self.owned_recordings(cid)?;
        self.connection.execute("DELETE FROM pending_sends WHERE client_message_id=?1", [cid]).map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM owned_send_resources WHERE client_message_id=?1", [cid]).map_err(|e| e.to_string())?;
        Ok(owned)
    }

    pub(crate) fn clear(&self) -> Result<Vec<String>, String> {
        let mut query = self.connection.prepare("SELECT path FROM owned_send_resources ORDER BY path").map_err(|e| e.to_string())?;
        let owned = query.query_map([], |row| row.get(0)).map_err(|e| e.to_string())?.collect::<Result<Vec<String>, _>>().map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM pending_sends", []).map_err(|e| e.to_string())?;
        self.connection.execute("DELETE FROM owned_send_resources", []).map_err(|e| e.to_string())?;
        Ok(owned)
    }
}

impl StoredSendContent {
    pub(crate) fn files(&self) -> Vec<&StoredSendFile> {
        match self {
            Self::Image { file } | Self::Video { file } | Self::Audio { file } | Self::File { file } => vec![file],
            Self::Gallery { files } => files.iter().map(|part| &part.file).collect(),
            _ => Vec::new(),
        }
    }
}

pub(crate) fn release_owned_recordings(paths: impl IntoIterator<Item = impl AsRef<str>>) -> Result<(), String> {
    for path in paths {
        let path = std::path::Path::new(path.as_ref());
        match std::fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_file() => {},
            Ok(_) => return Err("refusing to delete an unowned send resource".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        }
        let canonical = std::fs::canonicalize(path).map_err(|error| error.to_string())?;
        let safe = canonical.parent().and_then(|parent| parent.file_name()).is_some_and(|name| name == "pending-uploads")
            && canonical.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("voice-") && name.ends_with(".m4a"))
            && canonical.is_file();
        if !safe { return Err("refusing to delete an unowned send resource".into()); }
        match std::fs::remove_file(&canonical) {
            Ok(()) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

pub(crate) fn validate_file_reference(path: &str) -> Result<(), String> {
    if path.is_empty() || path.contains('\0') {
        return Err("upload source reference is empty or contains NUL".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_original_upload_parameters_without_runtime_state() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("outbox.sqlite");
        let task = StoredSendTask { client_message_id: "cid".into(), thread_id: 1,
            item: StoredSendContent::Audio { file: StoredSendFile { part_id: "part".into(), path: "voice/one.m4a".into(), name: "voice.m4a".into(), mime_type: "audio/mp4".into(), size: 10 } } };
        let connection = Connection::open(&path).unwrap();
        let store = SendOutboxStorage::initialize(&connection).unwrap();
        store.enqueue(&task).unwrap();
        assert_eq!(store.get("cid").unwrap().as_ref(), Some(&task));
        assert!(store.get("missing").unwrap().is_none());
        assert!(store.enqueue(&task).is_err());
        drop(store);
        drop(connection);
        let connection = Connection::open(&path).unwrap();
        let store = SendOutboxStorage::initialize(&connection).unwrap();
        assert_eq!(store.list().unwrap(), vec![task]);
        assert_eq!(store.referenced_files().unwrap(), std::collections::BTreeSet::from(["voice/one.m4a".to_string()]));
        assert!(store.remove("cid").unwrap().is_empty());
        assert!(store.referenced_files().unwrap().is_empty());
        assert!(store.clear().unwrap().is_empty());
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn preserves_original_platform_references() {
        for path in ["/tmp/voice.m4a", "C:\\Users\\file.jpg", "content://provider/document/42"] {
            assert!(validate_file_reference(path).is_ok(), "{path}");
        }
        assert!(validate_file_reference("").is_err());
        assert!(validate_file_reference("file\0name").is_err());
    }

    #[test]
    fn releases_only_registered_owned_recordings() {
        let directory = tempfile::tempdir().unwrap();
        let owned = directory.path().join("pending-uploads");
        std::fs::create_dir(&owned).unwrap();
        let recording = owned.join("voice-one.m4a");
        let external = directory.path().join("voice-external.m4a");
        std::fs::write(&recording, b"voice").unwrap();
        std::fs::write(&external, b"keep").unwrap();
        let connection = Connection::open_in_memory().unwrap();
        let store = SendOutboxStorage::initialize(&connection).unwrap();
        store.register_owned_recording("cid", &recording).unwrap();
        assert!(store.register_owned_recording("cid", &external).is_err());
        assert!(store.remove("cid").unwrap().contains(&recording.canonicalize().unwrap().to_string_lossy().to_string()));
        assert!(store.owned_recordings("cid").unwrap().is_empty());
        assert!(external.exists());
        std::os::unix::fs::symlink(&external, owned.join("voice-link.m4a")).unwrap();
        assert!(release_owned_recordings([owned.join("voice-link.m4a").to_string_lossy().to_string()]).is_err());
        assert!(external.exists());
        release_owned_recordings([recording.canonicalize().unwrap().to_string_lossy().to_string()]).unwrap();
        assert!(!recording.exists());
    }

    #[test]
    fn contact_and_forward_requests_persist_without_rendered_snapshots() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("outbox.sqlite");
        let connection = Connection::open(&path).unwrap();
        let store = SendOutboxStorage::initialize(&connection).unwrap();
        let values = [
            serde_json::json!({"type":"CONTACT_CARD","target":{"account":"alice","namespaceId":2,"profileRev":7}}),
            serde_json::json!({"type":"FORWARD","sourceMessages":[{"threadId":3,"seq":9}],"mode":"HISTORY"}),
        ];
        for (index, value) in values.iter().enumerate() {
            store.enqueue(&StoredSendTask { client_message_id: index.to_string(), thread_id: 1,
                item: serde_json::from_value(value.clone()).unwrap() }).unwrap();
        }
        drop(store);
        drop(connection);
        let connection = Connection::open(&path).unwrap();
        let store = SendOutboxStorage::initialize(&connection).unwrap();
        for (task, expected) in store.list().unwrap().iter().zip(values) {
            assert_eq!(serde_json::to_value(&task.item).unwrap(), expected);
        }
    }

    #[test]
    fn group_files_round_trip_in_original_order() {
        let value = serde_json::json!({"type":"GALLERY","files":[
            {"intent":"IMAGE","partId":"a","path":"a.jpg","name":"a.jpg","mimeType":"image/jpeg","size":12},
            {"intent":"FILE","partId":"b","path":"b.bin","name":"b.bin","mimeType":"application/octet-stream","size":34}
        ]});
        let content: StoredSendContent = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(content).unwrap(), value);
    }
}
