use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};

/// Admission for authentication lifecycle transitions. A phase describes native work
/// executing NOW, not the entire time an authentication screen is visible. Verification
/// owns a cancellable setup ID; HTTP authentication owns a prepared login UUID. Between
/// native commands the lifecycle is idle, but those identities continue to fence results.
/// One transition runs at a time. Its worker owns the guard, so a disappearing IPC
/// waiter neither releases the phase nor admits conflicting work.
///
/// Scope ends at activation: everything after a login is established belongs to the
/// login-session epoch (login_session + LoginConnection), never to this machine.
#[derive(Debug, Default)]
pub(crate) struct AuthLifecycle(Mutex<State>);

#[derive(Debug, Default)]
struct State {
    phase: Phase,
    /// Login identities prepared for the CURRENT server configuration.
    prepared: HashSet<String>,
    /// Preparations invalidated by a later configuration commit; late activations fail.
    superseded: HashSet<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Phase {
    #[default]
    Idle,
    /// A server configuration commit is running to completion.
    ServerSetup,
    /// A login preparation, restoration check, or credential activation is executing.
    Login,
}

impl Phase {
    fn busy_message(&self) -> Option<&'static str> {
        match self {
            Phase::Idle => None,
            Phase::ServerSetup => Some("server setup is in progress"),
            Phase::Login => Some("login is in progress"),
        }
    }
}

/// Holds the phase for the duration of one transition; dropping it returns to Idle.
#[derive(Debug)]
pub(crate) struct TransitionGuard {
    lifecycle: Arc<AuthLifecycle>,
    phase: Phase,
}

impl AuthLifecycle {
    pub(crate) fn enter(self: &Arc<Self>, phase: Phase) -> Result<TransitionGuard, String> {
        let mut state = self.0.lock().map_err(|_| "auth lifecycle lock poisoned")?;
        if let Some(message) = state.phase.busy_message() {
            return Err(message.into());
        }
        state.phase = phase;
        Ok(TransitionGuard {
            lifecycle: self.clone(),
            phase,
        })
    }
}

impl TransitionGuard {
    /// Register a login preparation minted under this login transition.
    pub(crate) fn register_login(&self, id: &str) -> Result<(), String> {
        self.assert_phase(Phase::Login);
        let mut state = self.lock()?;
        if state.superseded.contains(id) {
            return Err("login superseded by server configuration".into());
        }
        state.prepared.insert(id.into());
        Ok(())
    }

    pub(crate) fn is_superseded(&self, id: &str) -> bool {
        self.lifecycle.0.lock().unwrap().superseded.contains(id)
    }

    /// Activation boundary: only a preparation of the current configuration may publish a credential.
    pub(crate) fn validate_login(&self, id: &str) -> Result<(), String> {
        self.assert_phase(Phase::Login);
        let prepared = self
            .lifecycle
            .0
            .lock()
            .map_err(|_| "auth lifecycle lock poisoned")?
            .prepared
            .contains(id);
        if !prepared {
            return Err("login superseded by server configuration".into());
        }
        Ok(())
    }

    /// A configuration commit retires every login prepared against the previous server,
    /// including authentication responses that arrive after the commit finished.
    pub(crate) fn invalidate_logins(&self) {
        self.assert_phase(Phase::ServerSetup);
        let mut state = self.lifecycle.0.lock().unwrap();
        let prepared = std::mem::take(&mut state.prepared);
        state.superseded.extend(prepared);
    }

    fn assert_phase(&self, phase: Phase) {
        assert_eq!(self.phase, phase, "guard belongs to another phase");
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>, String> {
        self.lifecycle
            .0
            .lock()
            .map_err(|_| "auth lifecycle lock poisoned".to_string())
    }
}

impl Drop for TransitionGuard {
    fn drop(&mut self) {
        self.lifecycle.0.lock().unwrap().phase = Phase::Idle;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_transition_rejects_every_phase_until_its_guard_drops() {
        let lifecycle = Arc::new(AuthLifecycle::default());
        for phase in [Phase::ServerSetup, Phase::Login] {
            let guard = lifecycle.enter(phase).unwrap();
            assert_eq!(
                lifecycle.enter(Phase::Login).unwrap_err(),
                phase.busy_message().unwrap()
            );
            assert_eq!(
                lifecycle.enter(Phase::ServerSetup).unwrap_err(),
                phase.busy_message().unwrap()
            );
            drop(guard);
        }
        assert!(lifecycle.enter(Phase::Login).is_ok());
    }

    #[test]
    fn a_late_login_cannot_activate_after_configuration_completed() {
        let lifecycle = Arc::new(AuthLifecycle::default());
        let login = lifecycle.enter(Phase::Login).unwrap();
        login.register_login("old").unwrap();
        login.validate_login("old").unwrap();
        drop(login);
        let setup = lifecycle.enter(Phase::ServerSetup).unwrap();
        setup.invalidate_logins();
        drop(setup);
        let login = lifecycle.enter(Phase::Login).unwrap();
        assert_eq!(
            login.validate_login("old").unwrap_err(),
            "login superseded by server configuration"
        );
        assert!(login.register_login("old").is_err());
        login.register_login("new").unwrap();
        login.validate_login("new").unwrap();
    }

    #[tokio::test]
    async fn dropping_the_waiter_does_not_release_a_blocking_workers_guard() {
        let lifecycle = Arc::new(AuthLifecycle::default());
        let guard = lifecycle.enter(Phase::ServerSetup).unwrap();
        let (started, running) = tokio::sync::oneshot::channel();
        let (finish, wait) = std::sync::mpsc::channel();
        let (done, completed) = tokio::sync::oneshot::channel();
        let worker = tokio::task::spawn_blocking(move || {
            let guard = guard;
            started.send(()).unwrap();
            wait.recv().unwrap();
            drop(guard);
            done.send(()).unwrap();
        });
        running.await.unwrap();
        worker.abort();
        drop(worker);
        assert_eq!(
            lifecycle.enter(Phase::Login).unwrap_err(),
            "server setup is in progress"
        );
        finish.send(()).unwrap();
        completed.await.unwrap();
        assert!(lifecycle.enter(Phase::Login).is_ok());
    }
}
