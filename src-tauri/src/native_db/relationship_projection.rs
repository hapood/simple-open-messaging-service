use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::Value;

use super::{chrono_millis, json_text, parse_json};

fn save_request_projection(
    tx: &Transaction<'_>,
    user_id: i64,
    key: &str,
    payload: &Value,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO friend_requests(user_id, stable_key, payload_json) VALUES(?1, ?2, ?3)
         ON CONFLICT(user_id, stable_key) DO UPDATE SET payload_json=excluded.payload_json",
        params![user_id, key, json_text(payload)?],
    )
    .map_err(|e| format!("save friend-request projection: {e}"))?;
    Ok(())
}

fn intent_is_effective(value: Option<&Value>, now: i64) -> bool {
    match value
        .and_then(|intent| intent.get("status"))
        .and_then(Value::as_str)
    {
        Some("ACCEPTED") => true,
        Some("REQUESTED") => value
            .and_then(|intent| intent.get("expiresAt"))
            .and_then(Value::as_i64)
            .is_some_and(|expires_at| expires_at > now),
        _ => false,
    }
}

fn relationship_intent_key(
    namespace_id: i64,
    account: &str,
    domain: &str,
    subject_account: &str,
    subject_domain: &str,
) -> String {
    serde_json::json!([
        "relationship",
        namespace_id,
        domain,
        account,
        subject_domain,
        subject_account
    ])
    .to_string()
}

pub(super) fn apply_relationship_intent_fact(
    tx: &Transaction<'_>,
    user_id: i64,
    namespace_id: i64,
    account: &str,
    domain: &str,
    subject_account: &str,
    subject_domain: &str,
    body: &Value,
) -> Result<bool, String> {
    let now = chrono_millis();
    let status = body
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| "relationship intent has no status".to_string())?;
    let expires_at = body.get("expiresAt").and_then(Value::as_i64);
    let key = relationship_intent_key(
        namespace_id,
        account,
        domain,
        subject_account,
        subject_domain,
    );
    let reverse_key = relationship_intent_key(
        namespace_id,
        subject_account,
        subject_domain,
        account,
        domain,
    );
    let fact = serde_json::json!({
        "status": status,
        "expiresAt": expires_at,
        "localThreadId": body.get("localThreadId")
            .or_else(|| body.get("threadId"))
            .cloned()
            .unwrap_or(Value::Null),
        "updatedAt": now,
    });
    tx.execute(
        "INSERT INTO relationship_intents(user_id,stable_key,reverse_key,payload_json)
             VALUES(?1,?2,?3,?4)
             ON CONFLICT(user_id,stable_key) DO UPDATE SET
               reverse_key=excluded.reverse_key,payload_json=excluded.payload_json",
        params![user_id, key, reverse_key, json_text(&fact)?],
    )
    .map_err(|e| format!("save relationship intent fact: {e}"))?;
    let read_fact = |fact_key: &str| -> Result<Option<Value>, String> {
        tx.query_row(
            "SELECT payload_json FROM relationship_intents WHERE user_id=?1 AND stable_key=?2",
            params![user_id, fact_key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("read relationship intent fact: {e}"))?
        .map(parse_json)
        .transpose()
    };
    let first = read_fact(&key)?;
    let second = read_fact(&reverse_key)?;
    Ok(intent_is_effective(first.as_ref(), now)
        && intent_is_effective(second.as_ref(), now)
        && [first.as_ref(), second.as_ref()]
            .into_iter()
            .flatten()
            .any(|fact| fact.get("status").and_then(Value::as_str) == Some("ACCEPTED")))
}

pub(super) fn update_live_request_projection(
    tx: &Transaction<'_>,
    user_id: i64,
    key: &str,
    status: &str,
    now: i64,
) -> Result<(), String> {
    let current: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM friend_requests WHERE user_id=?1 AND stable_key=?2",
            params![user_id, key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("read request projection effect target: {e}"))?;
    let Some(mut projection) = current.map(parse_json).transpose()? else {
        return Ok(());
    };
    if projection.get("status").and_then(Value::as_str) != Some("REQUESTED")
        || !projection
            .get("expiresAt")
            .and_then(Value::as_i64)
            .is_some_and(|expires_at| expires_at > now)
    {
        return Ok(());
    }
    projection["status"] = Value::String(status.into());
    projection["updatedAt"] = Value::from(now);
    save_request_projection(tx, user_id, key, &projection)
}

