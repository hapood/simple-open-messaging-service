use jni::objects::{JObject, JString};
use jni::sys::jstring;
use jni::JNIEnv;
use std::sync::OnceLock;

#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustRuntimeBridge_queryNotifications(
    mut env: JNIEnv,
    _receiver: JObject,
    user_id: jni::sys::jint,
    target: jni::sys::jint,
) -> jni::sys::jobject {
    let result =
        (|| -> Result<jni::sys::jobject, String> {
            let proxy = proxy_state()?;
            let token = proxy
                .token
                .lock()
                .map_err(|_| "token lock poisoned")?
                .clone()
                .ok_or("notification session is not authenticated")?;
            let batch = tauri::async_runtime::block_on(
                crate::native_db::notifications::synchronize(proxy, i64::from(user_id), target),
            )?;
            if proxy
                .token
                .lock()
                .map_err(|_| "token lock poisoned")?
                .as_ref()
                != Some(&token)
            {
                return Err("notification session expired".into());
            }
            notification_object(&mut env, &batch).map(|object| object.into_raw())
        })();
    match result {
        Ok(result) => result,
        Err(error) => {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
            std::ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustRuntimeBridge_syncStateFeed(
    mut env: JNIEnv,
    _receiver: JObject,
    user_id: jni::sys::jint,
    target: jni::sys::jlong,
) -> jstring {
    let result = (|| -> Result<String, String> {
        let proxy = proxy_state()?;
        let token = proxy
            .token
            .lock()
            .map_err(|_| "token lock poisoned")?
            .clone()
            .ok_or("state-feed session is not authenticated")?;
        let epoch = crate::native_db::capture_account_epoch()?;
        let cursor = tauri::async_runtime::block_on(
            crate::native_db::state_feed_sync::synchronize(proxy, i64::from(user_id), target),
        )?;
        if !crate::native_db::is_account_epoch_current(epoch)
            || proxy
                .token
                .lock()
                .map_err(|_| "token lock poisoned")?
                .as_ref()
                != Some(&token)
        {
            return Err("state-feed session expired".into());
        }
        Ok(
            serde_json::json!({ "userId": user_id, "cursor": cursor, "accountEpoch": epoch })
                .to_string(),
        )
    })();
    match result {
        Ok(value) => env
            .new_string(value)
            .map(|value| value.into_raw())
            .unwrap_or_else(|_| std::ptr::null_mut()),
        Err(error) => {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
            std::ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustRuntimeBridge_getNotificationPreference(
    mut env: JNIEnv,
    _receiver: JObject,
    key: JString,
) -> jstring {
    let result = (|| -> Result<Option<String>, String> {
        let key: String = env.get_string(&key).map_err(|e| e.to_string())?.into();
        crate::native_db::preferences::read_notification_preference(&key)
    })();
    match result {
        Ok(Some(value)) => env
            .new_string(value)
            .map(|value| value.into_raw())
            .unwrap_or_else(|_| std::ptr::null_mut()),
        Ok(None) => std::ptr::null_mut(),
        Err(error) => {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
            std::ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustRuntimeBridge_setNotificationPreference(
    mut env: JNIEnv,
    _receiver: JObject,
    key: JString,
    value: JString,
) {
    let result = (|| -> Result<(), String> {
        let key: String = env.get_string(&key).map_err(|e| e.to_string())?.into();
        let value: String = env.get_string(&value).map_err(|e| e.to_string())?.into();
        crate::native_db::preferences::write_notification_preference(&key, &value)
    })();
    if let Err(error) = result {
        let _ = env.throw_new("java/lang/IllegalStateException", error);
    }
}

#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustRuntimeBridge_queryCallPeer(
    mut env: JNIEnv,
    _receiver: JObject,
    user_id: jni::sys::jint,
    thread_id: jni::sys::jint,
    account: JString,
    namespace_id: jni::sys::jint,
) -> jstring {
    let result = (|| -> Result<Option<String>, String> {
        let account: String = env.get_string(&account).map_err(|e| e.to_string())?.into();
        crate::native_db::call_peer::read_call_peer(
            i64::from(user_id),
            i64::from(thread_id),
            &account,
            i64::from(namespace_id),
        )?
        .map(|value| serde_json::to_string(&value).map_err(|e| e.to_string()))
        .transpose()
    })();
    match result {
        Ok(Some(value)) => env
            .new_string(value)
            .map(|value| value.into_raw())
            .unwrap_or_else(|_| std::ptr::null_mut()),
        Ok(None) => std::ptr::null_mut(),
        Err(error) => {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
            std::ptr::null_mut()
        }
    }
}

pub(crate) fn notification_object<'local>(
    env: &mut JNIEnv<'local>,
    batch: &crate::native_db::notifications::NotificationBatch,
) -> Result<JObject<'local>, String> {
    let metadata = JObject::from(env.new_string(&batch.metadata).map_err(|e| e.to_string())?);
    let images = env
        .new_object_array(batch.avatars.len() as i32, "[B", JObject::null())
        .map_err(|e| e.to_string())?;
    for (index, bytes) in batch.avatars.iter().enumerate() {
        let image = env
            .byte_array_from_slice(bytes)
            .map_err(|e| e.to_string())?;
        env.set_object_array_element(&images, index as i32, &image)
            .map_err(|e| e.to_string())?;
        env.delete_local_ref(image).map_err(|e| e.to_string())?;
    }
    let images = JObject::from(images);
    env.new_object(
        "com/soms/client/NativeNotificationBatch",
        "(Ljava/lang/String;[[BJ)V",
        &[
            jni::objects::JValue::Object(&metadata),
            jni::objects::JValue::Object(&images),
            jni::objects::JValue::Long(batch.account_epoch as i64),
        ],
    )
    .map_err(|e| e.to_string())
}

static PROXY: OnceLock<crate::ServerSessionState> = OnceLock::new();

#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustRuntimeBridge_isAccountEpochCurrent(
    _env: JNIEnv,
    _receiver: JObject,
    epoch: jni::sys::jlong,
) -> jni::sys::jboolean {
    u8::from(epoch >= 0 && crate::native_db::is_account_epoch_current(epoch as u64))
}

pub(crate) fn proxy_state() -> Result<&'static crate::ServerSessionState, String> {
    PROXY
        .get()
        .ok_or_else(|| "Android Rust runtime is not initialized".into())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeOrigins {
    primary: Option<String>,
    secondary: Option<String>,
    mode: String,
}

fn apply_origins(state: &crate::ServerSessionState, origins: RuntimeOrigins) -> Result<(), String> {
    let normalize = |value: Option<String>| -> Result<Option<String>, String> {
        value
            .map(|raw| crate::validate_origin(&raw).ok_or_else(|| "invalid runtime origin".into()))
            .transpose()
    };
    let primary = normalize(origins.primary)?.unwrap_or_else(|| crate::DEFAULT_API_ORIGIN.into());
    let secondary = normalize(origins.secondary)?;
    let (active, mode) = if origins.mode == "secondary" {
        match secondary.as_ref() {
            Some(value) => (value.clone(), crate::OriginMode::Secondary),
            None => (primary.clone(), crate::OriginMode::Primary),
        }
    } else {
        (primary.clone(), crate::OriginMode::Primary)
    };
    *state
        .api_origin_primary
        .lock()
        .map_err(|_| "primary lock poisoned")? = primary;
    *state
        .api_origin_secondary
        .lock()
        .map_err(|_| "secondary lock poisoned")? = secondary;
    crate::activate_origin(state, &active, mode);
    Ok(())
}

/// Loading the library and admitting database access do not create a Tauri app or WebView.
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustRuntimeBridge_initializeRuntime(
    mut env: JNIEnv,
    _receiver: JObject,
    data_directory: JString,
    origins_json: JString,
    token: JString,
) -> jstring {
    let result = (|| -> Result<jstring, String> {
        let directory: String = env
            .get_string(&data_directory)
            .map_err(|e| format!("read database directory: {e}"))?
            .into();
        let path = crate::native_db::location::initialize(std::path::Path::new(&directory))?;
        crate::native_db::initialize_preferences()?;
        let origins: String = env
            .get_string(&origins_json)
            .map_err(|e| e.to_string())?
            .into();
        let origins: RuntimeOrigins =
            serde_json::from_str(&origins).map_err(|_| "invalid runtime origins")?;
        let token = if token.is_null() {
            None
        } else {
            let value: String = env.get_string(&token).map_err(|e| e.to_string())?.into();
            Some(value).filter(|value| !value.is_empty())
        };
        let state = crate::ServerSessionState::new();
        // Eagerly start the same async runtime Tauri uses later; this performs no network I/O.
        let _ = tauri::async_runtime::handle();
        apply_origins(&state, origins)?;
        *state.token.lock().map_err(|_| "token lock poisoned")? = token;
        *state
            .config_path
            .lock()
            .map_err(|_| "config path lock poisoned")? = path
            .parent()
            .ok_or("missing database parent")?
            .join(crate::CONFIG_FILENAME);
        PROXY
            .set(state)
            .map_err(|_| "Android Rust runtime already initialized")?;
        env.new_string(path.to_str().ok_or("invalid database path encoding")?)
            .map(|value| value.into_raw())
            .map_err(|e| format!("return database path: {e}"))
    })();
    match result {
        Ok(path) => path,
        Err(error) => {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
            std::ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustRuntimeBridge_updateSessionToken(
    mut env: JNIEnv,
    _receiver: JObject,
    token: JString,
) {
    let result = (|| -> Result<(), String> {
        let token = if token.is_null() {
            None
        } else {
            let value: String = env.get_string(&token).map_err(|e| e.to_string())?.into();
            Some(value).filter(|value| !value.is_empty())
        };
        let state = proxy_state()?;
        state.replace_session_token(token);
        Ok(())
    })();
    if let Err(error) = result {
        let _ = env.throw_new("java/lang/IllegalStateException", error);
    }
}

#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustRuntimeBridge_setOrigins(
    mut env: JNIEnv,
    _receiver: JObject,
    origins_json: JString,
) {
    let result = (|| -> Result<(), String> {
        let json: String = env
            .get_string(&origins_json)
            .map_err(|e| e.to_string())?
            .into();
        let origins = serde_json::from_str(&json).map_err(|_| "invalid runtime origins")?;
        apply_origins(proxy_state()?, origins)
    })();
    if let Err(error) = result {
        let _ = env.throw_new("java/lang/IllegalStateException", error);
    }
}
