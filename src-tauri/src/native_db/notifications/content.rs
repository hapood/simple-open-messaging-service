use super::{NotificationThread, NotificationTarget};

#[derive(Clone, Copy)]
pub(crate) struct NotificationCopy<'a> {
    pub(crate) private_body: &'a str,
    pub(crate) retracted: &'a str,
    pub(crate) removed: &'a str,
}

pub(crate) fn localized_copy(language: &str) -> NotificationCopy<'static> {
    if language.to_ascii_lowercase().starts_with("zh") {
        NotificationCopy {
            private_body: "新消息",
            retracted: "[消息已撤回]",
            removed: "[消息已被管理员删除]",
        }
    } else {
        NotificationCopy {
            private_body: "New message",
            retracted: "[Message retracted]",
            removed: "[Message removed by administrator]",
        }
    }
}

/// Platform-neutral content assembled from Rust's unread projection.
/// OS adapters render these values rather than interpreting message events.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotificationMessage {
    pub(crate) seq: i64,
    pub(crate) sender_name: String,
    pub(crate) sender_key: Option<String>,
    pub(crate) timestamp_ms: Option<i64>,
    pub(crate) avatar_index: Option<u64>,
    pub(crate) text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotificationContent {
    pub(crate) target: NotificationTarget,
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) count: i64,
    pub(crate) silent: bool,
    pub(crate) messages: Vec<NotificationMessage>,
    pub(crate) has_unread_mention: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "operation", content = "notification", rename_all = "camelCase")]
pub(crate) enum NotificationCommand {
    Remove { target: NotificationTarget },
    /// Upsert the card identified by its typed target; never append a duplicate card.
    Show(NotificationContent),
}

/// Observations supplied by the host, not a second notification policy.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct PresentationFacts {
    pub(crate) visible: bool,
    pub(crate) focused: bool,
    /// None when the host is not displaying a conversation.
    pub(crate) open_thread: Option<i32>,
}

pub(crate) fn visible_thread(facts: PresentationFacts) -> Option<i32> {
    facts.open_thread.filter(|id| facts.visible && facts.focused && *id > 0)
}

/// Recheck queued shows against the host facts at execution time. Existing removals
/// remain removals: a later focus change cannot turn a read/disabled card into a show.
pub(crate) fn observe_before_delivery(
    command: NotificationCommand,
    facts: PresentationFacts,
) -> NotificationCommand {
    match command {
        NotificationCommand::Show(content) if visible_thread(facts).map(NotificationTarget::from) == Some(content.target) => {
            NotificationCommand::Remove { target: content.target }
        }
        other => other,
    }
}

/// Decide presentation from the same facts on every native platform. Removing the
/// active conversation's existing card also prevents stale notifications after reading.
pub(crate) fn command_with_facts(
    thread: &NotificationThread,
    preferences: &super::super::preferences::NotificationPreferences,
    facts: PresentationFacts,
    copy: NotificationCopy<'_>,
) -> NotificationCommand {
    if visible_thread(facts) == Some(thread.thread_id) {
        return NotificationCommand::Remove { target: thread.thread_id.into() };
    }
    command(thread, preferences, copy)
}

/// Shared presentation policy. A disabled notification or an empty unread projection
/// removes the existing card instead of leaving stale content in the OS notification center.
pub(crate) fn command(
    thread: &NotificationThread,
    preferences: &super::super::preferences::NotificationPreferences,
    copy: NotificationCopy<'_>,
) -> NotificationCommand {
    if !preferences.enabled || thread.unread_count <= 0 {
        return NotificationCommand::Remove { target: thread.thread_id.into() };
    }
    let mut notification = content(thread, preferences.private_preview, copy);
    notification.silent |= !preferences.sound;
    NotificationCommand::Show(notification)
}

