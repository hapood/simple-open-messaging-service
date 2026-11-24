//! Android secure-storage execution only; Rust owns logout admission and retries.
use jni::{objects::{GlobalRef, JObject, JValue}, JNIEnv, JavaVM};
use std::sync::OnceLock;

struct Adapter { vm: JavaVM, class: GlobalRef }
static ADAPTER: OnceLock<Adapter> = OnceLock::new();

pub(crate) fn initialize(env: &mut JNIEnv) -> Result<(), String> {
    let class = env.find_class("com/soms/client/SomsSecureStore").map_err(|e| e.to_string())?;
    ADAPTER.set(Adapter {
        vm: env.get_java_vm().map_err(|e| e.to_string())?,
        class: env.new_global_ref(class).map_err(|e| e.to_string())?,
    }).map_err(|_| "logout adapter already initialized".into())
}

pub(crate) fn cleanup(_: &tauri::AppHandle, session: &str) -> Result<(), String> {
    let adapter = ADAPTER.get().ok_or("logout adapter not initialized")?;
    let mut env = adapter.vm.attach_current_thread().map_err(|e| e.to_string())?;
    env.push_local_frame(8).map_err(|e| e.to_string())?;
    let result = (|| {
        let session = env.new_string(session).map_err(|e| e.to_string())?;
        let class: &jni::objects::JClass = adapter.class.as_obj().into();
        env.call_static_method(class, "clearEndedSession", "(Ljava/lang/String;)V", &[JValue::Object(&session)])
            .map_err(|_| "Android credential cleanup failed".to_owned())?;
        Ok(())
    })();
    if env.exception_check().unwrap_or(false) { let _ = env.exception_clear(); }
    unsafe { let _ = env.pop_local_frame(&JObject::null()); }
    result
}
