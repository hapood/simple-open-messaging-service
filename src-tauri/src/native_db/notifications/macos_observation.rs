//! Decode OS facts without inventing a receipt, content or notification identity.
use super::delivery::{ObservedCard, PlatformHandle};

pub(crate) fn decode(json: &str) -> Result<Vec<ObservedCard>, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Card {
        thread_id: i32,
        identifier: String,
    }
    serde_json::from_str::<Vec<Card>>(json)
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|card| {
            let instance = card
                .identifier
                .strip_prefix("soms-thread-")
                .ok_or("invalid macOS notification identifier")?;
            let parsed = uuid::Uuid::parse_str(instance).map_err(|error| error.to_string())?;
            if card.thread_id <= 0 || parsed.to_string() != instance {
                return Err("invalid macOS notification coordinates".into());
            }
            Ok(ObservedCard {
                thread_id: card.thread_id,
                notification_id: instance.to_owned(),
                handle: PlatformHandle::Macos {
                    identifier: card.identifier,
                },
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_exact_os_handle_and_leaves_duplicate_selection_to_shared_policy() {
        let id = uuid::Uuid::new_v4().to_string();
        let identifier = format!("soms-thread-{id}");
        let json = serde_json::json!([
            {"threadId": 7, "identifier": identifier},
            {"threadId": 7, "identifier": identifier},
        ])
        .to_string();
        let cards = decode(&json).unwrap();
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0].notification_id, id);
        assert_eq!(cards[0].handle, PlatformHandle::Macos { identifier });
    }

    #[test]
    fn malformed_observation_is_not_an_empty_success() {
        for json in [
            "null",
            "{}",
            r#"[{"threadId":7,"identifier":"soms-thread-not-a-uuid"}]"#,
            r#"[{"threadId":0,"identifier":"soms-thread-00000000-0000-0000-0000-000000000001"}]"#,
        ] {
            assert!(decode(json).is_err());
        }
        assert!(decode("[]").unwrap().is_empty());
    }
}
