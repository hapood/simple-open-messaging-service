use futures_util::StreamExt;
use std::{
    collections::HashMap,
    pin::Pin,
    sync::{LazyLock, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[cfg(test)]
#[path = "tests/http_stream_tests.rs"]
mod tests;

pub(crate) const OPEN_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// Persistent across caller control wakes. Only nonempty network bytes extend liveness.
pub(crate) struct ReceiveDeadline {
    timer: Pin<Box<tokio::time::Sleep>>,
}
impl ReceiveDeadline {
    pub(crate) fn new() -> Self {
        Self {
            timer: Box::pin(tokio::time::sleep(IDLE_TIMEOUT)),
        }
    }
    pub(crate) fn received(&mut self, bytes: usize) {
        if bytes > 0 {
            self.timer
                .as_mut()
                .reset(tokio::time::Instant::now() + IDLE_TIMEOUT);
        }
    }
    pub(crate) async fn expired(&mut self) {
        self.timer.as_mut().await;
    }
}

/// Transport-only errors: callers retain ownership of authentication and reconnect policy.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "snake_case")]
pub(crate) enum StreamError {
    OpenTimeout,
    IdleTimeout,
    Network(String),
    Cancelled,
    SessionEnded,
    Delivery(String),
}

pub(crate) async fn open(
    request: reqwest::RequestBuilder,
) -> Result<reqwest::Response, StreamError> {
    tokio::time::timeout(OPEN_TIMEOUT, request.send())
        .await
        .map_err(|_| StreamError::OpenTimeout)?
        .map_err(|error| StreamError::Network(error.without_url().to_string()))
}

/// Shared by IPC streams and headless realtime; no complete-response buffering.
pub(crate) struct Body {
    stream: Pin<Box<dyn futures_util::Stream<Item = Result<Vec<u8>, reqwest::Error>> + Send>>,
    deadline: ReceiveDeadline,
}
impl Body {
    pub(crate) fn new(response: reqwest::Response) -> Self {
        Self {
            stream: Box::pin(
                response
                    .bytes_stream()
                    .map(|chunk| chunk.map(|bytes| bytes.to_vec())),
            ),
            deadline: ReceiveDeadline::new(),
        }
    }
    pub(crate) async fn next(&mut self) -> Result<Option<Vec<u8>>, StreamError> {
        loop {
            tokio::select! {
                biased;
                _ = self.deadline.expired() => return Err(StreamError::IdleTimeout),
                chunk = self.stream.next() => match chunk {
                    None => return Ok(None),
                    Some(Err(error)) => return Err(StreamError::Network(error.without_url().to_string())),
                    Some(Ok(bytes)) => {
                        self.deadline.received(bytes.len());
                        if !bytes.is_empty() { return Ok(Some(bytes)); }
                    }
                }
            }
        }
    }
}

// One outstanding payload per stream. A random delivery capability prevents stale
// acknowledgements from releasing another request (including a reused request ID).
static DELIVERIES: LazyLock<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct Delivery(String);
impl Delivery {
    fn register() -> (Self, tokio::sync::oneshot::Receiver<()>) {
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        DELIVERIES.lock().unwrap().insert(id.clone(), sender);
        (Self(id), receiver)
    }

    async fn wait(&self, receiver: tokio::sync::oneshot::Receiver<()>) -> Result<(), StreamError> {
        tokio::time::timeout(IDLE_TIMEOUT, receiver)
            .await
            .map_err(|_| StreamError::Delivery("consumer acknowledgement timed out".into()))?
            .map_err(|_| StreamError::Delivery("consumer acknowledgement closed".into()))
    }
}
impl Drop for Delivery {
    fn drop(&mut self) {
        DELIVERIES.lock().unwrap().remove(&self.0);
    }
}

/// Do not admit the next payload until the renderer consumes this delivery.
/// Dropping this future (request/session cancellation) revokes its capability.
async fn deliver(send: impl FnOnce(String) -> Result<(), String>) -> Result<(), StreamError> {
    let (delivery, acknowledgement) = Delivery::register();
    send(delivery.0.clone()).map_err(StreamError::Delivery)?;
    delivery.wait(acknowledgement).await
}

#[tauri::command]
pub(crate) fn http_stream_ack(delivery_id: String) {
    if let Some(sender) = DELIVERIES.lock().unwrap().remove(&delivery_id) {
        let _ = sender.send(());
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum StreamEvent {
    Started,
    Headers {
        delivery_id: String,
        status: u16,
        headers: std::collections::HashMap<String, String>,
    },
    Chunk {
        delivery_id: String,
        bytes: Vec<u8>,
    },
    End,
    Error {
        error: StreamError,
    },
}

/// Request-local IPC adapter. Application-owned /events calls open/Body directly.
#[tauri::command]
pub(crate) async fn http_stream_request(
    proxy: tauri::State<'_, crate::ServerSessionState>,
    req_id: String,
    method: String,
    path: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<Vec<u8>>,
    channel: tauri::ipc::Channel<StreamEvent>,
) -> Result<(), String> {
    if !crate::proxy::is_allowed_http_path(&path)
        || path.contains('#')
        || path.contains('\\')
        || path.contains("..")
    {
        return Err("invalid stream path".into());
    }
    let method =
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "invalid HTTP method")?;
    let registration = crate::proxy::RequestCancellation::register(&proxy, Some(req_id))?;
    // A renderer that unsubscribed before registration cancels upon this acknowledgement.
    channel
        .send(StreamEvent::Started)
        .map_err(|e| e.to_string())?;
    let result = run(
        &proxy,
        method,
        path,
        headers,
        body,
        registration.token(),
        &channel,
    )
    .await;
    let event = match result {
        Ok(()) => StreamEvent::End,
        Err(error) => StreamEvent::Error { error },
    };
    channel.send(event).map_err(|e| e.to_string())
}

async fn run(
    proxy: &crate::ServerSessionState,
    method: reqwest::Method,
    path: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<Vec<u8>>,
    cancel: &CancellationToken,
    channel: &tauri::ipc::Channel<StreamEvent>,
) -> Result<(), StreamError> {
    let owner = crate::native_db::active_login().map_err(|_| StreamError::SessionEnded)?;
    let intent = crate::login_request::LoginRequest::capture(proxy, owner.clone())
        .map_err(|_| StreamError::SessionEnded)?;
    let endpoint = intent.endpoint().map_err(|_| StreamError::SessionEnded)?;
    let session_cancel = owner.cancellation();
    let work = async {
        let mut request = endpoint
            .client
            .request(method, format!("{}{path}", endpoint.origin))
            .bearer_auth(&endpoint.credential);
        for name in ["accept", "content-type", "accept-language", "x-request-id"] {
            if let Some(value) = headers.get(name) {
                request = request.header(name, value);
            }
        }
        if let Some(body) = body {
            request = request.body(body);
        }
        // Never replay a partially delivered stream; its domain owns reconnect semantics.
        let response = open(request).await?;
        owner
            .assert_active()
            .map_err(|_| StreamError::SessionEnded)?;
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.to_string(), value.to_string()))
            })
            .collect();
        deliver(|delivery_id| {
            channel
                .send(StreamEvent::Headers {
                    delivery_id,
                    status: response.status().as_u16(),
                    headers,
                })
                .map_err(|error| error.to_string())
        })
        .await?;
        let mut body = Body::new(response);
        while let Some(bytes) = body.next().await? {
            for chunk in bytes.chunks(64 * 1024) {
                owner
                    .assert_active()
                    .map_err(|_| StreamError::SessionEnded)?;
                deliver(|delivery_id| {
                    channel
                        .send(StreamEvent::Chunk {
                            delivery_id,
                            bytes: chunk.to_vec(),
                        })
                        .map_err(|error| error.to_string())
                })
                .await?;
            }
        }
        owner
            .assert_active()
            .map_err(|_| StreamError::SessionEnded)?;
        Ok(())
    };
    tokio::select! {
        biased;
        _ = session_cancel.cancelled() => Err(StreamError::SessionEnded),
        _ = cancel.cancelled() => Err(StreamError::Cancelled),
        result = work => result,
    }
}
