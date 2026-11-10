//! Serial prepare/acknowledge boundary. Prepared state is never published as a current card.
use crate::native_db::notifications::NotificationTarget;
use super::{alert::{AlertPolicy, AlertState}, content::NotificationCommand};
use std::time::Instant;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum PlatformHandle {
    Android { tag: String, id: i32 },
    Macos { identifier: String },
    Windows { tag: String, group: String },
    Linux { daemon: String, id: u32 },
}

pub(crate) enum DeliveryResult {
    Accepted { handle: Option<PlatformHandle> },
    Rejected,
    NotExecuted,
    Uncertain,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ObservedCard {
    pub(crate) target: NotificationTarget,
    pub(crate) notification_id: String,
    pub(crate) handle: PlatformHandle,
}

/// Stable selection is independent of OS enumeration order. Rebuilding supplies
/// current content, so selection does not infer recency from opaque instance IDs.
pub(crate) fn select_restored_cards(mut cards: Vec<ObservedCard>) -> (Vec<ObservedCard>, Vec<ObservedCard>) {
    cards.sort_by(|a, b| (&a.target, &a.notification_id, &a.handle).cmp(&(&b.target, &b.notification_id, &b.handle)));
    let mut retained = Vec::new();
    let mut duplicates = Vec::new();
    let mut previous = None;
    for card in cards {
        if previous == Some(card.target) {
            duplicates.push(card);
        } else {
            previous = Some(card.target);
            retained.push(card);
        }
    }
    (retained, duplicates)
}

struct PublishedCard {
    notification_id: String,
    // Imported OS cards have no known receipt/content from this process.
    operation_id: Option<String>,
    handle: PlatformHandle,
    content: Option<super::content::NotificationContent>,
}

pub(crate) struct PreparedDelivery {
    pub(crate) operation_id: String,
    pub(crate) notification_id: Option<String>,
    pub(crate) command: NotificationCommand,
    pub(crate) previous_handle: Option<PlatformHandle>,
}

struct Pending {
    operation_id: String,
    candidate: AlertState,
    alert_thread: Option<NotificationTarget>,
    command: NotificationCommand,
    notification_id: Option<String>,
    dismissed: bool,
}

#[derive(Default)]
pub(crate) struct DeliveryState {
    committed: AlertState,
    pending: Option<Pending>,
    published: std::collections::HashMap<NotificationTarget, PublishedCard>,
}

impl DeliveryState {
    /// Import once while the owner still rejects business work. Reject ambiguous
    /// thread ownership atomically rather than silently losing an OS handle.
    pub(crate) fn import_cards(&mut self, cards: Vec<ObservedCard>) -> Result<(), &'static str> {
        if self.pending.is_some() || !self.published.is_empty() {
            return Err("notification import requires an empty delivery state");
        }
        let mut threads = std::collections::HashSet::new();
        let mut instances = std::collections::HashSet::new();
        for card in &cards {
            let id = uuid::Uuid::parse_str(&card.notification_id).map_err(|_| "invalid notification instance")?;
            if !card.target.valid() || id.to_string() != card.notification_id {
                return Err("invalid notification observation");
            }
            if !threads.insert(card.target) || !instances.insert(&card.notification_id) {
                return Err("ambiguous notification observations");
            }
        }
        for card in cards {
            self.committed.import_instance(card.target, card.notification_id.clone());
            self.published.insert(card.target, PublishedCard {
                notification_id: card.notification_id,
                operation_id: None,
                handle: card.handle,
                content: None,
            });
        }
        Ok(())
    }

    /// Capture instances before fetching. Callers hold the presentation lane through
    /// fetch/merge and reconstruction; dismissal observations still retire live cards.
    pub(crate) fn reconstruction_candidates(&self) -> Vec<(NotificationTarget, String)> {
        self.published.iter().map(|(thread, card)| (*thread, card.notification_id.clone())).collect()
    }

