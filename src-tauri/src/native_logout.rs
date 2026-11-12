#[cfg(any(not(desktop), test))]
use std::collections::HashMap;
use std::sync::Arc;
#[cfg(any(not(desktop), test))]
use std::sync::Mutex;
use std::time::Duration;

#[cfg(any(not(desktop), test))]
use log::warn;
use tokio::task::JoinHandle;

const LOGOUT_TIMEOUT: Duration = Duration::from_secs(10);

/// Detached revocation owns the ended credential and origin, never the mutable session state.
/// A ticket identifies only this bounded operation; it is not a login identity or credential.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum LogoutOutcome {
    Revoked,
    HttpFailure { status_code: u16 },
    TransportFailure,
    TimedOut,
    TaskFailure,
    UnknownTicket,
}

/// One logout owns admission and its captured credential across all user-triggered attempts.
/// The coordinator retains this value on network or cleanup failure. No storage identity checks
/// are needed: the transition excludes another login until final cleanup succeeds.
#[derive(Clone, Copy, PartialEq, Eq)]
enum LogoutPhase {
    AwaitingRevocation,
    CleanupAfterRevocation,
    CleanupLocalOnly,
}

pub(crate) struct LogoutOperation {
    client: reqwest::Client,
    origin: String,
    token: String,
    transition: Option<crate::auth_lifecycle::TransitionGuard>,
    phase: LogoutPhase,
    session: Option<crate::login_session_store::LoginSessionId>,
    preparation_owner: Option<Arc<crate::login_connection::LoginConnection>>,
    preparation_task: Option<JoinHandle<Result<(), String>>>,
    cleanup_task: Option<JoinHandle<Result<(), String>>>,
}

impl LogoutOperation {
    pub(crate) fn new(
        client: reqwest::Client,
        origin: String,
        token: String,
        transition: crate::auth_lifecycle::TransitionGuard,
    ) -> Self {
        Self { client, origin, token, transition: Some(transition), phase: LogoutPhase::AwaitingRevocation,
            session: None, preparation_owner: None, preparation_task: None, cleanup_task: None }
    }

    async fn prepare(&mut self) -> Result<(), String> {
        let Some(owner) = self.preparation_owner.clone() else { return Ok(()) };
        if self.preparation_task.is_none() {
            self.preparation_task = Some(tokio::task::spawn_blocking(move || {
                end_and_drain_notifications(&owner)?;
                let preferences = crate::native_db::preferences_connection()?;
                // Keep the owner available for retry if either persistence or release fails.
                preferences.with_database(|conn| {
                    crate::login_session_store::SessionStore::begin_revocation(conn, owner.id())
                })?;
                crate::native_db::release_login_connection(&owner)
            }));
        }
        // Borrow the handle: cancelling this waiter does not detach it from the operation.
        let result = self.preparation_task.as_mut().unwrap().await;
        self.preparation_task = None;
        result.map_err(|e| format!("join logout preparation: {e}"))??;
        self.preparation_owner = None;
        Ok(())
    }

    pub(crate) async fn revoke(&mut self) -> LogoutOutcome {
        if self.transition.is_none() {
            return LogoutOutcome::TaskFailure;
        }
        match self.phase {
            LogoutPhase::CleanupLocalOnly => return LogoutOutcome::TaskFailure,
            LogoutPhase::CleanupAfterRevocation => return LogoutOutcome::Revoked,
            LogoutPhase::AwaitingRevocation => {}
        }
        let outcome = revoke_once(&self.client, &self.origin, &self.token, LOGOUT_TIMEOUT).await;
        if outcome == LogoutOutcome::Revoked {
            self.phase = LogoutPhase::CleanupAfterRevocation;
        }
        outcome
    }

    /// The caller invokes this only after success or an explicit local-only decision.
    /// Failed cleanup retains the transition and credential so the coordinator can retry cleanup.
    pub(crate) async fn finish<F>(&mut self, local_only: bool, cleanup: F) -> Result<(), String>
    where
        F: std::future::Future<Output = Result<(), String>>,
    {
        if self.transition.is_none() {
            return Ok(());
        }
        if self.phase == LogoutPhase::AwaitingRevocation {
            if !local_only {
                return Err("session revocation is unconfirmed; explicit local-only decision required".into());
            }
            self.phase = LogoutPhase::CleanupLocalOnly;
        }
        cleanup.await?;
        self.token.clear();
        self.transition.take();
        Ok(())
    }
}

