use std::sync::{RwLock, RwLockWriteGuard};

/// Serializes deliberate cache repair with admitted owner callbacks. Network work never holds it.
/// Login identity and cancellation are owned by the captured `DatabaseWork`, not by this lock.
pub(super) struct CacheLifetime {
    access: RwLock<()>,
}

impl CacheLifetime {
    pub(super) const fn new() -> Self {
        Self {
            access: RwLock::new(()),
        }
    }

    /// Exclude schema replacement while a UUID-owned database callback runs.
    pub(super) fn with_cache_access<T>(
        &self,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _guard = self
            .access
            .read()
            .map_err(|_| "cache maintenance lock poisoned")?;
        operation()
    }

    /// Keep the exclusive guard until deletion/recreation finishes, including on failure.
    pub(super) fn invalidate(&self) -> Result<RwLockWriteGuard<'_, ()>, String> {
        self.access
            .write()
            .map_err(|_| "cache maintenance lock poisoned".into())
    }
}

pub(super) static CACHE_LIFETIME: CacheLifetime = CacheLifetime::new();

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repair_excludes_admitted_cache_access_until_completion() {
        let lifetime = CacheLifetime::new();
        let admitted = lifetime.with_cache_access(|| {
            assert!(lifetime.access.try_write().is_err());
            Ok::<_, String>(())
        });
        assert!(admitted.is_ok());
        let replacement = lifetime.invalidate().unwrap();
        assert!(lifetime.access.try_read().is_err());
        drop(replacement);
        assert!(lifetime.access.try_read().is_ok());
    }
}
