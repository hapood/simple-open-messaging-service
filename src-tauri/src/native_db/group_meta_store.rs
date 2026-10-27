use rusqlite::{params, Connection, OptionalExtension};

pub(super) const SCHEMA: &str = r#"
CREATE TABLE group_meta (
  user_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL,
  member_count INTEGER NOT NULL DEFAULT 0 CHECK(member_count >= 0),
  feed_id TEXT NOT NULL DEFAULT '0',
  announcement_feed_id TEXT,
  announcement_text TEXT,
  announcement_created_at INTEGER CHECK(announcement_created_at IS NULL OR announcement_created_at >= 0),
  announcement_origin_created_at INTEGER CHECK(announcement_origin_created_at IS NULL OR announcement_origin_created_at >= 0),
  recovery_through TEXT,
  recovery_announcement_feed_id TEXT,
  recovery_announcement_text TEXT,
  recovery_announcement_created_at INTEGER CHECK(recovery_announcement_created_at IS NULL OR recovery_announcement_created_at >= 0),
  recovery_announcement_origin_created_at INTEGER CHECK(recovery_announcement_origin_created_at IS NULL OR recovery_announcement_origin_created_at >= 0),
  PRIMARY KEY(user_id,thread_id),
  FOREIGN KEY(user_id,thread_id) REFERENCES threads(user_id,thread_id) ON DELETE CASCADE,
  CHECK(announcement_feed_id IS NOT NULL OR announcement_text IS NULL),
  CHECK(announcement_created_at IS NOT NULL OR announcement_feed_id IS NULL),
  CHECK(recovery_announcement_feed_id IS NOT NULL OR recovery_announcement_text IS NULL),
  CHECK(recovery_announcement_created_at IS NOT NULL OR recovery_announcement_feed_id IS NULL)
);
"#;

pub(super) struct GroupMetaState {
    pub member_count: i64,
    pub feed_id: String,
    pub announcement_feed_id: Option<String>,
    pub announcement_text: Option<String>,
    pub announcement_created_at: Option<i64>,
    pub announcement_origin_created_at: Option<i64>,
    pub recovery_through: Option<String>,
    pub recovery_announcement_feed_id: Option<String>,
    pub recovery_announcement_text: Option<String>,
    pub recovery_announcement_created_at: Option<i64>,
    pub recovery_announcement_origin_created_at: Option<i64>,
}

pub(super) fn read(
    conn: &Connection,
    user_id: i64,
    thread_id: i64,
) -> Result<GroupMetaState, String> {
    conn.query_row(
        "SELECT member_count,feed_id,announcement_feed_id,announcement_text,
                announcement_created_at,announcement_origin_created_at,
                recovery_through,recovery_announcement_feed_id,recovery_announcement_text,
                recovery_announcement_created_at,recovery_announcement_origin_created_at
         FROM group_meta WHERE user_id=?1 AND thread_id=?2",
        params![user_id, thread_id],
        |row| {
            Ok(GroupMetaState {
                member_count: row.get(0)?,
                feed_id: row.get(1)?,
                announcement_feed_id: row.get(2)?,
                announcement_text: row.get(3)?,
                announcement_created_at: row.get(4)?,
                announcement_origin_created_at: row.get(5)?,
                recovery_through: row.get(6)?,
                recovery_announcement_feed_id: row.get(7)?,
                recovery_announcement_text: row.get(8)?,
                recovery_announcement_created_at: row.get(9)?,
                recovery_announcement_origin_created_at: row.get(10)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("read group meta: {e}"))?
    .ok_or_else(|| "stored group thread is missing its meta row".into())
}

/// Commit only Meta-owned facts. Thread identity, preferences and attention are
/// intentionally absent from this operation, even when the caller read them.
pub(super) fn commit(
    conn: &Connection,
    user_id: i64,
    thread_id: i64,
    state: &GroupMetaState,
) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE group_meta SET member_count=?3,feed_id=?4,
           announcement_feed_id=?5,announcement_text=?6,
           announcement_created_at=?7,announcement_origin_created_at=?8,recovery_through=?9,
           recovery_announcement_feed_id=?10,recovery_announcement_text=?11,
           recovery_announcement_created_at=?12,recovery_announcement_origin_created_at=?13
         WHERE user_id=?1 AND thread_id=?2",
            params![
                user_id,
                thread_id,
                state.member_count,
                state.feed_id,
                state.announcement_feed_id,
                state.announcement_text,
                state.announcement_created_at,
                state.announcement_origin_created_at,
                state.recovery_through,
                state.recovery_announcement_feed_id,
                state.recovery_announcement_text,
                state.recovery_announcement_created_at,
                state.recovery_announcement_origin_created_at,
            ],
        )
        .map_err(|e| format!("commit group meta: {e}"))?;
    if changed != 1 {
        return Err("stored group thread is missing its meta row".into());
    }
    Ok(())
}
