//! One native notification policy entry point, independent of the OS renderer.
#[cfg(test)]
use crate::native_db::notifications::NotificationTarget;
use crate::login_connection::DatabaseWork;
use super::{NotificationBatch, content::{NotificationCommand, PresentationFacts, command_with_facts, localized_copy}};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PresentationBatch {
    pub(crate) commands: Vec<NotificationCommand>,
    pub(crate) unread_total: i64,
    #[serde(skip)]
    pub(crate) avatars: Vec<Vec<u8>>,
}

pub(crate) fn package(
    mut commands: Vec<NotificationCommand>,
    unread_total: i64,
    source_avatars: &[Vec<u8>],
) -> Result<PresentationBatch, String> {
    let mut indices = std::collections::HashMap::new();
    let mut avatars = Vec::new();
    for command in &mut commands {
        if let NotificationCommand::Show(content) = command {
            for message in &mut content.messages {
                if let Some(index) = message.avatar_index {
                    let source = usize::try_from(index).map_err(|_| "invalid notification avatar index")?;
                    let bytes = source_avatars.get(source).ok_or("missing notification avatar")?;
                    let mapped = *indices.entry(index).or_insert_with(|| {
                        let mapped = avatars.len() as u64;
                        avatars.push(bytes.clone());
                        mapped
                    });
                    message.avatar_index = Some(mapped);
                }
            }
        }
    }
    Ok(PresentationBatch { commands, unread_total, avatars })
}

pub(crate) async fn prepare_batch(
    work: DatabaseWork,
    batch: &NotificationBatch,
    facts: PresentationFacts,
    allow_alert: bool,
) -> Result<PresentationBatch, String> {
    let (preferences, language) = super::super::spawn_owned_work(work.clone(), || {
        Ok((super::super::preferences::notification_preferences()?,
            super::super::preferences::notification_language()?))
    }).await.map_err(|e| format!("join notification preferences: {e}"))??;
    work.assert_current().map_err(|e| e.to_string())?;
    let copy = localized_copy(&language);
    let mut commands: Vec<_> = batch.threads.iter()
        .map(|thread| command_with_facts(thread, &preferences, facts, copy))
        .collect();
    let current = &batch.requests;
    let live: Vec<_> = work.owner().notification_delivery.lock().map_err(|_| "notification state poisoned")?
        .reconstruction_candidates().into_iter().map(|(target,_)| target).collect();
    let previous = work.owner().notification_requests.lock().map_err(|_| "request notification state poisoned")?.clone().unwrap_or_default();
    commands.extend(super::requests::selected(&current, &previous, &live, batch.reconstruction, &preferences, &language));
    let presentation = package(commands, batch.unread_total, &batch.avatars)?;
    let mut presentation = presentation;
    if !allow_alert {
        for command in &mut presentation.commands {
            if let NotificationCommand::Show(content) = command {
                content.silent = true;
            }
        }
    }
    Ok(presentation)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::content::{NotificationContent, NotificationMessage};

    fn show(indices: &[u64]) -> NotificationCommand {
        NotificationCommand::Show(NotificationContent {
            target: NotificationTarget::Thread { thread_id: 7 }, title: "Peer".into(), body: "Message".into(),
            count: 1, silent: false, has_unread_mention: false,
            messages: indices.iter().map(|index| NotificationMessage {
                seq: 1, sender_name: "Peer".into(), sender_key: None,
                timestamp_ms: None, avatar_index: Some(*index), text: "Message".into(),
            }).collect(),
        })
    }

    #[test]
    fn referenced_avatars_are_compacted_and_shared_across_commands() {
        let batch = package(vec![show(&[2, 2]), show(&[0])], 42,
            &[vec![10], vec![20], vec![30]]).unwrap();
        assert_eq!(batch.avatars, vec![vec![30], vec![10]]);
        assert_eq!(batch.unread_total, 42);
        let wire = serde_json::to_value(&batch).unwrap();
        assert!(wire.get("avatars").is_none());
        assert_eq!(wire["unreadTotal"], 42);
        assert_eq!(wire["commands"][0]["notification"]["messages"][0]["avatarIndex"], 0);
        assert_eq!(wire["commands"][0]["notification"]["messages"][1]["avatarIndex"], 0);
        assert_eq!(wire["commands"][1]["notification"]["messages"][0]["avatarIndex"], 1);
    }

    #[test]
    fn removal_and_private_content_do_not_forward_unused_avatars() {
        let batch = package(vec![NotificationCommand::Remove { target: NotificationTarget::Thread { thread_id: 7 } }, show(&[])],
            8, &[vec![1, 2, 3]]).unwrap();
        assert!(batch.avatars.is_empty());
        assert_eq!(batch.unread_total, 8);
    }

    #[test]
    fn missing_avatar_reference_fails_instead_of_binding_another_image() {
        assert!(package(vec![show(&[1])], 1, &[vec![10]]).is_err());
        assert!(package(vec![show(&[u64::MAX])], 1, &[]).is_err());
    }
}
