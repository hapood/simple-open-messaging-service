//! Typed conversation projection storage. Wire JSON is decoded at the boundary; no
//! complete conversation object or independent avatar revision is persisted here.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

pub(super) const SCHEMA: &str = r#"
CREATE TABLE threads (
  user_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL CHECK(thread_id > 0),
  kind TEXT NOT NULL CHECK(kind IN ('P2P', 'GROUP')),
  authority_namespace_id INTEGER NOT NULL CHECK(authority_namespace_id >= 0),
  self_mention_namespace_id INTEGER CHECK(self_mention_namespace_id >= 0),
  subject_account TEXT NOT NULL CHECK(subject_account <> ''),
  thread_feed_id INTEGER NOT NULL CHECK(thread_feed_id > 0),
  conversation_state TEXT NOT NULL CHECK(conversation_state IN ('ACTIVE','READ_ONLY')),
  blocked INTEGER NOT NULL,
  alias TEXT,
  thread_profile_rev INTEGER NOT NULL CHECK(thread_profile_rev >= 0),
  message_end_seq INTEGER NOT NULL CHECK(message_end_seq >= 0),
  tombstone_end_seq INTEGER NOT NULL CHECK(tombstone_end_seq >= 0),
  group_meta_feed_end_id TEXT,
  join_request_end_feed_id INTEGER NOT NULL,
  join_request_read_feed_id INTEGER NOT NULL,
  group_invite_end_feed_id INTEGER NOT NULL,
  server_last_read_seq INTEGER NOT NULL,
  announcement_read_feed_id INTEGER NOT NULL,
  server_unread_count INTEGER NOT NULL,
  last_mention_seq INTEGER,
  local_read_seq INTEGER NOT NULL,
  last_message_at INTEGER,
  muted INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  pinned_at INTEGER,
  last_message_preview TEXT,
  last_message_sender_account TEXT,
  last_message_sender_namespace_id INTEGER,
  mention_me INTEGER NOT NULL DEFAULT 0,
  mention_all INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_read_seq INTEGER,
  role TEXT CHECK(role IN ('OWNER','ADMIN','MEMBER')),
  PRIMARY KEY(user_id,thread_id),
  CHECK(join_request_read_feed_id >= -1 AND
        join_request_read_feed_id <= join_request_end_feed_id),
  CHECK((last_message_sender_account IS NULL AND last_message_sender_namespace_id IS NULL)
     OR (last_message_sender_account IS NOT NULL AND last_message_sender_namespace_id IS NOT NULL)),
  CHECK(last_message_sender_account IS NULL OR last_message_sender_account <> ''),
  CHECK((kind='GROUP' AND subject_account LIKE '!%')
     OR kind='P2P')
);
"#;

pub(super) const PREVIEW_SCHEMA: &str = r#"
CREATE TABLE thread_previews (
  user_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  sender_account TEXT NOT NULL,
  sender_namespace_id INTEGER NOT NULL,
  sender_profile_rev INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('LIVE', 'USER_RETRACTION', 'MODERATION_REMOVAL')),
  text TEXT,
  PRIMARY KEY (user_id, thread_id),
  FOREIGN KEY (user_id, thread_id) REFERENCES threads(user_id, thread_id)
    ON DELETE CASCADE
);
"#;

