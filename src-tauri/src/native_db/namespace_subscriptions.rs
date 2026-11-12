//! Shared native namespace-binding watch consumers. Dropping one consumer
//! never cancels another; the last consumer releases the resolve flight and
//! the wake subscription. Unlike a profile, a namespace binding is mutable
//! (expiry flips, domains rebind), so a flight keeps running after its first
//! READY emission and re-emits guarded updates on change-feed wakes.
use super::attention::FeedIntent;
use super::lru::RecencyLru;
use super::profile_namespaces::{
    commit_bindings, read_bindings, write_namespace_tomb, ProfileNamespaceBinding,
    ProfileNamespaceEntry, ProfileNamespacePair,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;
use tokio::sync::{broadcast, watch};

/** Business code for a permanently lost namespace binding (HTTP 200). */
const NAMESPACE_UNRECOVERABLE: i32 = 50032;
/** How long a PENDING resolve round suppresses re-requests. The server planted
 *  a tomb and scheduled a refresh; a wake normally converges the row first and
 *  the deadline only covers a lost wake. */
const PENDING_TTL: Duration = Duration::from_millis(30_000);

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum NamespaceWatch {
    #[serde(rename = "empty")]
    Empty,
    #[serde(rename = "ready")]
    Ready { binding: ProfileNamespaceBinding },
    #[serde(rename = "unrecoverable")]
    Unrecoverable,
    #[serde(rename = "failed")]
    Failed { reason: String },
}

impl NamespaceWatch {
    /// Terminal states end both the flight task and IPC forwarders.
    pub(super) fn is_terminal(&self) -> bool {
        matches!(
            self,
            NamespaceWatch::Failed { .. } | NamespaceWatch::Unrecoverable
        )
    }
}

#[derive(Deserialize)]
struct ResolveEnvelope {
    code: i32,
    data: Option<Value>,
}

enum RoundOutcome {
    /// A READY answer was committed; the next read emits it.
    Committed,
    /// The server planted a tomb and scheduled a refresh.
    Pending,
    /// The binding is permanently lost; the tomb is already durable.
    Unrecoverable,
}

struct Flight {
    result: watch::Sender<NamespaceWatch>,
    intent: FeedIntent,
}

type Wake = (i64, Vec<ProfileNamespacePair>);

static FLIGHTS: OnceLock<Mutex<HashMap<String, Weak<Flight>>>> = OnceLock::new();
static WAKES: OnceLock<broadcast::Sender<Wake>> = OnceLock::new();
/** Capacity mirrors the web repository: one binding per rendered identity pair. */
static LRU: OnceLock<Mutex<RecencyLru<ProfileNamespaceBinding>>> = OnceLock::new();

fn lru() -> &'static Mutex<RecencyLru<ProfileNamespaceBinding>> {
    LRU.get_or_init(|| Mutex::new(RecencyLru::new(100)))
}

/// Change-feed drains (and any future native writer) report converged pairs
/// here; every live flight for a pair re-reads its row and re-emits guarded.
pub(crate) fn wake(user_id: i64, pairs: &[ProfileNamespacePair]) {
    if pairs.is_empty() {
        return;
    }
    let _ = WAKES
        .get_or_init(|| broadcast::channel(256).0)
        .send((user_id, pairs.to_vec()));
}

pub(super) struct WatchSubscription {
    key: String,
    _flight: Arc<Flight>,
    receiver: Option<watch::Receiver<NamespaceWatch>>,
}
impl Drop for WatchSubscription {
    fn drop(&mut self) {
        // Remove the last consumer's registry entry before closing its
        // receiver, so a simultaneous replacement cannot attach to an
        // already-canceling flight. Other drops and new subscriptions use the
        // same registry lock; the receiver count decrements after the check.
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
            drop(receiver);
        }
    }
}
impl WatchSubscription {
    /// Current state, marking it seen. The first observed value is `Empty`
    /// (or `Ready` on a local cache hit) before any network round completes.
    pub(super) fn state(&mut self) -> NamespaceWatch {
        self.receiver
            .as_mut()
            .expect("live namespace consumer")
            .borrow_and_update()
            .clone()
    }

    /// Resolves when the state advances; false when the flight ended.
    pub(super) async fn changed(&mut self) -> bool {
        match self
            .receiver
            .as_mut()
            .expect("live namespace consumer")
            .changed()
            .await
        {
            Ok(()) => true,
            Err(_) => false,
        }
    }

