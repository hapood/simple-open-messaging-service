use std::sync::{
    atomic::{AtomicU64, Ordering},
    RwLock, RwLockReadGuard, RwLockWriteGuard,
};

/// Serializes cache replacement with admitted account-cache operations. Network work never holds it.
pub(super) struct CacheLifetime {
    epoch: RwLock<u64>,
    current: AtomicU64,
}

impl CacheLifetime {
    pub(super) const fn new() -> Self {
        Self {
            epoch: RwLock::new(0),
            current: AtomicU64::new(0),
        }
    }

    pub(super) fn capture(&self) -> Result<u64, String> {
        self.epoch
            .read()
            .map(|epoch| *epoch)
            .map_err(|_| "cache lifetime poisoned".into())
    }

    pub(super) fn admit(&self, epoch: u64) -> Result<RwLockReadGuard<'_, u64>, String> {
        let guard = self.epoch.read().map_err(|_| "cache lifetime poisoned")?;
        if *guard != epoch {
            return Err("account cache lifetime expired".into());
        }
        Ok(guard)
    }

    fn run<T>(
        &self,
        epoch: u64,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _guard = self.admit(epoch)?;
        operation()
    }

    /// Publication fencing is nonblocking even while a replacement holds the database lock.
    pub(super) fn is_current(&self, epoch: u64) -> bool {
        self.current.load(Ordering::Acquire) == epoch
    }

    /// Keep the exclusive guard until deletion/recreation finishes, including on failure.
    pub(super) fn invalidate(&self) -> Result<RwLockWriteGuard<'_, u64>, String> {
        let mut guard = self.epoch.write().map_err(|_| "cache lifetime poisoned")?;
        *guard = guard.checked_add(1).ok_or("cache lifetime exhausted")?;
        self.current.store(*guard, Ordering::Release);
        Ok(guard)
    }
}

pub(super) static CACHE_LIFETIME: CacheLifetime = CacheLifetime::new();

/// Capture before scheduling: a queued operation must not acquire a replacement cache's epoch.
pub(super) fn spawn<T, F>(operation: F) -> tauri::async_runtime::JoinHandle<Result<T, String>>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    spawn_at(CACHE_LIFETIME.capture(), operation)
}

/// Source-level network tasks pass their original epoch through every page commit.
pub(super) fn spawn_at<T, F>(
    epoch: Result<u64, String>,
    operation: F,
) -> tauri::async_runtime::JoinHandle<Result<T, String>>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let run = crate::realtime::WORK_RUN.try_with(Clone::clone).ok();
    tauri::async_runtime::spawn_blocking(move || {
        if run.as_ref().is_some_and(|run| !run.authenticated()) {
            return Err("realtime work lease expired".into());
        }
        CACHE_LIFETIME.run(epoch?, operation)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queued_old_operation_never_runs_against_replacement_data() {
        let lifetime = CacheLifetime::new();
        let queued_epoch = lifetime.capture().unwrap();
        drop(lifetime.invalidate().unwrap());
        let mut wrote = false;
        let result = lifetime.run(queued_epoch, || {
            wrote = true;
            Ok(())
        });
        assert_eq!(result.unwrap_err(), "account cache lifetime expired");
        assert!(!wrote);
    }

    #[test]
    fn operation_keeps_guard_until_completion_and_releases_it_on_error() {
        let lifetime = CacheLifetime::new();
        let result: Result<(), String> = lifetime.run(lifetime.capture().unwrap(), || {
            assert!(lifetime.epoch.try_write().is_err());
            Err("transaction failed".into())
        });
        assert_eq!(result.unwrap_err(), "transaction failed");
        assert!(lifetime.epoch.try_write().is_ok());
    }

    #[test]
    fn replacement_rejects_old_work_even_after_a_failed_cleanup() {
        let lifetime = CacheLifetime::new();
        let old = lifetime.capture().unwrap();
        drop(lifetime.invalidate().unwrap());
        assert!(lifetime.admit(old).is_err());
        assert!(lifetime.admit(lifetime.capture().unwrap()).is_ok());
    }

    #[test]
    fn admitted_commit_excludes_replacement() {
        let lifetime = CacheLifetime::new();
        let epoch = lifetime.capture().unwrap();
        let commit = lifetime.admit(epoch).unwrap();
        assert!(lifetime.epoch.try_write().is_err());
        drop(commit);
        let replacement = lifetime.invalidate().unwrap();
        assert!(lifetime.epoch.try_read().is_err());
        assert!(!lifetime.is_current(epoch));
        assert!(lifetime.is_current(*replacement));
        drop(replacement);
        assert!(lifetime.admit(epoch).is_err());
    }
}
