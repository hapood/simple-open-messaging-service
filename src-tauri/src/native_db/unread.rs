//! Shared native unread projection. Platform badge adapters only render this total.
use rusqlite::Connection;

pub(crate) fn unread_total(conn: &Connection, user_id: i64) -> Result<i64, String> {
    if user_id <= 0 {
        return Err("invalid badge account".into());
    }
    // Match conversation-list counts, including muted conversations. The stored
    // counts already incorporate local optimistic reads; previews are irrelevant.
    conn.query_row(
        "SELECT COALESCE(SUM(MAX(unread_count, 0)), 0) FROM threads WHERE user_id=?1 AND thread_feed_id>0",
        [user_id],
        |row| row.get(0),
    ).map_err(|error| format!("read native unread total: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn total_is_account_scoped_and_includes_muted_threads_without_previews() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE threads(user_id INTEGER,thread_feed_id INTEGER,unread_count INTEGER,muted INTEGER);
             INSERT INTO threads VALUES(1,1,8,0),(1,2,3,1),(2,1,99,0),(1,0,50,0),(1,3,-2,0);",
        ).unwrap();
        assert_eq!(unread_total(&conn, 1).unwrap(), 11);
        assert_eq!(unread_total(&conn, 2).unwrap(), 99);
        assert_eq!(unread_total(&conn, 3).unwrap(), 0);
        assert!(unread_total(&conn, 0).is_err());
        conn.execute("UPDATE threads SET unread_count=0 WHERE user_id=1", []).unwrap();
        assert_eq!(unread_total(&conn, 1).unwrap(), 0);
    }
}
