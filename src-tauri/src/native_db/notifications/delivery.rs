//! Serial prepare/acknowledge boundary. Prepared state is never published as a current card.
use super::{alert::{AlertPolicy, AlertState}, content::NotificationCommand};
use std::time::Instant;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PlatformHandle {
    Android { tag: String, id: i32 },
    Macos { identifier: String },
    Windows { tag: String, group: String },
    Linux { daemon: String, id: u32 },
}

pub(crate) enum DeliveryResult {
    Accepted { handle: Option<PlatformHandle> },
    Rejected,
    Uncertain,
}

struct PublishedCard {
    notification_id: String,
    operation_id: String,
    handle: PlatformHandle,
    content: super::content::NotificationContent,
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
    alert_thread: Option<i32>,
    command: NotificationCommand,
    notification_id: Option<String>,
    dismissed: bool,
}

#[derive(Default)]
pub(crate) struct DeliveryState {
    committed: AlertState,
    pending: Option<Pending>,
    published: std::collections::HashMap<i32, PublishedCard>,
}

impl DeliveryState {
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
            NotificationCommand::Show(content) if !content.silent => Some(content.thread_id),
            _ => None,
        };
        let thread_id = match &command {
            NotificationCommand::Show(content) => content.thread_id,
            NotificationCommand::Remove { thread_id } => *thread_id,
        };
        let previous_handle = self.published.get(&thread_id).map(|card| card.handle.clone());
        self.pending = Some(Pending {
            operation_id: operation_id.clone(), candidate, alert_thread,
            command: command.clone(), notification_id: notification_id.clone(), dismissed: false,
        });
        Ok(PreparedDelivery { operation_id, notification_id, command, previous_handle })
    }

    /// Call only with a definite OS result. Unknown outcomes retain the pending operation
    /// for reconciliation and must not be converted to rejection merely to unblock work.
    pub(crate) fn complete(&mut self, operation_id: &str, result: DeliveryResult, at: Instant) -> Result<(), &'static str> {
        if !self.pending.as_ref().is_some_and(|pending| pending.operation_id == operation_id) {
            return Err("notification result does not match pending operation");
        }
        if matches!(result, DeliveryResult::Uncertain) {
            return Ok(());
        }
        if matches!(result, DeliveryResult::Accepted { handle: None })
            && matches!(self.pending.as_ref().unwrap().command, NotificationCommand::Show(_)) {
            return Err("accepted show must return a platform handle");
        }
        let mut pending = self.pending.take().unwrap();
        if let DeliveryResult::Accepted { handle } = result {
            match &pending.command {
                NotificationCommand::Show(content) if !pending.dismissed => {
                    self.published.insert(content.thread_id, PublishedCard {
                        notification_id: pending.notification_id.clone().unwrap(),
                        operation_id: pending.operation_id.clone(),
                        handle: handle.unwrap(), content: content.clone(),
                    });
                }
                NotificationCommand::Remove { thread_id } => { self.published.remove(thread_id); }
                _ => {}
            }
            if let Some(thread_id) = pending.alert_thread {
                pending.candidate.accepted_alert_at(thread_id, at);
            }
            self.committed = pending.candidate;
        }
        Ok(())
    }

    pub(crate) fn dismissed(&mut self, thread_id: i32, notification_id: &str) {
        self.committed.dismissed_instance(thread_id, notification_id);
        if self.published.get(&thread_id).is_some_and(|card| card.notification_id == notification_id) {
            self.published.remove(&thread_id);
        }
        // A dismissal can arrive before submission's acknowledgement. Retire the same
        // instance in the candidate too, so a late acceptance cannot resurrect it.
        if let Some(pending) = &mut self.pending {
            pending.candidate.dismissed_instance(thread_id, notification_id);
            let pending_thread = match &pending.command {
                NotificationCommand::Show(content) => content.thread_id,
                NotificationCommand::Remove { thread_id } => *thread_id,
            };
            if pending_thread == thread_id && pending.notification_id.as_deref() == Some(notification_id) {
                pending.dismissed = true;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_db::notifications::content::NotificationContent;
    use std::time::Duration;

    fn show() -> NotificationCommand {
        NotificationCommand::Show(NotificationContent {
            thread_id: 7, title: "Peer".into(), body: "Message".into(), count: 1,
            silent: false, messages: vec![], has_unread_mention: false,
        })
    }
    fn policy() -> AlertPolicy { AlertPolicy::Cooldown(Duration::from_secs(5)) }

    fn accepted() -> DeliveryResult {
        DeliveryResult::Accepted { handle: Some(PlatformHandle::Macos { identifier: "os-card".into() }) }
    }

    #[test]
    fn rejected_card_leaves_alert_available_for_another_thread() {
        let mut state = DeliveryState::default();
        let now = Instant::now();
        let first = state.prepare(show(), policy(), true, now).unwrap();
        state.complete(&first.operation_id, DeliveryResult::Rejected, now).unwrap();
        let mut other = show();
        if let NotificationCommand::Show(content) = &mut other { content.thread_id = 8; }
        let second = state.prepare(other, policy(), true, now).unwrap();
        assert!(matches!(&second.command, NotificationCommand::Show(content) if !content.silent));
        state.complete(&second.operation_id, accepted(), now).unwrap();
        assert!(state.published.get(&7).is_none());
        assert!(state.published.get(&8).is_some());
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
        let current = state.published.get(&7).unwrap();
        assert_eq!(current.content.body, "Message");
        assert_eq!(current.operation_id, first.operation_id);
        let replacement = state.prepare(changed, policy(), false, now).unwrap();
        assert_eq!(replacement.notification_id, first.notification_id);
        assert!(state.complete(&failed.operation_id, accepted(), now).is_err());
        let handle = PlatformHandle::Macos { identifier: "accepted-handle".into() };
        state.complete(&replacement.operation_id, DeliveryResult::Accepted { handle: Some(handle.clone()) }, now).unwrap();
        let current = state.published.get(&7).unwrap();
        assert_eq!(current.content.body, "Edited message");
        assert_eq!(current.content.count, 2);
        assert_eq!(current.handle, handle);
        assert_eq!(current.operation_id, replacement.operation_id);
        assert!(state.complete(&first.operation_id, accepted(), now).is_err());
        assert_eq!(state.published.get(&7).unwrap().content.body, "Edited message");
    }

    #[test]
    fn accepted_removal_retires_content_and_handle_before_recreation() {
        let mut state = DeliveryState::default();
        let now = Instant::now();
        let first = state.prepare(show(), policy(), true, now).unwrap();
        state.complete(&first.operation_id, accepted(), now).unwrap();
        let removal = state.prepare(NotificationCommand::Remove { thread_id: 7 }, policy(), false, now).unwrap();
        assert!(removal.previous_handle.is_some());
        state.complete(&removal.operation_id, DeliveryResult::Accepted { handle: None }, now).unwrap();
        assert!(state.published.is_empty());
        assert!(state.committed.notification_id(7).is_none());
        let recreated = state.prepare(show(), policy(), true, now).unwrap();
        assert_ne!(recreated.notification_id, first.notification_id);
        assert!(recreated.previous_handle.is_none());
    }

    #[test]
    fn wrong_thread_dismissal_cannot_retire_a_pending_instance() {
        let mut state = DeliveryState::default();
        let now = Instant::now();
        let first = state.prepare(show(), policy(), true, now).unwrap();
        state.dismissed(8, first.notification_id.as_deref().unwrap());
        state.complete(&first.operation_id, accepted(), now).unwrap();
        assert_eq!(state.committed.notification_id(7), first.notification_id.as_deref());
        assert_eq!(state.published.get(&7).unwrap().notification_id, first.notification_id.unwrap());
    }

    #[test]
    fn uncertain_result_retains_operation_and_missing_handle_cannot_commit() {
        let mut state = DeliveryState::default();
        let now = Instant::now();
        let first = state.prepare(show(), policy(), true, now).unwrap();
        state.complete(&first.operation_id, DeliveryResult::Uncertain, now).unwrap();
        assert!(state.prepare(show(), policy(), true, now).is_err());
        assert!(state.complete(&first.operation_id, DeliveryResult::Accepted { handle: None }, now).is_err());
        assert!(state.published.is_empty());
        state.complete(&first.operation_id, accepted(), now).unwrap();
        let card = state.published.get(&7).unwrap();
        assert_eq!(card.operation_id, first.operation_id);
        assert_eq!(card.content.body, "Message");
        let update = state.prepare(show(), policy(), true, now).unwrap();
        assert_eq!(update.previous_handle, Some(PlatformHandle::Macos { identifier: "os-card".into() }));
        state.complete(&update.operation_id, DeliveryResult::Rejected, now).unwrap();
        assert_eq!(state.published.get(&7).unwrap().operation_id, first.operation_id);
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
        assert!(state.committed.notification_id(7).is_none());
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
        assert_eq!(state.committed.notification_id(7), first.notification_id.as_deref());
        assert!(state.complete(&first.operation_id, accepted(), Instant::now()).is_err());
    }

    #[test]
    fn failed_removal_preserves_the_existing_instance() {
        let mut state = DeliveryState::default();
        let now = Instant::now();
        let first = state.prepare(show(), policy(), true, now).unwrap();
        state.complete(&first.operation_id, accepted(), now).unwrap();
        let removal = state.prepare(NotificationCommand::Remove { thread_id: 7 }, policy(), false, now).unwrap();
        assert_eq!(first.notification_id, removal.notification_id);
        state.complete(&removal.operation_id, DeliveryResult::Rejected, now).unwrap();
        assert_eq!(state.committed.notification_id(7), first.notification_id.as_deref());
    }

    #[test]
    fn dismissal_before_acceptance_does_not_resurrect_card() {
        let mut state = DeliveryState::default();
        let first = state.prepare(show(), policy(), true, Instant::now()).unwrap();
        state.dismissed(7, first.notification_id.as_deref().unwrap());
        state.complete(&first.operation_id, accepted(), Instant::now()).unwrap();
        assert!(state.committed.notification_id(7).is_none());
    }
}
