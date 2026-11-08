//! Android executes the shared notification protocol synchronously; it owns no delivery queue.
use crate::native_db::notifications::{
    content::{NotificationCommand, PresentationFacts},
    delivery::{self, DeliveryResult, PlatformHandle, PreparedDelivery},
};
use jni::{
    objects::{GlobalRef, JObject, JValue},
    JNIEnv, JavaVM,
};
use std::sync::OnceLock;

struct Adapter {
    vm: JavaVM,
    class: GlobalRef,
}
static ADAPTER: OnceLock<Adapter> = OnceLock::new();

pub(crate) fn initialize(env: &mut JNIEnv) -> Result<(), String> {
    let class = env
        .find_class("com/soms/client/SomsMessagingService")
        .map_err(|e| e.to_string())?;
    let adapter = Adapter {
        vm: env.get_java_vm().map_err(|e| e.to_string())?,
        class: env.new_global_ref(class).map_err(|e| e.to_string())?,
    };
    ADAPTER
        .set(adapter)
        .map_err(|_| "notification adapter already initialized".into())
}

fn with_env<T>(
    operation: impl FnOnce(&mut JNIEnv, &jni::objects::JClass) -> Result<T, String>,
) -> Result<T, String> {
    let adapter = ADAPTER
        .get()
        .ok_or("notification adapter not initialized")?;
    let mut env = adapter
        .vm
        .attach_current_thread()
        .map_err(|e| e.to_string())?;
    env.push_local_frame(32).map_err(|e| e.to_string())?;
    let class: &jni::objects::JClass = adapter.class.as_obj().into();
    let result = operation(&mut env, class);
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_clear();
    }
    unsafe {
        let _ = env.pop_local_frame(&JObject::null());
    }
    result
}

pub(crate) fn current_cards() -> Result<Vec<delivery::ObservedCard>, String> {
    with_env(|env, class| {
        let response = env
            .call_static_method(
                class,
                "currentMessageNotifications",
                "()Ljava/lang/String;",
                &[],
            )
            .and_then(|value| value.l())
            .map_err(|_| "notification enumeration invocation failed".to_owned())?;
        let response = jni::objects::JString::from(response);
        let text: String = env.get_string(&response).map_err(|e| e.to_string())?.into();
        crate::android_notification_receipt::decode_cards(&text)
    })
}

/// Called before notification admission. Use the existing command/result adapter
/// to remove only surplus handles; never clear the selected card or navigation.
pub(crate) fn restore_cards() -> Result<Vec<delivery::ObservedCard>, String> {
    let (retained, duplicates) = delivery::select_restored_cards(current_cards()?);
    for card in duplicates {
        let prepared = PreparedDelivery {
            operation_id: uuid::Uuid::new_v4().to_string(),
            notification_id: Some(card.notification_id),
            command: NotificationCommand::Remove {
                thread_id: card.thread_id,
            },
            previous_handle: Some(card.handle),
        };
        match execute(prepared, vec![])? {
            DeliveryResult::Accepted { .. } => {}
            DeliveryResult::Rejected => {
                return Err("duplicate notification removal rejected".into())
            }
            DeliveryResult::NotExecuted => {
                return Err("duplicate notification removal not executed".into())
            }
            DeliveryResult::Uncertain => {
                return Err("duplicate notification removal uncertain".into())
            }
        }
    }
    Ok(retained)
}

fn facts() -> Result<PresentationFacts, String> {
    with_env(|env, class| {
        let visible = env
            .call_static_method(class, "notificationVisible", "()Z", &[])
            .and_then(|v| v.z())
            .map_err(|e| e.to_string())?;
        let focused = env
            .call_static_method(class, "notificationFocused", "()Z", &[])
            .and_then(|v| v.z())
            .map_err(|e| e.to_string())?;
        let thread = env
            .call_static_method(class, "notificationOpenThread", "()I", &[])
            .and_then(|v| v.i())
            .map_err(|e| e.to_string())?;
        Ok(PresentationFacts {
            visible,
            focused,
            open_thread: (thread > 0).then_some(thread),
        })
    })
}

