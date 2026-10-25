use super::{
    input::Command,
    model::{Effect, Machine, Response},
};
use crate::{login_connection::LoginConnection, login_request::LoginRequest, ServerSessionState};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

pub trait Sink: Send + Sync {
    fn command(&self, value: Value);
}

pub struct Runtime {
    stop: CancellationToken,
    sender: mpsc::UnboundedSender<Input>,
    pub snapshot: Arc<Mutex<Value>>,
    current: Arc<AtomicU64>,
    owner: Arc<Mutex<Option<Arc<LoginConnection>>>>,
    sink: Arc<Mutex<Option<Arc<dyn Sink>>>>,
    proxy: ServerSessionState,
}

enum Input {
    Command {
        owner: Arc<LoginConnection>,
        command: Command,
        reply: oneshot::Sender<Value>,
    },
    Http {
        lease: u64,
        peer: u64,
        tag: String,
        response: Response,
        binding: Arc<Binding>,
        sid: String,
    },
    Timer {
        lease: u64,
        kind: &'static str,
        ticket: u64,
    },
    Detach(u64),
}
struct SignalRequest {
    peer: u64,
    tag: String,
    path: String,
    body: Option<Value>,
    sid: String,
}
struct Binding {
    stop: CancellationToken,
    lease: u64,
    owner: Arc<LoginConnection>,
    request: LoginRequest,
    cancel: CancellationToken,
    signals: mpsc::UnboundedSender<SignalRequest>,
}

