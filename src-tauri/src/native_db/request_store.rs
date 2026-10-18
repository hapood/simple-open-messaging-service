use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("request projection has no {field}"))
}

fn number(value: &Value, field: &str) -> Result<i64, String> {
    value
        .get(field)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("request projection has no {field}"))
}

/// Decode only the send-time presentation shape, independently of subject identity.
fn snapshot_json(projection: &Value) -> Result<Option<String>, String> {
    let Some(snapshot) = projection.get("snapshot").filter(|value| !value.is_null()) else {
        if text(projection, "direction")? == "OUTGOING" {
            return Err("outgoing request requires a snapshot".into());
        }
        return Ok(None);
    };
    if text(projection, "direction")? != "OUTGOING" {
        return Err("incoming request cannot carry a receiver snapshot".into());
    }
    let object = snapshot.as_object().ok_or("invalid request snapshot")?;
    let name = text(snapshot, "displayName")?;
    let avatar_valid = match object.get("avatar") {
        Some(Value::Null) => true,
        Some(Value::String(avatar)) => !avatar.trim().is_empty(),
        _ => false,
    };
    if object.len() != 2 || name.trim().is_empty() || name.chars().count() > 31 || !avatar_valid {
        return Err("invalid request snapshot".into());
    }
    Ok(Some(snapshot.to_string()))
}

/// Persist only the typed request projection, not the state-feed event body.
/// Subject identity is the namespace/account coordinate; display domains are
/// resolved separately from namespace bindings and are never stored here.
pub(super) fn save(
    conn: &Connection,
    user_id: i64,
    key: &str,
    projection: &Value,
) -> Result<(), String> {
    if text(projection, "key")? != key {
        return Err("request projection key mismatch".into());
    }
    let kind = text(projection, "kind")?;
    if !matches!(kind, "FRIEND" | "GROUP") {
        return Err("invalid request projection kind".into());
    }
    let subject = projection
        .get(if kind == "FRIEND" { "peer" } else { "group" })
        .filter(|value| !value.is_null());
    let account = subject.map(|value| text(value, "account")).transpose()?;
    let namespace = subject
        .map(|value| number(value, "namespaceId"))
        .transpose()?;
    // Group subjects are profile references, not presentation snapshots.
    let avatar = if kind == "FRIEND" {
        subject.map(|value| text(value, "avatar")).transpose()?
    } else {
        None
    };
    let bio = if kind == "FRIEND" {
        subject.map(|value| text(value, "bio")).transpose()?
    } else {
        None
    };
    let profile_rev = if kind == "GROUP" {
        subject
            .map(|value| number(value, "profileRev"))
            .transpose()?
    } else {
        subject
            .and_then(|value| value.get("profileRev"))
            .and_then(Value::as_i64)
    };
    let subject_id = if kind == "FRIEND" {
        subject
            .and_then(|value| value.get("id"))
            .and_then(Value::as_i64)
    } else {
        None
    };
    let local_thread_id = projection
        .get("localThreadId")
        .filter(|value| !value.is_null())
        .map(|value| value.as_i64().ok_or("invalid localThreadId".to_string()))
        .transpose()?;
    conn.execute(
        "INSERT INTO relationship_requests (
           user_id, stable_key, namespace_id, kind, bucket, direction, status,
           expires_at, local_thread_id, note, requested_at, requested_sort,
           updated_at, source_label, subject_id, subject_account,
           subject_namespace_id, subject_avatar, subject_bio,
           subject_profile_rev, snapshot_json
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)
         ON CONFLICT(user_id,stable_key) DO UPDATE SET
           (namespace_id, kind, bucket, direction, status, expires_at,
            local_thread_id, note, requested_at, requested_sort, updated_at,
            source_label, subject_id, subject_account,
            subject_namespace_id, subject_avatar, subject_bio,
            subject_profile_rev, snapshot_json) =
           (excluded.namespace_id, excluded.kind, excluded.bucket, excluded.direction,
            excluded.status, excluded.expires_at, excluded.local_thread_id,
            excluded.note, excluded.requested_at, excluded.requested_sort,
            excluded.updated_at, excluded.source_label, excluded.subject_id,
            excluded.subject_account, excluded.subject_namespace_id,
            excluded.subject_avatar, excluded.subject_bio,
            excluded.subject_profile_rev, excluded.snapshot_json)",
        params![
            user_id, key, number(projection, "namespaceId")?, kind,
            text(projection, "bucket")?, text(projection, "direction")?,
            text(projection, "status")?, number(projection, "expiresAt")?,
            local_thread_id, text(projection, "note")?,
            number(projection, "requestedAt")?, number(projection, "requestedSort")?,
            number(projection, "updatedAt")?,
            projection.get("sourceLabel").and_then(Value::as_str), subject_id,
            account, namespace, avatar, bio, profile_rev, snapshot_json(projection)?,
        ],
    ).map_err(|e| format!("save request projection: {e}"))?;
    Ok(())
}

/// Rebuild the wire/IPC view from indexed scalar fields and the typed presentation snapshot.
/// The original state-feed body is never stored here.
pub(super) fn read(conn: &Connection, user_id: i64, key: &str) -> Result<Option<Value>, String> {
    let payload: Option<String> = conn
        .query_row(
            "SELECT json_object(
           'key', stable_key, 'namespaceId', namespace_id, 'kind', kind,
           'bucket', bucket, 'direction', direction, 'status', status,
           'expiresAt', expires_at, 'localThreadId', local_thread_id,
           'note', note, 'requestedAt', requested_at, 'requestedSort', requested_sort,
           'updatedAt', updated_at, 'sourceLabel', source_label,
           'snapshot', json(snapshot_json),
           'peer', json(CASE WHEN kind='FRIEND' AND subject_account IS NOT NULL THEN
             json_object('id', subject_id, 'account', subject_account,
               'namespaceId', subject_namespace_id,
               'avatar', subject_avatar, 'bio', subject_bio,
               'profileRev', subject_profile_rev)
             ELSE 'null' END),
           'group', json(CASE WHEN kind='GROUP' AND subject_account IS NOT NULL THEN
             json_object('account', subject_account,
               'namespaceId', subject_namespace_id,
               'profileRev', subject_profile_rev)
             ELSE 'null' END)
         ) FROM relationship_requests WHERE user_id=?1 AND stable_key=?2",
            params![user_id, key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("read request projection: {e}"))?;
    payload
        .map(|payload| {
            let mut value: Value = serde_json::from_str(&payload)
                .map_err(|e| format!("decode request projection: {e}"))?;
            let object = value.as_object_mut().ok_or("invalid request projection")?;
            if object.get("kind").and_then(Value::as_str) == Some("FRIEND") {
                object.remove("group");
                object.remove("sourceLabel");
                if let Some(peer) = object.get_mut("peer").and_then(Value::as_object_mut) {
                    if peer.get("id") == Some(&Value::Null) {
                        peer.remove("id");
                    }
                    if peer.get("profileRev") == Some(&Value::Null) {
                        peer.remove("profileRev");
                    }
                }
            } else {
                object.remove("peer");
            }
            Ok(value)
        })
        .transpose()
}
