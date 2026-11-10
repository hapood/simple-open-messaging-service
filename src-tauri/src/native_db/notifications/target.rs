//! Navigation destination and stable card key. Request cards never share message identity.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum NotificationTarget {
    Thread {
        #[serde(rename = "threadId")]
        thread_id: i32,
    },
    FriendRequests {},
    GroupJoinRequests {
        #[serde(rename = "threadId")]
        thread_id: i32,
    },
}

impl NotificationTarget {
    pub(crate) fn valid(self) -> bool {
        match self {
            Self::Thread { thread_id } | Self::GroupJoinRequests { thread_id } => thread_id > 0,
            Self::FriendRequests {} => true,
        }
    }
    pub(crate) fn key(self) -> String {
        match self {
            Self::Thread { thread_id } => format!("thread/{thread_id}"),
            Self::FriendRequests {} => "friend-requests".into(),
            Self::GroupJoinRequests { thread_id } => format!("group-join-requests/{thread_id}"),
        }
    }
    pub(crate) fn from_key(value: &str) -> Option<Self> {
        let target = if value == "friend-requests" {
            Self::FriendRequests {}
        } else if let Some(id) = value.strip_prefix("thread/") {
            Self::Thread {
                thread_id: id.parse().ok()?,
            }
        } else if let Some(id) = value.strip_prefix("group-join-requests/") {
            Self::GroupJoinRequests {
                thread_id: id.parse().ok()?,
            }
        } else {
            return None;
        };
        (target.valid() && target.key() == value).then_some(target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wire_targets_and_card_keys_roundtrip_without_synthetic_threads() {
        for target in [
            NotificationTarget::Thread { thread_id: 7 },
            NotificationTarget::FriendRequests {},
            NotificationTarget::GroupJoinRequests { thread_id: 7 },
        ] {
            assert_eq!(NotificationTarget::from_key(&target.key()), Some(target));
            let json = serde_json::to_string(&target).unwrap();
            assert_eq!(
                serde_json::from_str::<NotificationTarget>(&json).unwrap(),
                target
            );
        }
        assert_eq!(
            serde_json::to_value(NotificationTarget::FriendRequests {}).unwrap(),
            serde_json::json!({"kind":"friend-requests"})
        );
        for key in [
            "thread/0",
            "thread/07",
            "group-join-requests/-1",
            "friend-requests/7",
        ] {
            assert_eq!(NotificationTarget::from_key(key), None);
        }
        assert!(serde_json::from_str::<NotificationTarget>(
            r#"{"kind":"friend-requests","threadId":7}"#
        )
        .is_err());
    }
}

/// Internal construction convenience for thread-message projections; the wire
/// format itself only ever carries an explicit target document.
impl From<i32> for NotificationTarget {
    fn from(thread_id: i32) -> Self {
        Self::Thread { thread_id }
    }
}