fn content(
    thread: &NotificationThread,
    private_preview: bool,
    copy: NotificationCopy<'_>,
) -> NotificationContent {
    let messages: Vec<NotificationMessage> = if private_preview {
        Vec::new()
    } else {
        let mut previews: Vec<_> = thread.previews.iter()
            .filter(|preview| preview["seq"].as_i64().is_some_and(|seq| seq > i64::from(thread.last_read_seq)))
            .collect();
        previews.sort_by_key(|preview| preview["seq"].as_i64().unwrap_or_default());
        previews.into_iter()
            .map(|preview| {
                let text = match preview["status"].as_str() {
                    Some("USER_RETRACTION") => copy.retracted,
                    Some("MODERATION_REMOVAL") => copy.removed,
                    Some("LIVE") => preview["text"].as_str().filter(|text| !text.is_empty()).unwrap_or(copy.private_body),
                    // Unknown states must never expose potentially removed content.
                    _ => copy.private_body,
                };
                NotificationMessage {
                    seq: preview["seq"].as_i64().unwrap_or_default(),
                    sender_name: preview["senderName"].as_str().unwrap_or_default().to_owned(),
                    sender_key: match (preview["sender"]["account"].as_str(), preview["sender"]["domain"].as_str()) {
                        (Some(account), Some(domain)) => Some(format!("{account}@{domain}")),
                        _ => None,
                    },
                    timestamp_ms: preview["timestamp"].as_i64(),
                    avatar_index: preview["avatarIndex"].as_u64(),
                    text: text.to_owned(),
                }
            }).collect()
    };
    NotificationContent {
        target: thread.thread_id.into(),
        title: thread.title.clone(),
        body: if messages.is_empty() { copy.private_body.to_owned() } else {
            messages.iter().map(|message| message.text.as_str()).collect::<Vec<_>>().join("\n")
        },
        messages,
        has_unread_mention: thread.has_unread_mention,
        count: thread.unread_count,
        silent: thread.muted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn thread() -> NotificationThread {
        NotificationThread {
            thread_id: 7, thread_feed_id: 9, unread_count: 3,
            last_read_seq: 2, has_unread_mention: false, muted: true,
            title: "Alice".into(),
            previews: vec![
                json!({"seq":2,"text":"already read"}),
                json!({"seq":3,"text":"hello","status":"LIVE"}),
                json!({"seq":4,"text":"removed secret","status":"USER_RETRACTION"}),
                json!({"seq":5,"text":"moderated secret","status":"MODERATION_REMOVAL"}),
            ],
        }
    }

    fn copy() -> NotificationCopy<'static> {
        NotificationCopy { private_body: "New message", retracted: "Retracted", removed: "Removed" }
    }

    #[test]
    fn uses_only_unread_previews_and_replaces_removed_content() {
        let result = content(&thread(), false, copy());
        assert_eq!(result.body, "hello\nRetracted\nRemoved");
        assert_eq!(result.title, "Alice");
        assert_eq!(result.count, 3);
        assert!(result.silent);
    }

    #[test]
    fn unordered_previews_are_sorted_and_unknown_status_does_not_expose_text() {
        let mut thread = thread();
        thread.previews.reverse();
        thread.previews.push(json!({"seq":6,"status":"UNKNOWN","text":"secret"}));
        assert_eq!(content(&thread, false, copy()).body, "hello\nRetracted\nRemoved\nNew message");
    }

    #[test]
    fn message_structure_preserves_avatar_and_sender_but_not_retracted_text() {
        let mut thread = thread();
        thread.previews = vec![json!({
            "seq": 8, "status": "USER_RETRACTION", "text": "secret",
            "sender": {"account": "peer", "domain": "example.test"},
            "senderName": "Peer", "timestamp": 1767225600000_i64, "avatarIndex": 2,
        })];
        let result = content(&thread, false, copy());
        assert_eq!(result.messages, vec![NotificationMessage {
            seq: 8, sender_name: "Peer".into(), sender_key: Some("peer@example.test".into()),
            timestamp_ms: Some(1767225600000),
            avatar_index: Some(2), text: "Retracted".into(),
        }]);
        assert!(!result.body.contains("secret"));
    }

    #[test]
    fn timestamps_are_forwarded_from_the_rust_projection() {
        for timestamp in [1767225600000_i64, 1767225600123_i64] {
            let mut thread = thread();
            thread.has_unread_mention = true;
            thread.previews = vec![json!({"seq":9,"status":"LIVE","text":"hello","timestamp":timestamp})];
            let result = content(&thread, false, copy());
            assert_eq!(result.messages[0].timestamp_ms, Some(timestamp));
            assert!(result.has_unread_mention);
        }
        let mut thread = thread();
        thread.previews = vec![json!({"seq":9,"status":"LIVE","text":"hello","timestamp":"invalid"})];
        let result = content(&thread, false, copy());
        assert_eq!(result.messages[0].timestamp_ms, None);
        assert_eq!(result.messages[0].sender_key, None);
    }

    #[test]
    fn wire_commands_contain_decisions_not_raw_message_events() {
        let remove = serde_json::to_value(NotificationCommand::Remove { target: NotificationTarget::Thread { thread_id: 7 } }).unwrap();
        assert_eq!(remove, json!({"operation":"remove","notification":{"target":{"kind":"thread","threadId":7}}}));
        let show = NotificationCommand::Show(content(&thread(), true, copy()));
        let wire = serde_json::to_value(show).unwrap();
        assert_eq!(wire["operation"], "show");
        assert_eq!(wire["notification"]["target"]["threadId"], 7);
        assert_eq!(wire["notification"]["body"], "New message");
        assert_eq!(wire["notification"]["messages"], json!([]));
        assert!(wire["notification"].get("previews").is_none());
        assert!(!wire.to_string().contains("hello"));
        assert!(!wire.to_string().contains("removed secret"));
    }

    #[test]
    fn private_command_strips_sender_timestamp_and_avatar_references() {
        let mut thread = thread();
        thread.previews = vec![json!({
            "seq": 9, "status": "LIVE", "text": "private message",
            "senderName": "Private sender", "sender": {"account":"private-account","domain":"private.test"},
            "createdAt": "2026-01-01T00:00:00Z", "avatarIndex": 3,
        })];
        let preferences = super::super::super::preferences::NotificationPreferences {
            enabled: true, sound: true, private_preview: true,
        };
        let command = command(&thread, &preferences, copy());
        let wire = serde_json::to_value(command).unwrap();
        assert_eq!(wire["notification"]["messages"], json!([]));
        assert_eq!(wire["notification"]["body"], "New message");
        let raw = wire.to_string();
        for value in ["private message", "Private sender", "private-account", "private.test", "2026-01-01", "avatarIndex"] {
            assert!(!raw.contains(value), "private command leaked {value}");
        }
    }

    #[test]
    fn private_mode_never_includes_message_text() {
        let result = content(&thread(), true, copy());
        assert_eq!(result.body, "New message");
        assert!(result.messages.is_empty());
    }

    #[test]
    fn disabled_or_read_threads_only_emit_removal() {
        let mut preferences = super::super::super::preferences::NotificationPreferences {
            enabled: false, sound: true, private_preview: false,
        };
        assert_eq!(command(&thread(), &preferences, copy()), NotificationCommand::Remove { target: NotificationTarget::Thread { thread_id: 7 } });
        preferences.enabled = true;
        let mut read = thread();
        read.unread_count = 0;
        assert_eq!(command(&read, &preferences, copy()), NotificationCommand::Remove { target: NotificationTarget::Thread { thread_id: 7 } });
    }

    #[test]
    fn global_sound_and_privacy_apply_before_platform_delivery() {
        let preferences = super::super::super::preferences::NotificationPreferences {
            enabled: true, sound: false, private_preview: true,
        };
        let mut unmuted = thread();
        unmuted.muted = false;
        let NotificationCommand::Show(result) = command(&unmuted, &preferences, copy()) else {
            panic!("expected a notification");
        };
        assert!(result.silent);
        assert_eq!(result.body, "New message");
    }

    #[test]
    fn queued_show_is_removed_when_its_thread_becomes_active() {
        let show = NotificationCommand::Show(content(&thread(), false, copy()));
        let facts = PresentationFacts { visible: true, focused: true, open_thread: Some(7) };
        assert_eq!(observe_before_delivery(show, facts), NotificationCommand::Remove { target: NotificationTarget::Thread { thread_id: 7 } });
        assert_eq!(observe_before_delivery(NotificationCommand::Remove { target: NotificationTarget::Thread { thread_id: 7 } },
            PresentationFacts::default()), NotificationCommand::Remove { target: NotificationTarget::Thread { thread_id: 7 } });
    }

    #[test]
    fn queued_show_is_preserved_when_another_thread_or_unfocused_window_is_observed() {
        for facts in [
            PresentationFacts { visible: true, focused: true, open_thread: Some(8) },
            PresentationFacts { visible: true, focused: false, open_thread: Some(7) },
        ] {
            let show = NotificationCommand::Show(content(&thread(), false, copy()));
            assert_eq!(observe_before_delivery(show.clone(), facts), show);
        }
    }

    #[test]
    fn presentation_observation_removes_only_a_positive_visible_target() {
        assert_eq!(visible_thread(PresentationFacts::default()), None);
        for id in [-1, 0, 7] {
            for visible in [false, true] {
                for focused in [false, true] {
                    assert_eq!(visible_thread(PresentationFacts {
                        visible, focused, open_thread: Some(id),
                    }), (id > 0 && visible && focused).then_some(id));
                }
            }
        }
    }

    #[test]
    fn active_conversation_is_suppressed_only_in_focused_foreground() {
        let preferences = super::super::super::preferences::NotificationPreferences {
            enabled: true, sound: true, private_preview: false,
        };
        for (visible, focused, open_thread, suppressed) in [
            (true, true, Some(7), true),
            (false, true, Some(7), false),
            (true, false, Some(7), false),
            (true, true, Some(8), false),
            (true, true, None, false),
        ] {
            let command = command_with_facts(&thread(), &preferences,
                PresentationFacts { visible, focused, open_thread }, copy());
            assert_eq!(matches!(command, NotificationCommand::Remove { .. }), suppressed);
        }
    }

    #[test]
    fn localized_content_uses_native_copy_without_renderer_descriptors() {
        assert_eq!(content(&thread(), true, localized_copy("zh-CN")).body, "新消息");
        assert_eq!(content(&thread(), true, localized_copy("en")).body, "New message");
        assert_eq!(content(&thread(), true, localized_copy("unknown")).body, "New message");
        assert!(!content(&thread(), false, localized_copy("zh-CN")).body.contains("removed secret"));
    }

    #[test]
    fn missing_unread_preview_uses_private_fallback() {
        let mut thread = thread();
        thread.last_read_seq = 5;
        assert_eq!(content(&thread, false, copy()).body, "New message");
    }
}