/// Initialize a thread row once, from its validated feed snapshot. Existing
/// threads are changed through operation-scoped commits; an INSERT conflict
/// is an invariant error, never an implicit upsert. Last-message, mention, and
/// preference columns start at their defaults; later page commits own them.
pub(super) fn insert(
    conn: &Connection,
    user_id: i64,
    snapshot: &super::attention::ThreadFeedSnapshot,
    local_read_seq: i32,
) -> Result<(), String> {
    // Structural wire validation lives in `validate_snapshot`; the insert
    // re-checks the identity-defining fields so direct callers cannot poison
    // the durable row.
    if snapshot.thread_id <= 0
        || snapshot.thread_feed_id <= 0
        || snapshot.thread_profile_rev < 0
        || !matches!(snapshot.kind.as_str(), "P2P" | "GROUP")
        || !matches!(snapshot.conversation_state.as_str(), "ACTIVE" | "READ_ONLY")
        || snapshot.subject_account.is_empty()
        || snapshot.authority_namespace_id < 0
        || (snapshot.kind == "P2P" && snapshot.role.is_some())
        || snapshot
            .role
            .as_deref()
            .is_some_and(|role| !matches!(role, "OWNER" | "ADMIN" | "MEMBER"))
    {
        return Err("invalid thread identity".into());
    }
    // Every persisted value has its own typed SQLite column; the sender's
    // profile content is deliberately not stored here.
    conn.execute(
        "INSERT INTO threads(user_id,thread_id,kind,authority_namespace_id,
          subject_account,
          thread_feed_id,conversation_state,blocked,alias,thread_profile_rev,
          message_end_seq,tombstone_end_seq,group_meta_feed_end_id,
          join_request_end_feed_id,join_request_read_feed_id,group_invite_end_feed_id,
          server_last_read_seq,announcement_read_feed_id,server_unread_count,
          last_mention_seq,local_read_seq,
          role,self_mention_namespace_id)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,
           ?17,?18,?19,?20,?21,?22,?23)",
        params![
            user_id,
            snapshot.thread_id,
            snapshot.kind,
            snapshot.authority_namespace_id,
            snapshot.subject_account,
            snapshot.thread_feed_id,
            snapshot.conversation_state,
            snapshot.blocked,
            snapshot.alias,
            snapshot.thread_profile_rev,
            snapshot.message_end_seq,
            snapshot.tombstone_end_seq,
            snapshot.group_meta_feed_end_id,
            snapshot.join_request_end_feed_id,
            snapshot.join_request_read_feed_id,
            snapshot.group_invite_end_feed_id,
            snapshot.last_read_seq,
            snapshot.announcement_read_feed_id,
            snapshot.unread_count,
            snapshot.last_mention_seq,
            local_read_seq,
            snapshot.role,
            snapshot.self_mention_namespace_id,
        ],
    )
    .map_err(|e| format!("write typed thread: {e}"))?;
    if snapshot.kind == "GROUP" {
        conn.execute(
            "INSERT INTO group_meta(user_id,thread_id) VALUES(?1,?2)",
            params![user_id, snapshot.thread_id],
        )
        .map_err(|e| format!("initialize group meta: {e}"))?;
    }
    Ok(())
}

