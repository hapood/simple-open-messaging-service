use super::*;
use futures_util::{stream, FutureExt};

#[tokio::test]
async fn delivery_waits_for_its_exact_acknowledgement() {
    let (first, receiver) = Delivery::register();
    let (other, other_receiver) = Delivery::register();
    let mut wait = Box::pin(first.wait(receiver));
    http_stream_ack(other.0.clone());
    assert!(wait.as_mut().now_or_never().is_none());
    other.wait(other_receiver).await.unwrap();
    http_stream_ack(first.0.clone());
    wait.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn delivery_timeout_and_cancellation_remove_pending_capabilities() {
    let (delivery, receiver) = Delivery::register();
    let id = delivery.0.clone();
    assert!(matches!(
        delivery.wait(receiver).await,
        Err(StreamError::Delivery(_))
    ));
    drop(delivery);
    assert!(!DELIVERIES.lock().unwrap().contains_key(&id));

    let (delivery, receiver) = Delivery::register();
    let id = delivery.0.clone();
    drop(receiver);
    drop(delivery);
    assert!(!DELIVERIES.lock().unwrap().contains_key(&id));
    // Late acknowledgements are harmless and cannot grant credit to a successor.
    http_stream_ack(id);
}
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn delivery_admits_only_one_payload_until_each_consumer_acknowledgement() {
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let mut work = Box::pin(async {
        for index in 0..3 {
            deliver(|id| {
                sent.send((index, id)).unwrap();
                Ok(())
            })
            .await?;
        }
        Ok::<_, StreamError>(())
    });
    for index in 0..3 {
        assert!(work.as_mut().now_or_never().is_none());
        let (actual, id) = received.try_recv().unwrap();
        assert_eq!(actual, index);
        assert!(received.try_recv().is_err());
        // Repeated polling without consumption cannot admit another payload.
        assert!(work.as_mut().now_or_never().is_none());
        assert!(received.try_recv().is_err());
        http_stream_ack(id);
    }
    work.await.unwrap();
}

#[tokio::test]
async fn cancelling_delivery_revokes_credit_and_late_ack_cannot_release_successor() {
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let mut first = Box::pin(deliver(|id| {
        sent.send(id).unwrap();
        Ok(())
    }));
    assert!(first.as_mut().now_or_never().is_none());
    let stale_id = received.try_recv().unwrap();
    drop(first);
    assert!(!DELIVERIES.lock().unwrap().contains_key(&stale_id));

    let mut successor = Box::pin(deliver(|id| {
        sent.send(id).unwrap();
        Ok(())
    }));
    assert!(successor.as_mut().now_or_never().is_none());
    let successor_id = received.try_recv().unwrap();
    assert_ne!(stale_id, successor_id);
    http_stream_ack(stale_id);
    assert!(successor.as_mut().now_or_never().is_none());
    http_stream_ack(successor_id);
    successor.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn failed_or_unacknowledged_delivery_revokes_its_capability() {
    let mut failed_id = String::new();
    let result = deliver(|id| {
        failed_id = id;
        Err("renderer closed".into())
    })
    .await;
    assert!(matches!(result, Err(StreamError::Delivery(_))));
    assert!(!DELIVERIES.lock().unwrap().contains_key(&failed_id));

    let mut expired_id = String::new();
    let result = deliver(|id| {
        expired_id = id;
        Ok(())
    })
    .await;
    assert!(matches!(result, Err(StreamError::Delivery(_))));
    assert!(!DELIVERIES.lock().unwrap().contains_key(&expired_id));
}

async fn assert_connection_closed(socket: &mut tokio::net::TcpStream) {
    let mut byte = [0u8; 1];
    let result = tokio::time::timeout(Duration::from_secs(5), socket.read(&mut byte))
        .await
        .expect("stream retained its HTTP connection");
    match result {
        Ok(0) => {}
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
        other => panic!("expected connection close, got {other:?}"),
    }
}

#[tokio::test]
async fn opening_timeout_drops_the_pending_http_connection() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let request = tokio::spawn(async move {
        open(
            reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .get(url),
        )
        .await
    });
    let (mut socket, _) = listener.accept().await.unwrap();
    let mut bytes = [0u8; 4096];
    assert!(socket.read(&mut bytes).await.unwrap() > 0);
    // The request reached the server, but it never sends response headers.
    tokio::time::pause();
    tokio::time::advance(OPEN_TIMEOUT).await;
    assert!(matches!(
        request.await.unwrap(),
        Err(StreamError::OpenTimeout)
    ));
    tokio::time::resume();
    assert_connection_closed(&mut socket).await;
}

#[tokio::test]
async fn cancelling_a_body_reader_releases_the_http_connection() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let cancel = CancellationToken::new();
    let worker_cancel = cancel.clone();
    let (received, ready) = tokio::sync::oneshot::channel();
    let request = tokio::spawn(async move {
        let response = open(
            reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .get(url),
        )
        .await
        .unwrap();
        let mut body = Body::new(response);
        assert_eq!(body.next().await.unwrap().unwrap(), b"hello");
        received.send(()).unwrap();
        tokio::select! {
            biased;
            _ = worker_cancel.cancelled() => {}
            result = body.next() => panic!("silent stream ended before cancellation: {result:?}"),
        }
    });
    let (mut socket, _) = listener.accept().await.unwrap();
    let mut bytes = [0u8; 4096];
    assert!(socket.read(&mut bytes).await.unwrap() > 0);
    socket
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nhello")
        .await
        .unwrap();
    ready.await.unwrap();
    cancel.cancel();
    request.await.unwrap();
    assert_connection_closed(&mut socket).await;
}

