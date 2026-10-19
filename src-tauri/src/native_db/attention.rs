use chrono::DateTime;
use log::warn;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use super::client_state::{ClientGroupMetaApply, ClientGroupMetaPage};
use super::messages::{count_unread_message_slots, MessageCountOwner};
use super::{open, parse_json};
use crate::{proxy::perform_api_request_with_events, ServerSessionState};

// All native feed consumers share cursor ownership, including notification wakes.
// This is not the cache lifetime lock: network waits must not block account cleanup.
static THREAD_FEED_SYNC: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// The thread currently open in the UI. Per-thread Group Meta + tombstone drains
// (drain-open mode) check this between pages: switching away lets the current
// page commit, then stops. `None` means no thread is open (stop signal).
static OPEN_THREAD_ID: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

fn open_thread_id() -> Option<i64> {
    let value = OPEN_THREAD_ID.load(std::sync::atomic::Ordering::Acquire);
    (value > 0).then_some(value)
}

/// The serialized shape emitted on the `soms-sse-event` channel for local
/// (non-server) completion notifications. Mirrors `SseEventPayload` in sse.rs.
#[derive(Clone, serde::Serialize)]
struct LocalEventPayload {
    event: String,
    status: i64,
    message: String,
    data: serde_json::Value,
}

/// Drive per-thread Group Meta + tombstone drains (drain-open mode) for the
/// open thread. `thread_id <= 0` is the stop signal: clears `OPEN_THREAD_ID`
/// so in-flight drains stop after the current page commits. A non-null target
/// fires that drain; a null target skips it (e.g. a tombstone-only advance
/// must not touch Group Meta). On completion, emits `LOCAL_GROUP_META_COMMITTED`
/// and a `tombstone-committed`-equivalent event so the renderer refreshes.
#[tauri::command]
pub(crate) async fn native_db_drain_thread_misc(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ServerSessionState>,
    user_id: i64,
    thread_id: i64,
    group_meta_end_id: Option<String>,
    tombstone_end_seq: Option<i64>,
) -> Result<(), String> {
    if user_id <= 0 {
        return Err("invalid user id".into());
    }
    if thread_id <= 0 {
        // Stop signal.
        OPEN_THREAD_ID.store(0, std::sync::atomic::Ordering::Release);
        return Ok(());
    }
    OPEN_THREAD_ID.store(thread_id, std::sync::atomic::Ordering::Release);
    let epoch = super::lifetime::CACHE_LIFETIME.capture()?;
    // Fire both drains concurrently; they share the `OPEN_THREAD_ID` guard.
    let group_meta_app = app.clone();
    let group_meta_events = crate::realtime::NativeEvents::capture(Some(&app));
    let group_meta_proxy = proxy.inner().clone();
    let group_meta_task = tokio::spawn(async move {
        if let Some(_target) = group_meta_end_id {
            // The drain target lives in the threads table (group_meta_feed_end_id),
            // refreshed by the preceding thread-feed commit, so the caller's target
            // is redundant — `sync_group_meta_thread` reads it from `group_meta_plans`.
            let (changed, patches, error) = sync_group_meta_thread(
                Some(&group_meta_app),
                &group_meta_proxy,
                user_id,
                thread_id,
                epoch,
            )
            .await;
            // Deliver committed pages even when a later page or profile
            // reference failed; the persisted cursor already advanced.
            if !changed.is_empty() {
                let _ = group_meta_events.emit(
                    "soms-sse-event",
                    LocalEventPayload {
                        event: "LOCAL_GROUP_META_COMMITTED".into(),
                        status: 0,
                        message: "local group meta committed".into(),
                        data: serde_json::json!({
                            "userId": user_id,
                            "threadIds": changed,
                            "patches": patches,
                        }),
                    },
                );
            }
            if let Some(error) = error {
                warn!("group-meta per-thread drain failed; next wake retries: {error}");
            }
        }
    });
    let tombstone_app = app.clone();
    let tombstone_events = crate::realtime::NativeEvents::capture(Some(&app));
    let tombstone_proxy = proxy.inner().clone();
    let tombstone_task = tokio::spawn(async move {
        if let Some(target) = tombstone_end_seq {
            match sync_tombstone_thread(
                Some(&tombstone_app),
                &tombstone_proxy,
                user_id,
                thread_id,
                target,
                epoch,
            )
            .await
            {
                Ok(committed) if !committed.is_empty() => {
                    let _ = tombstone_events.emit(
                        "soms-sse-event",
                        LocalEventPayload {
                            event: "LOCAL_TOMBSTONE_COMMITTED".into(),
                            status: 0,
                            message: "local tombstone committed".into(),
                            data: serde_json::json!({
                                "userId": user_id,
                                "threadId": thread_id,
                                "tombstones": committed.iter().map(|item| serde_json::json!({
                                    "seq": item.get("messageSeq").and_then(Value::as_i64).unwrap_or(0),
                                    "type": item.get("type").and_then(Value::as_str).unwrap_or(""),
                                })).collect::<Vec<_>>(),
                            }),
                        },
                    );
                }
                Ok(_) => {}
                Err(error) => {
                    warn!("tombstone per-thread drain failed; next wake retries: {error}")
                }
            }
        }
    });
    let _ = tokio::join!(group_meta_task, tombstone_task);
    Ok(())
}

fn feed_request(cursor: i32, through: i32) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&serde_json::json!({
        "after": cursor, "through": through, "take": 100, "previewCount": 3,
    }))
    .map_err(|e| format!("encode thread feed request: {e}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadFeedPage {
    items: Vec<ThreadFeedSnapshot>,
    scanned_through: i32,
    through: i32,
    thread_feed_end_id: i32,
    has_more: bool,
}

#[derive(Deserialize)]
struct ThreadFeedResponse {
    code: i32,
    data: Option<ThreadFeedPage>,
}

#[derive(Deserialize)]
struct GroupMetaResponse {
    code: i32,
    data: Option<Value>,
}

fn commit_resolved_profile(
    conn: &Connection,
    user_id: i64,
    profile: &Value,
) -> Result<Value, String> {
    let publisher_namespace_id = profile
        .get("publisherNamespaceId")
        .and_then(Value::as_i64)
        .ok_or("resolved profile has no publisher namespace")?;
    let profile_namespace_id = profile
        .get("profileNamespaceId")
        .and_then(Value::as_i64)
        .ok_or("resolved profile has no profile namespace")?;
    let account = profile
        .get("account")
        .and_then(Value::as_str)
        .ok_or("resolved profile has no account")?;
    let domain = super::profile_namespaces::display_domain(
        conn,
        user_id,
        publisher_namespace_id,
        profile_namespace_id,
    )?
    .unwrap_or_default();
    let profile_rev = profile
        .get("rev")
        .and_then(Value::as_i64)
        .ok_or("resolved profile has no revision")?;
    let name = profile
        .get("name")
        .and_then(Value::as_str)
        .ok_or("resolved profile has no name")?;
    let bio = profile
        .get("bio")
        .and_then(Value::as_str)
        .ok_or("resolved profile has no bio")?;
    let avatar_digest =
        super::profile_avatars::save(user_id, profile.get("avatarBase64").and_then(Value::as_str))?;
    let snapshot = serde_json::json!({
        "publisherNamespaceId": publisher_namespace_id,
        "account": account,
        "domain": domain,
        "namespaceId": profile_namespace_id,
        "profileNamespaceId": profile_namespace_id,
        "profileRev": profile_rev,
        "name": name,
        "avatarDigest": avatar_digest,
        "bio": bio,
    });
    super::contacts::write_profile(conn, user_id, &snapshot)?;
    Ok(snapshot)
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileTarget {
    profile_namespace_id: i64,
    account: String,
    rev: i64,
}

#[derive(Deserialize)]
#[serde(tag = "lookup", deny_unknown_fields)]
enum ProfileDemand {
    #[serde(rename = "ACCOUNT_PROFILE")]
    Account {
        #[serde(rename = "publisherNamespaceId")]
        publisher_namespace_id: i64,
        target: ProfileTarget,
    },
    #[serde(rename = "GROUP_MEMBER_PROFILE")]
    GroupMember {
        #[serde(rename = "publisherNamespaceId")]
        publisher_namespace_id: i64,
        target: ProfileTarget,
        #[serde(rename = "groupAccount")]
        group_account: String,
    },
}

#[derive(Clone)]
struct ProfileCacheKey {
    publisher_namespace_id: i64,
    target: ProfileTarget,
}

fn parse_profile_request(request: &Value) -> Result<(ProfileCacheKey, bool), String> {
    let object = request
        .as_object()
        .ok_or("profile request must be an object")?;
    let (demand, no_evidence) = if let Some(demand) = object.get("demand") {
        if object.len() != 2 || object.get("evidence") != Some(&Value::Null) {
            return Err("invalid unevidenced profile request".into());
        }
        (demand, true)
    } else {
        (request, false)
    };
    let parsed: ProfileDemand = serde_json::from_value(demand.clone())
        .map_err(|e| format!("invalid profile demand: {e}"))?;
    let (publisher_namespace_id, target) = match parsed {
        ProfileDemand::Account {
            publisher_namespace_id,
            target,
        } => (publisher_namespace_id, target),
        ProfileDemand::GroupMember {
            publisher_namespace_id,
            target,
            group_account,
        } => {
            if group_account.trim().is_empty() {
                return Err("profile demand has no group account".into());
            }
            (publisher_namespace_id, target)
        }
    };
    if publisher_namespace_id < 0
        || target.profile_namespace_id < 0
        || publisher_namespace_id > 9_007_199_254_740_991
        || target.profile_namespace_id > 9_007_199_254_740_991
        || target.rev < 1
        || target.rev > 9_007_199_254_740_991
        || target.account.trim().is_empty()
    {
        return Err("invalid profile coordinates".into());
    }
    Ok((
        ProfileCacheKey {
            publisher_namespace_id,
            target,
        },
        no_evidence,
    ))
}

fn find_profile_for_key(
    conn: &Connection,
    user_id: i64,
    key: &ProfileCacheKey,
) -> Result<Option<Value>, String> {
    let payload: Option<String> = conn
        .query_row(
            "SELECT json_object('publisherNamespaceId',profile.publisher_namespace_id,
           'account',profile.account,
           'domain',COALESCE((SELECT domain FROM profile_namespaces binding
             WHERE binding.user_id=profile.user_id
               AND binding.publisher_namespace_id=profile.publisher_namespace_id
               AND binding.profile_namespace_id=profile.profile_namespace_id),''),
           'namespaceId',profile.profile_namespace_id,
           'profileNamespaceId',profile.profile_namespace_id,
           'profileRev',profile.profile_rev,
           'name',profile.name,'avatarDigest',profile.avatar_digest,'bio',profile.bio)
         FROM profiles profile
         WHERE profile.user_id=?1 AND profile.publisher_namespace_id=?2
           AND profile.profile_namespace_id=?3 AND profile.account=?4
           AND profile.profile_rev=?5",
            params![
                user_id,
                key.publisher_namespace_id,
                key.target.profile_namespace_id,
                key.target.account,
                key.target.rev
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("read cached profile: {e}"))?;
    payload.map(parse_json).transpose()
}

async fn handle_profile_error(
    user_id: i64,
    epoch: u64,
    key: &ProfileCacheKey,
    code: i32,
) -> Result<(), String> {
    if code == 0 {
        return Ok(());
    }
    // Permanent loss is sparse: the tomb covers the identity across all revisions.
    if code == 50033 {
        let tomb = serde_json::from_value(serde_json::json!({
            "publisherNamespaceId": key.publisher_namespace_id,
            "profileNamespaceId": key.target.profile_namespace_id,
            "account": key.target.account,
        }))
        .map_err(|e| format!("invalid profile tomb key: {e}"))?;
        super::lifetime::spawn_at(Ok(epoch), move || {
            super::profile_namespaces::write_profile_tomb(
                &open()?,
                user_id,
                &tomb,
                super::client_state::chrono_millis(),
            )
        })
        .await
        .map_err(|e| format!("join profile tomb write: {e}"))??;
        return Err("profile permanently lost (UNRECOVERABLE)".into());
    }
    Err("profile resolution failed".into())
}

#[tauri::command]
pub(crate) async fn native_profile_resolve(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ServerSessionState>,
    user_id: i64,
    request: Value,
) -> Result<Value, String> {
    resolve_profile(Some(&app), &proxy, user_id, request).await
}

async fn resolve_profile(
    app: Option<&tauri::AppHandle>,
    proxy: &ServerSessionState,
    user_id: i64,
    request: Value,
) -> Result<Value, String> {
    if user_id <= 0 {
        return Err("invalid profile resolution request".into());
    }
    let (key, no_evidence) = parse_profile_request(&request)?;
    let epoch = super::lifetime::CACHE_LIFETIME.capture()?;
    let cached_key = key.clone();
    if let Some(profile) = super::lifetime::spawn_at(Ok(epoch), move || {
        find_profile_for_key(&open()?, user_id, &cached_key)
    })
    .await
    .map_err(|e| format!("join cached profile lookup: {e}"))??
    {
        return Ok(serde_json::json!({ "status": "READY", "profile": profile }));
    }
    let response = perform_api_request_with_events(
        app,
        proxy,
        "POST".into(),
        "/api/v1/user/profile-resolution".into(),
        std::collections::HashMap::from([("content-type".into(), "application/json".into())]),
        Some(serde_json::to_vec(&request).map_err(|e| e.to_string())?),
        true,
    )
    .await?;
    if !(200..300).contains(&response.status) {
        return Err(format!("profile-resolution HTTP {}", response.status));
    }
    let envelope: GroupMetaResponse = serde_json::from_str(&response.body)
        .map_err(|e| format!("decode profile-resolution response: {e}"))?;
    handle_profile_error(user_id, epoch, &key, envelope.code).await?;
    let data = envelope.data.ok_or("missing profile-resolution result")?;
    if data.get("status").and_then(Value::as_str) == Some("PENDING") {
        if no_evidence {
            return Err("unevidenced profile lookup must not return PENDING".into());
        }
        return Ok(data);
    }
    if data.get("status").and_then(Value::as_str) != Some("READY") {
        return Err("invalid profile-resolution result".into());
    }
    let profile = data
        .get("profile")
        .cloned()
        .ok_or("missing resolved profile")?;
    let committed = super::lifetime::spawn_at(Ok(epoch), move || {
        commit_resolved_profile(&open()?, user_id, &profile)
    })
    .await
    .map_err(|e| format!("join resolved profile commit: {e}"))??;
    Ok(serde_json::json!({ "status": "READY", "profile": committed }))
}

pub(crate) async fn materialize_profile_event(
    app: Option<&tauri::AppHandle>,
    proxy: &ServerSessionState,
    user_id: i64,
    key: &Value,
) -> Result<(), String> {
    let publisher_namespace_id = key
        .get("publisherNamespaceId")
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0)
        .ok_or("profile event has no publisher namespace")?;
    let profile_namespace_id = key
        .get("profileNamespaceId")
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0)
        .ok_or("profile event has no profile namespace")?;
    let account = key
        .get("account")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("profile event has no account")?;
    let rev = key
        .get("rev")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .ok_or("profile event has no revision")?;
    let result = resolve_profile(
        app,
        proxy,
        user_id,
        serde_json::json!({
            "demand": {
                "publisherNamespaceId": publisher_namespace_id,
                "lookup": "ACCOUNT_PROFILE",
                "target": {
                    "profileNamespaceId": profile_namespace_id,
                    "account": account,
                    "rev": rev,
                },
            },
            "evidence": null,
        }),
    )
    .await?;
    if result.get("status").and_then(Value::as_str) != Some("READY") {
        return Err("profile event did not resolve from backend cache".into());
    }
    let profile = result
        .get("profile")
        .ok_or("resolved profile event has no profile")?;
    if profile.get("publisherNamespaceId").and_then(Value::as_i64) != Some(publisher_namespace_id)
        || profile.get("profileNamespaceId").and_then(Value::as_i64) != Some(profile_namespace_id)
        || profile.get("account").and_then(Value::as_str) != Some(account)
        || profile.get("profileRev").and_then(Value::as_i64) != Some(rev)
    {
        return Err("resolved profile does not match profile event key".into());
    }
    Ok(())
}