pub(super) fn apply_friend_request_effect(
    tx: &Transaction<'_>,
    user_id: i64,
    revision: i64,
    namespace_id: i64,
    account: &str,
    domain: &str,
    subject_account: &str,
    subject_domain: &str,
    body: &Value,
) -> Result<(), String> {
    let now = chrono_millis();
    let status = body.get("status").and_then(Value::as_str).unwrap_or("");
    let direction = body.get("direction").and_then(Value::as_str).unwrap_or("");
    if status == "ACCEPTED" && direction == "OUTGOING" {
        return Ok(());
    }
    let reverse = status == "ACCEPTED";
    let key = if reverse {
        serde_json::json!([
            "friend",
            namespace_id,
            subject_domain,
            subject_account,
            domain,
            account
        ])
        .to_string()
    } else {
        serde_json::json!([
            "friend",
            namespace_id,
            domain,
            account,
            subject_domain,
            subject_account
        ])
        .to_string()
    };
    if status != "REQUESTED" {
        return update_live_request_projection(tx, user_id, &key, status, now);
    }
    let requested_at = body.get("requestedAt").and_then(Value::as_i64).unwrap_or(0);
    let Some(expires_at) = body
        .get("expiresAt")
        .and_then(Value::as_i64)
        .map(|value| value.min(requested_at.saturating_add(604_800_000)))
        .filter(|value| *value > now)
    else {
        return Ok(());
    };
    let prior_actionable: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM friend_requests
             WHERE user_id=?1 AND stable_key=?2
               AND json_extract(payload_json,'$.status')='REQUESTED')",
            params![user_id, key],
            |row| row.get(0),
        )
        .map_err(|e| format!("read request projection actionability: {e}"))?;
    let mut peer = body.get("peer").cloned().unwrap_or(Value::Null);
    if let Some(peer_object) = peer.as_object_mut() {
        let peer_namespace_id =
            if peer_object.get("domain").and_then(Value::as_str) == Some("local") {
                0
            } else {
                namespace_id
            };
        peer_object.insert("namespaceId".into(), Value::from(peer_namespace_id));
    }
    let projection = serde_json::json!({
        "key": key,
        "namespaceId": namespace_id,
        "kind": "FRIEND",
        "bucket": if direction == "INCOMING" { "RECEIVED" } else { "SENT" },
        "direction": direction,
        "status": "REQUESTED",
        "expiresAt": expires_at,
        "localThreadId": body.get("localThreadId").cloned().unwrap_or(Value::Null),
        "inviteId": body.get("inviteId").cloned().unwrap_or(Value::Null),
        "note": body.get("note").cloned().unwrap_or(Value::String(String::new())),
        "requestedAt": requested_at,
        "peer": peer,
        "requestedSort": requested_at,
        "updatedAt": now,
    });
    save_request_projection(tx, user_id, &key, &projection)?;
    if direction == "INCOMING" && !prior_actionable {
        tx.execute(
            "INSERT INTO sync_state(user_id,key,value_json) VALUES(?1,'friendRequestStateRevision',?2)
             ON CONFLICT(user_id,key) DO UPDATE SET value_json=excluded.value_json",
            params![user_id, revision.to_string()],
        )
        .map_err(|e| format!("save friend-request unread revision: {e}"))?;
    }
    Ok(())
}

