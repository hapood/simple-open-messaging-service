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

/// Initialize a thread once. Existing threads are changed through operation-scoped
/// commits; an INSERT conflict is an invariant error, never an implicit upsert.
pub(super) fn insert(
    conn: &Connection,
    user_id: i64,
    thread_id: i64,
    item: &Value,
) -> Result<(), String> {
    let kind = item
        .get("type")
        .and_then(Value::as_str)
        .ok_or("thread type missing")?;
    if !matches!(kind, "P2P" | "GROUP") {
        return Err("invalid thread type".into());
    }
    let account = item
        .get("account")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("thread subject account missing")?;
    // The subject's profile namespace is structurally the thread's authority
    // namespace; no separate subject coordinate exists.
    let authority = item
        .get("publisherNamespaceId")
        .and_then(Value::as_i64)
        .filter(|n| *n >= 0)
        .ok_or("thread authority namespace missing")?;
    if item.get("threadId").and_then(Value::as_i64) != Some(thread_id) || thread_id <= 0 {
        return Err("thread id mismatch".into());
    }
    for field in [
        "threadFeedId",
        "conversationState",
        "selfMentionNamespaceId",
        "blocked",
        "alias",
        "profileRev",
        "messageEndSeq",
        "tombstoneEndSeq",
        "groupMetaFeedEndId",
        "joinRequestEndFeedId",
        "joinRequestReadFeedId",
        "groupInviteEndFeedId",
        "serverLastReadSeq",
        "announcementReadFeedId",
        "serverUnreadCount",
        "lastMentionSeq",
        "localReadSeq",
    ] {
        if item.get(field).is_none() {
            return Err(format!("thread state has no {field}"));
        }
    }
    if item.get("selfMentionNamespaceId").is_some_and(|value| {
        !value.is_null() && value.as_i64().is_none_or(|namespace| namespace < 0)
    }) {
        return Err("invalid self mention namespace".into());
    }
    if item["threadFeedId"].as_i64().is_none_or(|id| id <= 0)
        || item["profileRev"].as_i64().is_none_or(|rev| rev < 0)
    {
        return Err("thread state has invalid feed or profile revision".into());
    }
    let json = serde_json::to_string(item).map_err(|e| format!("encode thread input: {e}"))?;
    // json_extract acts only on the transient IPC input. Every persisted value has its
    // own typed SQLite column; the sender's profileRev is deliberately not stored.
    conn.execute(
        "INSERT INTO threads(user_id,thread_id,kind,authority_namespace_id,
          subject_account,
          thread_feed_id,conversation_state,blocked,alias,thread_profile_rev,
          message_end_seq,tombstone_end_seq,group_meta_feed_end_id,
          join_request_end_feed_id,join_request_read_feed_id,group_invite_end_feed_id,
          server_last_read_seq,announcement_read_feed_id,server_unread_count,
          last_mention_seq,local_read_seq,
          last_message_at,muted,pinned,pinned_at,
          last_message_preview,last_message_sender_account,last_message_sender_namespace_id,mention_me,mention_all,
          unread_count,last_read_seq,role,self_mention_namespace_id)
         VALUES(?1,?2,?3,?4,?5,
           json_extract(?6,'$.threadFeedId'),
           json_extract(?6,'$.conversationState'),json_extract(?6,'$.blocked'),
           json_extract(?6,'$.alias'),json_extract(?6,'$.profileRev'),
           json_extract(?6,'$.messageEndSeq'),json_extract(?6,'$.tombstoneEndSeq'),
           json_extract(?6,'$.groupMetaFeedEndId'),
           json_extract(?6,'$.joinRequestEndFeedId'),
           json_extract(?6,'$.joinRequestReadFeedId'),
           json_extract(?6,'$.groupInviteEndFeedId'),
           json_extract(?6,'$.serverLastReadSeq'),
           json_extract(?6,'$.announcementReadFeedId'),
           json_extract(?6,'$.serverUnreadCount'),
           json_extract(?6,'$.lastMentionSeq'),
           json_extract(?6,'$.localReadSeq'),
           json_extract(?6,'$.lastMessageAt'),
           COALESCE(json_extract(?6,'$.muted'),0),COALESCE(json_extract(?6,'$.pinned'),0),
           json_extract(?6,'$.pinnedAt'),json_extract(?6,'$.lastMessagePreview'),
           json_extract(?6,'$.lastMessageSenderAccount'),
           json_extract(?6,'$.lastMessageSenderNamespaceId'),
           EXISTS(SELECT 1 FROM json_each(?6,'$.mentionUnread') WHERE value='me'),
           EXISTS(SELECT 1 FROM json_each(?6,'$.mentionUnread') WHERE value='all'),
           COALESCE(json_extract(?6,'$.unreadCount'),0),json_extract(?6,'$.lastReadSeq'),
           json_extract(?6,'$.role'),json_extract(?6,'$.selfMentionNamespaceId'))",
        params![user_id, thread_id, kind, authority, account, json],
    ).map_err(|e| format!("write typed thread: {e}"))?;
    if kind == "GROUP" {
        conn.execute(
            "INSERT INTO group_meta(user_id,thread_id) VALUES(?1,?2)",
            params![user_id, thread_id],
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
           meta.recovery_through AS group_meta_recovery_through,
           meta.recovery_announcement_feed_id AS group_recovery_announcement_feed_id,
           meta.recovery_announcement_text AS group_recovery_announcement_text,
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
                    "recoveryThrough": row.get::<_, Option<String>>("group_meta_recovery_through")?,
                    "recoveryAnnouncementFeedId": row.get::<_, Option<String>>("group_recovery_announcement_feed_id")?,
                    "recoveryAnnouncementText": row.get::<_, Option<String>>("group_recovery_announcement_text")?,
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
            "account": "!room", "profileRev": 3,
            "selfMentionNamespaceId": 12,
            "threadFeedId":1,"conversationState":"ACTIVE","blocked":false,"alias":null,
            "messageEndSeq":4,"tombstoneEndSeq":0,
            "groupMetaFeedEndId":"3","joinRequestEndFeedId":0,
            "joinRequestReadFeedId":0,"groupInviteEndFeedId":0,
            "serverLastReadSeq":0,"announcementReadFeedId":0,
            "serverUnreadCount":2,"lastMentionSeq":null,"localReadSeq":0,
            "profile": { "name": "Team", "bio": "About", "avatarDigest": null },
            "meta": { "memberCount": 2, "groupMetaFeedId": "3" },
            "unreadCount": 2,
            "mentionUnread": ["me"],
        });
        insert(&conn, 1, 7, &input).unwrap();
        assert_eq!(
            read(&conn, 1, 7).unwrap().unwrap()["meta"]["memberCount"],
            0
        );
        let mut meta = super::super::group_meta_store::GroupMetaState {
            member_count: 2,
            feed_id: "3".into(),
            announcement_feed_id: None,
            announcement_text: None,
            recovery_through: None,
            recovery_announcement_feed_id: None,
            recovery_announcement_text: None,
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
        assert!(insert(&conn, 1, 7, &missing).is_err());
        assert_eq!(restored["meta"]["memberCount"], 2);
        assert_eq!(restored["messageEndSeq"], 4);
        assert!(restored.get("lastMessageSeq").is_none());
        assert_eq!(restored["mentionUnread"], serde_json::json!(["me"]));
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
        let mut peer = input.clone();
        peer["threadId"] = 8.into();
        peer["type"] = "P2P".into();
        peer["account"] = "peer".into();
        peer.as_object_mut().unwrap().remove("meta");
        insert(&conn, 1, 8, &peer).unwrap();
        let peer = read(&conn, 1, 8).unwrap().unwrap();
        assert!(peer.get("meta").is_none());
        for obsolete in ["createdAt", "updatedAt", "isDeleted"] {
            assert!(peer["profile"].get(obsolete).is_none());
        }

        let mut changed = input.clone();
        changed["meta"]["announcementFeedId"] = Value::Null;
        changed["meta"]["recoveryAnnouncementFeedId"] = Value::Null;
        assert!(insert(&conn, 1, 7, &changed).is_err());
        let cleared = read(&conn, 1, 7).unwrap().unwrap();
        assert!(cleared["meta"]["announcementFeedId"].is_null());
        assert!(cleared["meta"]["recoveryAnnouncementFeedId"].is_null());
        meta.announcement_feed_id = Some("4".into());
        meta.recovery_announcement_feed_id = Some("5".into());
        meta.recovery_announcement_text = Some("Notice".into());
        super::super::group_meta_store::commit(&conn, 1, 7, &meta).unwrap();
        // Reinitialization is rejected rather than overwriting committed facts.
        assert!(insert(&conn, 1, 7, &changed).is_err());
        let restored = read(&conn, 1, 7).unwrap().unwrap();
        assert_eq!(restored["meta"]["memberCount"], 2);
        assert_eq!(restored["meta"]["groupMetaFeedId"], "3");
        assert_eq!(restored["meta"]["announcementFeedId"], "4");
        assert_eq!(restored["meta"]["announcementText"], Value::Null);
        assert_eq!(restored["meta"]["recoveryAnnouncementFeedId"], "5");
        assert_eq!(restored["meta"]["recoveryAnnouncementText"], "Notice");
        meta.announcement_feed_id = None;
        meta.announcement_text = Some("Missing feed id".into());
        assert!(super::super::group_meta_store::commit(&conn, 1, 7, &meta).is_err());
    }
}
