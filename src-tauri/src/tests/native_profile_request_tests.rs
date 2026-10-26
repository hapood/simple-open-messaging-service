use super::super::profile_subscriptions;
use super::super::profile_subscriptions::tests::{fixture, request as read_request, response};
use super::*;
use serde_json::json;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};

fn demand() -> Value {
    json!({"publisherNamespaceId":7,"lookup":"GROUP_MEMBER_PROFILE","groupAccount":"!team",
        "target":{"profileNamespaceId":12,"account":"alice","rev":3}})
}
fn origin(proxy: &ServerSessionState, listener: &TcpListener) {
    let origin = format!("http://{}", listener.local_addr().unwrap());
    *proxy.api_origin.lock().unwrap() = origin.clone();
    *proxy.api_origin_primary.lock().unwrap() = origin;
}

#[tokio::test]
async fn cancellation_at_registration_starts_no_demand_and_cleans_up() {
    let proxy = ServerSessionState::new();
    let intent = fixture(&proxy);
    let id = uuid::Uuid::new_v4().to_string();
    let result = resolve_profile_request(&proxy, intent.clone(), id.clone(), demand(), || {
        assert!(crate::proxy::cancel_registered_request(&proxy, &id));
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(result["status"], "CANCELLED");
    assert!(!proxy.http_cancels.lock().unwrap().contains_key(&id));
    assert!(!crate::proxy::cancel_registered_request(&proxy, &id));
    intent.work.owner().end().unwrap();
    intent.work.owner().close().unwrap();
}

#[tokio::test]
async fn failed_acknowledgement_and_dropped_guard_leave_no_registration() {
    let proxy = ServerSessionState::new();
    let intent = fixture(&proxy);
    let id = uuid::Uuid::new_v4().to_string();
    assert!(
        resolve_profile_request(&proxy, intent.clone(), id.clone(), demand(), || Err(
            "renderer gone".into()
        ))
        .await
        .is_err()
    );
    assert!(!proxy.http_cancels.lock().unwrap().contains_key(&id));
    let guard = crate::proxy::RequestCancellation::register(&proxy, Some(id.clone())).unwrap();
    assert!(crate::proxy::RequestCancellation::register(&proxy, Some(id.clone())).is_err());
    assert!(crate::proxy::cancel_registered_request(&proxy, &id));
    // Cancellation reserves the UUID until its original owner cleans up.
    assert!(crate::proxy::RequestCancellation::register(&proxy, Some(id.clone())).is_err());
    drop(guard);
    assert!(!proxy.http_cancels.lock().unwrap().contains_key(&id));
    intent.work.owner().end().unwrap();
    intent.work.owner().close().unwrap();
}

#[tokio::test]
async fn last_pc_consumer_cancellation_closes_stalled_headers_and_body_sockets() {
    for body in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = ServerSessionState::new();
        origin(&proxy, &listener);
        let intent = fixture(&proxy);
        let (started, received) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            if body {
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{",
                    )
                    .await
                    .unwrap();
            }
            started.send(()).unwrap();
            let mut byte = [0];
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(3), socket.read(&mut byte))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
        });
        let id = uuid::Uuid::new_v4().to_string();
        let request_proxy = proxy.clone();
        let request_intent = intent.clone();
        let request_id = id.clone();
        let invocation = tokio::spawn(async move {
            resolve_profile_request(&request_proxy, request_intent, request_id, demand(), || {
                Ok(())
            })
            .await
        });
        tokio::time::timeout(Duration::from_secs(3), received)
            .await
            .unwrap()
            .unwrap();
        assert!(crate::proxy::cancel_registered_request(&proxy, &id));
        let result = tokio::time::timeout(Duration::from_secs(3), invocation)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(result["status"], "CANCELLED");
        server.await.unwrap();
        assert!(!proxy.http_cancels.lock().unwrap().contains_key(&id));
        intent.work.owner().end().unwrap();
        intent.work.owner().close().unwrap();
    }
}

#[tokio::test]
async fn cancelling_pc_consumer_keeps_another_native_consumers_http_alive() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = ServerSessionState::new();
    origin(&proxy, &listener);
    let intent = fixture(&proxy);
    let native = profile_subscriptions::subscribe(intent.clone(), demand()).unwrap();
    let (started, received) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        read_request(&mut socket).await;
        started.send(()).unwrap();
        let mut byte = [0];
        tokio::select! { biased;
            result = socket.read(&mut byte) => panic!("shared HTTP closed before release: {result:?}"),
            _ = released => {},
        }
        response(
            &mut socket,
            json!({"status":"READY","profile":{
            "publisherNamespaceId":7,"profileNamespaceId":12,"account":"alice","rev":3,
            "name":"Alice","bio":"","avatarBase64":null}}),
        )
        .await;
    });
    let (registered, ack) = oneshot::channel();
    let id = uuid::Uuid::new_v4().to_string();
    let request_proxy = proxy.clone();
    let request_intent = intent.clone();
    let request_id = id.clone();
    let invocation = tokio::spawn(async move {
        resolve_profile_request(&request_proxy, request_intent, request_id, demand(), || {
            registered.send(()).unwrap();
            Ok(())
        })
        .await
    });
    tokio::time::timeout(Duration::from_secs(3), ack)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), received)
        .await
        .unwrap()
        .unwrap();
    assert!(crate::proxy::cancel_registered_request(&proxy, &id));
    assert_eq!(invocation.await.unwrap().unwrap()["status"], "CANCELLED");
    release.send(()).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), native.ready())
            .await
            .unwrap()
            .unwrap()["name"],
        "Alice"
    );
    server.await.unwrap();
    intent.work.owner().end().unwrap();
    intent.work.owner().close().unwrap();
}
