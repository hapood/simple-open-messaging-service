use crate::*;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadProgress {
    loaded: u64,
    total: u64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeUploadSource {
    part_id: String,
    path: String,
    size: u64,
}

fn prepared_sources() -> &'static std::sync::Mutex<std::collections::HashMap<String, std::collections::HashMap<String, std::fs::File>>> {
    static PREPARED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, std::collections::HashMap<String, std::fs::File>>>> = std::sync::OnceLock::new();
    PREPARED.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn open_upload_source(path: &str) -> Result<std::fs::File, String> {
    #[cfg(target_os = "android")]
    if path.starts_with("content://") || path.starts_with("file://") {
        return crate::android_upload_source::open(path);
    }
    std::fs::File::open(path).map_err(|_| "Attachment unavailable. Please cancel and upload again.".into())
}

/// Open every gallery resource before any part may transfer. A failure closes every handle opened by this call.
fn prepare_sources(client_message_id: &str, sources: &[NativeUploadSource]) -> Result<(), String> {
    if sources.is_empty() { return Err("Attachment unavailable. Please cancel and upload again.".into()); }
    let mut opened = std::collections::HashMap::new();
    for source in sources {
        if source.part_id.is_empty() || !opened.insert(source.part_id.clone(), open_upload_source(&source.path)?).is_none() {
            return Err("Attachment unavailable. Please cancel and upload again.".into());
        }
        let file = opened.get(&source.part_id).expect("just inserted");
        let metadata = file.metadata().map_err(|_| "Attachment unavailable. Please cancel and upload again.".to_string())?;
        if metadata.is_file() && metadata.len() != source.size {
            return Err(format!("file changed after selection (selected {} bytes, now {} bytes)", source.size, metadata.len()));
        }
    }
    let mut prepared = prepared_sources().lock().expect("prepared upload sources");
    prepared.insert(client_message_id.to_owned(), opened);
    Ok(())
}

fn take_prepared_source(client_message_id: &str, part_id: &str) -> Option<std::fs::File> {
    let mut prepared = prepared_sources().lock().expect("prepared upload sources");
    let files = prepared.get_mut(client_message_id)?;
    let file = files.remove(part_id)?;
    if files.is_empty() { prepared.remove(client_message_id); }
    Some(file)
}

fn release_prepared_sources(client_message_id: &str) {
    prepared_sources().lock().expect("prepared upload sources").remove(client_message_id);
}

#[tauri::command]
pub(crate) fn prepare_native_upload_sources(client_message_id: String, sources: Vec<NativeUploadSource>) -> Result<(), String> {
    prepare_sources(&client_message_id, &sources)
}

#[tauri::command]
pub(crate) fn release_native_upload_sources(client_message_id: String) {
    release_prepared_sources(&client_message_id);
}

/// Stream a message attachment from disk using the sequential upload protocol.
#[tauri::command]
pub(crate) async fn upload_stream_file(
    proxy: tauri::State<'_, ServerSessionState>,
    path: String,
    filename: String,
    mime: String,
    size: u64,
    fields: std::collections::HashMap<String, String>,
    client_message_id: Option<String>,
    progress: tauri::ipc::Channel<UploadProgress>,
) -> Result<serde_json::Value, String> {
    upload_stream_path_core(
        proxy.inner().clone(),
        path,
        filename,
        mime,
        size,
        fields,
        client_message_id,
        progress,
    )
    .await
}

async fn upload_stream_path_core(
    proxy: ServerSessionState,
    path: String,
    filename: String,
    mime: String,
    size: u64,
    fields: std::collections::HashMap<String, String>,
    client_message_id: Option<String>,
    progress: tauri::ipc::Channel<UploadProgress>,
) -> Result<serde_json::Value, String> {
    let prepared = client_message_id.as_ref().zip(fields.get("partId")).and_then(|(cid, part_id)| take_prepared_source(cid, part_id));
    let file = if let Some(file) = prepared {
        tokio::fs::File::from_std(file)
    } else {
        #[cfg(target_os = "android")]
        {
            if path.starts_with("content://") || path.starts_with("file://") {
                let source = tauri::async_runtime::spawn_blocking(move || crate::android_upload_source::open(&path))
                    .await.map_err(|error| error.to_string())??;
                tokio::fs::File::from_std(source)
            } else {
                tokio::fs::File::open(&path).await.map_err(|_| "Attachment unavailable. Please cancel and upload again.".to_string())?
            }
        }
        #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows", target_os = "ios"))]
        { tokio::fs::File::open(&path).await.map_err(|_| "Attachment unavailable. Please cancel and upload again.".to_string())? }
    };
    let actual_size = file
        .metadata()
        .await
        .map_err(|e| format!("file metadata: {e}"))?
        .len();
    if actual_size != size {
        return Err(format!(
            "file changed after selection (selected {size} bytes, now {actual_size} bytes)"
        ));
    }
    upload_stream_open_file_core(
        proxy,
        file,
        filename,
        mime,
        size,
        fields,
        client_message_id,
        progress,
    )
    .await
}

/// Upload an already-open file descriptor without reopening it through a filesystem path.
///
/// Android document providers commonly return `content://` descriptors whose `/proc/self/fd/<n>`
/// symlink cannot be opened again (and pipe-backed providers may not have a reusable path at all).
/// Taking a `tokio::fs::File` here keeps the original picker grant alive for the whole request and
/// makes normal Rust ownership close the descriptor on success, error, or cancellation.
async fn upload_stream_open_file_core(
    proxy: ServerSessionState,
    mut file: tokio::fs::File,
    filename: String,
    mime: String,
    size: u64,
    fields: std::collections::HashMap<String, String>,
    client_message_id: Option<String>,
    progress: tauri::ipc::Channel<UploadProgress>,
) -> Result<serde_json::Value, String> {
    let cid = client_message_id
        .as_deref()
        .ok_or_else(|| "missing client message identity".to_string())?;
    let part = ResumablePart::from_fields(&fields)?;
    let metadata = file.metadata().await.map_err(|error| format!("attachment metadata: {error}"))?;
    // Provider pipes may not expose a file length. Regular files must match the admitted size,
    // including zero, without reading the contents or computing a digest.
    if metadata.is_file() && metadata.len() != size {
        return Err(format!("file changed after selection (selected {size} bytes, now {} bytes)", metadata.len()));
    }
    upload_resumable_open_file(proxy, &mut file, filename, mime, size, cid, part, progress).await
}

struct ResumablePart {
    part_id: String,
    position: u32,
    intent: String,
}

impl ResumablePart {
    fn from_fields(fields: &std::collections::HashMap<String, String>) -> Result<Self, String> {
        let required = |key: &str| {
            fields
                .get(key)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| format!("missing resumable upload field: {key}"))
        };
        Ok(Self {
            part_id: required("partId")?.clone(),
            position: required("position")?
                .parse()
                .map_err(|_| "invalid resumable upload position".to_string())?,
            intent: required("intent")?.clone(),
        })
    }
}

