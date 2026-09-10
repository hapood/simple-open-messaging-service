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
        "INSERT INTO relationship_requests(user_id, stable_key, payload_json) VALUES(?1, ?2, ?3)
         ON CONFLICT(user_id, stable_key) DO UPDATE SET payload_json=excluded.payload_json",
        params![user_id, key, json_text(payload)?],
    )
    .map_err(|e| format!("save friend-request projection: {e}"))?;
    Ok(())
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
            "SELECT payload_json FROM relationship_requests WHERE user_id=?1 AND stable_key=?2",
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

pub(super) fn apply_relationship_request_effect(
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
            "SELECT EXISTS(SELECT 1 FROM relationship_requests
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
        "note": body.get("note").cloned().unwrap_or(Value::String(String::new())),
        "requestedAt": requested_at,
        "peer": peer,
        "requestedSort": requested_at,
        "updatedAt": now,
    });
    save_request_projection(tx, user_id, &key, &projection)?;
    if direction == "INCOMING" && !prior_actionable {
        tx.execute(
            "INSERT INTO sync_state(user_id,key,value_json) VALUES(?1,'relationshipRequestStateRevision',?2)
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
        "note": body.get("note").cloned().unwrap_or(Value::String(String::new())),
        "requestedAt": requested_at,
        "group": group,
        "sourceLabel": if body.get("group").and_then(|group| group.get("isLocal")).and_then(Value::as_bool) == Some(true) { "local" } else { group_domain },
        "requestedSort": requested_at,
        "updatedAt": now,
    });
    let prior_actionable: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM relationship_requests
             WHERE user_id=?1 AND stable_key=?2
               AND json_extract(payload_json,'$.status')='REQUESTED')",
            params![user_id, key],
            |row| row.get(0),
        )
        .map_err(|e| format!("read group request projection actionability: {e}"))?;
    save_request_projection(tx, user_id, &key, &projection)?;
    if direction == "INCOMING" && !prior_actionable {
        tx.execute(
            "INSERT INTO sync_state(user_id,key,value_json) VALUES(?1,'relationshipRequestStateRevision',?2)
             ON CONFLICT(user_id,key) DO UPDATE SET value_json=excluded.value_json",
            params![user_id, revision.to_string()],
        )
        .map_err(|e| format!("save group-request unread revision: {e}"))?;
    }
    Ok(())
}