pub(super) fn read(
    conn: &Connection,
    user_id: i64,
    thread_id: i64,
) -> Result<Option<Value>, String> {
    conn.query_row(
        "SELECT kind,authority_namespace_id,subject_account,
           meta.member_count AS group_member_count,meta.feed_id AS group_meta_feed_id,
           meta.announcement_feed_id AS group_announcement_feed_id,
           meta.announcement_text AS group_announcement_text,
           meta.announcement_created_at AS group_announcement_created_at,
           meta.announcement_origin_created_at AS group_announcement_origin_created_at,
           meta.recovery_through AS group_meta_recovery_through,
           meta.recovery_announcement_feed_id AS group_recovery_announcement_feed_id,
           meta.recovery_announcement_text AS group_recovery_announcement_text,
           meta.recovery_announcement_created_at AS group_recovery_announcement_created_at,
           meta.recovery_announcement_origin_created_at AS group_recovery_announcement_origin_created_at,
           last_message_at,muted,pinned,pinned_at,
           last_message_preview,last_message_sender_account,last_message_sender_namespace_id,mention_me,mention_all,
           unread_count,last_read_seq,role,
           thread_feed_id,conversation_state,blocked,alias,thread_profile_rev,
           message_end_seq,tombstone_end_seq,group_meta_feed_end_id,
           join_request_end_feed_id,join_request_read_feed_id,group_invite_end_feed_id,
           server_last_read_seq,announcement_read_feed_id,server_unread_count,
           last_mention_seq,local_read_seq,self_mention_namespace_id
         FROM threads LEFT JOIN group_meta meta
           ON meta.user_id=threads.user_id AND meta.thread_id=threads.thread_id
         WHERE threads.user_id=?1 AND threads.thread_id=?2",
        params![user_id, thread_id], |row| {
            let kind: String = row.get("kind")?;
            let account: String = row.get("subject_account")?;
            let mut item = serde_json::json!({
                "threadId": thread_id, "type": kind, "publisherNamespaceId": row.get::<_, i64>("authority_namespace_id")?,
                "account": account,
                "profile": { "name": account, "bio": "", "avatarDigest": null },
                "visible": true,
                "lastMessageAt": row.get::<_, Option<i64>>("last_message_at")?,
                "muted": row.get::<_, bool>("muted")?, "pinned": row.get::<_, bool>("pinned")?,
                "pinnedAt": row.get::<_, Option<i64>>("pinned_at")?,
                "lastMessagePreview": row.get::<_, Option<String>>("last_message_preview")?,
                "lastMessageSenderAccount": row.get::<_, Option<String>>("last_message_sender_account")?,
                "lastMessageSenderNamespaceId": row.get::<_, Option<i64>>("last_message_sender_namespace_id")?,
                "mentionUnread": [],
                "unreadCount": row.get::<_, i64>("unread_count")?,
                "lastReadSeq": row.get::<_, Option<i64>>("last_read_seq")?,
                "role": row.get::<_, Option<String>>("role")?,
                "threadFeedId": row.get::<_, i64>("thread_feed_id")?,
                "conversationState": row.get::<_, String>("conversation_state")?,
                "blocked": row.get::<_, bool>("blocked")?,
                "alias": row.get::<_, Option<String>>("alias")?,
                "profileRev": row.get::<_, i64>("thread_profile_rev")?,
                "messageEndSeq": row.get::<_, i64>("message_end_seq")?,
                "tombstoneEndSeq": row.get::<_, i64>("tombstone_end_seq")?,
                "groupMetaFeedEndId": row.get::<_, Option<String>>("group_meta_feed_end_id")?,
                "joinRequestEndFeedId": row.get::<_, i64>("join_request_end_feed_id")?,
                "joinRequestReadFeedId": row.get::<_, i64>("join_request_read_feed_id")?,
                "groupInviteEndFeedId": row.get::<_, i64>("group_invite_end_feed_id")?,
                "serverLastReadSeq": row.get::<_, i64>("server_last_read_seq")?,
                "announcementReadFeedId": row.get::<_, i64>("announcement_read_feed_id")?,
                "serverUnreadCount": row.get::<_, i64>("server_unread_count")?,
                "lastMentionSeq": row.get::<_, Option<i64>>("last_mention_seq")?,
                "localReadSeq": row.get::<_, i64>("local_read_seq")?,
                "selfMentionNamespaceId": row.get::<_, Option<i64>>("self_mention_namespace_id")?,
            });
            let mut mentions = Vec::new();
            if row.get::<_, bool>("mention_me")? { mentions.push("me"); }
            if row.get::<_, bool>("mention_all")? { mentions.push("all"); }
            item["mentionUnread"] = serde_json::json!(mentions);
            if kind == "GROUP" {
                item["meta"] = serde_json::json!({
                    "memberCount": row.get::<_, i64>("group_member_count")?,
                    "groupMetaFeedId": row.get::<_, String>("group_meta_feed_id")?,
                    "announcementFeedId": row.get::<_, Option<String>>("group_announcement_feed_id")?,
                    "announcementText": row.get::<_, Option<String>>("group_announcement_text")?,
                    "announcementCreatedAt": row.get::<_, Option<i64>>("group_announcement_created_at")?,
                    "announcementOriginCreatedAt": row.get::<_, Option<i64>>("group_announcement_origin_created_at")?,
                    "recoveryThrough": row.get::<_, Option<String>>("group_meta_recovery_through")?,
                    "recoveryAnnouncementFeedId": row.get::<_, Option<String>>("group_recovery_announcement_feed_id")?,
                    "recoveryAnnouncementText": row.get::<_, Option<String>>("group_recovery_announcement_text")?,
                    "recoveryAnnouncementCreatedAt": row.get::<_, Option<i64>>("group_recovery_announcement_created_at")?,
                    "recoveryAnnouncementOriginCreatedAt": row.get::<_, Option<i64>>("group_recovery_announcement_origin_created_at")?,
                });
            }
            Ok(item)
        }
    ).optional().map_err(|e| format!("read typed thread: {e}"))
}

