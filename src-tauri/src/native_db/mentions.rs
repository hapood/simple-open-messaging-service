//! Native mention page ownership. The server selects a bounded roster page; each
//! fixed profile reference owns an independent consumer of the shared demand pipeline.
use super::{attention::FeedIntent, contacts, profile_avatars, profile_subscriptions};
#[cfg(target_os = "android")]
use crate::ServerSessionState;
use futures_util::{stream::FuturesUnordered, StreamExt};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RosterMember {
    account: String,
    publisher_namespace_id: i64,
    profile_namespace_id: i64,
    profile_rev: i64,
}

#[derive(Deserialize)]
struct RosterResponse {
    code: i64,
    data: Option<RosterPage>,
}

#[derive(Deserialize)]
struct RosterPage {
    items: Vec<RosterMember>,
}

async fn query_roster(
    intent: &mut FeedIntent,
    thread_id: i64,
    query: &str,
    take: usize,
) -> Result<Vec<RosterMember>, String> {
    let mut body = json!({"threadId":thread_id,"take":take,"excludeSelf":true});
    if !query.trim().is_empty() {
        body["search"] = json!(query.trim());
    }
    // Suggestions select only the first bounded page. The server owns filtering,
    // ordering and self exclusion; a nextCursor does not trigger a roster drain.
    let response = intent
        .post_query(
            "/api/v1/group/members".into(),
            serde_json::to_vec(&body).map_err(|e| e.to_string())?,
        )
        .await?;
    if !(200..300).contains(&response.status) {
        return Err(format!("mention roster HTTP {}", response.status));
    }
    let envelope: RosterResponse =
        serde_json::from_str(&response.body).map_err(|e| format!("decode mention roster: {e}"))?;
    if envelope.code != 0 {
        return Err(format!("mention roster error {}", envelope.code));
    }
    let page = envelope.data.ok_or("missing mention roster page")?;
    if page.items.len() > take
        || page.items.iter().any(|member| {
            member.account.trim().is_empty()
                || [
                    member.publisher_namespace_id,
                    member.profile_namespace_id,
                    member.profile_rev,
                ]
                .iter()
                .any(|coordinate| !(0..=9_007_199_254_740_991).contains(coordinate))
        })
    {
        return Err("invalid mention roster page".into());
    }
    Ok(page.items)
}

pub(crate) trait Sink: Send + Sync {
    fn results(&self, context: i64, request: i64, metadata: String, avatars: Vec<Vec<u8>>);
}
pub(crate) struct Owner {
    sink: Arc<dyn Sink>,
    generation: AtomicU64,
    active: Mutex<Option<CancellationToken>>,
}
impl Owner {
    pub(crate) fn new(sink: Arc<dyn Sink>) -> Arc<Self> {
        Arc::new(Self {
            sink,
            generation: AtomicU64::new(0),
            active: Mutex::new(None),
        })
    }
    pub(crate) fn cancel(&self) {
        if let Ok(mut active) = self.active.lock() {
            self.generation.fetch_add(1, Ordering::AcqRel);
            if let Some(cancel) = active.take() {
                cancel.cancel();
            }
        }
    }
    #[cfg(target_os = "android")]
    pub(crate) fn query(
        self: &Arc<Self>,
        proxy: &ServerSessionState,
        user_id: i64,
        thread_id: i64,
        context: i64,
        request: i64,
        query: String,
        all_label: String,
    ) -> Result<(), String> {
        let intent = match FeedIntent::capture(proxy, user_id) {
            Ok(intent) => intent,
            Err(error) => {
                self.cancel();
                return Err(error);
            }
        };
        self.start(intent, thread_id, context, request, query, all_label)
    }

