//! Durable app lifecycle and login identity. No credential is stored here: secure storage keeps
//! the token together with the same UUID, and a login is restorable only while both records agree.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::native_db::app_state::{self, LIFECYCLE_STATE_KEY, SESSION_UUID_KEY};

/// One login generation. It fences in-flight work and names the login's cache; it is never a
/// credential or a server session. It crosses command boundaries as its UUID text.
#[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub(crate) struct LoginSessionId(uuid::Uuid);

impl LoginSessionId {
    pub(crate) fn new() -> Self {
        Self(uuid::Uuid::new_v4())
    }

    pub(crate) fn sqlite_filename(&self) -> String {
        "soms-session.sqlite".to_string()
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

impl std::fmt::Display for LoginSessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl From<LoginSessionId> for String {
    fn from(value: LoginSessionId) -> Self {
        value.0.to_string()
    }
}

/// The durable part of the app lifecycle. Signing in is deliberately not a value: it lives only
/// in memory, so a process that dies mid-login next starts signed out.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LifecycleState {
    /// No server has been configured.
    Unconfigured,
    /// A server is configured and no login is admitted.
    SignedOut,
    /// A login completed; the next start restores it.
    Active,
    /// Local evidence of an ended login is being deleted; the next start resumes it.
    Cleaning,
}

impl LifecycleState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Unconfigured => "unconfigured",
            Self::SignedOut => "signed-out",
            Self::Active => "active",
            Self::Cleaning => "cleaning",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "unconfigured" => Ok(Self::Unconfigured),
            "signed-out" => Ok(Self::SignedOut),
            "active" => Ok(Self::Active),
            "cleaning" => Ok(Self::Cleaning),
            _ => Err(format!("unknown app lifecycle state {value}")),
        }
    }

    pub(crate) fn owns_a_login(self) -> bool {
        matches!(self, Self::Active | Self::Cleaning)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LoginRecord {
    pub(crate) state: LifecycleState,
    /// The login an active or cleaning lifecycle belongs to.
    pub(crate) session: Option<LoginSessionId>,
}

impl LoginRecord {
    /// The only login that owns business work and a cache.
    pub(crate) fn active_session(&self) -> Option<&LoginSessionId> {
        (self.state == LifecycleState::Active)
            .then(|| self.session.as_ref())
            .flatten()
    }

    /// The ended login whose local evidence is still being deleted.
    pub(crate) fn cleaning_session(&self) -> Option<&LoginSessionId> {
        (self.state == LifecycleState::Cleaning)
            .then(|| self.session.as_ref())
            .flatten()
    }
}

fn json(value: &str) -> String {
    serde_json::Value::String(value.to_owned()).to_string()
}

fn text(raw: &str, key: &str) -> Result<String, String> {
    serde_json::from_str(raw).map_err(|e| format!("decode app state {key}: {e}"))
}

/// Storage only: callers coordinate runtime cancellation and cache-handle release.
pub(crate) struct SessionStore;

impl SessionStore {
    /// Establishes the lifecycle a start needs. A database without a record gets one from the
    /// server configuration: a configured server is signed out, an unconfigured one is still in
    /// server setup. A recorded state is kept, except that server setup cannot outlive a
    /// committed server configuration.
    pub(crate) fn initialize(conn: &Connection, server_configured: bool) -> Result<(), String> {
        match app_state::get(conn, LIFECYCLE_STATE_KEY)? {
            Some(raw) => {
                if !server_configured
                    || text(&raw, LIFECYCLE_STATE_KEY)? != LifecycleState::Unconfigured.as_str()
                {
                    return Ok(());
                }
            }
            None if !server_configured => {
                return app_state::put(
                    conn,
                    LIFECYCLE_STATE_KEY,
                    &json(LifecycleState::Unconfigured.as_str()),
                );
            }
            None => {}
        }
        app_state::put(
            conn,
            LIFECYCLE_STATE_KEY,
            &json(LifecycleState::SignedOut.as_str()),
        )
    }

    /// A storage failure or a damaged record is an error, never an absence of login.
    pub(crate) fn read(conn: &Connection) -> Result<LoginRecord, String> {
        let state = match app_state::get(conn, LIFECYCLE_STATE_KEY)? {
            Some(raw) => LifecycleState::parse(&text(&raw, LIFECYCLE_STATE_KEY)?)?,
            None => return Err("app lifecycle state is missing".into()),
        };
        let session = match app_state::get(conn, SESSION_UUID_KEY)? {
            Some(raw) => Some(LoginSessionId::try_from(text(&raw, SESSION_UUID_KEY)?)?),
            None => None,
        };
        if session.is_some() != state.owns_a_login() {
            return Err("app lifecycle state and login identity disagree".into());
        }
        Ok(LoginRecord { state, session })
    }

    /// Records a completed login. The state and its identity are one write, so a restart never
    /// sees an active lifecycle without the login generation that owns it.
    pub(crate) fn activate(
        conn: &mut Connection,
        id: &LoginSessionId,
    ) -> Result<LoginRecord, String> {
        Self::mutate(conn, |record| {
            match record.state {
                LifecycleState::Active if record.session.as_ref() == Some(id) => Ok(()),
                LifecycleState::Active | LifecycleState::Cleaning => {
                    Err("app lifecycle does not admit a login".into())
                }
                _ => {
                    record.state = LifecycleState::Active;
                    record.session = Some(id.clone());
                    Ok(())
                }
            }
        })
    }

    /// Marks the ended login's local evidence for deletion. Entered only after a confirmed
    /// logout or an explicit local-only decision; until then the login stays active.
    pub(crate) fn begin_cleaning(
        conn: &mut Connection,
        expected: &LoginSessionId,
    ) -> Result<LoginRecord, String> {
        Self::mutate(conn, |record| {
            let admitted = record.state == LifecycleState::Active
                && record.session.as_ref() == Some(expected);
            let resumed = record.state == LifecycleState::Cleaning
                && record.session.as_ref() == Some(expected);
            if !admitted && !resumed {
                return Err("native login superseded".into());
            }
            record.state = LifecycleState::Cleaning;
            Ok(())
        })
    }

    /// Completes local deletion. The identity goes away in the same write as the signed-out
    /// state, so no late work of the ended login can be admitted afterwards.
    pub(crate) fn finish_cleaning(conn: &mut Connection) -> Result<LoginRecord, String> {
        Self::mutate(conn, |record| {
            if record.state != LifecycleState::Cleaning {
                return Err("no login cleanup is pending".into());
            }
            record.state = LifecycleState::SignedOut;
            record.session = None;
            Ok(())
        })
    }

    /// Admits a stored credential only while the lifecycle is active for the very pair it was
    /// saved with. A credential without its UUID, or with another login's UUID, restores nothing.
    pub(crate) fn restore(
        conn: &Connection,
        session_uuid: &str,
    ) -> Result<Option<LoginSessionId>, String> {
        if session_uuid.is_empty() {
            return Ok(None);
        }
        Ok(Self::read(conn)?
            .active_session()
            .filter(|id| id.to_string() == session_uuid)
            .cloned())
    }

    /// Every transition rereads inside one immediate transaction instead of trusting an in-memory
    /// copy that another connection can have made stale. A failed write changes nothing.
    fn mutate(
        conn: &mut Connection,
        change: impl FnOnce(&mut LoginRecord) -> Result<(), String>,
    ) -> Result<LoginRecord, String> {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("begin app lifecycle transition: {e}"))?;
        let mut record = Self::read(&tx)?;
        change(&mut record)?;
        app_state::put(&tx, LIFECYCLE_STATE_KEY, &json(record.state.as_str()))?;
        match &record.session {
            Some(id) => app_state::put(&tx, SESSION_UUID_KEY, &json(&id.to_string()))?,
            None => app_state::remove(&tx, SESSION_UUID_KEY)?,
        }
        if record.state == LifecycleState::SignedOut {
            app_state::remove(&tx, "forwardRecentThreads")?;
            app_state::remove(&tx, "cacheRebuild")?;
        }
        tx.commit()
            .map_err(|e| format!("commit app lifecycle transition: {e}"))?;
        Ok(record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(path: &Path) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS app_state (
            key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .unwrap();
        conn
    }

    fn signed_out(path: &Path) -> Connection {
        let mut conn = open(path);
        SessionStore::initialize(&mut conn, true).unwrap();
        conn
    }

    #[test]
    fn initial_lifecycle_follows_server_configuration() {
        let mut conn = open(Path::new(":memory:"));
        assert!(SessionStore::read(&conn).unwrap_err().contains("missing"));
        SessionStore::initialize(&mut conn, false).unwrap();
        assert_eq!(
            SessionStore::read(&conn).unwrap(),
            LoginRecord { state: LifecycleState::Unconfigured, session: None }
        );
        // Committing a server configuration completes setup; later starts keep the record.
        SessionStore::initialize(&mut conn, true).unwrap();
        SessionStore::initialize(&mut conn, false).unwrap();
        assert_eq!(
            SessionStore::read(&conn).unwrap(),
            LoginRecord { state: LifecycleState::SignedOut, session: None }
        );
    }

    #[test]
    fn login_restores_only_for_its_own_generation_and_survives_a_restart() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preferences.sqlite");
        let mut conn = signed_out(&path);
        let id = LoginSessionId::new();
        assert_eq!(SessionStore::restore(&conn, &id.to_string()).unwrap(), None);
        let active = SessionStore::activate(&mut conn, &id).unwrap();
        assert_eq!(active.active_session(), Some(&id));
        // Repeating the completion of the same login changes nothing.
        assert_eq!(SessionStore::activate(&mut conn, &id).unwrap(), active);
        let other = LoginSessionId::new();
        assert!(SessionStore::activate(&mut conn, &other).is_err());
        assert_eq!(SessionStore::read(&conn).unwrap(), active);
        drop(conn);

        let conn = open(&path);
        assert_eq!(SessionStore::read(&conn).unwrap(), active);
        assert_eq!(
            SessionStore::restore(&conn, &id.to_string()).unwrap(),
            Some(id.clone())
        );
        assert_eq!(SessionStore::restore(&conn, &other.to_string()).unwrap(), None);
        assert_eq!(SessionStore::restore(&conn, "").unwrap(), None);
        // Only the lifecycle and its identity are recorded; no credential or credential hash.
        let keys: Vec<String> = conn
            .prepare("SELECT key FROM app_state ORDER BY key")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(keys, ["lifecycleState", "sessionUuid"]);
    }

    #[test]
    fn an_unfinished_decision_leaves_the_login_active() {
        let mut stale = signed_out(Path::new(":memory:"));
        let id = LoginSessionId::new();
        SessionStore::activate(&mut stale, &id).unwrap();
        let successor = LoginSessionId::new();
        // A stale reader can neither end the login nor activate another one over it.
        assert!(SessionStore::begin_cleaning(&mut stale, &successor).is_err());
        assert!(SessionStore::activate(&mut stale, &successor).is_err());
        assert!(SessionStore::finish_cleaning(&mut stale).is_err());
        assert_eq!(SessionStore::read(&stale).unwrap().active_session(), Some(&id));
    }

    #[test]
    fn cleanup_is_durable_across_a_restart_and_blocks_logins_until_finished() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preferences.sqlite");
        let mut conn = signed_out(&path);
        let id = LoginSessionId::new();
        SessionStore::activate(&mut conn, &id).unwrap();
        let cleaning = SessionStore::begin_cleaning(&mut conn, &id).unwrap();
        assert_eq!(cleaning.state, LifecycleState::Cleaning);
        assert_eq!(cleaning.cleaning_session(), Some(&id));
        assert!(cleaning.active_session().is_none());
        assert_eq!(SessionStore::begin_cleaning(&mut conn, &id).unwrap(), cleaning);
        assert!(SessionStore::activate(&mut conn, &LoginSessionId::new()).is_err());
        drop(conn);

        // The process dies after deletion was decided: no work is admitted and the identity
        // survives only as long as the deletion needs it.
        let mut conn = open(&path);
        assert_eq!(SessionStore::read(&conn).unwrap(), cleaning);
        assert_eq!(SessionStore::restore(&conn, &id.to_string()).unwrap(), None);
        assert!(SessionStore::activate(&mut conn, &LoginSessionId::new()).is_err());
        assert_eq!(
            SessionStore::finish_cleaning(&mut conn).unwrap(),
            LoginRecord { state: LifecycleState::SignedOut, session: None }
        );
        assert!(SessionStore::finish_cleaning(&mut conn).is_err());
        let fresh = LoginSessionId::new();
        assert_eq!(
            SessionStore::activate(&mut conn, &fresh).unwrap().active_session(),
            Some(&fresh)
        );
    }

    #[test]
    fn cleanup_removes_login_metadata_but_keeps_installation_state_and_settings() {
        let mut conn = signed_out(Path::new(":memory:"));
        conn.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY, value_json TEXT);
            INSERT INTO settings VALUES('theme', '\"dark\"');").unwrap();
        for (key, value) in [
            ("forwardRecentThreads", "[7]"),
            ("cacheRebuild", "\"attempted\""),
            ("pushDeviceId", "\"installation\""),
            ("serverConfig", "{\"primary\":\"https://example.test\"}"),
        ] {
            app_state::put(&conn, key, value).unwrap();
        }
        let id = LoginSessionId::new();
        SessionStore::activate(&mut conn, &id).unwrap();
        SessionStore::begin_cleaning(&mut conn, &id).unwrap();
        SessionStore::finish_cleaning(&mut conn).unwrap();
        assert!(app_state::get(&conn, "forwardRecentThreads").unwrap().is_none());
        assert!(app_state::get(&conn, "cacheRebuild").unwrap().is_none());
        assert_eq!(app_state::get(&conn, "pushDeviceId").unwrap().as_deref(), Some("\"installation\""));
        assert!(app_state::get(&conn, "serverConfig").unwrap().is_some());
        assert_eq!(conn.query_row("SELECT value_json FROM settings WHERE key='theme'", [], |row| row.get::<_, String>(0)).unwrap(), "\"dark\"");
    }

    #[test]
    fn a_failed_transition_write_keeps_the_previous_lifecycle() {
        let mut conn = signed_out(Path::new(":memory:"));
        let id = LoginSessionId::new();
        conn.execute_batch(
            "CREATE TRIGGER fail_lifecycle_write BEFORE UPDATE ON app_state
             BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;",
        )
        .unwrap();
        assert!(SessionStore::activate(&mut conn, &id).is_err());
        assert_eq!(SessionStore::read(&conn).unwrap().state, LifecycleState::SignedOut);
        assert_eq!(SessionStore::restore(&conn, &id.to_string()).unwrap(), None);
        conn.execute_batch("DROP TRIGGER fail_lifecycle_write;").unwrap();
        SessionStore::activate(&mut conn, &id).unwrap();
        assert_eq!(
            SessionStore::restore(&conn, &id.to_string()).unwrap(),
            Some(id)
        );
    }

    #[test]
    fn damaged_records_fail_closed() {
        for invalid in [
            "../other.sqlite",
            "00000000-0000-0000-0000-000000000000",
            "550E8400-E29B-41D4-A716-446655440000",
        ] {
            assert!(LoginSessionId::try_from(invalid.to_string()).is_err());
        }
        let mut conn = signed_out(Path::new(":memory:"));
        let id = LoginSessionId::new();
        SessionStore::activate(&mut conn, &id).unwrap();
        for (key, value) in [
            (SESSION_UUID_KEY, json("not-a-uuid")),
            (LIFECYCLE_STATE_KEY, json("revoking")),
            (LIFECYCLE_STATE_KEY, "active".to_string()),
        ] {
            conn.execute(
                "INSERT INTO app_state(key,value) VALUES(?1,?2)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [key, value.as_str()],
            )
            .unwrap();
            assert!(SessionStore::read(&conn).is_err(), "{key}={value}");
            assert!(SessionStore::restore(&conn, &id.to_string()).is_err());
            assert!(SessionStore::begin_cleaning(&mut conn, &id).is_err());
            conn.execute(
                "UPDATE app_state SET value=?1 WHERE key=?2",
                [json("active").as_str(), LIFECYCLE_STATE_KEY],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO app_state(key,value) VALUES(?1,?2)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [SESSION_UUID_KEY, json(&id.to_string()).as_str()],
            )
            .unwrap();
        }
    }
}