/// Materialize the exact immutable profile selected by this thread's feed fields.
/// A late presentation write must not override these bytes or change the
/// `thread_profile_rev` stored on the same row.
pub(super) fn apply_selected_profile(
    conn: &Connection,
    user_id: i64,
    thread_id: i64,
    item: &mut Value,
) -> Result<(), String> {
    let selected: Option<(String, String, Option<String>)> = conn
        .query_row(
            "SELECT profile.name,profile.bio,profile.avatar_digest FROM threads state
         JOIN profiles profile ON profile.user_id=state.user_id
           AND profile.account=state.subject_account
           AND profile.publisher_namespace_id=state.authority_namespace_id
           AND profile.profile_namespace_id=0
           AND profile.profile_rev=state.thread_profile_rev
         WHERE state.user_id=?1 AND state.thread_id=?2 AND state.thread_profile_rev>0",
            params![user_id, thread_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("read selected thread profile: {e}"))?;
    let account = item["account"]
        .as_str()
        .ok_or("thread profile account missing")?;
    let (name, bio, avatar_digest) =
        selected.unwrap_or_else(|| (account.to_owned(), String::new(), None));
    item["profile"] = serde_json::json!({
        "name": name, "bio": bio, "avatarDigest": avatar_digest,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_presentation_in_columns_without_an_old_avatar_revision() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
            CREATE TABLE profile_namespaces(user_id INTEGER,publisher_namespace_id INTEGER,
              profile_namespace_id INTEGER,domain TEXT,
              PRIMARY KEY(user_id,publisher_namespace_id,profile_namespace_id));",
        )
        .unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute_batch(super::super::group_meta_store::SCHEMA)
            .unwrap();
        let input = serde_json::json!({
            "threadId": 7, "type": "GROUP", "publisherNamespaceId": 0,
            "profileAccount": "!room", "profileRev": 3, "role": null,
            "selfMentionNamespaceId": 12,
            "threadFeedId":1,"conversationState":"ACTIVE","blocked":false,"alias":null,
            "messageEndSeq":4,"tombstoneEndSeq":0,
            "groupMetaFeedEndId":"3","joinRequestEndFeedId":0,
            "joinRequestReadFeedId":0,"groupInviteEndFeedId":0,
            "lastReadSeq":0,"announcementReadFeedId":0,
            "unreadCount":2,"lastMentionSeq":null,"previews":[]
        });
        let snapshot: super::super::attention::ThreadFeedSnapshot =
            serde_json::from_value(input.clone()).unwrap();
        insert(&conn, 1, &snapshot, 0).unwrap();
        assert_eq!(
            read(&conn, 1, 7).unwrap().unwrap()["meta"]["memberCount"],
            0
        );
        let mut meta = super::super::group_meta_store::GroupMetaState {
            member_count: 2,
            feed_id: "3".into(),
            announcement_feed_id: None,
            announcement_text: None,
            announcement_created_at: None,
            announcement_origin_created_at: None,
            recovery_through: None,
            recovery_announcement_feed_id: None,
            recovery_announcement_text: None,
            recovery_announcement_created_at: None,
            recovery_announcement_origin_created_at: None,
        };
        super::super::group_meta_store::commit(&conn, 1, 7, &meta).unwrap();
        let restored = read(&conn, 1, 7).unwrap().unwrap();
        assert_eq!(
            restored["profile"],
            serde_json::json!({"name":"!room","bio":"","avatarDigest":null})
        );
        assert_eq!(restored["account"], "!room");
        assert_eq!(restored["publisherNamespaceId"], 0);
        assert_eq!(restored["selfMentionNamespaceId"], 12);
        let mut missing = input.clone();
        missing
            .as_object_mut()
            .unwrap()
            .remove("selfMentionNamespaceId");
        assert!(
            serde_json::from_value::<super::super::attention::ThreadFeedSnapshot>(missing).is_err()
        );
        assert_eq!(restored["meta"]["memberCount"], 2);
        assert_eq!(restored["messageEndSeq"], 4);
        // Feed facts initialize independently from the derived list counters.
        // The subsequent attention commit owns their projection.
        assert_eq!(restored["serverUnreadCount"], 2);
        assert_eq!(restored["unreadCount"], 0);
        assert!(restored["lastReadSeq"].is_null());
        assert_eq!(restored["localReadSeq"], 0);
        assert!(restored.get("lastMessageSeq").is_none());
        assert_eq!(restored["mentionUnread"], serde_json::json!([]));
        assert_eq!(restored["meta"]["announcementFeedId"], Value::Null);
        assert_eq!(restored["meta"]["recoveryAnnouncementFeedId"], Value::Null);
        assert_eq!(restored["profileRev"], 3);
        for obsolete in [
            "group",
            "peerUser",
            "authorityNamespaceId",
            "threadProfileRev",
        ] {
            assert!(restored.get(obsolete).is_none());
        }
        let mut columns = conn.prepare("PRAGMA table_info(threads)").unwrap();
        let names: Vec<String> = columns
            .query_map([], |row| row.get(1))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(!names.contains(&"payload_json".to_owned()));
        assert!(!names.contains(&"profile_rev".to_owned()));
        assert!(names.contains(&"thread_profile_rev".to_owned()));
        assert!(!names.contains(&"last_message_seq".to_owned()));
        assert!(!names.contains(&"group_dissolved_at".to_owned()));
        assert!(restored["meta"].get("dissolvedAt").is_none());
        assert!(!names.contains(&"group_member_count".to_owned()));
        assert!(!names.contains(&"group_meta_feed_id".to_owned()));
        assert!(!names.contains(&"group_meta_recovery_through".to_owned()));
        assert!(!names.contains(&"group_owner_id".to_owned()));
        assert!(!names.contains(&"group_announcement_known".to_owned()));
        assert!(!names.contains(&"group_recovery_announcement_known".to_owned()));
        assert!(restored["meta"].get("ownerId").is_none());
        for obsolete in [
            "subject_created_at",
            "subject_updated_at",
            "peer_is_deleted",
        ] {
            assert!(!names.contains(&obsolete.to_owned()));
        }
        for obsolete in ["createdAt", "updatedAt", "isDeleted"] {
            assert!(restored["profile"].get(obsolete).is_none());
        }
        let mut peer = snapshot.clone();
        peer.thread_id = 8;
        peer.kind = "P2P".into();
        peer.subject_account = "peer".into();
        insert(&conn, 1, &peer, 0).unwrap();
        let peer = read(&conn, 1, 8).unwrap().unwrap();
        assert!(peer.get("meta").is_none());
        for obsolete in ["createdAt", "updatedAt", "isDeleted"] {
            assert!(peer["profile"].get(obsolete).is_none());
        }

        assert!(insert(&conn, 1, &snapshot, 0).is_err());
        let cleared = read(&conn, 1, 7).unwrap().unwrap();
        assert!(cleared["meta"]["announcementFeedId"].is_null());
        assert!(cleared["meta"]["recoveryAnnouncementFeedId"].is_null());
        meta.announcement_feed_id = Some("4".into());
        meta.announcement_created_at = Some(1_000);
        meta.announcement_origin_created_at = Some(500);
        meta.recovery_announcement_feed_id = Some("5".into());
        meta.recovery_announcement_text = Some("Notice".into());
        meta.recovery_announcement_created_at = Some(2_000);
        meta.recovery_announcement_origin_created_at = Some(1_500);
        super::super::group_meta_store::commit(&conn, 1, 7, &meta).unwrap();
        // Reinitialization is rejected rather than overwriting committed facts.
        assert!(insert(&conn, 1, &snapshot, 0).is_err());
        let restored = read(&conn, 1, 7).unwrap().unwrap();
        assert_eq!(restored["meta"]["memberCount"], 2);
        assert_eq!(restored["meta"]["groupMetaFeedId"], "3");
        assert_eq!(restored["meta"]["announcementFeedId"], "4");
        assert_eq!(restored["meta"]["announcementCreatedAt"], 1_000);
        assert_eq!(restored["meta"]["announcementOriginCreatedAt"], 500);
        assert_eq!(restored["meta"]["announcementText"], Value::Null);
        assert_eq!(restored["meta"]["recoveryAnnouncementFeedId"], "5");
        assert_eq!(restored["meta"]["recoveryAnnouncementText"], "Notice");
        assert_eq!(restored["meta"]["recoveryAnnouncementCreatedAt"], 2_000);
        assert_eq!(
            restored["meta"]["recoveryAnnouncementOriginCreatedAt"],
            1_500
        );
        meta.announcement_feed_id = None;
        meta.announcement_text = Some("Missing feed id".into());
        assert!(super::super::group_meta_store::commit(&conn, 1, 7, &meta).is_err());
    }
}
