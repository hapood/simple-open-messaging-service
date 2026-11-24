//! Import OS observations before admitting notification business work.
use super::platform::{self, CardObservation};
use crate::login_connection::LoginConnection;
use std::sync::Arc;

pub(crate) fn restore(owner: &Arc<LoginConnection>, app: Option<&tauri::AppHandle>) -> Result<(), String> {
    // OS calls run without holding delivery or reconstruction locks.
    restore_observation(owner, platform::observe(app, owner)?)
}

fn restore_observation(owner: &Arc<LoginConnection>, observation: CardObservation) -> Result<(), String> {
    let CardObservation::Supported(cards) = observation else {
        return Ok(());
    };
    // Reserve reconstruction before mutating delivery so admission failure cannot
    // leave imported cards without a reconstruction request.
    let mut reconstruction = owner.notification_reconstruction.try_lock().map_err(|_| "notification restoration already running")?;
    if reconstruction.is_some() {
        return Err("notification restoration already scheduled".into());
    }
    let candidates = {
        let mut delivery = owner.notification_delivery.lock().map_err(|_| "notification state poisoned")?;
        delivery.import_cards(cards).map_err(str::to_owned)?;
        delivery.reconstruction_candidates()
    };
    *reconstruction = Some(candidates);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::delivery::{ObservedCard, PlatformHandle};

    fn owner() -> Arc<LoginConnection> {
        LoginConnection::preparing(
            crate::login_session_store::LoginSessionId::try_from(uuid::Uuid::new_v4().to_string()).unwrap(),
            rusqlite::Connection::open_in_memory().unwrap(),
        )
    }

    fn card() -> ObservedCard {
        let id = uuid::Uuid::new_v4().to_string();
        ObservedCard {
            target: 7.into(),
            notification_id: id.clone(),
            handle: PlatformHandle::Macos { identifier: id },
        }
    }

    #[test]
    fn unsupported_does_not_schedule_an_empty_reconstruction() {
        let owner = owner();
        restore_observation(&owner, CardObservation::Unsupported).unwrap();
        assert!(owner.notification_reconstruction.try_lock().unwrap().is_none());
    }

    #[test]
    fn supported_empty_observation_schedules_reconstruction() {
        let owner = owner();
        restore_observation(&owner, CardObservation::Supported(vec![])).unwrap();
        assert_eq!(*owner.notification_reconstruction.try_lock().unwrap(), Some(vec![]));
    }

    #[test]
    fn imports_observed_identity_and_schedules_it_once() {
        let owner = owner();
        let card = card();
        let expected = vec![(card.target, card.notification_id.clone())];
        restore_observation(&owner, CardObservation::Supported(vec![card])).unwrap();
        assert_eq!(*owner.notification_reconstruction.try_lock().unwrap(), Some(expected.clone()));
        assert_eq!(owner.notification_delivery.lock().unwrap().reconstruction_candidates(), expected);
        assert!(restore_observation(&owner, CardObservation::Supported(vec![])).is_err());
    }

    #[test]
    fn busy_reconstruction_does_not_partially_import_cards() {
        let owner = owner();
        let _busy = owner.notification_reconstruction.try_lock().unwrap();
        assert!(restore_observation(&owner, CardObservation::Supported(vec![card()])).is_err());
        assert!(owner.notification_delivery.lock().unwrap().reconstruction_candidates().is_empty());
    }
}
