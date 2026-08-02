use super::{
    merge_covered_tail, merge_message_section, update_message_coverage, CoveredInterval,
    MessageSection,
};
use rusqlite::{params, Connection};
use std::time::{SystemTime, UNIX_EPOCH};

fn interval(left: i64, right: i64) -> Option<CoveredInterval> {
    Some(CoveredInterval { left, right })
}

#[test]
fn covered_tail_normalizes_and_selects_the_rightmost_disjoint_interval() {
    assert_eq!(merge_covered_tail(None, interval(9, 3)), interval(3, 9));
    assert_eq!(
        merge_covered_tail(interval(20, 30), interval(1, 10)),
        interval(20, 30)
    );
    assert_eq!(
        merge_covered_tail(interval(1, 10), interval(20, 30)),
        interval(20, 30)
    );
}

#[test]
fn covered_tail_merges_overlap_adjacency_containment_and_extensions() {
    for (incoming, expected) in [
        ((15, 18), (10, 20)),
        ((5, 10), (5, 20)),
        ((20, 25), (10, 25)),
        ((5, 25), (5, 25)),
        ((1, 9), (1, 20)),
        ((21, 30), (10, 30)),
    ] {
        assert_eq!(
            merge_covered_tail(interval(10, 20), interval(incoming.0, incoming.1)),
            interval(expected.0, expected.1)
        );
    }
}

fn coverage_connection() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory sqlite");
    conn.execute_batch(
        "CREATE TABLE messages(
           user_id INTEGER NOT NULL, thread_id INTEGER NOT NULL, seq INTEGER NOT NULL,
           section_left INTEGER, section_right INTEGER,
           PRIMARY KEY(user_id,thread_id,seq)
         );
         CREATE TABLE sync_state(
           user_id INTEGER NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
           PRIMARY KEY(user_id,key)
         );",
    )
    .expect("create coverage schema");
    conn
}

fn insert_message(conn: &Connection, seq: i64) {
    conn.execute(
        "INSERT INTO messages(user_id,thread_id,seq) VALUES(1,42,?1)",
        [seq],
    )
    .unwrap();
}

fn set_section(conn: &Connection, left: i64, right: i64) {
    conn.execute(
        "UPDATE messages SET section_left=1 WHERE user_id=1 AND thread_id=42 AND seq=?1",
        [left],
    )
    .unwrap();
    conn.execute(
        "UPDATE messages SET section_right=1 WHERE user_id=1 AND thread_id=42 AND seq=?1",
        [right],
    )
    .unwrap();
}

fn set_covered_tail(conn: &Connection, left: i64, right: i64) {
    let value = serde_json::to_string(&super::MessageCoverageState {
        thread_id: 42,
        known_newest_seq: right,
        covered_tail: interval(left, right),
    })
    .unwrap();
    conn.execute(
        "INSERT INTO sync_state(user_id,key,value_json) VALUES(1,'messageCoverage:42',?1)",
        [value],
    )
    .unwrap();
}

fn section_edges(conn: &Connection) -> Vec<(i64, Option<i64>, Option<i64>)> {
    conn.prepare(
        "SELECT seq,section_left,section_right FROM messages
         WHERE user_id=1 AND thread_id=42 AND (section_left=1 OR section_right=1)
         ORDER BY seq",
    )
    .unwrap()
    .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
    .unwrap()
    .collect::<Result<Vec<_>, _>>()
    .unwrap()
}

