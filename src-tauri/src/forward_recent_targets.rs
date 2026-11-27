//! Recent forwarding targets belong to one active login. Admission and updates share the
//! device database transaction with lifecycle state, so delayed renderer work cannot revive
//! deleted history or update a successor login.

use rusqlite::{Connection, TransactionBehavior};
use serde_json::Value;

use crate::login_session_store::{LoginSessionId, SessionStore};
use crate::native_db::app_state;

pub(crate) const RECENT_TARGETS_KEY: &str = "forwardRecentThreads";
const MAX_RECENT_TARGETS: usize = 12;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn append_valid(targets: &mut Vec<u64>, value: &Value) {
    let Some(values) = value.as_array() else {
        return;
    };
    for value in values {
        if targets.len() == MAX_RECENT_TARGETS {
            break;
        }
        let Some(id) = value.as_f64() else { continue };
        if id > 0.0 && id <= MAX_SAFE_INTEGER && id.fract() == 0.0 {
            let id = id as u64;
            if !targets.contains(&id) {
                targets.push(id);
            }
        }
    }
}

fn stored(conn: &Connection) -> Result<Value, String> {
    app_state::get(conn, RECENT_TARGETS_KEY)?
        .map(|raw| serde_json::from_str(&raw).map_err(|e| format!("decode recent targets: {e}")))
        .transpose()
        .map(|value| value.unwrap_or(Value::Null))
}

fn read(conn: &mut Connection, expected: &LoginSessionId) -> Result<Vec<u64>, String> {
    // A read-only snapshot keeps the identity and history from different logins from mixing.
    let tx = conn
        .transaction()
        .map_err(|e| format!("begin recent targets read: {e}"))?;
    let mut targets = Vec::new();
    if SessionStore::read(&tx)?.active_session() == Some(expected) {
        append_valid(&mut targets, &stored(&tx)?);
    }
    tx.commit()
        .map_err(|e| format!("commit recent targets read: {e}"))?;
    Ok(targets)
}

fn remember(
    conn: &mut Connection,
    expected: &LoginSessionId,
    selected: &Value,
) -> Result<Vec<u64>, String> {
    // Acquire the write reservation BEFORE admission. Cleanup uses the same transaction mode:
    // an admitted write commits before deletion, or observes cleaning/signed-out/a new UUID.
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("begin recent targets update: {e}"))?;
    if SessionStore::read(&tx)?.active_session() != Some(expected) {
        return Ok(Vec::new());
    }
    let mut targets = Vec::new();
    append_valid(&mut targets, selected);
    append_valid(&mut targets, &stored(&tx)?);
    app_state::put(
        &tx,
        RECENT_TARGETS_KEY,
        &serde_json::to_string(&targets).map_err(|e| format!("encode recent targets: {e}"))?,
    )?;
    tx.commit()
        .map_err(|e| format!("commit recent targets update: {e}"))?;
    Ok(targets)
}

#[tauri::command]
pub(crate) async fn forward_recent_targets_read(
    expected_session_uuid: LoginSessionId,
) -> Result<Vec<u64>, String> {
    let preferences = crate::native_db::preferences_connection()?;
    tauri::async_runtime::spawn_blocking(move || {
        preferences.with_database(|conn| read(conn, &expected_session_uuid))
    })
    .await
    .map_err(|e| format!("join recent targets read: {e}"))?
}

