use rusqlite::{params, types::Value as SqlValue, Connection};
use serde_json::Value;

/// Local operations write only their explicitly supplied columns. Feed coordinates,
/// profile snapshots and Group Meta state are never accepted through this path.
pub(super) fn apply(
    conn: &Connection,
    user_id: i64,
    thread_id: i64,
    patch: &Value,
) -> Result<(), String> {
    let patch = patch.as_object().ok_or("thread patch must be an object")?;
    let mut updates = Vec::new();
    for (key, value) in patch {
        let (column, value) = match key.as_str() {
            "muted" | "pinned" | "blocked" => {
                let column = match key.as_str() {
                    "muted" => "muted",
                    "pinned" => "pinned",
                    _ => "blocked",
                };
                let value = value.as_bool().ok_or("thread patch requires a boolean")?;
                (column, SqlValue::Integer(i64::from(value)))
            }
            "pinnedAt" => {
                let value = if value.is_null() {
                    SqlValue::Null
                } else {
                    SqlValue::Integer(
                        value
                            .as_i64()
                            .filter(|v| *v >= 0)
                            .ok_or("invalid pin timestamp")?,
                    )
                };
                ("pinned_at", value)
            }
            "conversationState" => {
                let value = value
                    .as_str()
                    .filter(|v| matches!(*v, "ACTIVE" | "READ_ONLY"))
                    .ok_or("invalid conversation state")?;
                ("conversation_state", SqlValue::Text(value.to_owned()))
            }
            "announcementReadFeedId" | "joinRequestReadFeedId" => {
                let value = value
                    .as_i64()
                    .filter(|v| *v >= 0)
                    .ok_or("invalid thread read position")?;
                let column = if key == "announcementReadFeedId" {
                    "announcement_read_feed_id"
                } else {
                    "join_request_read_feed_id"
                };
                (column, SqlValue::Integer(value))
            }
            _ => return Err(format!("unsupported local thread field: {key}")),
        };
        updates.push((column, value));
    }
    // Validate all fields before the first write; callers own the transaction.
    for (column, value) in updates {
        let sql = match column {
            "announcement_read_feed_id" =>
                "UPDATE threads SET announcement_read_feed_id=MAX(announcement_read_feed_id,?3) WHERE user_id=?1 AND thread_id=?2".to_owned(),
            "join_request_read_feed_id" =>
                "UPDATE threads SET join_request_read_feed_id=CASE WHEN join_request_read_feed_id<0 THEN join_request_read_feed_id ELSE MIN(join_request_end_feed_id,MAX(join_request_read_feed_id,?3)) END WHERE user_id=?1 AND thread_id=?2".to_owned(),
            _ => format!("UPDATE threads SET {column}=?3 WHERE user_id=?1 AND thread_id=?2"),
        };
        if conn
            .execute(&sql, params![user_id, thread_id, value])
            .map_err(|e| format!("patch local thread: {e}"))?
            == 0
        {
            return Err("cannot patch thread before feed state exists".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE threads(user_id INTEGER,thread_id INTEGER,
            pinned INTEGER,pinned_at INTEGER,muted INTEGER,blocked INTEGER,
            conversation_state TEXT,announcement_read_feed_id INTEGER,
            join_request_read_feed_id INTEGER,join_request_end_feed_id INTEGER,
            thread_feed_id INTEGER);
            INSERT INTO threads VALUES(1,7,0,NULL,1,0,'ACTIVE',8,2,5,99);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn pin_patch_preserves_unrelated_facts() {
        let conn = database();
        apply(&conn, 1, 7, &json!({"pinned":true,"pinnedAt":123})).unwrap();
        let row: (i64, i64, i64, i64) = conn
            .query_row(
                "SELECT pinned,pinned_at,muted,thread_feed_id FROM threads",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(row, (1, 123, 1, 99));
    }

    #[test]
    fn acknowledgements_are_monotone_and_bounded() {
        let conn = database();
        apply(
            &conn,
            1,
            7,
            &json!({"announcementReadFeedId":3,"joinRequestReadFeedId":20}),
        )
        .unwrap();
        let positions: (i64, i64) = conn
            .query_row(
                "SELECT announcement_read_feed_id,join_request_read_feed_id FROM threads",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(positions, (8, 5));
    }

    #[test]
    fn invalid_patch_cannot_partially_write() {
        let conn = database();
        assert!(apply(&conn, 1, 7, &json!({"pinned":true,"threadFeedId":100})).is_err());
        let pinned: i64 = conn
            .query_row("SELECT pinned FROM threads", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pinned, 0);
    }
}
