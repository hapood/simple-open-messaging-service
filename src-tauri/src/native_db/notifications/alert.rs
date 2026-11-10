//! Shared native alert eligibility; OS adapters receive an already-decided silent flag.
use crate::native_db::notifications::NotificationTarget;
use std::time::{Duration, Instant};
use super::content::NotificationCommand;

#[derive(Clone, Copy)]
pub(crate) enum AlertPolicy {
    Cooldown(Duration),
    OncePerThread,
}

impl AlertPolicy {
    pub(crate) fn from_preference(value: Option<&str>) -> Result<Self, String> {
        match value {
            None | Some("cooldown_5s") => Ok(Self::Cooldown(Duration::from_secs(5))),
            Some("cooldown_2s") => Ok(Self::Cooldown(Duration::from_secs(2))),
            Some("once_per_thread") => Ok(Self::OncePerThread),
            Some(_) => Err("invalid notification alert policy".into()),
        }
    }
}

#[derive(Clone, Debug)]
struct NotificationCard {
    id: String,
    last_alert: Option<Instant>,
}

#[derive(Clone, Default)]
pub(crate) struct AlertState {
    last_alert: Option<Instant>,
    cards: std::collections::HashMap<NotificationTarget, NotificationCard>,
}

impl AlertState {
    /// OS presence is not evidence of an audible alert or its acceptance time.
    pub(crate) fn import_instance(&mut self, target: NotificationTarget, id: String) {
        self.cards.insert(target, NotificationCard { id, last_alert: None });
    }

    pub(crate) fn accepted_alert_at(&mut self, target: NotificationTarget, at: Instant) {
        self.last_alert = Some(at);
        if let Some(card) = self.cards.get_mut(&target) {
            card.last_alert = Some(at);
        }
    }

    pub(crate) fn dismissed_instance(&mut self, target: NotificationTarget, notification_id: &str) {
        if self.cards.get(&target).is_some_and(|card| card.id == notification_id) {
            self.cards.remove(&target);
        }
    }

    pub(crate) fn notification_id(&self, target: NotificationTarget) -> Option<&str> {
        self.cards.get(&target).map(|card| card.id.as_str())
    }

    pub(crate) fn apply_with_instances(
        &mut self,
        commands: &mut [NotificationCommand],
        policy: AlertPolicy,
        allow_alert: bool,
        now: Instant,
    ) -> Vec<Option<String>> {
        commands.iter_mut().map(|command| {
            let removed = match command {
                NotificationCommand::Remove { target } => self.notification_id(*target).map(str::to_owned),
                _ => None,
            };
            self.apply(std::slice::from_mut(command), policy, allow_alert, now);
            match command {
                NotificationCommand::Show(content) => self.notification_id(content.target).map(str::to_owned),
                NotificationCommand::Remove { .. } => removed,
            }
        }).collect()
    }

