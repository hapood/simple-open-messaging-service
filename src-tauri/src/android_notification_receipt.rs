//! Decode Android execution receipts; platform identity must match the submitted command.
use crate::native_db::notifications::delivery::{DeliveryResult, PlatformHandle};

pub(crate) fn decode(
    text: &str,
    operation_id: &str,
    expected_show: Option<(&str, i32)>,
) -> DeliveryResult {
    let Ok(result) = serde_json::from_str::<serde_json::Value>(text) else {
        return DeliveryResult::Uncertain;
    };
    if result["operationId"].as_str() != Some(operation_id) {
        return DeliveryResult::Uncertain;
    }
    match result["status"].as_str() {
        Some("accepted") => {
            let handle = if let Some((tag, id)) = expected_show {
                if result["tag"].as_str() != Some(tag)
                    || result["id"].as_i64() != Some(i64::from(id))
                {
                    return DeliveryResult::Uncertain;
                }
                Some(PlatformHandle::Android {
                    tag: tag.into(),
                    id,
                })
            } else {
                None
            };
            DeliveryResult::Accepted { handle }
        }
        Some("rejected") => DeliveryResult::Rejected,
        Some("notExecuted") => DeliveryResult::NotExecuted,
        _ => DeliveryResult::Uncertain,
    }
}

use crate::native_db::notifications::delivery::ObservedCard;

/// Decode an OS observation without mutating delivery state. Keep every instance
/// (including multiple cards for one thread) so reconciliation can address each.
pub(crate) fn decode_cards(text: &str) -> Result<Vec<ObservedCard>, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Card {
        target: crate::native_db::notifications::NotificationTarget,
        tag: String,
        id: i32,
    }
    let cards: Vec<Card> =
        serde_json::from_str(text).map_err(|e| format!("notification enumeration: {e}"))?;
    let mut handles = std::collections::HashSet::new();
    cards
        .into_iter()
        .map(|card| {
            let target = card
                .target
                .valid()
                .then_some(card.target)
                .ok_or("invalid notification target")?;
            let instance =
                uuid::Uuid::parse_str(&card.tag).map_err(|_| "invalid notification instance")?;
            if instance.to_string() != card.tag {
                return Err("invalid notification observation".into());
            }
            if !handles.insert((card.tag.clone(), card.id)) {
                return Err("duplicate notification handle".into());
            }
            Ok(ObservedCard {
                target,
                notification_id: card.tag.clone(),
                handle: PlatformHandle::Android {
                    tag: card.tag,
                    id: card.id,
                },
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enumeration_preserves_real_handles_and_multiple_instances_for_one_thread() {
        let first = "550e8400-e29b-41d4-a716-446655440000";
        let second = "550e8400-e29b-41d4-a716-446655440001";
        let cards = decode_cards(&format!(r#"[{{"target":{{"kind":"thread","threadId":7}},"tag":"{first}","id":65536}},{{"target":{{"kind":"thread","threadId":7}},"tag":"{second}","id":9}}]"#)).unwrap();
        assert_eq!(cards.len(), 2);
        assert_eq!(
            cards[0].target,
            crate::native_db::notifications::NotificationTarget::Thread { thread_id: 7 }
        );
        assert_eq!(cards[0].notification_id, first);
        assert_eq!(
            cards[1].handle,
            PlatformHandle::Android {
                tag: second.into(),
                id: 9
            }
        );
        assert!(decode_cards("[]").unwrap().is_empty());
    }

    #[test]
    fn invalid_enumeration_is_not_an_empty_success() {
        for text in [
            "",
            "null",
            "{}",
            r#"[{"threadId":7,"tag":null,"id":1}]"#,
            r#"[{"target":null,"tag":"550e8400-e29b-41d4-a716-446655440000","id":1}]"#,
            r#"[{"target":{"kind":"thread","threadId":0},"tag":"550e8400-e29b-41d4-a716-446655440000","id":1}]"#,
            r#"[{"target":{"kind":"thread","threadId":7},"tag":"bad","id":1}]"#,
            r#"[{"target":{"kind":"thread","threadId":7},"tag":"550e8400-e29b-41d4-a716-446655440000","id":4294967296}]"#,
        ] {
            assert!(decode_cards(text).is_err(), "{text}");
        }
        let entry = r#"{"target":{"kind":"thread","threadId":7},"tag":"550e8400-e29b-41d4-a716-446655440000","id":1}"#;
        assert!(decode_cards(&format!("[{entry},{entry}]")).is_err());
    }

    #[test]
    fn accepted_show_requires_the_exact_operation_and_platform_handle() {
        let receipt = r#"{"operationId":"op","status":"accepted","tag":"card","id":65536}"#;
        assert!(matches!(
            decode(receipt, "op", Some(("card", 65536))),
            DeliveryResult::Accepted {
                handle: Some(PlatformHandle::Android { id: 65536, .. })
            }
        ));
        for (operation, tag, id) in [
            ("other", "card", 65536),
            ("op", "other", 65536),
            ("op", "card", 1),
        ] {
            assert!(matches!(
                decode(receipt, operation, Some((tag, id))),
                DeliveryResult::Uncertain
            ));
        }
    }

    #[test]
    fn malformed_or_incomplete_receipts_cannot_claim_nonexecution() {
        for text in [
            "",
            "null",
            r#"{"operationId":"op","status":"accepted"}"#,
            r#"{"operationId":"op","status":"accepted","tag":"card","id":4294967296}"#,
            r#"{"operationId":"other","status":"notExecuted"}"#,
        ] {
            assert!(matches!(
                decode(text, "op", Some(("card", 65536))),
                DeliveryResult::Uncertain
            ));
        }
    }

    #[test]
    fn removal_and_definite_failure_receipts_need_no_show_handle() {
        assert!(matches!(
            decode(r#"{"operationId":"op","status":"accepted"}"#, "op", None),
            DeliveryResult::Accepted { handle: None }
        ));
        assert!(matches!(
            decode(r#"{"operationId":"op","status":"rejected"}"#, "op", None),
            DeliveryResult::Rejected
        ));
        assert!(matches!(
            decode(r#"{"operationId":"op","status":"notExecuted"}"#, "op", None),
            DeliveryResult::NotExecuted
        ));
    }
}