    /// Attach to (or create) the shared flight for one pair and observe its
    /// first settled state, bounded by the PENDING window. Dropping the
    /// returned subscription releases the shared flight when it is the last
    /// consumer — the change-feed drain uses this to warm undemanded pairs
    /// without keeping them alive.
    pub(super) async fn first_settled(mut self, timeout: Duration) -> NamespaceWatch {
        let state = self.state();
        if state.is_terminal() || matches!(state, NamespaceWatch::Ready { .. }) {
            return state;
        }
        let _ = tokio::time::timeout(timeout, async {
            loop {
                if !self.changed().await {
                    return;
                }
                let state = self.state();
                if state.is_terminal() || matches!(state, NamespaceWatch::Ready { .. }) {
                    return;
                }
            }
        })
        .await;
        self.state()
    }
}

fn pair_key(
    owner: &crate::login_session_store::LoginSessionId,
    pair: &ProfileNamespacePair,
) -> String {
    format!(
        "{owner}:{}:{}",
        pair.publisher_namespace_id, pair.profile_namespace_id
    )
}

pub(super) fn watch(
    intent: FeedIntent,
    pair: ProfileNamespacePair,
) -> Result<WatchSubscription, String> {
    intent.work.assert_current().map_err(|e| e.to_string())?;
    if pair.publisher_namespace_id < 0 || pair.profile_namespace_id < 0 {
        return Err("profile namespace pair must be non-negative".into());
    }
    let key = pair_key(intent.work.owner().id(), &pair);
    if let Ok(mut lru) = lru().lock() {
        if let Some(binding) = lru.get(&key).filter(|binding| !binding.expired) {
            // A local cache hit answers synchronously: a detached cell,
            // never registered, never cancelled, no flight, no network.
            let (result, receiver) = watch::channel(NamespaceWatch::Ready { binding });
            let flight = Arc::new(Flight { result, intent });
            return Ok(WatchSubscription {
                key,
                _flight: flight,
                receiver: Some(receiver),
            });
        }
    }
    let mut flights = FLIGHTS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "namespace subscription registry poisoned")?;
    flights.retain(|_, flight| flight.strong_count() > 0);
    if let Some(flight) = flights
        .get(&key)
        .and_then(Weak::upgrade)
        .filter(|flight| flight.intent.work.assert_current().is_ok())
    {
        let receiver = flight.result.subscribe();
        return Ok(WatchSubscription {
            key,
            _flight: flight,
            receiver: Some(receiver),
        });
    }
    let (result, receiver) = watch::channel(NamespaceWatch::Empty);
    let flight = Arc::new(Flight {
        result,
        intent: intent.clone(),
    });
    flights.insert(key.clone(), Arc::downgrade(&flight));
    let work = flight.clone();
    // Subscribe before the first round so a wake landing between the resolve
    // answer and the wait cannot be lost.
    let mut wakes = WAKES.get_or_init(|| broadcast::channel(256).0).subscribe();
    tauri::async_runtime::spawn(async move {
        let user_id = work.intent.user_id;
        let cancellation = work.intent.work.cancellation();
        let resolve = async {
            let flight_pair = pair.clone();
            // Coordinates of the last emission; an incoming row may replace it
            // only when both change-feed and publisher-feed coordinates are
            // greater than or equal (equal allows a display refresh).
            let mut last: Option<(i64, i64)> = None;
            loop {
                let read_pair = flight_pair.clone();
                let row = work
                    .intent
                    .db(move |conn| read_bindings(conn, user_id, &[read_pair]))
                    .await?
                    .into_iter()
                    .next();
                match row {
                    Some(binding) if !binding.expired => {
                        let stale = last.is_some_and(|(change_seq, update_feed_id)| {
                            binding.change_seq < change_seq
                                || binding.update_feed_id < update_feed_id
                        });
                        if !stale {
                            last = Some((binding.change_seq, binding.update_feed_id));
                            if let Ok(mut lru) = lru().lock() {
                                lru.insert(
                                    pair_key(work.intent.work.owner().id(), &flight_pair),
                                    binding.clone(),
                                );
                            }
                            work.result.send_replace(NamespaceWatch::Ready { binding });
                        }
                        // Healthy binding — idle until a change-feed wake.
                        if !wait_for_wake(&work.result, &mut wakes, user_id, &flight_pair, None)
                            .await
                        {
                            return Ok(());
                        }
                        continue;
                    }
                    // Missing or expired — resolve through the server. The
                    // round coordinate is the row's changeSeq at read time (0
                    // when absent): a wake landing mid-flight advances the row
                    // past this value and the commit guard drops the answer.
                    _ => {
                        let round_end = row.map(|binding| binding.change_seq).unwrap_or(0);
                        let mut round_intent = work.intent.clone();
                        match resolve_round(&mut round_intent, user_id, &flight_pair, round_end)
                            .await?
                        {
                            RoundOutcome::Committed => continue,
                            RoundOutcome::Pending => {
                                if !wait_for_wake(
                                    &work.result,
                                    &mut wakes,
                                    user_id,
                                    &flight_pair,
                                    Some(PENDING_TTL),
                                )
                                .await
                                {
                                    return Ok(());
                                }
                                continue;
                            }
                            RoundOutcome::Unrecoverable => {
                                work.result.send_replace(NamespaceWatch::Unrecoverable);
                                return Ok(());
                            }
                        }
                    }
                }
            }
        };
        let result = tokio::select! { biased;
            _ = cancellation.cancelled() => {
                work.result.send_replace(NamespaceWatch::Failed {
                    reason: "namespace subscription session expired".into(),
                });
                return;
            }
            _ = work.result.closed() => return,
            result = resolve => result,
        };
        if let Err(reason) = result {
            work.result.send_replace(NamespaceWatch::Failed { reason });
        }
    });
    Ok(WatchSubscription {
        key,
        _flight: flight,
        receiver: Some(receiver),
    })
}