pub(super) fn apply_group_request_effect(
    tx: &Transaction<'_>,
    user_id: i64,
    revision: i64,
    namespace_id: i64,
    group_account: &str,
    group_domain: &str,
    direction: &str,
    body: &Value,
) -> Result<(), String> {
    let now = chrono_millis();
    let status = body.get("status").and_then(Value::as_str).unwrap_or("");
    if status == "ACCEPTED" && direction == "OUTGOING" {
        return Ok(());
    }
    let target_direction = if status == "ACCEPTED" {
        "OUTGOING"
    } else {
        direction
    };
    let key = serde_json::json!([
        "group",
        namespace_id,
        group_domain,
        group_account,
        target_direction
    ])
    .to_string();
    if status != "REQUESTED" {
        return update_live_request_projection(tx, user_id, &key, status, now);
    }
    let requested_at = body.get("requestedAt").and_then(Value::as_i64).unwrap_or(0);
    let Some(expires_at) = body
        .get("expiresAt")
        .and_then(Value::as_i64)
        .map(|value| value.min(requested_at.saturating_add(604_800_000)))
        .filter(|value| *value > now)
    else {
        return Ok(());
    };
    let mut group = body.get("group").cloned().unwrap_or(Value::Null);
    if let Some(group_object) = group.as_object_mut() {
        let group_namespace_id = if group_domain == "local" {
            0
        } else {
            namespace_id
        };
        group_object.insert("namespaceId".into(), Value::from(group_namespace_id));
    }
    let projection = serde_json::json!({
        "key": key,
        "namespaceId": namespace_id,
        "kind": "GROUP",
        "bucket": if direction == "INCOMING" { "RECEIVED" } else { "SENT" },
        "direction": direction,
        "status": "REQUESTED",
        "expiresAt": expires_at,
        "localThreadId": body.get("threadId").cloned().unwrap_or(Value::Null),
        "inviteId": group_account,
        "note": body.get("note").cloned().unwrap_or(Value::String(String::new())),
        "requestedAt": requested_at,
        "group": group,
        "sourceLabel": if body.get("group").and_then(|group| group.get("isLocal")).and_then(Value::as_bool) == Some(true) { "local" } else { group_domain },
        "requestedSort": requested_at,
        "updatedAt": now,
    });
    let prior_actionable: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM friend_requests
             WHERE user_id=?1 AND stable_key=?2
               AND json_extract(payload_json,'$.status')='REQUESTED')",
            params![user_id, key],
            |row| row.get(0),
        )
        .map_err(|e| format!("read group request projection actionability: {e}"))?;
    save_request_projection(tx, user_id, &key, &projection)?;
    if direction == "INCOMING" && !prior_actionable {
        tx.execute(
            "INSERT INTO sync_state(user_id,key,value_json) VALUES(?1,'friendRequestStateRevision',?2)
             ON CONFLICT(user_id,key) DO UPDATE SET value_json=excluded.value_json",
            params![user_id, revision.to_string()],
        )
        .map_err(|e| format!("save group-request unread revision: {e}"))?;
    }
    Ok(())
}

pub(super) fn materialize_group_thread_from_fact(
    tx: &Transaction<'_>,
    user_id: i64,
    group_account: &str,
    group_domain: &str,
    namespace_id: i64,
    body: &Value,
    active: bool,
) -> Result<(), String> {
    if !active {
        return Ok(());
    }
    let Some(thread_id) = body.get("threadId").and_then(Value::as_i64) else {
        return Ok(());
    };
    let group = body.get("group").cloned().unwrap_or(Value::Null);
    let group_object = group.as_object().cloned().unwrap_or_default();
    let group_namespace_id = if group_domain == "local" {
        0
    } else {
        namespace_id
    };
    let thread = serde_json::json!({
        "threadId": thread_id, "authorityNamespaceId": group_namespace_id,
        "type": "GROUP", "role": null,
        "lastMessageAt": null, "lastMessageSeq": null, "muted": false,
        "blocked": false, "pinned": false, "pinnedAt": null,
        "alias": null, "conversationState": "ACTIVE",
        "lastReadSeq": null, "unreadCount": 0, "mentionUnread": [],
        "lastMessagePreview": null, "lastMessageSenderId": null,
        "group": {
            "id": thread_id,
            "account": group_object.get("account").cloned().unwrap_or(Value::String(group_account.into())),
            "name": group_object.get("name").cloned().unwrap_or(Value::String(group_account.into())),
            "ownerId": 0,
            "avatar": group_object.get("avatar").cloned().unwrap_or(Value::String(String::new())),
            "description": group_object.get("description").cloned().unwrap_or(Value::String(String::new())),
            "domain": group_object.get("domain").cloned().unwrap_or(Value::String(group_domain.into())),
            "namespaceId": group_namespace_id,
            "threadId": thread_id, "createdAt": 0, "updatedAt": 0,
            "profileRev": group_object.get("profileRev").cloned().unwrap_or(Value::from(0)),
            "dissolvedAt": null, "memberCount": 0, "groupMetaFeedId": "0"
        }
    });
    tx.execute(
        "INSERT INTO threads(user_id,thread_id,payload_json) VALUES(?1,?2,?3)
         ON CONFLICT(user_id,thread_id) DO NOTHING",
        params![user_id, thread_id, json_text(&thread)?],
    )
    .map_err(|e| format!("materialize group thread from relationship facts: {e}"))?;
    Ok(())
}

