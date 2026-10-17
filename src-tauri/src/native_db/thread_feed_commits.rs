use std::sync::{Arc, Mutex, Weak};

use super::attention::LocalThreadAttention;

pub(super) struct ThreadFeedCommit<'a> {
    pub user_id: i64,
    pub epoch: u64,
    pub states: &'a [LocalThreadAttention],
}

type Listener = dyn Fn(&ThreadFeedCommit<'_>) + Send + Sync;

/// Synchronous, lossless commit delivery. Subscription lifetime owns the listener;
/// callbacks run without the registry, database transaction, or cache lifetime lock.
#[derive(Default)]
pub(super) struct ThreadFeedCommits(Mutex<Vec<Weak<Listener>>>);

impl ThreadFeedCommits {
    pub fn subscribe(
        &self,
        listener: impl Fn(&ThreadFeedCommit<'_>) + Send + Sync + 'static,
    ) -> Arc<Listener> {
        let listener: Arc<Listener> = Arc::new(listener);
        let mut listeners = self.0.lock().expect("thread commit subscribers poisoned");
        listeners.retain(|listener| listener.strong_count() > 0);
        listeners.push(Arc::downgrade(&listener));
        listener
    }

    pub fn publish(&self, commit: &ThreadFeedCommit<'_>) {
        let listeners: Vec<_> = self
            .0
            .lock()
            .expect("thread commit subscribers poisoned")
            .iter()
            .filter_map(Weak::upgrade)
            .collect();
        for listener in listeners {
            listener(commit);
        }
    }
}

pub(super) static THREAD_FEED_COMMITS: ThreadFeedCommits =
    ThreadFeedCommits(Mutex::new(Vec::new()));

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn synchronous_delivery_and_subscription_drop() {
        let commits = Arc::new(ThreadFeedCommits::default());
        let count = Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        let registry = commits.clone();
        let subscription = commits.subscribe(move |commit| {
            assert_eq!((commit.user_id, commit.epoch), (7, 3));
            assert!(registry.0.try_lock().is_ok());
            observed.fetch_add(1, Ordering::SeqCst);
        });
        let commit = ThreadFeedCommit {
            user_id: 7,
            epoch: 3,
            states: &[],
        };
        commits.publish(&commit);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        drop(subscription);
        commits.publish(&commit);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
}
