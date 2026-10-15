//! Platform-independent ownership and publication boundary for the shared SSE protocol.
use crate::ServerSessionState;
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

static RUNTIME: std::sync::OnceLock<Supervisor> = std::sync::OnceLock::new();
pub(crate) fn runtime() -> &'static Supervisor {
    RUNTIME.get_or_init(Supervisor::new)
}

pub(crate) enum Output {
    Event(String, Value),
    State(String),
    ReconnectIn(u64),
    ForceLogout(Option<String>),
    Reconnect,
    Origin(String, String),
    Identity(i32, i64),
    #[cfg(any(target_os = "android", test))]
    Notifications(crate::native_db::notifications::NotificationBatch),
    IncomingCall(Value),
}
pub(crate) trait Sink: Send + Sync {
    fn bind_lease(&self, _lease: u64) {}
    fn publish(&self, output: Output);
    fn fork(&self) -> Arc<dyn Sink>;
    fn app(&self) -> Option<&tauri::AppHandle> {
        None
    }
}

pub(crate) struct Run {
    /// Private worker generation; callbacks carry this value through platform queues.
    pub lease: u64,
    /// Stable OS owner handle. Rebinding an account/cache worker does not change its service owner.
    owner_lease: AtomicU64,
    generation: Arc<AtomicU64>,
    admission: Arc<Mutex<()>>,
    pub cancel: CancellationToken,
    pub wake: Arc<Notify>,
    pub offline: Arc<AtomicBool>,
    pub force: AtomicBool,
    pub state: Mutex<String>,
    pub hello: Arc<Mutex<Option<Value>>>,
    identity: std::sync::OnceLock<(u64, String)>,
    proxy: ServerSessionState,
    sink: Arc<dyn Sink>,
}
impl Run {
    pub fn owner(&self) -> u64 {
        self.owner_lease.load(Ordering::Acquire)
    }
    pub fn active(&self) -> bool {
        !self.cancel.is_cancelled() && self.generation.load(Ordering::Acquire) == self.lease
    }
    pub fn authenticated(&self) -> bool {
        if !self.active() {
            return false;
        }
        self.identity.get().is_some_and(|(epoch, token)| {
            crate::native_db::is_account_epoch_current(*epoch)
                && self.proxy.token.lock().unwrap().as_ref() == Some(token)
                && self.active()
                && crate::native_db::is_account_epoch_current(*epoch)
        })
    }
    pub fn bind_identity(&self) -> bool {
        let Ok(epoch) = crate::native_db::capture_account_epoch() else {
            return false;
        };
        let Some(token) = self.proxy.token.lock().unwrap().clone() else {
            return false;
        };
        let _ = self.identity.set((epoch, token));
        self.authenticated()
    }
    pub fn publish(&self, output: Output) {
        if self.authenticated() {
            self.sink.publish(output);
        }
    }
    pub fn app(&self) -> Option<&tauri::AppHandle> {
        self.sink.app()
    }
    pub fn publish_origin(&self) {
        self.publish(Output::Origin(
            self.proxy.api_origin.lock().unwrap().clone(),
            format!("{:?}", *self.proxy.origin_mode.lock().unwrap()).to_lowercase(),
        ));
    }
    pub async fn pick_origin(&self) -> Option<String> {
        tokio::select! { biased;
            _ = self.cancel.cancelled() => None,
            result = crate::proxy::pick_origin_race_with_commit(&self.proxy, |origin, mode| {
                // Authentication can wait for a credential transition. Never hold the runtime
                // admission lock across that wait; commit-time epoch and generation reads are atomic.
                if !self.authenticated() { return false; }
                let _admission = self.admission.lock().unwrap();
                if !self.active() || !self.identity.get().is_some_and(|(epoch, _)| crate::native_db::is_account_epoch_current(*epoch)) { return false; }
                crate::activate_origin(&self.proxy, origin, mode);
                true
            }) => result,
        }
    }
    // Legacy desktop envelopes stay intact; Android receives StandardMessage's inner data.
    pub fn emit<T: serde::Serialize>(&self, channel: &str, payload: T) -> Result<(), String> {
        let v = serde_json::to_value(payload).map_err(|e| e.to_string())?;
        let output = match channel {
            "soms-sse-event" => Output::Event(v["event"].as_str().unwrap_or_default().into(), v),
            "soms-sse-state" => Output::State(v.as_str().unwrap_or("closed").into()),
            "soms-sse-reconnect-in" => Output::ReconnectIn(v.as_u64().unwrap_or(0)),
            "soms-sse-force-logout" => Output::ForceLogout(v["reason"].as_str().map(str::to_owned)),
            "soms-sse-reconnect" => Output::Reconnect,
            _ => return Ok(()),
        };
        self.publish(output);
        Ok(())
    }
    pub fn set_state(&self, state: &str) {
        let bound = self.identity.get().is_some();
        if !self.active() || (state != "closed" && bound && !self.authenticated()) {
            return;
        }
        *self.state.lock().unwrap() = state.into();
        // Startup may precede login. Lifecycle state requires a lease, not authentication.
        if self.active() {
            self.sink.publish(Output::State(state.into()));
        }
    }
    pub fn replay_snapshot(&self) -> Option<Value> {
        let hello = self.replay()?;
        if !self.authenticated() {
            return None;
        }
        Some(serde_json::json!({ "generation": self.lease, "hello": hello }))
    }
    pub fn replay(&self) -> Option<Value> {
        if !self.authenticated() {
            return None;
        }
        self.hello.lock().unwrap().clone()
    }
}
pub(crate) struct Supervisor {
    next_owner: AtomicU64,
    generation: Arc<AtomicU64>,
    admission: Arc<Mutex<()>>,
    run: Mutex<Option<Arc<Run>>>,
}
impl Supervisor {
    pub fn new() -> Self {
        Self {
            next_owner: AtomicU64::new(0),
            generation: Arc::new(AtomicU64::new(0)),
            admission: Arc::new(Mutex::new(())),
            run: Mutex::new(None),
        }
    }
    pub fn start(&self, proxy: ServerSessionState, sink: Arc<dyn Sink>) -> u64 {
        self.start_inner(proxy, sink, false, None, false)
    }
    pub fn replace(&self, proxy: ServerSessionState, sink: Arc<dyn Sink>) -> u64 {
        self.start_inner(proxy, sink, true, None, false)
    }
    fn start_inner(
        &self,
        proxy: ServerSessionState,
        sink: Arc<dyn Sink>,
        replace: bool,
        expected: Option<u64>,
        offline: bool,
    ) -> u64 {
        let mut slot = self.run.lock().unwrap();
        if expected.is_some_and(|lease| !slot.as_ref().is_some_and(|r| r.owner() == lease)) {
            return 0;
        }
        let owner = expected.unwrap_or_else(|| self.next_owner.fetch_add(1, Ordering::AcqRel) + 1);
        if !replace {
            if let Some(run) = slot.as_ref() {
                if run.active() {
                    // A reclaimed desktop renderer gets its own control lease without reopening SSE.
                    run.owner_lease.store(owner, Ordering::Release);
                    return owner;
                }
            }
        }
        let _admission = self.admission.lock().unwrap();
        let lease = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        if let Some(old) = slot.take() {
            old.cancel.cancel();
            old.wake.notify_one();
        }
        sink.bind_lease(lease);
        let run = Arc::new(Run {
            lease,
            owner_lease: AtomicU64::new(owner),
            generation: self.generation.clone(),
            admission: self.admission.clone(),
            cancel: CancellationToken::new(),
            wake: Arc::new(Notify::new()),
            offline: Arc::new(AtomicBool::new(offline)),
            force: AtomicBool::new(false),
            state: Mutex::new("closed".into()),
            hello: Arc::new(Mutex::new(None)),
            identity: std::sync::OnceLock::new(),
            proxy: proxy.clone(),
            sink,
        });
        *slot = Some(run.clone());
        tauri::async_runtime::spawn(crate::sse::run_loop(run, proxy));
        owner
    }
    pub fn current(&self) -> Option<Arc<Run>> {
        self.run.lock().unwrap().clone()
    }
    pub fn stop(&self, lease: u64) {
        let old = {
            let mut slot = self.run.lock().unwrap();
            if !slot.as_ref().is_some_and(|r| r.owner() == lease) {
                return;
            }
            let _admission = self.admission.lock().unwrap();
            self.generation.fetch_add(1, Ordering::AcqRel);
            slot.take()
        };
        if let Some(run) = old {
            run.cancel.cancel();
            run.wake.notify_one();
        }
    }
    pub fn net(&self, lease: u64, online: bool, force: bool) {
        let slot = self.run.lock().unwrap();
        if let Some(run) = slot.as_ref().filter(|r| r.owner() == lease && r.active()) {
            run.offline.store(!online, Ordering::Release);
            if force {
                run.force.store(true, Ordering::Release);
            }
            run.wake.notify_one();
        }
    }
    /// Only an explicit request may replace a terminal worker. Network observations never reclaim a
    /// server-replaced stream. Return the authoritative lease so the OS adapter can rebind its handle.
    pub fn retry(&self, lease: u64, force: bool) -> u64 {
        let Some(run) = self.current().filter(|r| r.owner() == lease) else {
            return 0;
        };
        let unbound = run.identity.get().is_none();
        if run.active() && (unbound || run.authenticated()) {
            let slot = self.run.lock().unwrap();
            if !slot.as_ref().is_some_and(|current| {
                current.owner() == lease && current.lease == run.lease && current.active()
            }) {
                return 0;
            }
            if force {
                run.force.store(true, Ordering::Release);
            }
            run.wake.notify_one();
            return lease;
        }
        let offline = run.offline.load(Ordering::Acquire);
        self.start_inner(
            run.proxy.clone(),
            run.sink.fork(),
            true,
            Some(lease),
            offline,
        )
    }
    pub fn refresh_account_epoch(&self) {
        if let Some(run) = self.current() {
            let bound = run.identity.get().is_some();
            let has_token = run.proxy.token.lock().unwrap().is_some();
            if has_token && (!run.active() || (bound && !run.authenticated())) {
                self.retry(run.owner(), true);
            }
        }
    }
    pub fn is_current_generation(&self, generation: u64) -> bool {
        self.current().is_some_and(|r| {
            r.lease == generation && self.generation.load(Ordering::Acquire) == generation
        })
    }
    pub fn state(&self) -> String {
        self.current()
            .filter(|r| r.active())
            .map(|r| r.state.lock().unwrap().clone())
            .unwrap_or_else(|| "closed".into())
    }
}