struct GroupMetaPlan {
    thread_id: i64,
    account: String,
    namespace_id: i64,
    target: String,
    processed_through: String,
    recovery_through: Option<String>,
}

#[derive(Clone)]
struct GroupMetaProfileReference {
    is_group: bool,
    thread_id: i64,
    account: String,
    namespace_id: i64,
    rev: i64,
}

fn commit_group_meta_profile(
    conn: &Connection,
    user_id: i64,
    reference: &GroupMetaProfileReference,
    profile: &Value,
) -> Result<(), String> {
    if profile.get("account").and_then(Value::as_str) != Some(reference.account.as_str())
        || profile.get("profileNamespaceId").and_then(Value::as_i64) != Some(reference.namespace_id)
        || profile.get("rev").and_then(Value::as_i64) != Some(reference.rev)
        || (reference.is_group
            && profile.get("publisherNamespaceId").and_then(Value::as_i64)
                != Some(reference.namespace_id))
    {
        return Err("resolved profile revision does not match Group Meta".into());
    }
    let current: bool = if reference.is_group {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM threads
             WHERE user_id=?1 AND thread_id=?2 AND kind='GROUP'
               AND subject_account=?3
               AND subject_namespace_id=?4 AND thread_profile_rev=?5)",
            params![
                user_id,
                reference.thread_id,
                reference.account,
                reference.namespace_id,
                reference.rev
            ],
            |row| row.get(0),
        )
    } else {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM members member
             JOIN threads thread ON thread.user_id=member.user_id AND thread.thread_id=member.thread_id
             WHERE member.user_id=?1 AND member.thread_id=?2
             AND member.member_account=?3 AND member.namespace_id=?4
             AND member.profile_rev=?5 AND member.left_state=0
             AND thread.kind='GROUP' AND thread.authority_namespace_id=?6)",
            params![
                user_id,
                reference.thread_id,
                reference.account,
                reference.namespace_id,
                reference.rev,
                profile.get("publisherNamespaceId").and_then(Value::as_i64)
                    .ok_or("resolved member profile has no publisher namespace")?
            ],
            |row| row.get(0),
        )
    }
    .map_err(|e| format!("validate Group Meta profile reference: {e}"))?;
    if !current {
        return Ok(());
    }
    // Preserve the group's publisher and the member namespace in that publisher's space.
    commit_resolved_profile(conn, user_id, profile)?;
    if reference.is_group {
        conn.execute(
            "UPDATE threads SET subject_name=?3,subject_avatar='',subject_bio=?4
             WHERE user_id=?1 AND thread_id=?2 AND kind='GROUP'",
            params![
                user_id,
                reference.thread_id,
                profile
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or("resolved profile has no name")?,
                profile
                    .get("bio")
                    .and_then(Value::as_str)
                    .ok_or("resolved profile has no bio")?,
            ],
        )
        .map_err(|e| format!("update resolved group profile: {e}"))?;
    }
    Ok(())
}

