use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use super::client_state::{ClientGroupMetaApply, ClientGroupMetaPage};
use super::open;
use crate::{proxy::perform_api_request_with_events, ProxyState};

// All native feed consumers share cursor ownership, including notification wakes.
// This is not the cache lifetime lock: network waits must not block account cleanup.
static THREAD_FEED_SYNC: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
    let namespace_id = profile
        .get("namespaceId")
        .and_then(Value::as_i64)
        .ok_or("resolved profile has no namespace")?;
    let account = profile
        .get("account")
        .and_then(Value::as_str)
        .ok_or("resolved profile has no account")?;
    let domain = profile
        .get("domain")
        .and_then(Value::as_str)
        .ok_or("resolved profile has no domain")?;
    let profile_rev = profile
        .get("rev")
        .and_then(Value::as_i64)
        .ok_or("resolved profile has no revision")?;
    let name = profile
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(account);
    let bio = profile.get("bio").and_then(Value::as_str).unwrap_or("");
    let avatar = profile
        .get("avatarBase64")
        .and_then(Value::as_str)
        .map(|value| format!("data:image/webp;base64,{value}"))
        .unwrap_or_default();
    super::contacts::register_namespace(conn, user_id, namespace_id, domain)?;
    let snapshot = serde_json::json!({
        "account": account,
        "domain": domain,
        "namespaceId": namespace_id,
        "profileRev": profile_rev,
        "name": name,
        "avatar": avatar,
        "bio": bio,
    });
    super::contacts::write_profile(conn, user_id, &snapshot)?;
    Ok(snapshot)
}

fn find_profile_for_evidence(
    conn: &Connection,
    user_id: i64,
    selector: &Value,
) -> Result<Option<Value>, String> {
    let kind = selector
        .get("type")
        .and_then(Value::as_str)
        .ok_or("profile evidence has no type")?;
    let payload: Option<String> = match kind {
        "EXACT" => conn
            .query_row(
                "SELECT profile.payload_json FROM profiles profile
                 JOIN namespaces namespace
                   ON namespace.user_id=profile.user_id
                  AND namespace.domain=profile.domain
                  AND namespace.namespace_id=profile.namespace_id
                 WHERE profile.user_id=?1 AND profile.account=?2
                   AND profile.domain=?3 AND profile.profile_rev=?4
                   AND namespace.status='ACTIVE'
                 ORDER BY profile.namespace_id DESC LIMIT 1",
                params![
                    user_id,
                    selector.get("account").and_then(Value::as_str).ok_or("exact evidence has no account")?,
                    selector.get("domain").and_then(Value::as_str).ok_or("exact evidence has no domain")?,
                    selector.get("rev").and_then(Value::as_i64).ok_or("exact evidence has no revision")?
                ],
                |row| row.get(0),
            )
            .optional(),
        "MESSAGE_AUTHOR" => conn
            .query_row(
                "SELECT profile.payload_json FROM messages message
                 JOIN profiles profile
                   ON profile.user_id=message.user_id
                  AND profile.account=json_extract(message.payload_json,'$.creator.account')
                  AND profile.domain=json_extract(message.payload_json,'$.creator.domain')
                  AND profile.namespace_id=json_extract(message.payload_json,'$.creator.namespaceId')
                  AND profile.profile_rev=json_extract(message.payload_json,'$.profileRev')
                 WHERE message.user_id=?1 AND message.thread_id=?2 AND message.seq=?3
                   AND json_extract(message.payload_json,'$.profileRev')=?4",
                params![
                    user_id,
                    selector.get("threadId").and_then(Value::as_i64).ok_or("message evidence has no thread")?,
                    selector.get("messageSeq").and_then(Value::as_i64).ok_or("message evidence has no sequence")?,
                    selector.get("rev").and_then(Value::as_i64).ok_or("message evidence has no revision")?
                ],
                |row| row.get(0),
            )
            .optional(),
        "GROUP_META" => {
            let thread_id = selector
                .get("threadId")
                .and_then(Value::as_i64)
                .ok_or("Group Meta evidence has no thread")?;
            let rev = selector
                .get("profileRev")
                .and_then(Value::as_i64)
                .ok_or("Group Meta evidence has no revision")?;
            let subject = selector.get("subject").ok_or("Group Meta evidence has no subject")?;
            match subject.get("type").and_then(Value::as_str) {
                Some("GROUP") => conn
                    .query_row(
                        "SELECT profile.payload_json FROM threads thread
                         JOIN profiles profile
                           ON profile.user_id=thread.user_id
                          AND profile.account=json_extract(thread.payload_json,'$.group.account')
                          AND profile.domain=json_extract(thread.payload_json,'$.group.domain')
                          AND profile.namespace_id=json_extract(thread.payload_json,'$.group.namespaceId')
                          AND profile.profile_rev=json_extract(thread.payload_json,'$.group.profileRev')
                         WHERE thread.user_id=?1 AND thread.thread_id=?2
                           AND json_extract(thread.payload_json,'$.type')='GROUP'
                           AND json_extract(thread.payload_json,'$.group.profileRev')=?3",
                        params![user_id, thread_id, rev],
                        |row| row.get(0),
                    )
                    .optional(),
                Some("MEMBER") => conn
                    .query_row(
                        "SELECT profile.payload_json FROM members member
                         JOIN profiles profile
                           ON profile.user_id=member.user_id
                          AND profile.account=member.member_account
                          AND profile.domain=member.member_domain
                          AND profile.namespace_id=member.namespace_id
                          AND profile.profile_rev=member.profile_rev
                         WHERE member.user_id=?1 AND member.thread_id=?2
                           AND member.member_account=?3 AND member.member_domain=?4
                           AND member.profile_rev=?5 AND member.left_state=0",
                        params![
                            user_id,
                            thread_id,
                            subject.get("account").and_then(Value::as_str).ok_or("member evidence has no account")?,
                            subject.get("domain").and_then(Value::as_str).ok_or("member evidence has no domain")?,
                            rev
                        ],
                        |row| row.get(0),
                    )
                    .optional(),
                _ => return Err("invalid Group Meta evidence subject".into()),
            }
        }
        _ => return Err("invalid profile evidence type".into()),
    }
    .map_err(|e| format!("read cached profile evidence: {e}"))?;
    payload.map(super::parse_json).transpose()
}