    /// `merged` is the complete current projection for this candidate, not a delta.
    /// Recheck live identity at prepare time so a dismissal or replacement during
    /// fetch cannot authorize recreation of the old card.
    pub(crate) fn prepare_reconstruction(
        &mut self,
        target: NotificationTarget,
        notification_id: &str,
        merged: Option<NotificationCommand>,
        policy: AlertPolicy,
        now: Instant,
    ) -> Result<Option<PreparedDelivery>, &'static str> {
        if self.pending.is_some() {
            return Err("notification delivery awaits a result");
        }
        if !self.published.get(&target).is_some_and(|card| card.notification_id == notification_id) {
            return Ok(None);
        }
        let command = match merged {
            Some(NotificationCommand::Show(mut content)) => {
                if content.target != target { return Err("reconstruction thread mismatch"); }
                if content.count > 0 {
                    content.silent = true;
                    NotificationCommand::Show(content)
                } else { NotificationCommand::Remove { target } }
            }
            Some(NotificationCommand::Remove { target: other }) if other != target => {
                return Err("reconstruction thread mismatch");
            }
            _ => NotificationCommand::Remove { target },
        };
        self.prepare(command, policy, false, now).map(Some)
    }

    pub(crate) fn prepare(
        &mut self,
        mut command: NotificationCommand,
        policy: AlertPolicy,
        allow_alert: bool,
        now: Instant,
    ) -> Result<PreparedDelivery, &'static str> {
        if self.pending.is_some() {
            return Err("notification delivery awaits a result");
        }
        let mut candidate = self.committed.clone();
        let notification_id = candidate.apply_with_instances(
            std::slice::from_mut(&mut command), policy, allow_alert, now,
        ).pop().flatten();
        let operation_id = uuid::Uuid::new_v4().to_string();
        let alert_thread = match &command {
            NotificationCommand::Show(content) if !content.silent => Some(content.target),
            _ => None,
        };
        let target = match &command {
            NotificationCommand::Show(content) => content.target,
            NotificationCommand::Remove { target } => *target,
        };
        let previous_handle = self.published.get(&target).map(|card| card.handle.clone());
        self.pending = Some(Pending {
            operation_id: operation_id.clone(), candidate, alert_thread,
            command: command.clone(), notification_id: notification_id.clone(), dismissed: false,
        });
        Ok(PreparedDelivery { operation_id, notification_id, command, previous_handle })
    }

    /// Commit only accepted receipts. Unknown outcomes end this attempt without
    /// committing; possible OS side effects are tolerated rather than blocking delivery.
    pub(crate) fn complete(&mut self, operation_id: &str, result: DeliveryResult, at: Instant) -> Result<(), &'static str> {
        if !self.pending.as_ref().is_some_and(|pending| pending.operation_id == operation_id) {
            return Err("notification result does not match pending operation");
        }
        if matches!(result, DeliveryResult::Uncertain) {
            log::warn!("notification result uncertain; treating attempt as unsuccessful; OS side effects may exist");
        }
        if matches!(result, DeliveryResult::Accepted { handle: None })
            && matches!(self.pending.as_ref().unwrap().command, NotificationCommand::Show(_)) {
            return Err("accepted show must return a platform handle");
        }
        let mut pending = self.pending.take().unwrap();
        if let DeliveryResult::Accepted { handle } = result {
            match &pending.command {
                NotificationCommand::Show(content) if !pending.dismissed => {
                    self.published.insert(content.target, PublishedCard {
                        notification_id: pending.notification_id.clone().unwrap(),
                        operation_id: Some(pending.operation_id.clone()),
                        handle: handle.unwrap(), content: Some(content.clone()),
                    });
                }
                NotificationCommand::Remove { target } => { self.published.remove(target); }
                _ => {}
            }
            if let Some(target) = pending.alert_thread {
                pending.candidate.accepted_alert_at(target, at);
            }
            self.committed = pending.candidate;
        }
        Ok(())
    }

    /// Some OS callbacks belong to a submitted update object, not the whole card.
    /// Ignore a retired object's event once a newer update is pending or published.
    pub(crate) fn dismissed_operation(&mut self, target: NotificationTarget, notification_id: &str, operation_id: &str) {
        if let Some(pending) = &self.pending {
            let pending_thread = match &pending.command {
                NotificationCommand::Show(content) => content.target,
                NotificationCommand::Remove { target } => *target,
            };
            if pending_thread == target {
                if pending.operation_id == operation_id && pending.notification_id.as_deref() == Some(notification_id) {
                    self.dismissed(target, notification_id);
                } else if self.published.get(&target).is_some_and(|card| card.notification_id == notification_id && card.operation_id.as_deref() == Some(operation_id)) {
                    // The old OS object disappeared while a replacement was being
                    // submitted. Retire only committed state: acceptance may publish
                    // the replacement, but rejection must not preserve a ghost card.
                    self.committed.dismissed_instance(target, notification_id);
                    self.published.remove(&target);
                }
                return;
            }
        }
        if self.published.get(&target).is_some_and(|card| card.notification_id == notification_id && card.operation_id.as_deref() == Some(operation_id)) {
            self.dismissed(target, notification_id);
        }
    }

    /// A history object's callback belongs to the imported version, not a later update.
    #[cfg(any(target_os = "windows", test))]
    pub(crate) fn dismissed_imported(&mut self, target: NotificationTarget, notification_id: &str) {
        if self.published.get(&target).is_some_and(|card|
            card.notification_id == notification_id && card.operation_id.is_none()) {
            self.committed.dismissed_instance(target, notification_id);
            self.published.remove(&target);
        } else {
            log::warn!("notification removal observation has no matching imported instance");
        }
    }

    pub(crate) fn dismissed(&mut self, target: NotificationTarget, notification_id: &str) {
        let published = self.published.get(&target)
            .is_some_and(|card| card.notification_id == notification_id);
        let pending = self.pending.as_ref().is_some_and(|pending| {
            let pending_target = match &pending.command {
                NotificationCommand::Show(content) => content.target,
                NotificationCommand::Remove { target } => *target,
            };
            pending_target == target && pending.notification_id.as_deref() == Some(notification_id)
        });
        if !published && !pending {
            // Late/duplicate events and the non-atomic startup import can miss.
            // Diagnostic only: never enumerate or rebuild in response.
            log::warn!("notification removal observation has no matching in-memory instance");
        }
        self.committed.dismissed_instance(target, notification_id);
        if self.published.get(&target).is_some_and(|card| card.notification_id == notification_id) {
            self.published.remove(&target);
        }
        // A dismissal can arrive before submission's acknowledgement. Retire the same
        // instance in the candidate too, so a late acceptance cannot resurrect it.
        if let Some(pending) = &mut self.pending {
            pending.candidate.dismissed_instance(target, notification_id);
            let pending_thread = match &pending.command {
                NotificationCommand::Show(content) => content.target,
                NotificationCommand::Remove { target } => *target,
            };
            if pending_thread == target && pending.notification_id.as_deref() == Some(notification_id) {
                pending.dismissed = true;
            }
        }
    }
}