async fn revoke_once(
    client: &reqwest::Client,
    origin: &str,
    token: &str,
    deadline: Duration,
) -> LogoutOutcome {
    let target = format!("{origin}/api/v1/auth/logout");
    // The caller owns the transport future. Timeout or caller cancellation drops it
    // before releasing the coordinator lane; no detached attempt survives a retry.
    match tokio::time::timeout(
        deadline,
        client.post(&target)
            .header("authorization", format!("Bearer {token}"))
            .json(&serde_json::json!({}))
            .send(),
    ).await {
        Ok(Ok(response)) if response.status().is_success() => LogoutOutcome::Revoked,
        Ok(Ok(response)) => LogoutOutcome::HttpFailure { status_code: response.status().as_u16() },
        Ok(Err(_)) => LogoutOutcome::TransportFailure,
        Err(_) => LogoutOutcome::TimedOut,
    }
}

/// Rust-owned slot for one logout. The async mutex serializes commands, not OS or lifecycle
/// callbacks; the auth transition remains owned by the stored operation between commands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LogoutStatus {
    Idle,
    AwaitingRevocation,
    AwaitingCleanup,
}

#[derive(Default)]
pub(crate) struct LogoutCoordinator(tokio::sync::Mutex<Option<LogoutOperation>>);

/// Called from the retained blocking preparation task, never from the event loop.
fn end_and_drain_notifications(owner: &crate::login_connection::LoginConnection) -> Result<(), String> {
    owner.end().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        let _drained = owner.notification_delivery_lane.blocking_lock();
    }
    Ok(())
}

impl LogoutCoordinator {
    /// Capture credentials before cancelling business work. Retain the operation even
    /// if durable marking or handle release fails; callers must retry preparation.
    pub(crate) async fn begin_login_logout(
        &self,
        state: &crate::ServerSessionState,
    ) -> Result<(), String> {
        let mut current = self.0.lock().await;
        if let Some(operation) = current.as_mut() {
            return operation.prepare().await;
        }
        let transition = state.auth_lifecycle.enter(crate::auth_lifecycle::Phase::Logout)?;
        let owner = crate::native_db::active_login()?;
        let token = owner.credential().map_err(|e| e.to_string())?;
        let origin = state.api_origin.lock().map_err(|_| "origin lock poisoned")?.clone();
        let origin = crate::validate_origin(&origin).ok_or("invalid logout origin")?;
        let mut operation = LogoutOperation::new(state.api_client(&origin), origin, token, transition);
        operation.session = Some(owner.id().clone());
        operation.preparation_owner = Some(owner.clone());
        *current = Some(operation);
        owner.end().map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        crate::native_db::desktop_badge::reset();
        current.as_mut().unwrap().prepare().await
    }

    /// Desktop cleanup belongs to Rust, including the OS credential adapter. The
    /// stored operation supplies the descriptor; the renderer supplies only its decision.
    #[cfg(desktop)]
    pub(crate) async fn finish_desktop(&self, app: tauri::AppHandle, local_only: bool) -> Result<(), String> {
        let mut current = self.0.lock().await;
        let operation = current.as_mut().ok_or("no logout is in progress")?;
        operation.prepare().await?;
        let id = operation.session.clone().ok_or("logout session is missing")?;
        // Record the decision before scheduling OS work. The task handle stays in
        // the operation so a cancelled IPC waiter cannot start overlapping cleanup.
        if operation.phase == LogoutPhase::AwaitingRevocation {
            if !local_only {
                return Err("session revocation is unconfirmed; explicit local-only decision required".into());
            }
            operation.phase = LogoutPhase::CleanupLocalOnly;
        }
        if operation.cleanup_task.is_none() {
            operation.cleanup_task = Some(tokio::task::spawn_blocking(move || {
                // Keep notification removal inside the retained task: an abandoned IPC
                // must not allow delayed removal to erase a successor login's cards.
                crate::native_db::desktop_notifications::clear_notifications(&app, true)?;
                let preferences = crate::native_db::preferences_connection()?;
                preferences.with_database(|conn| {
                    crate::login_session_store::SessionStore::end(conn, Some(&id))?;
                    Ok(())
                })?;
                crate::secure_storage::secure_clear_token_internal()?;
                preferences.with_database(|conn| {
                    crate::login_session_store::SessionStore::finish_ending(conn, Some(&id))
                })
            }));
        }
        let result = operation.cleanup_task.as_mut().unwrap().await;
        operation.cleanup_task = None;
        result.map_err(|e| format!("join logout cleanup: {e}"))??;
        operation.finish(false, async { Ok(()) }).await?;
        *current = None;
        Ok(())
    }