#[derive(Debug, PartialEq)]
enum ResumableState {
    Uploading { offset: u64, chunk_size: usize },
    Completing,
    Completed(serde_json::Value),
    RetryRequired,
}

fn parse_resumable_state(
    value: &serde_json::Value,
    task_id: &str,
    size: u64,
) -> Result<ResumableState, String> {
    if value.pointer("/data/id").and_then(|v| v.as_str()) != Some(task_id) {
        return Err("upload response changed id".into());
    }
    let offset = match value.pointer("/data/offset") {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => Some(
            value
                .as_u64()
                .filter(|offset| *offset <= size)
                .ok_or_else(|| "invalid upload offset".to_string())?,
        ),
    };
    let status = value.pointer("/data/status").and_then(|v| v.as_str());
    let phase = value.pointer("/data/phase");
    if status != Some("PENDING") && phase.is_some() {
        return Err("invalid upload phase".into());
    }
    match status {
        Some("PENDING") => match phase.and_then(|v| v.as_str()) {
            Some("UPLOADING") => Ok(ResumableState::Uploading {
                offset: offset.ok_or_else(|| "upload progress unavailable".to_string())?,
                chunk_size: value
                    .pointer("/data/chunkSize")
                    .and_then(|v| v.as_u64())
                    .and_then(|v| usize::try_from(v).ok())
                    .filter(|v| *v > 0)
                    .ok_or_else(|| "invalid upload chunk size".to_string())?,
            }),
            Some("COMPLETING") => Ok(ResumableState::Completing),
            _ => Err("invalid upload phase".into()),
        },
        Some("COMPLETED") => value
            .pointer("/data/result")
            .filter(|result| result.is_object())
            .cloned()
            .map(ResumableState::Completed)
            .ok_or_else(|| "completed upload omitted result".to_string()),
        Some("FAILED") => Ok(ResumableState::RetryRequired),
        _ => Err("invalid upload status".into()),
    }
}