/// Wait until a change-feed wake touches this pair. Returns false when the
/// flight should end (all receivers dropped or the wake channel closed). A
/// bounded channel overflow (`Lagged`) returns true: the durable row is the
/// authority and a re-read loses nothing.
async fn wait_for_wake(
    sender: &watch::Sender<NamespaceWatch>,
    wakes: &mut broadcast::Receiver<Wake>,
    user_id: i64,
    pair: &ProfileNamespacePair,
    timeout: Option<Duration>,
) -> bool {
    let deadline = timeout.map(|ttl| tokio::time::Instant::now() + ttl);
    loop {
        let wait = wakes.recv();
        tokio::pin!(wait);
        tokio::select! { biased;
            _ = sender.closed() => return false,
            _ = async {
                match deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending::<()>().await,
                }
            } => return true,
            received = &mut wait => match received {
                Ok((wake_user, pairs))
                    if wake_user == user_id
                        && pairs.iter().any(|item| {
                            item.publisher_namespace_id == pair.publisher_namespace_id
                                && item.profile_namespace_id == pair.profile_namespace_id
                        }) =>
                {
                    return true
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => return true,
                Err(broadcast::error::RecvError::Closed) => return false,
            }
        }
    }
}

/// One authorized resolve round for a pair: READY answers commit durably,
/// PENDING answers wait for a wake, and an unrecoverable answer writes the
/// permanent tomb. The round coordinate guards against a wake that advanced
/// the row while the request was in flight.
async fn resolve_round(
    intent: &mut FeedIntent,
    user_id: i64,
    pair: &ProfileNamespacePair,
    round_end: i64,
) -> Result<RoundOutcome, String> {
    let body = serde_json::to_vec(pair).map_err(|e| e.to_string())?;
    let response = intent
        .post_query("/api/v1/profile-namespaces/resolve".into(), body)
        .await?;
    if !(200..300).contains(&response.status) {
        return Err(format!(
            "profile-namespace resolve HTTP {}",
            response.status
        ));
    }
    let envelope: ResolveEnvelope = serde_json::from_str(&response.body)
        .map_err(|e| format!("decode profile-namespace resolve response: {e}"))?;
    if envelope.code == NAMESPACE_UNRECOVERABLE {
        let tomb_pair = pair.clone();
        intent
            .db(move |conn| write_namespace_tomb(conn, user_id, &tomb_pair, super::chrono_millis()))
            .await?;
        return Ok(RoundOutcome::Unrecoverable);
    }
    if envelope.code != 0 {
        return Err(format!(
            "profile-namespace resolve business code {}",
            envelope.code
        ));
    }
    let data = envelope
        .data
        .ok_or("missing profile-namespace resolve result")?;
    let status = data.get("status").and_then(Value::as_str);
    if status == Some("PENDING") {
        return Ok(RoundOutcome::Pending);
    }
    if status != Some("READY") {
        return Err("invalid profile-namespace resolve result".into());
    }
    let entry: ProfileNamespaceEntry = serde_json::from_value(
        data.get("entry")
            .cloned()
            .ok_or("profile-namespace resolve answer has no entry")?,
    )
    .map_err(|e| format!("decode profile-namespace entry: {e}"))?;
    if entry.publisher_namespace_id != pair.publisher_namespace_id
        || entry.profile_namespace_id != pair.profile_namespace_id
    {
        return Err("resolved entry does not match pair coordinates".into());
    }
    intent
        .db(move |conn| commit_bindings(conn, user_id, &[entry], round_end, super::chrono_millis()))
        .await?;
    Ok(RoundOutcome::Committed)
}

#[cfg(test)]
#[path = "../tests/native_namespace_subscription_tests.rs"]
pub(super) mod tests;
