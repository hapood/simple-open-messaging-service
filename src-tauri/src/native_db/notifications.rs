use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

use super::attention::{read_state, LocalThreadAttention};
use super::messages::{count_unread_message_slots, MessageCountOwner};

/// Metadata and image bytes travel separately across JNI. Images are encoded files, not pixels.
pub(crate) struct NotificationBatch {
    pub(crate) account_epoch: u64,
    pub(crate) metadata: String,
    pub(crate) avatars: Vec<Vec<u8>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationThread {
    thread_id: i32,
    thread_feed_id: i32,
    unread_count: i64,
    last_read_seq: i32,
    has_unread_mention: bool,
    muted: bool,
    title: String,
    previews: Vec<Value>,
}

fn projected_count(
    conn: &Connection,
    user_id: i64,
    state: &LocalThreadAttention,
    owner: Option<&MessageCountOwner>,
) -> Result<i64, String> {
    let server = state
        .server
        .as_ref()
        .ok_or("missing notification snapshot")?;
    let local = state.local_read_seq.unwrap_or(server.last_read_seq);
    let after = server.message_end_seq.min(local.min(server.last_read_seq));
    let through = server.message_end_seq.min(local.max(server.last_read_seq));
    let delta = if after == through {
        0
    } else {
        count_unread_message_slots(
            conn,
            user_id,
            state.thread_id,
            after,
            through,
            owner.ok_or("missing notification account identity")?,
        )?
    };
    Ok((i64::from(server.unread_count)
        + i64::from((server.last_read_seq - local).signum()) * delta)
        .max(0))
}

fn sender_profile(
    conn: &Connection,
    user_id: i64,
    thread_id: i32,
    thread: &Value,
    account: &str,
    domain: &str,
) -> Result<Option<Value>, String> {
    let peer = &thread["peerUser"];
    let reference =
        if peer["account"].as_str() == Some(account) && peer["domain"].as_str() == Some(domain) {
            peer["namespaceId"]
                .as_i64()
                .zip(peer["profileRev"].as_i64())
        } else {
            conn.query_row(
                "SELECT m.namespace_id,m.profile_rev FROM members m
             JOIN namespaces n ON n.user_id=m.user_id AND n.namespace_id=m.namespace_id
             WHERE m.user_id=?1 AND m.thread_id=?2 AND m.member_account=?3 AND m.member_domain=?4
               AND n.status='ACTIVE' ORDER BY m.namespace_id DESC LIMIT 1",
                params![user_id, thread_id, account, domain],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| format!("read notification member: {e}"))?
        };
    match reference {
        Some((namespace, revision)) => {
            super::contacts::read_profile(conn, user_id, account, domain, namespace, revision)
        }
        None => Ok(None),
    }
}

#[cfg(target_os = "android")]
pub(crate) async fn synchronize(
    proxy: &crate::ProxyState,
    user_id: i64,
    target: i32,
) -> Result<NotificationBatch, String> {
    let epoch = super::lifetime::CACHE_LIFETIME.capture()?;
    let result = super::attention::sync_thread_feed(None, proxy, user_id, target, 5).await?;
    super::lifetime::spawn_at(Ok(epoch), move || {
        let mut batch = assemble(&mut super::open()?, user_id, result.states, result.error)?;
        batch.account_epoch = epoch;
        Ok(batch)
    })
    .await
    .map_err(|e| format!("join notification assembly: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::super::attention::ThreadFeedSnapshot;
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE sync_state(user_id INTEGER,key TEXT,value_json TEXT);
          CREATE TABLE thread_states(user_id INTEGER,thread_id INTEGER,payload_json TEXT);
          CREATE TABLE threads(user_id INTEGER,thread_id INTEGER,payload_json TEXT);
          CREATE TABLE messages(user_id INTEGER,thread_id INTEGER,seq INTEGER,payload_json TEXT);
          CREATE TABLE members(user_id INTEGER,thread_id INTEGER,member_account TEXT,member_domain TEXT,namespace_id INTEGER,profile_rev INTEGER);
          CREATE TABLE namespaces(user_id INTEGER,namespace_id INTEGER,status TEXT);
          CREATE TABLE profiles(user_id INTEGER,account TEXT,domain TEXT,namespace_id INTEGER,profile_rev INTEGER,payload_json TEXT);
          CREATE TABLE avatars(user_id INTEGER,identity TEXT,source_path TEXT,mime TEXT,data BLOB,last_render INTEGER);").unwrap();
        conn.execute(
            "INSERT INTO sync_state VALUES(1,'selfProfile',?1)",
            [r#"{"account":"me"}"#],
        )
        .unwrap();
        conn
    }

    fn state(local: i32) -> LocalThreadAttention {
        LocalThreadAttention {
            thread_id: 7,
            local_read_seq: Some(local),
            server: Some(ThreadFeedSnapshot {
                thread_id: 7,
                thread_feed_id: 8,
                message_end_seq: 10,
                tombstone_end_seq: 4,
                group_meta_feed_end_id: None,
                join_request_end_feed_id: 0,
                join_request_read_feed_id: -1,
                group_invite_end_feed_id: 0,
                last_read_seq: 2,
                unread_count: 8,
                last_mention_seq: Some(5),
                previews: Some(vec![
                    serde_json::json!({"seq": 5, "sender":{"account":"peer","domain":"local"},"status":"USER_RETRACTION"}),
                    serde_json::json!({"seq": 6, "sender":{"account":"peer","domain":"local"},"status":"LIVE","text":"hello"}),
                ]),
            }),
        }
    }

    fn save(conn: &Connection, state: &LocalThreadAttention) {
        conn.execute("DELETE FROM thread_states", []).unwrap();
        conn.execute(
            "INSERT INTO thread_states VALUES(1,7,?1)",
            [serde_json::to_string(state).unwrap()],
        )
        .unwrap();
    }

    #[test]
    fn notification_count_rebases_known_slots_including_tombs_and_excluding_self() {
        let conn = db();
        for (seq, account) in [(3, "peer"), (4, "me"), (5, "peer")] {
            conn.execute("INSERT INTO messages VALUES(1,7,?1,?2)", params![seq,
                serde_json::json!({"isDeleted":true,"creator":{"account":account,"domain":"local","namespaceId":0}}).to_string()]).unwrap();
        }
        let owner = MessageCountOwner {
            account: "me".into(),
            domain: "local".into(),
            namespace_id: 0,
        };
        assert_eq!(
            projected_count(&conn, 1, &state(5), Some(&owner)).unwrap(),
            6
        );
        assert_eq!(
            projected_count(&conn, 1, &state(20), Some(&owner)).unwrap(),
            6
        );
        let mut rollback = state(2);
        rollback.server.as_mut().unwrap().last_read_seq = 5;
        assert_eq!(
            projected_count(&conn, 1, &rollback, Some(&owner)).unwrap(),
            10
        );
    }

    #[test]
    fn assembly_uses_latest_local_read_and_separates_deduplicated_avatar_bytes() {
        let mut conn = db();
        let delivered = state(2);
        save(&conn, &delivered);
        conn.execute(
            "INSERT INTO threads VALUES(1,7,?1)",
            [r#"{"peerUser":{"account":"peer","domain":"local","namespaceId":0,"profileRev":1}}"#],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO profiles VALUES(1,'peer','local',0,1,?1)",
            [r#"{"name":"Peer","avatar":"/avatar"}"#],
        )
        .unwrap();
        let bytes = vec![0_u8, 128, 255];
        conn.execute(
            "INSERT INTO avatars VALUES(1,'peer','/avatar','image/png',?1,0)",
            [&bytes],
        )
        .unwrap();
        let batch = assemble(&mut conn, 1, vec![delivered.clone()], None).unwrap();
        let metadata: Value = serde_json::from_str(&batch.metadata).unwrap();
        assert_eq!(batch.avatars, vec![bytes]);
        assert_eq!(metadata["threads"][0]["previews"][0]["avatarIndex"], 0);
        assert_eq!(metadata["threads"][0]["previews"][1]["avatarIndex"], 0);
        assert_eq!(
            metadata["threads"][0]["previews"][0]["status"],
            "USER_RETRACTION"
        );
        assert!(!batch.metadata.contains("image/png"));
        save(&conn, &state(5));
        let batch = assemble(&mut conn, 1, vec![delivered], None).unwrap();
        let metadata: Value = serde_json::from_str(&batch.metadata).unwrap();
        assert_eq!(
            metadata["threads"][0]["previews"].as_array().unwrap().len(),
            1
        );
        assert_eq!(metadata["threads"][0]["hasUnreadMention"], false);
    }

    #[test]
    fn no_consumed_states_means_no_notification_even_if_database_has_unread() {
        let mut conn = db();
        save(&conn, &state(2));
        let batch = assemble(&mut conn, 1, vec![], None).unwrap();
        assert_eq!(batch.account_epoch, 0);
        let metadata: Value = serde_json::from_str(&batch.metadata).unwrap();
        assert_eq!(metadata["threads"], serde_json::json!([]));
        assert!(batch.avatars.is_empty());
    }
}

fn assemble(
    conn: &mut Connection,
    user_id: i64,
    states: Vec<LocalThreadAttention>,
    error: Option<String>,
) -> Result<NotificationBatch, String> {
    // Avatar reads touch last_render, so reserve the writer before taking the read snapshot.
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let profile_json: Option<String> = tx
        .query_row(
            "SELECT value_json FROM sync_state WHERE user_id=?1 AND key='selfProfile'",
            [user_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let profile: Option<Value> = profile_json
        .map(|json| serde_json::from_str(&json))
        .transpose()
        .map_err(|e| e.to_string())?;
    let owner = profile
        .as_ref()
        .and_then(|value| value["account"].as_str())
        .map(|account| MessageCountOwner {
            account: account.into(),
            domain: "local".into(),
            namespace_id: 0,
        });
    let mut notifications = Vec::new();
    let mut avatars = Vec::new();
    let mut avatar_indices = BTreeMap::new();
    for delivered in states {
        // UI reads may have advanced since the page commit. Reconcile against the current local position.
        let current = read_state(&tx, user_id, delivered.thread_id)?;
        let Some(server) = current.server.as_ref() else {
            continue;
        };
        if delivered
            .server
            .as_ref()
            .is_none_or(|value| value.thread_feed_id != server.thread_feed_id)
        {
            continue;
        }
        let local = current.local_read_seq.unwrap_or(server.last_read_seq);
        let count = projected_count(&tx, user_id, &current, owner.as_ref())?;
        let thread_json: Option<String> = tx
            .query_row(
                "SELECT payload_json FROM threads WHERE user_id=?1 AND thread_id=?2 AND COALESCE(json_extract(payload_json, '$.visible'), 1)=1",
                params![user_id, current.thread_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let thread: Value = thread_json
            .map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(|e| e.to_string())?
            .unwrap_or(Value::Null);
        let mut previews = Vec::new();
        for preview in delivered
            .server
            .as_ref()
            .ok_or("missing delivered notification snapshot")?
            .previews
            .iter()
            .flatten()
            .filter(|preview| {
                preview["seq"]
                    .as_i64()
                    .is_some_and(|seq| seq > i64::from(local))
            })
            .take(5)
        {
            if preview["sender"].is_null() {
                let mut value = preview.clone();
                value["senderName"] = Value::String("SOMS".into());
                previews.push(value);
                continue;
            }
            let account = preview["sender"]["account"]
                .as_str()
                .ok_or("invalid preview sender")?;
            let domain = preview["sender"]["domain"]
                .as_str()
                .ok_or("invalid preview sender")?;
            let profile =
                sender_profile(&tx, user_id, current.thread_id, &thread, account, domain)?;
            let name = profile
                .as_ref()
                .and_then(|value| value["name"].as_str())
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("{account}@{domain}"));
            let mut value = preview.clone();
            value["senderName"] = Value::String(name);
            if let Some(path) = profile
                .as_ref()
                .and_then(|value| value["avatar"].as_str())
                .filter(|path| !path.is_empty())
            {
                let index = match avatar_indices.get(path) {
                    Some(index) => Some(*index),
                    None => match super::avatars::read_avatar_by_source(&tx, user_id, path)? {
                        Some(avatar) => {
                            let index = avatars.len();
                            avatars.push(avatar.data);
                            avatar_indices.insert(path.to_owned(), index);
                            Some(index)
                        }
                        None => None,
                    },
                };
                if let Some(index) = index {
                    value["avatarIndex"] = serde_json::json!(index);
                }
            }
            previews.push(value);
        }
        let title = thread["group"]["name"]
            .as_str()
            .or_else(|| thread["peerUser"]["name"].as_str())
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                previews
                    .first()
                    .and_then(|value| value["senderName"].as_str())
                    .map(str::to_owned)
            })
            .unwrap_or_default();
        notifications.push(NotificationThread {
            thread_id: current.thread_id,
            thread_feed_id: server.thread_feed_id,
            unread_count: count,
            last_read_seq: local,
            has_unread_mention: server.last_mention_seq.is_some_and(|seq| seq > local),
            muted: thread["muted"].as_bool().unwrap_or(false),
            title,
            previews,
        });
    }
    let metadata =
        serde_json::to_string(&serde_json::json!({ "threads": notifications, "error": error }))
            .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(NotificationBatch {
        metadata,
        avatars,
        account_epoch: 0,
    })
}
