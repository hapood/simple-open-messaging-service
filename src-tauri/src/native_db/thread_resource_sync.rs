//! Durable resource targets are independent of conversation materialization.
use rusqlite::{params, Connection};

pub(super) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS thread_resource_sync (
  user_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL CHECK(thread_id > 0),
  message_end_seq INTEGER NOT NULL DEFAULT 0 CHECK(message_end_seq >= 0),
  tombstone_end_seq INTEGER NOT NULL DEFAULT 0 CHECK(tombstone_end_seq >= 0),
  group_meta_feed_end_id TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY(user_id, thread_id)
);
"#;

/// Call inside the feed-page transaction, alongside its cursor commit.
/// Decimal meta coordinates are compared without narrowing them to SQLite integers.
pub(super) fn advance(
    conn: &Connection,
    user_id: i64,
    thread_id: i64,
    message_end_seq: i64,
    tombstone_end_seq: i64,
    group_meta_feed_end_id: &str,
) -> Result<(), String> {
    let meta = group_meta_feed_end_id.parse::<u64>()
        .map_err(|_| "invalid group meta target".to_string())?;
    if user_id <= 0 || thread_id <= 0 || message_end_seq < 0 || tombstone_end_seq < 0
        || meta.to_string() != group_meta_feed_end_id {
        return Err("invalid thread resource target".into());
    }
    conn.execute(
        "INSERT INTO thread_resource_sync(user_id,thread_id,message_end_seq,tombstone_end_seq,group_meta_feed_end_id)
         VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(user_id,thread_id) DO UPDATE SET
           message_end_seq=MAX(message_end_seq,excluded.message_end_seq),
           tombstone_end_seq=MAX(tombstone_end_seq,excluded.tombstone_end_seq),
           group_meta_feed_end_id=CASE
             WHEN length(excluded.group_meta_feed_end_id)>length(group_meta_feed_end_id)
               OR (length(excluded.group_meta_feed_end_id)=length(group_meta_feed_end_id)
                   AND excluded.group_meta_feed_end_id>group_meta_feed_end_id)
             THEN excluded.group_meta_feed_end_id ELSE group_meta_feed_end_id END",
        params![user_id, thread_id, message_end_seq, tombstone_end_seq, group_meta_feed_end_id],
    ).map_err(|e| format!("advance thread resource targets: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_precede_threads_and_never_regress() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        advance(&conn, 1, 42, 0, 8, "9007199254740993").unwrap();
        advance(&conn, 1, 42, 20, 0, "99").unwrap();
        advance(&conn, 1, 42, 19, 7, "0").unwrap();
        let targets: (i64, i64, String) = conn.query_row(
            "SELECT message_end_seq,tombstone_end_seq,group_meta_feed_end_id
             FROM thread_resource_sync WHERE user_id=1 AND thread_id=42",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(targets, (20, 8, "9007199254740993".into()));
    }

    #[test]
    fn target_write_rolls_back_with_its_feed_transaction() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        {
            let tx = conn.transaction().unwrap();
            advance(&tx, 1, 42, 20, 8, "100").unwrap();
        }
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM thread_resource_sync", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
        assert!(advance(&conn, 1, 42, 0, 0, "01").is_err());
        assert!(advance(&conn, 1, 42, -1, 0, "0").is_err());
    }
}