/// Own the operation through its receipt even if the original caller stops waiting.
/// Platforms execute one prepared command; only this lane advances committed policy.
pub(crate) async fn deliver<F, Fut, O>(
    work: crate::login_connection::DatabaseWork,
    command: NotificationCommand,
    policy: AlertPolicy,
    allow_alert: bool,
    observe: O,
    execute: F,
) -> Result<(), String>
where
    O: FnOnce() -> Result<super::content::PresentationFacts, String> + Send + 'static,
    F: FnOnce(PreparedDelivery) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<DeliveryResult, String>> + Send,
{
    tauri::async_runtime::spawn(async move {
        let owner = work.owner().clone();
        let _lane = owner.notification_delivery_lane.lock().await;
        work.assert_current().map_err(|e| e.to_string())?;
        let command = super::content::observe_before_delivery(command, observe()?);
        let prepared = owner.notification_delivery.lock().map_err(|_| "notification state poisoned")?
            .prepare(command, policy, allow_alert, Instant::now()).map_err(str::to_owned)?;
        let operation_id = prepared.operation_id.clone();
        let outcome = if work.assert_current().is_err() {
            Ok(DeliveryResult::NotExecuted)
        } else {
            execute(prepared).await
        };
        settle(&owner, &operation_id, outcome)
    }).await.map_err(|e| format!("join notification transaction: {e}"))?
}

fn settle(
    owner: &crate::login_connection::LoginConnection,
    operation_id: &str,
    outcome: Result<DeliveryResult, String>,
) -> Result<(), String> {
    let (result, error) = match outcome {
        Ok(DeliveryResult::Accepted { handle }) => (DeliveryResult::Accepted { handle }, None),
        Ok(DeliveryResult::Rejected) => (DeliveryResult::Rejected, Some("notification rejected by platform".to_owned())),
        Ok(DeliveryResult::NotExecuted) => (DeliveryResult::NotExecuted, Some("notification not executed".to_owned())),
        Ok(DeliveryResult::Uncertain) => (DeliveryResult::Uncertain, Some("notification result uncertain".to_owned())),
        Err(error) => (DeliveryResult::Uncertain, Some(error)),
    };
    owner.notification_delivery.lock().map_err(|_| "notification state poisoned")?
        .complete(operation_id, result, Instant::now()).map_err(str::to_owned)?;
    error.map_or(Ok(()), Err)
}

