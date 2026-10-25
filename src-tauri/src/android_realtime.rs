//! JNI is an OS callback adapter only; transport and projection live in the shared Rust core.
use crate::realtime::{Output, Sink, Supervisor};
use jni::{
    objects::{GlobalRef, JObject, JValue},
    sys::{jboolean, jlong, jstring},
    JNIEnv, JavaVM,
};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
fn runtime() -> &'static Supervisor {
    crate::realtime::runtime()
}
pub(crate) fn current_run() -> Option<Arc<crate::realtime::Run>> {
    runtime().current()
}
struct Callbacks {
    vm: Arc<JavaVM>,
    object: GlobalRef,
    lease: AtomicU64,
}
impl Sink for Callbacks {
    fn fork(&self) -> Arc<dyn Sink> {
        Arc::new(Self {
            vm: self.vm.clone(),
            object: self.object.clone(),
            lease: AtomicU64::new(0),
        })
    }
    fn bind_lease(&self, lease: u64) {
        self.lease.store(lease, Ordering::Release);
    }
    fn publish(&self, output: Output) {
        let lease = self.lease.load(Ordering::Acquire);
        let Some(run) = runtime()
            .current()
            .filter(|r| r.lease == lease && r.active())
        else {
            return;
        };
        let Ok(mut env) = self.vm.attach_current_thread() else {
            return;
        };
        // Revalidate after attaching: attachment and queued projection can cross stop/logout.
        if !run.active() || (!matches!(&output, Output::State(_)) && !run.authenticated()) {
            return;
        }
        let _ = env.with_local_frame(32, |env| -> jni::errors::Result<()> {
            let callback = self.object.as_obj();
            match output {
                Output::Event(envelope) => {
                    let envelope = JObject::from(env.new_string(envelope.to_string())?);
                    env.call_method(
                        callback,
                        "onEvent",
                        "(JLjava/lang/String;)V",
                        &[JValue::Long(lease as i64), JValue::Object(&envelope)],
                    )?;
                }
                Output::State(state) => {
                    let state = JObject::from(env.new_string(state)?);
                    env.call_method(
                        callback,
                        "onState",
                        "(JLjava/lang/String;)V",
                        &[JValue::Long(lease as i64), JValue::Object(&state)],
                    )?;
                }
                Output::ReconnectIn(ms) => {
                    env.call_method(
                        callback,
                        "onReconnectIn",
                        "(JJ)V",
                        &[JValue::Long(lease as i64), JValue::Long(ms as i64)],
                    )?;
                }
                Output::ForceLogout(reason) => {
                    let Some(envelope) = run.event_payload(
                        "FORCE_LOGOUT",
                        reason.as_deref().unwrap_or(""),
                        serde_json::Value::Null,
                    ) else {
                        return Ok(());
                    };
                    let envelope = JObject::from(env.new_string(envelope.to_string())?);
                    env.call_method(
                        callback,
                        "onForceLogout",
                        "(JLjava/lang/String;)V",
                        &[JValue::Long(lease as i64), JValue::Object(&envelope)],
                    )?;
                }
                Output::Origin(origin, mode) => {
                    let origin = JObject::from(env.new_string(origin)?);
                    let mode = JObject::from(env.new_string(mode)?);
                    env.call_method(
                        callback,
                        "onOriginActive",
                        "(JLjava/lang/String;Ljava/lang/String;)V",
                        &[
                            JValue::Long(lease as i64),
                            JValue::Object(&origin),
                            JValue::Object(&mode),
                        ],
                    )?;
                }
                Output::Identity(user, session) => {
                    env.call_method(
                        callback,
                        "onIdentity",
                        "(JIJ)V",
                        &[
                            JValue::Long(lease as i64),
                            JValue::Int(user),
                            JValue::Long(session),
                        ],
                    )?;
                }
                Output::Notifications(batch) => {
                    let login_current = crate::login_session_store::LoginSessionId::try_from(
                        batch.login_session_id.clone(),
                    )
                    .map(|id| crate::native_db::is_login_session_current(&id))
                    .unwrap_or(false);
                    if !login_current {
                        return Ok(());
                    }
                    if let Ok(batch) = crate::android_runtime::notification_object(env, &batch) {
                        env.call_method(
                            callback,
                            "onNotifications",
                            "(JLcom/soms/client/NativeNotificationBatch;)V",
                            &[JValue::Long(lease as i64), JValue::Object(&batch)],
                        )?;
                    }
                }
                Output::IncomingCall(mut data) => {
                    let Some(envelope) = run.event_payload("CALL_RECOVERY", "", serde_json::Value::Null) else { return Ok(()); };
                    data["loginSessionId"] = envelope["loginSessionId"].clone();
                    let data = JObject::from(env.new_string(data.to_string())?);
                    env.call_method(
                        callback,
                        "onIncomingCall",
                        "(JLjava/lang/String;)V",
                        &[JValue::Long(lease as i64), JValue::Object(&data)],
                    )?;
                }
                Output::Reconnect => {
                    let Some(envelope) =
                        run.event_payload("RECONNECT", "reconnected", serde_json::Value::Null)
                    else {
                        return Ok(());
                    };
                    let envelope = JObject::from(env.new_string(envelope.to_string())?);
                    env.call_method(
                        callback,
                        "onEvent",
                        "(JLjava/lang/String;)V",
                        &[JValue::Long(lease as i64), JValue::Object(&envelope)],
                    )?;
                }
            }
            Ok(())
        });
        // A Java callback must never poison an attached Rust worker thread. No exception text
        // is logged: event payloads and credentials can appear in platform exception messages.
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustRuntimeBridge_realtimeStart(
    mut env: JNIEnv,
    _: JObject,
    callbacks: JObject,
) -> jlong {
    let result = (|| -> Result<i64, String> {
        let proxy = crate::android_runtime::proxy_state()?.clone();
        // Each service instance owns its own callback object and nonzero lease.
        let sink = Arc::new(Callbacks {
            vm: Arc::new(env.get_java_vm().map_err(|e| e.to_string())?),
            object: env.new_global_ref(callbacks).map_err(|e| e.to_string())?,
            lease: AtomicU64::new(0),
        });
        let lease = runtime().replace(proxy, sink);
        Ok(lease as i64)
    })();
    match result {
        Ok(lease) => lease,
        Err(error) => {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
            0
        }
    }
}
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustRuntimeBridge_realtimeIsCurrent(
    _: JNIEnv,
    _: JObject,
    generation: jlong,
) -> jboolean {
    runtime().is_current_generation(generation as u64) as jboolean
}
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustRuntimeBridge_realtimeStop(
    _: JNIEnv,
    _: JObject,
    lease: jlong,
) {
    runtime().stop(lease as u64);
}
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustRuntimeBridge_realtimeNet(
    _: JNIEnv,
    _: JObject,
    lease: jlong,
    online: jboolean,
) {
    runtime().net(lease as u64, online != 0, false);
}
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustRuntimeBridge_realtimeRetryNow(
    _: JNIEnv,
    _: JObject,
    lease: jlong,
) -> jlong {
    runtime().retry(lease as u64, false) as jlong
}
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustRuntimeBridge_realtimeForceReconnect(
    _: JNIEnv,
    _: JObject,
    lease: jlong,
) -> jlong {
    runtime().retry(lease as u64, true) as jlong
}
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustRuntimeBridge_realtimeGetState(
    env: JNIEnv,
    _: JObject,
) -> jstring {
    env.new_string(runtime().state())
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustRuntimeBridge_realtimeReplayHello(
    env: JNIEnv,
    _: JObject,
) -> jstring {
    runtime()
        .current()
        .and_then(|r| r.replay_snapshot())
        .and_then(|v| env.new_string(v.to_string()).ok())
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustRuntimeBridge_realtimePickOrigin(
    env: JNIEnv,
    _: JObject,
) -> jstring {
    let value = crate::android_runtime::proxy_state()
        .ok()
        .and_then(|proxy| tauri::async_runtime::block_on(crate::pick_origin_race(proxy)));
    value
        .and_then(|v| env.new_string(v).ok())
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}
