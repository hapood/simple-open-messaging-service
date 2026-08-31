use crate::*;

/// Shell-wide streaming upload: POST a file straight from its on-disk `path` to `${origin}${endpoint}`
/// as a multipart form without buffering the whole file into the webview or IPC.
#[tauri::command]
pub(crate) async fn upload_stream_file(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ProxyState>,
    path: String,
    endpoint: String,
    filename: String,
    mime: String,
    size: u64,
    fields: std::collections::HashMap<String, String>,
    client_message_id: Option<String>,
) -> Result<serde_json::Value, String> {
    upload_stream_path_core(
        app,
        proxy.inner().clone(),
        path,
        endpoint,
        filename,
        mime,
        size,
        fields,
        client_message_id,
    )
    .await
}

async fn upload_stream_path_core(
    app: tauri::AppHandle,
    proxy: ProxyState,
    path: String,
    endpoint: String,
    filename: String,
    mime: String,
    size: u64,
    fields: std::collections::HashMap<String, String>,
    client_message_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| format!("open file: {e}"))?;
    let actual_size = file
        .metadata()
        .await
        .map_err(|e| format!("file metadata: {e}"))?
        .len();
    if size > 0 && actual_size != size {
        return Err(format!(
            "file changed after selection (selected {size} bytes, now {actual_size} bytes)"
        ));
    }
    let size = if size > 0 { size } else { actual_size };
    upload_stream_open_file_core(
        app,
        proxy,
        file,
        endpoint,
        filename,
        mime,
        size,
        fields,
        client_message_id,
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
    app: tauri::AppHandle,
    proxy: ProxyState,
    mut file: tokio::fs::File,
    endpoint: String,
    filename: String,
    mime: String,
    size: u64,
    fields: std::collections::HashMap<String, String>,
    client_message_id: Option<String>,
) -> Result<serde_json::Value, String> {
    if !matches!(
        endpoint.as_str(),
        "/upload" | "/upload/file" | "/upload/video" | "/upload/audio" | "/upload/avatar"
    ) {
        return Err("unsupported upload endpoint".to_string());
    }
    if let Some(cid) = client_message_id.as_ref() {
        return upload_resumable_open_file(app, proxy, &mut file, filename, mime, size, cid).await;
    }
    let origin = proxy.api_origin.lock().expect("origin lock").clone();
    let url = format!("{}/api/v1{}", origin, endpoint);
    let client = proxy.api_client(&origin);
    let progress_id = client_message_id.clone();
    let mut loaded = 0_u64;
    let mut last_reported = 0_u64;
    let mut last_report_at = Instant::now();
    // Report at most roughly every 256 KiB / 100 ms. ReaderStream may yield very small chunks; emitting
    // every chunk would flood the WebView IPC on a fast multi-GB upload.
    let stream = tokio_util::io::ReaderStream::new(file).map(move |result| {
        if let Ok(bytes) = &result {
            loaded = loaded.saturating_add(bytes.len() as u64);
            let due_bytes = loaded.saturating_sub(last_reported) >= 256 * 1024;
            let due_time = last_report_at.elapsed() >= Duration::from_millis(100);
            if due_bytes || due_time || (size > 0 && loaded >= size) {
                if let Some(cid) = progress_id.as_ref() {
                    let _ = app.emit(
                        "upload-progress",
                        serde_json::json!({
                            "clientMessageId": cid,
                            "loaded": loaded,
                            "total": size,
                        }),
                    );
                }
                last_reported = loaded;
                last_report_at = Instant::now();
            }
        }
        result
    });
    let body = reqwest::Body::wrap_stream(stream);
    let part = if size > 0 {
        reqwest::multipart::Part::stream_with_length(body, size)
    } else {
        reqwest::multipart::Part::stream(body)
    }
    .file_name(filename)
    .mime_str(&mime)
    .map_err(|e| format!("mime: {e}"))?;
    let mut form = reqwest::multipart::Form::new();
    for (k, v) in fields {
        form = form.text(k, v);
    }
    form = form.part("file", part);
    let mut req = client.post(&url).multipart(form);
    if let Some(cid) = client_message_id.as_ref() {
        req = req.header("x-client-message-id", cid);
    }
    if let Some(t) = proxy.token.lock().ok().and_then(|g| g.clone()) {
        req = req.header("authorization", format!("Bearer {}", t));
    }
    // No send timeout: a large upload legitimately takes minutes, and a total-duration timeout would
    // wrongly abort it. `BACKEND_CONNECT_TIMEOUT` (on the cached client) already catches an unreachable
    // backend; a mid-upload stall is an accepted rare failure (the user can retry).
    let upload_cancel = CancellationToken::new();
    if let Some(cid) = client_message_id.as_ref() {
        proxy
            .upload_cancels
            .lock()
            .expect("upload_cancels lock")
            .insert(cid.clone(), upload_cancel.clone());
    }
    let send_result = tokio::select! {
        result = req.send() => Some(result),
        _ = upload_cancel.cancelled() => None,
    };
    if let Some(cid) = client_message_id.as_ref() {
        proxy
            .upload_cancels
            .lock()
            .expect("upload_cancels lock")
            .remove(cid);
    }
    let resp = match send_result {
        None => return Err("upload cancelled".to_string()),
        Some(Ok(r)) => r,
        Some(Err(e)) => {
            // Unreachable backend mid-upload: re-race select_origin so the user's RETRY hits the new active
            // origin. We do NOT re-issue the streaming upload here (re-opening the file + re-streaming is
            // the caller's job); non-network errors don't switch.
            if is_network_failure(&e) {
                runtime_switch(&proxy).await;
            }
            return Err(format!("upload send: {e}"));
        }
    };
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("upload read: {e}"))?;
    if !status.is_success() {
        return Err(format!("upload HTTP {}: {}", status.as_u16(), text));
    }
    // Return the raw envelope ({code,message,data}); the frontend reads it as StandardResponse<T>.
    serde_json::from_str::<serde_json::Value>(&text).map_err(|e| format!("upload parse: {e}"))
}

