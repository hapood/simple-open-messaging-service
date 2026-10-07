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

/// Persist only the typed request projection, not the state-feed event body.
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
    let domain = subject.map(|value| text(value, "domain")).transpose()?;
    let namespace = subject
        .map(|value| number(value, "namespaceId"))
        .transpose()?;
    let name = subject.map(|value| text(value, "name")).transpose()?;
    let avatar = subject.map(|value| text(value, "avatar")).transpose()?;
    let bio = if kind == "FRIEND" {
        subject.map(|value| text(value, "bio")).transpose()?
    } else {
        None
    };
    let description = if kind == "GROUP" {
        subject
            .map(|value| text(value, "description"))
            .transpose()?
    } else {
        None
    };
    let is_local = if kind == "GROUP" {
        subject
            .map(|value| {
                value
                    .get("isLocal")
                    .and_then(Value::as_bool)
                    .ok_or("request group has no isLocal".to_string())
            })
            .transpose()?
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
           updated_at, source_label, subject_id, subject_account, subject_domain,
           subject_namespace_id, subject_name, subject_avatar, subject_bio,
           subject_description, subject_is_local, subject_profile_rev
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)
         ON CONFLICT(user_id,stable_key) DO UPDATE SET
           (namespace_id, kind, bucket, direction, status, expires_at,
            local_thread_id, note, requested_at, requested_sort, updated_at,
            source_label, subject_id, subject_account, subject_domain,
            subject_namespace_id, subject_name, subject_avatar, subject_bio,
            subject_description, subject_is_local, subject_profile_rev) =
           (excluded.namespace_id, excluded.kind, excluded.bucket, excluded.direction,
            excluded.status, excluded.expires_at, excluded.local_thread_id,
            excluded.note, excluded.requested_at, excluded.requested_sort,
            excluded.updated_at, excluded.source_label, excluded.subject_id,
            excluded.subject_account, excluded.subject_domain,
            excluded.subject_namespace_id, excluded.subject_name,
            excluded.subject_avatar, excluded.subject_bio,
            excluded.subject_description, excluded.subject_is_local,
            excluded.subject_profile_rev)",
        params![
            user_id, key, number(projection, "namespaceId")?, kind,
            text(projection, "bucket")?, text(projection, "direction")?,
            text(projection, "status")?, number(projection, "expiresAt")?,
            local_thread_id, text(projection, "note")?,
            number(projection, "requestedAt")?, number(projection, "requestedSort")?,
            number(projection, "updatedAt")?,
            projection.get("sourceLabel").and_then(Value::as_str), subject_id,
            account, domain, namespace, name, avatar, bio, description,
            is_local, profile_rev,
        ],
    ).map_err(|e| format!("save request projection: {e}"))?;
    Ok(())
}

/// Rebuild the wire/IPC view from scalar columns. The JSON expression is evaluated only on read;
/// the database never stores an opaque object or the original state-feed body.
pub(super) fn read(conn: &Connection, user_id: i64, key: &str) -> Result<Option<Value>, String> {
    let payload: Option<String> = conn
        .query_row(
            "SELECT json_object(
           'key', stable_key, 'namespaceId', namespace_id, 'kind', kind,
           'bucket', bucket, 'direction', direction, 'status', status,
           'expiresAt', expires_at, 'localThreadId', local_thread_id,
           'note', note, 'requestedAt', requested_at, 'requestedSort', requested_sort,
           'updatedAt', updated_at, 'sourceLabel', source_label,
           'peer', json(CASE WHEN kind='FRIEND' AND subject_account IS NOT NULL THEN
             json_object('id', subject_id, 'account', subject_account,
               'domain', subject_domain, 'namespaceId', subject_namespace_id,
               'name', subject_name, 'avatar', subject_avatar, 'bio', subject_bio,
               'profileRev', subject_profile_rev)
             ELSE 'null' END),
           'group', json(CASE WHEN kind='GROUP' AND subject_account IS NOT NULL THEN
             json_object('account', subject_account, 'domain', subject_domain,
               'namespaceId', subject_namespace_id, 'name', subject_name,
               'avatar', subject_avatar, 'description', subject_description,
               'isLocal', json(CASE WHEN subject_is_local THEN 'true' ELSE 'false' END),
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
