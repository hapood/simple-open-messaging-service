use super::runtime::{Runtime, Sink};
use jni::{
    objects::{GlobalRef, JObject, JString, JValue},
    sys::{jboolean, jlong, jstring},
    JNIEnv, JavaVM,
};
use serde_json::Value;
use std::sync::{Arc, OnceLock};

static RUNTIME: OnceLock<Runtime> = OnceLock::new();
fn runtime() -> Result<&'static Runtime, String> {
    if let Some(runtime) = RUNTIME.get() {
        return Ok(runtime);
    }
    let proxy = crate::android_runtime::proxy_state()?.clone();
    Ok(RUNTIME.get_or_init(|| Runtime::new(proxy)))
}
struct Callbacks {
    vm: JavaVM,
    object: GlobalRef,
}
impl Sink for Callbacks {
    fn command(&self, command: Value) {
        let Ok(mut env) = self.vm.attach_current_thread() else {
            return;
        };
        let _ = env.with_local_frame(8, |env| -> jni::errors::Result<()> {
            let command = JObject::from(env.new_string(command.to_string())?);
            env.call_method(
                self.object.as_obj(),
                "onCommand",
                "(Ljava/lang/String;)V",
                &[JValue::Object(&command)],
            )?;
            Ok(())
        });
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
    }
}
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustCallBridge_bind(
    mut env: JNIEnv,
    _: JObject,
    callback: JObject,
) {
    let result = (|| -> Result<(), String> {
        let callback = Callbacks {
            vm: env.get_java_vm().map_err(|error| error.to_string())?,
            object: env
                .new_global_ref(callback)
                .map_err(|error| error.to_string())?,
        };
        runtime()?.bind(Arc::new(callback));
        Ok(())
    })();
    if let Err(error) = result {
        let _ = env.throw_new("java/lang/IllegalStateException", error);
    }
}
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustCallBridge_command(
    mut env: JNIEnv,
    _: JObject,
    lease: jlong,
    command: JString,
) -> jstring {
    let result = (|| -> Result<String, String> {
        let command: String = env
            .get_string(&command)
            .map_err(|error| error.to_string())?
            .into();
        let command: Value = serde_json::from_str(&command).map_err(|error| error.to_string())?;
        tauri::async_runtime::block_on(runtime()?.command(lease as u64, command))
            .map(|result| result.to_string())
    })();
    match result {
        Ok(result) => env
            .new_string(result)
            .map(|result| result.into_raw())
            .unwrap_or(std::ptr::null_mut()),
        Err(error) => {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
            std::ptr::null_mut()
        }
    }
}
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustCallBridge_isCurrent(
    _: JNIEnv,
    _: JObject,
    lease: jlong,
) -> jboolean {
    u8::from(runtime().is_ok_and(|runtime| runtime.is_current(lease as u64)))
}
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustCallBridge_detach(
    _: JNIEnv,
    _: JObject,
    lease: jlong,
) {
    if let Ok(runtime) = runtime() {
        runtime.detach(lease as u64);
    }
}

#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustCallBridge_isLive(
    _: JNIEnv,
    _: JObject,
    lease: jlong,
) -> jboolean {
    u8::from(runtime().is_ok_and(|runtime| runtime.is_live(lease as u64)))
}
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustCallBridge_canRing(
    _: JNIEnv,
    _: JObject,
    lease: jlong,
) -> jboolean {
    u8::from(runtime().is_ok_and(|runtime| runtime.can_ring(lease as u64)))
}