fn execute(prepared: PreparedDelivery, avatars: Vec<Vec<u8>>) -> Result<DeliveryResult, String> {
    let mut invoked = false;
    let result = with_env(|env, class| {
        let (tag, platform_id) = match &prepared.previous_handle {
            Some(PlatformHandle::Android { tag, id }) => (Some(tag.clone()), *id),
            Some(_) => return Ok(DeliveryResult::NotExecuted),
            None => (prepared.notification_id.clone(), 0x10000),
        };
        if matches!(prepared.command, NotificationCommand::Show(_)) && tag.is_none() {
            return Ok(DeliveryResult::NotExecuted);
        }
        let mut command = serde_json::to_value(&prepared.command).map_err(|e| e.to_string())?;
        command["notification"]["notificationId"] = serde_json::json!(tag);
        let metadata = serde_json::json!({ "operationId": prepared.operation_id, "platformId": platform_id, "commands": [command] });
        let metadata = JObject::from(
            env.new_string(metadata.to_string())
                .map_err(|e| e.to_string())?,
        );
        let images = env
            .new_object_array(avatars.len() as i32, "[B", JObject::null())
            .map_err(|e| e.to_string())?;
        for (index, bytes) in avatars.iter().enumerate() {
            let bytes = env
                .byte_array_from_slice(bytes)
                .map_err(|e| e.to_string())?;
            env.set_object_array_element(&images, index as i32, &bytes)
                .map_err(|e| e.to_string())?;
            env.delete_local_ref(bytes).map_err(|e| e.to_string())?;
        }
        let images = JObject::from(images);
        // After entering Kotlin, an invocation error alone cannot prove whether
        // Binder submission occurred. Earlier JNI allocation failures can.
        invoked = true;
        let response = env
            .call_static_method(
                class,
                "executeNotification",
                "(Ljava/lang/String;[[B)Ljava/lang/String;",
                &[JValue::Object(&metadata), JValue::Object(&images)],
            )
            .and_then(|v| v.l())
            .map_err(|_| "notification adapter invocation failed".to_owned())?;
        let response = jni::objects::JString::from(response);
        let text: String = env.get_string(&response).map_err(|e| e.to_string())?.into();
        let expected_show = if matches!(prepared.command, NotificationCommand::Show(_)) {
            Some((
                tag.as_deref().ok_or("missing notification tag")?,
                platform_id,
            ))
        } else {
            None
        };
        Ok(crate::android_notification_receipt::decode(
            &text,
            &prepared.operation_id,
            expected_show,
        ))
    });
    match result {
        Ok(result) => Ok(result),
        Err(_) if !invoked => {
            log::warn!("notification JNI preparation failed before adapter invocation");
            Ok(DeliveryResult::NotExecuted)
        }
        Err(error) => Err(error),
    }
}

pub(crate) async fn deliver_command(
    work: crate::login_connection::DatabaseWork,
    command: NotificationCommand,
    avatars: Vec<Vec<u8>>,
    allow_alert: bool,
) -> Result<(), String> {
    crate::native_db::notifications::runtime::deliver_command(
        work,
        command,
        avatars,
        allow_alert,
        crate::native_db::notifications::runtime::Platform { facts, execute },
    )
    .await
}

pub(crate) async fn deliver_batch(
    batch: crate::native_db::notifications::NotificationBatch,
    allow_alert: bool,
) -> Result<(), String> {
    crate::native_db::notifications::runtime::deliver_batch(
        batch,
        allow_alert,
        crate::native_db::notifications::runtime::Platform { facts, execute },
    )
    .await
}

pub(crate) fn presentation_changed() {
    tauri::async_runtime::spawn(async {
        let result = async {
            let work = crate::native_db::capture_database_work()?;
            if let Some(thread_id) =
                crate::native_db::notifications::content::visible_thread(facts()?)
            {
                deliver_command(
                    work,
                    NotificationCommand::Remove { thread_id },
                    vec![],
                    false,
                )
                .await?;
            }
            Ok::<_, String>(())
        }
        .await;
        if result.is_err() {
            log::debug!("notification presentation observation not delivered");
        }
    });
}
