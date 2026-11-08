//! Native batch orchestration. OS adapters supply facts and execute commands only.
use super::{
    alert::AlertPolicy,
    content::{NotificationCommand, PresentationFacts},
    delivery::{self, DeliveryResult, PreparedDelivery},
    presentation, NotificationBatch,
};
use crate::login_connection::DatabaseWork;

#[derive(Clone, Copy)]
pub(crate) struct Platform<
    F = fn() -> Result<PresentationFacts, String>,
    E = fn(PreparedDelivery, Vec<Vec<u8>>) -> Result<DeliveryResult, String>,
> {
    pub(crate) facts: F,
    pub(crate) execute: E,
}

fn policy() -> Result<AlertPolicy, String> {
    let preference =
        super::super::preferences::read_notification_preference("notificationAlertPolicy")?;
    AlertPolicy::from_preference(preference.as_deref())
}

async fn execute<F, E>(
    work: DatabaseWork,
    prepared: PreparedDelivery,
    avatars: Vec<Vec<u8>>,
    platform: Platform<F, E>,
) -> Result<DeliveryResult, String>
where
    F: Fn() -> Result<PresentationFacts, String> + Clone + Send + 'static,
    E: Fn(PreparedDelivery, Vec<Vec<u8>>) -> Result<DeliveryResult, String>
        + Clone
        + Send
        + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        if work.assert_current().is_err() {
            return Ok(DeliveryResult::NotExecuted);
        }
        (platform.execute)(prepared, avatars)
    })
    .await
    .map_err(|e| format!("notification execution interrupted: {e}"))?
}

pub(crate) async fn deliver_command<F, E>(
    work: DatabaseWork,
    command: NotificationCommand,
    avatars: Vec<Vec<u8>>,
    allow_alert: bool,
    platform: Platform<F, E>,
) -> Result<(), String>
where
    F: Fn() -> Result<PresentationFacts, String> + Clone + Send + 'static,
    E: Fn(PreparedDelivery, Vec<Vec<u8>>) -> Result<DeliveryResult, String>
        + Clone
        + Send
        + 'static,
{
    tauri::async_runtime::spawn(async move {
        let owner = work.owner().clone();
        let restoration = owner.notification_reconstruction.lock().await;
        work.assert_current().map_err(|e| e.to_string())?;
        if restoration.is_some() {
            return Err("notification delivery paused for reconstruction".into());
        }
        deliver_admitted_command(work, command, avatars, allow_alert, platform).await
    })
    .await
    .map_err(|e| format!("join native notification command: {e}"))?
}

/// Caller holds the reconstruction lane through the receipt. Batch delivery uses
/// this directly rather than recursively acquiring its own admission lock.
async fn deliver_admitted_command<F, E>(
    work: DatabaseWork,
    command: NotificationCommand,
    avatars: Vec<Vec<u8>>,
    allow_alert: bool,
    platform: Platform<F, E>,
) -> Result<(), String>
where
    F: Fn() -> Result<PresentationFacts, String> + Clone + Send + 'static,
    E: Fn(PreparedDelivery, Vec<Vec<u8>>) -> Result<DeliveryResult, String>
        + Clone
        + Send
        + 'static,
{
    delivery::deliver(
        work.clone(),
        command,
        policy()?,
        allow_alert,
        platform.facts.clone(),
        move |prepared| execute(work, prepared, avatars, platform),
    )
    .await
}

pub(crate) async fn deliver_batch<F, E>(
    batch: NotificationBatch,
    allow_alert: bool,
    platform: Platform<F, E>,
) -> Result<(), String>
where
    F: Fn() -> Result<PresentationFacts, String> + Clone + Send + 'static,
    E: Fn(PreparedDelivery, Vec<Vec<u8>>) -> Result<DeliveryResult, String>
        + Clone
        + Send
        + 'static,
{
    // The batch owns reconstruction through receipt completion, not its caller.
    tauri::async_runtime::spawn(deliver_batch_owned(batch, allow_alert, platform))
        .await
        .map_err(|e| format!("join native notification batch: {e}"))?
}

