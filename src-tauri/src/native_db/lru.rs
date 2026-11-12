//! Bounded in-memory recency cache shared by the profile and namespace watch
//! cores. Mirrors the web repositories' LRU semantics: a read promotes the
//! entry, an insert evicts the least-recently-used one, and keys embed the
//! owning login connection so a stale login's entries age out through capacity
//! instead of being served to a successor session.

use std::collections::{HashMap, VecDeque};

/// Generation-tagged LRU. The recency deque may hold superseded slots after a
/// promote; eviction skips slots whose generation no longer matches the map, so
/// every operation stays O(1) amortized without scanning for duplicates.
pub(super) struct RecencyLru<V> {
    capacity: usize,
    entries: HashMap<String, (V, u64)>,
    order: VecDeque<(String, u64)>,
    next_generation: u64,
}

impl<V: Clone> RecencyLru<V> {
    pub(super) fn new(capacity: usize) -> Self {
        Self {
            capacity,
            entries: HashMap::new(),
            order: VecDeque::new(),
            next_generation: 0,
        }
    }

    pub(super) fn get(&mut self, key: &str) -> Option<V> {
        let entry = self.entries.get_mut(key)?;
        self.next_generation += 1;
        entry.1 = self.next_generation;
        let promoted = (key.to_owned(), entry.1);
        let value = entry.0.clone();
        self.order.push_back(promoted);
        Some(value)
    }

    pub(super) fn insert(&mut self, key: String, value: V) {
        if self.capacity == 0 {
            return;
        }
        self.next_generation += 1;
        let generation = self.next_generation;
        self.entries.insert(key.clone(), (value, generation));
        self.order.push_back((key, generation));
        self.evict();
    }

    fn evict(&mut self) {
        while self.entries.len() > self.capacity {
            // A superseded slot has a stale generation and evicts nothing.
            let Some((key, generation)) = self.order.pop_front() else {
                break;
            };
            if self
                .entries
                .get(&key)
                .is_some_and(|(_, current)| *current == generation)
            {
                self.entries.remove(&key);
            }
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn promotes_reads_and_evicts_least_recently_used() {
        let mut lru = RecencyLru::new(2);
        lru.insert("a".into(), 1);
        lru.insert("b".into(), 2);
        assert_eq!(lru.get("a"), Some(1));
        lru.insert("c".into(), 3);
        assert_eq!(lru.get("b"), None);
        assert_eq!(lru.get("a"), Some(1));
        assert_eq!(lru.get("c"), Some(3));
        assert_eq!(lru.len(), 2);
    }

    #[test]
    fn inserting_an_existing_key_replaces_without_growing() {
        let mut lru = RecencyLru::new(2);
        lru.insert("a".into(), 1);
        lru.insert("b".into(), 2);
        lru.insert("a".into(), 10);
        lru.insert("c".into(), 3);
        assert_eq!(lru.get("a"), Some(10));
        assert_eq!(lru.get("b"), None);
        assert_eq!(lru.len(), 2);
    }
}