impl Runtime {
    pub fn new(proxy: ServerSessionState) -> Self {
        let stop = CancellationToken::new();
        let (sender, receiver) = mpsc::unbounded_channel();
        let snapshot = Arc::new(Mutex::new(
            json!({"lease":0,"revision":0,"snapshot":{"phase":"idle"}}),
        ));
        let current = Arc::new(AtomicU64::new(0));
        let owner = Arc::new(Mutex::new(None));
        let sink = Arc::new(Mutex::new(None));
        let actor = Actor {
            stop: stop.clone(),
            proxy: proxy.clone(),
            machine: Machine::default(),
            binding: None,
            timers: HashMap::new(),
            ticket: 0,
            revision: 0,
            sender: sender.clone(),
            snapshot: snapshot.clone(),
            current: current.clone(),
            owner: owner.clone(),
            sink: sink.clone(),
        };
        tauri::async_runtime::spawn(actor.run(receiver));
        Self {
            stop,
            sender,
            snapshot,
            current,
            owner,
            sink,
            proxy,
        }
    }
    pub fn bind(&self, sink: Arc<dyn Sink>) {
        *self.sink.lock().unwrap() = Some(sink);
    }
    pub fn is_current(&self, lease: u64) -> bool {
        self.current.load(Ordering::Acquire) == lease
            && self
                .owner
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|owner| owner.assert_active().is_ok())
    }
    pub fn is_live(&self, lease: u64) -> bool {
        self.is_current(lease) && self.snapshot.lock().unwrap()["snapshot"]["phase"] != "idle"
    }
    pub fn can_ring(&self, lease: u64) -> bool {
        self.is_live(lease) && self.snapshot.lock().unwrap()["canRing"] == true
    }
    pub fn detach(&self, lease: u64) {
        let _ = self.sender.send(Input::Detach(lease));
    }
    pub async fn command(&self, expected: u64, data: Value) -> Result<Value, String> {
        let id = self
            .proxy
            .login_session
            .lock()
            .map_err(|_| "login lock poisoned")?
            .clone()
            .ok_or("no active login")?;
        if data["loginSessionId"].as_str() != Some(id.to_string().as_str()) {
            return Err("native login superseded".into());
        }
        let owner = crate::native_db::login_connection(&id)?;
        owner.assert_active().map_err(|error| error.to_string())?;
        let mut command = Command::decode(expected, data)?;
        if let Command::NewCall { incoming, data } = command {
            let captured = owner.clone();
            let cancellation = owner.cancellation();
            let data = tokio::select! { biased;
                _ = cancellation.cancelled() => return Err("native login superseded".into()),
                result = tauri::async_runtime::spawn_blocking(move || resolve_peer(captured, data)) => result.map_err(|error| error.to_string())??,
            };
            command = Command::NewCall { incoming, data };
        }
        let (reply, receive) = oneshot::channel();
        self.sender
            .send(Input::Command {
                owner,
                command,
                reply,
            })
            .map_err(|_| "call runtime stopped")?;
        receive.await.map_err(|_| "call runtime stopped".into())
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

fn resolve_peer(owner: Arc<LoginConnection>, mut data: Value) -> Result<Value, String> {
    let work = owner
        .capture_database_work()
        .map_err(|error| error.to_string())?;
    let peer = crate::native_db::with_owned_database(&work, |connection| {
        use rusqlite::OptionalExtension;
        let user_id = connection
            .query_row("SELECT user_id FROM account_state LIMIT 1", [], |row| {
                row.get::<_, i64>(0)
            })
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(user_id) = user_id else {
            return Ok(None);
        };
        crate::native_db::call_peer::read_call_peer_from_connection(
            connection,
            user_id,
            data["threadId"].as_i64().unwrap_or(0),
            data["peerAccount"].as_str().unwrap_or(""),
            data["peerNamespaceId"].as_i64().unwrap_or(-1),
        )
    })
    .map_err(|error| error.to_string())?;
    if let Some(peer) = peer {
        data["peerName"] = peer["name"].clone();
        data["peerAvatar"] = peer["avatarDataUrl"].clone();
        // The resolver validates the exact local P2P coordinates; presentation never overrides them.
    } else if data["source"] == "fcm" {
        return Err("incoming push has no matching local peer".into());
    }
    Ok(data)
}

struct Actor {
    stop: CancellationToken,
    proxy: ServerSessionState,
    machine: Machine,
    binding: Option<Arc<Binding>>,
    timers: HashMap<&'static str, (u64, CancellationToken)>,
    ticket: u64,
    revision: u64,
    sender: mpsc::UnboundedSender<Input>,
    snapshot: Arc<Mutex<Value>>,
    current: Arc<AtomicU64>,
    owner: Arc<Mutex<Option<Arc<LoginConnection>>>>,
    sink: Arc<Mutex<Option<Arc<dyn Sink>>>>,
}
impl Actor {
    async fn run(mut self, mut receiver: mpsc::UnboundedReceiver<Input>) {
        loop {
            let login_cancel = self
                .binding
                .as_ref()
                .map(|binding| binding.owner.cancellation())
                .unwrap_or_default();
            let input = tokio::select! { biased;
                _ = self.stop.cancelled() => {
                    let (_,effects) = self.machine.command(json!({"type":"detach"}),0);
                    self.effects(effects);
                    break;
                }
                _ = login_cancel.cancelled(), if self.binding.is_some() => {
                    let (_,effects) = self.machine.command(json!({"type":"detach"}),0);
                    self.effects(effects);
                    self.binding = None;
                    *self.owner.lock().unwrap() = None;
                    continue;
                }
                input = receiver.recv() => match input {Some(input)=>input,None=>break},
            };
            match input {
                Input::Detach(lease) => {
                    if self.machine.lease == lease {
                        let (_, effects) = self.machine.command(json!({"type":"detach"}), 0);
                        self.effects(effects);
                    }
                }
                Input::Command {
                    owner,
                    command,
                    reply,
                } => {
                    let new_call = matches!(command, Command::NewCall { .. });
                    let owner_matches = self
                        .binding
                        .as_ref()
                        .is_some_and(|binding| Arc::ptr_eq(&binding.owner, &owner));
                    let allowed = self.admits(&owner, &command);
                    let incoming = matches!(command, Command::NewCall { incoming: true, .. });
                    let mut accepted = false;
                    if allowed {
                        let data = command.into_data();
                        if new_call
                            && self.machine.live()
                            && (!owner_matches
                                || incoming && self.machine.snapshot.phase == "starting")
                        {
                            let (_, effects) = self.machine.command(json!({"type":"cancel"}), 0);
                            self.effects(effects);
                        }
                        let old_lease = self.machine.lease;
                        let (admitted, effects) = self
                            .machine
                            .command(data, crate::native_db::chrono_millis());
                        accepted = admitted;
                        if self.machine.lease != old_lease {
                            match self.bind(owner.clone()) {
                                Ok(()) => {}
                                Err(_) => {
                                    let (_, cleanup) =
                                        self.machine.command(json!({"type":"detach"}), 0);
                                    self.effects(cleanup);
                                    accepted = false;
                                }
                            }
                        }
                        if accepted {
                            self.effects(effects);
                        }
                    }
                    let mut result = self.snapshot.lock().unwrap().clone();
                    result["accepted"] = json!(accepted);
                    let _ = reply.send(result);
                }
                Input::Http {
                    lease,
                    peer,
                    tag,
                    response,
                    binding,
                    sid,
                } => {
                    let current = self.machine.live()
                        && self.machine.lease == lease
                        && binding.owner.assert_active().is_ok();
                    if tag == "initiate" && response.ok && !current {
                        self.http(
                            binding,
                            peer,
                            "terminal".into(),
                            "/api/v1/calls/cancel".into(),
                            Some(json!({"callSid":sid})),
                            true,
                            sid,
                        );
                    } else if current && peer == self.machine.peer {
                        let effects = self.machine.response(&tag, response);
                        self.effects(effects);
                    }
                }
                Input::Timer {
                    lease,
                    kind,
                    ticket,
                } => {
                    if lease == self.machine.lease
                        && self.timers.get(kind).is_some_and(|entry| entry.0 == ticket)
                    {
                        self.timers.remove(kind);
                        let effects = self.machine.timer(kind);
                        self.effects(effects);
                    }
                }
            }
        }
    }
    fn admits(&self, owner: &Arc<LoginConnection>, command: &Command) -> bool {
        if owner.assert_active().is_err() {
            return false;
        }
        if let Command::NewCall { data, .. } = command {
            return self.machine.accepts_identity(data);
        }
        if !self.machine.live()
            || !self
                .binding
                .as_ref()
                .is_some_and(|binding| Arc::ptr_eq(&binding.owner, owner))
        {
            return false;
        }
        match command {
            Command::Server { call_sid, .. } => {
                self.machine.snapshot.call_sid.as_ref() == Some(call_sid)
            }
            Command::User {
                lease, call_sid, ..
            } => {
                *lease == self.machine.lease
                    && self.machine.snapshot.call_sid.as_ref() == Some(call_sid)
            }
            Command::Media { lease, peer, .. } => {
                *lease == self.machine.lease && *peer == self.machine.peer
            }
            Command::NewCall { .. } => unreachable!(),
        }
    }

    fn bind(&mut self, owner: Arc<LoginConnection>) -> Result<(), String> {
        let intent = LoginRequest::capture(&self.proxy, owner.clone());
        // The route is supplied at runtime construction, never reconstructed from platform mirrors.
        let captured_request = intent?;
        let (signals, mut receiver) = mpsc::unbounded_channel::<SignalRequest>();
        let binding = Arc::new(Binding {
            stop: self.stop.clone(),
            lease: self.machine.lease,
            owner: owner.clone(),
            request: captured_request,
            cancel: CancellationToken::new(),
            signals,
        });
        let captured = binding.clone();
        let sender = self.sender.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(signal) = tokio::select! { biased;
                _ = captured.cancel.cancelled() => None,
                signal = receiver.recv() => signal,
            } {
                let response =
                    request(&captured, &signal.path, signal.body.clone(), false, true).await;
                if captured.cancel.is_cancelled() {
                    break;
                }
                let _ = sender.send(Input::Http {
                    lease: captured.lease,
                    peer: signal.peer,
                    tag: signal.tag,
                    response,
                    binding: captured.clone(),
                    sid: signal.sid,
                });
            }
        });
        if let Some(previous) = self.binding.replace(binding) {
            previous.cancel.cancel();
        }
        *self.owner.lock().unwrap() = Some(owner);
        self.current.store(self.machine.lease, Ordering::Release);
        Ok(())
    }
    fn effects(&mut self, effects: Vec<Effect>) {
        for effect in effects {
            match effect {
                Effect::Platform(mut command) => {
                    self.revision += 1;
                    command["lease"] = json!(self.machine.lease);
                    command["revision"] = json!(self.revision);
                    command["loginSessionId"] = self
                        .binding
                        .as_ref()
                        .map(|binding| json!(binding.owner.id().to_string()))
                        .unwrap_or(Value::Null);
                    if command["command"] == "snapshot" {
                        command["canRing"] = json!(self.machine.can_ring());
                        *self.snapshot.lock().unwrap() = command.clone();
                    }
                    let sink = self.sink.lock().unwrap().clone();
                    if let Some(sink) = sink {
                        sink.command(command);
                    }
                }
                Effect::Http {
                    tag,
                    path,
                    body,
                    terminal,
                } => {
                    let Some(binding) = self.binding.clone() else {
                        continue;
                    };
                    let sid = body
                        .as_ref()
                        .and_then(|body| body["callSid"].as_str())
                        .unwrap_or(self.machine.snapshot.call_sid.as_deref().unwrap_or(""))
                        .to_string();
                    if path.ends_with("/signal") {
                        let _ = binding.signals.send(SignalRequest {
                            peer: self.machine.peer,
                            tag,
                            path,
                            body,
                            sid,
                        });
                    } else {
                        self.http(binding, self.machine.peer, tag, path, body, terminal, sid);
                    }
                }
                Effect::Arm(kind, delay) => {
                    self.cancel_timer(kind);
                    self.ticket += 1;
                    let ticket = self.ticket;
                    let cancel = CancellationToken::new();
                    self.timers.insert(kind, (ticket, cancel.clone()));
                    let sender = self.sender.clone();
                    let lease = self.machine.lease;
                    tauri::async_runtime::spawn(async move {
                        tokio::select! { biased;
                            _ = cancel.cancelled() => {},
                            _ = tokio::time::sleep(std::time::Duration::from_millis(delay)) => { let _ = sender.send(Input::Timer {lease,kind,ticket}); }
                        }
                    });
                }
                Effect::Cancel(kind) => self.cancel_timer(kind),
                Effect::Retire => {
                    for (_, (_, cancel)) in self.timers.drain() {
                        cancel.cancel();
                    }
                    if let Some(binding) = &self.binding {
                        binding.cancel.cancel();
                    }
                }
            }
        }
    }
    fn cancel_timer(&mut self, kind: &'static str) {
        if let Some((_, cancel)) = self.timers.remove(kind) {
            cancel.cancel();
        }
    }
    fn http(
        &self,
        binding: Arc<Binding>,
        peer: u64,
        tag: String,
        path: String,
        body: Option<Value>,
        terminal: bool,
        sid: String,
    ) {
        let sender = self.sender.clone();
        tauri::async_runtime::spawn(async move {
            let response =
                request(&binding, &path, body, terminal || tag == "initiate", false).await;
            if !terminal {
                let _ = sender.send(Input::Http {
                    lease: binding.lease,
                    peer,
                    tag,
                    response,
                    binding,
                    sid,
                });
            }
        });
    }
}