/// Capture at scheduling, rather than looking up the successor at completion.
#[derive(Clone)]
pub(crate) struct NativeEvents {
    run: Option<Arc<Run>>,
    app: Option<tauri::AppHandle>,
    epoch: Option<u64>,
    session: Option<(ServerSessionState, Option<String>)>,
}
impl NativeEvents {
    pub fn capture(app: Option<&tauri::AppHandle>) -> Self {
        use tauri::Manager;
        let run = WORK_RUN.try_with(Clone::clone).ok();
        #[cfg(target_os = "android")]
        let run = run.or_else(crate::android_realtime::current_run);
        let session = app
            .and_then(|app| app.try_state::<ServerSessionState>())
            .map(|state| {
                let proxy = state.inner().clone();
                let token = proxy.token.lock().unwrap().clone();
                (proxy, token)
            });
        Self {
            run,
            app: app.cloned(),
            epoch: crate::native_db::capture_account_epoch().ok(),
            session,
        }
    }
    pub fn emit<T: serde::Serialize>(&self, channel: &str, payload: T) -> Result<(), String> {
        if !self
            .epoch
            .is_some_and(crate::native_db::is_account_epoch_current)
        {
            return Ok(());
        }
        if self
            .session
            .as_ref()
            .is_some_and(|(proxy, token)| *proxy.token.lock().unwrap() != *token)
        {
            return Ok(());
        }
        if let Some(run) = &self.run {
            return run.emit(channel, payload);
        }
        #[cfg(desktop)]
        if let Some(app) = &self.app {
            use tauri::Emitter;
            let payload = serde_json::to_value(payload).map_err(|e| e.to_string())?;
            app.emit(channel, payload).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

tokio::task_local! { pub(crate) static WORK_RUN: Arc<Run>; }
/// Carry the original lease into queued database jobs, not whichever run is current later.
pub(crate) fn spawn(run: Arc<Run>, work: impl std::future::Future<Output = ()> + Send + 'static) {
    tauri::async_runtime::spawn(WORK_RUN.scope(run, work));
}

#[cfg(desktop)]
pub(crate) struct DesktopSink(pub tauri::AppHandle, AtomicU64);
#[cfg(desktop)]
impl DesktopSink {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self(app, AtomicU64::new(0))
    }
}
#[cfg(desktop)]
impl Sink for DesktopSink {
    fn bind_lease(&self, generation: u64) {
        self.1.store(generation, Ordering::Release);
    }
    fn fork(&self) -> Arc<dyn Sink> {
        Arc::new(Self::new(self.0.clone()))
    }
    fn app(&self) -> Option<&tauri::AppHandle> {
        Some(&self.0)
    }
    fn publish(&self, output: Output) {
        if !runtime().is_current_generation(self.1.load(Ordering::Acquire)) {
            return;
        }
        use tauri::Emitter;
        match output {
            Output::Event(_, v) => {
                let _ = self.0.emit("soms-sse-event", v);
            }
            Output::State(v) => {
                let _ = self.0.emit("soms-sse-state", v);
            }
            Output::ReconnectIn(v) => {
                let _ = self.0.emit("soms-sse-reconnect-in", v);
            }
            Output::ForceLogout(reason) => {
                let _ = self.0.emit(
                    "soms-sse-force-logout",
                    serde_json::json!({"reason": reason}),
                );
            }
            Output::Reconnect => {
                let _ = self.0.emit("soms-sse-reconnect", ());
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Null;
    impl Sink for Null {
        fn publish(&self, _: Output) {}
        fn fork(&self) -> Arc<dyn Sink> {
            Arc::new(Null)
        }
    }
    struct Recording(Arc<Mutex<Vec<String>>>);
    impl Sink for Recording {
        fn publish(&self, output: Output) {
            if let Output::State(state) = output {
                self.0.lock().unwrap().push(state);
            }
        }
        fn fork(&self) -> Arc<dyn Sink> {
            Arc::new(Self(self.0.clone()))
        }
    }

    #[test]
    fn desktop_reattach_transfers_control_without_reopening_the_worker() {
        let supervisor = Supervisor::new();
        let proxy = ServerSessionState::new();
        let first = supervisor.start(proxy.clone(), Arc::new(Null));
        let retained = supervisor.current().unwrap();
        let next = supervisor.start(proxy, Arc::new(Null));
        assert_ne!(first, next);
        assert_eq!(supervisor.current().unwrap().lease, retained.lease);
        supervisor.stop(first);
        supervisor.net(first, false, true);
        assert_eq!(supervisor.retry(first, true), 0);
        assert!(retained.active());
        assert!(!retained.offline.load(Ordering::Acquire));
        assert!(!retained.force.load(Ordering::Acquire));
        supervisor.stop(next);
    }

    #[test]
    fn authentication_loss_still_publishes_terminal_closed() {
        let supervisor = Supervisor::new();
        let states = Arc::new(Mutex::new(Vec::new()));
        let owner = supervisor.start(
            ServerSessionState::new(),
            Arc::new(Recording(states.clone())),
        );
        let run = supervisor.current().unwrap();
        run.set_state("open");
        run.identity.set((u64::MAX, "fixture".into())).unwrap();
        assert!(!run.authenticated());
        run.set_state("closed");
        assert_eq!(supervisor.state(), "closed");
        assert_eq!(*states.lock().unwrap(), vec!["open", "closed"]);
        run.cancel.cancel();
        supervisor.net(owner, false, false);
        assert!(!run.offline.load(Ordering::Acquire));
        supervisor.stop(owner);
    }

    #[test]
    fn replay_returns_one_generation_tagged_snapshot_and_rejects_cancelled_source() {
        let supervisor = Supervisor::new();
        let proxy = ServerSessionState::new();
        let owner = supervisor.start(proxy.clone(), Arc::new(Null));
        let run = supervisor.current().unwrap();
        run.offline.store(true, Ordering::Release);
        *proxy.token.lock().unwrap() = Some("fixture-not-a-credential".into());
        assert!(run.bind_identity());
        let hello = serde_json::json!({"userId":41,"threadFeedEndId":7});
        *run.hello.lock().unwrap() = Some(hello.clone());
        let snapshot = run.replay_snapshot().unwrap();
        assert_eq!(snapshot["generation"], run.lease);
        assert_eq!(snapshot["hello"], hello);
        run.cancel.cancel();
        assert!(run.replay_snapshot().is_none());
        supervisor.stop(owner);
    }

    #[test]
    fn explicit_retry_rebinds_worker_but_preserves_os_owner_and_offline_fact() {
        let supervisor = Supervisor::new();
        let owner = supervisor.start(ServerSessionState::new(), Arc::new(Null));
        let old = supervisor.current().unwrap();
        supervisor.net(owner, false, false);
        old.cancel.cancel(); // Terminal stream, as after SSE_REPLACED.
        supervisor.net(owner, true, false);
        assert_eq!(supervisor.current().unwrap().lease, old.lease);
        assert_eq!(supervisor.retry(owner, false), owner);
        let next = supervisor.current().unwrap();
        assert_ne!(next.lease, old.lease);
        assert_eq!(next.owner(), owner);
        assert!(next.offline.load(Ordering::Acquire));
        assert!(!supervisor.is_current_generation(old.lease));
        assert!(supervisor.is_current_generation(next.lease));
        supervisor.stop(owner);
        assert!(!supervisor.is_current_generation(next.lease));
    }

    #[test]
    fn cache_epoch_rebind_preserves_owner_and_invalidates_queued_worker_commands() {
        let supervisor = Supervisor::new();
        let proxy = ServerSessionState::new();
        let owner = supervisor.start(proxy.clone(), Arc::new(Null));
        let old = supervisor.current().unwrap();
        old.offline.store(true, Ordering::Release);
        let token = "fixture-not-a-credential".to_owned();
        *proxy.token.lock().unwrap() = Some(token.clone());
        // Model an expired cache epoch without mutating the process-global database lifetime.
        old.identity.set((u64::MAX, token)).unwrap();
        supervisor.refresh_account_epoch();
        let current = supervisor.current().unwrap();
        assert_eq!(current.owner(), owner);
        assert_ne!(current.lease, old.lease);
        assert!(!old.active());
        assert!(!supervisor.is_current_generation(old.lease));
        assert!(supervisor.is_current_generation(current.lease));
        supervisor.stop(owner);
    }

    #[test]
    fn stale_retry_cannot_reclaim_a_successor_owner() {
        let supervisor = Supervisor::new();
        let old = supervisor.start(ServerSessionState::new(), Arc::new(Null));
        supervisor.stop(old);
        let next = supervisor.start(ServerSessionState::new(), Arc::new(Null));
        assert_eq!(supervisor.retry(old, true), 0);
        assert_eq!(supervisor.current().unwrap().owner(), next);
        supervisor.stop(next);
    }

    #[test]
    fn stopped_run_and_stale_commands_cannot_touch_successor() {
        let supervisor = Supervisor::new();
        let first = supervisor.start(ServerSessionState::new(), Arc::new(Null));
        let old = supervisor.current().unwrap();
        supervisor.stop(first);
        assert!(!old.active());
        assert!(old.cancel.is_cancelled());
        let next = supervisor.start(ServerSessionState::new(), Arc::new(Null));
        assert_ne!(first, next);
        supervisor.stop(first);
        supervisor.net(first, false, true);
        let run = supervisor.current().unwrap();
        assert!(run.active());
        assert!(!run.offline.load(Ordering::Acquire));
        assert!(!run.force.load(Ordering::Acquire));
        old.set_state("open");
        assert_eq!(supervisor.state(), "closed");
        assert!(old.replay().is_none());
        supervisor.stop(next);
    }
}