async fn resolve_group_meta_profile(
    app: Option<&tauri::AppHandle>,
    proxy: &ServerSessionState,
    user_id: i64,
    epoch: u64,
    reference: GroupMetaProfileReference,
) -> Result<bool, String> {
    let target = serde_json::json!({
        "profileNamespaceId": reference.namespace_id,
        "account": reference.account,
        "rev": reference.rev,
    });
    let demand = if reference.is_group {
        serde_json::json!({
            "publisherNamespaceId": reference.namespace_id,
            "lookup": "ACCOUNT_PROFILE",
            "target": target,
        })
    } else {
        let thread_id = reference.thread_id;
        let (group_account, authority_namespace_id): (String, i64) =
            super::lifetime::spawn_at(Ok(epoch), move || {
                open()?.query_row(
                    "SELECT subject_account, authority_namespace_id FROM threads WHERE user_id=?1 AND thread_id=?2 AND kind='GROUP'",
                    params![user_id, thread_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|e| format!("read group account for profile demand: {e}"))
            })
            .await
            .map_err(|e| format!("join group account lookup: {e}"))??;
        // Member snapshots remain scoped to the group's publisher.
        serde_json::json!({
            "publisherNamespaceId": authority_namespace_id,
            "lookup": "GROUP_MEMBER_PROFILE",
            "target": target,
            "groupAccount": group_account,
        })
    };
    let response = perform_api_request_with_events(
        app,
        proxy,
        "POST".into(),
        "/api/v1/user/profile-resolution".into(),
        std::collections::HashMap::from([("content-type".into(), "application/json".into())]),
        Some(serde_json::to_vec(&demand).map_err(|e| e.to_string())?),
        true,
    )
    .await?;
    if !(200..300).contains(&response.status) {
        return Err(format!("profile-resolution HTTP {}", response.status));
    }
    let envelope: GroupMetaResponse = serde_json::from_str(&response.body)
        .map_err(|e| format!("decode profile-resolution response: {e}"))?;
    let (key, _) = parse_profile_request(&demand)?;
    handle_profile_error(user_id, epoch, &key, envelope.code).await?;
    let data = envelope.data.ok_or("missing profile-resolution result")?;
    match data.get("status").and_then(Value::as_str) {
        Some("READY") => {
            let profile = data
                .get("profile")
                .cloned()
                .ok_or("missing resolved profile")?;
            super::lifetime::spawn_at(Ok(epoch), move || {
                commit_group_meta_profile(&open()?, user_id, &reference, &profile)
            })
            .await
            .map_err(|e| format!("join resolved profile commit: {e}"))??;
            return Ok(true);
        }
        Some("PENDING") => {
            return Ok(false);
        }
        _ => return Err("invalid profile-resolution result".into()),
    }
}

fn unresolved_group_meta_profiles(
    conn: &Connection,
    user_id: i64,
) -> Result<Vec<GroupMetaProfileReference>, String> {
    let mut references = Vec::new();
    let mut groups = conn
        .prepare(
            "SELECT state.thread_id, state.subject_account,
                    state.subject_namespace_id, state.thread_profile_rev
             FROM threads state
             WHERE state.user_id=?1 AND state.kind='GROUP'
               AND state.conversation_state <> 'READ_ONLY'
               AND state.thread_profile_rev > 0
               AND NOT EXISTS (
                 SELECT 1 FROM profiles profile WHERE profile.user_id=state.user_id
                   AND profile.account=state.subject_account
                   AND profile.publisher_namespace_id=state.subject_namespace_id
                   AND profile.profile_namespace_id=state.subject_namespace_id
                   AND profile.profile_rev=state.thread_profile_rev)",
        )
        .map_err(|e| format!("prepare unresolved group profiles: {e}"))?;
    let rows = groups
        .query_map([user_id], |row| {
            Ok(GroupMetaProfileReference {
                is_group: true,
                thread_id: row.get(0)?,
                account: row.get(1)?,
                namespace_id: row.get(2)?,
                rev: row.get(3)?,
            })
        })
        .map_err(|e| format!("query unresolved group profiles: {e}"))?;
    for row in rows {
        references.push(row.map_err(|e| format!("read unresolved group profile: {e}"))?);
    }
    let mut members = conn
        .prepare(
            "SELECT member.thread_id, member.member_account,
                    member.namespace_id, member.profile_rev
             FROM members member
             JOIN threads thread ON thread.user_id=member.user_id AND thread.thread_id=member.thread_id AND thread.kind='GROUP'
             WHERE member.user_id=?1 AND member.left_state=0 AND member.profile_rev>0
               AND NOT EXISTS (
                 SELECT 1 FROM profiles profile WHERE profile.user_id=member.user_id
                   AND profile.account=member.member_account
                   AND profile.publisher_namespace_id=thread.authority_namespace_id
                   AND profile.profile_namespace_id=member.namespace_id
                   AND profile.profile_rev=member.profile_rev)",
        )
        .map_err(|e| format!("prepare unresolved member profiles: {e}"))?;
    let rows = members
        .query_map([user_id], |row| {
            Ok(GroupMetaProfileReference {
                is_group: false,
                thread_id: row.get(0)?,
                account: row.get(1)?,
                namespace_id: row.get(2)?,
                rev: row.get(3)?,
            })
        })
        .map_err(|e| format!("query unresolved member profiles: {e}"))?;
    for row in rows {
        references.push(row.map_err(|e| format!("read unresolved member profile: {e}"))?);
    }
    Ok(references)
}

fn group_meta_plans(conn: &Connection, user_id: i64) -> Result<Vec<GroupMetaPlan>, String> {
    let mut statement = conn
        .prepare(
            "SELECT thread_id, group_meta_feed_end_id
             FROM threads
             WHERE user_id=?1 AND kind='GROUP'
               AND conversation_state <> 'READ_ONLY'",
        )
        .map_err(|e| format!("prepare group-meta plans: {e}"))?;
    let rows = statement
        .query_map([user_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| format!("query group-meta plans: {e}"))?;
    let mut plans = Vec::new();
    for row in rows {
        let (thread_id, target) = row.map_err(|e| format!("read group-meta plan: {e}"))?;
        let thread = super::thread_store::read(conn, user_id, thread_id)?
            .ok_or("missing group thread structure")?;
        let Some(target) = target else {
            continue;
        };
        let group = &thread["group"];
        let account = group["account"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or("group-meta plan has no group account")?;
        let namespace_id = group["namespaceId"]
            .as_i64()
            .filter(|value| *value >= 0)
            .ok_or("group-meta plan has no namespace")?;
        let processed_through = group["groupMetaFeedId"].as_str().unwrap_or("0");
        for value in [&target, processed_through] {
            value
                .parse::<u64>()
                .map_err(|_| "invalid group-meta coordinate".to_string())?;
        }
        let recovery_through = thread["groupMetaRecoveryThrough"]
            .as_str()
            .map(str::to_owned);
        if let Some(value) = &recovery_through {
            value
                .parse::<u64>()
                .map_err(|_| "invalid group-meta recovery boundary".to_string())?;
        }
        plans.push(GroupMetaPlan {
            thread_id,
            account: account.to_owned(),
            namespace_id,
            target,
            processed_through: processed_through.to_owned(),
            recovery_through,
        });
    }
    Ok(plans)
}

/// Drain Group Meta for a single thread (drain-open mode). Only the open
/// thread's Group Meta advances; switching away stops after the current
/// page commits. Returns the changed thread ids (just `thread_id` when any
/// page committed).
async fn sync_group_meta_thread(
    app: Option<&tauri::AppHandle>,
    proxy: &ServerSessionState,
    user_id: i64,
    thread_id: i64,
    epoch: u64,
) -> (
    Vec<i64>,
    Vec<super::client_state::GroupMetaCommitPatch>,
    Option<String>,
) {
    let mut changed = Vec::new();
    let mut patches = Vec::new();
    let result = sync_group_meta_thread_unchecked(
        app,
        proxy,
        user_id,
        thread_id,
        epoch,
        &mut changed,
        &mut patches,
    )
    .await;
    changed.sort_unstable();
    changed.dedup();
    (changed, patches, result.err())
}

// Each drain subscribes before reading its initial plan, so a committed
// departure cannot be missed between the snapshot read and the first request.
fn subscribe_meta_flight(
    user_id: i64,
    thread_id: i64,
    epoch: u64,
) -> (std::sync::Arc<std::sync::atomic::AtomicBool>, impl Sized) {
    let token = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let cancelled = token.clone();
    let subscription = super::thread_feed_commits::THREAD_FEED_COMMITS.subscribe(move |commit| {
        if commit.user_id == user_id
            && commit.epoch == epoch
            && commit.states.iter().any(|state| {
                i64::from(state.thread_id) == thread_id
                    && state.server.as_ref().is_some_and(|snapshot| {
                        snapshot.kind != "GROUP" || snapshot.conversation_state != "ACTIVE"
                    })
            })
        {
            cancelled.store(false, std::sync::atomic::Ordering::Release);
        }
    });
    (token, subscription)
}

async fn sync_group_meta_thread_unchecked(
    app: Option<&tauri::AppHandle>,
    proxy: &ServerSessionState,
    user_id: i64,
    thread_id: i64,
    epoch: u64,
    changed: &mut Vec<i64>,
    patches: &mut Vec<super::client_state::GroupMetaCommitPatch>,
) -> Result<(), String> {
    let (token, _subscription) = subscribe_meta_flight(user_id, thread_id, epoch);
    let active = || token.load(std::sync::atomic::Ordering::Acquire);
    let plans = super::lifetime::spawn_at(Ok(epoch), move || group_meta_plans(&open()?, user_id))
        .await
        .map_err(|e| format!("join group-meta plan read: {e}"))??;
    for plan in plans.into_iter().filter(|plan| plan.thread_id == thread_id) {
        if !active() || open_thread_id() != Some(thread_id) {
            return Ok(());
        }
        let target = plan.target.parse::<u64>().map_err(|e| e.to_string())?;
        let mut after = plan
            .processed_through
            .parse::<u64>()
            .map_err(|e| e.to_string())?;
        let recovery_through = plan.recovery_through;
        if recovery_through.is_none() && after >= target {
            continue;
        }
        let mut mode = if recovery_through.is_some() || after == 0 {
            "full"
        } else {
            "delta"
        };
        let mut through = recovery_through
            .as_deref()
            .unwrap_or(&plan.target)
            .parse::<u64>()
            .map_err(|e| e.to_string())?;
        if mode == "full" && recovery_through.is_none() {
            let boundary = through.to_string();
            super::lifetime::spawn_at(Ok(epoch), move || {
                super::client_state::begin_group_meta_recovery(
                    &mut open()?,
                    user_id,
                    plan.thread_id,
                    &boundary,
                )
            })
            .await
            .map_err(|e| format!("join group-meta recovery reset: {e}"))??;
            changed.push(plan.thread_id);
            after = 0;
        }
        let mut reopened = false;
        loop {
            if !active() || open_thread_id() != Some(thread_id) {
                return Ok(());
            }
            drop(super::lifetime::CACHE_LIFETIME.admit(epoch)?);
            let path = format!(
                "/api/v1/user/group-meta?threadId={}&mode={mode}&after={after}&take=100&through={through}",
                plan.thread_id
            );
            let response = perform_api_request_with_events(
                app,
                proxy,
                "GET".into(),
                path,
                std::collections::HashMap::new(),
                None,
                true,
            )
            .await;
            if !active() {
                return Ok(());
            }
            let response = response?;
            if !(200..300).contains(&response.status) {
                return Err(format!("group-meta HTTP {}", response.status));
            }
            let envelope: GroupMetaResponse = serde_json::from_str(&response.body)
                .map_err(|e| format!("decode group-meta response: {e}"))?;
            if envelope.code == 30006 {
                if reopened {
                    return Err("group-meta recovery window is unavailable".into());
                }
                let reset = envelope.data.ok_or("missing group-meta recovery window")?;
                if reset["resumeAfter"].as_str() != Some("0") {
                    return Err("invalid group-meta recovery window".into());
                }
                let before = reset["resumeBefore"]
                    .as_str()
                    .ok_or("invalid group-meta recovery boundary")?
                    .parse::<u64>()
                    .map_err(|_| "invalid group-meta recovery boundary".to_string())?;
                through = before
                    .checked_sub(1)
                    .ok_or("invalid group-meta recovery boundary")?;
                let boundary = through.to_string();
                let thread_id = plan.thread_id;
                super::lifetime::spawn_at(Ok(epoch), move || {
                    super::client_state::begin_group_meta_recovery(
                        &mut open()?,
                        user_id,
                        thread_id,
                        &boundary,
                    )
                })
                .await
                .map_err(|e| format!("join group-meta recovery reopen: {e}"))??;
                changed.push(plan.thread_id);
                after = 0;
                mode = "full";
                reopened = true;
                continue;
            }
            if envelope.code != 0 {
                return Err("group-meta pull failed".into());
            }
            let page: ClientGroupMetaPage =
                serde_json::from_value(envelope.data.ok_or("missing group-meta page")?)
                    .map_err(|e| format!("decode group-meta page: {e}"))?;
            let scanned = page
                .scanned_through
                .parse::<u64>()
                .map_err(|_| "invalid group-meta scanned boundary".to_string())?;
            let source_end = page
                .group_meta_feed_end_id
                .parse::<u64>()
                .map_err(|_| "invalid group-meta source boundary".to_string())?;
            if page.mode != mode
                || page.account != plan.account
                || scanned < after
                || scanned > through
                || source_end < through
                || (!page.has_more && scanned != through)
                || (page.has_more && scanned == after)
            {
                return Err("invalid group-meta page".into());
            }
            let has_more = page.has_more;
            let update = ClientGroupMetaApply {
                thread_id: plan.thread_id,
                namespace_id: plan.namespace_id,
                page,
            };
            let patch = super::lifetime::spawn_at(Ok(epoch), move || {
                super::client_state::apply_group_meta_page(&mut open()?, user_id, update)
            })
            .await
            .map_err(|e| format!("join group-meta page commit: {e}"))??;
            if let Some(patch) = patch {
                patches.push(patch);
                changed.push(plan.thread_id);
            }
            after = scanned;
            if !has_more {
                if mode == "full" && after < target {
                    mode = "delta";
                    through = target;
                    continue;
                }
                break;
            }
        }
    }
    if !active() {
        return Ok(());
    }
    let references = super::lifetime::spawn_at(Ok(epoch), move || {
        unresolved_group_meta_profiles(&open()?, user_id)
    })
    .await
    .map_err(|e| format!("join unresolved Group Meta profile read: {e}"))??;
    for reference in references
        .into_iter()
        .filter(|reference| reference.thread_id == thread_id)
    {
        if !active() {
            return Ok(());
        }
        let changed_thread_id = reference.thread_id;
        // Profile warming is optional: one failed reference must not discard
        // the already-committed Group Meta pages of this drain.
        match resolve_group_meta_profile(app, proxy, user_id, epoch, reference).await {
            Ok(true) => changed.push(changed_thread_id),
            Ok(false) => {}
            Err(error) => warn!("group-meta profile reference failed; next wake retries: {error}"),
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeletedMessagePage {
    tombstones: Vec<Value>,
    scanned_through: i64,
    has_more: bool,
}

#[derive(Deserialize)]
struct TombstoneResponse {
    code: i32,
    data: Option<DeletedMessagePage>,
}

/// Drain the deletion (tombstone) feed for one thread up to `target` (drain-open
/// mode). Checks `open_thread_id() === thread_id` between pages so switching
/// away lets the current page commit, then stops. Returns the committed
/// tombstones so the caller can emit a notification.
async fn sync_tombstone_thread(
    app: Option<&tauri::AppHandle>,
    proxy: &ServerSessionState,
    user_id: i64,
    thread_id: i64,
    target: i64,
    epoch: u64,
) -> Result<Vec<Value>, String> {
    let mut committed = Vec::new();
    let mut hwm = super::lifetime::spawn_at(Ok(epoch), move || {
        let conn = open()?;
        let hwm: Option<i64> = conn
            .query_row(
                "SELECT deleted_hwm FROM thread_sync_state WHERE user_id=?1 AND thread_id=?2",
                rusqlite::params![user_id, thread_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("get deleted hwm: {e}"))?;
        Ok::<_, String>(hwm.unwrap_or(0))
    })
    .await
    .map_err(|e| format!("join tombstone hwm read: {e}"))??;
    loop {
        if open_thread_id() != Some(thread_id) {
            return Ok(committed);
        }
        if hwm >= target {
            return Ok(committed);
        }
        drop(super::lifetime::CACHE_LIFETIME.admit(epoch)?);
        let body = serde_json::to_vec(&serde_json::json!({
            "threadId": thread_id,
            "after": hwm,
            "take": 100,
            "through": target,
        }))
        .map_err(|e| format!("encode tombstone request: {e}"))?;
        let response = perform_api_request_with_events(
            app,
            proxy,
            "POST".into(),
            "/api/v1/deleted-messages/query".into(),
            std::collections::HashMap::from([("content-type".into(), "application/json".into())]),
            Some(body),
            true,
        )
        .await?;
        if !(200..300).contains(&response.status) {
            return Err(format!("tombstone HTTP {}", response.status));
        }
        let envelope: TombstoneResponse = serde_json::from_str(&response.body)
            .map_err(|e| format!("decode tombstone response: {e}"))?;
        if envelope.code != 0 {
            return Err("tombstone query failed".into());
        }
        let page = envelope.data.ok_or("missing tombstone page")?;
        if page.scanned_through < hwm || (page.scanned_through == hwm && page.has_more) {
            return Err("invalid tombstone page".into());
        }
        let scanned = page.scanned_through;
        let has_more = page.has_more;
        let tombstones = page.tombstones;
        let page_committed = tombstones.clone();
        super::messages::native_db_apply_deleted_messages(user_id, thread_id, tombstones, scanned)
            .await?;
        committed.extend(page_committed);
        hwm = scanned;
        if !has_more {
            return Ok(committed);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadFeedSyncResult {
    pub(crate) states: Vec<LocalThreadAttention>,
    pub(crate) cursor: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

fn validate_page(page: &ThreadFeedPage, after: i32, through: i32) -> Result<(), String> {
    if page.through != through
        || page.scanned_through <= after
        || page.scanned_through > through
        || page.thread_feed_end_id < through
        || (!page.has_more && page.scanned_through != through)
    {
        return Err("invalid thread feed page boundary".into());
    }
    let mut previous = after;
    for state in &page.items {
        validate_snapshot(state)?;
        if state.thread_feed_id <= previous || state.thread_feed_id > page.scanned_through {
            return Err("unordered thread feed page".into());
        }
        previous = state.thread_feed_id;
    }
    Ok(())
}

fn validate_sync_page(
    page: &ThreadFeedPage,
    after: i32,
    through: Option<i32>,
) -> Result<(), String> {
    let empty_poll = through.is_none()
        && page.through == after
        && page.scanned_through == after
        && page.thread_feed_end_id == after
        && page.items.is_empty()
        && !page.has_more;
    if empty_poll {
        Ok(())
    } else {
        validate_page(page, after, through.unwrap_or(page.through))
    }
}

fn read_feed_changes(
    conn: &mut Connection,
    user_id: i64,
    after: i32,
) -> Result<ThreadFeedSyncResult, String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("begin thread feed changes: {e}"))?;
    let cursor = read_cursor(&tx, user_id)?;
    let states = read_states(&tx, user_id)?
        .into_iter()
        .filter(|state| {
            state.server.as_ref().is_some_and(|server| {
                server.thread_feed_id > after && server.thread_feed_id <= cursor
            })
        })
        .collect();
    tx.commit()
        .map_err(|e| format!("finish thread feed changes: {e}"))?;
    Ok(ThreadFeedSyncResult {
        states,
        cursor,
        error: None,
    })
}

#[tauri::command]
pub(crate) async fn native_thread_feed_changes(
    user_id: i64,
    after: i32,
) -> Result<ThreadFeedSyncResult, String> {
    if user_id <= 0 || after < 0 {
        return Err("invalid thread feed changes request".into());
    }
    super::lifetime::spawn(move || read_feed_changes(&mut open()?, user_id, after))
        .await
        .map_err(|e| format!("join thread feed changes: {e}"))?
}

pub(crate) async fn sync_thread_feed(
    app: Option<&tauri::AppHandle>,
    proxy: &ServerSessionState,
    user_id: i64,
    target: i32,
) -> Result<ThreadFeedSyncResult, String> {
    if user_id <= 0 || target < -1 {
        return Err("invalid thread feed owner or target".into());
    }
    let epoch = super::lifetime::CACHE_LIFETIME.capture()?;
    let _sync = THREAD_FEED_SYNC.lock().await;
    let events = crate::realtime::NativeEvents::capture(app);
    let _renderer = super::thread_feed_commits::THREAD_FEED_COMMITS.subscribe(move |commit| {
        if commit.user_id != user_id || commit.epoch != epoch {
            return;
        }
        for snapshot in commit
            .states
            .iter()
            .filter_map(|state| state.server.as_ref())
        {
            let _ = events.emit(
                "soms-sse-event",
                LocalEventPayload {
                    event: "THREAD_ALIAS_APPLIED".into(),
                    status: 0,
                    message: "thread alias applied".into(),
                    data: serde_json::json!({
                        "userId": user_id, "threadId": snapshot.thread_id,
                        "threadFeedId": snapshot.thread_feed_id, "alias": snapshot.alias,
                    }),
                },
            );
        }
        let _ = events.emit(
            "soms-sse-event",
            LocalEventPayload {
                event: "LOCAL_THREAD_FEED_COMMITTED".into(),
                status: 0,
                message: "local data committed".into(),
                data: serde_json::json!({ "userId": user_id, "states": commit.states }),
            },
        );
    });
    drop(super::lifetime::CACHE_LIFETIME.admit(epoch)?);
    let mut cursor = super::lifetime::spawn_at(Ok(epoch), move || {
        let conn = open()?;
        read_cursor(&conn, user_id)
    })
    .await
    .map_err(|e| format!("join thread feed cursor read: {e}"))??;
    let mut states: BTreeMap<i32, LocalThreadAttention> = BTreeMap::new();
    // Only scheduled polling lacks a wake head. Its first page discovers the server boundary.
    let mut target = (target >= 0).then_some(target);
    let outcome: Result<(), String> = async {
        while target.is_none_or(|target| cursor < target) {
            drop(super::lifetime::CACHE_LIFETIME.admit(epoch)?);
            let through = target;
            let response = perform_api_request_with_events(
                app,
                proxy,
                "POST".into(),
                "/api/v1/thread-feed".into(),
                std::collections::HashMap::from([(
                    "content-type".into(),
                    "application/json".into(),
                )]),
                Some(if let Some(through) = through {
                    feed_request(cursor, through)?
                } else {
                    serde_json::to_vec(
                        &serde_json::json!({"after":cursor,"take":100,"previewCount":3}),
                    )
                    .map_err(|e| e.to_string())?
                }),
                true,
            )
            .await?;
            if !(200..300).contains(&response.status) {
                return Err(format!("thread feed HTTP {}", response.status));
            }
            let envelope: ThreadFeedResponse = serde_json::from_str(&response.body)
                .map_err(|e| format!("decode thread feed response: {e}"))?;
            if envelope.code != 0 {
                return Err("thread feed query failed".into());
            }
            let page = envelope.data.ok_or("missing thread feed page")?;
            validate_sync_page(&page, cursor, through)?;
            let scanned = page.scanned_through;
            let head = page.thread_feed_end_id;
            let renderer = _renderer.clone();
            let merged = super::lifetime::spawn_at_then(
                Ok(epoch),
                move || merge_states(&mut open()?, user_id, page.items, Some(scanned)),
                move |merged| {
                    // Keep the subscription alive through a detached blocking commit.
                    let _renderer = renderer;
                    super::thread_feed_commits::THREAD_FEED_COMMITS.publish(
                        &super::thread_feed_commits::ThreadFeedCommit {
                            user_id,
                            epoch,
                            states: merged,
                        },
                    );
                },
            )
            .await
            .map_err(|e| format!("join thread feed merge: {e}"))??;
            for mut state in merged {
                state.notification_changed |= states
                    .get(&state.thread_id)
                    .is_some_and(|old| old.notification_changed);
                states.insert(state.thread_id, state);
            }
            cursor = scanned;
            target = Some(target.unwrap_or(head).max(head));
        }
        // Group Meta is no longer drained inline here. It runs as an independent
        // per-thread drain driven by `native_db_drain_thread_misc` (drain-open mode):
        // only the open thread's Group Meta advances, switched-away threads stop
        // after the current page commits.
        Ok(())
    }
    .await;
    drop(super::lifetime::CACHE_LIFETIME.admit(epoch)?);
    // A later network failure must not hide earlier committed pages from the live renderer.
    Ok(ThreadFeedSyncResult {
        states: states.into_values().collect(),
        cursor,
        error: outcome.err(),
    })
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ThreadPreviewSender {
    account: String,
    /// Profile namespace in the thread authority publisher's space, not receiver-local.
    #[serde(rename = "profileNamespaceId")]
    namespace_id: i32,
    profile_rev: i32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum ThreadPreviewStatus {
    Live,
    UserRetraction,
    ModerationRemoval,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ThreadPreview {
    pub(super) seq: i32,
    created_at: String,
    sender: ThreadPreviewSender,
    status: ThreadPreviewStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ThreadFeedSnapshot {
    #[serde(rename = "type")]
    pub(super) kind: String,
    /// Thread authority/publisher coordinate (wire: `publisherNamespaceId`).
    #[serde(rename = "publisherNamespaceId")]
    pub(super) authority_namespace_id: i32,
    /// Viewer home namespace in the group origin's space; unknown is not namespace zero.
    #[serde(deserialize_with = "required_nullable")]
    pub(super) self_mention_namespace_id: Option<i32>,
    pub(super) conversation_state: String,
    pub(super) blocked: bool,
    #[serde(deserialize_with = "required_nullable")]
    pub(super) role: Option<String>,
    /// Peer's account in the publisher's namespace (wire: `profileAccount`).
    #[serde(rename = "profileAccount")]
    pub(super) subject_account: String,
    pub(super) thread_id: i32,
    pub(super) thread_feed_id: i32,
    #[serde(deserialize_with = "required_nullable")]
    pub(super) alias: Option<String>,
    pub(super) message_end_seq: i32,
    /// Peer's profile revision in the publisher's namespace (wire: `profileRev`).
    #[serde(rename = "profileRev")]
    pub(super) thread_profile_rev: i32,
    pub(super) tombstone_end_seq: i32,
    #[serde(deserialize_with = "required_nullable")]
    pub(super) group_meta_feed_end_id: Option<String>,
    pub(super) join_request_end_feed_id: i32,
    pub(super) join_request_read_feed_id: i32,
    pub(super) group_invite_end_feed_id: i32,
    pub(super) last_read_seq: i32,
    pub(super) announcement_read_feed_id: i32,
    pub(super) unread_count: i32,
    #[serde(deserialize_with = "required_nullable")]
    pub(super) last_mention_seq: Option<i32>,
    pub(super) previews: Vec<ThreadPreview>,
}

fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocalThreadAttention {
    /// Transient eligibility from the consumed page; never part of the durable snapshot.
    #[serde(skip)]
    pub(super) notification_changed: bool,
    pub(super) thread_id: i32,
    pub(super) server: Option<ThreadFeedSnapshot>,
    pub(super) local_read_seq: Option<i32>,
}

/// The WebView contract (shared/thread-attention.ts) is a FLAT snapshot plus `localReadSeq`,
/// not a nested `server` object. Serialize the committed snapshot accordingly; the nested
/// form stays the internal/Deserialize representation.
impl Serialize for LocalThreadAttention {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match &self.server {
            Some(server) => {
                #[derive(Serialize)]
                struct Flat<'a> {
                    #[serde(flatten)]
                    server: &'a ThreadFeedSnapshot,
                    #[serde(rename = "localReadSeq")]
                    local_read_seq: i32,
                }
                Flat {
                    server,
                    local_read_seq: self.local_read_seq.unwrap_or(server.last_read_seq),
                }
                .serialize(serializer)
            }
            None => {
                #[derive(Serialize)]
                #[serde(rename_all = "camelCase")]
                struct Empty {
                    thread_id: i32,
                    local_read_seq: i32,
                }
                Empty {
                    thread_id: self.thread_id,
                    local_read_seq: self.local_read_seq.unwrap_or(0),
                }
                .serialize(serializer)
            }
        }
    }
}

fn validate_snapshot(state: &ThreadFeedSnapshot) -> Result<(), String> {
    if state.thread_id <= 0
        || state.thread_feed_id <= 0
        || !matches!(state.kind.as_str(), "P2P" | "GROUP")
        || !matches!(state.conversation_state.as_str(), "ACTIVE" | "READ_ONLY")
        || (state.kind == "P2P" && state.role.is_some())
        || state
            .role
            .as_deref()
            .is_some_and(|role| !matches!(role, "OWNER" | "ADMIN" | "MEMBER"))
        || state.authority_namespace_id < 0
        || state
            .self_mention_namespace_id
            .is_some_and(|namespace| namespace < 0)
        || state.subject_account.is_empty()
        || state.thread_profile_rev < 0
        || state.message_end_seq < 0
        || state.tombstone_end_seq < 0
        || state.join_request_end_feed_id < 0
        || state.join_request_read_feed_id < -1
        || state.join_request_read_feed_id > state.join_request_end_feed_id
        || state.group_invite_end_feed_id < 0
        || state.last_read_seq < 0
        || state.announcement_read_feed_id < 0
        || state.unread_count < 0
        || state.last_mention_seq.is_some_and(|seq| seq <= 0)
    {
        return Err("invalid attention snapshot".into());
    }
    Ok(())
}

pub(super) fn read_state(
    conn: &Connection,
    user_id: i64,
    thread_id: i32,
) -> Result<LocalThreadAttention, String> {
    let state = conn
        .query_row(
            "SELECT thread_feed_id, kind, authority_namespace_id, conversation_state,
                blocked, role, subject_account,
                subject_namespace_id, alias, thread_profile_rev,
                message_end_seq, tombstone_end_seq, group_meta_feed_end_id,
                join_request_end_feed_id, join_request_read_feed_id,
                group_invite_end_feed_id, server_last_read_seq, announcement_read_feed_id,
                server_unread_count, last_mention_seq, local_read_seq, self_mention_namespace_id
         FROM threads WHERE user_id=?1 AND thread_id=?2",
            params![user_id, thread_id],
            |row| {
                Ok(LocalThreadAttention {
                    notification_changed: false,
                    thread_id,
                    server: Some(ThreadFeedSnapshot {
                        thread_id,
                        thread_feed_id: row.get(0)?,
                        kind: row.get(1)?,
                        authority_namespace_id: row.get(2)?,
                        self_mention_namespace_id: row.get(21)?,
                        conversation_state: row.get(3)?,
                        blocked: row.get(4)?,
                        role: row.get(5)?,
                        subject_account: row.get(6)?,
                        alias: row.get(8)?,
                        thread_profile_rev: row.get(9)?,
                        message_end_seq: row.get(10)?,
                        tombstone_end_seq: row.get(11)?,
                        group_meta_feed_end_id: row.get(12)?,
                        join_request_end_feed_id: row.get(13)?,
                        join_request_read_feed_id: row.get(14)?,
                        group_invite_end_feed_id: row.get(15)?,
                        last_read_seq: row.get(16)?,
                        announcement_read_feed_id: row.get(17)?,
                        unread_count: row.get(18)?,
                        last_mention_seq: row.get(19)?,
                        previews: Vec::new(),
                    }),
                    local_read_seq: Some(row.get(20)?),
                })
            },
        )
        .optional()
        .map_err(|e| format!("read attention: {e}"))?;
    let Some(mut state) = state else {
        return Ok(LocalThreadAttention {
            notification_changed: false,
            thread_id,
            server: None,
            local_read_seq: None,
        });
    };
    let preview = conn
        .query_row(
            "SELECT seq, created_at, sender_account, sender_namespace_id,
                sender_profile_rev, status, text
         FROM thread_previews WHERE user_id=?1 AND thread_id=?2",
            params![user_id, thread_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get::<_, String>(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("read thread preview: {e}"))?;
    if let Some((seq, created_at, account, namespace_id, profile_rev, status, text)) = preview {
        let status = serde_json::from_value(serde_json::Value::String(status))
            .map_err(|e| format!("decode thread preview status: {e}"))?;
        state.server.as_mut().unwrap().previews.push(ThreadPreview {
            seq,
            created_at,
            sender: ThreadPreviewSender {
                account,
                namespace_id,
                profile_rev,
            },
            status,
            text,
        });
    }
    Ok(state)
}

pub(super) fn write_state(
    conn: &Connection,
    user_id: i64,
    state: &LocalThreadAttention,
) -> Result<(), String> {
    let server = state.server.as_ref().ok_or("attention snapshot missing")?;
    let local_read_seq = state
        .local_read_seq
        .ok_or("attention read position missing")?;
    let affected = conn
        .execute(
            "UPDATE threads SET
           thread_feed_id=?3,conversation_state=?6,blocked=?7,role=?8,
           alias=?11,thread_profile_rev=?12,message_end_seq=?13,
           tombstone_end_seq=?14,group_meta_feed_end_id=?15,
           join_request_end_feed_id=?16,join_request_read_feed_id=?17,
           group_invite_end_feed_id=?18,server_last_read_seq=?19,
           announcement_read_feed_id=?20,server_unread_count=?21,
           last_mention_seq=?22,local_read_seq=?23,self_mention_namespace_id=?24
         WHERE user_id=?1 AND thread_id=?2 AND kind=?4
           AND authority_namespace_id=?5
           AND subject_account=?9 AND subject_namespace_id=?10",
            params![
                user_id,
                state.thread_id,
                server.thread_feed_id,
                server.kind,
                server.authority_namespace_id,
                server.conversation_state,
                server.blocked,
                server.role,
                server.subject_account,
                server.authority_namespace_id,
                server.alias,
                server.thread_profile_rev,
                server.message_end_seq,
                server.tombstone_end_seq,
                server.group_meta_feed_end_id,
                server.join_request_end_feed_id,
                server.join_request_read_feed_id,
                server.group_invite_end_feed_id,
                server.last_read_seq,
                server.announcement_read_feed_id,
                server.unread_count,
                server.last_mention_seq,
                local_read_seq,
                server.self_mention_namespace_id,
            ],
        )
        .map_err(|e| format!("write attention: {e}"))?;
    if affected != 1 {
        return Err("thread snapshot has no matching structural identity".into());
    }
    let latest = server.previews.iter().max_by_key(|preview| preview.seq);
    if let Some(preview) = latest {
        let status = match preview.status {
            ThreadPreviewStatus::Live => "LIVE",
            ThreadPreviewStatus::UserRetraction => "USER_RETRACTION",
            ThreadPreviewStatus::ModerationRemoval => "MODERATION_REMOVAL",
        };
        conn.execute(
            "INSERT INTO thread_previews (
               user_id, thread_id, seq, created_at, sender_account,
               sender_namespace_id, sender_profile_rev, status, text
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(user_id,thread_id) DO UPDATE SET
               (seq, created_at, sender_account,
                sender_namespace_id, sender_profile_rev, status, text) =
               (excluded.seq, excluded.created_at, excluded.sender_account,
                excluded.sender_namespace_id,
                excluded.sender_profile_rev, excluded.status, excluded.text)",
            params![
                user_id,
                state.thread_id,
                preview.seq,
                preview.created_at,
                preview.sender.account,
                preview.sender.namespace_id,
                preview.sender.profile_rev,
                status,
                preview.text
            ],
        )
        .map_err(|e| format!("write thread preview: {e}"))?;
    } else {
        conn.execute(
            "DELETE FROM thread_previews WHERE user_id=?1 AND thread_id=?2",
            params![user_id, state.thread_id],
        )
        .map_err(|e| format!("clear thread preview: {e}"))?;
    }
    Ok(())
}

fn merge_states(
    conn: &mut Connection,
    user_id: i64,
    states: Vec<ThreadFeedSnapshot>,
    cursor: Option<i32>,
) -> Result<Vec<LocalThreadAttention>, String> {
    for state in &states {
        validate_snapshot(state)?;
    }
    if cursor.is_some_and(|cursor| cursor < 0) {
        return Err("invalid attention feed cursor".into());
    }
    // Serialize read-modify-write with WebView and background notification writers.
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("begin attention merge: {e}"))?;
    let mut merged = BTreeMap::new();
    for snapshot in states {
        let mut state = read_state(&tx, user_id, snapshot.thread_id)?;
        if state
            .server
            .as_ref()
            .is_none_or(|old| snapshot.thread_feed_id > old.thread_feed_id)
        {
            if state.local_read_seq.is_none() {
                state.local_read_seq = Some(snapshot.last_read_seq);
            }
            let notification_changed = state.server.as_ref().is_none_or(|old| {
                old.message_end_seq != snapshot.message_end_seq
                    || old.tombstone_end_seq != snapshot.tombstone_end_seq
                    || old.last_read_seq != snapshot.last_read_seq
                    || old.unread_count != snapshot.unread_count
                    || old.last_mention_seq != snapshot.last_mention_seq
            });
            // The structural write helper consumes its own nested shape (distinct from the
            // thread-feed wire shape): profile {account, namespaceId, profileRev} plus
            // authorityNamespaceId. Translate the validated wire snapshot explicitly.
            let body = serde_json::json!({
                "type": snapshot.kind.as_str(),
                "threadId": snapshot.thread_id,
                "authorityNamespaceId": snapshot.authority_namespace_id,
                "selfMentionNamespaceId": snapshot.self_mention_namespace_id,
                "conversationState": snapshot.conversation_state.as_str(),
                "blocked": snapshot.blocked,
                "role": snapshot.role,
                "profile": {
                    "account": snapshot.subject_account.as_str(),
                    "namespaceId": snapshot.authority_namespace_id,
                    "profileRev": snapshot.thread_profile_rev,
                },
                "alias": snapshot.alias,
                "threadProfileRev": snapshot.thread_profile_rev,
                "messageEndSeq": snapshot.message_end_seq,
                "tombstoneEndSeq": snapshot.tombstone_end_seq,
                "groupMetaFeedEndId": snapshot.group_meta_feed_end_id,
                "joinRequestEndFeedId": snapshot.join_request_end_feed_id,
                "joinRequestReadFeedId": snapshot.join_request_read_feed_id,
                "groupInviteEndFeedId": snapshot.group_invite_end_feed_id,
                "lastReadSeq": snapshot.last_read_seq,
                "announcementReadFeedId": snapshot.announcement_read_feed_id,
                "unreadCount": snapshot.unread_count,
                "lastMentionSeq": snapshot.last_mention_seq,
            });
            super::client_state::apply_thread_state(
                &tx,
                user_id,
                &body,
                i64::from(snapshot.thread_feed_id),
            )?;
            state.server = Some(snapshot);
            state.notification_changed = notification_changed;
            write_state(&tx, user_id, &state)?;
        }
        merged.insert(state.thread_id, state);
    }
    if let Some(cursor) = cursor {
        tx.execute(
            "INSERT INTO account_state(user_id,thread_feed_cursor) VALUES(?1,?2)
             ON CONFLICT(user_id) DO UPDATE SET thread_feed_cursor=
               MAX(COALESCE(account_state.thread_feed_cursor,0),excluded.thread_feed_cursor)",
            params![user_id, cursor],
        )
        .map_err(|e| format!("write attention cursor: {e}"))?;
    }
    tx.commit()
        .map_err(|e| format!("commit attention merge: {e}"))?;
    Ok(merged.into_values().collect())
}

fn advance_read(
    conn: &mut Connection,
    user_id: i64,
    thread_id: i32,
    seq: i32,
) -> Result<LocalThreadAttention, String> {
    if thread_id <= 0 || seq < 0 {
        return Err("invalid local attention position".into());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("begin attention read: {e}"))?;
    let mut state = read_state(&tx, user_id, thread_id)?;
    if state.server.is_none() {
        return Err("cannot mark a thread read before its feed snapshot".into());
    }
    if state.local_read_seq.is_none_or(|old| seq > old) {
        state.local_read_seq = Some(seq);
        write_state(&tx, user_id, &state)?;
    }
    tx.commit()
        .map_err(|e| format!("commit attention read: {e}"))?;
    Ok(state)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadAttentionProjection {
    thread_id: i32,
    last_read_seq: i32,
    unread_count: i32,
    mention_unread: Vec<&'static str>,
    last_message_preview: Option<String>,
    last_message_at: Option<i64>,
    last_message_sender_account: Option<String>,
    last_message_sender_namespace_id: Option<i32>,
}

fn attention_count_range(state: &LocalThreadAttention) -> Result<(i32, i32), String> {
    let server = state.server.as_ref().ok_or("attention snapshot missing")?;
    let local_read_seq = state
        .local_read_seq
        .ok_or("attention read position missing")?;
    let effective_read_seq = server
        .message_end_seq
        .min(server.last_read_seq.max(local_read_seq));
    let server_read_seq = server.message_end_seq.min(server.last_read_seq);
    Ok((
        server_read_seq.min(effective_read_seq),
        server_read_seq.max(effective_read_seq),
    ))
}

fn preview_timestamp_millis(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.timestamp_millis())
}

fn project_thread_attention(
    state: &LocalThreadAttention,
    interval_count: i64,
) -> Result<ThreadAttentionProjection, String> {
    let server = state.server.as_ref().ok_or("attention snapshot missing")?;
    let local_read_seq = state
        .local_read_seq
        .ok_or("attention read position missing")?;
    let (after_seq, through_seq) = attention_count_range(state)?;
    if interval_count < 0 || interval_count > i64::from(through_seq - after_seq) {
        return Err("invalid attention interval count".into());
    }
    let effective_read_seq = server
        .message_end_seq
        .min(server.last_read_seq.max(local_read_seq));
    let server_read_seq = server.message_end_seq.min(server.last_read_seq);
    let unread = if effective_read_seq > server_read_seq {
        (server.unread_count - interval_count as i32).max(0)
    } else {
        server.unread_count.max(0)
    };
    let has_mention = server
        .last_mention_seq
        .is_some_and(|seq| seq > effective_read_seq);
    Ok(ThreadAttentionProjection {
        thread_id: state.thread_id,
        last_read_seq: effective_read_seq,
        unread_count: unread,
        mention_unread: if has_mention { vec!["me"] } else { vec![] },
        last_message_preview: server.previews.last().map(|preview| match preview.status {
            ThreadPreviewStatus::Live => preview.text.clone().unwrap_or_default(),
            ThreadPreviewStatus::UserRetraction => "[Message retracted]".into(),
            ThreadPreviewStatus::ModerationRemoval => "[Message removed by administrator]".into(),
        }),
        last_message_at: server
            .previews
            .last()
            .and_then(|preview| preview_timestamp_millis(&preview.created_at)),
        last_message_sender_account: server
            .previews
            .last()
            .map(|preview| preview.sender.account.clone()),
        last_message_sender_namespace_id: server
            .previews
            .last()
            .map(|preview| preview.sender.namespace_id),
    })
}

fn project_attention(
    conn: &mut Connection,
    user_id: i64,
    thread_id: i32,
    self_identity: &MessageCountOwner,
) -> Result<ThreadAttentionProjection, String> {
    if thread_id <= 0 {
        return Err("invalid local attention projection".into());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("begin attention projection: {e}"))?;
    let state = read_state(&tx, user_id, thread_id)?;
    if state.server.is_none() {
        return Err("cannot project attention before its feed snapshot".into());
    }
    let (after_seq, through_seq) = attention_count_range(&state)?;
    let count = count_unread_message_slots(
        &tx,
        user_id,
        thread_id,
        after_seq,
        through_seq,
        self_identity,
    )?;
    let projection = project_thread_attention(&state, count)?;
    tx.execute(
        "UPDATE threads SET unread_count=?3,last_read_seq=?4,mention_me=?5,mention_all=0,
             last_message_preview=?6,last_message_at=?7,
             last_message_sender_account=?8,last_message_sender_namespace_id=?9
         WHERE user_id=?1 AND thread_id=?2",
        params![
            user_id,
            thread_id,
            projection.unread_count,
            projection.last_read_seq,
            projection.mention_unread.contains(&"me"),
            projection.last_message_preview,
            projection.last_message_at,
            projection.last_message_sender_account,
            projection.last_message_sender_namespace_id,
        ],
    )
    .map_err(|e| format!("write attention projection: {e}"))?;
    tx.commit()
        .map_err(|e| format!("commit attention projection: {e}"))?;
    Ok(projection)
}

#[tauri::command]
pub(crate) async fn native_db_project_thread_attention(
    user_id: i64,
    thread_id: i32,
    owner: MessageCountOwner,
) -> Result<ThreadAttentionProjection, String> {
    super::lifetime::spawn(move || project_attention(&mut open()?, user_id, thread_id, &owner))
        .await
        .map_err(|e| format!("join attention projection: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_thread_states(
    user_id: i64,
) -> Result<Vec<LocalThreadAttention>, String> {
    super::lifetime::spawn(move || {
        let conn = open()?;
        read_states(&conn, user_id)
    })
    .await
    .map_err(|e| format!("join attention query: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_advance_thread_read(
    user_id: i64,
    thread_id: i32,
    seq: i32,
) -> Result<LocalThreadAttention, String> {
    super::lifetime::spawn(move || advance_read(&mut open()?, user_id, thread_id, seq))
        .await
        .map_err(|e| format!("join attention read: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polling_accepts_an_empty_current_head_but_not_a_stalled_incremental_page() {
        let mut page = ThreadFeedPage {
            items: vec![],
            scanned_through: 5,
            through: 5,
            thread_feed_end_id: 5,
            has_more: false,
        };
        assert!(validate_sync_page(&page, 5, None).is_ok());
        assert!(validate_sync_page(&page, 5, Some(5)).is_err());
        page.has_more = true;
        assert!(validate_sync_page(&page, 5, None).is_err());
        page.has_more = false;
        page.thread_feed_end_id = 6;
        assert!(validate_sync_page(&page, 5, None).is_err());
    }

    #[test]
    fn notification_previews_are_returned_but_only_latest_is_persisted() {
        let mut conn = db();
        let mut snapshot = snapshot(1, 0);
        let mut tomb = preview(9);
        tomb.status = ThreadPreviewStatus::UserRetraction;
        tomb.text = None;
        snapshot.tombstone_end_seq = 2;
        snapshot.last_read_seq = 5;
        snapshot.previews = vec![preview(4), tomb.clone(), preview(6)];
        let merged = merge_states(&mut conn, 1, vec![snapshot], Some(1)).unwrap();
        assert_eq!(merged[0].server.as_ref().unwrap().previews.len(), 3);
        assert_eq!(
            read_state(&conn, 1, 7).unwrap().server.unwrap().previews,
            vec![tomb]
        );
        let persisted: (i32, String, Option<String>) = conn
            .query_row(
                "SELECT seq, status, text FROM thread_previews WHERE user_id=1 AND thread_id=7",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(persisted, (9, "USER_RETRACTION".into(), None));
        let row: (i32, i32) = conn.query_row(
            "SELECT server_last_read_seq, tombstone_end_seq FROM threads WHERE user_id=1 AND thread_id=7",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(row, (5, 2));
        let columns = conn
            .prepare("PRAGMA table_info(threads)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(!columns.contains(&"payload_json".to_string()));
        assert!(columns.contains(&"thread_profile_rev".to_string()));
        assert!(columns.contains(&"subject_name".to_string()));
        let old_state_table: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='thread_states'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(old_state_table, 0);
    }

    #[test]
    fn changed_identity_rolls_back_the_whole_feed_page_and_cursor() {
        let mut conn = db();
        merge_states(&mut conn, 1, vec![snapshot(1, 0)], Some(1)).unwrap();
        let mut other = snapshot(2, 0);
        other.thread_id = 8;
        let mut replacement = snapshot(3, 0);
        replacement.subject_account = "different-peer".into();
        assert!(merge_states(&mut conn, 1, vec![other, replacement], Some(3)).is_err());
        assert_eq!(
            read_state(&conn, 1, 7)
                .unwrap()
                .server
                .unwrap()
                .thread_feed_id,
            1
        );
        assert!(read_state(&conn, 1, 8).unwrap().server.is_none());
        let cursor: Option<i64> = conn
            .query_row(
                "SELECT thread_feed_cursor FROM account_state WHERE user_id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cursor, Some(1));
    }

    #[test]
    fn full_snapshots_reject_missing_previews_and_null_senders_on_decode() {
        let mut value = serde_json::to_value(snapshot(1, 0)).unwrap();
        value.as_object_mut().unwrap().remove("previews");
        assert!(serde_json::from_value::<ThreadFeedSnapshot>(value.clone()).is_err());
        value["previews"] = serde_json::json!([{
            "seq": 1, "createdAt": "2026-01-01T00:00:00Z",
            "sender": null, "status": "LIVE"
        }]);
        assert!(serde_json::from_value::<ThreadFeedSnapshot>(value).is_err());
    }

    #[test]
    fn all_native_requests_use_three_previews() {
        let body: serde_json::Value = serde_json::from_slice(&feed_request(3, 8).unwrap()).unwrap();
        assert_eq!(
            body,
            serde_json::json!({
                "after": 3, "through": 8, "take": 100, "previewCount": 3,
            })
        );
    }

    #[test]
    fn renderer_reads_background_progress_from_its_own_applied_cursor() {
        let mut conn = db();
        merge_states(&mut conn, 1, vec![snapshot(1, 0)], Some(1)).unwrap();
        merge_states(&mut conn, 1, vec![snapshot(3, 0)], Some(3)).unwrap();
        let changes = read_feed_changes(&mut conn, 1, 1).unwrap();
        assert_eq!(changes.cursor, 3);
        assert_eq!(changes.states.len(), 1);
        assert_eq!(changes.states[0].server.as_ref().unwrap().thread_feed_id, 3);
        assert!(read_feed_changes(&mut conn, 1, 3)
            .unwrap()
            .states
            .is_empty());
        assert!(read_feed_changes(&mut conn, 2, 0)
            .unwrap()
            .states
            .is_empty());
    }

    #[test]
    fn thread_feed_page_requires_progress_and_ordered_compacted_items() {
        let mut page = ThreadFeedPage {
            items: vec![snapshot(1, 0), snapshot(2, 0)],
            scanned_through: 2,
            through: 2,
            thread_feed_end_id: 3,
            has_more: false,
        };
        assert!(validate_page(&page, 0, 2).is_ok());
        page.items.reverse();
        assert!(validate_page(&page, 0, 2).is_err());
        page.items.clear();
        assert!(validate_page(&page, 0, 2).is_ok());
        assert!(validate_page(&page, 2, 2).is_err());
        page.scanned_through = 1;
        assert!(validate_page(&page, 0, 2).is_err());
        page.has_more = true;
        assert!(validate_page(&page, 0, 2).is_ok());
    }

    #[test]
    fn cache_schema_rebuild_recreates_attention_without_preserving_old_rows() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE client_preferences(scope TEXT,key TEXT,value_json TEXT,updated_at INTEGER,PRIMARY KEY(scope,key));").unwrap();
        super::super::create_cache_schema(&conn).unwrap();
        super::super::validate_cache_schema(&conn).unwrap();
        merge_states(&mut conn, 1, vec![snapshot(1, 0)], Some(1)).unwrap();
        advance_read(&mut conn, 1, 7, 105).unwrap();
        super::super::drop_cache_schema(&conn).unwrap();
        super::super::create_cache_schema(&conn).unwrap();
        super::super::validate_cache_schema(&conn).unwrap();
        assert_eq!(read_state(&conn, 1, 7).unwrap().local_read_seq, None);
    }

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON; CREATE TABLE client_preferences(scope TEXT,key TEXT,value_json TEXT,updated_at INTEGER,PRIMARY KEY(scope,key));").unwrap();
        super::super::create_cache_schema(&conn).unwrap();
        conn
    }
    #[test]
    fn projects_the_thread_avatar_revision_before_publishing_feed_cursor() {
        let mut conn = db();
        let mut next = snapshot(1, 0);
        next.thread_profile_rev = 2;
        next.thread_profile_rev = 2;
        merge_states(&mut conn, 1, vec![next], Some(1)).unwrap();
        let state = read_state(&conn, 1, 7).unwrap();
        assert_eq!(state.server.unwrap().thread_profile_rev, 2);
        let stored = super::super::thread_store::read(&conn, 1, 7)
            .unwrap()
            .unwrap();
        assert!(stored.get("profileRev").is_none());
        assert!(stored["peerUser"].get("profileRev").is_none());
        super::super::contacts::write_profile(&conn, 1, &serde_json::json!({
            "account":"peer","domain":"local","publisherNamespaceId":0,"profileNamespaceId":0,"profileRev":2,
            "name":"Selected peer","avatarDigest":null,"bio":"Latest",
        })).unwrap();
        let list = super::super::client_state::read_threads(&conn, 1).unwrap();
        assert_eq!(list[0]["profileRev"], 2);
        assert_eq!(list[0]["peerUser"]["name"], "Selected peer");
        assert_eq!(list[0]["peerUser"]["bio"], "Latest");
        assert_eq!(
            super::super::thread_store::read(&conn, 1, 7)
                .unwrap()
                .unwrap()["peerUser"]["name"],
            ""
        );
    }

    fn preview(seq: i32) -> ThreadPreview {
        serde_json::from_value(serde_json::json!({
            "seq": seq,
            "createdAt": "2026-01-01T00:00:00Z",
            "sender": {"account":"peer","profileNamespaceId":0,"profileRev":0},
            "status": "LIVE",
            "text": "message"
        }))
        .unwrap()
    }

    #[test]
    fn committed_departure_cancels_only_matching_meta_flights_and_rejoin_cannot_revive_them() {
        use super::super::thread_feed_commits::{ThreadFeedCommit, THREAD_FEED_COMMITS};
        use std::sync::atomic::Ordering;
        let (token, _subscription) = subscribe_meta_flight(98765, 9, 42);
        let (other_user, _other) = subscribe_meta_flight(98766, 9, 42);
        let (other_epoch, _epoch) = subscribe_meta_flight(98765, 9, 43);
        let mut state = snapshot(2, 0);
        state.thread_id = 9;
        state.kind = "GROUP".into();
        state.conversation_state = "READ_ONLY".into();
        let mut states = vec![LocalThreadAttention {
            thread_id: 9,
            local_read_seq: Some(0),
            server: Some(state),
            notification_changed: false,
        }];
        THREAD_FEED_COMMITS.publish(&ThreadFeedCommit {
            user_id: 98765,
            epoch: 42,
            states: &states,
        });
        assert!(!token.load(Ordering::Acquire));
        assert!(other_user.load(Ordering::Acquire));
        assert!(other_epoch.load(Ordering::Acquire));
        states[0].server.as_mut().unwrap().conversation_state = "ACTIVE".into();
        THREAD_FEED_COMMITS.publish(&ThreadFeedCommit {
            user_id: 98765,
            epoch: 42,
            states: &states,
        });
        assert!(!token.load(Ordering::Acquire));
        let (fresh, _fresh_subscription) = subscribe_meta_flight(98765, 9, 42);
        assert!(fresh.load(Ordering::Acquire));
    }

    fn snapshot(feed: i32, seq: i32) -> ThreadFeedSnapshot {
        ThreadFeedSnapshot {
            kind: "P2P".into(),
            authority_namespace_id: 0,
            self_mention_namespace_id: None,
            conversation_state: "ACTIVE".into(),
            blocked: false,
            role: None,
            subject_account: "peer".into(),
            thread_id: 7,
            thread_feed_id: feed,
            alias: None,
            message_end_seq: 200,
            thread_profile_rev: 0,
            tombstone_end_seq: 0,
            group_meta_feed_end_id: None,
            join_request_end_feed_id: 0,
            join_request_read_feed_id: -1,
            group_invite_end_feed_id: 0,
            last_read_seq: seq,
            announcement_read_feed_id: 0,
            unread_count: 8,
            last_mention_seq: None,
            previews: vec![],
        }
    }
    #[test]
    fn profile_requests_reject_obsolete_selectors_and_unknown_fields() {
        for selector in [
            serde_json::json!({ "type": "EXACT", "account": "peer", "domain": "local",
                "publisherNamespaceId": 0, "profileNamespaceId": 0, "rev": 2 }),
            serde_json::json!({ "type": "MESSAGE_AUTHOR", "threadId": 7, "messageSeq": 1, "rev": 2 }),
            serde_json::json!({ "type": "GROUP_META", "threadId": 7, "profileRev": 2,
                "subject": { "type": "GROUP" } }),
            serde_json::json!({ "publisherNamespaceId": 0, "lookup": "ACCOUNT_PROFILE",
                "target": { "profileNamespaceId": 0, "account": "peer", "rev": 2, "domain": "local" } }),
        ] {
            assert!(parse_profile_request(&selector).is_err());
        }
    }

    #[test]
    fn unevidenced_profile_requests_have_the_same_cache_key() {
        let demand = serde_json::json!({
            "publisherNamespaceId": 3, "lookup": "ACCOUNT_PROFILE",
            "target": { "profileNamespaceId": 5, "account": "peer", "rev": 2 },
        });
        let (key, evidenced) = parse_profile_request(&demand).unwrap();
        let (unevidenced_key, no_evidence) =
            parse_profile_request(&serde_json::json!({ "demand": demand, "evidence": null }))
                .unwrap();
        assert!(!evidenced);
        assert!(no_evidence);
        assert_eq!(
            key.publisher_namespace_id,
            unevidenced_key.publisher_namespace_id
        );
        assert_eq!(
            key.target.profile_namespace_id,
            unevidenced_key.target.profile_namespace_id
        );
        assert_eq!(key.target.account, unevidenced_key.target.account);
        assert_eq!(key.target.rev, unevidenced_key.target.rev);
    }

    #[test]
    fn ready_profiles_do_not_require_display_bindings_or_create_diagonal_bindings() {
        let conn = db();
        let profile = serde_json::json!({
            "publisherNamespaceId": 3, "profileNamespaceId": 5,
            "account": "peer", "rev": 2, "name": "Peer", "bio": "About",
            "avatarBase64": null,
        });
        let snapshot = commit_resolved_profile(&conn, 1, &profile).unwrap();
        assert_eq!(snapshot["name"], "Peer");
        let (key, _) = parse_profile_request(&serde_json::json!({
            "publisherNamespaceId": 3, "lookup": "ACCOUNT_PROFILE",
            "target": { "profileNamespaceId": 5, "account": "peer", "rev": 2 },
        }))
        .unwrap();
        assert_eq!(
            find_profile_for_key(&conn, 1, &key).unwrap().unwrap()["name"],
            "Peer"
        );
        let bindings: i64 = conn
            .query_row("SELECT COUNT(*) FROM profile_namespaces", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(bindings, 0);
        let mut other = key;
        other.publisher_namespace_id = 4;
        assert!(find_profile_for_key(&conn, 1, &other).unwrap().is_none());
    }

    #[test]
    fn group_member_profiles_keep_the_group_publisher_without_diagonal_rekeying() {
        let mut conn = db();
        let mut group = snapshot(1, 0);
        group.kind = "GROUP".into();
        group.role = Some("MEMBER".into());
        group.authority_namespace_id = 7;
        group.authority_namespace_id = 7;
        group.subject_account = "!team".into();
        merge_states(&mut conn, 1, vec![group], None).unwrap();
        conn.execute(
            "INSERT INTO members(user_id,thread_id,member_account,namespace_id,role,profile_rev)
             VALUES(1,7,'alice',2,'MEMBER',3)",
            [],
        )
        .unwrap();
        let reference = GroupMetaProfileReference {
            is_group: false,
            thread_id: 7,
            account: "alice".into(),
            namespace_id: 2,
            rev: 3,
        };
        let mut profile = serde_json::json!({
            "publisherNamespaceId": 2, "profileNamespaceId": 2,
            "account": "alice", "rev": 3, "name": "Wrong diagonal", "bio": "",
            "avatarBase64": null,
        });
        commit_resolved_profile(&conn, 1, &profile).unwrap();
        assert_eq!(unresolved_group_meta_profiles(&conn, 1).unwrap().len(), 1);
        profile["publisherNamespaceId"] = serde_json::json!(7);
        profile["name"] = serde_json::json!("Correct publisher");
        commit_group_meta_profile(&conn, 1, &reference, &profile).unwrap();
        let exact = super::super::contacts::read_profile(&conn, 1, 7, 2, "alice", 3)
            .unwrap()
            .unwrap();
        assert_eq!(exact["name"], "Correct publisher");
        let diagonal = super::super::contacts::read_profile(&conn, 1, 2, 2, "alice", 3)
            .unwrap()
            .unwrap();
        assert_eq!(diagonal["name"], "Wrong diagonal");
        assert!(unresolved_group_meta_profiles(&conn, 1).unwrap().is_empty());
    }

    #[test]
    fn group_meta_ready_uses_current_coordinates_without_a_wire_domain() {
        let mut conn = db();
        let mut group = snapshot(1, 0);
        group.kind = "GROUP".into();
        group.role = Some("OWNER".into());
        group.subject_account = "!team".into();
        group.thread_profile_rev = 2;
        group.thread_profile_rev = 2;
        merge_states(&mut conn, 1, vec![group], None).unwrap();
        let reference = GroupMetaProfileReference {
            is_group: true,
            thread_id: 7,
            account: "!team".into(),
            namespace_id: 0,
            rev: 2,
        };
        let mut profile = serde_json::json!({
            "publisherNamespaceId": 0, "profileNamespaceId": 0,
            "account": "!team", "rev": 2, "name": "Team", "bio": "About",
            "avatarBase64": null,
        });
        profile["rev"] = serde_json::json!(3);
        assert!(commit_group_meta_profile(&conn, 1, &reference, &profile).is_err());
        profile["rev"] = serde_json::json!(2);
        commit_group_meta_profile(&conn, 1, &reference, &profile).unwrap();
        let stored = super::super::thread_store::read(&conn, 1, 7)
            .unwrap()
            .unwrap();
        assert_eq!(stored["group"]["name"], "Team");
        assert!(unresolved_group_meta_profiles(&conn, 1).unwrap().is_empty());
    }

    #[test]
    fn exact_profile_key_uses_the_typed_cache() {
        let conn = db();
        super::super::contacts::register_namespace(&conn, 1, 0, "local").unwrap();
        super::super::contacts::write_profile(&conn, 1, &serde_json::json!({
            "account": "peer", "domain": "local", "publisherNamespaceId": 0, "profileNamespaceId": 0,
            "profileRev": 2, "name": "Peer", "avatarDigest": null, "bio": "About",
        })).unwrap();
        let (key, _) = parse_profile_request(&serde_json::json!({
            "publisherNamespaceId": 0, "lookup": "ACCOUNT_PROFILE",
            "target": { "profileNamespaceId": 0, "account": "peer", "rev": 2 },
        }))
        .unwrap();
        let actual = find_profile_for_key(&conn, 1, &key).unwrap();
        assert_eq!(
            actual,
            Some(serde_json::json!({
                "account": "peer", "domain": "local", "namespaceId": 0,
                "publisherNamespaceId": 0, "profileNamespaceId": 0,
                "profileRev": 2, "name": "Peer", "avatarDigest": null, "bio": "About",
            }))
        );
    }

    #[test]
    fn group_profile_demand_reads_the_exact_revision() {
        let mut conn = db();
        let mut group = snapshot(1, 0);
        group.kind = "GROUP".into();
        group.role = Some("OWNER".into());
        group.subject_account = "!team".into();
        group.thread_profile_rev = 2;
        group.thread_profile_rev = 2;
        merge_states(&mut conn, 1, vec![group], None).unwrap();
        super::super::contacts::write_profile(&conn, 1, &serde_json::json!({
            "account": "!team", "domain": "local", "publisherNamespaceId": 0, "profileNamespaceId": 0,
            "profileRev": 2, "name": "Team", "avatarDigest": null, "bio": "",
        })).unwrap();
        assert!(super::super::thread_store::read(&conn, 1, 7)
            .unwrap()
            .unwrap()
            .get("profileRev")
            .is_none());
        let (key, _) = parse_profile_request(&serde_json::json!({
            "publisherNamespaceId": 0, "lookup": "ACCOUNT_PROFILE",
            "target": { "profileNamespaceId": 0, "account": "!team", "rev": 2 },
        }))
        .unwrap();
        assert_eq!(
            find_profile_for_key(&conn, 1, &key).unwrap().unwrap()["name"],
            "Team"
        );
        assert!(unresolved_group_meta_profiles(&conn, 1).unwrap().is_empty());
    }

    #[test]
    fn namespace_identity_validation_uses_namespace_coordinates() {
        let mut invalid = snapshot(1, 0);
        invalid.authority_namespace_id = -1;
        assert!(validate_snapshot(&invalid).is_err());
        invalid.authority_namespace_id = 2;
        assert!(validate_snapshot(&invalid).is_ok());
    }

    #[test]
    fn thread_feed_response_decodes_the_shared_wire_shape() {
        // Mirrors the server response built by ThreadFeedService (backend) and the shared
        // ThreadFeedSnapshot type: flat publisher/profile coordinates, no nested profile
        // object, sender carries profileNamespaceId. This guards against wire drift.
        let body = serde_json::json!({
            "code": 0,
            "data": {
                "threadFeedEndId": 4, "through": 4, "scannedThrough": 4, "hasMore": false,
                "items": [{
                    "threadId": 10, "threadFeedId": 1, "type": "P2P",
                    "publisherNamespaceId": 0, "conversationState": "ACTIVE",
                    "selfMentionNamespaceId": null,
                    "blocked": false, "role": null, "profileAccount": "bob",
                    "profileRev": 3, "alias": "Pal",
                    "messageEndSeq": 7, "tombstoneEndSeq": 0, "groupMetaFeedEndId": null,
                    "joinRequestEndFeedId": 0, "joinRequestReadFeedId": -1,
                    "groupInviteEndFeedId": 0, "lastReadSeq": 0,
                    "announcementReadFeedId": 0, "unreadCount": 2, "lastMentionSeq": null,
                    "previews": [{
                        "seq": 7, "createdAt": "2026-10-15T00:00:00.000Z",
                        "sender": {"account": "bob", "profileNamespaceId": 0, "profileRev": 3},
                        "status": "LIVE", "text": "hello",
                    }],
                }],
            },
        });
        let page = serde_json::from_value::<ThreadFeedResponse>(body)
            .unwrap()
            .data
            .unwrap();
        assert_eq!(page.items.len(), 1);
        let item = &page.items[0];
        assert_eq!(item.authority_namespace_id, 0);
        assert_eq!(item.subject_account, "bob");
        assert_eq!(item.thread_profile_rev, 3);
        assert_eq!(item.previews[0].sender.namespace_id, 0);
        assert_eq!(item.previews[0].sender.profile_rev, 3);
        validate_page(&page, 0, 4).unwrap();
        validate_snapshot(item).unwrap();
    }

    #[test]
    fn thread_states_serialize_flat_for_the_webview_contract() {
        // The WebView consumes shared/thread-attention.ts LocalThreadAttention: a FLAT
        // snapshot plus localReadSeq. A nested `server` object breaks isThreadStateSnapshot
        // and silently aborts onHello (observed on device as navigationReady never set).
        let mut conn = db();
        merge_states(&mut conn, 1, vec![snapshot(1, 0)], Some(1)).unwrap();
        let states = read_states(&conn, 1).unwrap();
        assert_eq!(states.len(), 1);
        let json = serde_json::to_value(&states[0]).unwrap();
        assert!(json.get("server").is_none());
        for key in [
            "threadId",
            "threadFeedId",
            "type",
            "publisherNamespaceId",
            "conversationState",
            "blocked",
            "profileAccount",
            "profileRev",
            "localReadSeq",
        ] {
            assert!(json.get(key).is_some(), "missing flat key {key}");
        }
        assert_eq!(json["profileAccount"], "peer");
        assert_eq!(json["localReadSeq"], 0);
        // Round-trip through the WebView-side guard semantics: every integer coordinate
        // the TS guard checks must be present and integral.
        assert!(json["threadFeedId"].is_i64());
        assert!(json["publisherNamespaceId"].is_i64());
    }

    #[test]
    fn thread_feed_identity_roundtrips_without_domains_and_ignores_display_changes() {
        let mut conn = db();
        let mut feed = snapshot(1, 0);
        feed.authority_namespace_id = 7;
        feed.self_mention_namespace_id = Some(12);
        feed.previews = vec![serde_json::from_value(serde_json::json!({
            "seq": 1, "createdAt": "2026-01-01T00:00:00Z",
            "sender": {"account": "alice", "profileNamespaceId": 2, "profileRev": 3},
            "status": "LIVE", "text": "Hello",
        }))
        .unwrap()];
        let wire = serde_json::to_value(&feed).unwrap();
        // The wire shape is the flat shared protocol: no nested profile object, no domains.
        assert_eq!(wire["profileAccount"], "peer");
        assert_eq!(wire["publisherNamespaceId"], 7);
        assert_eq!(wire["selfMentionNamespaceId"], 12);
        let mut missing = wire.clone();
        missing
            .as_object_mut()
            .unwrap()
            .remove("selfMentionNamespaceId");
        assert!(serde_json::from_value::<ThreadFeedSnapshot>(missing).is_err());
        assert_eq!(wire["previews"][0]["sender"]["profileNamespaceId"], 2);
        assert!(wire.get("profile").is_none());
        assert!(wire.get("domain").is_none());
        assert!(wire["previews"][0]["sender"].get("domain").is_none());
        for (pointer, key) in [("", "domain"), ("/previews/0/sender", "domain")] {
            let mut leaked = wire.clone();
            let target = if pointer.is_empty() {
                &mut leaked
            } else {
                leaked.pointer_mut(pointer).unwrap()
            };
            target[key] = "local".into();
            assert!(serde_json::from_value::<ThreadFeedSnapshot>(leaked).is_err());
        }
        merge_states(&mut conn, 1, vec![feed.clone()], None).unwrap();
        assert_eq!(read_state(&conn, 1, 7).unwrap().server, Some(feed.clone()));
        for domain in ["local", "renamed.test"] {
            super::super::contacts::register_namespace(&conn, 1, 7, domain).unwrap();
            conn.execute(
                "UPDATE profile_namespaces SET domain=?1 WHERE user_id=1",
                [domain],
            )
            .unwrap();
            let state = read_state(&conn, 1, 7).unwrap();
            write_state(&conn, 1, &state).unwrap();
            assert_eq!(state.server, Some(feed.clone()));
            let presentation = super::super::thread_store::read(&conn, 1, 7)
                .unwrap()
                .unwrap();
            assert_eq!(presentation["peerUser"]["domain"], domain);
        }
        let mut wrong = read_state(&conn, 1, 7).unwrap();
        wrong.server.as_mut().unwrap().authority_namespace_id = 8;
        assert!(write_state(&conn, 1, &wrong).is_err());
        for table in ["threads", "thread_previews"] {
            let mut statement = conn
                .prepare(&format!("PRAGMA table_info({table})"))
                .unwrap();
            let columns: Vec<String> = statement
                .query_map([], |row| row.get(1))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            assert!(!columns.iter().any(|column| column.ends_with("domain")));
        }
    }

    #[test]
    fn nullable_snapshot_fields_still_must_be_present() {
        let snapshot = serde_json::to_value(snapshot(1, 0)).unwrap();
        for key in ["alias", "role", "groupMetaFeedEndId", "lastMentionSeq"] {
            let mut missing = snapshot.clone();
            missing.as_object_mut().unwrap().remove(key);
            assert!(
                serde_json::from_value::<ThreadFeedSnapshot>(missing).is_err(),
                "{key}"
            );
        }
    }

    #[test]
    fn decodes_server_announcement_read_cursor() {
        let mut value = serde_json::to_value(snapshot(8, 2)).unwrap();
        value["announcementReadFeedId"] = serde_json::json!(4);
        let decoded: ThreadFeedSnapshot = serde_json::from_value(value).unwrap();
        assert_eq!(decoded.announcement_read_feed_id, 4);
        assert!(validate_snapshot(&decoded).is_ok());
    }

    #[test]
    fn aliases_follow_the_feed_and_metadata_only_changes_do_not_notify() {
        let mut conn = db();
        let mut first = snapshot(1, 0);
        first.alias = Some("Private".into());
        assert!(
            merge_states(&mut conn, 1, vec![first.clone()], Some(1)).unwrap()[0]
                .notification_changed
        );
        let mut cleared = first.clone();
        cleared.thread_feed_id = 2;
        cleared.alias = None;
        let result = merge_states(&mut conn, 1, vec![cleared], Some(2)).unwrap();
        assert!(!result[0].notification_changed);
        merge_states(&mut conn, 1, vec![first], Some(1)).unwrap();
        let state = read_state(&conn, 1, 7).unwrap();
        assert_eq!(state.server.as_ref().unwrap().alias, None);
        assert_eq!(state.server.as_ref().unwrap().thread_feed_id, 2);
        let mut encoded = serde_json::to_value(snapshot(3, 0)).unwrap();
        encoded.as_object_mut().unwrap().remove("alias");
        assert!(serde_json::from_value::<ThreadFeedSnapshot>(encoded).is_err());
    }

    #[test]
    fn snapshot_merge_preserves_local_position_and_orders_by_feed() {
        let mut conn = db();
        merge_states(&mut conn, 1, vec![snapshot(1, 0)], None).unwrap();
        advance_read(&mut conn, 1, 7, 105).unwrap();
        for (feed, seq) in [(2, 110), (1, 120), (2, 130), (3, 95)] {
            merge_states(&mut conn, 1, vec![snapshot(feed, seq)], None).unwrap();
        }
        let state = read_state(&conn, 1, 7).unwrap();
        assert_eq!(state.local_read_seq, Some(105));
        assert_eq!(state.server, Some(snapshot(3, 95)));
        assert_eq!(advance_read(&mut conn, 1, 7, 100).unwrap(), state);
        assert_eq!(read_state(&conn, 2, 7).unwrap().server, None);
    }
    #[test]
    fn partial_snapshots_do_not_advance_cursor_and_empty_pages_can() {
        let mut conn = db();
        merge_states(&mut conn, 1, vec![snapshot(50, 100)], None).unwrap();
        let cursor: Option<i64> = conn
            .query_row(
                "SELECT thread_feed_cursor FROM account_state WHERE user_id=1",
                [],
                |r| r.get(0),
            )
            .optional()
            .unwrap()
            .flatten();
        assert_eq!(cursor, None);
        for cursor in [20, 10, 30] {
            merge_states(&mut conn, 1, vec![], Some(cursor)).unwrap();
        }
        let final_cursor: i64 = conn
            .query_row(
                "SELECT thread_feed_cursor FROM account_state WHERE user_id=1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(final_cursor, 30);
        assert_eq!(read_state(&conn, 1, 7).unwrap().local_read_seq, Some(100));
    }
    #[test]
    fn failed_cursor_write_rolls_back_rows() {
        let mut conn = db();
        conn.execute_batch("CREATE TRIGGER fail_cursor BEFORE INSERT ON account_state BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
        assert!(merge_states(&mut conn, 1, vec![snapshot(1, 100)], Some(1)).is_err());
        assert_eq!(read_state(&conn, 1, 7).unwrap().server, None);
    }
}

fn read_cursor(conn: &Connection, user_id: i64) -> Result<i32, String> {
    let cursor: Option<i64> = conn
        .query_row(
            "SELECT thread_feed_cursor FROM account_state WHERE user_id=?1",
            [user_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("read thread feed cursor: {e}"))?;
    let cursor = cursor.unwrap_or(0);
    if !(0..=i32::MAX as i64).contains(&cursor) {
        return Err("invalid local thread feed cursor".into());
    }
    Ok(cursor as i32)
}

fn read_states(conn: &Connection, user_id: i64) -> Result<Vec<LocalThreadAttention>, String> {
    let mut query = conn
        .prepare("SELECT thread_id FROM threads WHERE user_id=?1 ORDER BY thread_id")
        .map_err(|e| format!("prepare attention query: {e}"))?;
    let ids = query
        .query_map([user_id], |row| row.get::<_, i32>(0))
        .map_err(|e| format!("query attention: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read attention ids: {e}"))?;
    ids.into_iter()
        .map(|id| read_state(conn, user_id, id))
        .collect()
}
