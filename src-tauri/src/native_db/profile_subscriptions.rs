//! Shared native demand consumers. Dropping one consumer never cancels another;
//! the last consumer releases the pending request and wake subscription.
use super::attention::{resolve_profile_intent, FeedIntent};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use tokio::sync::{broadcast, watch};

type Outcome = Option<Result<Value, String>>;
struct Flight {
    result: watch::Sender<Outcome>,
    intent: FeedIntent,
}
static FLIGHTS: OnceLock<Mutex<HashMap<String, Weak<Flight>>>> = OnceLock::new();
static WAKES: OnceLock<broadcast::Sender<(i64, String, Value)>> = OnceLock::new();

pub(crate) fn wake(user_id: i64, event: &str, data: &Value) {
    let _ = WAKES.get_or_init(|| broadcast::channel(128).0).send((
        user_id,
        event.to_owned(),
        data.clone(),
    ));
}

pub(super) struct Subscription {
    key: String,
    _flight: Arc<Flight>,
    receiver: Option<watch::Receiver<Outcome>>,
}
impl Drop for Subscription {
    fn drop(&mut self) {
        // Remove the last consumer's registry entry before closing its receiver.
        // A simultaneous replacement must not attach to an already-canceling task.
        let receiver = self.receiver.take();
        if let Ok(mut flights) = FLIGHTS.get_or_init(Default::default).lock() {
            if self._flight.result.receiver_count() == 1
                && flights
                    .get(&self.key)
                    .and_then(Weak::upgrade)
                    .is_some_and(|flight| Arc::ptr_eq(&flight, &self._flight))
            {
                flights.remove(&self.key);
            }
            // Other drops and new subscriptions use the same registry lock.
            // Decrement the receiver count before either can inspect this flight.
            drop(receiver);
        }
    }
}
impl Subscription {
    pub(super) async fn ready(mut self) -> Result<Value, String> {
        loop {
            let receiver = self.receiver.as_mut().expect("live profile consumer");
            if let Some(result) = receiver.borrow_and_update().clone() {
                return result;
            }
            receiver
                .changed()
                .await
                .map_err(|_| "profile subscription closed")?;
        }
    }
}

pub(super) fn subscribe(intent: FeedIntent, request: Value) -> Result<Subscription, String> {
    intent.work.assert_current().map_err(|e| e.to_string())?;
    let key = format!("{}:{}", intent.work.owner().id(), request);
    let mut flights = FLIGHTS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "profile subscription registry poisoned")?;
    flights.retain(|_, flight| flight.strong_count() > 0);
    if let Some(flight) = flights
        .get(&key)
        .and_then(Weak::upgrade)
        .filter(|flight| flight.intent.work.assert_current().is_ok())
    {
        let receiver = flight.result.subscribe();
        return Ok(Subscription {
            key,
            _flight: flight,
            receiver: Some(receiver),
        });
    }
    let (result, receiver) = watch::channel(None);
    let flight = Arc::new(Flight { result, intent });
    flights.insert(key.clone(), Arc::downgrade(&flight));
    let work = flight.clone();
    // Subscribe before the first request so a fast materialization cannot be lost
    // between receiving PENDING and beginning to wait for its wake.
    let mut wakes = WAKES.get_or_init(|| broadcast::channel(128).0).subscribe();
    tauri::async_runtime::spawn(async move {
        let cancellation = work.intent.work.cancellation();
        let resolve = async {
            loop {
                let result = resolve_profile_intent(work.intent.clone(), request.clone()).await?;
                if result["status"] == "READY" {
                    return Ok(result["profile"].clone());
                }
                let pending_key = result.get("key").ok_or("pending profile has no key")?;
                loop {
                    match wakes.recv().await {
                        Ok((user_id, event, data))
                            if user_id == work.intent.user_id && same_key(pending_key, &data) =>
                        {
                            if event == "PROFILE_UNAVAILABLE" {
                                return Err("profile unavailable".into());
                            }
                            break;
                        }
                        Ok(_) => {}
                        // Recheck the durable cache after a bounded channel overflows.
                        Err(broadcast::error::RecvError::Lagged(_)) => break,
                        Err(broadcast::error::RecvError::Closed) => {
                            return Err("profile wake channel closed".into())
                        }
                    }
                }
            }
        };
        let result = tokio::select! { biased;
            _ = cancellation.cancelled() => {
                work.result.send_replace(Some(Err("profile subscription session expired".into())));
                return;
            }
            _ = work.result.closed() => return,
            result = resolve => result,
        };
        let result = work
            .intent
            .work
            .assert_current()
            .map_err(|error| error.to_string())
            .and(result);
        work.result.send_replace(Some(result));
    });
    Ok(Subscription {
        key,
        _flight: flight,
        receiver: Some(receiver),
    })
}

#[cfg(test)]
#[path = "../tests/native_profile_subscription_tests.rs"]
pub(super) mod tests;

fn same_key(a: &Value, b: &Value) -> bool {
    [
        "publisherNamespaceId",
        "profileNamespaceId",
        "account",
        "rev",
    ]
    .iter()
    .all(|field| a.get(*field).is_some() && a.get(*field) == b.get(*field))
}