    pub(crate) async fn status(&self) -> LogoutStatus {
        match self.0.lock().await.as_ref() {
            None => LogoutStatus::Idle,
            Some(operation) if operation.phase != LogoutPhase::AwaitingRevocation => LogoutStatus::AwaitingCleanup,
            Some(_) => LogoutStatus::AwaitingRevocation,
        }
    }

    pub(crate) async fn begin(&self, operation: LogoutOperation) -> Result<(), String> {
        let mut current = self.0.lock().await;
        if current.is_some() {
            return Err("logout is already in progress".into());
        }
        *current = Some(operation);
        Ok(())
    }

    pub(crate) async fn revoke(&self) -> Result<LogoutOutcome, String> {
        let mut current = self.0.lock().await;
        let operation = current.as_mut().ok_or("no logout is in progress")?;
        operation.prepare().await?;
        Ok(operation.revoke().await)
    }

    pub(crate) async fn finish<F>(&self, local_only: bool, cleanup: F) -> Result<(), String>
    where
        F: std::future::Future<Output = Result<(), String>>,
    {
        let mut current = self.0.lock().await;
        let operation = current.as_mut().ok_or("no logout is in progress")?;
        operation.prepare().await?;
        operation.finish(local_only, cleanup).await?;
        *current = None;
        Ok(())
    }
}

#[cfg(any(not(desktop), test))]
#[derive(Clone, Default)]
pub(crate) struct LogoutTasks(Arc<Mutex<HashMap<String, JoinHandle<LogoutOutcome>>>>);

#[cfg(any(not(desktop), test))]
impl LogoutTasks {
    pub(crate) fn start(&self, client: reqwest::Client, origin: String, token: String) -> String {
        self.start_with_timeout(client, origin, token, LOGOUT_TIMEOUT, None)
    }

    pub(crate) fn start_in_transition(
        &self,
        client: reqwest::Client,
        origin: String,
        token: String,
        transition: crate::auth_lifecycle::TransitionGuard,
    ) -> String {
        self.start_with_timeout(client, origin, token, LOGOUT_TIMEOUT, Some(transition))
    }

    fn start_with_timeout(
        &self,
        client: reqwest::Client,
        origin: String,
        token: String,
        deadline: Duration,
        transition: Option<crate::auth_lifecycle::TransitionGuard>,
    ) -> String {
        let ticket = uuid::Uuid::new_v4().to_string();
        let task = tokio::spawn(async move {
            // The worker, not the IPC waiter, owns admission until transport completion.
            let _transition = transition;
            revoke_once(&client, &origin, &token, deadline).await
        });
        let mut pending = self.0.lock().expect("logout tasks lock");
        // Bound abandoned tickets without routinely dropping completed results before their waiter.
        // Eviction is reported as UnknownTicket, never mistaken for successful revocation.
        if pending.len() >= 64 {
            pending.retain(|_, task| !task.is_finished());
        }
        pending.insert(ticket.clone(), task);
        ticket
    }

