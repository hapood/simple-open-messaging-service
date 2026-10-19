//! Durable native login metadata. Credentials are never persisted in the preferences database.
//! The native session authority must release admitted cache work before executing a cleanup plan.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const JOURNAL_KEY: &str = "soms.native-login-session.v1";

#[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub(crate) struct LoginSessionId(uuid::Uuid);

impl LoginSessionId {
    fn new() -> Self {
        Self(uuid::Uuid::new_v4())
    }

    pub(crate) fn sqlite_filename(&self) -> String {
        format!("soms-session-{}.sqlite", self.0)
    }

    pub(crate) fn cache_files(&self, directory: &Path) -> [PathBuf; 3] {
        let filename = self.sqlite_filename();
        [
            directory.join(&filename),
            directory.join(format!("{filename}-wal")),
            directory.join(format!("{filename}-shm")),
        ]
    }
}

impl TryFrom<String> for LoginSessionId {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let id = uuid::Uuid::parse_str(&value).map_err(|_| "invalid native login UUID")?;
        if id.get_version() != Some(uuid::Version::Random)
            || id.get_variant() != uuid::Variant::RFC4122
            || id.to_string() != value
        {
            return Err("native login UUID must be canonical UUID v4".into());
        }
        Ok(Self(id))
    }
}

impl From<LoginSessionId> for String {
    fn from(value: LoginSessionId) -> Self {
        value.0.to_string()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Phase {
    Preparing,
    Active,
    Ending,
    SignedOut,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    rename_all = "camelCase",
    try_from = "JournalWire",
    into = "JournalWire"
)]
pub(crate) struct Journal {
    phase: Phase,
    session: Option<LoginSessionId>,
    credential_fingerprint: Option<String>,
    pending_cleanup: Vec<LoginSessionId>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JournalWire {
    version: u8,
    phase: Phase,
    session: Option<LoginSessionId>,
    credential_fingerprint: Option<String>,
    pending_cleanup: Vec<LoginSessionId>,
}

impl TryFrom<JournalWire> for Journal {
    type Error = String;

    fn try_from(value: JournalWire) -> Result<Self, Self::Error> {
        if value.version != 1 {
            return Err("unsupported native login journal version".into());
        }
        let unique: HashSet<_> = value.pending_cleanup.iter().collect();
        if unique.len() != value.pending_cleanup.len()
            || value.session.as_ref().is_some_and(|id| unique.contains(id))
        {
            return Err("native login journal contains conflicting cache ownership".into());
        }
        let fingerprint_valid = value.credential_fingerprint.as_ref().is_some_and(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        });
        let valid = match value.phase {
            Phase::Preparing => {
                value.session.is_some()
                    && value.credential_fingerprint.is_none()
                    && value.pending_cleanup.is_empty()
            }
            Phase::Active => {
                value.session.is_some() && fingerprint_valid && value.pending_cleanup.is_empty()
            }
            Phase::Ending | Phase::SignedOut => {
                value.session.is_none() && value.credential_fingerprint.is_none()
            }
        };
        if !valid {
            return Err("invalid native login journal state".into());
        }
        Ok(Self {
            phase: value.phase,
            session: value.session,
            credential_fingerprint: value.credential_fingerprint,
            pending_cleanup: value.pending_cleanup,
        })
    }
}

impl From<Journal> for JournalWire {
    fn from(value: Journal) -> Self {
        Self {
            version: 1,
            phase: value.phase,
            session: value.session,
            credential_fingerprint: value.credential_fingerprint,
            pending_cleanup: value.pending_cleanup,
        }
    }
}

impl Journal {
    fn initial() -> Self {
        Self {
            phase: Phase::SignedOut,
            session: None,
            credential_fingerprint: None,
            pending_cleanup: Vec::new(),
        }
    }

    pub(crate) fn phase(&self) -> Phase {
        self.phase
    }

    /// The login UUID a cache command may target: only a prepared or active login owns a cache file.
    /// A login in Ending/SignedOut owns none; its file is pending deletion instead.
    pub(crate) fn active_session(&self) -> Option<&LoginSessionId> {
        if matches!(self.phase, Phase::Preparing | Phase::Active) {
            self.session.as_ref()
        } else {
            None
        }
    }

    pub(crate) fn pending_cleanup(&self) -> &[LoginSessionId] {
        &self.pending_cleanup
    }
}

/// Storage only: callers coordinate runtime cancellation and cache-handle release. Every mutation
/// rereads inside one SQLite transaction, rather than using an in-memory copy that a second host can stale.
pub(crate) struct SessionStore;

impl SessionStore {
    pub(crate) fn read(conn: &Connection) -> Result<Option<Journal>, String> {
        let raw: Option<String> = conn
            .query_row(
                "SELECT value_json FROM client_preferences WHERE scope='device' AND key=?1",
                [JOURNAL_KEY],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("read native login journal: {e}"))?;
        raw.map(|raw| {
            serde_json::from_str(&raw).map_err(|e| format!("decode native login journal: {e}"))
        })
        .transpose()
    }