    fn start(
        self: &Arc<Self>,
        intent: FeedIntent,
        thread_id: i64,
        context: i64,
        request: i64,
        query: String,
        all_label: String,
    ) -> Result<(), String> {
        let cancel = CancellationToken::new();
        let generation = {
            let mut active = self.active.lock().map_err(|_| "mention owner poisoned")?;
            if let Some(previous) = active.replace(cancel.clone()) {
                previous.cancel();
            }
            self.generation.fetch_add(1, Ordering::AcqRel) + 1
        };
        let owner = self.clone();
        tauri::async_runtime::spawn(async move {
            let lifetime = intent.work.cancellation();
            tokio::select! { biased;
                _ = cancel.cancelled() => {},
                _ = lifetime.cancelled() => {},
                result = owner.run(intent.clone(), generation, thread_id, context, request, query, all_label) => {
                    if let Err(error) = result {
                        log::warn!("native mention page: {error}");
                        let _ = owner.publish(&intent, generation, context, request, &[]).await;
                    }
                }
            }
        });
        Ok(())
    }
    async fn run(
        &self,
        intent: FeedIntent,
        generation: u64,
        thread_id: i64,
        context: i64,
        request: i64,
        query: String,
        all_label: String,
    ) -> Result<(), String> {
        let mut intent = intent;
        let user_id = intent.user_id;
        let role: Option<String> = intent
            .db(move |conn| {
                conn.query_row(
                    "SELECT role FROM threads
                     WHERE user_id=?1 AND thread_id=?2 AND kind='GROUP'",
                    params![user_id, thread_id],
                    |row| row.get(0),
                )
                .map_err(|e| format!("read mention thread: {e}"))
            })
            .await?;
        let include_all = matches!(role.as_deref(), Some("OWNER" | "ADMIN"))
            && all_label
                .to_lowercase()
                .contains(&query.trim().to_lowercase());
        let members = query_roster(
            &mut intent,
            thread_id,
            &query,
            if include_all { 4 } else { 5 },
        )
        .await?;
        let (mut items, references) = intent
            .db(move |conn| {
                let mut items = Vec::new();
                let mut references = Vec::new();
                if include_all {
                    items.push(json!({"kind":"all","id":"somfp:audience:all","label":all_label}));
                }
                for member in members {
                    let account = member.account;
                    let namespace = member.profile_namespace_id;
                    let publisher = member.publisher_namespace_id;
                    let rev = member.profile_rev;
                    let profile =
                        contacts::read_profile(conn, user_id, publisher, namespace, &account, rev)?;
                    let name = profile
                        .as_ref()
                        .and_then(|value| value["name"].as_str())
                        .filter(|name| !name.is_empty())
                        .unwrap_or(&account);
                    let index = items.len();
                    items.push(
                        json!({"kind":"user","id":format!("{namespace}/{account}"),"label":name,
                    "colorSeed":format!("{publisher}/{namespace}/{account}"),
                    "avatarDigest":profile.as_ref().and_then(|value| value.get("avatarDigest"))}),
                    );
                    if rev > 0 {
                        references.push((
                            index,
                            json!({"publisherNamespaceId":publisher,
                        "lookup":"ACCOUNT_PROFILE",
                        "target":{"profileNamespaceId":namespace,"account":account,"rev":rev}}),
                        ));
                    }
                }
                Ok((items, references))
            })
            .await?;
        // These server-selected coordinates stay pinned for this page's lifetime.
        // Only another search chooses new candidates or revisions.
        self.publish(&intent, generation, context, request, &items)
            .await?;
        let mut pending = FuturesUnordered::new();
        for (index, demand) in references {
            let subscription = profile_subscriptions::subscribe(intent.clone(), demand)?;
            pending.push(async move { (index, subscription.ready().await) });
        }
        while let Some((index, result)) = pending.next().await {
            match result {
                Ok(profile) => {
                    if let Some(name) = profile["name"].as_str().filter(|name| !name.is_empty()) {
                        items[index]["label"] = json!(name);
                    }
                    items[index]["avatarDigest"] = profile["avatarDigest"].clone();
                    self.publish(&intent, generation, context, request, &items)
                        .await?;
                }
                // An unavailable profile keeps its cached/fallback row and does
                // not prevent another member's presentation from completing.
                Err(error) => log::warn!("native mention item: {error}"),
            }
        }
        Ok(())
    }
    async fn publish(
        &self,
        intent: &FeedIntent,
        generation: u64,
        context: i64,
        request: i64,
        items: &[Value],
    ) -> Result<(), String> {
        let mut items = items.to_vec();
        let user_id = intent.user_id;
        let login_session_id = intent.work.owner().id().to_string();
        let (metadata, avatars) = super::spawn_owned_work(intent.work.clone(), move || {
            let mut avatars = profile_avatars::AvatarBatch::default();
            for item in &mut items {
                let digest = item.as_object_mut().unwrap().remove("avatarDigest");
                if let Some(digest) = digest.as_ref().and_then(Value::as_str) {
                    match avatars.index(user_id, digest) {
                        Ok(Some(index)) => item["avatarIndex"] = json!(index),
                        Ok(None) => {}
                        Err(error) => log::warn!("native mention avatar: {error}"),
                    }
                }
            }
            Ok((
                json!({"items":items,"loginSessionId":login_session_id}).to_string(),
                avatars.bytes,
            ))
        })
        .await
        .map_err(|e| format!("join mention avatars: {e}"))??;
        intent.work.assert_current().map_err(|e| e.to_string())?;
        if self.generation.load(Ordering::Acquire) == generation {
            self.sink.results(context, request, metadata, avatars);
        }
        Ok(())
    }
}

#[cfg(target_os = "android")]
mod android;

#[cfg(test)]
#[path = "../tests/native_mention_tests.rs"]
mod tests;