#[tokio::test(start_paused = true)]
async fn body_idle_timeout_survives_cancelled_next_polls() {
    let mut body = Body {
        stream: Box::pin(stream::pending()),
        deadline: ReceiveDeadline::new(),
    };
    for _ in 0..29 {
        assert!(body.next().now_or_never().is_none());
        tokio::time::advance(Duration::from_secs(1)).await;
    }
    assert!(body.next().now_or_never().is_none());
    tokio::time::advance(Duration::from_secs(1)).await;
    assert!(matches!(body.next().await, Err(StreamError::IdleTimeout)));
}

#[tokio::test(start_paused = true)]
async fn empty_chunks_do_not_renew_body_deadline() {
    let mut body = Body {
        stream: Box::pin(stream::unfold((), |_| async {
            tokio::time::sleep(Duration::from_secs(10)).await;
            Some((Ok(vec![]), ()))
        })),
        deadline: ReceiveDeadline::new(),
    };
    let started = tokio::time::Instant::now();
    assert!(matches!(body.next().await, Err(StreamError::IdleTimeout)));
    assert_eq!(started.elapsed(), Duration::from_secs(30));
}

#[tokio::test(start_paused = true)]
async fn bytes_keep_a_stream_alive_without_a_total_deadline() {
    let mut body = Body {
        stream: Box::pin(stream::unfold(0, |count| async move {
            if count == 8 {
                return None;
            }
            tokio::time::sleep(Duration::from_secs(10)).await;
            Some((Ok(b"heartbeat".to_vec()), count + 1))
        })),
        deadline: ReceiveDeadline::new(),
    };
    let started = tokio::time::Instant::now();
    for _ in 0..8 {
        assert_eq!(body.next().await.unwrap().unwrap(), b"heartbeat");
    }
    assert!(body.next().await.unwrap().is_none());
    assert_eq!(started.elapsed(), Duration::from_secs(80));
}

#[tokio::test]
async fn stream_delivers_headers_and_bytes_before_connection_closes() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let (release, wait) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0u8; 4096];
        socket.read(&mut request).await.unwrap();
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nhello")
            .await
            .unwrap();
        wait.await.unwrap();
        socket.write_all(b"!").await.unwrap();
    });
    let response = open(
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(url),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), 200);
    let mut body = Body::new(response);
    assert_eq!(body.next().await.unwrap().unwrap(), b"hello");
    release.send(()).unwrap();
    assert_eq!(body.next().await.unwrap().unwrap(), b"!");
    assert!(body.next().await.unwrap().is_none());
    server.await.unwrap();
}