    fn mutate<T>(
        conn: &mut Connection,
        operation: impl FnOnce(&mut Journal) -> Result<T, String>,
    ) -> Result<T, String> {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("begin native login transition: {e}"))?;
        let mut journal = Self::read(&tx)?.unwrap_or_else(Journal::initial);
        let result = operation(&mut journal)?;
        let value = serde_json::to_string(&journal)
            .map_err(|e| format!("encode native login journal: {e}"))?;
        tx.execute(
            "INSERT INTO client_preferences(scope,key,value_json,updated_at)
             VALUES('device',?1,?2,CAST(strftime('%s','now') AS INTEGER)*1000)
             ON CONFLICT(scope,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
            params![JOURNAL_KEY, value],
        ).map_err(|e| format!("write native login journal: {e}"))?;
        tx.commit()
            .map_err(|e| format!("commit native login transition: {e}"))?;
        Ok(result)
    }

    /// Fresh-login authority transition: ends whatever login the record itself describes.
    /// Distinct from `end`, whose expected UUID rejects completions from superseded operations.
    pub(crate) fn end_current(conn: &mut Connection) -> Result<Journal, String> {
        Self::mutate(conn, |journal| {
            if let Some(id) = journal.session.take() {
                journal.pending_cleanup.push(id);
            }
            journal.credential_fingerprint = None;
            journal.phase = Phase::Ending;
            Ok(journal.clone())
        })
    }

    /// Persist the end marker and cleanup ownership without removing a single cache file.
    /// The expected UUID must be captured by the original operation, not looked up at completion.
    /// None means no UUID-bound login is being ended (never-activated preparation); it cannot
    /// end a UUID-bound login.
    pub(crate) fn end(
        conn: &mut Connection,
        expected: Option<&LoginSessionId>,
    ) -> Result<Journal, String> {
        Self::mutate(conn, |journal| {
            if let Some(current) = &journal.session {
                if Some(current) != expected {
                    return Err("native login superseded".into());
                }
                journal.pending_cleanup.push(current.clone());
                journal.session = None;
            } else if let Some(expected) = expected {
                if !journal.pending_cleanup.contains(expected) {
                    return Err("native login superseded".into());
                }
                return Ok(journal.clone());
            } else if !journal.pending_cleanup.is_empty() {
                return Err("native login superseded".into());
            }
            journal.credential_fingerprint = None;
            journal.phase = Phase::Ending;
            Ok(journal.clone())
        })
    }

    pub(crate) fn finish_ending(
        conn: &mut Connection,
        expected: Option<&LoginSessionId>,
    ) -> Result<(), String> {
        Self::mutate(conn, |journal| {
            let owns_cleanup = match expected {
                Some(id) => journal.pending_cleanup.contains(id),
                None => journal.pending_cleanup.is_empty(),
            };
            if !matches!(journal.phase, Phase::Ending | Phase::SignedOut) || !owns_cleanup {
                return Err("native login superseded".into());
            }
            journal.phase = Phase::SignedOut;
            Ok(())
        })
    }