fn upload_result(result: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "code": 0, "message": "success", "data": result })
}

/// Each invocation is a user-started attempt for the same part identity, including explicit retry.
/// Failed/stopped tasks require one retry request; there is no automatic retry loop. Unknown
/// progress never permits seeking or writing, and completing tasks need no source seek.
async fn upload_resumable_open_file(
    proxy: ServerSessionState,
    file: &mut tokio::fs::File,
    filename: String,
    mime: String,
    size: u64,
    client_message_id: &str,
    part: ResumablePart,
    progress: tauri::ipc::Channel<UploadProgress>,
) -> Result<serde_json::Value, String> {
    let cancel = proxy
        .upload_cancels
        .lock()
        .expect("upload_cancels lock")
        .register(client_message_id);
    let transfer = async {
    let origin = proxy.routes.snapshot().active.clone();
    let client = proxy.api_client(&origin);
    let token = proxy.session_token();
    let auth = |request: reqwest::RequestBuilder| {
        if let Some(value) = token.as_ref() {
            request.header("authorization", format!("Bearer {value}"))
        } else {
            request
        }
    };
    let init_url = format!("{origin}/api/v1/uploads/resumable/init");
    let init_value = timed_upload_json(
        auth(client.post(init_url).json(&serde_json::json!({
            "clientMessageId": client_message_id,
            "partId": part.part_id,
            "position": part.position,
            "intent": part.intent,
            "originalName": filename,
            "mimeType": if mime.is_empty() { "application/octet-stream" } else { &mime },
            "totalBytes": size,
        }))),
        "upload init",
    )
    .await?;
    if init_value.get("code").and_then(|v| v.as_i64()) != Some(0) {
        return Ok(init_value);
    }
    let task_id = init_value
        .pointer("/data/id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "upload init omitted id".to_string())?
        .to_string();
    if !task_id.bytes().all(|byte| byte.is_ascii_digit())
        || task_id.starts_with('0')
        || task_id.parse::<i64>().map_or(true, |id| id <= 0)
    {
        return Err("upload init returned invalid task id".into());
    }
    if let ResumableState::Completed(result) = parse_resumable_state(&init_value, &task_id, size)?
    {
        return Ok(upload_result(result));
    }
    let status_url = format!("{origin}/api/v1/uploads/resumable/{task_id}");
    let status = timed_upload_json(auth(client.get(&status_url)), "upload status").await?;
    if status.get("code").and_then(|v| v.as_i64()) != Some(0) {
        return Ok(status);
    }
    let mut state = parse_resumable_state(&status, &task_id, size)?;
    if state == ResumableState::RetryRequired {
        let retried = timed_upload_json(
            auth(
                client
                    .post(format!("{status_url}/retry"))
                    .json(&serde_json::json!({})),
            ),
            "upload retry",
        )
        .await?;
        if retried.get("code").and_then(|v| v.as_i64()) != Some(0) {
            return Ok(retried);
        }
        state = parse_resumable_state(&retried, &task_id, size)?;
    }
    match &state {
        ResumableState::Completed(result) => return Ok(upload_result(result.clone())),
        ResumableState::RetryRequired => return Err("upload remains failed or stopped".into()),
        ResumableState::Uploading { offset, .. } => {
            file.seek(std::io::SeekFrom::Start(*offset))
                .await
                .map_err(|e| format!("seek upload source: {e}"))?;
            let _ = progress.send(UploadProgress { loaded: *offset, total: size });
        }
        ResumableState::Completing => {}
    }
        while let ResumableState::Uploading { offset, chunk_size } = state {
            if offset == size {
                break;
            }
            let wanted =
                usize::try_from((size - offset).min(chunk_size as u64)).unwrap_or(chunk_size);
            let mut chunk = vec![0_u8; wanted];
            file.read_exact(&mut chunk)
                .await
                .map_err(|e| format!("read upload source: {e}"))?;
            let end = offset + wanted as u64 - 1;
            let progress_channel = progress.clone();
            let (activity, receiver) = tokio::sync::watch::channel((tokio::time::Instant::now(), false));
            let body = futures_util::stream::unfold((chunk, 0usize, std::time::Instant::now()), move |(chunk, position, last_report)| {
                let activity = activity.clone();
                let channel = progress_channel.clone();
                async move {
                    if position >= chunk.len() { return None; }
                    let next = (position + 64 * 1024).min(chunk.len());
                    let _ = activity.send((tokio::time::Instant::now(), next == chunk.len()));
                    let bytes = chunk[position..next].to_vec();
                    let now = std::time::Instant::now();
                    let report = next == chunk.len() || now.duration_since(last_report) >= std::time::Duration::from_millis(100);
                    if report {
                        let _ = channel.send(UploadProgress { loaded: offset + next as u64, total: size });
                    }
                    Some((Ok::<_, std::io::Error>(bytes), (chunk, next, if report { now } else { last_report })))
                }
            });
            let response = upload_chunk_json(
                auth(
                    client
                        .put(&status_url)
                        .header("content-type", "application/octet-stream")
                        .header("content-range", format!("bytes {offset}-{end}/{size}"))
                        .header("content-length", wanted)
                        .body(reqwest::Body::wrap_stream(body)),
                ),
                receiver,
            )
            .await?;
            if response.get("code").and_then(|v| v.as_i64()) != Some(0) {
                return Ok(response);
            }
            state = parse_resumable_state(&response, &task_id, size)?;
            match &state {
                ResumableState::Uploading { offset, .. } => {
                    if *offset != end + 1 {
                        return Err("upload chunk returned unexpected offset".into());
                    }

                }
                ResumableState::Completed(result) => return Ok(upload_result(result.clone())),
                ResumableState::RetryRequired => return Err("upload failed or stopped".into()),
                ResumableState::Completing => {}
            }
        }
        let completed = timed_upload_json(
            auth(
                client
                    .post(format!("{status_url}/complete"))
                    .json(&serde_json::json!({})),
            ),
            "upload complete",
        )
        .await?;
        if completed.get("code").and_then(|v| v.as_i64()) != Some(0) {
            return Ok(completed);
        }
        match parse_resumable_state(&completed, &task_id, size)? {
            ResumableState::Completed(result) => Ok(upload_result(result)),
            ResumableState::Completing => completed
                .pointer("/data/result")
                .filter(|result| result.is_object())
                .cloned()
                .map(upload_result)
                .ok_or_else(|| "upload complete omitted result".to_string()),
            _ => Err("invalid upload complete status".into()),
        }
    };
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("upload cancelled".to_string()),
        value = transfer => value,
    };
    proxy
        .upload_cancels
        .lock()
        .expect("upload_cancels lock")
        .finish(client_message_id, &cancel);
    result
}