    /// Owned by one login's notification runtime, not a process-global platform singleton.
    /// Removal retires the card; a later new card may alert again.
    pub(crate) fn apply(
        &mut self,
        commands: &mut [NotificationCommand],
        policy: AlertPolicy,
        allow_alert: bool,
        now: Instant,
    ) {
        for command in commands {
            match command {
                NotificationCommand::Remove { target } => {
                    self.cards.remove(target);
                }
                NotificationCommand::Show(content) => {
                    let card = self.cards.entry(content.target).or_insert_with(|| NotificationCard {
                        id: uuid::Uuid::new_v4().to_string(),
                        last_alert: None,
                    });
                    if content.silent || !allow_alert {
                        content.silent = true;
                        continue;
                    }
                    let eligible = match policy {
                        AlertPolicy::Cooldown(interval) => self.last_alert.is_none_or(|last| {
                            now.saturating_duration_since(last) >= interval
                        }),
                        AlertPolicy::OncePerThread => card.last_alert.is_none(),
                    };
                    content.silent = !eligible;
                    if eligible {
                        self.last_alert = Some(now);
                        card.last_alert = Some(now);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_db::notifications::content::NotificationContent;

    fn show(id: i32, silent: bool) -> NotificationCommand {
        NotificationCommand::Show(NotificationContent {
            target: id.into(), latest_seq: Some(42), title: String::new(), body: String::new(), count: 1,
            silent, messages: vec![], has_unread_mention: false,
        })
    }
    fn silent(command: &NotificationCommand) -> bool {
        match command { NotificationCommand::Show(value) => value.silent, _ => true }
    }
    #[test]
    fn removal_returns_the_retired_id_and_preserves_global_cooldown() {
        let mut state = AlertState::default();
        let now = Instant::now();
        let policy = AlertPolicy::Cooldown(Duration::from_secs(5));
        state.apply(&mut [show(7, false)], policy, true, now);
        let old = state.notification_id(7.into()).unwrap().to_owned();
        state.dismissed_instance(7.into(), &old);
        assert_eq!(state.notification_id(7.into()), None);
        state.dismissed_instance(7.into(), &old);
        let mut next = [show(7, false)];
        state.apply(&mut next, policy, true, now);
        assert!(silent(&next[0]));
        assert_ne!(state.notification_id(7.into()), Some(old.as_str()));
    }

    #[test]
    fn batch_ids_follow_each_operation_not_the_final_thread_state() {
        let mut state = AlertState::default();
        let mut commands = [show(7, false), show(7, false),
            NotificationCommand::Remove { target: NotificationTarget::Thread { thread_id: 7 } }, show(7, false),
            NotificationCommand::Remove { target: NotificationTarget::Thread { thread_id: 8 } }];
        let ids = state.apply_with_instances(&mut commands, AlertPolicy::OncePerThread, true, Instant::now());
        assert!(ids[0].is_some());
        assert_eq!(ids[0], ids[1]);
        assert_eq!(ids[0], ids[2]);
        assert_ne!(ids[0], ids[3]);
        assert_eq!(ids[4], None);
        state.dismissed_instance(7.into(), ids[0].as_deref().unwrap());
        assert_eq!(state.notification_id(7.into()), ids[3].as_deref());
    }

    #[test]
    fn card_updates_reuse_id_and_stale_dismissal_cannot_remove_a_replacement() {
        let mut state = AlertState::default();
        let now = Instant::now();
        state.apply(&mut [show(7, false)], AlertPolicy::OncePerThread, true, now);
        let first = state.notification_id(7.into()).unwrap().to_owned();
        state.apply(&mut [show(7, false)], AlertPolicy::OncePerThread, true, now);
        assert_eq!(state.notification_id(7.into()), Some(first.as_str()));
        state.dismissed_instance(7.into(), &first);
        assert!(state.notification_id(7.into()).is_none());
        let mut replacement = [show(7, false)];
        state.apply(&mut replacement, AlertPolicy::OncePerThread, true, now);
        assert!(!silent(&replacement[0]));
        let second = state.notification_id(7.into()).unwrap().to_owned();
        assert_ne!(first, second);
        state.dismissed_instance(7.into(), &first);
        assert_eq!(state.notification_id(7.into()), Some(second.as_str()));
    }

    #[test]
    fn silent_cards_also_have_instances_without_consuming_first_alert() {
        let mut state = AlertState::default();
        let now = Instant::now();
        state.apply(&mut [show(7, true)], AlertPolicy::OncePerThread, true, now);
        let id = state.notification_id(7.into()).unwrap().to_owned();
        let mut update = [show(7, false)];
        state.apply(&mut update, AlertPolicy::OncePerThread, true, now);
        assert!(!silent(&update[0]));
        assert_eq!(state.notification_id(7.into()), Some(id.as_str()));
    }

    #[test]
    fn existing_preference_values_map_to_shared_policy() {
        assert!(matches!(AlertPolicy::from_preference(None).unwrap(), AlertPolicy::Cooldown(value) if value == Duration::from_secs(5)));
        assert!(matches!(AlertPolicy::from_preference(Some("cooldown_2s")).unwrap(), AlertPolicy::Cooldown(value) if value == Duration::from_secs(2)));
        assert!(matches!(AlertPolicy::from_preference(Some("once_per_thread")).unwrap(), AlertPolicy::OncePerThread));
        assert!(AlertPolicy::from_preference(Some("invalid")).is_err());
    }

    #[test]
    fn both_cooldowns_suppress_before_the_boundary_without_extending_it() {
        for seconds in [2, 5] {
            let mut state = AlertState::default();
            let now = Instant::now();
            let interval = Duration::from_secs(seconds);
            let policy = AlertPolicy::Cooldown(interval);
            let mut first = [show(1, false)];
            state.apply(&mut first, policy, true, now);
            assert!(!silent(&first[0]));
            let mut early = [show(2, false)];
            state.apply(&mut early, policy, true, now + interval - Duration::from_millis(1));
            assert!(silent(&early[0]));
            let mut boundary = [show(3, false)];
            state.apply(&mut boundary, policy, true, now + interval);
            assert!(!silent(&boundary[0]));
        }
    }

    #[test]
    fn removal_and_muted_cards_do_not_consume_cooldown() {
        let mut state = AlertState::default();
        let mut commands = [NotificationCommand::Remove { target: NotificationTarget::Thread { thread_id: 1 } }, show(2, true), show(3, false), show(4, false)];
        state.apply(&mut commands, AlertPolicy::Cooldown(Duration::from_secs(5)), true, Instant::now());
        assert!(!silent(&commands[2]));
        assert!(silent(&commands[3]));
    }
    #[test]
    fn suppressed_batch_does_not_delay_next_alert_and_boundary_is_inclusive() {
        let mut state = AlertState::default();
        let now = Instant::now();
        let policy = AlertPolicy::Cooldown(Duration::from_secs(5));
        state.apply(&mut [show(1, false)], policy, false, now);
        let mut first = [show(2, false)];
        state.apply(&mut first, policy, true, now);
        assert!(!silent(&first[0]));
        let mut next = [show(3, false)];
        state.apply(&mut next, policy, true, now + Duration::from_secs(5));
        assert!(!silent(&next[0]));
    }
    #[test]
    fn system_dismissal_retires_only_that_card_without_resetting_global_cooldown() {
        let mut state = AlertState::default();
        let now = Instant::now();
        state.apply(&mut [show(1, false), show(2, false)], AlertPolicy::OncePerThread, true, now);
        let id = state.notification_id(1.into()).unwrap().to_owned();
        state.dismissed_instance(1.into(), &id);
        let mut cards = [show(1, false), show(2, false)];
        state.apply(&mut cards, AlertPolicy::OncePerThread, true, now);
        assert!(!silent(&cards[0]));
        assert!(silent(&cards[1]));
        let id = state.notification_id(1.into()).unwrap().to_owned();
        state.dismissed_instance(1.into(), &id);
        let mut next = [show(3, false)];
        state.apply(&mut next, AlertPolicy::Cooldown(Duration::from_secs(5)), true, now);
        assert!(silent(&next[0]));
    }

    #[test]
    fn once_per_thread_replacement_is_silent_until_card_is_removed() {
        let mut state = AlertState::default();
        let mut commands = [show(1, false), show(1, false), NotificationCommand::Remove { target: NotificationTarget::Thread { thread_id: 1 } }, show(1, false)];
        state.apply(&mut commands, AlertPolicy::OncePerThread, true, Instant::now());
        assert!(!silent(&commands[0]));
        assert!(silent(&commands[1]));
        assert!(!silent(&commands[3]));
    }
}
