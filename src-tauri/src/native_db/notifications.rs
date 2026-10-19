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
    publisher_namespace: i64,
    account: &str,
    profile_namespace: i64,
    revision: i64,
) -> Result<Option<Value>, String> {
    super::contacts::read_profile(
        conn,
        user_id,
        publisher_namespace,
        profile_namespace,
        account,
        revision,
    )
}

#[cfg(target_os = "android")]
pub(crate) async fn synchronize(
    proxy: &crate::ServerSessionState,
    user_id: i64,
    target: i32,
) -> Result<NotificationBatch, String> {
    let epoch = super::lifetime::CACHE_LIFETIME.capture()?;
    let result = super::attention::sync_thread_feed(None, proxy, user_id, target).await?;
    from_result_at(user_id, result.states, result.cursor, result.error, epoch).await
}

#[cfg(target_os = "android")]
pub(crate) async fn from_result(
    user_id: i64,
    result: &super::attention::ThreadFeedSyncResult,
) -> Result<NotificationBatch, String> {
    let epoch = super::lifetime::CACHE_LIFETIME.capture()?;
    from_result_at(
        user_id,
        result.states.clone(),
        result.cursor,
        result.error.clone(),
        epoch,
    )
    .await
}

#[cfg(target_os = "android")]
async fn from_result_at(
    user_id: i64,
    states: Vec<LocalThreadAttention>,
    cursor: i32,
    error: Option<String>,
    epoch: u64,
) -> Result<NotificationBatch, String> {
    super::lifetime::spawn_at(Ok(epoch), move || {
        let has_threads = !states.is_empty();
        let mut batch = assemble(&mut super::open()?, user_id, states, error)?;
        let mut metadata: Value =
            serde_json::from_str(&batch.metadata).map_err(|e| e.to_string())?;
        let mut changes = Vec::new();
        if has_threads {
            changes.push("THREADS");
        }
        metadata["commit"] = serde_json::json!({
            "userId": user_id,
            "cursor": cursor,
            "changes": changes,
        });
        batch.metadata = serde_json::to_string(&metadata).map_err(|e| e.to_string())?;
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
    use base64::Engine;

    fn avatar_store() {
        super::super::shared_test_location();
    }

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON; CREATE TABLE client_preferences(scope TEXT,key TEXT,value_json TEXT,updated_at INTEGER,PRIMARY KEY(scope,key));").unwrap();
        super::super::create_cache_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO account_state(user_id,self_profile_json) VALUES(1,?1)",
            [r#"{"account":"me"}"#],
        )
        .unwrap();
        conn
    }

    fn preview(
        seq: i32,
        rev: i32,
        status: &str,
        text: Option<&str>,
    ) -> super::super::attention::ThreadPreview {
        serde_json::from_value(serde_json::json!({
            "seq": seq,
            "createdAt": "2026-01-01T00:00:00Z",
            "sender": {"account":"peer","profileNamespaceId":0,"profileRev":rev},
            "status": status,
            "text": text,
        }))
        .unwrap()
    }

    fn state(local: i32) -> LocalThreadAttention {
        LocalThreadAttention {
            notification_changed: true,
            thread_id: 7,
            local_read_seq: Some(local),
            server: Some(ThreadFeedSnapshot {
                kind: "P2P".into(),
                authority_namespace_id: 0,
                self_mention_namespace_id: None,
                conversation_state: "ACTIVE".into(),
                blocked: false,
                role: None,
                subject_account: "peer".into(),
                thread_id: 7,
                thread_feed_id: 8,
                alias: None,
                message_end_seq: 10,
                thread_profile_rev: 0,
                tombstone_end_seq: 4,
                group_meta_feed_end_id: None,
                join_request_end_feed_id: 0,
                join_request_read_feed_id: -1,
                group_invite_end_feed_id: 0,
                last_read_seq: 2,
                announcement_read_feed_id: 0,
                unread_count: 8,
                last_mention_seq: Some(5),
                previews: vec![
                    preview(5, 1, "USER_RETRACTION", None),
                    preview(6, 1, "LIVE", Some("hello")),
                ],
            }),
        }
    }

    fn save(conn: &Connection, state: &LocalThreadAttention) {
        if super::super::thread_store::read(conn, 1, state.thread_id as i64)
            .unwrap()
            .is_none()
        {
            let server = state.server.as_ref().unwrap();
            let mut base = serde_json::to_value(server).unwrap();
            base["type"] = server.kind.clone().into();
            base["authorityNamespaceId"] = server.authority_namespace_id.into();
            base["threadProfileRev"] = server.thread_profile_rev.into();
            base["serverLastReadSeq"] = server.last_read_seq.into();
            base["serverUnreadCount"] = server.unread_count.into();
            base["localReadSeq"] = state.local_read_seq.unwrap_or(server.last_read_seq).into();
            // The presentation object is the publisher-space profile coordinate.
            let profile = serde_json::json!({
                "account": server.subject_account,
                "namespaceId": server.authority_namespace_id,
                "profileRev": server.thread_profile_rev,
            });
            if server.kind == "GROUP" {
                let mut group = profile;
                group["id"] = (server.thread_id as i64).into();
                base["group"] = group;
            } else {
                base["peerUser"] = profile;
            }
            super::super::thread_store::write(conn, 1, state.thread_id as i64, &base).unwrap();
        }
        super::super::attention::write_state(conn, 1, state).unwrap();
    }

    #[test]
    fn notification_count_rebases_known_slots_including_tombs_and_excluding_self() {
        let conn = db();
        for (seq, account) in [(3, "peer"), (4, "me"), (5, "peer")] {
            conn.execute("INSERT INTO messages(user_id,thread_id,seq,created_at,payload_json) VALUES(1,7,?1,0,?2)", params![seq,
                serde_json::json!({"isDeleted":true,"creator":{"account":account,"namespaceId":0}}).to_string()]).unwrap();
        }
        let owner = MessageCountOwner {
            account: "me".into(),
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
        let bytes = vec![0_u8, 128, 255];
        avatar_store();
        let digest = super::super::profile_avatars::save(
            1,
            Some(&base64::engine::general_purpose::STANDARD.encode(&bytes)),
        )
        .unwrap()
        .unwrap();
        conn.execute(
            "INSERT INTO profiles(user_id,publisher_namespace_id,profile_namespace_id,account,profile_rev,name,avatar_digest,bio) VALUES(1,0,0,'peer',1,'Peer',?1,'')",
            [digest.clone()],
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
        assert!(!batch.metadata.contains(&digest));
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
    fn preview_sender_revision_wins_over_stale_thread_peer_avatar() {
        let mut conn = db();
        let mut delivered = state(2);
        delivered.server.as_mut().unwrap().previews = vec![preview(6, 2, "LIVE", Some("new"))];
        save(&conn, &delivered);
        avatar_store();
        let bytes = vec![10_u8, 20, 30];
        let digest = super::super::profile_avatars::save(
            1,
            Some(&base64::engine::general_purpose::STANDARD.encode(&bytes)),
        )
        .unwrap()
        .unwrap();
        conn.execute(
            "INSERT INTO profiles(user_id,publisher_namespace_id,profile_namespace_id,account,profile_rev,name,avatar_digest,bio) VALUES(1,0,0,'peer',1,'Old peer',NULL,'')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO profiles(user_id,publisher_namespace_id,profile_namespace_id,account,profile_rev,name,avatar_digest,bio) VALUES(1,0,0,'peer',2,'New peer',?1,'')",
            [digest.clone()],
        )
        .unwrap();

        let batch = assemble(&mut conn, 1, vec![delivered], None).unwrap();
        let metadata: Value = serde_json::from_str(&batch.metadata).unwrap();
        assert_eq!(batch.avatars, vec![bytes]);
        assert_eq!(
            metadata["threads"][0]["previews"][0]["senderName"],
            "New peer"
        );
        assert_eq!(metadata["threads"][0]["previews"][0]["avatarIndex"], 0);
    }

    #[test]
    fn preview_profiles_use_thread_publisher_and_sender_publisher_space_namespace() {
        let conn = db();
        for (publisher, namespace, name) in [
            (7, 0, "Publisher-local member"),
            (7, 2, "Correct member"),
            (2, 2, "Wrong diagonal"),
            (0, 0, "Wrong receiver-local"),
        ] {
            super::super::contacts::write_profile(
                &conn,
                1,
                &serde_json::json!({
                    "publisherNamespaceId": publisher, "profileNamespaceId": namespace,
                    "account": "alice", "profileRev": 3, "name": name,
                    "avatarDigest": null, "bio": "",
                }),
            )
            .unwrap();
        }
        assert_eq!(
            sender_profile(&conn, 1, 7, "alice", 2, 3).unwrap().unwrap()["name"],
            "Correct member"
        );
        assert_eq!(
            sender_profile(&conn, 1, 7, "alice", 0, 3).unwrap().unwrap()["name"],
            "Publisher-local member"
        );
        assert!(sender_profile(&conn, 1, 8, "alice", 2, 3)
            .unwrap()
            .is_none());
        assert!(sender_profile(&conn, 1, 7, "alice", 2, 4)
            .unwrap()
            .is_none());
    }

    #[test]
    fn alias_titles_use_the_snapshot_and_clear_to_the_profile() {
        let mut conn = db();
        let mut delivered = state(2);
        let server = delivered.server.as_mut().unwrap();
        server.kind = "GROUP".into();
        server.role = Some("MEMBER".into());
        server.subject_account = "!group".into();
        delivered.server.as_mut().unwrap().alias = Some("Private name".into());
        save(&conn, &delivered);
        let mut presentation = super::super::thread_store::read(&conn, 1, 7)
            .unwrap()
            .unwrap();
        presentation["group"]["name"] = "Profile name".into();
        super::super::thread_store::write(&conn, 1, 7, &presentation).unwrap();
        let batch = assemble(&mut conn, 1, vec![delivered.clone()], None).unwrap();
        let metadata: Value = serde_json::from_str(&batch.metadata).unwrap();
        assert_eq!(metadata["threads"][0]["title"], "Private name");
        delivered.server.as_mut().unwrap().alias = None;
        save(&conn, &delivered);
        let batch = assemble(&mut conn, 1, vec![delivered.clone()], None).unwrap();
        let metadata: Value = serde_json::from_str(&batch.metadata).unwrap();
        assert_eq!(metadata["threads"][0]["title"], "Profile name");
        delivered.server.as_mut().unwrap().thread_profile_rev = 3;
        save(&conn, &delivered);
        super::super::contacts::write_profile(&conn, 1, &serde_json::json!({
            "account":"!group","domain":"local","publisherNamespaceId":0,"profileNamespaceId":0,"profileRev":3,
            "name":"Resolved group","avatarDigest":null,"bio":"",
        })).unwrap();
        let batch = assemble(&mut conn, 1, vec![delivered.clone()], None).unwrap();
        let metadata: Value = serde_json::from_str(&batch.metadata).unwrap();
        assert_eq!(metadata["threads"][0]["title"], "Resolved group");
        assert_eq!(
            super::super::thread_store::read(&conn, 1, 7)
                .unwrap()
                .unwrap()["group"]["name"],
            "Profile name"
        );
        delivered.notification_changed = false;
        let batch = assemble(&mut conn, 1, vec![delivered], None).unwrap();
        let metadata: Value = serde_json::from_str(&batch.metadata).unwrap();
        assert!(metadata["threads"].as_array().unwrap().is_empty());
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
            "SELECT self_profile_json FROM account_state WHERE user_id=?1",
            [user_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    let profile: Option<Value> = profile_json
        .map(|json| serde_json::from_str(&json))
        .transpose()
        .map_err(|e| e.to_string())?;
    let owner = profile
        .as_ref()
        .and_then(|value| value["account"].as_str())
        .map(|account| MessageCountOwner {
            account: account.into(),
            namespace_id: 0,
        });
    let mut notifications = Vec::new();
    let mut avatars = Vec::new();
    let mut avatar_indices = BTreeMap::new();
    for delivered in states {
        if !delivered.notification_changed {
            continue;
        }
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
        let mut thread = super::thread_store::read(&tx, user_id, i64::from(current.thread_id))?
            .unwrap_or(Value::Null);
        if !thread.is_null() {
            super::thread_store::apply_selected_profile(
                &tx,
                user_id,
                i64::from(current.thread_id),
                &mut thread,
            )?;
        }
        let mut previews = Vec::new();
        for preview in delivered
            .server
            .as_ref()
            .ok_or("missing delivered notification snapshot")?
            .previews
            .iter()
            .filter(|preview| preview.seq > local)
            .take(5)
        {
            let preview = serde_json::to_value(preview)
                .map_err(|e| format!("encode notification preview: {e}"))?;
            let account = preview["sender"]["account"]
                .as_str()
                .ok_or("invalid preview sender")?;
            let publisher_namespace =
                i64::from(delivered.server.as_ref().unwrap().authority_namespace_id);
            let profile_namespace = preview["sender"]["profileNamespaceId"]
                .as_i64()
                .ok_or("invalid preview sender namespace")?;
            let revision = preview["sender"]["profileRev"]
                .as_i64()
                .ok_or("invalid preview sender revision")?;
            let profile = sender_profile(
                &tx,
                user_id,
                publisher_namespace,
                account,
                profile_namespace,
                revision,
            )?;
            let domain = super::profile_namespaces::display_domain(
                &tx,
                user_id,
                publisher_namespace,
                profile_namespace,
            )?;
            let name = profile
                .as_ref()
                .and_then(|value| value["name"].as_str())
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| match domain.as_deref() {
                    Some(domain) => format!("{account}@{domain}"),
                    None => account.to_owned(),
                });
            let mut value = preview.clone();
            value["senderName"] = Value::String(name);
            if let Some(digest) = profile
                .as_ref()
                .and_then(|value| value["avatarDigest"].as_str())
            {
                let index = match avatar_indices.get(digest) {
                    Some(index) => Some(*index),
                    None => match super::profile_avatars::read(user_id, digest)? {
                        Some(bytes) => {
                            let index = avatars.len();
                            avatars.push(bytes);
                            avatar_indices.insert(digest.to_owned(), index);
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
        let title = server
            .alias
            .as_deref()
            .filter(|alias| !alias.is_empty())
            .or_else(|| thread["group"]["name"].as_str())
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