async fn upload_chunk_json(
    request: reqwest::RequestBuilder,
    mut activity: tokio::sync::watch::Receiver<(tokio::time::Instant, bool)>,
) -> Result<serde_json::Value, String> {
    let response = request.send();
    tokio::pin!(response);
    let mut watching = true;
    let response = loop {
        let (last, finished) = *activity.borrow_and_update();
        let delay = if finished { Duration::from_secs(12) } else { Duration::from_secs(30) };
        tokio::select! {
            result = &mut response => break result.map_err(|e| format!("upload chunk: {e}"))?,
            changed = activity.changed(), if watching => {
                if changed.is_err() { watching = false; }
            }
            _ = tokio::time::sleep_until(last + delay) => {
                return Err(if finished { "upload response headers timed out" } else { "upload transmission idle timeout" }.into());
            }
        }
    };
    let bytes = crate::proxy::read_body_with_inactivity_timeout(
        response.bytes_stream(), crate::API_BODY_INACTIVITY_TIMEOUT, None,
    ).await?;
    serde_json::from_slice(&bytes).map_err(|e| format!("decode upload response: {e}"))
}

/** Small resumable control requests use the same header and body deadlines as native API calls. */
async fn timed_upload_json(
    request: reqwest::RequestBuilder,
    phase: &str,
) -> Result<serde_json::Value, String> {
    let response = crate::proxy::send_with_headers_deadline(request, crate::API_HEADERS_TIMEOUT)
        .await.map_err(|error| match error {
            crate::proxy::HeadersError::SendFailed(error) => format!("{phase}: {error}"),
            crate::proxy::HeadersError::Timeout => format!("{phase}: response headers timed out"),
            crate::proxy::HeadersError::Cancelled => format!("{phase}: cancelled"),
        })?;
    let bytes = crate::proxy::read_body_with_inactivity_timeout(
        response.bytes_stream(), crate::API_BODY_INACTIVITY_TIMEOUT, None,
    ).await.map_err(|e| format!("{phase}: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("{phase}: {e}"))
}

#[cfg(test)]
mod resumable_part_tests {
    use super::*;

    #[test]
    fn resumable_state_never_fabricates_writable_progress() {
        let base = serde_json::json!({"data": {
            "id": "task", "status": "PENDING", "phase": "UPLOADING", "offset": 0, "chunkSize": 4
        }});
        assert_eq!(
            parse_resumable_state(&base, "task", 4).unwrap(),
            ResumableState::Uploading {
                offset: 0,
                chunk_size: 4
            }
        );
        for offset in [
            serde_json::Value::Null,
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!(5),
            serde_json::json!("0"),
        ] {
            let mut value = base.clone();
            value["data"]["offset"] = offset;
            assert!(parse_resumable_state(&value, "task", 4).is_err());
        }
        let mut missing = base.clone();
        missing["data"].as_object_mut().unwrap().remove("offset");
        assert!(parse_resumable_state(&missing, "task", 4).is_err());
        assert!(parse_resumable_state(&base, "other-task", 4).is_err());
        for status in [
            "FAILED",
            "STOPPED",
            "UPLOADING",
            "COMPLETING",
            "COMPLETED",
            "UNKNOWN",
        ] {
            missing["data"]["status"] = serde_json::json!(status);
            missing["data"].as_object_mut().unwrap().remove("phase");
            let result = parse_resumable_state(&missing, "task", 4);
            match status {
                "FAILED" => assert_eq!(result.unwrap(), ResumableState::RetryRequired),
                _ => assert!(result.is_err()),
            }
        }
        missing["data"]["status"] = serde_json::json!("PENDING");
        missing["data"]["phase"] = serde_json::json!("COMPLETING");
        assert_eq!(
            parse_resumable_state(&missing, "task", 4).unwrap(),
            ResumableState::Completing
        );
        for phase in [serde_json::Value::Null, serde_json::json!("UNKNOWN")] {
            missing["data"]["phase"] = phase;
            assert!(parse_resumable_state(&missing, "task", 4).is_err());
        }
        missing["data"].as_object_mut().unwrap().remove("phase");
        assert!(parse_resumable_state(&missing, "task", 4).is_err());
        missing["data"]["status"] = serde_json::json!("COMPLETED");
        missing["data"]["result"] = serde_json::json!({"digest": "done"});
        assert_eq!(
            parse_resumable_state(&missing, "task", 4).unwrap(),
            ResumableState::Completed(serde_json::json!({"digest": "done"}))
        );
        for status in ["COMPLETED", "FAILED"] {
            missing["data"]["status"] = serde_json::json!(status);
            for phase in [serde_json::Value::Null, serde_json::json!("UPLOADING")] {
                missing["data"]["phase"] = phase;
                assert!(parse_resumable_state(&missing, "task", 4).is_err());
            }
        }
    }

    #[test]
    fn native_resumable_init_preserves_browser_part_identity() {
        let fields = std::collections::HashMap::from([
            (
                "partId".into(),
                "3d69ea67-50ea-49d9-98f0-d54360699b33".into(),
            ),
            ("position".into(), "0".into()),
            ("intent".into(), "FILE".into()),
        ]);
        let part = ResumablePart::from_fields(&fields).unwrap();
        let value = serde_json::json!({
            "partId": part.part_id,
            "position": part.position,
            "intent": part.intent,
        });
        assert_eq!(value["partId"], fields["partId"]);
        assert_eq!(value["position"], 0);
        assert_eq!(value["intent"], "FILE");
        assert!(ResumablePart::from_fields(&std::collections::HashMap::new()).is_err());
    }
}

/// Tracks recording ownership until session cleanup; sending and retry use the shared outbox.
#[cfg(any(target_os = "android", target_os = "ios"))]
#[derive(Clone)]
pub(crate) struct NativeVoicePending {
    owner: Arc<crate::login_connection::LoginConnection>,
    path: String,
    part_id: String,
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustUploadBridge_uploadVoicePath(
    mut env: jni::JNIEnv,
    _receiver: jni::objects::JObject,
    path: jni::objects::JString,
    context_id: jni::sys::jlong,
    thread_id: jni::sys::jlong,
    client_message_id: jni::objects::JString,
    duration_ms: jni::sys::jlong,
    size: jni::sys::jlong,
) {
    let read = |env: &mut jni::JNIEnv, value: jni::objects::JString| {
        env.get_string(&value)
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let path = read(&mut env, path);
    let client_message_id = read(&mut env, client_message_id);
    let Some(app) = ANDROID_APP.get().cloned() else {
        return;
    };
    let proxy = app.state::<ServerSessionState>().inner().clone();
    let owner = match crate::native_db::current_login() {
        // A non-ACTIVE owner still owns this recording: the entry is created, the spawn emits
        // a visible failure from its credential gate, and a later retry re-asserts admission —
        // exactly the old unauthenticated-stage behavior with epoch discipline.
        Ok(Some(owner)) => owner,
        Ok(None) | Err(_) => {
            // No login connection exists at all: nothing can own or retry this recording, so
            // close the UI loop visibly and drop the file instead of leaking it silently.
            log::warn!("Recording admission rejected: no native login owns the resource");
            let _ = fs::remove_file(path);
            return;
        }
    };
    let pending = NativeVoicePending {
        owner: owner.clone(),
        path,
        part_id: uuid::Uuid::new_v4().to_string(),
    };
    let registered = owner.capture_database_work().map_err(|error| error.to_string()).and_then(|work| {
        work.with_database(|connection| {
            crate::send_outbox::SendOutboxStorage::new(connection)
                .register_owned_recording(&client_message_id, std::path::Path::new(&pending.path))
        }).map_err(|error| error.to_string())
    });
    if let Err(error) = registered {
        log::warn!("Recording ownership registration failed: {error}");
        let _ = fs::remove_file(&pending.path);
        return;
    }
    proxy
        .native_voice_pending
        .lock()
        .expect("native voice lock")
        .insert(client_message_id.clone(), pending.clone());
    // The captured epoch owns disposal. Late cancellation only removes its own recording,
    // never a successor's entry, and never holds a lifecycle lock during filesystem work.
    let session_id = owner.id().clone();
    let cleanup_proxy = proxy.clone();
    let cleanup_id = client_message_id.clone();
    tauri::async_runtime::spawn(async move {
        owner.cancellation().cancelled().await;
        let removed = {
            let mut entries = cleanup_proxy
                .native_voice_pending
                .lock()
                .expect("native voice lock");
            if entries
                .get(&cleanup_id)
                .is_some_and(|entry| Arc::ptr_eq(&entry.owner, &owner))
            {
                entries.remove(&cleanup_id)
            } else {
                None
            }
        };
        if removed.is_some() {
            cancel_task_uploads(&cleanup_proxy, &cleanup_id);
            if let Ok(work) = owner.capture_database_work() {
                let _ = work.with_database(|connection| {
                    let store = crate::send_outbox::SendOutboxStorage::new(connection);
                    if store.get(&cleanup_id)?.is_some() { return Ok(()); }
                    let paths = store.owned_recordings(&cleanup_id)?;
                    crate::send_outbox::release_owned_recordings(paths)?;
                    connection.execute("DELETE FROM owned_send_resources WHERE client_message_id=?1", [&cleanup_id]).map_err(|error| error.to_string())?;
                    Ok(())
                });
            }
        }
    });
    let _ = app.emit("native-voice-ready", serde_json::json!({
        "sessionId": session_id,
        "contextId": context_id, "threadId": thread_id, "clientMessageId": client_message_id,
        "durationMs": duration_ms, "size": size, "path": pending.path,
        "partId": pending.part_id, "name": "voice.m4a", "mimeType": "audio/mp4",
    }));
}

/// Cancel all registered parts of a shell upload, including control requests and source reads.
/// Idempotent for completed tasks. Browser cancellation remains owned by HttpClient unsubscribe.
#[tauri::command]
pub(crate) fn cancel_upload(
    proxy: tauri::State<'_, ServerSessionState>,
    client_message_id: String,
) {
    cancel_task_uploads(&proxy, &client_message_id);
    release_prepared_sources(&client_message_id);
}

fn cancel_task_uploads(proxy: &ServerSessionState, client_message_id: &str) {
    let tokens = proxy.upload_cancels.lock().expect("upload_cancels lock").take(client_message_id);
    for token in tokens { token.cancel(); }
}

#[cfg(test)]
mod prepared_source_tests {
    use super::*;

    #[test]
    fn opens_every_source_before_retaining_any_handle() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("one");
        std::fs::write(&first, b"abc").unwrap();
        let missing = directory.path().join("missing");
        let sources = vec![
            NativeUploadSource { part_id: "a".into(), path: first.display().to_string(), size: 3 },
            NativeUploadSource { part_id: "b".into(), path: missing.display().to_string(), size: 1 },
        ];
        assert!(prepare_sources("prepare-cid", &sources).unwrap_err().contains("Attachment unavailable"));
        assert!(take_prepared_source("prepare-cid", "a").is_none());
        prepare_sources("prepare-cid", &sources[..1]).unwrap();
        assert!(take_prepared_source("prepare-cid", "a").is_some());
        assert!(take_prepared_source("prepare-cid", "a").is_none());
    }
}