    pub(crate) async fn wait(&self, ticket: &str) -> LogoutOutcome {
        let task = self.0.lock().expect("logout tasks lock").remove(ticket);
        // Never hold the task registry lock over network I/O. Tickets are consumed once.
        match task {
            Some(task) => match task.await {
                Ok(outcome) => outcome,
                Err(error) => {
                    warn!("logout task failed: {error}");
                    LogoutOutcome::TaskFailure
                }
            },
            None => LogoutOutcome::UnknownTicket,
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
        assert_eq!(tasks.wait(&ticket).await, LogoutOutcome::HttpFailure { status_code: 503 });
        assert_eq!(tasks.wait(&ticket).await, LogoutOutcome::UnknownTicket);
        accept.await.unwrap();
    }

    #[tokio::test]
    async fn revocation_worker_holds_logout_admission_until_response() {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", server.local_addr().unwrap());
        let (received, request_received) = tokio::sync::oneshot::channel();
        let (respond, response) = tokio::sync::oneshot::channel::<()>();
        let accept = tokio::spawn(async move {
            let (mut socket, _) = server.accept().await.unwrap();
            read_request(&mut socket).await;
            received.send(()).unwrap();
            response.await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
        });
        let lifecycle = Arc::new(crate::auth_lifecycle::AuthLifecycle::default());
        let transition = lifecycle.enter(crate::auth_lifecycle::Phase::Logout).unwrap();
        let tasks = LogoutTasks::default();
        let ticket = tasks.start_in_transition(reqwest::Client::new(), origin, "token".into(), transition);
        request_received.await.unwrap();
        assert!(lifecycle.enter(crate::auth_lifecycle::Phase::Login).is_err());
        respond.send(()).unwrap();
        assert_eq!(tasks.wait(&ticket).await, LogoutOutcome::Revoked);
        assert!(lifecycle.enter(crate::auth_lifecycle::Phase::Login).is_ok());
        accept.await.unwrap();
    }

    #[tokio::test]
    async fn operation_retains_admission_across_failed_attempt_and_cleanup_retry() {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", server.local_addr().unwrap());
        let accept = tokio::spawn(async move {
            for status in ["503 Service Unavailable", "200 OK"] {
                let (mut socket, _) = server.accept().await.unwrap();
                let request = read_request(&mut socket).await;
                assert!(request.to_lowercase().contains("authorization: bearer retained-token"));
                socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
            }
        });
        let lifecycle = Arc::new(crate::auth_lifecycle::AuthLifecycle::default());
        let mut operation = LogoutOperation::new(
            reqwest::Client::new(), origin, "retained-token".into(),
            lifecycle.enter(crate::auth_lifecycle::Phase::Logout).unwrap(),
        );
        assert_eq!(operation.revoke().await, LogoutOutcome::HttpFailure { status_code: 503 });
        assert!(operation.finish(false, async { panic!("unconfirmed logout must not clean up") }).await.is_err());
        assert!(lifecycle.enter(crate::auth_lifecycle::Phase::Login).is_err());
        // The second request is issued by an explicit coordinator call, never automatically.
        assert_eq!(operation.revoke().await, LogoutOutcome::Revoked);
        // Confirmed revocation is remembered: repeated commands must not send another request.
        assert_eq!(operation.revoke().await, LogoutOutcome::Revoked);
        assert!(lifecycle.enter(crate::auth_lifecycle::Phase::Login).is_err());
        assert!(operation.finish(false, async { Err("storage unavailable".into()) }).await.is_err());
        assert!(lifecycle.enter(crate::auth_lifecycle::Phase::Login).is_err());
        assert_eq!(operation.token, "retained-token");
        operation.finish(false, async { Ok(()) }).await.unwrap();
        assert!(operation.token.is_empty());
        assert!(lifecycle.enter(crate::auth_lifecycle::Phase::Login).is_ok());
        accept.await.unwrap();
    }

    #[tokio::test]
    async fn coordinator_retains_operation_after_a_cleanup_waiter_is_cancelled() {
        let lifecycle = Arc::new(crate::auth_lifecycle::AuthLifecycle::default());
        let coordinator = Arc::new(LogoutCoordinator::default());
        coordinator.begin(LogoutOperation::new(
            reqwest::Client::new(), "http://127.0.0.1".into(), "token".into(),
            lifecycle.enter(crate::auth_lifecycle::Phase::Logout).unwrap(),
        )).await.unwrap();
        let (started, ready) = tokio::sync::oneshot::channel();
        let waiting = coordinator.clone();
        let worker = tokio::spawn(async move {
            waiting.finish(true, async {
                started.send(()).unwrap();
                std::future::pending::<Result<(), String>>().await
            }).await
        });
        ready.await.unwrap();
        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
        assert!(lifecycle.enter(crate::auth_lifecycle::Phase::Login).is_err());
        // Cancellation did not drop the stored operation or relinquish logout admission.
        coordinator.finish(true, async { Ok(()) }).await.unwrap();
        assert!(lifecycle.enter(crate::auth_lifecycle::Phase::Login).is_ok());
        assert!(coordinator.revoke().await.is_err());
    }

    #[tokio::test]
    async fn cancelling_a_revocation_closes_transport_and_retains_logout_admission() {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", server.local_addr().unwrap());
        let (received, ready) = tokio::sync::oneshot::channel();
        let accept = tokio::spawn(async move {
            let (mut socket, _) = server.accept().await.unwrap();
            read_request(&mut socket).await;
            received.send(()).unwrap();
            let mut remaining = Vec::new();
            tokio::time::timeout(Duration::from_secs(2), socket.read_to_end(&mut remaining))
                .await.expect("cancelled request must close transport").unwrap();
        });
        let lifecycle = Arc::new(crate::auth_lifecycle::AuthLifecycle::default());
        let coordinator = Arc::new(LogoutCoordinator::default());
        coordinator.begin(LogoutOperation::new(
            reqwest::Client::new(), origin, "token".into(),
            lifecycle.enter(crate::auth_lifecycle::Phase::Logout).unwrap(),
        )).await.unwrap();
        let waiting = coordinator.clone();
        let worker = tokio::spawn(async move { waiting.revoke().await });
        ready.await.unwrap();
        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
        accept.await.unwrap();
        assert!(lifecycle.enter(crate::auth_lifecycle::Phase::Login).is_err());
        coordinator.finish(true, async { Ok(()) }).await.unwrap();
        assert!(lifecycle.enter(crate::auth_lifecycle::Phase::Login).is_ok());
    }

    #[tokio::test]
    async fn app_state_clones_share_logout_admission_and_status() {
        let state = crate::ServerSessionState::new();
        let recreated = state.clone();
        assert_eq!(state.logout.status().await, LogoutStatus::Idle);
        state.logout.begin(LogoutOperation::new(
            reqwest::Client::new(), "http://127.0.0.1".into(), "token".into(),
            state.auth_lifecycle.enter(crate::auth_lifecycle::Phase::Logout).unwrap(),
        )).await.unwrap();
        drop(state);
        assert_eq!(recreated.logout.status().await, LogoutStatus::AwaitingRevocation);
        assert!(recreated.auth_lifecycle.enter(crate::auth_lifecycle::Phase::Login).is_err());
        recreated.logout.finish(true, async { Ok(()) }).await.unwrap();
        assert_eq!(recreated.logout.status().await, LogoutStatus::Idle);
        assert!(recreated.auth_lifecycle.enter(crate::auth_lifecycle::Phase::Login).is_ok());
    }

    #[tokio::test]
    async fn idle_coordinator_rejects_commands_without_running_cleanup() {
        let coordinator = LogoutCoordinator::default();
        assert_eq!(coordinator.status().await, LogoutStatus::Idle);
        assert_eq!(coordinator.revoke().await.unwrap_err(), "no logout is in progress");
        assert!(coordinator.finish(true, async {
            panic!("idle coordinator must not invoke cleanup")
        }).await.is_err());
        assert_eq!(coordinator.status().await, LogoutStatus::Idle);
    }

    #[test]
    fn status_projection_has_no_credential_or_operation_identifier() {
        assert_eq!(serde_json::to_string(&LogoutStatus::Idle).unwrap(), "\"idle\"");
        assert_eq!(serde_json::to_string(&LogoutStatus::AwaitingRevocation).unwrap(), "\"awaitingRevocation\"");
        assert_eq!(serde_json::to_string(&LogoutStatus::AwaitingCleanup).unwrap(), "\"awaitingCleanup\"");
    }

    #[tokio::test]
    async fn local_only_decision_survives_failed_cleanup_without_another_prompt() {
        let lifecycle = Arc::new(crate::auth_lifecycle::AuthLifecycle::default());
        let coordinator = LogoutCoordinator::default();
        coordinator.begin(LogoutOperation::new(
            reqwest::Client::new(), "http://127.0.0.1".into(), "token".into(),
            lifecycle.enter(crate::auth_lifecycle::Phase::Logout).unwrap(),
        )).await.unwrap();
        assert!(coordinator.finish(true, async { Err("keyring locked".into()) }).await.is_err());
        assert_eq!(coordinator.status().await, LogoutStatus::AwaitingCleanup);
        assert!(lifecycle.enter(crate::auth_lifecycle::Phase::Login).is_err());
        assert_eq!(coordinator.revoke().await.unwrap(), LogoutOutcome::TaskFailure);
        // The decision is already owned by Rust. Retrying cleanup need not authorize it again.
        coordinator.finish(false, async { Ok(()) }).await.unwrap();
        assert_eq!(coordinator.status().await, LogoutStatus::Idle);
        assert!(lifecycle.enter(crate::auth_lifecycle::Phase::Login).is_ok());
    }

    fn operation_with_pending_preparation(
        lifecycle: &Arc<crate::auth_lifecycle::AuthLifecycle>,
        task: JoinHandle<Result<(), String>>,
    ) -> LogoutOperation {
        let id = crate::login_session_store::LoginSessionId::try_from(uuid::Uuid::new_v4().to_string()).unwrap();
        let owner = crate::login_connection::LoginConnection::preparing(
            id, rusqlite::Connection::open_in_memory().unwrap(),
        );
        let mut operation = LogoutOperation::new(
            reqwest::Client::new(), "http://127.0.0.1".into(), "token".into(),
            lifecycle.enter(crate::auth_lifecycle::Phase::Logout).unwrap(),
        );
        operation.preparation_owner = Some(owner);
        operation.preparation_task = Some(task);
        operation
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn logout_ends_admission_before_waiting_for_notification_delivery() {
        let id = crate::login_session_store::LoginSessionId::try_from(uuid::Uuid::new_v4().to_string()).unwrap();
        let owner = crate::login_connection::LoginConnection::preparing(
            id, rusqlite::Connection::open_in_memory().unwrap(),
        );
        owner.begin_activation().unwrap().commit("token".into()).unwrap();
        let in_flight = owner.notification_delivery_lane.lock().await;
        let waiting_owner = owner.clone();
        let mut preparation = tokio::task::spawn_blocking(move || end_and_drain_notifications(&waiting_owner));
        tokio::time::timeout(Duration::from_secs(2), owner.cancellation().cancelled()).await.unwrap();
        assert!(owner.capture_database_work().is_err());
        assert!(tokio::time::timeout(Duration::from_millis(20), &mut preparation).await.is_err());
        drop(in_flight);
        tokio::time::timeout(Duration::from_secs(2), preparation).await.unwrap().unwrap().unwrap();
    }

    #[tokio::test]
    async fn cancelling_preparation_wait_preserves_the_same_task_for_resumption() {
        let lifecycle = Arc::new(crate::auth_lifecycle::AuthLifecycle::default());
        let (finish, waiting) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move { waiting.await.unwrap(); Ok(()) });
        let task_id = task.id();
        let mut operation = operation_with_pending_preparation(&lifecycle, task);
        assert!(tokio::time::timeout(Duration::from_millis(20), operation.prepare()).await.is_err());
        assert_eq!(operation.preparation_task.as_ref().unwrap().id(), task_id);
        assert!(operation.preparation_owner.is_some());
        assert!(lifecycle.enter(crate::auth_lifecycle::Phase::Login).is_err());
        finish.send(()).unwrap();
        operation.prepare().await.unwrap();
        assert!(operation.preparation_task.is_none());
        assert!(operation.preparation_owner.is_none());
        assert!(lifecycle.enter(crate::auth_lifecycle::Phase::Login).is_err());
    }

    #[tokio::test]
    async fn failed_preparation_retains_owner_and_credential_for_retry() {
        let lifecycle = Arc::new(crate::auth_lifecycle::AuthLifecycle::default());
        let task = tokio::spawn(async { Err("database busy".into()) });
        let mut operation = operation_with_pending_preparation(&lifecycle, task);
        assert_eq!(operation.prepare().await.unwrap_err(), "database busy");
        assert!(operation.preparation_task.is_none());
        assert!(operation.preparation_owner.is_some());
        assert_eq!(operation.token, "token");
        assert!(lifecycle.enter(crate::auth_lifecycle::Phase::Login).is_err());
        // Simulate the retry's successful worker result without touching global cache fixtures.
        operation.preparation_task = Some(tokio::spawn(async { Ok(()) }));
        operation.prepare().await.unwrap();
        assert!(operation.preparation_owner.is_none());
    }

    #[tokio::test]
    async fn successful_revocation_returns_an_explicit_outcome() {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", server.local_addr().unwrap());
        let accept = tokio::spawn(async move {
            let (mut socket, _) = server.accept().await.unwrap();
            read_request(&mut socket).await;
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
        });
        let tasks = LogoutTasks::default();
        let ticket = tasks.start(reqwest::Client::new(), origin, "ended".into());
        assert_eq!(tasks.wait(&ticket).await, LogoutOutcome::Revoked);
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
            None,
        );
        assert_eq!(tokio::time::timeout(Duration::from_secs(2), tasks.wait(&ticket))
            .await
            .unwrap(), LogoutOutcome::TimedOut);
        accept.await.unwrap();
    }
}
