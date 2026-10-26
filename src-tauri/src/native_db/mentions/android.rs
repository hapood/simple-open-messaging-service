use super::{Owner, Sink};
use jni::{
    objects::{GlobalRef, JObject, JString, JValue},
    sys::jlong,
    JNIEnv, JavaVM,
};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, OnceLock,
};

static OWNERS: OnceLock<Mutex<HashMap<u64, Arc<Owner>>>> = OnceLock::new();
static NEXT: AtomicU64 = AtomicU64::new(1);
struct Callback {
    vm: JavaVM,
    object: GlobalRef,
}
impl Sink for Callback {
    fn results(&self, context: i64, request: i64, metadata: String, avatars: Vec<Vec<u8>>) {
        let Ok(mut env) = self.vm.attach_current_thread() else {
            return;
        };
        let result = env.with_local_frame(16, |env| -> jni::errors::Result<()> {
            let metadata = JObject::from(env.new_string(metadata)?);
            let images = env.new_object_array(avatars.len() as i32, "[B", JObject::null())?;
            for (index, bytes) in avatars.iter().enumerate() {
                let image = env.byte_array_from_slice(bytes)?;
                env.set_object_array_element(&images, index as i32, &image)?;
                env.delete_local_ref(image)?;
            }
            env.call_method(
                self.object.as_obj(),
                "onResults",
                "(JJLjava/lang/String;[[B)V",
                &[
                    JValue::Long(context),
                    JValue::Long(request),
                    JValue::Object(&metadata),
                    JValue::Object(&JObject::from(images)),
                ],
            )?;
            Ok(())
        });
        if result.is_err() && env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
    }
}
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustMentionBridge_open(
    mut env: JNIEnv,
    _: JObject,
    callback: JObject,
) -> jlong {
    let result = (|| -> Result<u64, String> {
        let callback = Callback {
            vm: env.get_java_vm().map_err(|e| e.to_string())?,
            object: env.new_global_ref(callback).map_err(|e| e.to_string())?,
        };
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        OWNERS
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| "mention registry poisoned")?
            .insert(id, Owner::new(Arc::new(callback)));
        Ok(id)
    })();
    match result {
        Ok(id) => id as jlong,
        Err(error) => {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
            0
        }
    }
}
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustMentionBridge_query(
    mut env: JNIEnv,
    _: JObject,
    lease: jlong,
    user_id: jlong,
    thread_id: jlong,
    context: jlong,
    request: jlong,
    query: JString,
    all_label: JString,
) {
    let result = (|| -> Result<(), String> {
        let owner = OWNERS
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| "mention registry poisoned")?
            .get(&(lease as u64))
            .cloned()
            .ok_or("mention owner closed")?;
        let query: String = env.get_string(&query).map_err(|e| e.to_string())?.into();
        let all_label: String = env
            .get_string(&all_label)
            .map_err(|e| e.to_string())?
            .into();
        owner.query(
            crate::android_runtime::proxy_state()?,
            user_id,
            thread_id,
            context,
            request,
            query,
            all_label,
        )
    })();
    if let Err(error) = result {
        let _ = env.throw_new("java/lang/IllegalStateException", error);
    }
}
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustMentionBridge_cancel(
    _: JNIEnv,
    _: JObject,
    lease: jlong,
) {
    let owner = OWNERS
        .get_or_init(Default::default)
        .lock()
        .ok()
        .and_then(|owners| owners.get(&(lease as u64)).cloned());
    if let Some(owner) = owner {
        owner.cancel();
    }
}
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustMentionBridge_close(
    _: JNIEnv,
    _: JObject,
    lease: jlong,
) {
    let owner = OWNERS
        .get_or_init(Default::default)
        .lock()
        .ok()
        .and_then(|mut owners| owners.remove(&(lease as u64)));
    if let Some(owner) = owner {
        owner.cancel();
    }
}
