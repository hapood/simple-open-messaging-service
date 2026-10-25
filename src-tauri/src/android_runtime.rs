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
    let result = (|| -> Result<jni::sys::jobject, String> {
        let proxy = proxy_state()?;
        let batch = tauri::async_runtime::block_on(crate::native_db::notifications::synchronize(
            proxy,
            i64::from(user_id),
            target,
        ))?;
        let login_id =
            crate::login_session_store::LoginSessionId::try_from(batch.login_session_id.clone())
                .map_err(|e| e.to_string())?;
        if !crate::native_db::is_login_session_current(&login_id) {
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
        let cursor = tauri::async_runtime::block_on(
            crate::native_db::state_feed_sync::synchronize(proxy, i64::from(user_id), target),
        )?;
        Ok(serde_json::json!({ "userId": user_id, "cursor": cursor }).to_string())
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
    let login_id = JObject::from(
        env.new_string(&batch.login_session_id)
            .map_err(|e| e.to_string())?,
    );
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
        "(Ljava/lang/String;[[BLjava/lang/String;)V",
        &[
            jni::objects::JValue::Object(&metadata),
            jni::objects::JValue::Object(&images),
            jni::objects::JValue::Object(&login_id),
        ],
    )
    .map_err(|e| e.to_string())
}

static PROXY: OnceLock<crate::ServerSessionState> = OnceLock::new();

#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustRuntimeBridge_isLoginSessionCurrent(
    mut env: JNIEnv,
    _receiver: JObject,
    session: JString,
) -> jni::sys::jboolean {
    let current = (|| -> Result<bool, String> {
        let session: String = env.get_string(&session).map_err(|e| e.to_string())?.into();
        let id = crate::login_session_store::LoginSessionId::try_from(session)
            .map_err(|e| e.to_string())?;
        Ok(crate::native_db::is_login_session_current(&id))
    })();
    u8::from(current.unwrap_or(false))
}

pub(crate) fn proxy_state() -> Result<&'static crate::ServerSessionState, String> {
    PROXY
        .get()
        .ok_or_else(|| "Android Rust runtime is not initialized".into())
}

/// Loading the library and admitting database access do not create a Tauri app or WebView.
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustRuntimeBridge_initializeRuntime(
    mut env: JNIEnv,
    _receiver: JObject,
    data_directory: JString,
    token: JString,
) -> jstring {
    let result = (|| -> Result<jstring, String> {
        let directory: String = env
            .get_string(&data_directory)
            .map_err(|e| format!("read database directory: {e}"))?
            .into();
        let path = crate::native_db::location::initialize(std::path::Path::new(&directory))?;
        crate::native_db::initialize_preferences()?;
        if let Err(error) = crate::native_db::initialize_login_cache() {
            log::warn!("login cache initialization requires repair: {error}");
        }
        let token = if token.is_null() {
            None
        } else {
            let value: String = env.get_string(&token).map_err(|e| e.to_string())?.into();
            Some(value).filter(|value| !value.is_empty())
        };
        let state = crate::ServerSessionState::new();
        // Eagerly start the same async runtime Tauri uses later; this performs no network I/O.
        let _ = tauri::async_runtime::handle();
        if let Some(token) = token {
            if let Some(id) = crate::native_db::restore_login_credential(&token)? {
                *state
                    .login_session
                    .lock()
                    .map_err(|_| "login session lock poisoned")? =
                    Some(crate::login_session_store::LoginSessionId::try_from(id)?);
                *state.token.lock().map_err(|_| "token lock poisoned")? = Some(token);
            }
        }
        *state
            .config_path
            .lock()
            .map_err(|_| "config path lock poisoned")? = path
            .parent()
            .ok_or("missing database parent")?
            .join(crate::CONFIG_FILENAME);
        crate::server_setup::restore(&state)?;
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
    session_uuid: JString,
) {
    let result = (|| -> Result<(), String> {
        let token = if token.is_null() {
            None
        } else {
            let value: String = env.get_string(&token).map_err(|e| e.to_string())?.into();
            Some(value).filter(|value| !value.is_empty())
        };
        if session_uuid.is_null() {
            return Err("session UUID is required".into());
        }
        let session_uuid: String = env
            .get_string(&session_uuid)
            .map_err(|e| e.to_string())?
            .into();
        if session_uuid.is_empty() {
            return Err("session UUID must not be empty".into());
        }
        let state = proxy_state()?;
        state.update_session_token_admitted(token, &session_uuid)
    })();
    if let Err(error) = result {
        let _ = env.throw_new("java/lang/IllegalStateException", error);
    }
}

#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustRuntimeBridge_clearResidualToken(
    mut env: JNIEnv,
    _receiver: JObject,
) {
    let result = (|| -> Result<(), String> {
        let state = proxy_state()?;
        state.clear_residual_token()
    })();
    if let Err(error) = result {
        let _ = env.throw_new("java/lang/IllegalStateException", error);
    }
}

#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustRuntimeBridge_getServerOrigins(
    mut env: JNIEnv,
    _receiver: JObject,
) -> jstring {
    let result = (|| -> Result<String, String> {
        let state = proxy_state()?;
        let primary = state
            .api_origin_primary
            .lock()
            .map_err(|_| "primary lock poisoned")?
            .clone();
        let secondary = state
            .api_origin_secondary
            .lock()
            .map_err(|_| "secondary lock poisoned")?
            .clone();
        let mode = match *state.origin_mode.lock().map_err(|_| "mode lock poisoned")? {
            crate::OriginMode::Primary => "primary",
            crate::OriginMode::Secondary => "secondary",
        };
        Ok(
            serde_json::json!({ "primary": primary, "secondary": secondary, "mode": mode,
            "configured": primary != crate::DEFAULT_API_ORIGIN })
            .to_string(),
        )
    })();
    match result {
        Ok(value) => env
            .new_string(value)
            .map(|value| value.into_raw())
            .unwrap_or(std::ptr::null_mut()),
        Err(error) => {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
            std::ptr::null_mut()
        }
    }
}