#[tauri::command]
pub(crate) async fn forward_recent_targets_remember(
    expected_session_uuid: LoginSessionId,
    thread_ids: Value,
) -> Result<Vec<u64>, String> {
    let preferences = crate::native_db::preferences_connection()?;
    tauri::async_runtime::spawn_blocking(move || {
        preferences.with_database(|conn| remember(conn, &expected_session_uuid, &thread_ids))
    })
    .await
    .map_err(|e| format!("join recent targets update: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn active() -> (Connection, LoginSessionId) {
        let mut conn = Connection::open_in_memory().unwrap();
        app_state::ensure_schema(&conn).unwrap();
        SessionStore::initialize(&conn, true).unwrap();
        let id = LoginSessionId::new();
        SessionStore::activate(&mut conn, &id).unwrap();
        (conn, id)
    }

    #[test]
    fn policy_filters_safe_positive_ids_deduplicates_and_keeps_latest_twelve() {
        let (mut conn, id) = active();
        app_state::put(&conn, RECENT_TARGETS_KEY, r#"[4,"5",4,-1,8,1.5,null]"#).unwrap();
        assert_eq!(read(&mut conn, &id).unwrap(), vec![4, 8]);
        assert_eq!(
            remember(
                &mut conn,
                &id,
                &json!([
                    8,
                    2,
                    2.0,
                    0,
                    "3",
                    -5,
                    9007199254740992_u64,
                    9007199254740991_u64
                ])
            )
            .unwrap(),
            vec![8, 2, 9007199254740991, 4]
        );
        let selected: Vec<u64> = (10..24).collect();
        assert_eq!(
            remember(&mut conn, &id, &json!(selected)).unwrap(),
            (10..22).collect::<Vec<u64>>()
        );
    }

    #[test]
    fn admitted_write_is_deleted_and_delayed_work_cannot_reinsert_or_target_successor() {
        let (mut conn, id) = active();
        assert_eq!(remember(&mut conn, &id, &json!([7])).unwrap(), vec![7]);
        // An IPC request can have captured the active UUID before cleanup starts.
        let captured = SessionStore::read(&conn)
            .unwrap()
            .active_session()
            .unwrap()
            .clone();
        SessionStore::begin_cleaning(&mut conn, &id).unwrap();
        assert!(read(&mut conn, &captured).unwrap().is_empty());
        assert!(remember(&mut conn, &captured, &json!([8]))
            .unwrap()
            .is_empty());
        SessionStore::finish_cleaning(&mut conn).unwrap();
        assert!(remember(&mut conn, &captured, &json!([9]))
            .unwrap()
            .is_empty());
        assert!(app_state::get(&conn, RECENT_TARGETS_KEY).unwrap().is_none());
        let successor = LoginSessionId::new();
        SessionStore::activate(&mut conn, &successor).unwrap();
        remember(&mut conn, &successor, &json!([10])).unwrap();
        assert!(remember(&mut conn, &captured, &json!([11]))
            .unwrap()
            .is_empty());
        assert!(read(&mut conn, &captured).unwrap().is_empty());
        assert_eq!(read(&mut conn, &successor).unwrap(), vec![10]);
    }

    #[test]
    fn signed_out_requests_do_not_create_history() {
        let mut conn = Connection::open_in_memory().unwrap();
        app_state::ensure_schema(&conn).unwrap();
        SessionStore::initialize(&conn, true).unwrap();
        let id = LoginSessionId::new();
        assert!(remember(&mut conn, &id, &json!([1])).unwrap().is_empty());
        assert!(read(&mut conn, &id).unwrap().is_empty());
        assert!(app_state::get(&conn, RECENT_TARGETS_KEY).unwrap().is_none());
    }

    #[test]
    fn cleanup_waits_for_an_admitted_write_then_removes_it() {
        use std::sync::mpsc;
        use std::time::Duration;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("device.sqlite");
        let mut conn = Connection::open(&path).unwrap();
        app_state::ensure_schema(&conn).unwrap();
        SessionStore::initialize(&conn, true).unwrap();
        let id = LoginSessionId::new();
        SessionStore::activate(&mut conn, &id).unwrap();
        // Pause inside the INSERT, after the UUID was checked under the write reservation.
        let (admitted_tx, admitted_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let writer_path = path.clone();
        let writer_id = id.clone();
        let writer = std::thread::spawn(move || {
            let mut conn = Connection::open(writer_path).unwrap();
            conn.create_scalar_function(
                "recent_write_admitted",
                0,
                rusqlite::functions::FunctionFlags::SQLITE_UTF8,
                move |_| {
                    admitted_tx.send(()).unwrap();
                    resume_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    Ok(0)
                },
            )
            .unwrap();
            conn.execute_batch(
                "CREATE TEMP TRIGGER pause_recent_write BEFORE INSERT ON app_state
                 WHEN NEW.key = 'forwardRecentThreads'
                 BEGIN SELECT recent_write_admitted(); END;",
            )
            .unwrap();
            remember(&mut conn, &writer_id, &json!([7])).unwrap()
        });
        admitted_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let (cleanup_tx, cleanup_rx) = mpsc::channel();
        let cleanup_path = path.clone();
        let cleanup_id = id.clone();
        let cleanup = std::thread::spawn(move || {
            let mut conn = Connection::open(cleanup_path).unwrap();
            conn.busy_timeout(Duration::from_secs(5)).unwrap();
            cleanup_tx.send(()).unwrap();
            SessionStore::begin_cleaning(&mut conn, &cleanup_id).unwrap();
            SessionStore::finish_cleaning(&mut conn).unwrap();
        });
        cleanup_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        resume_tx.send(()).unwrap();
        assert_eq!(writer.join().unwrap(), vec![7]);
        cleanup.join().unwrap();
        assert!(app_state::get(&conn, RECENT_TARGETS_KEY).unwrap().is_none());
        assert!(remember(&mut conn, &id, &json!([8])).unwrap().is_empty());
        assert!(read(&mut conn, &id).unwrap().is_empty());
    }

    #[test]
    fn independent_connections_do_not_lose_concurrent_confirmations() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("device.sqlite");
        let mut conn = Connection::open(&path).unwrap();
        app_state::ensure_schema(&conn).unwrap();
        SessionStore::initialize(&conn, true).unwrap();
        let id = LoginSessionId::new();
        SessionStore::activate(&mut conn, &id).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let workers: Vec<_> = (1..=2)
            .map(|target| {
                let path = path.clone();
                let id = id.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let mut conn = Connection::open(path).unwrap();
                    conn.busy_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                    barrier.wait();
                    remember(&mut conn, &id, &json!([target])).unwrap();
                })
            })
            .collect();
        barrier.wait();
        for worker in workers {
            worker.join().unwrap();
        }
        let mut targets = read(&mut conn, &id).unwrap();
        targets.sort();
        assert_eq!(targets, vec![1, 2]);
    }
}
