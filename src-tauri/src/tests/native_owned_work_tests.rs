use super::spawn_owned_work;
use crate::login_connection::LoginConnection;
use crate::login_session_store::LoginSessionId;
use std::sync::{mpsc, Arc};
use std::time::Duration;

fn active_owner() -> Arc<LoginConnection> {
    let owner = LoginConnection::preparing(
        LoginSessionId::try_from(uuid::Uuid::new_v4().to_string()).unwrap(),
        rusqlite::Connection::open_in_memory().unwrap(),
    );
    owner
        .begin_activation()
        .unwrap()
        .commit("original-credential".into())
        .unwrap();
    owner
}

#[tokio::test]
async fn external_work_does_not_borrow_sqlite_or_the_maintenance_lock() {
    let owner = active_owner();
    let work = owner.capture_database_work().unwrap();
    let (started, ready) = mpsc::channel();
    let (release, finished) = mpsc::channel();
    let sql_worker = {
        let owner = owner.clone();
        std::thread::spawn(move || {
            owner.with_database(|_| {
                started.send(()).unwrap();
                finished.recv().unwrap();
                Ok(())
            })
        })
    };
    ready.recv_timeout(Duration::from_secs(2)).unwrap();
    let (maintenance_started, maintenance_ready) = tokio::sync::oneshot::channel();
    let (release_maintenance, maintenance_finished) = mpsc::channel();
    // Keep the synchronous guard on its owning thread while the async task proves
    // external work does not need either the database or the maintenance lock.
    let maintenance_worker = std::thread::spawn(move || {
        let _maintenance = super::lifetime::CACHE_LIFETIME.invalidate().unwrap();
        maintenance_started.send(()).unwrap();
        maintenance_finished
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
    });
    maintenance_ready.await.unwrap();
    let result =
        tokio::time::timeout(Duration::from_secs(2), spawn_owned_work(work, || Ok(17))).await;
    release_maintenance.send(()).unwrap();
    maintenance_worker.join().unwrap();
    release.send(()).unwrap();
    sql_worker.join().unwrap().unwrap();
    assert_eq!(result.unwrap().unwrap().unwrap(), 17);
    owner.end().unwrap();
    owner.close().unwrap();
}

#[tokio::test]
async fn obsolete_external_work_never_starts_its_callback() {
    use std::sync::atomic::{AtomicBool, Ordering};

    for repair in [false, true] {
        let owner = active_owner();
        let work = owner.capture_database_work().unwrap();
        let called = Arc::new(AtomicBool::new(false));
        if repair {
            owner.invalidate_database_work().unwrap();
        } else {
            owner.end().unwrap();
        }
        let callback_called = called.clone();
        let error = spawn_owned_work(work, move || {
            callback_called.store(true, Ordering::SeqCst);
            Ok(())
        })
        .await
        .unwrap()
        .unwrap_err();
        assert_eq!(
            error,
            if repair {
                "native cache work superseded"
            } else {
                "native login superseded"
            }
        );
        assert!(!called.load(Ordering::SeqCst));
        owner.end().unwrap();
        owner.close().unwrap();
    }
}

#[tokio::test]
async fn external_work_rejects_a_result_completed_after_end_or_repair() {
    for repair in [false, true] {
        let owner = active_owner();
        let work = owner.capture_database_work().unwrap();
        let (started, ready) = mpsc::channel();
        let (release, finished) = mpsc::channel();
        let pending = spawn_owned_work(work, move || {
            started.send(()).unwrap();
            finished.recv().unwrap();
            Ok("obsolete result")
        });
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        if repair {
            owner.invalidate_database_work().unwrap();
        } else {
            owner.end().unwrap();
            // Resource release does not wait on the non-SQL callback.
            owner.close().unwrap();
        }
        let successor = active_owner();
        assert_ne!(owner.id(), successor.id());
        release.send(()).unwrap();
        let error = pending.await.unwrap().unwrap_err();
        assert_eq!(
            error,
            if repair {
                "native cache work superseded"
            } else {
                "native login superseded"
            }
        );
        assert!(successor.assert_active().is_ok());
        assert_eq!(successor.credential().unwrap(), "original-credential");
        owner.end().unwrap();
        owner.close().unwrap();
        successor.end().unwrap();
        successor.close().unwrap();
    }
}