/// Native counterpart of the browser's sequential resumable protocol. The server owns the
/// authoritative offset; every retry re-initializes idempotently and resumes from that offset.
async fn upload_resumable_open_file(
    app: tauri::AppHandle,
    proxy: ProxyState,
    file: &mut tokio::fs::File,
    filename: String,
    mime: String,
    size: u64,
    client_message_id: &str,
) -> Result<serde_json::Value, String> {
    const FALLBACK_CHUNK: usize = 4 * 1024 * 1024;
    let origin = proxy.api_origin.lock().expect("origin lock").clone();
    let client = proxy.api_client(&origin);
    let token = proxy.token.lock().ok().and_then(|g| g.clone());
    let auth = |request: reqwest::RequestBuilder| {
        if let Some(value) = token.as_ref() {
            request.header("authorization", format!("Bearer {value}"))
        } else {
            request
        }
    };
    let init_url = format!("{origin}/api/v1/uploads/resumable/init");
    let init = auth(client.post(init_url).json(&serde_json::json!({
        "clientMessageId": client_message_id,
        "originalName": filename,
        "mimeType": if mime.is_empty() { "application/octet-stream" } else { &mime },
        "totalBytes": size,
    })))
    .send()
    .await
    .map_err(|e| format!("upload init: {e}"))?;
    let init_value = init
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("upload init parse: {e}"))?;
    if init_value.get("code").and_then(|v| v.as_i64()) != Some(0) {
        return Ok(init_value);
    }
    let upload_id = init_value
        .pointer("/data/uploadId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "upload init omitted uploadId".to_string())?
        .to_string();
    let status_url = format!("{origin}/api/v1/uploads/resumable/{upload_id}");
    let status = auth(client.get(&status_url))
        .send()
        .await
        .map_err(|e| format!("upload status: {e}"))?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("upload status parse: {e}"))?;
    if status.get("code").and_then(|v| v.as_i64()) != Some(0) {
        return Ok(status);
    }
    let mut offset = status
        .pointer("/data/offset")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let chunk_size = status
        .pointer("/data/chunkSize")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(FALLBACK_CHUNK);
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|e| format!("seek upload source: {e}"))?;
    let cancel = CancellationToken::new();
    proxy
        .upload_cancels
        .lock()
        .expect("upload_cancels lock")
        .insert(client_message_id.to_string(), cancel.clone());
    let transfer = async {
        while offset < size {
            let wanted =
                usize::try_from((size - offset).min(chunk_size as u64)).unwrap_or(chunk_size);
            let mut chunk = vec![0_u8; wanted];
            file.read_exact(&mut chunk)
                .await
                .map_err(|e| format!("read upload source: {e}"))?;
            let end = offset + wanted as u64 - 1;
            let response = auth(
                client
                    .put(&status_url)
                    .header("content-type", "application/octet-stream")
                    .header("content-range", format!("bytes {offset}-{end}/{size}"))
                    .body(chunk),
            )
            .send()
            .await
            .map_err(|e| format!("upload chunk: {e}"))?
            .json::<serde_json::Value>()
            .await
            .map_err(|e| format!("upload chunk parse: {e}"))?;
            if response.get("code").and_then(|v| v.as_i64()) != Some(0) {
                return Ok(response);
            }
            offset = response
                .pointer("/data/offset")
                .and_then(|v| v.as_u64())
                .unwrap_or(end + 1);
            let _ = app.emit(
                "upload-progress",
                serde_json::json!({
                    "clientMessageId": client_message_id,
                    "loaded": offset,
                    "total": size,
                }),
            );
        }
        auth(
            client
                .post(format!("{status_url}/complete"))
                .json(&serde_json::json!({})),
        )
        .send()
        .await
        .map_err(|e| format!("upload complete: {e}"))?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("upload complete parse: {e}"))
    };
    let result = tokio::select! {
        value = transfer => value,
        _ = cancel.cancelled() => Err("upload cancelled".to_string()),
    };
    proxy
        .upload_cancels
        .lock()
        .expect("upload_cancels lock")
        .remove(client_message_id);
    result
}

