use crate::{activate_origin, validate_origin, OriginMode, ServerSessionState};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

const CONFIG_FILE: &str = crate::CONFIG_FILENAME;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct ServerOrigins {
    pub primary: String,
    pub secondary: Option<String>,
}

impl ServerOrigins {
    fn normalized(primary: &str, secondary: Option<&str>) -> Result<Self, String> {
        let primary = validate_origin(primary).ok_or("invalid primary origin")?;
        let secondary = secondary
            .map(|value| validate_origin(value).ok_or("invalid secondary origin"))
            .transpose()?
            .filter(|value| value != &primary);
        Ok(Self { primary, secondary })
    }
}

struct Setup {
    id: String,
    cancel: CancellationToken,
    verified: Option<(String, ServerOrigins)>,
}

#[derive(Default)]
pub(crate) struct ServerSetup(Mutex<Option<Setup>>);

impl ServerSetup {
    fn begin(&self) -> Result<String, String> {
        let mut current = self.0.lock().map_err(|_| "setup lock poisoned")?;
        // A reclaimed renderer cannot run its destruction hook. A fresh setup cancels abandoned
        // verification so reopening the form can recover without restarting the process.
        if let Some(previous) = current.take() {
            previous.cancel.cancel();
        }
        let id = uuid::Uuid::new_v4().to_string();
        *current = Some(Setup {
            id: id.clone(),
            cancel: CancellationToken::new(),
            verified: None,
        });
        Ok(id)
    }

    fn cancellation(&self, id: &str) -> Result<CancellationToken, String> {
        self.0
            .lock()
            .map_err(|_| "setup lock poisoned")?
            .as_ref()
            .filter(|setup| setup.id == id)
            .map(|setup| setup.cancel.clone())
            .ok_or_else(|| "server setup cancelled".into())
    }

    fn take_configuration(&self, id: &str, use_advertised: bool) -> Result<ServerOrigins, String> {
        let mut current = self.0.lock().map_err(|_| "setup lock poisoned")?;
        let setup = current
            .as_ref()
            .filter(|setup| setup.id == id)
            .ok_or("server setup cancelled")?;
        let (entered, advertised) = setup
            .verified
            .as_ref()
            .ok_or("server setup has not been verified")?;
        let origins = if use_advertised {
            advertised.clone()
        } else {
            ServerOrigins::normalized(entered, None)?
        };
        current.take();
        Ok(origins)
    }

    fn cancel(&self, id: &str) {
        let mut current = self.0.lock().expect("setup lock");
        if current.as_ref().is_some_and(|setup| setup.id == id) {
            if let Some(setup) = current.take() {
                setup.cancel.cancel();
            }
        }
    }
}

