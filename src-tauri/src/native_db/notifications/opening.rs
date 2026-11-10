//! Per-tap refresh ceiling, deliberately separate from stable notification identity.
use super::NotificationTarget;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NotificationOpening {
    pub(crate) target: NotificationTarget,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) latest_seq: Option<i32>,
}

impl NotificationOpening {
    pub(crate) fn new(target: NotificationTarget, latest_seq: Option<i32>) -> Option<Self> {
        let valid_seq = match target {
            NotificationTarget::Thread { .. } => latest_seq.is_some_and(|seq| seq >= 0),
            _ => latest_seq.is_none(),
        };
        (target.valid() && valid_seq).then_some(Self { target, latest_seq })
    }

    pub(crate) fn parse(raw: &str) -> Option<Self> {
        let value: Self = serde_json::from_str(raw).ok()?;
        Self::new(value.target, value.latest_seq)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_openings_require_an_explicit_bounded_ceiling() {
        for seq in [0, 42, i32::MAX] {
            let raw = format!(r#"{{"target":{{"kind":"thread","threadId":7}},"latestSeq":{seq}}}"#);
            let opening = NotificationOpening::parse(&raw).unwrap();
            assert_eq!(opening.latest_seq, Some(seq));
            assert_eq!(opening.target.key(), "thread/7");
            assert_eq!(serde_json::to_value(opening).unwrap()["latestSeq"], seq);
        }
        for raw in [
            r#"{"target":{"kind":"thread","threadId":7}}"#,
            r#"{"target":{"kind":"thread","threadId":7},"latestSeq":null}"#,
            r#"{"target":{"kind":"thread","threadId":7},"latestSeq":-1}"#,
            r#"{"target":{"kind":"thread","threadId":7},"latestSeq":2147483648}"#,
            r#"{"target":{"kind":"thread","threadId":7},"latestSeq":"42"}"#,
            r#"{"target":{"kind":"thread","threadId":7},"latestSeq":1.5}"#,
            r#"{"target":{"kind":"thread","threadId":0},"latestSeq":42}"#,
            r#"{"threadId":7,"latestSeq":42}"#,
            "7",
        ] {
            assert_eq!(NotificationOpening::parse(raw), None, "{raw}");
        }
    }

    #[test]
    fn request_openings_do_not_carry_message_sequences() {
        for target in [
            NotificationTarget::FriendRequests {},
            NotificationTarget::GroupJoinRequests { thread_id: 7 },
        ] {
            let opening = NotificationOpening::new(target, None).unwrap();
            let wire = serde_json::to_value(opening).unwrap();
            assert!(wire.get("latestSeq").is_none());
            assert_eq!(NotificationOpening::parse(&wire.to_string()), Some(opening));
            assert_eq!(NotificationOpening::new(target, Some(42)), None);
        }
    }
}