pub(super) fn apply_friend_thread_from_facts(
    tx: &Transaction<'_>,
    user_id: i64,
    namespace_id: i64,
    body: &Value,
    active: bool,
) -> Result<(), String> {
    let Some(thread_id) = body.get("localThreadId").and_then(Value::as_i64) else {
        return Ok(());
    };
    let existing: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM threads WHERE user_id=?1 AND thread_id=?2",
            params![user_id, thread_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("read friend thread projection: {e}"))?;
    if let Some(existing) = existing {
        let mut thread = parse_json(existing)?;
        if thread.get("type").and_then(Value::as_str) == Some("P2P") {
            thread["friendshipActive"] = Value::Bool(active);
            thread["conversationState"] =
                Value::String(if active { "ACTIVE" } else { "READ_ONLY" }.into());
            if let Some(peer) = body.get("peer") {
                let mut peer = peer.clone();
                if let Some(peer_object) = peer.as_object_mut() {
                    let peer_namespace_id =
                        if peer_object.get("domain").and_then(Value::as_str) == Some("local") {
                            0
                        } else {
                            namespace_id
                        };
                    peer_object.insert("namespaceId".into(), Value::from(peer_namespace_id));
                }
                thread["peerUser"] = peer;
            }
            tx.execute(
                "UPDATE threads SET payload_json=?3 WHERE user_id=?1 AND thread_id=?2",
                params![user_id, thread_id, json_text(&thread)?],
            )
            .map_err(|e| format!("update friend thread from relationship facts: {e}"))?;
        }
    } else if active {
        let mut peer = body.get("peer").cloned().unwrap_or(Value::Null);
        if let Some(peer) = peer.as_object_mut() {
            let peer_namespace_id = if peer.get("domain").and_then(Value::as_str) == Some("local") {
                0
            } else {
                namespace_id
            };
            peer.insert("namespaceId".into(), Value::from(peer_namespace_id));
            peer.entry("isGroup").or_insert(Value::Bool(false));
            peer.entry("profileRev").or_insert(Value::from(0));
            peer.entry("createdAt").or_insert(Value::from(0));
            peer.entry("updatedAt").or_insert(Value::from(0));
            peer.entry("isDeleted").or_insert(Value::Bool(false));
        }
        let thread = serde_json::json!({
            "threadId": thread_id, "authorityNamespaceId": peer.get("namespaceId").cloned().unwrap_or(Value::from(0)),
            "type": "P2P", "role": null,
            "lastMessageAt": null, "lastMessageSeq": null, "muted": false,
            "blocked": false, "pinned": false, "pinnedAt": null,
            "alias": null, "peerUser": peer,
            "friendshipActive": true, "conversationState": "ACTIVE",
            "lastReadSeq": null, "unreadCount": 0, "mentionUnread": [],
            "lastMessagePreview": null, "lastMessageSenderId": null,
        });
        tx.execute(
            "INSERT INTO threads(user_id,thread_id,payload_json) VALUES(?1,?2,?3)",
            params![user_id, thread_id, json_text(&thread)?],
        )
        .map_err(|e| format!("insert friend thread from relationship facts: {e}"))?;
    }
    Ok(())
}
