//! Request attention is a watermark, not a count of pending applications.
use super::{
    content::{NotificationCommand, NotificationContent},
    NotificationTarget,
};
use rusqlite::{Connection, OptionalExtension};
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RequestAttention {
    pub(crate) target: NotificationTarget,
    pub(crate) end: i64,
    pub(crate) read: i64,
    pub(crate) eligible: bool,
    pub(crate) title: String,
    pub(crate) muted: bool,
}
pub(crate) type RequestBaseline = HashMap<NotificationTarget, RequestAttention>;

/// Seed from the persisted authoritative view before either feed advances. Existing
/// unread requests are not new arrivals; imported OS cards are rebuilt separately.
pub(crate) async fn capture_baseline(
    work: crate::login_connection::DatabaseWork,
    user: i64,
) -> Result<(), String> {
    if work
        .owner()
        .notification_requests
        .lock()
        .map_err(|_| "request state poisoned")?
        .is_some()
    {
        return Ok(());
    }
    super::super::spawn_owned_database(Ok(work.clone()), move |conn| {
        let current = read(conn, user)?;
        let mut baseline = work
            .owner()
            .notification_requests
            .lock()
            .map_err(|_| "request state poisoned")?;
        if baseline.is_none() {
            *baseline = Some(
                current
                    .into_iter()
                    .map(|value| (value.target, value))
                    .collect(),
            );
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn read(conn: &Connection, user: i64) -> Result<Vec<RequestAttention>, String> {
    let mut result = Vec::new();
    let personal = conn.query_row("SELECT intent_request_end_id,intent_request_read_id,intent_request_optimistic_read_id FROM account_state WHERE user_id=?1", [user], |r| Ok((r.get::<_,Option<i64>>(0)?,r.get::<_,Option<i64>>(1)?,r.get::<_,Option<i64>>(2)?))).optional().map_err(|e| e.to_string())?;
    if let Some((Some(end), Some(read), optimistic)) = personal {
        result.push(RequestAttention {
            target: NotificationTarget::FriendRequests {},
            end,
            read: read.max(optimistic.unwrap_or(0)),
            eligible: true,
            title: String::new(),
            muted: false,
        });
    }
    let mut statement = conn.prepare("SELECT thread_id,join_request_end_feed_id,join_request_read_feed_id,role,conversation_state,blocked,muted FROM threads WHERE user_id=?1 AND kind='GROUP'").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([user], |r| {
            Ok((
                r.get::<_, i32>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, bool>(5)?,
                r.get::<_, bool>(6)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (thread_id, end, read, role, state, blocked, muted) = row.map_err(|e| e.to_string())?;
        let mut thread =
            super::super::thread_store::read(conn, user, i64::from(thread_id))?.unwrap_or_default();
        super::super::thread_store::apply_selected_profile(
            conn,
            user,
            i64::from(thread_id),
            &mut thread,
        )?;
        let title = thread["alias"]
            .as_str()
            .filter(|v| !v.is_empty())
            .or_else(|| thread["profile"]["name"].as_str())
            .unwrap_or_default()
            .to_owned();
        result.push(RequestAttention {
            target: NotificationTarget::GroupJoinRequests { thread_id },
            end,
            read,
            eligible: read >= 0
                && matches!(role.as_deref(), Some("OWNER" | "ADMIN"))
                && state == "ACTIVE"
                && !blocked,
            title,
            muted,
        });
    }
    Ok(result)
}

pub(crate) fn command(
    value: &RequestAttention,
    preferences: &super::super::preferences::NotificationPreferences,
    language: &str,
    alert: bool,
) -> NotificationCommand {
    if !preferences.enabled || !value.eligible || value.read >= value.end {
        return NotificationCommand::Remove {
            target: value.target,
        };
    }
    let zh = language.to_ascii_lowercase().starts_with("zh");
    let personal = value.target == NotificationTarget::FriendRequests {};
    let label = match (personal, zh) {
        (true, true) => "新的好友请求或群邀请",
        (true, false) => "New friend requests or group invitations",
        (false, true) => "新的入群申请",
        (false, false) => "New group join requests",
    };
    NotificationCommand::Show(NotificationContent {
        target: value.target,
        latest_seq: None,
        title: if preferences.private_preview || personal || value.title.is_empty() {
            "SOMS".into()
        } else {
            value.title.clone()
        },
        body: label.into(),
        count: 1,
        silent: !alert || !preferences.sound || value.muted,
        messages: vec![],
        has_unread_mention: false,
    })
}

pub(crate) fn selected(
    current: &[RequestAttention],
    previous: &RequestBaseline,
    live: &[NotificationTarget],
    reconstruction: bool,
    preferences: &super::super::preferences::NotificationPreferences,
    language: &str,
) -> Vec<NotificationCommand> {
    let mut commands = Vec::new();
    for value in current {
        let old = previous.get(&value.target);
        let arrival = old.is_some_and(|old| value.end > old.end);
        if reconstruction
            || arrival
            || (live.contains(&value.target) && (old != Some(value) || !preferences.enabled))
        {
            commands.push(command(
                value,
                preferences,
                language,
                arrival && !reconstruction,
            ));
        }
    }
    for target in live {
        if !matches!(target, NotificationTarget::Thread { .. })
            && !current.iter().any(|value| value.target == *target)
        {
            commands.push(NotificationCommand::Remove { target: *target });
        }
    }
    commands
}

#[cfg(test)]
mod tests {
    use super::*;
    fn prefs() -> super::super::super::preferences::NotificationPreferences {
        super::super::super::preferences::NotificationPreferences {
            enabled: true,
            sound: true,
            private_preview: false,
        }
    }
    fn attention(end: i64, read: i64) -> RequestAttention {
        RequestAttention {
            target: NotificationTarget::FriendRequests {},
            end,
            read,
            eligible: true,
            title: "Private group".into(),
            muted: false,
        }
    }
    fn baseline(value: RequestAttention) -> RequestBaseline {
        [(value.target, value)].into_iter().collect()
    }
    #[tokio::test]
    async fn baseline_is_seeded_from_persisted_heads_before_first_background_arrival() {
        let conn = Connection::open_in_memory().unwrap();
        super::super::super::create_cache_schema(&conn).unwrap();
        conn.execute("INSERT INTO account_state(user_id,intent_request_end_id,intent_request_read_id) VALUES(1,100,100)",[]).unwrap();
        let owner = crate::login_connection::LoginConnection::preparing(
            crate::login_session_store::LoginSessionId::try_from(uuid::Uuid::new_v4().to_string())
                .unwrap(),
            conn,
        );
        owner
            .begin_activation()
            .unwrap()
            .commit("token".into())
            .unwrap();
        capture_baseline(owner.capture_database_work().unwrap(), 1)
            .await
            .unwrap();
        let previous = owner.notification_requests.lock().unwrap().clone().unwrap();
        assert_eq!(previous[&NotificationTarget::FriendRequests {}].end, 100);
        let commands = selected(
            &[attention(200, 100)],
            &previous,
            &[],
            false,
            &prefs(),
            "en",
        );
        assert!(matches!(&commands[0],NotificationCommand::Show(value) if !value.silent));
    }
    #[test]
    fn sparse_bigint_heads_are_boolean_and_only_arrivals_alert() {
        let before = attention(9_000_000_000_000_000, 9_000_000_000_000_000);
        let current = attention(before.end + 91, before.read);
        let commands = selected(
            &[current.clone()],
            &baseline(before),
            &[],
            false,
            &prefs(),
            "en",
        );
        assert!(
            matches!(&commands[0],NotificationCommand::Show(value) if value.count == 1 && !value.silent)
        );
        assert!(selected(
            &[current.clone()],
            &baseline(current.clone()),
            &[],
            false,
            &prefs(),
            "en"
        )
        .is_empty());
        let mut read = current.clone();
        read.read = read.end;
        assert!(matches!(
            selected(
                &[read],
                &baseline(current.clone()),
                &[current.target],
                false,
                &prefs(),
                "en"
            )[0],
            NotificationCommand::Remove { .. }
        ));
    }
    #[test]
    fn initial_personal_baseline_does_not_create_old_cards_but_reconstruction_preserves_live_cards()
    {
        let current = attention(100, 0);
        assert!(selected(
            &[current.clone()],
            &Default::default(),
            &[],
            false,
            &prefs(),
            "en"
        )
        .is_empty());
        let restored = selected(
            &[current.clone()],
            &Default::default(),
            &[current.target],
            true,
            &prefs(),
            "en",
        );
        assert!(matches!(&restored[0],NotificationCommand::Show(value) if value.silent));
        let mut disabled = prefs();
        disabled.enabled = false;
        assert!(matches!(
            selected(
                &[current.clone()],
                &baseline(current.clone()),
                &[current.target],
                false,
                &disabled,
                "en"
            )[0],
            NotificationCommand::Remove { .. }
        ));
    }
    #[test]
    fn group_cards_are_independent_and_role_loss_removes_only_applications() {
        let mut value = attention(5, 0);
        value.target = NotificationTarget::GroupJoinRequests { thread_id: 7 };
        assert_ne!(value.target, NotificationTarget::Thread { thread_id: 7 });
        assert!(selected(
            &[value.clone()],
            &Default::default(),
            &[],
            false,
            &prefs(),
            "en"
        )
        .is_empty());
        let mut before = value.clone();
        before.end = 0;
        assert!(
            matches!(&selected(&[value.clone()],&baseline(before),&[],false,&prefs(),"en")[0],NotificationCommand::Show(c) if !c.silent)
        );
        let mut lost = value.clone();
        lost.eligible = false;
        lost.read = -1;
        assert!(
            matches!(selected(&[lost],&baseline(value.clone()),&[value.target],false,&prefs(),"en")[0],NotificationCommand::Remove { target } if target == value.target)
        );
        let mut private = prefs();
        private.private_preview = true;
        private.sound = false;
        let NotificationCommand::Show(c) = command(&value, &private, "en", true) else {
            panic!()
        };
        assert_eq!(c.title, "SOMS");
        assert!(c.latest_seq.is_none());
        assert!(serde_json::to_value(&c).unwrap().get("latestSeq").is_none());
        assert!(c.silent);
        assert!(c.messages.is_empty());
    }
    #[test]
    fn group_projection_reads_real_schema_role_and_local_read_watermark() {
        let conn = Connection::open_in_memory().unwrap();
        super::super::super::create_cache_schema(&conn).unwrap();
        let snapshot: super::super::super::attention::ThreadFeedSnapshot = serde_json::from_value(serde_json::json!({
            "type":"GROUP","publisherNamespaceId":0,"selfMentionNamespaceId":null,"conversationState":"ACTIVE",
            "blocked":false,"role":"ADMIN","profileAccount":"!group","threadId":7,"threadFeedId":1,"alias":"Group alias",
            "messageEndSeq":0,"profileRev":0,"tombstoneEndSeq":0,"groupMetaFeedEndId":null,
            "joinRequestEndFeedId":5,"joinRequestReadFeedId":0,"groupInviteEndFeedId":0,"lastReadSeq":0,
            "announcementReadFeedId":0,"unreadCount":0,"lastMentionSeq":null,"previews":[]
        })).unwrap();
        super::super::super::thread_store::insert(&conn, 1, &snapshot, 0).unwrap();
        let values = read(&conn, 1).unwrap();
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].title, "Group alias");
        assert!(values[0].eligible);
        conn.execute(
            "UPDATE threads SET join_request_read_feed_id=5 WHERE user_id=1",
            [],
        )
        .unwrap();
        assert!(matches!(
            command(&read(&conn, 1).unwrap()[0], &prefs(), "en", false),
            NotificationCommand::Remove { .. }
        ));
        conn.execute(
            "UPDATE threads SET role='MEMBER',join_request_read_feed_id=-1 WHERE user_id=1",
            [],
        )
        .unwrap();
        assert!(!read(&conn, 1).unwrap()[0].eligible);
    }
    #[test]
    fn projection_uses_account_scope_and_optimistic_read_without_subtracting_ids() {
        let conn = Connection::open_in_memory().unwrap();
        super::super::super::create_cache_schema(&conn).unwrap();
        conn.execute("INSERT INTO account_state(user_id,intent_request_end_id,intent_request_read_id,intent_request_optimistic_read_id) VALUES(1,9223372036854775800,1,9223372036854775800)",[]).unwrap();
        let current = read(&conn, 1).unwrap();
        assert_eq!(current.len(), 1);
        assert!(matches!(
            command(&current[0], &prefs(), "en", true),
            NotificationCommand::Remove { .. }
        ));
        assert!(read(&conn, 2).unwrap().is_empty());
    }
}