async fn request(
    binding: &Binding,
    path: &str,
    body: Option<Value>,
    terminal: bool,
    retry_signal: bool,
) -> Response {
    let owner_cancel = binding.owner.cancellation();
    let perform = async {
        let mut intent = binding.request.clone();
        for attempt in 0..=u8::from(retry_signal || body.is_none()) {
            let Ok(endpoint) = intent.endpoint() else {
                break;
            };
            let mut request = endpoint
                .client
                .request(
                    if body.is_some() {
                        reqwest::Method::POST
                    } else {
                        reqwest::Method::GET
                    },
                    format!("{}{path}", endpoint.origin),
                )
                .bearer_auth(&endpoint.credential)
                .timeout(std::time::Duration::from_secs(20));
            if let Some(body) = &body {
                request = request.json(body);
            }
            match request.send().await {
                Ok(response) => {
                    let success = response.status().is_success();
                    let Ok(envelope) = response.json::<Value>().await else {
                        break;
                    };
                    return Response {
                        ok: success && envelope["code"] == 0,
                        code: envelope["code"].as_i64().unwrap_or(-1),
                        data: envelope["data"].clone(),
                    };
                }
                Err(_) if attempt == 0 && (retry_signal || body.is_none()) => {
                    if let Some((endpoint, _)) = intent.select_endpoint().await {
                        intent = intent.at_endpoint(&endpoint);
                    }
                }
                Err(_) => break,
            }
        }
        Response {
            ok: false,
            code: -1,
            data: Value::Null,
        }
    };
    let response = tokio::select! { biased;
        _ = binding.stop.cancelled() => Response::default(),
        _ = owner_cancel.cancelled() => Response::default(),
        _ = binding.cancel.cancelled(), if !terminal => Response::default(),
        response = perform => response,
    };
    if binding.owner.assert_active().is_err() {
        Response::default()
    } else {
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::login_session_store::LoginSessionId;
    use std::time::Duration;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    const SID: &str = "00000000-0000-4000-8000-000000000001";
    fn owner() -> Arc<LoginConnection> {
        let owner = LoginConnection::preparing(
            LoginSessionId::try_from(uuid::Uuid::new_v4().to_string()).unwrap(),
            rusqlite::Connection::open_in_memory().unwrap(),
        );
        owner
            .begin_activation()
            .unwrap()
            .commit("original-token".into())
            .unwrap();
        owner
    }
    fn proxy(origin: &str) -> ServerSessionState {
        let proxy = ServerSessionState::new();
        *proxy.api_origin.lock().unwrap() = origin.into();
        *proxy.api_origin_primary.lock().unwrap() = origin.into();
        proxy
    }
    async fn dispatch(
        runtime: &Runtime,
        owner: Arc<LoginConnection>,
        lease: u64,
        data: Value,
    ) -> Value {
        let command = match Command::decode(lease, data) {
            Ok(command) => command,
            // Undecodable input is rejected at the boundary: it never reaches the machine.
            Err(_) => {
                let mut result = runtime.snapshot.lock().unwrap().clone();
                result["accepted"] = json!(false);
                return result;
            }
        };
        let (reply, receive) = oneshot::channel();
        runtime
            .sender
            .send(Input::Command {
                owner,
                command,
                reply,
            })
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), receive)
            .await
            .unwrap()
            .unwrap()
    }
    async fn headers(socket: &mut tokio::net::TcpStream) -> String {
        let mut bytes = Vec::new();
        while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
            let mut part = [0; 4096];
            let count = socket.read(&mut part).await.unwrap();
            assert_ne!(count, 0);
            bytes.extend_from_slice(&part[..count]);
        }
        String::from_utf8(bytes).unwrap()
    }
    struct Recording(Mutex<Vec<Value>>);
    impl Sink for Recording {
        fn command(&self, value: Value) {
            self.0.lock().unwrap().push(value);
        }
    }
    #[tokio::test]
    async fn command_requires_the_original_login_identity_before_lookup_or_dispatch() {
        let proxy = ServerSessionState::new();
        *proxy.login_session.lock().unwrap() =
            Some(LoginSessionId::try_from(uuid::Uuid::new_v4().to_string()).unwrap());
        let runtime = Runtime::new(proxy);
        assert!(runtime.command(0,json!({"type":"initiate","callSid":SID,"loginSessionId":uuid::Uuid::new_v4().to_string()})).await.is_err());
        assert!(runtime
            .command(0, json!({"type":"initiate","callSid":SID}))
            .await
            .is_err());
        assert_eq!(
            runtime.snapshot.lock().unwrap()["snapshot"]["phase"],
            "idle"
        );
    }
    #[tokio::test]
    async fn a_server_frame_queued_before_its_call_admission_still_applies() {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let runtime = Runtime::new(proxy(&format!("http://{}", server.local_addr().unwrap())));
        let owner = owner();
        let incoming = dispatch(
            &runtime,
            owner.clone(),
            0,
            json!({"type":"incoming","callSid":SID,"threadId":1}),
        )
        .await;
        let lease = incoming["lease"].as_u64().unwrap();
        // Captured before the incoming command adopted its lease: a server fact identifies
        // its login and call, never the renderer's current media lease.
        let signal = dispatch(
            &runtime,
            owner.clone(),
            0,
            json!({"type":"frame","event":"CALL_SIGNAL","data":{"callSid":SID,
                "kind":"offer","id":"00000000-0000-4000-8000-000000000003","payload":"opaque-offer"}}),
        )
        .await;
        assert_eq!(signal["accepted"], true);
        assert_eq!(
            runtime.snapshot.lock().unwrap()["snapshot"]["step"],
            "offer-received"
        );
        // A stale-lease media callback and a foreign call's event never apply.
        let stale = dispatch(
            &runtime,
            owner.clone(),
            lease + 1,
            json!({"type":"peer-ready","peer":1,"cameraEnabled":false}),
        )
        .await;
        assert_eq!(stale["accepted"], false);
        let foreign = dispatch(
            &runtime,
            owner.clone(),
            0,
            json!({"type":"frame","event":"CALL_EVENT",
                "data":{"callSid":"00000000-0000-4000-8000-000000000002","type":"ended"}}),
        )
        .await;
        assert_eq!(foreign["accepted"], false);
        owner.end().unwrap();
    }
    #[tokio::test]
    async fn cancelled_call_cannot_authorize_an_incoming_service_after_accept() {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let runtime = Runtime::new(proxy(&format!("http://{}", server.local_addr().unwrap())));
        let owner = owner();
        let incoming = dispatch(
            &runtime,
            owner.clone(),
            0,
            json!({"type":"incoming","callSid":SID,"threadId":1}),
        )
        .await;
        let lease = incoming["lease"].as_u64().unwrap();
        assert!(runtime.can_ring(lease));
        dispatch(
            &runtime,
            owner.clone(),
            lease,
            json!({"type":"accept","callSid":SID}),
        )
        .await;
        assert!(!runtime.can_ring(lease));
        runtime.detach(lease);
        tokio::time::timeout(Duration::from_secs(2), async {
            while runtime.is_live(lease) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!runtime.can_ring(lease));
        owner.end().unwrap();
    }
    #[tokio::test]
    async fn hanging_initiate_never_blocks_hangup_and_late_success_is_cancelled_without_reviving_media(
    ) {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let runtime = Runtime::new(proxy(&format!("http://{}", server.local_addr().unwrap())));
        let owner = owner();
        let recording = Arc::new(Recording(Mutex::new(Vec::new())));
        runtime.bind(recording.clone());
        let starting = dispatch(
            &runtime,
            owner.clone(),
            0,
            json!({"type":"initiate","callSid":SID,"threadId":1}),
        )
        .await;
        let lease = starting["lease"].as_u64().unwrap();
        let (mut initiate, _) = tokio::time::timeout(Duration::from_secs(2), server.accept())
            .await
            .unwrap()
            .unwrap();
        assert!(headers(&mut initiate)
            .await
            .starts_with("POST /api/v1/calls/initiate "));
        let ended = dispatch(
            &runtime,
            owner.clone(),
            lease,
            json!({"type":"cancel","callSid":SID}),
        )
        .await;
        assert_eq!(ended["snapshot"]["phase"], "idle");
        assert!(!runtime.is_live(lease));
        let (mut cancel, _) = tokio::time::timeout(Duration::from_secs(2), server.accept())
            .await
            .unwrap()
            .unwrap();
        assert!(headers(&mut cancel)
            .await
            .starts_with("POST /api/v1/calls/cancel "));
        let body = r#"{"code":0,"data":{"threadId":1}}"#;
        initiate
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let (mut cleanup, _) = tokio::time::timeout(Duration::from_secs(2), server.accept())
            .await
            .unwrap()
            .unwrap();
        assert!(headers(&mut cleanup)
            .await
            .starts_with("POST /api/v1/calls/cancel "));
        assert_eq!(
            runtime.snapshot.lock().unwrap()["snapshot"]["phase"],
            "idle"
        );
        assert!(!recording
            .0
            .lock()
            .unwrap()
            .iter()
            .any(|command| command["command"] == "create-peer"));
        owner.end().unwrap();
    }
    #[tokio::test]
    async fn malformed_incoming_identity_cannot_replace_an_outgoing_setup() {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let runtime = Runtime::new(proxy(&format!("http://{}", server.local_addr().unwrap())));
        let owner = owner();
        let initial = dispatch(
            &runtime,
            owner.clone(),
            0,
            json!({"type":"initiate","callSid":SID,"threadId":1}),
        )
        .await;
        let lease = initial["lease"].as_u64().unwrap();
        let rejected = dispatch(
            &runtime,
            owner.clone(),
            lease,
            json!({"type":"incoming","callSid":"bad-id","threadId":1}),
        )
        .await;
        assert_eq!(rejected["accepted"], false);
        assert_eq!(rejected["snapshot"]["callSid"], SID);
        assert_eq!(rejected["snapshot"]["phase"], "starting");
        owner.end().unwrap();
    }
    #[tokio::test]
    async fn logout_cancels_in_flight_signaling_and_releases_the_original_call() {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let runtime = Runtime::new(proxy(&format!("http://{}", server.local_addr().unwrap())));
        let owner = owner();
        let incoming = dispatch(
            &runtime,
            owner.clone(),
            0,
            json!({"type":"incoming","callSid":SID,"threadId":1}),
        )
        .await;
        let lease = incoming["lease"].as_u64().unwrap();
        let (mut socket, _) = tokio::time::timeout(Duration::from_secs(2), server.accept())
            .await
            .unwrap()
            .unwrap();
        let request = headers(&mut socket).await;
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer original-token"));
        owner.end().unwrap();
        let mut bytes = [0; 4096];
        let closed = tokio::time::timeout(Duration::from_secs(2), socket.read(&mut bytes))
            .await
            .unwrap();
        assert!(matches!(closed, Ok(0) | Err(_)));
        tokio::time::timeout(Duration::from_secs(2), async {
            while runtime.snapshot.lock().unwrap()["snapshot"]["phase"] != "idle" {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!runtime.is_current(lease));
    }
    #[tokio::test]
    async fn queued_commands_from_an_ended_owner_cannot_admit_a_call() {
        let runtime = Runtime::new(ServerSessionState::new());
        let owner = owner();
        owner.end().unwrap();
        let result = dispatch(
            &runtime,
            owner,
            0,
            json!({"type":"initiate","callSid":SID,"threadId":1}),
        )
        .await;
        assert_eq!(result["accepted"], false);
        assert_eq!(result["snapshot"]["phase"], "idle");
    }
}