#[tauri::command]
pub(crate) async fn native_profile_resolve(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ProxyState>,
    user_id: i64,
    selector: Value,
) -> Result<Value, String> {
    resolve_profile(&app, &proxy, user_id, selector).await
}

async fn resolve_profile(
    app: &tauri::AppHandle,
    proxy: &ProxyState,
    user_id: i64,
    selector: Value,
) -> Result<Value, String> {
    if user_id <= 0 || !selector.is_object() {
        return Err("invalid profile resolution request".into());
    }
    let epoch = super::lifetime::CACHE_LIFETIME.capture()?;
    let cached_selector = selector.clone();
    if let Some(profile) = super::lifetime::spawn_at(Ok(epoch), move || {
        find_profile_for_evidence(&open()?, user_id, &cached_selector)
    })
    .await
    .map_err(|e| format!("join cached profile lookup: {e}"))??
    {
        return Ok(serde_json::json!({ "status": "READY", "profile": profile }));
    }
    let response = perform_api_request_with_events(
        Some(app),
        proxy,
        "POST".into(),
        "/api/v1/user/profile-resolution".into(),
        std::collections::HashMap::from([("content-type".into(), "application/json".into())]),
        Some(serde_json::to_vec(&selector).map_err(|e| e.to_string())?),
        true,
    )
    .await?;
    if !(200..300).contains(&response.status) {
        return Err(format!("profile-resolution HTTP {}", response.status));
    }
    let envelope: GroupMetaResponse = serde_json::from_str(&response.body)
        .map_err(|e| format!("decode profile-resolution response: {e}"))?;
    if envelope.code != 0 {
        return Err("profile resolution failed".into());
    }
    let data = envelope.data.ok_or("missing profile-resolution result")?;
    if data.get("status").and_then(Value::as_str) == Some("PENDING") {
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
    app: &tauri::AppHandle,
    proxy: &ProxyState,
    user_id: i64,
    key: &Value,
) -> Result<(), String> {
    let namespace_id = key
        .get("namespaceId")
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0)
        .ok_or("profile event has no namespace")?;
    let account = key
        .get("account")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("profile event has no account")?;
    let domain = key
        .get("domain")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("profile event has no domain")?;
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
            "type": "EXACT",
            "account": account,
            "domain": domain,
            "rev": rev,
        }),
    )
    .await?;
    if result.get("status").and_then(Value::as_str) != Some("READY") {
        return Err("profile event did not resolve from backend cache".into());
    }
    let profile = result
        .get("profile")
        .ok_or("resolved profile event has no profile")?;
    if profile.get("namespaceId").and_then(Value::as_i64) != Some(namespace_id)
        || profile.get("account").and_then(Value::as_str) != Some(account)
        || profile.get("domain").and_then(Value::as_str) != Some(domain)
        || profile.get("profileRev").and_then(Value::as_i64) != Some(rev)
    {
        return Err("resolved profile does not match profile event key".into());
    }
    Ok(())
}

