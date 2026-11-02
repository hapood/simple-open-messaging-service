use super::*;
use crate::{login_session_store::LoginSessionId, native_db};
use std::{
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};

fn install(token: &str) -> Arc<crate::login_connection::LoginConnection> {
    let id = LoginSessionId::try_from(uuid::Uuid::new_v4().to_string()).unwrap();
    let owner = native_db::install_test_login_connection(
        id,
        rusqlite::Connection::open_in_memory().unwrap(),
    )
    .unwrap();
    owner
        .begin_activation()
        .unwrap()
        .commit(token.into())
        .unwrap();
    owner
}

#[test]
fn persistence_is_not_a_second_authentication_or_realtime_activation() {
    let _filesystem = native_db::FILESYSTEM_TEST_LOCK.lock().unwrap();
    let owner = install("token");
    let state = crate::ServerSessionState::new();
    // Persistence is post-activation work: it must not re-enter Auth or the realtime supervisor.
    let _phase = state
        .auth_lifecycle
        .enter(crate::auth_lifecycle::Phase::ServerSetup)
        .unwrap();
    let work = owner.capture_database_work().unwrap();
    let stored = persist(&owner.id().to_string(), "token", || {
        assert!(Arc::ptr_eq(&owner, &native_db::active_login()?));
        Ok("stored")
    })
    .unwrap();
    assert_eq!(stored, "stored");
    work.assert_current().unwrap();
    assert_eq!(
        persist(&owner.id().to_string(), "wrong", || Ok(())).unwrap_err(),
        "credential mismatch"
    );
    assert!(clear(None, || panic!("active login cannot be cleared")).is_err());
    owner.end().unwrap();
    assert!(persist::<()>(&owner.id().to_string(), "token", || panic!(
        "ended owner cannot persist"
    ))
    .is_err());
    clear(Some(&owner.id().to_string()), || Ok(())).unwrap();
    native_db::release_login_connection(&owner).unwrap();
}

#[test]
fn slow_old_os_write_does_not_block_logout_and_cannot_overwrite_successor() {
    let _filesystem = native_db::FILESYSTEM_TEST_LOCK.lock().unwrap();
    let old = install("old");
    let stored = Arc::new(Mutex::new(String::new()));
    let (entered, wait_entered) = mpsc::channel();
    let (finish, wait_finish) = mpsc::channel();
    let old_id = old.id().to_string();
    let store = stored.clone();
    let writer = std::thread::spawn(move || {
        persist(&old_id, "old", || {
            entered.send(()).unwrap();
            wait_finish.recv_timeout(Duration::from_secs(5)).unwrap();
            *store.lock().unwrap() = "old".into();
            Ok(())
        })
    });
    wait_entered.recv_timeout(Duration::from_secs(5)).unwrap();
    // No lifecycle lock is held by OS I/O: the old owner ends and a successor activates now.
    old.end().unwrap();
    native_db::release_login_connection(&old).unwrap();
    let next = install("next");
    let next_id = next.id().to_string();
    let store = stored.clone();
    let next_writer = std::thread::spawn(move || {
        persist(&next_id, "next", || {
            *store.lock().unwrap() = "next".into();
            Ok(())
        })
    });
    finish.send(()).unwrap();
    assert!(writer.join().unwrap().is_err());
    next_writer.join().unwrap().unwrap();
    assert_eq!(&*stored.lock().unwrap(), "next");
    assert!(clear(Some(&old.id().to_string()), || panic!(
        "late clear cannot delete successor"
    ))
    .is_err());
    assert!(persist::<()>(&old.id().to_string(), "old", || panic!(
        "late write cannot overwrite successor"
    ))
    .is_err());
    next.end().unwrap();
    native_db::release_login_connection(&next).unwrap();
}
