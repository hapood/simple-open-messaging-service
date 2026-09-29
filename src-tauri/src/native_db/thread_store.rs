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
  subject_account TEXT NOT NULL CHECK(subject_account <> ''),
  subject_domain TEXT NOT NULL CHECK(subject_domain <> ''),
  subject_namespace_id INTEGER NOT NULL CHECK(subject_namespace_id >= 0),
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
  subject_name TEXT NOT NULL DEFAULT '',
  subject_avatar TEXT NOT NULL DEFAULT '',
  subject_bio TEXT NOT NULL DEFAULT '',
  subject_created_at INTEGER NOT NULL DEFAULT 0,
  subject_updated_at INTEGER NOT NULL DEFAULT 0,
  peer_is_deleted INTEGER NOT NULL DEFAULT 0,
  peer_profile_message_seq INTEGER,
  group_id INTEGER,
  group_dissolved_at INTEGER,
  group_member_count INTEGER NOT NULL DEFAULT 0,
  group_meta_feed_id TEXT NOT NULL DEFAULT '0',
  group_announcement_feed_id TEXT,
  group_announcement_text TEXT,
  group_meta_recovery_through TEXT,
  group_meta_target_feed_id TEXT,
  group_recovery_announcement_feed_id TEXT,
  group_recovery_announcement_text TEXT,
  last_message_at INTEGER,
  last_message_seq INTEGER,
  muted INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  pinned_at INTEGER,
  last_message_preview TEXT,
  last_message_sender_id TEXT,
  mention_me INTEGER NOT NULL DEFAULT 0,
  mention_all INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_read_seq INTEGER,
  role TEXT CHECK(role IN ('OWNER','ADMIN','MEMBER')),
  PRIMARY KEY(user_id,thread_id),
  FOREIGN KEY(user_id,subject_domain,authority_namespace_id)
    REFERENCES namespaces(user_id,domain,namespace_id),
  CHECK(subject_namespace_id = authority_namespace_id),
  CHECK(join_request_read_feed_id >= -1 AND
        join_request_read_feed_id <= join_request_end_feed_id),
  CHECK(group_announcement_feed_id IS NOT NULL OR group_announcement_text IS NULL),
  CHECK(group_recovery_announcement_feed_id IS NOT NULL OR group_recovery_announcement_text IS NULL),
  CHECK((kind='GROUP' AND subject_account LIKE '!%' AND group_id > 0)
     OR (kind='P2P' AND group_id IS NULL))
);
CREATE TRIGGER threads_namespace_before_insert BEFORE INSERT ON threads BEGIN
  UPDATE namespaces SET status='ARCHIVED' WHERE user_id=NEW.user_id
    AND domain=NEW.subject_domain AND namespace_id<NEW.authority_namespace_id;
  INSERT OR IGNORE INTO namespaces(user_id,namespace_id,domain,status)
  VALUES(NEW.user_id,NEW.authority_namespace_id,NEW.subject_domain,
    CASE WHEN NEW.authority_namespace_id=0 OR NOT EXISTS(
      SELECT 1 FROM namespaces WHERE user_id=NEW.user_id AND domain=NEW.subject_domain
        AND namespace_id>NEW.authority_namespace_id
    ) THEN 'ACTIVE' ELSE 'ARCHIVED' END);
END;
"#;

pub(super) const PREVIEW_SCHEMA: &str = r#"
CREATE TABLE thread_previews (
  user_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  sender_account TEXT NOT NULL,
  sender_domain TEXT NOT NULL,
  sender_namespace_id INTEGER NOT NULL,
  sender_profile_rev INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('LIVE', 'USER_RETRACTION', 'MODERATION_REMOVAL')),
  text TEXT,
  PRIMARY KEY (user_id, thread_id),
  FOREIGN KEY (user_id, thread_id) REFERENCES threads(user_id, thread_id)
    ON DELETE CASCADE
);
"#;

