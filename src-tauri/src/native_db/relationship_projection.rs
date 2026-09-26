use rusqlite::{params, Transaction};
use serde_json::Value;

use super::chrono_millis;

fn save_request_projection(
    tx: &Transaction<'_>,
    user_id: i64,
    key: &str,
    payload: &Value,
) -> Result<(), String> {
    super::request_store::save(tx, user_id, key, payload)
}

pub(super) fn update_live_request_projection(
    tx: &Transaction<'_>,
    user_id: i64,
    key: &str,
    status: &str,
    now: i64,
) -> Result<(), String> {
    tx.execute(
        "UPDATE relationship_requests SET status=?4, updated_at=?5
         WHERE user_id=?1 AND stable_key=?2 AND status='REQUESTED' AND expires_at>?3",
        params![user_id, key, now, status, now],
    ).map_err(|e| format!("update request projection: {e}"))?;
    Ok(())
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
    let request_direction = body
        .get("requestDirection")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "INCOMING" | "OUTGOING"));
    let target_direction = request_direction.unwrap_or_else(|| {
        if status == "ACCEPTED" && direction == "INCOMING" {
            "OUTGOING"
        } else {
            direction
        }
    });
    let reverse = target_direction != direction;
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
        let projection_status = if status == "REVOKED" {
            if request_direction.is_none() {
                return Ok(());
            }
            if body
                .get("requestStatus")
                .and_then(Value::as_str)
                .is_none_or(|value| !matches!(value, "WITHDRAWN" | "REJECTED"))
            {
                return Ok(());
            }
            body.get("requestStatus").and_then(Value::as_str).unwrap()
        } else {
            status
        };
        return update_live_request_projection(tx, user_id, &key, projection_status, now);
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
               AND status='REQUESTED')",
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
    let request_direction = body
        .get("requestDirection")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "INCOMING" | "OUTGOING"));
    let target_direction = request_direction.unwrap_or(if status == "ACCEPTED" {
        "OUTGOING"
    } else {
        direction
    });
    let key = serde_json::json!([
        "group",
        namespace_id,
        group_domain,
        group_account,
        target_direction
    ])
    .to_string();
    if status != "REQUESTED" {
        let projection_status = if status == "REVOKED" {
            if request_direction.is_none()
                || body
                    .get("requestStatus")
                    .and_then(Value::as_str)
                    .is_none_or(|value| !matches!(value, "WITHDRAWN" | "REJECTED"))
            {
                return Ok(());
            }
            body.get("requestStatus").and_then(Value::as_str).unwrap()
        } else {
            status
        };
        return update_live_request_projection(tx, user_id, &key, projection_status, now);
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
               AND status='REQUESTED')",
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
