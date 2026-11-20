use std::collections::HashMap;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// Each operation owns its registration; finishing an older operation cannot remove a newer one.
#[derive(Default)]
pub(crate) struct UploadCancellations {
    tasks: HashMap<String, Vec<Arc<CancellationToken>>>,
}

impl UploadCancellations {
    pub(crate) fn register(&mut self, cid: &str) -> Arc<CancellationToken> {
        let token = Arc::new(CancellationToken::new());
        self.tasks.entry(cid.to_owned()).or_default().push(token.clone());
        token
    }

    pub(crate) fn finish(&mut self, cid: &str, token: &Arc<CancellationToken>) {
        if let Some(tokens) = self.tasks.get_mut(cid) {
            tokens.retain(|current| !Arc::ptr_eq(current, token));
            if tokens.is_empty() { self.tasks.remove(cid); }
        }
    }

    /// Take under the registry lock, then cancel outside it to avoid reentrant wakeups.
    pub(crate) fn take(&mut self, cid: &str) -> Vec<Arc<CancellationToken>> {
        self.tasks.remove(cid).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelling_a_gallery_cancels_every_active_part() {
        let mut registry = UploadCancellations::default();
        let first = registry.register("gallery");
        let second = registry.register("gallery");
        let other = registry.register("other");
        for token in registry.take("gallery") { token.cancel(); }
        assert!(first.is_cancelled());
        assert!(second.is_cancelled());
        assert!(!other.is_cancelled());
    }

    #[test]
    fn finishing_a_part_keeps_its_siblings_registered() {
        let mut registry = UploadCancellations::default();
        let first = registry.register("gallery");
        let second = registry.register("gallery");
        registry.finish("gallery", &first);
        let remaining = registry.take("gallery");
        assert_eq!(remaining.len(), 1);
        assert!(Arc::ptr_eq(&remaining[0], &second));
    }

    #[test]
    fn old_completion_cannot_remove_new_attempt() {
        let mut registry = UploadCancellations::default();
        let old = registry.register("task");
        for token in registry.take("task") { token.cancel(); }
        let new = registry.register("task");
        registry.finish("task", &old);
        let remaining = registry.take("task");
        assert_eq!(remaining.len(), 1);
        assert!(Arc::ptr_eq(&remaining[0], &new));
    }
}
