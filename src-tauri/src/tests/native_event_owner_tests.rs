use super::*;
use crate::login_connection::LoginConnection;
use crate::login_session_store::LoginSessionId;

#[test]
fn local_completions_carry_original_uuid_and_reject_ended_or_repaired_work() {
    let id = LoginSessionId::try_from(uuid::Uuid::new_v4().to_string()).unwrap();
    let owner =
        LoginConnection::preparing(id.clone(), rusqlite::Connection::open_in_memory().unwrap());
    owner
        .begin_activation()
        .unwrap()
        .commit("event-token".into())
        .unwrap();
    let events = NativeEvents::for_database_work(None, owner.capture_database_work().unwrap());
    let event = serde_json::json!({
        "event": "LOCAL_MESSAGE_DB_COMMITTED", "status": 0, "message": "",
        "data": { "userId": 42, "threadId": 7 },
        "loginSessionId": "payload-must-not-choose-its-owner",
    });
    let payload = events
        .prepare_payload("soms-sse-event", &event)
        .unwrap()
        .unwrap();
    assert_eq!(payload["loginSessionId"], serde_json::json!(id));
    assert_eq!(payload["data"], event["data"]);
    owner.invalidate_database_work().unwrap();
    assert!(events
        .prepare_payload("soms-sse-event", &event)
        .unwrap()
        .is_none());
    let repaired = NativeEvents::for_database_work(None, owner.capture_database_work().unwrap());
    assert_eq!(
        repaired
            .prepare_payload("soms-sse-event", &event)
            .unwrap()
            .unwrap()["loginSessionId"],
        serde_json::json!(id)
    );
    owner.end().unwrap();
    assert!(repaired
        .prepare_payload("soms-sse-event", &event)
        .unwrap()
        .is_none());
    assert!(events
        .prepare_payload("soms-sse-event", &event)
        .unwrap()
        .is_none());
}