#[test]
fn sqlite_section_merge_bridges_multiple_intervals_and_clears_internal_edges() {
    let mut conn = coverage_connection();
    for seq in [10_i64, 20, 30, 40, 50, 60] {
        conn.execute(
            "INSERT INTO messages(user_id,thread_id,seq) VALUES(1,42,?1)",
            [seq],
        )
        .unwrap();
    }
    conn.execute(
        "UPDATE messages SET section_left=1 WHERE seq IN (10,30,50)",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE messages SET section_right=1 WHERE seq IN (20,40,60)",
        [],
    )
    .unwrap();
    let tx = conn.transaction().unwrap();
    let merged = merge_message_section(
        &tx,
        1,
        MessageSection {
            thread_id: 42,
            left: 18,
            right: 52,
        },
    )
    .unwrap();
    assert_eq!((merged.left, merged.right), (10, 60));
    tx.commit().unwrap();
    let edges = conn
        .prepare(
            "SELECT seq,section_left,section_right FROM messages
             WHERE section_left=1 OR section_right=1 ORDER BY seq",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(edges, vec![(10, Some(1), None), (60, None, Some(1))]);
}

#[test]
fn sqlite_coverage_keeps_lagging_tail_then_bridges_it() {
    let mut conn = coverage_connection();
    let tx = conn.transaction().unwrap();
    let initial = update_message_coverage(
        &tx,
        1,
        42,
        Some(20),
        Some(MessageSection {
            thread_id: 42,
            left: 10,
            right: 20,
        }),
    )
    .unwrap()
    .unwrap();
    assert_eq!(initial.covered_tail, interval(10, 20));
    let advanced = update_message_coverage(&tx, 1, 42, Some(25), None)
        .unwrap()
        .unwrap();
    assert_eq!(advanced.known_newest_seq, 25);
    assert_eq!(advanced.covered_tail, interval(10, 20));
    let bridged = update_message_coverage(
        &tx,
        1,
        42,
        Some(25),
        Some(MessageSection {
            thread_id: 42,
            left: 10,
            right: 25,
        }),
    )
    .unwrap()
    .unwrap();
    assert_eq!(bridged.covered_tail, interval(10, 25));
    tx.commit().unwrap();

    let json: String = conn
        .query_row(
            "SELECT value_json FROM sync_state WHERE user_id=?1 AND key=?2",
            params![1, "messageCoverage:42"],
            |row| row.get(0),
        )
        .unwrap();
    assert!(json.contains("\"knownNewestSeq\":25"));
    assert!(json.contains("\"coveredTail\""));
}

#[test]
fn sqlite_section_merge_changes_only_touched_boundaries() {
    let mut conn = coverage_connection();
    for seq in [1_i64, 5, 10, 20, 30, 40, 50, 60] {
        insert_message(&conn, seq);
    }
    for (left, right) in [(1, 5), (10, 20), (30, 40), (50, 60)] {
        set_section(&conn, left, right);
    }

    let tx = conn.transaction().unwrap();
    let merged = merge_message_section(
        &tx,
        1,
        MessageSection {
            thread_id: 42,
            left: 18,
            right: 32,
        },
    )
    .unwrap();
    assert_eq!((merged.left, merged.right), (10, 40));
    tx.commit().unwrap();

    assert_eq!(
        section_edges(&conn),
        vec![
            (1, Some(1), None),
            (5, None, Some(1)),
            (10, Some(1), None),
            (40, None, Some(1)),
            (50, Some(1), None),
            (60, None, Some(1)),
        ]
    );
}

#[test]
fn sqlite_section_merge_uses_covered_tail_fast_paths() {
    struct Case {
        tail: (i64, i64),
        incoming: (i64, i64),
        expected: (i64, i64),
        old_section: Option<(i64, i64)>,
        expected_edges: Vec<(i64, Option<i64>, Option<i64>)>,
    }

    for case in [
        // Contained: return the tail without touching its boundaries.
        Case {
            tail: (10, 20),
            incoming: (12, 18),
            expected: (10, 20),
            old_section: Some((10, 20)),
            expected_edges: vec![(10, Some(1), None), (20, None, Some(1))],
        },
        // Immediately right: join the tail without any neighbor resolution.
        Case {
            tail: (10, 20),
            incoming: (21, 25),
            expected: (10, 25),
            old_section: Some((10, 20)),
            expected_edges: vec![(10, Some(1), None), (25, None, Some(1))],
        },
        // Disjoint right: the new interval is the new right-most section.
        Case {
            tail: (10, 20),
            incoming: (30, 40),
            expected: (30, 40),
            old_section: Some((10, 20)),
            expected_edges: vec![
                (10, Some(1), None),
                (20, None, Some(1)),
                (30, Some(1), None),
                (40, None, Some(1)),
            ],
        },
        // Reaching the tail from the left resolves only the incoming left endpoint.
        Case {
            tail: (30, 40),
            incoming: (21, 29),
            expected: (10, 40),
            old_section: Some((10, 20)),
            expected_edges: vec![(10, Some(1), None), (40, None, Some(1))],
        },
    ] {
        let mut conn = coverage_connection();
        for seq in [10_i64, 12, 18, 20, 21, 25, 29, 30, 40] {
            insert_message(&conn, seq);
        }
        if let Some((left, right)) = case.old_section {
            set_section(&conn, left, right);
        }
        if case.tail != case.old_section.unwrap_or(case.tail) {
            set_section(&conn, case.tail.0, case.tail.1);
        }
        set_covered_tail(&conn, case.tail.0, case.tail.1);

        let tx = conn.transaction().unwrap();
        let merged = merge_message_section(
            &tx,
            1,
            MessageSection {
                thread_id: 42,
                left: case.incoming.0,
                right: case.incoming.1,
            },
        )
        .unwrap();
        assert_eq!((merged.left, merged.right), case.expected);
        tx.commit().unwrap();
        assert_eq!(section_edges(&conn), case.expected_edges);
    }
}

#[test]
fn sqlite_section_merge_rejects_unpaired_neighbor_edges() {
    let mut conn = coverage_connection();
    for seq in [10_i64, 20, 21] {
        insert_message(&conn, seq);
    }
    conn.execute(
        "UPDATE messages SET section_right=1 WHERE user_id=1 AND thread_id=42 AND seq=20",
        [],
    )
    .unwrap();

    let tx = conn.transaction().unwrap();
    let error = merge_message_section(
        &tx,
        1,
        MessageSection {
            thread_id: 42,
            left: 21,
            right: 21,
        },
    )
    .unwrap_err();
    assert!(error.contains("right edge has no left"));
}

#[test]
fn sqlite_single_message_section_sets_both_edges() {
    let mut conn = coverage_connection();
    insert_message(&conn, 7);
    let tx = conn.transaction().unwrap();
    let merged = merge_message_section(
        &tx,
        1,
        MessageSection {
            thread_id: 42,
            left: 7,
            right: 7,
        },
    )
    .unwrap();
    assert_eq!((merged.left, merged.right), (7, 7));
    tx.commit().unwrap();
    assert_eq!(section_edges(&conn), vec![(7, Some(1), Some(1))]);
}

#[test]
fn sqlite_coverage_keeps_the_rightmost_disjoint_tail() {
    let mut conn = coverage_connection();
    let tx = conn.transaction().unwrap();
    let first = update_message_coverage(
        &tx,
        1,
        42,
        Some(40),
        Some(MessageSection {
            thread_id: 42,
            left: 20,
            right: 30,
        }),
    )
    .unwrap()
    .unwrap();
    assert_eq!(first.covered_tail, interval(20, 30));
    let older = update_message_coverage(
        &tx,
        1,
        42,
        None,
        Some(MessageSection {
            thread_id: 42,
            left: 1,
            right: 10,
        }),
    )
    .unwrap()
    .unwrap();
    assert_eq!(older.covered_tail, interval(20, 30));
    let newer = update_message_coverage(
        &tx,
        1,
        42,
        None,
        Some(MessageSection {
            thread_id: 42,
            left: 35,
            right: 40,
        }),
    )
    .unwrap()
    .unwrap();
    assert_eq!(newer.covered_tail, interval(35, 40));
    tx.commit().unwrap();
}

#[test]
fn sqlite_failed_section_merge_rolls_back_edges_and_coverage() {
    let mut conn = coverage_connection();
    insert_message(&conn, 5);
    {
        let tx = conn.transaction().unwrap();
        let error = merge_message_section(
            &tx,
            1,
            MessageSection {
                thread_id: 42,
                left: 5,
                right: 10,
            },
        )
        .unwrap_err();
        assert!(error.contains("right edge affected no row"));
        // Dropping the uncommitted transaction is the same failure path used by native_db_put_messages.
    }
    assert!(section_edges(&conn).is_empty());
    let coverage_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM sync_state", [], |row| row.get(0))
        .unwrap();
    assert_eq!(coverage_count, 0);
}

#[test]
fn sqlite_committed_coverage_survives_reopen() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("soms-native-db-test-{nonce}.sqlite3"));
    {
        let mut conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE messages(
               user_id INTEGER NOT NULL, thread_id INTEGER NOT NULL, seq INTEGER NOT NULL,
               section_left INTEGER, section_right INTEGER,
               PRIMARY KEY(user_id,thread_id,seq)
             );
             CREATE TABLE sync_state(
               user_id INTEGER NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
               PRIMARY KEY(user_id,key)
             );",
        )
        .unwrap();
        for seq in [5_i64, 10] {
            insert_message(&conn, seq);
        }
        let tx = conn.transaction().unwrap();
        let merged = merge_message_section(
            &tx,
            1,
            MessageSection {
                thread_id: 42,
                left: 5,
                right: 10,
            },
        )
        .unwrap();
        update_message_coverage(&tx, 1, 42, Some(10), Some(merged)).unwrap();
        tx.commit().unwrap();
    }
    let conn = Connection::open(&path).unwrap();
    let json: String = conn
        .query_row(
            "SELECT value_json FROM sync_state WHERE user_id=1 AND key='messageCoverage:42'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let state: super::MessageCoverageState = serde_json::from_str(&json).unwrap();
    assert_eq!(state.known_newest_seq, 10);
    assert_eq!(state.covered_tail, interval(5, 10));
    assert_eq!(
        section_edges(&conn),
        vec![(5, Some(1), None), (10, None, Some(1))]
    );
    drop(conn);
    std::fs::remove_file(path).unwrap();
}