struct GroupMetaPlan {
    thread_id: i64,
    account: String,
    source_server: String,
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
    domain: String,
    namespace_id: i64,
    rev: i64,
}

fn commit_group_meta_profile(
    conn: &Connection,
    user_id: i64,
    reference: &GroupMetaProfileReference,
    profile: &Value,
) -> Result<(), String> {
    if profile.get("account").and_then(Value::as_str) != Some(&reference.account)
        || profile.get("domain").and_then(Value::as_str) != Some(&reference.domain)
    {
        return Err("resolved profile revision does not match Group Meta".into());
    }
    let actual_rev = profile
        .get("rev")
        .and_then(Value::as_i64)
        .ok_or("resolved profile has no revision")?;
    let current: bool = if reference.is_group {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM threads WHERE user_id=?1 AND thread_id=?2
             AND json_extract(payload_json,'$.type')='GROUP'
             AND json_extract(payload_json,'$.group.account')=?3
             AND json_extract(payload_json,'$.group.domain')=?4
             AND json_extract(payload_json,'$.group.namespaceId')=?5
             AND json_extract(payload_json,'$.group.profileRev')=?6)",
            params![
                user_id,
                reference.thread_id,
                reference.account,
                reference.domain,
                reference.namespace_id,
                reference.rev
            ],
            |row| row.get(0),
        )
    } else {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM members WHERE user_id=?1 AND thread_id=?2
             AND member_account=?3 AND member_domain=?4 AND namespace_id=?5
             AND profile_rev=?6 AND left_state=0)",
            params![
                user_id,
                reference.thread_id,
                reference.account,
                reference.domain,
                reference.namespace_id,
                reference.rev
            ],
            |row| row.get(0),
        )
    }
    .map_err(|e| format!("validate Group Meta profile reference: {e}"))?;
    if !current {
        return Ok(());
    }
    let avatar = profile
        .get("avatarBase64")
        .and_then(Value::as_str)
        .map(|value| format!("data:image/webp;base64,{value}"))
        .unwrap_or_default();
    super::contacts::register_namespace(conn, user_id, reference.namespace_id, &reference.domain)?;
    super::contacts::write_profile(
        conn,
        user_id,
        &serde_json::json!({
            "account": reference.account,
            "domain": reference.domain,
            "namespaceId": reference.namespace_id,
            "profileRev": actual_rev,
            "name": profile.get("name").and_then(Value::as_str).unwrap_or(&reference.account),
            "avatar": avatar,
            "bio": profile.get("bio").and_then(Value::as_str).unwrap_or(""),
        }),
    )?;
    if reference.is_group && actual_rev == reference.rev {
        conn.execute(
            "UPDATE threads SET payload_json=json_set(payload_json,
               '$.group.name', ?3, '$.group.avatar', ?4, '$.group.description', ?5)
             WHERE user_id=?1 AND thread_id=?2",
            params![
                user_id,
                reference.thread_id,
                profile
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&reference.account),
                avatar,
                profile.get("bio").and_then(Value::as_str).unwrap_or("")
            ],
        )
        .map_err(|e| format!("update resolved group profile: {e}"))?;
    }
    Ok(())
}

