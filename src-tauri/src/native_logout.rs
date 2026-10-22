use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use log::warn;
use tokio::task::JoinHandle;

const LOGOUT_TIMEOUT: Duration = Duration::from_secs(10);

/// Detached revocation owns the ended credential and origin, never the mutable session state.
/// A ticket identifies only this bounded operation; it is not a login identity or credential.
#[derive(Clone, Default)]
pub(crate) struct LogoutTasks(Arc<Mutex<HashMap<String, JoinHandle<()>>>>);

impl LogoutTasks {
    pub(crate) fn start(&self, client: reqwest::Client, origin: String, token: String) -> String {
        self.start_with_timeout(client, origin, token, LOGOUT_TIMEOUT)
    }

    fn start_with_timeout(
        &self,
        client: reqwest::Client,
        origin: String,
        token: String,
        deadline: Duration,
    ) -> String {
        let ticket = uuid::Uuid::new_v4().to_string();
        let task = tokio::spawn(async move {
            let target = format!("{origin}/api/v1/auth/logout");
            // Dropping the timed-out send cancels the actual transport, not just the waiter.
            // No retry: a successor may already exist by the time this attempt finishes.
            match tokio::time::timeout(
                deadline,
                client
                    .post(&target)
                    .header("authorization", format!("Bearer {token}"))
                    .json(&serde_json::json!({}))
                    .send(),
            )
            .await
            {
                Ok(Ok(response)) if response.status().is_success() => {}
                Ok(Ok(response)) => warn!("logout {target} returned HTTP {}", response.status()),
                Ok(Err(error)) => warn!("logout {target} failed: {error}"),
                Err(_) => warn!("logout {target} timed out"),
            }
        });
        let mut pending = self.0.lock().expect("logout tasks lock");
        // A renderer can disappear before waiting. Finished tasks need not survive its recreation.
        pending.retain(|_, task| !task.is_finished());
        pending.insert(ticket.clone(), task);
        ticket
    }

    pub(crate) async fn wait(&self, ticket: &str) {
        let task = self.0.lock().expect("logout tasks lock").remove(ticket);
        // Never hold the task registry lock over network I/O. Tickets are consumed once.
        if let Some(task) = task {
            if let Err(error) = task.await {
                warn!("logout task failed: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    async fn read_request(socket: &mut TcpStream) -> String {
        let mut request = Vec::new();
        while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            let mut bytes = [0; 1024];
            let count = socket.read(&mut bytes).await.unwrap();
            assert_ne!(count, 0);
            request.extend_from_slice(&bytes[..count]);
        }
        String::from_utf8(request).unwrap()
    }

    #[tokio::test]
    async fn captures_the_ended_credential_and_consumes_the_ticket_once() {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", server.local_addr().unwrap());
        let accept = tokio::spawn(async move {
            let (mut socket, _) = server.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            assert!(request.starts_with("POST /api/v1/auth/logout HTTP/1.1"));
            assert!(request
                .to_lowercase()
                .contains("authorization: bearer ended-token\r\n"));
            socket.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(80), server.accept())
                    .await
                    .is_err()
            );
        });
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("authorization", "Bearer successor-token".parse().unwrap());
        let client = reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .unwrap();
        let tasks = LogoutTasks::default();
        let ticket = tasks.start(client, origin, "ended-token".into());
        tasks.wait(&ticket).await;
        tasks.wait(&ticket).await;
        accept.await.unwrap();
    }

    #[tokio::test]
    async fn deadline_cancels_a_connected_but_silent_transport() {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", server.local_addr().unwrap());
        let accept = tokio::spawn(async move {
            let (mut socket, _) = server.accept().await.unwrap();
            read_request(&mut socket).await;
            let mut remaining = Vec::new();
            tokio::time::timeout(Duration::from_secs(2), socket.read_to_end(&mut remaining))
                .await
                .expect("timed-out request must close its socket")
                .unwrap();
        });
        let tasks = LogoutTasks::default();
        let ticket = tasks.start_with_timeout(
            reqwest::Client::new(),
            origin,
            "ended".into(),
            Duration::from_millis(100),
        );
        tokio::time::timeout(Duration::from_secs(2), tasks.wait(&ticket))
            .await
            .unwrap();
        accept.await.unwrap();
    }
}