async fn deliver_batch_owned<F, E>(
    batch: NotificationBatch,
    allow_alert: bool,
    platform: Platform<F, E>,
) -> Result<(), String>
where
    F: Fn() -> Result<PresentationFacts, String> + Clone + Send + 'static,
    E: Fn(PreparedDelivery, Vec<Vec<u8>>) -> Result<DeliveryResult, String>
        + Clone
        + Send
        + 'static,
{
    let work = batch
        .work
        .clone()
        .ok_or("notification batch has no captured work")?;
    let owner = work.owner().clone();
    let mut restoration = owner.notification_reconstruction.lock().await;
    work.assert_current().map_err(|e| e.to_string())?;
    let candidate_threads: std::collections::HashSet<_> = restoration
        .as_ref()
        .into_iter()
        .flatten()
        .map(|(thread, _)| *thread)
        .collect();
    if let Some(candidates) = restoration.as_ref() {
        if batch.sync_error.is_some() {
            return Err("notification reconstruction awaits complete synchronization".into());
        }
        let user_id = batch.user_id;
        let states = super::reconstruction_states(work.clone(), user_id).await?;
        let full = super::for_reconstruction(work.clone(), user_id, states).await?;
        let projected =
            presentation::prepare_batch(work.clone(), &full, (platform.facts)()?, false).await?;
        let execution_work = work.clone();
        let execution_platform = platform.clone();
        delivery::reconstruct(
            work.clone(),
            candidates.clone(),
            projected.commands,
            policy()?,
            platform.facts.clone(),
            move |prepared| {
                execute(
                    execution_work.clone(),
                    prepared,
                    projected.avatars.clone(),
                    execution_platform.clone(),
                )
            },
        )
        .await?;
        *restoration = None;
    }
    let projected =
        presentation::prepare_batch(work.clone(), &batch, (platform.facts)()?, allow_alert).await?;
    for command in projected.commands {
        let thread = match &command {
            NotificationCommand::Show(content) => content.thread_id,
            NotificationCommand::Remove { thread_id } => *thread_id,
        };
        if candidate_threads.contains(&thread) {
            continue;
        }
        deliver_admitted_command(
            work.clone(),
            command,
            projected.avatars.clone(),
            allow_alert,
            platform.clone(),
        )
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_db::notifications::delivery::{ObservedCard, PlatformHandle};

    fn platform(reject: bool) -> Platform {
        Platform {
            facts: || Ok(Default::default()),
            execute: if reject {
                |_, _| Ok(DeliveryResult::Rejected)
            } else {
                |prepared, _| {
                    // The full merged database has no surviving thread. The same-round
                    // delta below must never resurrect this candidate after removal.
                    assert!(matches!(
                        prepared.command,
                        NotificationCommand::Remove { thread_id: 7 }
                    ));
                    Ok(DeliveryResult::Accepted { handle: None })
                }
            },
        }
    }

    #[tokio::test]
    async fn single_command_cannot_operate_cards_while_reconstruction_is_pending() {
        let owner = crate::login_connection::LoginConnection::preparing(
            crate::login_session_store::LoginSessionId::try_from(uuid::Uuid::new_v4().to_string())
                .unwrap(),
            rusqlite::Connection::open_in_memory().unwrap(),
        );
        owner
            .begin_activation()
            .unwrap()
            .commit("test-token".into())
            .unwrap();
        let instance = uuid::Uuid::new_v4().to_string();
        owner
            .notification_delivery
            .lock()
            .unwrap()
            .import_cards(vec![ObservedCard {
                thread_id: 7,
                notification_id: instance.clone(),
                handle: PlatformHandle::Android {
                    tag: instance.clone(),
                    id: 65536,
                },
            }])
            .unwrap();
        *owner.notification_reconstruction.lock().await = Some(vec![(7, instance.clone())]);
        let never = Platform {
            facts: || panic!("paused command must not prepare presentation"),
            execute: |_, _| panic!("paused command must not execute"),
        };
        assert_eq!(
            deliver_command(
                owner.capture_database_work().unwrap(),
                NotificationCommand::Remove { thread_id: 7 },
                vec![],
                false,
                never
            )
            .await
            .unwrap_err(),
            "notification delivery paused for reconstruction"
        );
        assert_eq!(
            owner
                .notification_delivery
                .lock()
                .unwrap()
                .reconstruction_candidates(),
            vec![(7, instance.clone())]
        );
        // OS observations remain independent of admission and do not wait for the lane.
        let _restoring = owner.notification_reconstruction.lock().await;
        owner
            .notification_delivery
            .lock()
            .unwrap()
            .dismissed(7, &instance);
        assert!(owner
            .notification_delivery
            .lock()
            .unwrap()
            .reconstruction_candidates()
            .is_empty());
    }

    #[tokio::test]
    async fn desktop_restoration_imports_before_activation_and_empty_sync_removes_exact_handles() {
        let _filesystem = crate::native_db::FILESYSTEM_TEST_LOCK.lock().unwrap();
        crate::native_db::shared_test_location();
        let database = rusqlite::Connection::open_in_memory().unwrap();
        crate::native_db::create_cache_schema(&database).unwrap();
        let owner = crate::login_connection::LoginConnection::preparing(
            crate::login_session_store::LoginSessionId::try_from(uuid::Uuid::new_v4().to_string())
                .unwrap(),
            database,
        );
        let instance = uuid::Uuid::new_v4().to_string();
        let handle = PlatformHandle::Macos {
            identifier: format!("soms-thread-{instance}"),
        };
        owner
            .notification_delivery
            .lock()
            .unwrap()
            .import_cards(vec![ObservedCard {
                thread_id: 7,
                notification_id: instance.clone(),
                handle: handle.clone(),
            }])
            .unwrap();
        *owner.notification_reconstruction.lock().await = Some(vec![(7, instance)]);
        assert!(owner.capture_database_work().is_err());
        owner
            .begin_activation()
            .unwrap()
            .commit("test-token".into())
            .unwrap();
        let batch = super::super::from_result(
            owner.capture_database_work().unwrap(),
            1,
            &crate::native_db::attention::ThreadFeedSyncResult {
                states: vec![],
                cursor: 0,
                error: None,
            },
        )
        .await
        .unwrap();
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = calls.clone();
        deliver_batch(
            batch,
            true,
            Platform {
                facts: || Ok(Default::default()),
                execute: move |prepared: PreparedDelivery, _| {
                    assert!(matches!(
                        prepared.command,
                        NotificationCommand::Remove { thread_id: 7 }
                    ));
                    assert_eq!(prepared.previous_handle, Some(handle.clone()));
                    observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(DeliveryResult::Accepted { handle: None })
                },
            },
        )
        .await
        .unwrap();
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(owner.notification_reconstruction.lock().await.is_none());
        assert!(owner
            .notification_delivery
            .lock()
            .unwrap()
            .reconstruction_candidates()
            .is_empty());
    }

    #[tokio::test]
    async fn batch_reconstruction_retains_candidates_until_success_and_excludes_same_round_delta() {
        let _filesystem = crate::native_db::FILESYSTEM_TEST_LOCK.lock().unwrap();
        crate::native_db::shared_test_location();
        let database = rusqlite::Connection::open_in_memory().unwrap();
        crate::native_db::create_cache_schema(&database).unwrap();
        let owner = crate::login_connection::LoginConnection::preparing(
            crate::login_session_store::LoginSessionId::try_from(uuid::Uuid::new_v4().to_string())
                .unwrap(),
            database,
        );
        owner
            .begin_activation()
            .unwrap()
            .commit("test-token".into())
            .unwrap();
        let instance = uuid::Uuid::new_v4().to_string();
        owner
            .notification_delivery
            .lock()
            .unwrap()
            .import_cards(vec![ObservedCard {
                thread_id: 7,
                notification_id: instance.clone(),
                handle: PlatformHandle::Android {
                    tag: instance.clone(),
                    id: 65536,
                },
            }])
            .unwrap();
        let candidates = vec![(7, instance)];
        *owner.notification_reconstruction.lock().await = Some(candidates.clone());
        let work = owner.capture_database_work().unwrap();

        let mut partial = super::super::from_result(
            work.clone(),
            1,
            &crate::native_db::attention::ThreadFeedSyncResult {
                states: vec![],
                cursor: 0,
                error: Some("offline".into()),
            },
        )
        .await
        .unwrap();
        let never = Platform {
            facts: || panic!("partial sync cannot project"),
            execute: |_, _| panic!("partial sync cannot submit"),
        };
        // Presentation metadata is not an authority for native recovery admission.
        partial.metadata = r#"{"error":null}"#.into();
        assert!(deliver_batch(partial, true, never).await.is_err());
        assert_eq!(
            *owner.notification_reconstruction.lock().await,
            Some(candidates.clone())
        );

        let complete = crate::native_db::attention::ThreadFeedSyncResult {
            states: vec![],
            cursor: 0,
            error: None,
        };
        let batch = super::super::from_result(work.clone(), 1, &complete)
            .await
            .unwrap();
        assert!(deliver_batch(batch, true, platform(true)).await.is_err());
        assert_eq!(
            *owner.notification_reconstruction.lock().await,
            Some(candidates.clone())
        );
        assert_eq!(
            owner
                .notification_delivery
                .lock()
                .unwrap()
                .reconstruction_candidates(),
            candidates
        );

        let mut batch = super::super::from_result(work.clone(), 1, &complete)
            .await
            .unwrap();
        batch.metadata = "not a JNI envelope".into();
        batch.threads.push(super::super::NotificationThread {
            thread_id: 7,
            thread_feed_id: 1,
            unread_count: 1,
            last_read_seq: 0,
            has_unread_mention: false,
            muted: false,
            title: "Peer".into(),
            previews: vec![],
        });
        deliver_batch(batch, true, platform(false)).await.unwrap();
        assert!(owner.notification_reconstruction.lock().await.is_none());
        assert!(owner
            .notification_delivery
            .lock()
            .unwrap()
            .reconstruction_candidates()
            .is_empty());

        // Subsequent empty ordinary batches do not enumerate or execute a reconstruction.
        let batch = super::super::from_result(work, 1, &complete).await.unwrap();
        let ordinary = Platform {
            facts: || Ok(Default::default()),
            execute: |_, _| panic!("empty ordinary batch"),
        };
        deliver_batch(batch, true, ordinary).await.unwrap();
    }
}