pub(super) fn write(
    conn: &Connection,
    user_id: i64,
    thread_id: i64,
    item: &Value,
) -> Result<(), String> {
    let kind = item
        .get("type")
        .and_then(Value::as_str)
        .ok_or("thread type missing")?;
    let subject = match kind {
        "P2P" => item.get("peerUser"),
        "GROUP" => item.get("group"),
        _ => return Err("invalid thread type".into()),
    }
    .ok_or("thread subject missing")?;
    let account = subject
        .get("account")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("thread subject account missing")?;
    let domain = subject
        .get("domain")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("thread subject domain missing")?;
    let namespace = subject
        .get("namespaceId")
        .and_then(Value::as_i64)
        .filter(|n| *n >= 0)
        .ok_or("thread subject namespace missing")?;
    let authority = item
        .get("authorityNamespaceId")
        .and_then(Value::as_i64)
        .filter(|n| *n == namespace)
        .ok_or("thread authority namespace mismatch")?;
    if (domain == "local") != (namespace == 0) {
        return Err("thread subject namespace does not match domain".into());
    }
    if kind == "GROUP"
        && subject
            .get("id")
            .and_then(Value::as_i64)
            .is_none_or(|id| id <= 0)
    {
        return Err("group thread has no positive local thread id".into());
    }
    if kind == "GROUP" {
        for announcement in [
            subject.get("announcement"),
            item.get("groupMetaRecoveryAnnouncement"),
        ]
        .into_iter()
        .flatten()
        {
            if announcement.is_null() {
                continue;
            }
            if announcement
                .get("feedId")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
                || announcement
                    .get("text")
                    .is_none_or(|text| !text.is_null() && !text.is_string())
            {
                return Err("group announcement needs a feed id and nullable text".into());
            }
        }
    }
    if item.get("threadId").and_then(Value::as_i64) != Some(thread_id) || thread_id <= 0 {
        return Err("thread id mismatch".into());
    }
    for field in [
        "threadFeedId", "conversationState", "blocked", "alias", "threadProfileRev",
        "messageEndSeq", "tombstoneEndSeq", "groupMetaFeedEndId",
        "joinRequestEndFeedId", "joinRequestReadFeedId", "groupInviteEndFeedId",
        "serverLastReadSeq", "announcementReadFeedId", "serverUnreadCount",
        "lastMentionSeq", "localReadSeq",
    ] {
        if item.get(field).is_none() {
            return Err(format!("thread state has no {field}"));
        }
    }
    if item["threadFeedId"].as_i64().is_none_or(|id| id <= 0)
        || item["threadProfileRev"].as_i64().is_none_or(|rev| rev < 0)
    {
        return Err("thread state has invalid feed or profile revision".into());
    }
    let json = serde_json::to_string(item).map_err(|e| format!("encode thread input: {e}"))?;
    // json_extract acts only on the transient IPC input. Every persisted value has its
    // own typed SQLite column; the sender's profileRev is deliberately not stored.
    conn.execute(
        "INSERT INTO threads(user_id,thread_id,kind,authority_namespace_id,
          subject_account,subject_domain,subject_namespace_id,
          thread_feed_id,conversation_state,blocked,alias,thread_profile_rev,
          message_end_seq,tombstone_end_seq,group_meta_feed_end_id,
          join_request_end_feed_id,join_request_read_feed_id,group_invite_end_feed_id,
          server_last_read_seq,announcement_read_feed_id,server_unread_count,
          last_mention_seq,local_read_seq,
          subject_name,subject_avatar,
          subject_bio,subject_created_at,subject_updated_at,peer_is_deleted,
          peer_profile_message_seq,group_id,group_dissolved_at,
          group_member_count,group_meta_feed_id,group_announcement_feed_id,
          group_announcement_text,group_meta_recovery_through,
          group_meta_target_feed_id,group_recovery_announcement_feed_id,
          group_recovery_announcement_text,
          last_message_at,last_message_seq,muted,pinned,pinned_at,
          last_message_preview,last_message_sender_id,mention_me,mention_all,
          unread_count,last_read_seq,role)
         VALUES(?1,?2,?3,?4,?5,?6,?7,
           json_extract(?9,'$.threadFeedId'),
           json_extract(?9,'$.conversationState'),json_extract(?9,'$.blocked'),
           json_extract(?9,'$.alias'),json_extract(?9,'$.threadProfileRev'),
           json_extract(?9,'$.messageEndSeq'),json_extract(?9,'$.tombstoneEndSeq'),
           json_extract(?9,'$.groupMetaFeedEndId'),
           json_extract(?9,'$.joinRequestEndFeedId'),
           json_extract(?9,'$.joinRequestReadFeedId'),
           json_extract(?9,'$.groupInviteEndFeedId'),
           json_extract(?9,'$.serverLastReadSeq'),
           json_extract(?9,'$.announcementReadFeedId'),
           json_extract(?9,'$.serverUnreadCount'),
           json_extract(?9,'$.lastMentionSeq'),
           json_extract(?9,'$.localReadSeq'),
           COALESCE(json_extract(?8,'$.name'),''),
           COALESCE(json_extract(?8,'$.avatar'),''),
           COALESCE(json_extract(?8,'$.bio'),json_extract(?8,'$.description'),''),
           COALESCE(json_extract(?8,'$.createdAt'),0),COALESCE(json_extract(?8,'$.updatedAt'),0),
           COALESCE(json_extract(?8,'$.isDeleted'),0),
           json_extract(?9,'$.peerProfileMessageSeq'),
           CASE WHEN ?3='GROUP' THEN json_extract(?8,'$.id') END,
           json_extract(?8,'$.dissolvedAt'),COALESCE(json_extract(?8,'$.memberCount'),0),
           COALESCE(json_extract(?8,'$.groupMetaFeedId'),'0'),
           json_extract(?8,'$.announcement.feedId'),json_extract(?8,'$.announcement.text'),
           json_extract(?9,'$.groupMetaRecoveryThrough'),
           json_extract(?9,'$.groupMetaTargetFeedId'),
           json_extract(?9,'$.groupMetaRecoveryAnnouncement.feedId'),
           json_extract(?9,'$.groupMetaRecoveryAnnouncement.text'),
           json_extract(?9,'$.lastMessageAt'),json_extract(?9,'$.lastMessageSeq'),
           COALESCE(json_extract(?9,'$.muted'),0),COALESCE(json_extract(?9,'$.pinned'),0),
           json_extract(?9,'$.pinnedAt'),json_extract(?9,'$.lastMessagePreview'),
           json_extract(?9,'$.lastMessageSenderId'),
           EXISTS(SELECT 1 FROM json_each(?9,'$.mentionUnread') WHERE value='me'),
           EXISTS(SELECT 1 FROM json_each(?9,'$.mentionUnread') WHERE value='all'),
           COALESCE(json_extract(?9,'$.unreadCount'),0),json_extract(?9,'$.lastReadSeq'),
           json_extract(?9,'$.role'))
         ON CONFLICT(user_id,thread_id) DO UPDATE SET
           kind=excluded.kind,authority_namespace_id=excluded.authority_namespace_id,
           subject_account=excluded.subject_account,subject_domain=excluded.subject_domain,
           subject_namespace_id=excluded.subject_namespace_id,subject_name=excluded.subject_name,
           subject_avatar=excluded.subject_avatar,subject_bio=excluded.subject_bio,
           subject_created_at=excluded.subject_created_at,subject_updated_at=excluded.subject_updated_at,
           peer_is_deleted=excluded.peer_is_deleted,peer_profile_message_seq=excluded.peer_profile_message_seq,
           group_id=excluded.group_id,
           group_dissolved_at=excluded.group_dissolved_at,group_member_count=excluded.group_member_count,
           group_meta_feed_id=excluded.group_meta_feed_id,
           group_announcement_feed_id=excluded.group_announcement_feed_id,
           group_announcement_text=excluded.group_announcement_text,
           group_meta_recovery_through=excluded.group_meta_recovery_through,
           group_meta_target_feed_id=excluded.group_meta_target_feed_id,
           group_recovery_announcement_feed_id=excluded.group_recovery_announcement_feed_id,
           group_recovery_announcement_text=excluded.group_recovery_announcement_text,
           last_message_at=excluded.last_message_at,last_message_seq=excluded.last_message_seq,
           muted=excluded.muted,pinned=excluded.pinned,pinned_at=excluded.pinned_at,
           last_message_preview=excluded.last_message_preview,
           last_message_sender_id=excluded.last_message_sender_id,
           mention_me=excluded.mention_me,mention_all=excluded.mention_all,
           unread_count=excluded.unread_count,last_read_seq=excluded.last_read_seq,
           role=excluded.role",
        params![user_id, thread_id, kind, authority, account, domain, namespace, subject.to_string(), json],
    ).map_err(|e| format!("write typed thread: {e}"))?;
    Ok(())
}

