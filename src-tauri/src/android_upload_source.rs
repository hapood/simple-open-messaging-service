//! OS-only source opener. Upload execution and IPC channels remain in Rust.
use jni::{objects::{GlobalRef, JObject, JValue}, JNIEnv, JavaVM};
use std::{os::fd::FromRawFd, sync::OnceLock};

struct SourceAdapter { vm: JavaVM, object: GlobalRef }
static SOURCE: OnceLock<SourceAdapter> = OnceLock::new();

#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustUploadBridge_bindSourceAdapter(env: JNIEnv, object: JObject) {
    if let (Ok(vm), Ok(object)) = (env.get_java_vm(), env.new_global_ref(object)) {
        let _ = SOURCE.set(SourceAdapter { vm, object });
    }
}

pub(crate) fn open(path: &str) -> Result<std::fs::File, String> {
    let adapter = SOURCE.get().ok_or("Android source adapter is unavailable")?;
    let mut env = adapter.vm.attach_current_thread().map_err(|error| error.to_string())?;
    let result = env.with_local_frame(8, |env| -> jni::errors::Result<i32> {
        let path = JObject::from(env.new_string(path)?);
        env.call_method(adapter.object.as_obj(), "openSource", "(Ljava/lang/String;)I", &[JValue::Object(&path)])?.i()
    });
    let fd = result.map_err(|error| error.to_string())?;
    if fd < 0 { return Err("Attachment unavailable. Please cancel and upload again.".into()); }
    // Kotlin detached this descriptor and transferred sole ownership to this invocation.
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}