/// Execute an explicitly supplied full projection against the original candidate
/// identities. The caller retains the candidates across retries. Cancellation of
/// the waiter cannot abandon OS receipts or release the lane during execution.
pub(crate) async fn reconstruct<F, Fut, O>(
    work: crate::login_connection::DatabaseWork,
    candidates: Vec<(NotificationTarget, String)>,
    merged: Vec<NotificationCommand>,
    policy: AlertPolicy,
    observe: O,
    mut execute: F,
) -> Result<(), String>
where
    O: Fn() -> Result<super::content::PresentationFacts, String> + Send + 'static,
    F: FnMut(PreparedDelivery) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<DeliveryResult, String>> + Send,
{
    tauri::async_runtime::spawn(async move {
        let owner = work.owner().clone();
        let _lane = owner.notification_delivery_lane.lock().await;
        work.assert_current().map_err(|e| e.to_string())?;
        let mut projection = std::collections::HashMap::new();
        for command in merged {
            let thread = match &command {
                NotificationCommand::Show(content) => content.target,
                NotificationCommand::Remove { target } => *target,
            };
            if projection.insert(thread, command).is_some() {
                return Err("duplicate reconstruction thread".into());
            }
        }
        for (thread, instance) in candidates {
            work.assert_current().map_err(|e| e.to_string())?;
            let facts = observe()?;
            let command = projection.get(&thread).cloned()
                .map(|command| super::content::observe_before_delivery(command, facts));
            let prepared = owner.notification_delivery.lock().map_err(|_| "notification state poisoned")?
                .prepare_reconstruction(thread, &instance, command, policy, Instant::now())
                .map_err(str::to_owned)?;
            let Some(prepared) = prepared else { continue };
            let operation = prepared.operation_id.clone();
            let outcome = if work.assert_current().is_err() {
                Ok(DeliveryResult::NotExecuted)
            } else {
                execute(prepared).await
            };
            settle(&owner, &operation, outcome)?;
        }
        Ok(())
    }).await.map_err(|e| format!("join notification reconstruction: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_db::notifications::content::NotificationContent;
    use std::time::Duration;

    fn show() -> NotificationCommand {
        NotificationCommand::Show(NotificationContent {
            target: NotificationTarget::Thread { thread_id: 7 }, title: "Peer".into(), body: "Message".into(), count: 1,
            silent: false, messages: vec![], has_unread_mention: false,
        })
    }
    fn policy() -> AlertPolicy { AlertPolicy::Cooldown(Duration::from_secs(5)) }

    fn accepted() -> DeliveryResult {
        DeliveryResult::Accepted { handle: Some(PlatformHandle::Macos { identifier: "os-card".into() }) }
    }

    fn owner() -> std::sync::Arc<crate::login_connection::LoginConnection> {
        let owner = crate::login_connection::LoginConnection::preparing(
            crate::login_session_store::LoginSessionId::try_from(uuid::Uuid::new_v4().to_string()).unwrap(),
            rusqlite::Connection::open_in_memory().unwrap(),
        );
        owner.begin_activation().unwrap().commit("test-token".into()).unwrap();
        owner
    }

    #[tokio::test]
    async fn reconstruction_executes_intersection_and_removals_without_creating_projection_only_cards() {
        let owner = owner();
        let first = observed(7.into());
        let second = observed(8.into());
        owner.notification_delivery.lock().unwrap().import_cards(vec![first, second]).unwrap();
        let candidates = owner.notification_delivery.lock().unwrap().reconstruction_candidates();
        let mut extra = show();
        if let NotificationCommand::Show(content) = &mut extra { content.target = 9.into(); }
        reconstruct(owner.capture_database_work().unwrap(), candidates, vec![show(), extra], policy(),
            || Ok(Default::default()), |prepared| async move {
                match prepared.command {
                    NotificationCommand::Show(content) => {
                        assert_eq!(content.target, 7.into());
                        assert!(content.silent);
                        Ok(DeliveryResult::Accepted { handle: prepared.previous_handle })
                    }
                    NotificationCommand::Remove { target } => {
                        assert_eq!(target, 8.into());
                        Ok(DeliveryResult::Accepted { handle: None })
                    }
                }
            }).await.unwrap();
        let state = owner.notification_delivery.lock().unwrap();
        assert_eq!(state.published.len(), 1);
        assert!(state.published.contains_key(&NotificationTarget::from(7)));
    }

    #[tokio::test]
    async fn reconstruction_stops_on_rejection_and_retries_original_candidate() {
        let owner = owner();
        let card = observed(7.into());
        let id = card.notification_id.clone();
        owner.notification_delivery.lock().unwrap().import_cards(vec![card]).unwrap();
        let candidates = vec![(7.into(), id.clone())];
        assert!(reconstruct(owner.capture_database_work().unwrap(), candidates.clone(), vec![show()], policy(),
            || Ok(Default::default()), |_| async { Ok(DeliveryResult::Rejected) }).await.is_err());
        assert!(owner.notification_delivery.lock().unwrap().published[&NotificationTarget::from(7)].content.is_none());
        reconstruct(owner.capture_database_work().unwrap(), candidates, vec![show()], policy(),
            || Ok(Default::default()), |prepared| async move {
                Ok(DeliveryResult::Accepted { handle: prepared.previous_handle })
            }).await.unwrap();
        let state = owner.notification_delivery.lock().unwrap();
        assert_eq!(state.published[&NotificationTarget::from(7)].notification_id, id);
        assert!(state.published[&NotificationTarget::from(7)].content.is_some());
    }

    #[tokio::test]
    async fn reconstruction_survives_waiter_cancellation_and_skips_later_dismissed_candidate() {
        let owner = owner();
        let first = observed(7.into());
        let second = observed(8.into());
        let second_id = second.notification_id.clone();
        let candidates = vec![(7.into(), first.notification_id.clone()), (8.into(), second_id.clone())];
        owner.notification_delivery.lock().unwrap().import_cards(vec![first, second]).unwrap();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
        let mut entered_tx = Some(entered_tx);
        let mut finish_rx = Some(finish_rx);
        let caller = tokio::spawn(reconstruct(owner.capture_database_work().unwrap(), candidates, vec![show()], policy(),
            || Ok(Default::default()), move |prepared| {
                let entered = entered_tx.take().expect("dismissed second card must not execute");
                let finish = finish_rx.take().unwrap();
                async move {
                    entered.send(prepared.operation_id).unwrap();
                    finish.await.unwrap();
                    Ok(DeliveryResult::Accepted { handle: prepared.previous_handle })
                }
            }));
        let operation = entered_rx.await.unwrap();
        owner.notification_delivery.lock().unwrap().dismissed(8.into(), &second_id);
        caller.abort();
        finish_tx.send(()).unwrap();
        let _lane = owner.notification_delivery_lane.lock().await;
        let state = owner.notification_delivery.lock().unwrap();
        assert_eq!(state.published[&NotificationTarget::from(7)].operation_id.as_deref(), Some(operation.as_str()));
        assert!(!state.published.contains_key(&NotificationTarget::from(8)));
        assert!(state.pending.is_none());
    }

    #[tokio::test]
    async fn execution_error_releases_pending_for_subsequent_delivery() {
        let owner = owner();
        let work = owner.capture_database_work().unwrap();
        assert!(deliver(work.clone(), show(), policy(), true,
            || Ok(Default::default()), |_| async { Err("receipt interrupted".into()) }).await.is_err());
        assert!(owner.notification_delivery.lock().unwrap().pending.is_none());
        deliver(work, show(), policy(), true, || Ok(Default::default()),
            |prepared| async move {
                assert!(matches!(prepared.command, NotificationCommand::Show(content) if !content.silent));
                Ok(accepted())
            }).await.unwrap();
        assert_eq!(owner.notification_delivery.lock().unwrap().published.len(), 1);
    }

    #[tokio::test]
    async fn reconstruction_uncertainty_ends_attempt_and_allows_the_next_round() {
        let owner = owner();
        let first = observed(7.into());
        let second = observed(8.into());
        let candidates = vec![(7.into(), first.notification_id.clone()), (8.into(), second.notification_id.clone())];
        owner.notification_delivery.lock().unwrap().import_cards(vec![first, second]).unwrap();
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let executed = calls.clone();
        assert!(reconstruct(owner.capture_database_work().unwrap(), candidates.clone(), vec![show()], policy(),
            || Ok(Default::default()), move |_| {
                executed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async { Ok(DeliveryResult::Uncertain) }
            }).await.is_err());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(owner.notification_delivery.lock().unwrap().pending.is_none());
        assert_eq!(owner.notification_delivery.lock().unwrap().published.len(), 2);
        reconstruct(owner.capture_database_work().unwrap(), candidates, vec![show()], policy(),
            || Ok(Default::default()), |prepared| async move {
                Ok(DeliveryResult::Accepted { handle: match prepared.command {
                    NotificationCommand::Show(_) => prepared.previous_handle,
                    NotificationCommand::Remove { .. } => None,
                } })
            }).await.unwrap();
        assert_eq!(owner.notification_delivery.lock().unwrap().published.len(), 1);
    }

    #[tokio::test]
    async fn shared_lane_commits_after_platform_acceptance_and_survives_caller_cancellation() {
        let owner = owner();
        let work = owner.capture_database_work().unwrap();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
        let caller = tokio::spawn(deliver(work, show(), policy(), true,
            || Ok(Default::default()),
            move |prepared| async move {
                entered_tx.send(prepared.operation_id).unwrap();
                finish_rx.await.unwrap();
                Ok(accepted())
            },
        ));
        let operation = entered_rx.await.unwrap();
        assert!(owner.notification_delivery.lock().unwrap().published.is_empty());
        caller.abort();
        finish_tx.send(()).unwrap();
        let _lane = owner.notification_delivery_lane.lock().await;
        assert_eq!(owner.notification_delivery.lock().unwrap().published[&NotificationTarget::from(7)].operation_id.as_deref(), Some(operation.as_str()));
    }

    #[tokio::test]
    async fn shared_lane_rechecks_facts_and_does_not_execute_ended_work() {
        let owner = owner();
        let work = owner.capture_database_work().unwrap();
        deliver(work.clone(), show(), policy(), true,
            || Ok(super::super::content::PresentationFacts { visible: true, focused: true, open_thread: Some(7) }),
            |prepared| async move {
                assert!(matches!(prepared.command, NotificationCommand::Remove { target: NotificationTarget::Thread { thread_id: 7 } }));
                Ok(DeliveryResult::Accepted { handle: None })
            },
        ).await.unwrap();
        owner.end().unwrap();
        assert!(deliver(work, show(), policy(), true, || Ok(Default::default()),
            |_| async { panic!("ended work must not reach the OS") }).await.is_err());
    }

    fn observed(target: NotificationTarget) -> ObservedCard {
        let id = uuid::Uuid::new_v4().to_string();
        ObservedCard { target, notification_id: id.clone(), handle: PlatformHandle::Android { tag: id, id: 65536 } }
    }

    #[test]
    fn restoration_selects_one_card_per_thread_independent_of_enumeration_order() {
        fn card(thread: NotificationTarget, suffix: u64, platform_id: i32) -> ObservedCard {
            let id = format!("550e8400-e29b-41d4-a716-{suffix:012}");
            ObservedCard { target: thread, notification_id: id.clone(), handle: PlatformHandle::Android { tag: id, id: platform_id } }
        }
        let (kept, removed) = select_restored_cards(vec![card(7.into(), 2, 4), card(8.into(), 3, 9), card(7.into(), 1, 6)]);
        let (reordered, reordered_removed) = select_restored_cards(vec![card(7.into(), 1, 6), card(7.into(), 2, 4), card(8.into(), 3, 9)]);
        assert_eq!(kept, reordered);
        assert_eq!(removed, reordered_removed);
        assert_eq!(kept.len(), 2);
        assert_eq!(removed, vec![card(7.into(), 2, 4)]);
        let mut state = DeliveryState::default();
        state.import_cards(kept).unwrap();
        assert_eq!(state.published.len(), 2);
    }

    #[test]
    fn requests_and_messages_on_the_same_thread_have_independent_instances() {
        let mut state = DeliveryState::default();
        let now = Instant::now();
        let first = state.prepare(show(), policy(), false, now).unwrap();
        state.complete(&first.operation_id, accepted(), now).unwrap();
        let mut request = show();
        if let NotificationCommand::Show(value) = &mut request { value.target = NotificationTarget::GroupJoinRequests { thread_id: 7 }; }
        let second = state.prepare(request, policy(), false, now).unwrap();
        assert_ne!(first.notification_id,second.notification_id);
        state.complete(&second.operation_id,accepted(),now).unwrap();
        state.dismissed(NotificationTarget::GroupJoinRequests { thread_id: 7 },second.notification_id.as_deref().unwrap());
        assert!(state.published.contains_key(&7.into()));
        assert_eq!(state.published.len(),1);
    }

    #[test]
    fn unmatched_removal_is_diagnostic_only_and_cannot_retire_another_instance() {
        let mut state = DeliveryState::default();
        let card = observed(7.into());
        let instance = card.notification_id.clone();
        state.import_cards(vec![card]).unwrap();
        state.dismissed(7.into(), &uuid::Uuid::new_v4().to_string());
        state.dismissed(8.into(), &instance);
        assert_eq!(state.committed.notification_id(7.into()), Some(instance.as_str()));
        assert_eq!(state.published.len(), 1);
        assert!(state.pending.is_none());
        state.dismissed(7.into(), &instance);
        state.dismissed(7.into(), &instance);
        assert!(state.published.is_empty());
        assert!(state.pending.is_none());
    }

    #[test]
    fn imported_object_dismissal_cannot_retire_a_newer_accepted_update() {
        let mut state = DeliveryState::default();
        let card = observed(7.into());
        let instance = card.notification_id.clone();
        let handle = card.handle.clone();
        state.import_cards(vec![card]).unwrap();
        let prepared = state.prepare_reconstruction(7.into(), &instance, Some(show()), policy(), Instant::now()).unwrap().unwrap();
        state.dismissed_imported(7.into(), &instance);
        assert!(state.published.is_empty());
        state.complete(&prepared.operation_id, DeliveryResult::Accepted { handle: Some(handle) }, Instant::now()).unwrap();
        state.dismissed_imported(7.into(), &instance);
        assert_eq!(state.published[&NotificationTarget::from(7)].operation_id.as_deref(), Some(prepared.operation_id.as_str()));
    }

    #[test]
    fn imported_card_preserves_identity_without_fabricating_content_or_receipts() {
        let mut state = DeliveryState::default();
        let card = observed(7.into());
        let id = card.notification_id.clone();
        let handle = card.handle.clone();
        state.import_cards(vec![card]).unwrap();
        assert!(state.published[&NotificationTarget::from(7)].content.is_none());
        assert!(state.published[&NotificationTarget::from(7)].operation_id.is_none());
        let prepared = state.prepare_reconstruction(7.into(), &id, Some(show()), policy(), Instant::now()).unwrap().unwrap();
        assert_eq!(prepared.notification_id.as_deref(), Some(id.as_str()));
        assert_eq!(prepared.previous_handle, Some(handle));
        assert!(matches!(prepared.command, NotificationCommand::Show(content) if content.silent));
    }

    #[test]
    fn ambiguous_import_is_atomic_and_cannot_overwrite_live_state() {
        let mut state = DeliveryState::default();
        assert!(state.import_cards(vec![observed(7.into()), observed(7.into())]).is_err());
        assert!(state.published.is_empty());
        assert!(state.committed.notification_id(7.into()).is_none());
        let card = observed(7.into());
        let id = card.notification_id.clone();
        state.import_cards(vec![card]).unwrap();
        assert!(state.import_cards(vec![observed(8.into())]).is_err());
        assert_eq!(state.committed.notification_id(7.into()), Some(id.as_str()));
        state.dismissed(7.into(), &id);
        assert!(state.prepare_reconstruction(7.into(), &id, Some(show()), policy(), Instant::now()).unwrap().is_none());
    }

    #[test]
    fn reconstruction_reuses_live_intersection_silently_and_removes_expired_cards() {
        let mut state = DeliveryState::default();
        let now = Instant::now();
        let first = state.prepare(show(), policy(), true, now).unwrap();
        state.complete(&first.operation_id, accepted(), now).unwrap();
        let candidates = state.reconstruction_candidates();
        assert_eq!(candidates.len(), 1);
        let (thread, instance) = &candidates[0];
        let rebuilt = state.prepare_reconstruction(*thread, instance, Some(show()), policy(), now).unwrap().unwrap();
        assert_eq!(rebuilt.notification_id, first.notification_id);
        assert!(matches!(&rebuilt.command, NotificationCommand::Show(content) if content.silent));
        state.complete(&rebuilt.operation_id, accepted(), now).unwrap();
        let removed = state.prepare_reconstruction(*thread, instance, None, policy(), now).unwrap().unwrap();
        assert!(matches!(removed.command, NotificationCommand::Remove { target: NotificationTarget::Thread { thread_id: 7 } }));
        state.complete(&removed.operation_id, DeliveryResult::Accepted { handle: None }, now).unwrap();
        assert!(state.reconstruction_candidates().is_empty());
    }

    #[test]
    fn reconstruction_cannot_revive_a_dismissed_or_replaced_candidate() {
        let mut state = DeliveryState::default();
        let now = Instant::now();
        let first = state.prepare(show(), policy(), true, now).unwrap();
        state.complete(&first.operation_id, accepted(), now).unwrap();
        let instance = first.notification_id.unwrap();
        state.dismissed(7.into(), &instance);
        assert!(state.prepare_reconstruction(7.into(), &instance, Some(show()), policy(), now).unwrap().is_none());
        let next = state.prepare(show(), policy(), true, now).unwrap();
        state.complete(&next.operation_id, accepted(), now).unwrap();
        assert!(state.prepare_reconstruction(7.into(), &instance, Some(show()), policy(), now).unwrap().is_none());
        assert_eq!(state.published[&NotificationTarget::from(7)].notification_id, next.notification_id.unwrap());
    }

    #[test]
    fn rejected_reconstruction_retains_candidate_and_can_retry() {
        let mut state = DeliveryState::default();
        let now = Instant::now();
        let first = state.prepare(show(), policy(), true, now).unwrap();
        state.complete(&first.operation_id, accepted(), now).unwrap();
        let instance = first.notification_id.unwrap();
        let update = state.prepare_reconstruction(7.into(), &instance, Some(show()), policy(), now).unwrap().unwrap();
        state.complete(&update.operation_id, DeliveryResult::Rejected, now).unwrap();
        let retry = state.prepare_reconstruction(7.into(), &instance, Some(show()), policy(), now).unwrap().unwrap();
        assert_eq!(retry.notification_id.as_deref(), Some(instance.as_str()));
    }

    #[test]
    fn not_executed_preserves_card_and_alert_capacity() {
        let mut state = DeliveryState::default();
        let first = state.prepare(show(), policy(), true, Instant::now()).unwrap();
        state.complete(&first.operation_id, DeliveryResult::NotExecuted, Instant::now()).unwrap();
        assert!(state.published.is_empty());
        let retry = state.prepare(show(), policy(), true, Instant::now()).unwrap();
        assert!(matches!(retry.command, NotificationCommand::Show(content) if !content.silent));
    }

    #[test]
    fn rejected_card_leaves_alert_available_for_another_thread() {
        let mut state = DeliveryState::default();
        let now = Instant::now();
        let first = state.prepare(show(), policy(), true, now).unwrap();
        state.complete(&first.operation_id, DeliveryResult::Rejected, now).unwrap();
        let mut other = show();
        if let NotificationCommand::Show(content) = &mut other { content.target = 8.into(); }
        let second = state.prepare(other, policy(), true, now).unwrap();
        assert!(matches!(&second.command, NotificationCommand::Show(content) if !content.silent));
        state.complete(&second.operation_id, accepted(), now).unwrap();
        assert!(state.published.get(&NotificationTarget::from(7)).is_none());
        assert!(state.published.get(&NotificationTarget::from(8)).is_some());
        let retry = state.prepare(show(), policy(), true, now).unwrap();
        assert!(matches!(retry.command, NotificationCommand::Show(content) if content.silent));
    }

    #[test]
    fn content_and_handle_change_only_after_the_matching_acceptance() {
        let mut state = DeliveryState::default();
        let now = Instant::now();
        let first = state.prepare(show(), policy(), true, now).unwrap();
        state.complete(&first.operation_id, accepted(), now).unwrap();
        let mut changed = show();
        if let NotificationCommand::Show(content) = &mut changed {
            content.body = "Edited message".into();
            content.count = 2;
        }
        let failed = state.prepare(changed.clone(), policy(), false, now).unwrap();
        state.complete(&failed.operation_id, DeliveryResult::Rejected, now).unwrap();
        let current = state.published.get(&NotificationTarget::from(7)).unwrap();
        assert_eq!(current.content.as_ref().unwrap().body, "Message");
        assert_eq!(current.operation_id.as_deref(), Some(first.operation_id.as_str()));
        let replacement = state.prepare(changed, policy(), false, now).unwrap();
        assert_eq!(replacement.notification_id, first.notification_id);
        assert!(state.complete(&failed.operation_id, accepted(), now).is_err());
        let handle = PlatformHandle::Macos { identifier: "accepted-handle".into() };
        state.complete(&replacement.operation_id, DeliveryResult::Accepted { handle: Some(handle.clone()) }, now).unwrap();
        let current = state.published.get(&NotificationTarget::from(7)).unwrap();
        assert_eq!(current.content.as_ref().unwrap().body, "Edited message");
        assert_eq!(current.content.as_ref().unwrap().count, 2);
        assert_eq!(current.handle, handle);
        assert_eq!(current.operation_id.as_deref(), Some(replacement.operation_id.as_str()));
        assert!(state.complete(&first.operation_id, accepted(), now).is_err());
        assert_eq!(state.published.get(&NotificationTarget::from(7)).unwrap().content.as_ref().unwrap().body, "Edited message");
    }

    #[test]
    fn accepted_removal_retires_content_and_handle_before_recreation() {
        let mut state = DeliveryState::default();
        let now = Instant::now();
        let first = state.prepare(show(), policy(), true, now).unwrap();
        state.complete(&first.operation_id, accepted(), now).unwrap();
        let removal = state.prepare(NotificationCommand::Remove { target: NotificationTarget::Thread { thread_id: 7 } }, policy(), false, now).unwrap();
        assert!(removal.previous_handle.is_some());
        state.complete(&removal.operation_id, DeliveryResult::Accepted { handle: None }, now).unwrap();
        assert!(state.published.is_empty());
        assert!(state.committed.notification_id(7.into()).is_none());
        let recreated = state.prepare(show(), policy(), true, now).unwrap();
        assert_ne!(recreated.notification_id, first.notification_id);
        assert!(recreated.previous_handle.is_none());
    }

    #[test]
    fn retired_update_callback_cannot_remove_a_newer_update_of_the_same_instance() {
        let mut state = DeliveryState::default();
        let now = Instant::now();
        let first = state.prepare(show(), policy(), true, now).unwrap();
        state.complete(&first.operation_id, accepted(), now).unwrap();
        let update = state.prepare(show(), policy(), false, now).unwrap();
        let instance = first.notification_id.as_deref().unwrap();
        state.dismissed_operation(7.into(), instance, &first.operation_id);
        state.complete(&update.operation_id, accepted(), now).unwrap();
        assert!(state.published.contains_key(&NotificationTarget::from(7)));
        state.dismissed_operation(7.into(), instance, &first.operation_id);
        assert!(state.published.contains_key(&NotificationTarget::from(7)));
        state.dismissed_operation(7.into(), instance, &update.operation_id);
        assert!(!state.published.contains_key(&NotificationTarget::from(7)));
    }

    #[test]
    fn dismissal_of_another_thread_survives_an_in_flight_commit() {
        let mut state = DeliveryState::default();
        let now = Instant::now();
        let first = state.prepare(show(), policy(), true, now).unwrap();
        state.complete(&first.operation_id, accepted(), now).unwrap();
        let mut other = show();
        if let NotificationCommand::Show(content) = &mut other { content.target = 8.into(); }
        let next = state.prepare(other, policy(), false, now).unwrap();
        state.dismissed_operation(7.into(), first.notification_id.as_deref().unwrap(), &first.operation_id);
        state.complete(&next.operation_id, accepted(), now).unwrap();
        assert!(!state.published.contains_key(&NotificationTarget::from(7)));
        assert!(state.committed.notification_id(7.into()).is_none());
        assert!(state.published.contains_key(&NotificationTarget::from(8)));
    }

    #[test]
    fn old_card_dismissed_during_rejected_update_does_not_leave_a_ghost() {
        let mut state = DeliveryState::default();
        let now = Instant::now();
        let first = state.prepare(show(), policy(), true, now).unwrap();
        state.complete(&first.operation_id, accepted(), now).unwrap();
        let update = state.prepare(show(), policy(), false, now).unwrap();
        state.dismissed_operation(7.into(), first.notification_id.as_deref().unwrap(), &first.operation_id);
        state.complete(&update.operation_id, DeliveryResult::Rejected, now).unwrap();
        assert!(state.published.is_empty());
        assert!(state.committed.notification_id(7.into()).is_none());
    }

    #[test]
    fn exact_update_callback_before_acceptance_cannot_resurrect_card() {
        let mut state = DeliveryState::default();
        let now = Instant::now();
        let pending = state.prepare(show(), policy(), true, now).unwrap();
        state.dismissed_operation(7.into(), pending.notification_id.as_deref().unwrap(), &pending.operation_id);
        state.complete(&pending.operation_id, accepted(), now).unwrap();
        assert!(state.published.is_empty());
        assert!(state.committed.notification_id(7.into()).is_none());
    }

    #[test]
    fn wrong_thread_dismissal_cannot_retire_a_pending_instance() {
        let mut state = DeliveryState::default();
        let now = Instant::now();
        let first = state.prepare(show(), policy(), true, now).unwrap();
        state.dismissed(8.into(), first.notification_id.as_deref().unwrap());
        state.complete(&first.operation_id, accepted(), now).unwrap();
        assert_eq!(state.committed.notification_id(7.into()), first.notification_id.as_deref());
        assert_eq!(state.published.get(&NotificationTarget::from(7)).unwrap().notification_id, first.notification_id.unwrap());
    }

    #[test]
    fn uncertain_result_releases_operation_without_consuming_alert_or_accepting_late_receipts() {
        let mut state = DeliveryState::default();
        let now = Instant::now();
        let first = state.prepare(show(), policy(), true, now).unwrap();
        state.complete(&first.operation_id, DeliveryResult::Uncertain, now).unwrap();
        assert!(state.pending.is_none());
        assert!(state.published.is_empty());
        let retry = state.prepare(show(), policy(), true, now).unwrap();
        assert!(matches!(&retry.command, NotificationCommand::Show(content) if !content.silent));
        assert_ne!(retry.notification_id, first.notification_id);
        assert!(state.complete(&first.operation_id, accepted(), now).is_err());
        assert!(state.complete(&retry.operation_id, DeliveryResult::Accepted { handle: None }, now).is_err());
        state.complete(&retry.operation_id, accepted(), now).unwrap();
        let card = state.published.get(&NotificationTarget::from(7)).unwrap();
        assert_eq!(card.operation_id.as_deref(), Some(retry.operation_id.as_str()));
        assert_eq!(card.content.as_ref().unwrap().body, "Message");
        let update = state.prepare(show(), policy(), true, now).unwrap();
        assert_eq!(update.previous_handle, Some(PlatformHandle::Macos { identifier: "os-card".into() }));
        state.complete(&update.operation_id, DeliveryResult::Uncertain, now).unwrap();
        assert!(state.pending.is_none());
        assert_eq!(state.published.get(&NotificationTarget::from(7)).unwrap().operation_id.as_deref(), Some(retry.operation_id.as_str()));
    }

    #[test]
    fn cooldown_starts_at_acceptance_not_preparation() {
        let mut state = DeliveryState::default();
        let now = Instant::now();
        let accepted_at = now + Duration::from_secs(10);
        let first = state.prepare(show(), policy(), true, now).unwrap();
        state.complete(&first.operation_id, accepted(), accepted_at).unwrap();
        let early = state.prepare(show(), policy(), true, accepted_at + Duration::from_secs(4)).unwrap();
        assert!(matches!(early.command, NotificationCommand::Show(content) if content.silent));
        state.complete(&early.operation_id, DeliveryResult::Rejected, accepted_at + Duration::from_secs(4)).unwrap();
        let boundary = state.prepare(show(), policy(), true, accepted_at + Duration::from_secs(5)).unwrap();
        assert!(matches!(boundary.command, NotificationCommand::Show(content) if !content.silent));
    }

    #[test]
    fn rejected_update_does_not_advance_the_previous_cooldown() {
        let mut state = DeliveryState::default();
        let now = Instant::now();
        let first = state.prepare(show(), policy(), true, now).unwrap();
        state.complete(&first.operation_id, accepted(), now).unwrap();
        let later = now + Duration::from_secs(5);
        let update = state.prepare(show(), policy(), true, later).unwrap();
        assert_eq!(update.notification_id, first.notification_id);
        state.complete(&update.operation_id, DeliveryResult::Rejected, later).unwrap();
        let retry = state.prepare(show(), policy(), true, later).unwrap();
        assert_eq!(retry.notification_id, first.notification_id);
        assert!(matches!(retry.command, NotificationCommand::Show(content) if !content.silent));
    }

    #[test]
    fn rejection_leaves_no_card_or_consumed_cooldown() {
        let mut state = DeliveryState::default();
        let now = Instant::now();
        let first = state.prepare(show(), policy(), true, now).unwrap();
        assert!(state.committed.notification_id(7.into()).is_none());
        state.complete(&first.operation_id, DeliveryResult::Rejected, now).unwrap();
        let retry = state.prepare(show(), policy(), true, now).unwrap();
        assert_ne!(first.notification_id, retry.notification_id);
        assert!(matches!(retry.command, NotificationCommand::Show(content) if !content.silent));
    }

    #[test]
    fn wrong_receipt_does_not_release_pending_work() {
        let mut state = DeliveryState::default();
        let first = state.prepare(show(), policy(), true, Instant::now()).unwrap();
        assert!(state.complete("wrong", accepted(), Instant::now()).is_err());
        assert!(state.prepare(show(), policy(), true, Instant::now()).is_err());
        state.complete(&first.operation_id, accepted(), Instant::now()).unwrap();
        assert_eq!(state.committed.notification_id(7.into()), first.notification_id.as_deref());
        assert!(state.complete(&first.operation_id, accepted(), Instant::now()).is_err());
    }

    #[test]
    fn failed_removal_preserves_the_existing_instance() {
        let mut state = DeliveryState::default();
        let now = Instant::now();
        let first = state.prepare(show(), policy(), true, now).unwrap();
        state.complete(&first.operation_id, accepted(), now).unwrap();
        let removal = state.prepare(NotificationCommand::Remove { target: NotificationTarget::Thread { thread_id: 7 } }, policy(), false, now).unwrap();
        assert_eq!(first.notification_id, removal.notification_id);
        state.complete(&removal.operation_id, DeliveryResult::Rejected, now).unwrap();
        assert_eq!(state.committed.notification_id(7.into()), first.notification_id.as_deref());
    }

    #[test]
    fn dismissal_before_acceptance_does_not_resurrect_card() {
        let mut state = DeliveryState::default();
        let first = state.prepare(show(), policy(), true, Instant::now()).unwrap();
        state.dismissed(7.into(), first.notification_id.as_deref().unwrap());
        state.complete(&first.operation_id, accepted(), Instant::now()).unwrap();
        assert!(state.committed.notification_id(7.into()).is_none());
    }
}