pub(super) fn read(
    conn: &Connection,
    user_id: i64,
    thread_id: i64,
) -> Result<Option<Value>, String> {
    conn.query_row(
        "SELECT kind,authority_namespace_id,subject_account,subject_domain,subject_namespace_id,
           subject_name,subject_avatar,subject_bio,subject_created_at,subject_updated_at,
           peer_is_deleted,peer_profile_message_seq,group_id,group_dissolved_at,
           group_member_count,group_meta_feed_id,group_announcement_feed_id,group_announcement_text,
           group_meta_recovery_through,group_meta_target_feed_id,
           group_recovery_announcement_feed_id,group_recovery_announcement_text,
           last_message_at,last_message_seq,muted,pinned,pinned_at,
           last_message_preview,last_message_sender_id,mention_me,mention_all,
           unread_count,last_read_seq,role,
           thread_feed_id,conversation_state,blocked,alias,thread_profile_rev,
           message_end_seq,tombstone_end_seq,group_meta_feed_end_id,
           join_request_end_feed_id,join_request_read_feed_id,group_invite_end_feed_id,
           server_last_read_seq,announcement_read_feed_id,server_unread_count,
           last_mention_seq,local_read_seq
         FROM threads WHERE user_id=?1 AND thread_id=?2",
        params![user_id, thread_id], |row| {
            let kind: String = row.get(0)?;
            let account: String = row.get(2)?;
            let domain: String = row.get(3)?;
            let namespace: i64 = row.get(4)?;
            let mut item = serde_json::json!({
                "threadId": thread_id, "type": kind, "authorityNamespaceId": row.get::<_, i64>(1)?,
                "lastMessageAt": row.get::<_, Option<i64>>(22)?,
                "lastMessageSeq": row.get::<_, Option<i64>>(23)?,
                "muted": row.get::<_, bool>(24)?, "pinned": row.get::<_, bool>(25)?,
                "pinnedAt": row.get::<_, Option<i64>>(26)?,
                "lastMessagePreview": row.get::<_, Option<String>>(27)?,
                "lastMessageSenderId": row.get::<_, Option<String>>(28)?,
                "mentionUnread": [],
                "unreadCount": row.get::<_, i64>(31)?,
                "lastReadSeq": row.get::<_, Option<i64>>(32)?,
                "role": row.get::<_, Option<String>>(33)?,
                "threadFeedId": row.get::<_, i64>(34)?,
                "conversationState": row.get::<_, String>(35)?,
                "blocked": row.get::<_, bool>(36)?,
                "alias": row.get::<_, Option<String>>(37)?,
                "threadProfileRev": row.get::<_, i64>(38)?,
                "messageEndSeq": row.get::<_, i64>(39)?,
                "tombstoneEndSeq": row.get::<_, i64>(40)?,
                "groupMetaFeedEndId": row.get::<_, Option<String>>(41)?,
                "joinRequestEndFeedId": row.get::<_, i64>(42)?,
                "joinRequestReadFeedId": row.get::<_, i64>(43)?,
                "groupInviteEndFeedId": row.get::<_, i64>(44)?,
                "serverLastReadSeq": row.get::<_, i64>(45)?,
                "announcementReadFeedId": row.get::<_, i64>(46)?,
                "serverUnreadCount": row.get::<_, i64>(47)?,
                "lastMentionSeq": row.get::<_, Option<i64>>(48)?,
                "localReadSeq": row.get::<_, i64>(49)?,
            });
            let mut mentions = Vec::new();
            if row.get::<_, bool>(29)? { mentions.push("me"); }
            if row.get::<_, bool>(30)? { mentions.push("all"); }
            item["mentionUnread"] = serde_json::json!(mentions);
            let name: String = row.get(5)?;
            let avatar: String = row.get(6)?;
            let bio: String = row.get(7)?;
            let created_at: i64 = row.get(8)?;
            let updated_at: i64 = row.get(9)?;
            if kind == "P2P" {
                item["peerUser"] = serde_json::json!({
                    "account":account,"domain":domain,"namespaceId":namespace,
                    "name":name,"avatar":avatar,"bio":bio,
                    "createdAt":created_at,"updatedAt":updated_at,
                    "isDeleted":row.get::<_, bool>(10)?,"isGroup":false,
                });
                if let Some(seq) = row.get::<_, Option<i64>>(11)? { item["peerProfileMessageSeq"] = seq.into(); }
            } else {
                let mut group = serde_json::json!({
                    "id":row.get::<_, Option<i64>>(12)?,
                    "account":account,"domain":domain,"namespaceId":namespace,
                    "name":name,"avatar":avatar,"description":bio,
                    "createdAt":created_at,"updatedAt":updated_at,
                    "dissolvedAt":row.get::<_, Option<i64>>(13)?,
                    "memberCount":row.get::<_, i64>(14)?,"groupMetaFeedId":row.get::<_, String>(15)?,
                    "isGroup":true,
                });
                group["announcement"] = match row.get::<_, Option<String>>(16)? {
                    Some(feed_id) => serde_json::json!({
                        "feedId":feed_id,"text":row.get::<_, Option<String>>(17)?,
                    }),
                    None => Value::Null,
                };
                item["group"] = group;
                item["groupMetaRecoveryThrough"] = serde_json::json!(row.get::<_, Option<String>>(18)?);
                if let Some(target) = row.get::<_, Option<String>>(19)? {
                    item["groupMetaTargetFeedId"] = target.into();
                }
                item["groupMetaRecoveryAnnouncement"] =
                    match row.get::<_, Option<String>>(20)? {
                        Some(feed_id) => serde_json::json!({
                            "feedId":feed_id,"text":row.get::<_, Option<String>>(21)?,
                        }),
                        None => Value::Null,
                    };
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
    let selected: Option<(String, String)> = conn
        .query_row(
            "SELECT profile.name,profile.bio FROM threads state
         JOIN profiles profile ON profile.user_id=state.user_id
           AND profile.account=state.subject_account AND profile.domain=state.subject_domain
           AND profile.publisher_namespace_id=state.subject_namespace_id AND profile.profile_namespace_id=state.subject_namespace_id
           AND profile.profile_rev=state.thread_profile_rev
         WHERE state.user_id=?1 AND state.thread_id=?2 AND state.thread_profile_rev>0",
            params![user_id, thread_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("read selected thread profile: {e}"))?;
    if let Some((name, bio)) = selected {
        let key = if item["type"] == "GROUP" {
            "group"
        } else {
            "peerUser"
        };
        item[key]["name"] = name.into();
        item[key]["avatar"] = "".into();
        item[key][if key == "group" { "description" } else { "bio" }] = bio.into();
    }
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
            CREATE TABLE namespaces(user_id INTEGER,namespace_id INTEGER,domain TEXT,
              status TEXT, PRIMARY KEY(user_id,namespace_id),
              UNIQUE(user_id,domain,namespace_id));",
        )
        .unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let input = serde_json::json!({
            "threadId": 7, "type": "GROUP", "authorityNamespaceId": 0,
            "profileRev": 99,
            "threadFeedId":1,"conversationState":"ACTIVE","blocked":false,"alias":null,
            "threadProfileRev":3,"messageEndSeq":4,"tombstoneEndSeq":0,
            "groupMetaFeedEndId":"3","joinRequestEndFeedId":0,
            "joinRequestReadFeedId":0,"groupInviteEndFeedId":0,
            "serverLastReadSeq":0,"announcementReadFeedId":0,
            "serverUnreadCount":2,"lastMentionSeq":null,"localReadSeq":0,
            "group": { "id": 7, "account": "!room", "domain": "local",
                "namespaceId": 0, "name": "Team", "avatar": "", "description": "About",
                "memberCount": 2, "groupMetaFeedId": "3" },
            "lastMessageSeq": 4, "unreadCount": 2,
            "mentionUnread": ["me"],
        });
        write(&conn, 1, 7, &input).unwrap();
        let restored = read(&conn, 1, 7).unwrap().unwrap();
        assert_eq!(restored["group"]["name"], "Team");
        assert_eq!(restored["group"]["memberCount"], 2);
        assert_eq!(restored["mentionUnread"], serde_json::json!(["me"]));
        assert_eq!(restored["group"]["announcement"], Value::Null);
        assert_eq!(restored["groupMetaRecoveryAnnouncement"], Value::Null);
        assert!(restored.get("profileRev").is_none());
        let mut columns = conn.prepare("PRAGMA table_info(threads)").unwrap();
        let names: Vec<String> = columns
            .query_map([], |row| row.get(1))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(!names.contains(&"payload_json".to_owned()));
        assert!(!names.contains(&"profile_rev".to_owned()));
        assert!(names.contains(&"thread_profile_rev".to_owned()));
        assert!(!names.contains(&"group_owner_id".to_owned()));
        assert!(!names.contains(&"group_announcement_known".to_owned()));
        assert!(!names.contains(&"group_recovery_announcement_known".to_owned()));
        assert!(restored["group"].get("ownerId").is_none());

        let mut changed = input.clone();
        changed["group"]["announcement"] = Value::Null;
        changed["groupMetaRecoveryAnnouncement"] = Value::Null;
        write(&conn, 1, 7, &changed).unwrap();
        let cleared = read(&conn, 1, 7).unwrap().unwrap();
        assert!(cleared["group"].get("announcement").unwrap().is_null());
        assert!(cleared
            .get("groupMetaRecoveryAnnouncement")
            .unwrap()
            .is_null());
        changed["group"]["announcement"] = serde_json::json!({"feedId":"4","text":null});
        changed["groupMetaRecoveryAnnouncement"] =
            serde_json::json!({"feedId":"5","text":"Notice"});
        write(&conn, 1, 7, &changed).unwrap();
        let restored = read(&conn, 1, 7).unwrap().unwrap();
        assert_eq!(
            restored["group"]["announcement"],
            changed["group"]["announcement"]
        );
        assert_eq!(
            restored["groupMetaRecoveryAnnouncement"],
            changed["groupMetaRecoveryAnnouncement"]
        );
        changed["group"]["announcement"] = serde_json::json!({"text":null});
        assert!(write(&conn, 1, 7, &changed).is_err());
    }
}
