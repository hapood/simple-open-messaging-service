//! Dock unread projection. Rust reads the login-owned durable projection; the renderer only wakes it.
use rusqlite::Connection;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default)]
struct BadgeRevision {
    requested: AtomicU64,
    published: AtomicU64,
}

impl BadgeRevision {
    fn advance(&self) -> u64 {
        self.requested.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_current(&self, revision: u64) -> bool {
        self.requested.load(Ordering::SeqCst) == revision
    }

    fn should_clear(&self, revision: u64) -> bool {
        self.published.load(Ordering::SeqCst) < revision
    }

    // Publication and clearing are serialized on the main thread.
    fn mark_published(&self, revision: u64) {
        self.published.store(revision, Ordering::SeqCst);
    }
}

fn unread_total(conn: &Connection, user_id: i64) -> Result<i64, String> {
    if user_id <= 0 {
        return Err("invalid badge account".into());
    }
    // Match the conversation list's message total, including muted conversations.
    // These counts already incorporate the local optimistic read projection.
    conn.query_row(
        "SELECT COALESCE(SUM(MAX(unread_count, 0)), 0) FROM threads WHERE user_id=?1 AND thread_feed_id>0",
        [user_id],
        |row| row.get(0),
    )
    .map_err(|error| format!("read Dock unread total: {error}"))
}

fn badge_label(count: i64) -> Option<String> {
    (count > 0).then(|| count.to_string())
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::ffi::{c_char, CString};
    use std::sync::OnceLock;

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    static REVISION: BadgeRevision = BadgeRevision {
        requested: AtomicU64::new(0),
        published: AtomicU64::new(0),
    };

    extern "C" {
        fn soms_macos_badge_set_label(label: *const c_char);
    }

    // Called only on the main thread, immediately after generation and login checks.
    fn present(count: i64) {
        let label =
            badge_label(count).map(|value| CString::new(value).expect("numeric badge label"));
        unsafe {
            soms_macos_badge_set_label(
                label
                    .as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
            );
        }
    }

    pub(crate) fn initialize(app: tauri::AppHandle) {
        let _ = APP.set(app);
        reset();
    }

    /// Invalidate outstanding reads synchronously; clear without relying on a live renderer.
    pub(crate) fn reset() {
        let revision = REVISION.advance();
        if let Some(app) = APP.get() {
            if let Err(error) = app.run_on_main_thread(move || {
                // A pending or failed refresh must not cancel logout's clear. Only a newer
                // badge actually published on this thread may supersede it.
                if REVISION.should_clear(revision) {
                    present(0);
                    REVISION.mark_published(revision);
                }
            }) {
                log::warn!("clear Dock badge: {error}");
            }
        }
    }

    pub(crate) async fn refresh(
        app: tauri::AppHandle,
        session_uuid: String,
        user_id: i64,
    ) -> Result<(), String> {
        let expected = crate::login_session_store::LoginSessionId::try_from(session_uuid)?;
        let work = super::super::capture_database_work()?;
        if work.owner().id() != &expected {
            return Err("native badge login superseded".into());
        }
        let revision = REVISION.advance();
        let query_work = work.clone();
        let count = super::super::spawn_owned_database(Ok(query_work), move |conn| {
            unread_total(conn, user_id)
        })
        .await
        .map_err(|error| format!("join Dock unread projection: {error}"))??;
        app.run_on_main_thread(move || {
            // Validate on the actual publication thread, not before queuing platform work.
            // No lifecycle or database lock spans the OS operation.
            if REVISION.is_current(revision) && work.assert_current().is_ok() {
                present(count);
                REVISION.mark_published(revision);
            }
        })
        .map_err(|error| format!("publish Dock badge: {error}"))
    }
}

#[cfg(target_os = "macos")]
pub(crate) use macos::{initialize, refresh, reset};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unread_total_is_account_scoped_and_counts_muted_threads_without_preview_data() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE threads(user_id INTEGER,thread_feed_id INTEGER,unread_count INTEGER,muted INTEGER);
             INSERT INTO threads VALUES(1,1,8,0),(1,2,3,1),(2,1,99,0),(1,0,50,0),(1,3,-2,0);",
        ).unwrap();
        assert_eq!(unread_total(&conn, 1).unwrap(), 11);
        assert_eq!(unread_total(&conn, 2).unwrap(), 99);
        assert_eq!(unread_total(&conn, 3).unwrap(), 0);
        assert!(unread_total(&conn, 0).is_err());
        conn.execute("UPDATE threads SET unread_count=0 WHERE user_id=1", [])
            .unwrap();
        assert_eq!(unread_total(&conn, 1).unwrap(), 0);
    }

    #[test]
    fn zero_clears_the_label_and_positive_totals_are_not_truncated() {
        assert_eq!(badge_label(0), None);
        assert_eq!(badge_label(-1), None);
        assert_eq!(badge_label(1).as_deref(), Some("1"));
        assert_eq!(badge_label(1234).as_deref(), Some("1234"));
    }

    #[test]
    fn pending_or_failed_refresh_cannot_cancel_logout_clear() {
        let revisions = BadgeRevision::default();
        let clear = revisions.advance();
        let refresh = revisions.advance();
        assert!(revisions.should_clear(clear));
        revisions.mark_published(refresh);
        assert!(!revisions.should_clear(clear));
    }

    #[test]
    fn reset_or_new_refresh_invalidates_older_queued_publication() {
        let revisions = BadgeRevision::default();
        let old_read = revisions.advance();
        let logout_clear = revisions.advance();
        assert!(!revisions.is_current(old_read));
        assert!(revisions.is_current(logout_clear));
        let next_login = revisions.advance();
        assert!(!revisions.is_current(logout_clear));
        assert!(revisions.is_current(next_login));
    }
}