async fn resolve_group_meta_profile(
    app: Option<&tauri::AppHandle>,
    proxy: &ProxyState,
    user_id: i64,
    epoch: u64,
    reference: GroupMetaProfileReference,
) -> Result<bool, String> {
    let selector = if reference.is_group {
        serde_json::json!({
            "type": "GROUP_META", "threadId": reference.thread_id,
            "profileRev": reference.rev, "subject": { "type": "GROUP" },
        })
    } else {
        serde_json::json!({
            "type": "GROUP_META", "threadId": reference.thread_id,
            "profileRev": reference.rev,
            "subject": { "type": "MEMBER", "account": reference.account,
                         "domain": reference.domain },
        })
    };
    let response = perform_api_request_with_events(
        app,
        proxy,
        "POST".into(),
        "/api/v1/user/profile-resolution".into(),
        std::collections::HashMap::from([("content-type".into(), "application/json".into())]),
        Some(serde_json::to_vec(&selector).map_err(|e| e.to_string())?),
        true,
    )
    .await?;
    if !(200..300).contains(&response.status) {
        return Err(format!("profile-resolution HTTP {}", response.status));
    }
    let envelope: GroupMetaResponse = serde_json::from_str(&response.body)
        .map_err(|e| format!("decode profile-resolution response: {e}"))?;
    if envelope.code != 0 {
        return Err("profile resolution failed".into());
    }
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
            "SELECT thread_id, json_extract(payload_json,'$.group.account'),
                    json_extract(payload_json,'$.group.domain'),
                    json_extract(payload_json,'$.group.namespaceId'),
                    json_extract(payload_json,'$.group.profileRev')
             FROM threads
             WHERE user_id=?1 AND json_extract(payload_json,'$.type')='GROUP'
               AND COALESCE(json_extract(payload_json,'$.conversationState'),'ACTIVE') <> 'READ_ONLY'
               AND CAST(json_extract(payload_json,'$.group.profileRev') AS INTEGER) > 0
               AND NOT EXISTS (
                 SELECT 1 FROM profiles profile WHERE profile.user_id=?1
                   AND profile.account=json_extract(threads.payload_json,'$.group.account')
                   AND profile.domain=json_extract(threads.payload_json,'$.group.domain')
                   AND profile.namespace_id=json_extract(threads.payload_json,'$.group.namespaceId')
                   AND profile.profile_rev=json_extract(threads.payload_json,'$.group.profileRev'))",
        )
        .map_err(|e| format!("prepare unresolved group profiles: {e}"))?;
    let rows = groups
        .query_map([user_id], |row| {
            Ok(GroupMetaProfileReference {
                is_group: true,
                thread_id: row.get(0)?,
                account: row.get(1)?,
                domain: row.get(2)?,
                namespace_id: row.get(3)?,
                rev: row.get(4)?,
            })
        })
        .map_err(|e| format!("query unresolved group profiles: {e}"))?;
    for row in rows {
        references.push(row.map_err(|e| format!("read unresolved group profile: {e}"))?);
    }
    let mut members = conn
        .prepare(
            "SELECT member.thread_id, member.member_account, member.member_domain,
                    member.namespace_id, member.profile_rev
             FROM members member
             WHERE member.user_id=?1 AND member.left_state=0 AND member.profile_rev>0
               AND member.profile_message_seq IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM profiles profile WHERE profile.user_id=member.user_id
                   AND profile.account=member.member_account
                   AND profile.domain=member.member_domain
                   AND profile.namespace_id=member.namespace_id
                   AND profile.profile_rev=member.profile_rev)",
        )
        .map_err(|e| format!("prepare unresolved member profiles: {e}"))?;
    let rows = members
        .query_map([user_id], |row| {
            Ok(GroupMetaProfileReference {
                is_group: false,
                thread_id: row.get(0)?,
                account: row.get(1)?,
                domain: row.get(2)?,
                namespace_id: row.get(3)?,
                rev: row.get(4)?,
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
            "SELECT thread.thread_id, thread.payload_json, state.payload_json
             FROM threads thread JOIN thread_states state
               ON state.user_id=thread.user_id AND state.thread_id=thread.thread_id
             WHERE thread.user_id=?1 AND json_extract(thread.payload_json,'$.type')='GROUP'
               AND COALESCE(json_extract(thread.payload_json,'$.conversationState'),'ACTIVE') <> 'READ_ONLY'",
        )
        .map_err(|e| format!("prepare group-meta plans: {e}"))?;
    let rows = statement
        .query_map([user_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| format!("query group-meta plans: {e}"))?;
    let mut plans = Vec::new();
    for row in rows {
        let (thread_id, thread_json, state_json) =
            row.map_err(|e| format!("read group-meta plan: {e}"))?;
        let thread: Value =
            serde_json::from_str(&thread_json).map_err(|e| format!("decode group thread: {e}"))?;
        let state: LocalThreadAttention = serde_json::from_str(&state_json)
            .map_err(|e| format!("decode group thread head: {e}"))?;
        let Some(target) = state
            .server
            .and_then(|server| server.group_meta_feed_end_id)
        else {
            continue;
        };
        let group = &thread["group"];
        let account = group["account"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or("group-meta plan has no group account")?;
        let source_server = group["domain"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or("group-meta plan has no source server")?;
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
            source_server: source_server.to_owned(),
            namespace_id,
            target,
            processed_through: processed_through.to_owned(),
            recovery_through,
        });
    }
    Ok(plans)
}

async fn sync_group_meta(
    app: Option<&tauri::AppHandle>,
    proxy: &ProxyState,
    user_id: i64,
    epoch: u64,
) -> (Vec<i64>, Option<String>) {
    let mut changed = Vec::new();
    let result = sync_group_meta_unchecked(app, proxy, user_id, epoch, &mut changed).await;
    changed.sort_unstable();
    changed.dedup();
    (changed, result.err())
}

async fn sync_group_meta_unchecked(
    app: Option<&tauri::AppHandle>,
    proxy: &ProxyState,
    user_id: i64,
    epoch: u64,
    changed: &mut Vec<i64>,
) -> Result<(), String> {
    let plans = super::lifetime::spawn_at(Ok(epoch), move || group_meta_plans(&open()?, user_id))
        .await
        .map_err(|e| format!("join group-meta plan read: {e}"))??;
    for plan in plans {
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
            .await?;
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
                source_server: plan.source_server.clone(),
                namespace_id: plan.namespace_id,
                page,
            };
            super::lifetime::spawn_at(Ok(epoch), move || {
                super::client_state::apply_group_meta_page(&mut open()?, user_id, update)
            })
            .await
            .map_err(|e| format!("join group-meta page commit: {e}"))??;
            changed.push(plan.thread_id);
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
    let references = super::lifetime::spawn_at(Ok(epoch), move || {
        unresolved_group_meta_profiles(&open()?, user_id)
    })
    .await
    .map_err(|e| format!("join unresolved Group Meta profile read: {e}"))??;
    for reference in references {
        let thread_id = reference.thread_id;
        if resolve_group_meta_profile(app, proxy, user_id, epoch, reference).await? {
            changed.push(thread_id);
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadFeedSyncResult {
    pub(crate) states: Vec<LocalThreadAttention>,
    pub(crate) cursor: i32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) group_thread_ids: Vec<i64>,
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

/// The source executor owns HTTP pagination and atomic snapshot/cursor commits without a renderer.
#[tauri::command]
pub(crate) async fn native_thread_feed_sync(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ProxyState>,
    user_id: i64,
    target: i32,
    after: i32,
) -> Result<ThreadFeedSyncResult, String> {
    if after < 0 {
        return Err("invalid applied thread feed cursor".into());
    }
    let epoch = super::lifetime::CACHE_LIFETIME.capture()?;
    let result = sync_thread_feed(Some(&app), &proxy, user_id, target).await?;
    super::lifetime::spawn_at(Ok(epoch), move || {
        let mut changes = read_feed_changes(&mut open()?, user_id, after)?;
        for state in &mut changes.states {
            let Some(server) = state.server.as_mut() else {
                continue;
            };
            let Some(transient) = result.states.iter().find(|candidate| {
                candidate.thread_id == state.thread_id
                    && candidate.server.as_ref().is_some_and(|candidate_server| {
                        candidate_server.thread_feed_id == server.thread_feed_id
                    })
            }) else {
                continue;
            };
            server.previews = transient
                .server
                .as_ref()
                .and_then(|candidate_server| candidate_server.previews.clone());
        }
        changes.group_thread_ids = result.group_thread_ids;
        changes.error = result.error;
        Ok(changes)
    })
    .await
    .map_err(|e| format!("join thread feed changes: {e}"))?
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
        group_thread_ids: Vec::new(),
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
    proxy: &ProxyState,
    user_id: i64,
    target: i32,
) -> Result<ThreadFeedSyncResult, String> {
    if user_id <= 0 || target < -1 {
        return Err("invalid thread feed owner or target".into());
    }
    let epoch = super::lifetime::CACHE_LIFETIME.capture()?;
    let _sync = THREAD_FEED_SYNC.lock().await;
    drop(super::lifetime::CACHE_LIFETIME.admit(epoch)?);
    let mut cursor = super::lifetime::spawn_at(Ok(epoch), move || {
        let conn = open()?;
        read_cursor(&conn, user_id)
    })
    .await
    .map_err(|e| format!("join thread feed cursor read: {e}"))??;
    let mut states = BTreeMap::new();
    let mut group_thread_ids = Vec::new();
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
                "/api/v1/thread/feed-delta".into(),
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
            let merged = super::lifetime::spawn_at(Ok(epoch), move || {
                merge_states(&mut open()?, user_id, page.items, Some(scanned))
            })
            .await
            .map_err(|e| format!("join thread feed merge: {e}"))??;
            for state in merged {
                states.insert(state.thread_id, state);
            }
            cursor = scanned;
            target = Some(target.unwrap_or(head).max(head));
        }
        let (changed, error) = sync_group_meta(app, proxy, user_id, epoch).await;
        group_thread_ids = changed;
        if let Some(error) = error {
            return Err(error);
        }
        Ok(())
    }
    .await;
    drop(super::lifetime::CACHE_LIFETIME.admit(epoch)?);
    // A later network failure must not hide earlier committed pages from the live renderer.
    Ok(ThreadFeedSyncResult {
        states: states.into_values().collect(),
        cursor,
        group_thread_ids,
        error: outcome.err(),
    })
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ThreadFeedSnapshot {
    pub(super) thread_id: i32,
    pub(super) thread_feed_id: i32,
    pub(super) message_end_seq: i32,
    pub(super) tombstone_end_seq: i32,
    pub(super) group_meta_feed_end_id: Option<String>,
    #[serde(default)]
    pub(super) join_request_end_feed_id: i32,
    #[serde(default = "disabled_join_request_read_feed_id")]
    pub(super) join_request_read_feed_id: i32,
    #[serde(default)]
    pub(super) group_invite_end_feed_id: i32,
    pub(super) last_read_seq: i32,
    pub(super) unread_count: i32,
    pub(super) last_mention_seq: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) previews: Option<Vec<serde_json::Value>>,
}

fn disabled_join_request_read_feed_id() -> i32 {
    -1
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocalThreadAttention {
    pub(super) thread_id: i32,
    pub(super) server: Option<ThreadFeedSnapshot>,
    pub(super) local_read_seq: Option<i32>,
}

fn validate_snapshot(state: &ThreadFeedSnapshot) -> Result<(), String> {
    if state.thread_id <= 0
        || state.thread_feed_id < 0
        || state.message_end_seq < 0
        || state.tombstone_end_seq < 0
        || state.join_request_end_feed_id < 0
        || state.join_request_read_feed_id < -1
        || state.join_request_read_feed_id > state.join_request_end_feed_id
        || state.group_invite_end_feed_id < 0
        || state.last_read_seq < 0
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
    let payload: Option<String> = conn
        .query_row(
            "SELECT payload_json FROM thread_states WHERE user_id=?1 AND thread_id=?2",
            params![user_id, thread_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("read attention: {e}"))?;
    match payload {
        Some(payload) => {
            serde_json::from_str(&payload).map_err(|e| format!("decode attention: {e}"))
        }
        None => Ok(LocalThreadAttention {
            thread_id,
            server: None,
            local_read_seq: None,
        }),
    }
}

fn write_state(
    conn: &Connection,
    user_id: i64,
    state: &LocalThreadAttention,
) -> Result<(), String> {
    let mut stored = state.clone();
    if let Some(previews) = stored
        .server
        .as_mut()
        .and_then(|server| server.previews.as_mut())
    {
        let latest = previews
            .iter()
            .max_by_key(|preview| preview["seq"].as_i64().unwrap_or(0))
            .cloned();
        *previews = latest.into_iter().collect();
    }
    let thread_feed_id = state.server.as_ref().map(|server| server.thread_feed_id);
    conn.execute(
        "INSERT OR IGNORE INTO threads(user_id,thread_id,payload_json) VALUES(?1,?2,?3)",
        params![
            user_id,
            state.thread_id,
            serde_json::json!({"threadId": state.thread_id, "threadFeedId": thread_feed_id, "type": "PENDING", "visible": false})
                .to_string()
        ],
    )
    .map_err(|e| format!("write pending thread: {e}"))?;
    if let Some(thread_feed_id) = thread_feed_id {
        conn.execute(
            "UPDATE threads SET payload_json=json_set(payload_json, '$.threadFeedId', ?3,
               '$.visible', CASE WHEN json_extract(payload_json, '$.type')='PENDING' THEN json('false') ELSE json('true') END)
             WHERE user_id=?1 AND thread_id=?2",
            params![user_id, state.thread_id, thread_feed_id],
        )
        .map_err(|e| format!("publish thread list order: {e}"))?;
    }
    let payload = serde_json::to_string(&stored).map_err(|e| format!("encode attention: {e}"))?;
    conn.execute(
        "INSERT INTO thread_states(user_id,thread_id,payload_json) VALUES(?1,?2,?3)
         ON CONFLICT(user_id,thread_id) DO UPDATE SET payload_json=excluded.payload_json",
        params![user_id, state.thread_id, payload],
    )
    .map_err(|e| format!("write attention: {e}"))?;
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
            state.server = Some(snapshot);
            write_state(&tx, user_id, &state)?;
        }
        merged.insert(state.thread_id, state);
    }
    if let Some(cursor) = cursor {
        tx.execute(
            "INSERT INTO sync_state(user_id,key,value_json) VALUES(?1,'threadFeedCursor',?2)
             ON CONFLICT(user_id,key) DO UPDATE SET value_json=
               CAST(MAX(CAST(sync_state.value_json AS INTEGER),CAST(excluded.value_json AS INTEGER)) AS TEXT)",
            params![user_id, cursor.to_string()],
        ).map_err(|e| format!("write attention cursor: {e}"))?;
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
    if state.local_read_seq.is_none_or(|old| seq > old) {
        state.local_read_seq = Some(seq);
        write_state(&tx, user_id, &state)?;
    }
    tx.commit()
        .map_err(|e| format!("commit attention read: {e}"))?;
    Ok(state)
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
pub(crate) async fn native_db_merge_thread_states(
    user_id: i64,
    states: Vec<ThreadFeedSnapshot>,
    scanned_through: Option<i32>,
) -> Result<Vec<LocalThreadAttention>, String> {
    super::lifetime::spawn(move || merge_states(&mut open()?, user_id, states, scanned_through))
        .await
        .map_err(|e| format!("join attention merge: {e}"))?
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
        snapshot.previews = Some(vec![
            serde_json::json!({"seq": 4}),
            serde_json::json!({"seq": 9}),
            serde_json::json!({"seq": 6}),
        ]);
        let merged = merge_states(&mut conn, 1, vec![snapshot], Some(1)).unwrap();
        assert_eq!(
            merged[0]
                .server
                .as_ref()
                .unwrap()
                .previews
                .as_ref()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            read_state(&conn, 1, 7)
                .unwrap()
                .server
                .unwrap()
                .previews
                .unwrap(),
            vec![serde_json::json!({"seq": 9})]
        );
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
        advance_read(&mut conn, 1, 7, 105).unwrap();
        super::super::drop_cache_schema(&conn).unwrap();
        super::super::create_cache_schema(&conn).unwrap();
        super::super::validate_cache_schema(&conn).unwrap();
        assert_eq!(read_state(&conn, 1, 7).unwrap().local_read_seq, None);
    }

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE threads(user_id INTEGER,thread_id INTEGER,payload_json TEXT,PRIMARY KEY(user_id,thread_id)); CREATE TABLE thread_states(user_id INTEGER,thread_id INTEGER,payload_json TEXT,PRIMARY KEY(user_id,thread_id));
            CREATE TABLE sync_state(user_id INTEGER,key TEXT,value_json TEXT,PRIMARY KEY(user_id,key));").unwrap();
        conn
    }
    fn snapshot(feed: i32, seq: i32) -> ThreadFeedSnapshot {
        ThreadFeedSnapshot {
            thread_id: 7,
            thread_feed_id: feed,
            message_end_seq: 200,
            tombstone_end_seq: 0,
            group_meta_feed_end_id: None,
            join_request_end_feed_id: 0,
            join_request_read_feed_id: -1,
            group_invite_end_feed_id: 0,
            last_read_seq: seq,
            unread_count: 8,
            last_mention_seq: None,
            previews: None,
        }
    }
    #[test]
    fn snapshot_merge_preserves_local_position_and_orders_by_feed() {
        let mut conn = db();
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
        let count: i32 = conn
            .query_row("SELECT count(*) FROM sync_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        for cursor in [20, 10, 30] {
            merge_states(&mut conn, 1, vec![], Some(cursor)).unwrap();
        }
        let cursor: String = conn
            .query_row("SELECT value_json FROM sync_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cursor, "30");
        assert_eq!(read_state(&conn, 1, 7).unwrap().local_read_seq, Some(100));
    }
    #[test]
    fn failed_cursor_write_rolls_back_rows() {
        let mut conn = db();
        conn.execute_batch("CREATE TRIGGER fail_cursor BEFORE INSERT ON sync_state BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
        assert!(merge_states(&mut conn, 1, vec![snapshot(1, 100)], Some(1)).is_err());
        assert_eq!(read_state(&conn, 1, 7).unwrap().server, None);
    }
}

fn read_cursor(conn: &Connection, user_id: i64) -> Result<i32, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value_json FROM sync_state WHERE user_id=?1 AND key='threadFeedCursor'",
            [user_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("read thread feed cursor: {e}"))?;
    let cursor = match raw {
        Some(value) => serde_json::from_str::<i32>(&value)
            .map_err(|e| format!("decode thread feed cursor: {e}"))?,
        None => 0,
    };
    if cursor < 0 {
        return Err("invalid local thread feed cursor".into());
    }
    Ok(cursor)
}

fn read_states(conn: &Connection, user_id: i64) -> Result<Vec<LocalThreadAttention>, String> {
    let mut query = conn
        .prepare("SELECT payload_json FROM thread_states WHERE user_id=?1 ORDER BY thread_id")
        .map_err(|e| format!("prepare attention query: {e}"))?;
    let rows = query
        .query_map([user_id], |row| row.get::<_, String>(0))
        .map_err(|e| format!("query attention: {e}"))?;
    rows.map(|row| {
        let payload = row.map_err(|e| format!("read attention row: {e}"))?;
        serde_json::from_str(&payload).map_err(|e| format!("decode attention row: {e}"))
    })
    .collect()
}