pub(crate) fn assert_signed_out(state: &ServerSessionState) -> Result<(), String> {
    if state
        .login_session
        .lock()
        .map_err(|_| "login lock poisoned")?
        .is_some()
        || state
            .token
            .lock()
            .map_err(|_| "token lock poisoned")?
            .is_some()
    {
        return Err("sign out before changing the server".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn begin_server_setup(
    state: tauri::State<'_, ServerSessionState>,
) -> Result<String, String> {
    assert_signed_out(&state)?;
    state.server_setup.begin()
}

#[tauri::command]
pub(crate) fn cancel_server_setup(id: String, state: tauri::State<'_, ServerSessionState>) {
    state.server_setup.cancel(&id);
}

#[tauri::command]
pub(crate) async fn check_server_setup(
    id: String,
    origin: String,
    state: tauri::State<'_, ServerSessionState>,
) -> Result<serde_json::Value, String> {
    assert_signed_out(&state)?;
    check(&state.server_setup, &id, origin).await
}

async fn check(
    setups: &ServerSetup,
    id: &str,
    origin: String,
) -> Result<serde_json::Value, String> {
    let origin = validate_origin(&origin).ok_or("invalid server origin")?;
    let cancel = setups.cancellation(&id)?;
    let compat = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err("server setup cancelled".into()),
        result = async {
            let compat = crate::client_compat::init_check_compat(origin.clone()).await?;
            crate::client_compat::init_validate_cert(origin.clone()).await?;
            Ok::<_, String>(compat)
        } => result?,
    };
    let advertised = ServerOrigins::normalized(
        compat
            .get("primaryOrigin")
            .and_then(|value| value.as_str())
            .unwrap_or(&origin),
        compat.get("lanOrigin").and_then(|value| value.as_str()),
    )?;
    let mut current = setups.0.lock().map_err(|_| "setup lock poisoned")?;
    let setup = current
        .as_mut()
        .filter(|setup| setup.id == id)
        .ok_or("server setup cancelled")?;
    setup.verified = Some((origin, advertised));
    Ok(compat)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupResult {
    origins: ServerOrigins,
    active: String,
}

#[tauri::command]
pub(crate) async fn commit_server_setup(
    id: String,
    use_advertised: bool,
    state: tauri::State<'_, ServerSessionState>,
) -> Result<SetupResult, String> {
    // Admission is the commit point: once granted, the operation runs to success or failure even
    // if its IPC waiter disappears. It also blocks a queued login activation from racing the save.
    let guard = state
        .auth_lifecycle
        .enter(crate::auth_lifecycle::Phase::ServerSetup)?;
    assert_signed_out(&state)?;
    let origins = state.server_setup.take_configuration(&id, use_advertised)?;
    guard.invalidate_logins();
    let proxy = state.inner().clone();
    // The detached worker owns the transition through BOTH persistence and endpoint selection.
    // Dropping the IPC future must not release admission while a disk write is still running.
    tauri::async_runtime::spawn(commit(proxy, origins, guard))
        .await
        .map_err(|error| format!("join server configuration commit: {error}"))?
}

async fn commit(
    state: ServerSessionState,
    origins: ServerOrigins,
    guard: crate::auth_lifecycle::TransitionGuard,
) -> Result<SetupResult, String> {
    {
        // Never hold this lock while calling pick_origin_race, which acquires it itself.
        let selection = state.select_lock.clone().lock_owned().await;
        let proxy = state.clone();
        let persisted = origins.clone();
        tauri::async_runtime::spawn_blocking(move || {
            // Owned by the blocking worker as well: cancellation cannot detach the disk write
            // from its selection lock.
            let _selection = selection;
            persist(&proxy, persisted)
        })
        .await
        .map_err(|error| format!("join server configuration save: {error}"))??;
    }
    let active = crate::pick_origin_race(&state)
        .await
        .unwrap_or_else(|| origins.primary.clone());
    drop(guard);
    Ok(SetupResult { origins, active })
}

/// One atomic file replacement stores the pair. This is the only configuration writer.
pub(crate) fn persist(state: &ServerSessionState, origins: ServerOrigins) -> Result<(), String> {
    let origins = ServerOrigins::normalized(&origins.primary, origins.secondary.as_deref())?;
    let path = state
        .config_path
        .lock()
        .map_err(|_| "config path lock poisoned")?
        .clone();
    let directory = path
        .parent()
        .ok_or("missing server configuration directory")?;
    let temporary = directory.join(format!(".server-origins-{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec(&origins).map_err(|error| error.to_string())?;
    let write = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, directory.join(CONFIG_FILE))
    })();
    if let Err(error) = write {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("failed to save server configuration: {error}"));
    }
    apply(state, &origins);
    Ok(())
}

fn apply(state: &ServerSessionState, origins: &ServerOrigins) {
    *state.api_origin_primary.lock().expect("primary lock") = origins.primary.clone();
    *state.api_origin_secondary.lock().expect("secondary lock") = origins.secondary.clone();
    activate_origin(state, &origins.primary, OriginMode::Primary);
}

pub(crate) fn restore(state: &ServerSessionState) -> Result<(), String> {
    let path = state
        .config_path
        .lock()
        .map_err(|_| "config path lock poisoned")?
        .clone();
    let file = path
        .parent()
        .ok_or("missing server configuration directory")?
        .join(CONFIG_FILE);
    let bytes = match std::fs::read(file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("read server configuration: {error}")),
    };
    let origins: ServerOrigins =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    let origins = ServerOrigins::normalized(&origins.primary, origins.secondary.as_deref())?;
    apply(state, &origins);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn cancelled_setup_releases_admission_and_cannot_cancel_its_successor() {
        let setups = ServerSetup::default();
        let first = setups.begin().unwrap();
        let cancel = setups.cancellation(&first).unwrap();
        setups.cancel(&first);
        assert!(cancel.is_cancelled());
        let next = setups.begin().unwrap();
        setups.cancel(&first);
        assert!(!setups.cancellation(&next).unwrap().is_cancelled());
        assert!(setups.cancellation(&first).is_err());
    }

    #[test]
    fn fresh_setup_cancels_verification_abandoned_by_a_renderer() {
        let setups = ServerSetup::default();
        let first = setups.begin().unwrap();
        let cancel = setups.cancellation(&first).unwrap();
        let next = setups.begin().unwrap();
        assert!(cancel.is_cancelled());
        assert!(setups.cancellation(&first).is_err());
        assert!(!setups.cancellation(&next).unwrap().is_cancelled());
    }

    #[test]
    fn commit_requires_completed_verification_and_cannot_commit_a_cancelled_setup() {
        let setups = ServerSetup::default();
        let id = setups.begin().unwrap();
        assert!(setups.take_configuration(&id, true).is_err());
        setups.0.lock().unwrap().as_mut().unwrap().verified = Some((
            "http://entered.example".into(),
            ServerOrigins {
                primary: "https://public.example".into(),
                secondary: Some("http://lan.example".into()),
            },
        ));
        let pair = setups.take_configuration(&id, true).unwrap();
        assert_eq!(pair.primary, "https://public.example");
        assert_eq!(pair.secondary.as_deref(), Some("http://lan.example"));
        assert!(setups.take_configuration(&id, true).is_err());
        let id = setups.begin().unwrap();
        setups.cancel(&id);
        assert!(setups.take_configuration(&id, false).is_err());
    }

    #[tokio::test]
    async fn cancelling_verification_drops_the_http_request_without_saving() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let setups = std::sync::Arc::new(ServerSetup::default());
        let id = setups.begin().unwrap();
        let worker = {
            let setups = setups.clone();
            let id = id.clone();
            tokio::spawn(async move { check(&setups, &id, origin).await })
        };
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = [0; 4096];
        // Wait for request activity, not a fixed-size read or a complete HTTP frame.
        assert!(stream.read(&mut bytes).await.unwrap() > 0);
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{").await.unwrap();
        setups.cancel(&id);
        let error = tokio::time::timeout(std::time::Duration::from_secs(2), worker)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(error, "server setup cancelled");
        assert!(setups.0.lock().unwrap().is_none());
        let closed =
            tokio::time::timeout(std::time::Duration::from_secs(2), stream.read(&mut bytes))
                .await
                .unwrap();
        assert!(
            matches!(closed, Ok(0) | Err(_)),
            "cancelled request must close its transport"
        );
    }

    #[test]
    fn saving_a_single_server_clears_the_old_backup_and_restores_the_whole_pair() {
        let directory = tempfile::tempdir().unwrap();
        let state = ServerSessionState::new();
        *state.config_path.lock().unwrap() = directory.path().join(crate::CONFIG_FILENAME);
        let pair = ServerOrigins {
            primary: "https://public.example".into(),
            secondary: Some("http://10.0.0.1".into()),
        };
        persist(&state, pair.clone()).unwrap();
        activate_origin(
            &state,
            pair.secondary.as_deref().unwrap(),
            OriginMode::Secondary,
        );
        let single = ServerOrigins {
            primary: "https://new.example".into(),
            secondary: None,
        };
        persist(&state, single.clone()).unwrap();
        assert_eq!(*state.api_origin.lock().unwrap(), single.primary);
        assert!(state.api_origin_secondary.lock().unwrap().is_none());
        assert_eq!(*state.origin_mode.lock().unwrap(), OriginMode::Primary);
        let restored = ServerSessionState::new();
        *restored.config_path.lock().unwrap() = directory.path().join(crate::CONFIG_FILENAME);
        restore(&restored).unwrap();
        assert_eq!(*restored.api_origin_primary.lock().unwrap(), single.primary);
        assert!(restored.api_origin_secondary.lock().unwrap().is_none());
    }

    #[test]
    fn failed_save_leaves_the_live_configuration_unchanged() {
        let state = ServerSessionState::new();
        let before = state.api_origin.lock().unwrap().clone();
        let directory = tempfile::tempdir().unwrap();
        *state.config_path.lock().unwrap() = directory
            .path()
            .join("missing")
            .join(crate::CONFIG_FILENAME);
        assert!(persist(
            &state,
            ServerOrigins {
                primary: "https://new.example".into(),
                secondary: None
            }
        )
        .is_err());
        assert_eq!(*state.api_origin.lock().unwrap(), before);
    }

    #[tokio::test]
    async fn commit_with_a_backup_finishes_without_reacquiring_its_own_lock() {
        let directory = tempfile::tempdir().unwrap();
        let state = ServerSessionState::new();
        *state.config_path.lock().unwrap() = directory.path().join(crate::CONFIG_FILENAME);
        // Closed ports make both probes fail immediately; the primary remains the fallback.
        let primary = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let secondary = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origins = ServerOrigins {
            primary: format!("http://{}", primary.local_addr().unwrap()),
            secondary: Some(format!("http://{}", secondary.local_addr().unwrap())),
        };
        drop((primary, secondary));
        let guard = state
            .auth_lifecycle
            .enter(crate::auth_lifecycle::Phase::ServerSetup)
            .unwrap();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            commit(state.clone(), origins.clone(), guard),
        )
        .await
        .expect("configuration commit must not deadlock")
        .unwrap();
        assert_eq!(result.origins, origins);
        assert!(state
            .auth_lifecycle
            .enter(crate::auth_lifecycle::Phase::Login)
            .is_ok());
    }

    #[tokio::test]
    async fn dropping_the_commit_waiter_keeps_admission_until_the_worker_finishes() {
        let directory = tempfile::tempdir().unwrap();
        let state = ServerSessionState::new();
        *state.config_path.lock().unwrap() = directory.path().join(crate::CONFIG_FILENAME);
        let origins = ServerOrigins {
            primary: "https://configured.example".into(),
            secondary: None,
        };
        let selection = state.select_lock.lock().await;
        let guard = state
            .auth_lifecycle
            .enter(crate::auth_lifecycle::Phase::ServerSetup)
            .unwrap();
        let worker = tauri::async_runtime::spawn(commit(state.clone(), origins.clone(), guard));
        // A dropped JoinHandle detaches, rather than cancels, the admitted commit.
        drop(worker);
        assert!(state
            .auth_lifecycle
            .enter(crate::auth_lifecycle::Phase::Login)
            .is_err());
        drop(selection);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let Ok(guard) = state
                    .auth_lifecycle
                    .enter(crate::auth_lifecycle::Phase::Login)
                {
                    drop(guard);
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("detached commit must finish and release admission");
        let saved: ServerOrigins =
            serde_json::from_slice(&std::fs::read(directory.path().join(CONFIG_FILE)).unwrap())
                .unwrap();
        assert_eq!(saved, origins);
        assert_eq!(*state.api_origin_primary.lock().unwrap(), origins.primary);
    }

    #[test]
    fn signed_in_configuration_is_rejected() {
        let state = ServerSessionState::new();
        *state.token.lock().unwrap() = Some("token".into());
        assert!(assert_signed_out(&state).is_err());
    }
}