/// Android's source adapter transfers ownership of a readable descriptor (system-picker content URI or
/// app-private recorder file) to Rust. Only metadata crosses JNI; Rust adopts the descriptor itself
/// instead of reopening `/proc/self/fd/<n>`, which Android document providers may reject with EACCES.
/// The resulting `File` owns the descriptor and closes it on every completion/cancellation/error path.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustUploadBridge_uploadFd(
    mut env: jni::JNIEnv,
    _receiver: jni::objects::JObject,
    fd: jni::sys::jint,
    upload_id: jni::objects::JString,
    attempt_id: jni::objects::JString,
    endpoint: jni::objects::JString,
    filename: jni::objects::JString,
    mime: jni::objects::JString,
    size: jni::sys::jlong,
    fields_json: jni::objects::JString,
    client_message_id: jni::objects::JString,
) {
    if fd < 0 {
        return;
    }
    // SAFETY: Kotlin calls ParcelFileDescriptor.detachFd() immediately before this JNI method and
    // transfers sole ownership to Rust. Construct the owner before spawning so every later return or
    // panic drops the descriptor exactly once.
    let file = unsafe { std::fs::File::from_raw_fd(fd) };
    let read = |env: &mut jni::JNIEnv, value: jni::objects::JString| {
        env.get_string(&value)
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let upload_id = read(&mut env, upload_id);
    let attempt_id = read(&mut env, attempt_id);
    let endpoint = read(&mut env, endpoint);
    let filename = read(&mut env, filename);
    let mime = read(&mut env, mime);
    let fields_json = read(&mut env, fields_json);
    let client_message_id = read(&mut env, client_message_id);
    let fields = serde_json::from_str::<std::collections::HashMap<String, String>>(&fields_json)
        .unwrap_or_default();
    let Some(app) = ANDROID_APP.get().cloned() else {
        return;
    };
    let proxy = app.state::<ProxyState>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let result = upload_stream_open_file_core(
            app.clone(),
            proxy,
            tokio::fs::File::from_std(file),
            endpoint,
            filename,
            mime,
            size.max(0) as u64,
            fields,
            Some(client_message_id),
        )
        .await;
        let payload = match result {
            Ok(response) => serde_json::json!({
                "uploadId": upload_id,
                "attemptId": attempt_id,
                "ok": true,
                "response": response,
            }),
            Err(message) => serde_json::json!({
                "uploadId": upload_id,
                "attemptId": attempt_id,
                "ok": false,
                "message": message,
            }),
        };
        let _ = app.emit("native-upload-result", payload);
    });
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_soms_client_RustUploadBridge_cancelUpload(
    mut env: jni::JNIEnv,
    _receiver: jni::objects::JObject,
    client_message_id: jni::objects::JString,
) {
    let Ok(client_message_id) = env.get_string(&client_message_id) else {
        return;
    };
    let Some(app) = ANDROID_APP.get() else {
        return;
    };
    cancel_upload(
        app.state::<ProxyState>(),
        client_message_id.to_string_lossy().into_owned(),
    );
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
    let proxy = app.state::<ProxyState>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let emit_phase = |phase: &str, error: Option<&str>| {
            let _ = app.emit(
                "native-voice-upload",
                serde_json::json!({
                    "contextId": context_id,
                    "threadId": thread_id,
                    "clientMessageId": client_message_id,
                    "durationMs": duration_ms,
                    "size": size,
                    "phase": phase,
                    "error": error,
                }),
            );
        };
        emit_phase("started", None);
        let origin = proxy.api_origin.lock().expect("origin lock").clone();
        let token = proxy.token.lock().ok().and_then(|value| value.clone());
        let stage_body = serde_json::json!({
            "threadId": thread_id,
            "contentType": "AUDIO",
            "clientMessageId": client_message_id,
            "meta": { "duration": duration_ms as f64 / 1000.0 },
        })
        .to_string();
        let mut stage = proxy
            .api_client(&origin)
            .post(format!("{origin}/api/v1/send-media"))
            .header("content-type", "application/json")
            .body(stage_body);
        if let Some(token) = token {
            stage = stage.header("authorization", format!("Bearer {token}"));
        }
        let stage_result = async {
            let response = stage.send().await.map_err(|e| format!("stage send: {e}"))?;
            let status = response.status();
            let text = response
                .text()
                .await
                .map_err(|e| format!("stage read: {e}"))?;
            if !status.is_success() {
                return Err(format!("stage HTTP {}: {text}", status.as_u16()));
            }
            let envelope: serde_json::Value =
                serde_json::from_str(&text).map_err(|e| format!("stage parse: {e}"))?;
            if envelope.get("code").and_then(|v| v.as_i64()) != Some(0) {
                return Err(format!("stage rejected: {text}"));
            }
            Ok(())
        }
        .await;
        let result = match stage_result {
            Ok(()) => {
                upload_stream_path_core(
                    app.clone(),
                    proxy,
                    path.clone(),
                    "/upload/audio".to_string(),
                    "voice.m4a".to_string(),
                    "audio/mp4".to_string(),
                    size.max(0) as u64,
                    std::collections::HashMap::new(),
                    Some(client_message_id.clone()),
                )
                .await
            }
            Err(error) => Err(error),
        };
        match result {
            Ok(response) if response.get("code").and_then(|v| v.as_i64()) == Some(0) => {
                emit_phase("completed", None)
            }
            Ok(response) => emit_phase("failed", Some(&format!("upload rejected: {response}"))),
            Err(error) => emit_phase("failed", Some(&error)),
        }
        let _ = fs::remove_file(path);
    });
}

/// Cancel one shell streaming upload. Idempotent: a task that already completed or has not reached the
/// streaming phase simply has no token. Browser cancellation remains owned by HttpClient unsubscribe.
#[tauri::command]
pub(crate) fn cancel_upload(proxy: tauri::State<'_, ProxyState>, client_message_id: String) {
    if let Some(token) = proxy
        .upload_cancels
        .lock()
        .expect("upload_cancels lock")
        .remove(&client_message_id)
    {
        token.cancel();
    }
}