    /// Called by fresh-login preparation only, after the native cache lifetime has been drained.
    /// On failure the durable descriptor remains discoverable; partial deletion is retry-safe.
    pub(crate) fn delete_retired_cache(
        conn: &mut Connection,
        directory: &Path,
        id: &LoginSessionId,
    ) -> Result<(), String> {
        let journal = Self::read(conn)?.ok_or("native login cleanup record is missing")?;
        if !matches!(journal.phase, Phase::Ending | Phase::SignedOut)
            || !journal.pending_cleanup.contains(id)
        {
            return Err("native login superseded".into());
        }
        if !directory.is_absolute() {
            return Err("native cache directory must be absolute".into());
        }
        for path in id.cache_files(directory) {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("remove retired native cache: {error}")),
            }
        }
        Self::mutate(conn, |journal| {
            if !matches!(journal.phase, Phase::Ending | Phase::SignedOut)
                || !journal.pending_cleanup.contains(id)
            {
                return Err("native login superseded".into());
            }
            journal.pending_cleanup.retain(|pending| pending != id);
            Ok(())
        })
    }

    /// Retry/poll within one unactivated login preserves its prepared UUID. An ended login never does.
    pub(crate) fn prepare(conn: &mut Connection) -> Result<LoginSessionId, String> {
        Self::mutate(conn, |journal| {
            if journal.phase == Phase::Preparing {
                return journal
                    .session
                    .clone()
                    .ok_or_else(|| "missing prepared native login".into());
            }
            if !matches!(journal.phase, Phase::Ending | Phase::SignedOut)
                || !journal.pending_cleanup.is_empty()
            {
                return Err("native login requires fresh-login cleanup".into());
            }
            let id = LoginSessionId::new();
            journal.phase = Phase::Preparing;
            journal.session = Some(id.clone());
            Ok(id)
        })
    }

    /// The expected UUID belongs to the original authentication operation, never a mutable current pointer.
    pub(crate) fn activate(
        conn: &mut Connection,
        expected: &LoginSessionId,
        token: &str,
    ) -> Result<(), String> {
        if token.is_empty() {
            return Err("empty native login credential".into());
        }
        let fingerprint = format!("{:x}", Sha256::digest(token.as_bytes()));
        Self::mutate(conn, |journal| {
            if journal.session.as_ref() != Some(expected) {
                return Err("native login superseded".into());
            }
            match journal.phase {
                Phase::Preparing => {
                    journal.phase = Phase::Active;
                    journal.credential_fingerprint = Some(fingerprint);
                    Ok(())
                }
                Phase::Active if journal.credential_fingerprint.as_ref() == Some(&fingerprint) => {
                    Ok(())
                }
                _ => Err("native login superseded".into()),
            }
        })
    }

    /// A residual secure-store credential cannot revive an ended or incompletely prepared login.
    /// Journal absence (fresh install) never authorizes restoration of an existing credential.
    pub(crate) fn restore(
        conn: &Connection,
        token: &str,
    ) -> Result<Option<LoginSessionId>, String> {
        if token.is_empty() {
            return Ok(None);
        }
        let Some(journal) = Self::read(conn)? else {
            return Ok(None);
        };
        let fingerprint = format!("{:x}", Sha256::digest(token.as_bytes()));
        if journal.phase == Phase::Active
            && journal.credential_fingerprint.as_ref() == Some(&fingerprint)
        {
            return Ok(journal.session);
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(path: &Path) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch("CREATE TABLE IF NOT EXISTS client_preferences (
            scope TEXT NOT NULL,key TEXT NOT NULL,value_json TEXT NOT NULL,updated_at INTEGER NOT NULL,
            PRIMARY KEY(scope,key));").unwrap();
        conn
    }

    fn prepare(conn: &mut Connection) -> LoginSessionId {
        SessionStore::prepare(conn).unwrap()
    }

    #[test]
    fn restart_preserves_uuid_and_logout_retains_all_cache_files() {
        let dir = tempfile::tempdir().unwrap();
        let preferences = dir.path().join("preferences.sqlite");
        let mut conn = open(&preferences);
        let id = prepare(&mut conn);
        assert_eq!(SessionStore::prepare(&mut conn).unwrap(), id);
        SessionStore::activate(&mut conn, &id, "original-secret").unwrap();
        assert!(!serde_json::to_string(&SessionStore::read(&conn).unwrap())
            .unwrap()
            .contains("original-secret"));
        for path in id.cache_files(dir.path()) {
            std::fs::write(path, "cached data").unwrap();
        }
        drop(conn);
        let mut conn = open(&preferences);
        assert_eq!(
            SessionStore::restore(&conn, "original-secret").unwrap(),
            Some(id.clone())
        );
        assert_eq!(SessionStore::restore(&conn, "other-secret").unwrap(), None);
        SessionStore::end(&mut conn, Some(&id)).unwrap();
        SessionStore::finish_ending(&mut conn, Some(&id)).unwrap();
        drop(conn);
        let conn = open(&preferences);
        assert_eq!(
            SessionStore::restore(&conn, "original-secret").unwrap(),
            None
        );
        assert!(id.cache_files(dir.path()).iter().all(|path| path.exists()));
        let raw: String = conn
            .query_row("SELECT value_json FROM client_preferences", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(!raw.contains("original-secret"));
    }

    #[test]
    fn failed_deletion_blocks_preparation_and_retry_gets_a_new_uuid() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open(&dir.path().join("preferences.sqlite"));
        let old = prepare(&mut conn);
        SessionStore::activate(&mut conn, &old, "old").unwrap();
        SessionStore::end(&mut conn, Some(&old)).unwrap();
        let cache = old.cache_files(dir.path())[0].clone();
        std::fs::create_dir(&cache).unwrap();
        assert!(SessionStore::delete_retired_cache(&mut conn, dir.path(), &old).is_err());
        assert!(SessionStore::prepare(&mut conn).is_err());
        assert_eq!(
            SessionStore::read(&conn)
                .unwrap()
                .unwrap()
                .pending_cleanup(),
            &[old.clone()]
        );
        std::fs::remove_dir(cache).unwrap();
        SessionStore::delete_retired_cache(&mut conn, dir.path(), &old).unwrap();
        let fresh = SessionStore::prepare(&mut conn).unwrap();
        assert_ne!(old, fresh);
        assert!(SessionStore::activate(&mut conn, &old, "late old response").is_err());
        SessionStore::activate(&mut conn, &fresh, "new").unwrap();
        assert!(SessionStore::activate(&mut conn, &fresh, "different").is_err());
        assert_eq!(SessionStore::restore(&conn, "new").unwrap(), Some(fresh));
    }

    #[test]
    fn stale_connection_cannot_end_or_activate_a_successor() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("preferences.sqlite");
        let mut owner = open(&path);
        owner
            .execute(
                "INSERT INTO client_preferences VALUES('device','theme','\"dark\"',0)",
                [],
            )
            .unwrap();
        let old = prepare(&mut owner);
        SessionStore::activate(&mut owner, &old, "old-secret").unwrap();
        let mut stale = open(&path);
        assert_eq!(
            SessionStore::restore(&stale, "old-secret").unwrap(),
            Some(old.clone())
        );
        SessionStore::end(&mut owner, Some(&old)).unwrap();
        SessionStore::finish_ending(&mut owner, Some(&old)).unwrap();
        // Duplicate logout is idempotent and leaves its cleanup record intact.
        assert_eq!(
            SessionStore::end(&mut stale, Some(&old)).unwrap().phase(),
            Phase::SignedOut
        );
        SessionStore::delete_retired_cache(&mut owner, dir.path(), &old).unwrap();
        let successor = SessionStore::prepare(&mut owner).unwrap();
        assert!(SessionStore::end(&mut stale, Some(&old)).is_err());
        assert!(SessionStore::finish_ending(&mut stale, Some(&old)).is_err());
        assert!(SessionStore::activate(&mut stale, &old, "late-secret").is_err());
        assert!(SessionStore::end(&mut stale, None).is_err());
        SessionStore::activate(&mut owner, &successor, "successor-secret").unwrap();
        assert!(SessionStore::end(&mut stale, Some(&old)).is_err());
        assert_eq!(SessionStore::restore(&stale, "old-secret").unwrap(), None);
        assert_eq!(
            SessionStore::restore(&stale, "successor-secret").unwrap(),
            Some(successor)
        );
        let theme: String = stale
            .query_row(
                "SELECT value_json FROM client_preferences WHERE key='theme'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(theme, "\"dark\"");
    }

    #[test]
    fn failed_activation_write_never_becomes_restorable_and_can_be_retried() {
        let mut conn = open(Path::new(":memory:"));
        let id = prepare(&mut conn);
        conn.execute_batch(
            "CREATE TRIGGER fail_session_write BEFORE UPDATE ON client_preferences
            BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;",
        )
        .unwrap();
        assert!(SessionStore::activate(&mut conn, &id, "secret").is_err());
        assert_eq!(
            SessionStore::read(&conn).unwrap().unwrap().phase(),
            Phase::Preparing
        );
        assert_eq!(SessionStore::restore(&conn, "secret").unwrap(), None);
        assert_eq!(SessionStore::restore(&conn, "").unwrap(), None);
        conn.execute_batch("DROP TRIGGER fail_session_write;")
            .unwrap();
        SessionStore::activate(&mut conn, &id, "secret").unwrap();
        assert_eq!(SessionStore::restore(&conn, "secret").unwrap(), Some(id));
    }

    #[test]
    fn malformed_records_fail_closed_and_paths_are_not_user_supplied() {
        for invalid in [
            "../other.sqlite",
            "00000000-0000-0000-0000-000000000000",
            "550E8400-E29B-41D4-A716-446655440000",
        ] {
            assert!(LoginSessionId::try_from(invalid.to_string()).is_err());
        }
        let mut conn = open(Path::new(":memory:"));
        let id = prepare(&mut conn);
        SessionStore::activate(&mut conn, &id, "secret").unwrap();
        let journal = SessionStore::read(&conn).unwrap().unwrap();
        assert_eq!(journal.phase(), Phase::Active);
        let mut raw = serde_json::to_value(journal).unwrap();
        raw["pendingCleanup"] = serde_json::json!([id]);
        conn.execute(
            "UPDATE client_preferences SET value_json=?1",
            [raw.to_string()],
        )
        .unwrap();
        assert!(SessionStore::read(&conn).is_err());
        assert!(SessionStore::end(&mut conn, None).is_err());
    }
}
