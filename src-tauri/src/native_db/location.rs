use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

const PREFERENCES_FILENAME: &str = "soms-local.sqlite3";
/// Process-wide location shared by the background runtime and the application shell.
/// Account cache replacement changes the contents, never the location.
pub(super) struct DatabaseLocation(OnceLock<PathBuf>);

impl DatabaseLocation {
    const fn new() -> Self {
        Self(OnceLock::new())
    }

    fn initialize(&self, directory: &Path) -> Result<&Path, String> {
        if !directory.is_absolute() {
            return Err("native database directory must be absolute".into());
        }
        std::fs::create_dir_all(directory).map_err(|e| format!("create app data: {e}"))?;
        let directory =
            std::fs::canonicalize(directory).map_err(|e| format!("resolve app data: {e}"))?;
        let candidate = directory.join(PREFERENCES_FILENAME);
        let current = self.0.get_or_init(|| candidate.clone());
        if current != &candidate {
            return Err(
                "native database location already initialized with a different directory".into(),
            );
        }
        Ok(current)
    }

    fn path(&self) -> Result<&Path, String> {
        self.0
            .get()
            .map(PathBuf::as_path)
            .ok_or_else(|| "native database location is not initialized".into())
    }
}

static LOCATION: DatabaseLocation = DatabaseLocation::new();

pub(crate) fn initialize(directory: &Path) -> Result<&Path, String> {
    LOCATION.initialize(directory)
}

pub(super) fn path() -> Result<&'static Path, String> {
    LOCATION.path()
}

/// The directory holding every native database file (preferences + per-login caches).
pub(super) fn directory() -> Result<PathBuf, String> {
    Ok(path()?
        .parent()
        .ok_or("native database location has no parent directory")?
        .to_path_buf())
}

/// The active per-login cache file, resolved from the durable login journal on first use and
/// switched only by fresh-login preparation. Cache commands never guess a filename: an unreadable
/// or signed-out journal yields an error, not a default cache.
static ACTIVE_CACHE: RwLock<Option<PathBuf>> = RwLock::new(None);

pub(super) fn activate_cache(path: PathBuf) {
    if let Ok(mut active) = ACTIVE_CACHE.write() {
        *active = Some(path);
    }
}

pub(super) fn active_cache_path() -> Result<PathBuf, String> {
    if let Ok(active) = ACTIVE_CACHE.read() {
        if let Some(path) = active.as_ref() {
            return Ok(path.clone());
        }
    }
    let resolved = resolve_active_cache_from_journal()?;
    if let Ok(mut active) = ACTIVE_CACHE.write() {
        active.get_or_insert_with(|| resolved.clone());
    }
    Ok(resolved)
}

#[cfg(test)]
pub(super) fn reset_active_cache_for_tests() {
    if let Ok(mut active) = ACTIVE_CACHE.write() {
        *active = None;
    }
}

fn resolve_active_cache_from_journal() -> Result<PathBuf, String> {
    let conn = super::open_preferences()?;
    let journal = crate::login_session_store::SessionStore::read(&conn)?
        .ok_or("native login journal is missing: no active login cache")?;
    let id = journal
        .active_session()
        .ok_or("native login is signed out: no active login cache")?;
    Ok(directory()?.join(id.sqlite_filename()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_and_shell_reuse_one_location_without_creating_a_database() {
        let temp = tempfile::tempdir().unwrap();
        let location = DatabaseLocation::new();
        assert!(location.path().is_err());
        let expected = temp
            .path()
            .canonicalize()
            .unwrap()
            .join(PREFERENCES_FILENAME);
        assert_eq!(location.initialize(temp.path()).unwrap(), expected);
        assert_eq!(
            location.initialize(&temp.path().join(".")).unwrap(),
            expected
        );
        assert_eq!(location.path().unwrap(), expected);
        assert!(!expected.exists());
    }

    #[test]
    fn refuses_a_second_database_directory() {
        let temp = tempfile::tempdir().unwrap();
        let location = DatabaseLocation::new();
        location.initialize(temp.path()).unwrap();
        assert!(location.initialize(&temp.path().join("files")).is_err());
        assert!(location.initialize(Path::new("relative")).is_err());
        assert_eq!(
            location.path().unwrap(),
            temp.path()
                .canonicalize()
                .unwrap()
                .join(PREFERENCES_FILENAME)
        );
    }
}
