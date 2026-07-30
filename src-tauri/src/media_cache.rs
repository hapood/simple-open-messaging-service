use crate::ProxyState;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak};
use tauri::{Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

const CACHE_DIR: &str = "media";
const CHAT_THUMBNAIL_DIR: &str = "chat-thumbnails";
const CHAT_THUMBNAIL_LONG_EDGE: u32 = 960;
const CHAT_THUMBNAIL_MAX_SOURCE_EDGE: u32 = 16_384;
const CHAT_THUMBNAIL_MAX_DECODE_BYTES: u64 = 256 * 1024 * 1024;
const DEFAULT_CACHE_LIMIT_MB: u64 = 512;
const CACHE_LIMIT_FILENAME: &str = "media-cache-limit-mb";
const MIN_CACHE_LIMIT_MB: u64 = 128;
const MAX_CACHE_LIMIT_MB: u64 = 4096;
const CACHE_BLOCK_SIZE: u64 = 1024 * 1024;

type KeyLock = Arc<Mutex<()>>;
static KEY_LOCKS: OnceLock<Mutex<HashMap<String, Weak<Mutex<()>>>>> = OnceLock::new();
static CACHE_MAINTENANCE: OnceLock<RwLock<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheMeta {
    content_type: Option<String>,
    /** Total object size, not allocated bytes. */
    size: u64,
    /** Old metadata predates sparse ranges and represents a complete object. */
    #[serde(default = "default_complete")]
    complete: bool,
    #[serde(default)]
    ranges: Vec<CachedRange>,
    /** ETag (preferred) or Last-Modified. Prevents mixing ranges from different object versions. */
    #[serde(default)]
    validator: Option<String>,
    /** SHA-256 for each fully cached fixed-size block. Used to turn local corruption back into holes. */
    #[serde(default)]
    blocks: Vec<CachedBlock>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
struct CachedRange {
    /** Inclusive byte offset. */
    start: u64,
    /** Exclusive byte offset. */
    end: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct CachedBlock {
    index: u64,
    sha256: String,
}

fn default_complete() -> bool {
    true
}

pub(crate) struct CachedMedia {
    pub bytes: Vec<u8>,
    pub content_type: Option<String>,
}

pub(crate) struct CachedRangeResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub content_range: Option<String>,
    pub accept_ranges: Option<String>,
    pub bytes: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CachedMediaFile {
    path: String,
    content_type: Option<String>,
    size: u64,
}

#[derive(Clone)]
struct MediaDownloadObserver {
    app: tauri::AppHandle,
    task_id: String,
    cancel: CancellationToken,
}

impl MediaDownloadObserver {
    fn progress(&self, loaded: u64, total: u64) {
        let _ = self.app.emit(
            "media-download-progress",
            serde_json::json!({
                "taskId": self.task_id,
                "loaded": loaded,
                "total": total,
            }),
        );
    }

    fn cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaCacheInfo {
    limit_mb: u64,
    used_bytes: u64,
}

fn validate_path(path: &str) -> Result<(), String> {
    if !path.starts_with("/uploads/")
        || path.contains("..")
        || path.contains('\\')
        || path.contains('#')
    {
        return Err("only safe /uploads/* media paths are allowed".into());
    }
    Ok(())
}

fn valid_download_task_id(task_id: &str) -> bool {
    !task_id.is_empty()
        && task_id.len() <= 128
        && task_id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_'))
}

fn cache_key(origin: &str, credential: Option<&str>, path: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(origin.as_bytes());
    hash.update(b"\n");
    // Authorization is part of the namespace: a logout/login as another user must never expose bytes
    // cached by the previous session. Only the digest reaches the filename; the token is never persisted.
    hash.update(credential.unwrap_or("anonymous").as_bytes());
    hash.update(b"\n");
    hash.update(path.as_bytes());
    format!("{:x}", hash.finalize())
}

fn request_identity(proxy: &ProxyState, path: &str) -> (String, Option<String>, String) {
    let origin = proxy.api_origin.lock().expect("origin lock").clone();
    let token = proxy.token.lock().ok().and_then(|value| value.clone());
    let key = cache_key(&origin, token.as_deref(), path);
    (origin, token, key)
}

fn cache_paths(app: &tauri::AppHandle, key: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("resolve app cache: {e}"))?
        .join(CACHE_DIR);
    std::fs::create_dir_all(&root).map_err(|e| format!("create media cache: {e}"))?;
    Ok((
        root.join(format!("{key}.bin")),
        root.join(format!("{key}.json")),
    ))
}

fn thumbnail_path(app: &tauri::AppHandle, key: &str) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("resolve app cache: {e}"))?
        .join(CHAT_THUMBNAIL_DIR);
    std::fs::create_dir_all(&root).map_err(|e| format!("create thumbnail cache: {e}"))?;
    Ok(root.join(format!("{key}.webp")))
}

fn video_thumbnail_path(app: &tauri::AppHandle, key: &str) -> Result<PathBuf, String> {
    let (data_path, _) = cache_paths(app, key)?;
    Ok(data_path.with_extension("video.webp"))
}

pub(crate) async fn get_video_thumbnail(
    app: &tauri::AppHandle,
    proxy: &ProxyState,
    source_path: &str,
) -> Result<Vec<u8>, String> {
    validate_path(source_path)?;
    let (_, _, key) = request_identity(proxy, source_path);
    tokio::fs::read(video_thumbnail_path(app, &key)?)
        .await
        .map_err(|error| format!("read video thumbnail: {error}"))
}

/** Import the Android player's first rendered frame into the authenticated Rust cache namespace.
 * Decode is authoritative: a loopback caller cannot persist arbitrary bytes under an image URL. */
pub(crate) async fn put_video_thumbnail(
    app: &tauri::AppHandle,
    proxy: &ProxyState,
    source_path: &str,
    bytes: Vec<u8>,
) -> Result<(), String> {
    validate_path(source_path)?;
    if bytes.is_empty() || bytes.len() > 512 * 1024 {
        return Err("video thumbnail must be between 1 byte and 512 KiB".into());
    }
    let (_, _, key) = request_identity(proxy, source_path);
    let output = video_thumbnail_path(app, &key)?;
    let temporary = output.with_extension("video.webp.tmp");
    let verified = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let image = image::load_from_memory(&bytes)
            .map_err(|error| format!("decode video thumbnail: {error}"))?;
        if image.width() > 512 || image.height() > 512 {
            return Err("video thumbnail dimensions exceed 512px".into());
        }
        let mut encoded = Vec::new();
        image
            .write_to(
                &mut std::io::Cursor::new(&mut encoded),
                image::ImageOutputFormat::WebP,
            )
            .map_err(|error| format!("encode video thumbnail: {error}"))?;
        Ok(encoded)
    })
    .await
    .map_err(|error| format!("join video-thumbnail worker: {error}"))??;
    tokio::fs::write(&temporary, verified)
        .await
        .map_err(|error| format!("write video thumbnail: {error}"))?;
    tokio::fs::rename(&temporary, &output)
        .await
        .map_err(|error| format!("commit video thumbnail: {error}"))?;
    if let Some(root) = output.parent() {
        prune_cache(app, root, &key).await;
    }
    Ok(())
}

/** Generate at most one 960px WebP per authenticated media-cache identity. Image decode/resize is CPU
 * work, so keep it off Tokio workers. Atomic rename prevents a racing URI request from seeing a partial
 * image. Sources already within the target box are still re-encoded: the alternate URL has one stable
 * WebP content type and never aliases the original cache file. */
async fn ensure_chat_thumbnail(
    app: &tauri::AppHandle,
    proxy: &ProxyState,
    source_path: &str,
    source_bytes: Vec<u8>,
) -> Result<Vec<u8>, String> {
    validate_path(source_path)?;
    let (_, _, key) = request_identity(proxy, source_path);
    let output = thumbnail_path(app, &key)?;
    if let Ok(bytes) = tokio::fs::read(&output).await {
        return Ok(bytes);
    }
    let lock = key_lock(&format!("thumbnail:{key}")).await;
    let _guard = lock.lock().await;
    if let Ok(bytes) = tokio::fs::read(&output).await {
        return Ok(bytes);
    }
    let temporary = output.with_extension("webp.tmp");
    let output_for_worker = output.clone();
    let temporary_for_worker = temporary.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let mut limits = image::io::Limits::default();
        limits.max_image_width = Some(CHAT_THUMBNAIL_MAX_SOURCE_EDGE);
        limits.max_image_height = Some(CHAT_THUMBNAIL_MAX_SOURCE_EDGE);
        limits.max_alloc = Some(CHAT_THUMBNAIL_MAX_DECODE_BYTES);
        let mut reader = image::io::Reader::new(std::io::Cursor::new(source_bytes))
            .with_guessed_format()
            .map_err(|error| format!("identify thumbnail source: {error}"))?;
        reader.limits(limits);
        let decoded = reader
            .decode()
            .map_err(|error| format!("decode thumbnail source: {error}"))?;
        let resized = if decoded.width() > CHAT_THUMBNAIL_LONG_EDGE
            || decoded.height() > CHAT_THUMBNAIL_LONG_EDGE
        {
            decoded.resize(
                CHAT_THUMBNAIL_LONG_EDGE,
                CHAT_THUMBNAIL_LONG_EDGE,
                image::imageops::FilterType::Triangle,
            )
        } else {
            decoded
        };
        let mut bytes = Vec::new();
        resized
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageOutputFormat::WebP,
            )
            .map_err(|error| format!("encode thumbnail: {error}"))?;
        std::fs::write(&temporary_for_worker, &bytes)
            .map_err(|error| format!("write thumbnail: {error}"))?;
        std::fs::rename(&temporary_for_worker, &output_for_worker)
            .map_err(|error| format!("commit thumbnail: {error}"))?;
        Ok(bytes)
    })
    .await
    .map_err(|error| format!("join thumbnail worker: {error}"))?
}

pub(crate) async fn get_or_create_chat_thumbnail(
    app: &tauri::AppHandle,
    proxy: &ProxyState,
    source_path: &str,
) -> Result<Vec<u8>, String> {
    validate_path(source_path)?;
    let (_, _, key) = request_identity(proxy, source_path);
    if let Ok(bytes) = tokio::fs::read(thumbnail_path(app, &key)?).await {
        return Ok(bytes);
    }
    let original = get_or_fetch(app, proxy, source_path).await?;
    ensure_chat_thumbnail(app, proxy, source_path, original.bytes).await
}

pub(crate) async fn read_chat_thumbnail(
    app: &tauri::AppHandle,
    proxy: &ProxyState,
    source_path: &str,
) -> Option<Vec<u8>> {
    validate_path(source_path).ok()?;
    let (_, _, key) = request_identity(proxy, source_path);
    tokio::fs::read(thumbnail_path(app, &key).ok()?).await.ok()
}

/** Best-effort post-original warm-up. The URI response must not wait for this: a later thumbnail request
 * either hits the completed file or joins the same per-thumbnail lock in ensure_chat_thumbnail. */
pub(crate) fn warm_chat_thumbnail(app: tauri::AppHandle, proxy: ProxyState, source_path: String) {
    tauri::async_runtime::spawn(async move {
        match get_or_create_chat_thumbnail(&app, &proxy, &source_path).await {
            Ok(_) => {
                let _ = app.emit(
                    "chat-thumbnail-ready",
                    serde_json::json!({ "sourcePath": source_path }),
                );
            }
            Err(error) => {
                log::debug!("chat thumbnail warm-up skipped for {source_path}: {error}");
            }
        }
    });
}

async fn key_lock(key: &str) -> KeyLock {
    let locks = KEY_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = locks.lock().await;
    // Weak entries preserve single-flight while a request is active without growing this process-wide
    // table forever as users encounter new media over months of uptime.
    guard.retain(|_, value| value.strong_count() > 0);
    if let Some(lock) = guard.get(key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    guard.insert(key.to_string(), Arc::downgrade(&lock));
    lock
}

async fn read_cached(
    data_path: &Path,
    meta_path: &Path,
    expected: Option<&str>,
    load_bytes: bool,
) -> Option<CachedMedia> {
    let encoded = tokio::fs::read(meta_path).await.ok()?;
    let mut meta: CacheMeta = serde_json::from_slice(&encoded).ok()?;
    if !meta.complete {
        return None;
    }
    let file_size = tokio::fs::metadata(data_path).await.ok()?.len();
    if file_size != meta.size {
        return None;
    }
    let whole = CachedRange {
        start: 0,
        end: meta.size,
    };
    if meta.blocks.is_empty() {
        if !verify_complete_digest(data_path, expected).await.ok()? {
            meta.complete = false;
            meta.ranges.clear();
            let _ = write_meta(meta_path, &meta).await;
            return None;
        }
        meta.blocks = block_hashes_for_file(data_path, meta.size).await.ok()?;
    } else if invalidate_corrupt_blocks(data_path, &mut meta, whole)
        .await
        .ok()?
    {
        let _ = write_meta(meta_path, &meta).await;
        return None;
    }
    // Metadata mtime is the LRU clock. Rewriting the tiny sidecar avoids touching or reopening the
    // potentially large data file and works consistently on desktop and Android filesystems.
    let _ = tokio::fs::write(meta_path, encoded).await;
    Some(CachedMedia {
        bytes: if load_bytes {
            tokio::fs::read(data_path).await.ok()?
        } else {
            Vec::new()
        },
        content_type: meta.content_type,
    })
}

async fn read_meta(meta_path: &Path) -> Option<CacheMeta> {
    serde_json::from_slice(&tokio::fs::read(meta_path).await.ok()?).ok()
}

async fn write_meta(meta_path: &Path, meta: &CacheMeta) -> Result<(), String> {
    let encoded = serde_json::to_vec(meta).map_err(|e| format!("encode cache metadata: {e}"))?;
    let temporary = meta_path.with_extension("json.tmp");
    tokio::fs::write(&temporary, encoded)
        .await
        .map_err(|e| format!("write cache metadata: {e}"))?;
    if cfg!(windows) {
        let _ = tokio::fs::remove_file(meta_path).await;
    }
    tokio::fs::rename(&temporary, meta_path)
        .await
        .map_err(|e| format!("commit cache metadata: {e}"))
}

fn parse_content_range(value: &str) -> Option<(u64, u64, u64)> {
    let value = value.strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, end_inclusive) = range.split_once('-')?;
    let start = start.parse::<u64>().ok()?;
    let end = end_inclusive.parse::<u64>().ok()?.checked_add(1)?;
    let total = total.parse::<u64>().ok()?;
    (start < end && end <= total).then_some((start, end, total))
}

fn requested_range(value: &str, total: u64) -> Option<CachedRange> {
    let value = value.strip_prefix("bytes=")?;
    if value.contains(',') || total == 0 {
        return None;
    }
    let (start, end) = value.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?.min(total);
        return (suffix > 0).then_some(CachedRange {
            start: total - suffix,
            end: total,
        });
    }
    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() {
        total
    } else {
        end.parse::<u64>().ok()?.checked_add(1)?.min(total)
    };
    (start < end && start < total).then_some(CachedRange { start, end })
}

fn merge_range(ranges: &mut Vec<CachedRange>, added: CachedRange) {
    ranges.push(added);
    ranges.sort_by_key(|range| range.start);
    let mut merged: Vec<CachedRange> = Vec::with_capacity(ranges.len());
    for range in ranges.drain(..) {
        if let Some(last) = merged.last_mut() {
            if range.start <= last.end {
                last.end = last.end.max(range.end);
                continue;
            }
        }
        merged.push(range);
    }
    *ranges = merged;
}

fn range_is_cached(meta: &CacheMeta, range: CachedRange) -> bool {
    meta.complete
        || meta
            .ranges
            .iter()
            .any(|cached| cached.start <= range.start && cached.end >= range.end)
}

fn missing_ranges(meta: &CacheMeta) -> Vec<CachedRange> {
    if meta.complete {
        return Vec::new();
    }
    let mut cursor = 0u64;
    let mut missing = Vec::new();
    for range in &meta.ranges {
        if range.start > cursor {
            missing.push(CachedRange {
                start: cursor,
                end: range.start,
            });
        }
        cursor = cursor.max(range.end);
    }
    if cursor < meta.size {
        missing.push(CachedRange {
            start: cursor,
            end: meta.size,
        });
    }
    missing
}

fn intersecting_missing_ranges(meta: &CacheMeta, requested: CachedRange) -> Vec<CachedRange> {
    missing_ranges(meta)
        .into_iter()
        .filter_map(|missing| {
            let start = missing.start.max(requested.start);
            let end = missing.end.min(requested.end);
            (start < end).then_some(CachedRange { start, end })
        })
        .collect()
}

fn remove_range(ranges: &mut Vec<CachedRange>, removed: CachedRange) {
    let mut kept = Vec::new();
    for range in ranges.drain(..) {
        if range.end <= removed.start || range.start >= removed.end {
            kept.push(range);
            continue;
        }
        if range.start < removed.start {
            kept.push(CachedRange {
                start: range.start,
                end: removed.start,
            });
        }
        if range.end > removed.end {
            kept.push(CachedRange {
                start: removed.end,
                end: range.end,
            });
        }
    }
    *ranges = kept;
}

fn block_range(index: u64, total: u64) -> CachedRange {
    let start = index.saturating_mul(CACHE_BLOCK_SIZE);
    CachedRange {
        start,
        end: start.saturating_add(CACHE_BLOCK_SIZE).min(total),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn expected_digest(path: &str) -> Option<&str> {
    let name = path.split('?').next()?.rsplit('/').next()?;
    let digest = name.split('.').next()?;
    (digest.len() == 64
        && digest
            .bytes()
            .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase()))
    .then_some(digest)
}

async fn read_file_range(path: &Path, range: CachedRange) -> Result<Vec<u8>, String> {
    let len = usize::try_from(range.end - range.start)
        .map_err(|_| "requested media range is too large".to_string())?;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("open cached media: {e}"))?;
    file.seek(std::io::SeekFrom::Start(range.start))
        .await
        .map_err(|e| format!("seek cached media: {e}"))?;
    let mut bytes = vec![0u8; len];
    file.read_exact(&mut bytes)
        .await
        .map_err(|e| format!("read cached media range: {e}"))?;
    Ok(bytes)
}

async fn hash_file_range(path: &Path, range: CachedRange) -> Result<String, String> {
    Ok(sha256_hex(&read_file_range(path, range).await?))
}

async fn refresh_block_hashes(
    path: &Path,
    meta: &mut CacheMeta,
    touched: CachedRange,
) -> Result<(), String> {
    if meta.size == 0 {
        return Ok(());
    }
    let first = touched.start / CACHE_BLOCK_SIZE;
    let last = (touched.end.saturating_sub(1)) / CACHE_BLOCK_SIZE;
    for index in first..=last {
        let range = block_range(index, meta.size);
        meta.blocks.retain(|block| block.index != index);
        if range_is_cached(meta, range) {
            meta.blocks.push(CachedBlock {
                index,
                sha256: hash_file_range(path, range).await?,
            });
        }
    }
    meta.blocks.sort_by_key(|block| block.index);
    Ok(())
}

/** Verify cached blocks touched by a read. Bad blocks are removed from coverage and become holes. */
async fn invalidate_corrupt_blocks(
    path: &Path,
    meta: &mut CacheMeta,
    requested: CachedRange,
) -> Result<bool, String> {
    let candidates: Vec<CachedBlock> = meta
        .blocks
        .iter()
        .filter(|block| {
            let range = block_range(block.index, meta.size);
            range.start < requested.end && range.end > requested.start
        })
        .cloned()
        .collect();
    let mut changed = false;
    for block in candidates {
        let range = block_range(block.index, meta.size);
        if hash_file_range(path, range).await? != block.sha256 {
            if meta.complete {
                meta.ranges = vec![CachedRange {
                    start: 0,
                    end: meta.size,
                }];
            }
            remove_range(&mut meta.ranges, range);
            meta.blocks.retain(|item| item.index != block.index);
            meta.complete = false;
            changed = true;
        }
    }
    Ok(changed)
}

async fn verify_complete_digest(path: &Path, expected: Option<&str>) -> Result<bool, String> {
    let Some(expected) = expected else {
        return Ok(true);
    };
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| format!("read media for digest verification: {e}"))?;
    Ok(sha256_hex(&bytes) == expected)
}

fn block_hashes_for_bytes(bytes: &[u8]) -> Vec<CachedBlock> {
    bytes
        .chunks(CACHE_BLOCK_SIZE as usize)
        .enumerate()
        .map(|(index, chunk)| CachedBlock {
            index: index as u64,
            sha256: sha256_hex(chunk),
        })
        .collect()
}

async fn block_hashes_for_file(path: &Path, size: u64) -> Result<Vec<CachedBlock>, String> {
    if size == 0 {
        return Ok(Vec::new());
    }
    let last = (size - 1) / CACHE_BLOCK_SIZE;
    let mut blocks = Vec::with_capacity((last + 1) as usize);
    for index in 0..=last {
        blocks.push(CachedBlock {
            index,
            sha256: hash_file_range(path, block_range(index, size)).await?,
        });
    }
    Ok(blocks)
}

async fn write_file_range(
    path: &Path,
    range: CachedRange,
    total: u64,
    bytes: &[u8],
) -> Result<(), String> {
    if bytes.len() as u64 != range.end - range.start {
        return Err("upstream Content-Range length did not match body".into());
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(path)
        .await
        .map_err(|e| format!("open sparse media cache: {e}"))?;
    file.set_len(total)
        .await
        .map_err(|e| format!("size sparse media cache: {e}"))?;
    file.seek(std::io::SeekFrom::Start(range.start))
        .await
        .map_err(|e| format!("seek sparse media cache: {e}"))?;
    file.write_all(bytes)
        .await
        .map_err(|e| format!("write sparse media cache: {e}"))?;
    file.flush()
        .await
        .map_err(|e| format!("flush sparse media cache: {e}"))
}

async fn stream_response_range(
    response: reqwest::Response,
    path: &Path,
    range: CachedRange,
    total: u64,
    observer: Option<&MediaDownloadObserver>,
    already_cached: u64,
) -> Result<(), String> {
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(path)
        .await
        .map_err(|e| format!("open sparse media cache: {e}"))?;
    file.set_len(total)
        .await
        .map_err(|e| format!("size sparse media cache: {e}"))?;
    file.seek(std::io::SeekFrom::Start(range.start))
        .await
        .map_err(|e| format!("seek sparse media cache: {e}"))?;
    let mut received = 0u64;
    let mut last_reported = already_cached;
    let mut stream = response.bytes_stream();
    loop {
        let next = if let Some(observer) = observer {
            tokio::select! {
                value = stream.next() => value,
                _ = observer.cancel.cancelled() => return Err("media download cancelled".into()),
            }
        } else {
            stream.next().await
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|e| format!("read missing media range: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("write missing media range: {e}"))?;
        received = received.saturating_add(chunk.len() as u64);
        if let Some(observer) = observer {
            let loaded = already_cached.saturating_add(received).min(total);
            if loaded.saturating_sub(last_reported) >= 64 * 1024 || loaded >= total {
                observer.progress(loaded, total);
                last_reported = loaded;
            }
        }
    }
    if received != range.end - range.start {
        return Err(format!(
            "missing media range body length mismatch: expected {}, got {received}",
            range.end - range.start
        ));
    }
    file.flush()
        .await
        .map_err(|e| format!("flush missing media range: {e}"))
}

/** Serve one player Range request while recording the returned bytes in a sparse native cache file. */
pub(crate) async fn get_or_fetch_range(
    app: &tauri::AppHandle,
    proxy: &ProxyState,
    path: &str,
    range_header: &str,
) -> Result<CachedRangeResponse, String> {
    validate_path(path)?;
    let maintenance = CACHE_MAINTENANCE.get_or_init(|| RwLock::new(()));
    let _maintenance_guard = maintenance.read().await;
    let (origin, token, key) = request_identity(proxy, path);
    let (data_path, meta_path) = cache_paths(app, &key)?;
    let lock = key_lock(&key).await;
    let _guard = lock.lock().await;

    if let Some(mut meta) = read_meta(&meta_path).await {
        if let Some(range) = requested_range(range_header, meta.size) {
            if meta.complete && meta.blocks.is_empty() {
                if !verify_complete_digest(&data_path, expected_digest(path)).await? {
                    meta.complete = false;
                    meta.ranges.clear();
                } else {
                    meta.blocks = block_hashes_for_file(&data_path, meta.size).await?;
                }
                write_meta(&meta_path, &meta).await?;
            }
            if invalidate_corrupt_blocks(&data_path, &mut meta, range).await? {
                write_meta(&meta_path, &meta).await?;
            }
            if range_is_cached(&meta, range) {
                let bytes = read_file_range(&data_path, range).await?;
                let _ = write_meta(&meta_path, &meta).await;
                return Ok(CachedRangeResponse {
                    status: 206,
                    content_type: meta.content_type,
                    content_range: Some(format!(
                        "bytes {}-{}/{}",
                        range.start,
                        range.end - 1,
                        meta.size
                    )),
                    accept_ranges: Some("bytes".into()),
                    bytes,
                });
            }

            // A player commonly asks for a range that overlaps its preceding request. Reuse the
            // cached prefix/suffix and fetch only the holes, then assemble the exact requested range.
            // If the origin changes version or violates Range semantics, discard the sparse entry and
            // fall through to the authoritative whole-request path below.
            if meta.validator.is_some() || expected_digest(path).is_some() {
                let mut filled = true;
                for missing in intersecting_missing_ranges(&meta, range) {
                    let target = format!("{origin}{path}");
                    let mut request = proxy.api_client(&origin).get(target).header(
                        reqwest::header::RANGE,
                        format!("bytes={}-{}", missing.start, missing.end - 1),
                    );
                    if let Some(validator) = meta.validator.as_deref() {
                        request = request.header(reqwest::header::IF_RANGE, validator);
                    }
                    if let Some(token) = token.as_ref() {
                        request = request.header("authorization", format!("Bearer {token}"));
                    }
                    let response = match request.send().await {
                        Ok(response) => response,
                        Err(error) => {
                            if crate::is_network_failure(&error) {
                                crate::runtime_switch(proxy).await;
                            }
                            return Err(format!("fill playback media range: {error}"));
                        }
                    };
                    let returned = response
                        .headers()
                        .get(reqwest::header::CONTENT_RANGE)
                        .and_then(|value| value.to_str().ok())
                        .and_then(parse_content_range);
                    if response.status().as_u16() != 206
                        || returned != Some((missing.start, missing.end, meta.size))
                    {
                        filled = false;
                        break;
                    }
                    stream_response_range(response, &data_path, missing, meta.size, None, 0)
                        .await?;
                    merge_range(&mut meta.ranges, missing);
                    refresh_block_hashes(&data_path, &mut meta, missing).await?;
                    write_meta(&meta_path, &meta).await?;
                }
                if filled && range_is_cached(&meta, range) {
                    let bytes = read_file_range(&data_path, range).await?;
                    return Ok(CachedRangeResponse {
                        status: 206,
                        content_type: meta.content_type,
                        content_range: Some(format!(
                            "bytes {}-{}/{}",
                            range.start,
                            range.end - 1,
                            meta.size
                        )),
                        accept_ranges: Some("bytes".into()),
                        bytes,
                    });
                }
                let _ = tokio::fs::remove_file(&data_path).await;
                let _ = tokio::fs::remove_file(&meta_path).await;
            }
        }
    }

    let target = format!("{origin}{path}");
    let mut request = proxy
        .api_client(&origin)
        .get(target)
        .header(reqwest::header::RANGE, range_header);
    if let Some(validator) = read_meta(&meta_path).await.and_then(|meta| meta.validator) {
        request = request.header(reqwest::header::IF_RANGE, validator);
    }
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            if crate::is_network_failure(&error) {
                crate::runtime_switch(proxy).await;
            }
            return Err(format!("media range request failed: {error}"));
        }
    };
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let validator = response
        .headers()
        .get(reqwest::header::ETAG)
        .or_else(|| response.headers().get(reqwest::header::LAST_MODIFIED))
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let content_range = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let accept_ranges = response
        .headers()
        .get(reqwest::header::ACCEPT_RANGES)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("read media range: {e}"))?
        .to_vec();
    if status == 206 {
        if let Some((start, end, total)) = content_range.as_deref().and_then(parse_content_range) {
            let range = CachedRange { start, end };
            let existing = read_meta(&meta_path).await;
            let validator_matches = existing
                .as_ref()
                .map(|meta| {
                    meta.size == total
                        && (meta.validator.is_none()
                            || validator.is_none()
                            || meta.validator == validator)
                })
                .unwrap_or(false);
            if !validator_matches {
                let _ = tokio::fs::remove_file(&data_path).await;
                let _ = tokio::fs::remove_file(&meta_path).await;
            }
            let mut meta = existing.filter(|_| validator_matches).unwrap_or(CacheMeta {
                content_type: content_type.clone(),
                size: total,
                complete: false,
                ranges: Vec::new(),
                validator: validator.clone(),
                blocks: Vec::new(),
            });
            if meta.complete {
                // A complete cache should have served above. A malformed request that could not be
                // parsed is returned but must not downgrade the complete entry.
            } else {
                write_file_range(&data_path, range, total, &bytes).await?;
                merge_range(&mut meta.ranges, range);
                refresh_block_hashes(&data_path, &mut meta, range).await?;
                meta.complete = meta.ranges.len() == 1
                    && meta.ranges[0].start == 0
                    && meta.ranges[0].end == total;
                meta.content_type = content_type.clone().or(meta.content_type);
                meta.validator = validator.clone().or(meta.validator);
                write_meta(&meta_path, &meta).await?;
            }
        }
    } else if status == 200 {
        // Upstream ignored Range or If-Range detected a newer object. The body is authoritative and
        // complete, so replace every old sparse segment atomically.
        if expected_digest(path).is_some_and(|expected| sha256_hex(&bytes) != expected) {
            return Err("media SHA-256 did not match its content-addressed URL".into());
        }
        let blocks = block_hashes_for_bytes(&bytes);
        let temporary = data_path.with_extension("part");
        tokio::fs::write(&temporary, &bytes)
            .await
            .map_err(|e| format!("write complete media replacement: {e}"))?;
        let _ = tokio::fs::remove_file(&data_path).await;
        tokio::fs::rename(&temporary, &data_path)
            .await
            .map_err(|e| format!("commit complete media replacement: {e}"))?;
        write_meta(
            &meta_path,
            &CacheMeta {
                content_type: content_type.clone(),
                size: bytes.len() as u64,
                complete: true,
                ranges: Vec::new(),
                validator,
                blocks,
            },
        )
        .await?;
    }
    if data_path.is_file() {
        if let Some(root) = data_path.parent() {
            prune_cache(app, root, &key).await;
        }
    }

    Ok(CachedRangeResponse {
        status,
        content_type,
        content_range,
        accept_ranges,
        bytes,
    })
}

pub(crate) async fn get_or_fetch(
    app: &tauri::AppHandle,
    proxy: &ProxyState,
    path: &str,
) -> Result<CachedMedia, String> {
    get_or_fetch_inner(app, proxy, path, true, None).await
}

async fn ensure_cached_file(
    app: &tauri::AppHandle,
    proxy: &ProxyState,
    path: &str,
) -> Result<CachedMedia, String> {
    get_or_fetch_inner(app, proxy, path, false, None).await
}

async fn get_or_fetch_inner(
    app: &tauri::AppHandle,
    proxy: &ProxyState,
    path: &str,
    load_bytes: bool,
    observer: Option<&MediaDownloadObserver>,
) -> Result<CachedMedia, String> {
    let maintenance = CACHE_MAINTENANCE.get_or_init(|| RwLock::new(()));
    let _maintenance_guard = maintenance.read().await;
    validate_path(path)?;
    let (origin, token, key) = request_identity(proxy, path);
    let (data_path, meta_path) = cache_paths(app, &key)?;
    let lock = key_lock(&key).await;
    let _guard = lock.lock().await;

    if let Some(cached) =
        read_cached(&data_path, &meta_path, expected_digest(path), load_bytes).await
    {
        if let Some(observer) = observer {
            let size = tokio::fs::metadata(&data_path)
                .await
                .map(|value| value.len())
                .unwrap_or(0);
            observer.progress(size, size);
        }
        return Ok(cached);
    }
    if let Some(mut meta) = read_meta(&meta_path)
        .await
        .filter(|meta| !meta.complete && meta.size > 0 && data_path.is_file())
    {
        // Playback already populated some sparse ranges. Fetch only the holes, so "watch half, then
        // save" transfers approximately one complete file in total instead of half + a second full GET.
        let mut restart_full = false;
        let mut cached_bytes: u64 = meta
            .ranges
            .iter()
            .map(|range| range.end.saturating_sub(range.start))
            .sum();
        for missing in missing_ranges(&meta) {
            if observer.is_some_and(MediaDownloadObserver::cancelled) {
                return Err("media download cancelled".into());
            }
            let target = format!("{origin}{path}");
            let mut request = proxy.api_client(&origin).get(target).header(
                reqwest::header::RANGE,
                format!("bytes={}-{}", missing.start, missing.end - 1),
            );
            if let Some(validator) = meta.validator.as_ref() {
                request = request.header(reqwest::header::IF_RANGE, validator);
            }
            if let Some(token) = token.as_ref() {
                request = request.header("authorization", format!("Bearer {token}"));
            }
            let response_result = if let Some(observer) = observer {
                tokio::select! {
                    value = request.send() => value,
                    _ = observer.cancel.cancelled() => return Err("media download cancelled".into()),
                }
            } else {
                request.send().await
            };
            let response = match response_result {
                Ok(response) => response,
                Err(error) => {
                    if crate::is_network_failure(&error) {
                        crate::runtime_switch(proxy).await;
                    }
                    return Err(format!("fill media cache range: {error}"));
                }
            };
            if response.status().as_u16() != 206 {
                // If-Range returns 200 when the object changed. Drop the mixed sparse entry and restart
                // as one authoritative full download instead of combining two versions.
                restart_full = true;
                break;
            }
            let returned = response
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .and_then(parse_content_range);
            if returned != Some((missing.start, missing.end, meta.size)) {
                restart_full = true;
                break;
            }
            stream_response_range(
                response,
                &data_path,
                missing,
                meta.size,
                observer,
                cached_bytes,
            )
            .await?;
            cached_bytes = cached_bytes.saturating_add(missing.end - missing.start);
            merge_range(&mut meta.ranges, missing);
            refresh_block_hashes(&data_path, &mut meta, missing).await?;
            write_meta(&meta_path, &meta).await?;
        }
        meta.complete = !restart_full && missing_ranges(&meta).is_empty();
        if meta.complete {
            if !verify_complete_digest(&data_path, expected_digest(path)).await? {
                restart_full = true;
                meta.complete = false;
            }
        }
        if meta.complete {
            write_meta(&meta_path, &meta).await?;
            let bytes = if load_bytes {
                tokio::fs::read(&data_path)
                    .await
                    .map_err(|e| format!("read completed media cache: {e}"))?
            } else {
                Vec::new()
            };
            return Ok(CachedMedia {
                bytes,
                content_type: meta.content_type,
            });
        }
        if restart_full {
            let _ = tokio::fs::remove_file(&data_path).await;
            let _ = tokio::fs::remove_file(&meta_path).await;
        }
    }
    // A crash may leave only one side of the data+metadata pair. Remove both before rebuilding so
    // Windows' non-overwriting rename semantics cannot strand the entry permanently.
    let _ = tokio::fs::remove_file(&data_path).await;
    let _ = tokio::fs::remove_file(&meta_path).await;

    let target = format!("{origin}{path}");
    let mut request = proxy.api_client(&origin).get(target);
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response_result = if let Some(observer) = observer {
        tokio::select! {
            value = request.send() => value,
            _ = observer.cancel.cancelled() => return Err("media download cancelled".into()),
        }
    } else {
        request.send().await
    };
    let response = match response_result {
        Ok(response) => response,
        Err(error) => {
            if crate::is_network_failure(&error) {
                crate::runtime_switch(proxy).await;
            }
            return Err(format!("media request failed: {error}"));
        }
    };
    if !response.status().is_success() {
        return Err(format!("media HTTP {}", response.status()));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let validator = response
        .headers()
        .get(reqwest::header::ETAG)
        .or_else(|| response.headers().get(reqwest::header::LAST_MODIFIED))
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let total = response.content_length().unwrap_or(0);

    let part_path = data_path.with_extension("part");
    let mut file = tokio::fs::File::create(&part_path)
        .await
        .map_err(|e| format!("create cache part: {e}"))?;
    let mut bytes = Vec::new();
    let mut digest = Sha256::new();
    let mut received = 0u64;
    let mut last_reported = 0u64;
    let mut stream = response.bytes_stream();
    loop {
        let next = if let Some(observer) = observer {
            tokio::select! {
                value = stream.next() => value,
                _ = observer.cancel.cancelled() => {
                    drop(file);
                    let _ = tokio::fs::remove_file(&part_path).await;
                    return Err("media download cancelled".into());
                },
            }
        } else {
            stream.next().await
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|e| format!("read media body: {e}"))?;
        digest.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("write media cache: {e}"))?;
        received = received.saturating_add(chunk.len() as u64);
        if load_bytes {
            bytes.extend_from_slice(&chunk);
        }
        if let Some(observer) = observer {
            if received.saturating_sub(last_reported) >= 64 * 1024
                || (total > 0 && received >= total)
            {
                observer.progress(received, total);
                last_reported = received;
            }
        }
    }
    if let Some(observer) = observer {
        observer.progress(received, if total > 0 { total } else { received });
    }
    file.flush()
        .await
        .map_err(|e| format!("flush media cache: {e}"))?;
    drop(file);
    let actual_digest = format!("{:x}", digest.finalize());
    if expected_digest(path).is_some_and(|expected| actual_digest != expected) {
        let _ = tokio::fs::remove_file(&part_path).await;
        return Err("media SHA-256 did not match its content-addressed URL".into());
    }
    tokio::fs::rename(&part_path, &data_path)
        .await
        .map_err(|e| format!("commit media cache: {e}"))?;

    let size = tokio::fs::metadata(&data_path)
        .await
        .map_err(|e| format!("stat media cache: {e}"))?
        .len();
    let meta = CacheMeta {
        content_type: content_type.clone(),
        size,
        complete: true,
        ranges: Vec::new(),
        validator,
        blocks: block_hashes_for_file(&data_path, size).await?,
    };
    let encoded = serde_json::to_vec(&meta).map_err(|e| format!("encode cache metadata: {e}"))?;
    tokio::fs::write(&meta_path, encoded)
        .await
        .map_err(|e| format!("write cache metadata: {e}"))?;
    prune_cache(
        app,
        data_path
            .parent()
            .ok_or_else(|| "media cache has no parent directory".to_string())?,
        &key,
    )
    .await;

    Ok(CachedMedia {
        bytes,
        content_type,
    })
}

async fn prune_cache(app: &tauri::AppHandle, root: &Path, protected_key: &str) {
    let Ok(mut entries) = tokio::fs::read_dir(root).await else {
        return;
    };
    let mut total = 0u64;
    let mut candidates = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("bin") {
            continue;
        }
        let Ok(metadata) = entry.metadata().await else {
            continue;
        };
        let key = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let meta_path = root.join(format!("{key}.json"));
        let size = read_meta(&meta_path)
            .await
            .map(|meta| {
                if meta.complete {
                    meta.size
                } else {
                    meta.ranges
                        .iter()
                        .map(|range| range.end.saturating_sub(range.start))
                        .sum()
                }
            })
            .unwrap_or_else(|| metadata.len());
        let thumbnail_size = tokio::fs::metadata(root.join(format!("{key}.video.webp")))
            .await
            .map(|value| value.len())
            .unwrap_or(0);
        let size = size.saturating_add(thumbnail_size);
        total = total.saturating_add(size);
        if key != protected_key {
            let touched = tokio::fs::metadata(&meta_path)
                .await
                .ok()
                .and_then(|value| value.modified().ok())
                .unwrap_or(std::time::UNIX_EPOCH);
            candidates.push((touched, size, key.to_string()));
        }
    }
    let max_cache_bytes = cache_limit_mb(app).saturating_mul(1024 * 1024);
    if total <= max_cache_bytes {
        return;
    }
    candidates.sort_by_key(|entry| entry.0);
    for (_, size, key) in candidates {
        let _ = tokio::fs::remove_file(root.join(format!("{key}.bin"))).await;
        let _ = tokio::fs::remove_file(root.join(format!("{key}.json"))).await;
        let _ = tokio::fs::remove_file(root.join(format!("{key}.video.webp"))).await;
        total = total.saturating_sub(size);
        if total <= max_cache_bytes {
            break;
        }
    }
}

fn cache_limit_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data: {e}"))?
        .join(CACHE_LIMIT_FILENAME))
}

fn cache_limit_mb(app: &tauri::AppHandle) -> u64 {
    cache_limit_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| (MIN_CACHE_LIMIT_MB..=MAX_CACHE_LIMIT_MB).contains(value))
        .unwrap_or(DEFAULT_CACHE_LIMIT_MB)
}

async fn cache_used_bytes(app: &tauri::AppHandle) -> u64 {
    let Ok(root) = app.path().app_cache_dir().map(|path| path.join(CACHE_DIR)) else {
        return 0;
    };
    let Ok(mut entries) = tokio::fs::read_dir(&root).await else {
        return 0;
    };
    let mut total = 0u64;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("bin") {
            continue;
        }
        let key = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let size = match read_meta(&root.join(format!("{key}.json"))).await {
            Some(meta) if meta.complete => meta.size,
            Some(meta) => meta
                .ranges
                .iter()
                .map(|range| range.end.saturating_sub(range.start))
                .sum(),
            None => entry.metadata().await.map(|meta| meta.len()).unwrap_or(0),
        };
        let thumbnail_size = tokio::fs::metadata(root.join(format!("{key}.video.webp")))
            .await
            .map(|value| value.len())
            .unwrap_or(0);
        total = total.saturating_add(size.saturating_add(thumbnail_size));
    }
    total
}

#[tauri::command]
pub(crate) async fn get_media_cache_info(app: tauri::AppHandle) -> Result<MediaCacheInfo, String> {
    Ok(MediaCacheInfo {
        limit_mb: cache_limit_mb(&app),
        used_bytes: cache_used_bytes(&app).await,
    })
}

#[tauri::command]
pub(crate) async fn set_media_cache_limit(
    app: tauri::AppHandle,
    limit_mb: u64,
) -> Result<MediaCacheInfo, String> {
    if !(MIN_CACHE_LIMIT_MB..=MAX_CACHE_LIMIT_MB).contains(&limit_mb) {
        return Err(format!(
            "media cache limit must be between {MIN_CACHE_LIMIT_MB} and {MAX_CACHE_LIMIT_MB} MB"
        ));
    }
    let path = cache_limit_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create app data: {e}"))?;
    }
    let temporary = path.with_extension("tmp");
    tokio::fs::write(&temporary, limit_mb.to_string())
        .await
        .map_err(|e| format!("write media cache limit: {e}"))?;
    tokio::fs::rename(&temporary, &path)
        .await
        .map_err(|e| format!("commit media cache limit: {e}"))?;

    let maintenance = CACHE_MAINTENANCE.get_or_init(|| RwLock::new(()));
    let _guard = maintenance.write().await;
    if let Ok(root) = app.path().app_cache_dir().map(|path| path.join(CACHE_DIR)) {
        prune_cache(&app, &root, "").await;
    }
    Ok(MediaCacheInfo {
        limit_mb,
        used_bytes: cache_used_bytes(&app).await,
    })
}

#[tauri::command]
pub(crate) async fn clear_media_cache(app: tauri::AppHandle) -> Result<MediaCacheInfo, String> {
    let maintenance = CACHE_MAINTENANCE.get_or_init(|| RwLock::new(()));
    let _guard = maintenance.write().await;
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("resolve app cache: {e}"))?
        .join(CACHE_DIR);
    match tokio::fs::remove_dir_all(&root).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("clear media cache: {error}")),
    }
    std::fs::create_dir_all(&root).map_err(|e| format!("recreate media cache: {e}"))?;
    Ok(MediaCacheInfo {
        limit_mb: cache_limit_mb(&app),
        used_bytes: 0,
    })
}

#[cfg(test)]
mod tests {
    #[cfg(desktop)]
    use super::sanitize_filename;
    use super::{
        cache_key, expected_digest, intersecting_missing_ranges, merge_range, missing_ranges,
        remove_range, requested_range, valid_download_task_id, validate_path, CacheMeta,
        CachedRange,
    };

    #[test]
    fn media_path_gate_rejects_traversal_and_non_upload_routes() {
        assert!(validate_path("/uploads/photo.jpg").is_ok());
        assert!(validate_path("/api/v1/users").is_err());
        assert!(validate_path("/uploads/../secret").is_err());
        assert!(validate_path("/uploads\\secret").is_err());
    }

    #[test]
    fn native_download_task_ids_are_bounded_and_event_safe() {
        assert!(valid_download_task_id("media-0123_ab"));
        assert!(!valid_download_task_id(""));
        assert!(!valid_download_task_id("space is not allowed"));
        assert!(!valid_download_task_id(&"x".repeat(129)));
    }

    #[test]
    fn cache_namespace_changes_with_origin_and_session() {
        let base = cache_key("https://one.example", Some("token-a"), "/uploads/a.jpg");
        assert_ne!(
            base,
            cache_key("https://two.example", Some("token-a"), "/uploads/a.jpg")
        );
        assert_ne!(
            base,
            cache_key("https://one.example", Some("token-b"), "/uploads/a.jpg")
        );
    }

    #[test]
    fn sparse_ranges_merge_and_report_only_the_holes() {
        let mut ranges = vec![
            CachedRange { start: 0, end: 20 },
            CachedRange { start: 40, end: 45 },
        ];
        merge_range(&mut ranges, CachedRange { start: 18, end: 30 });
        let meta = CacheMeta {
            content_type: Some("video/mp4".into()),
            size: 50,
            complete: false,
            ranges,
            validator: Some("\"v1\"".into()),
            blocks: Vec::new(),
        };
        assert_eq!(
            missing_ranges(&meta),
            vec![
                CachedRange { start: 30, end: 40 },
                CachedRange { start: 45, end: 50 },
            ]
        );
    }

    #[test]
    fn parses_open_and_suffix_http_ranges() {
        assert_eq!(
            requested_range("bytes=20-", 100),
            Some(CachedRange {
                start: 20,
                end: 100
            })
        );
        assert_eq!(
            requested_range("bytes=-10", 100),
            Some(CachedRange {
                start: 90,
                end: 100
            })
        );
    }

    #[test]
    fn overlapping_player_request_fetches_only_its_holes() {
        let meta = CacheMeta {
            content_type: Some("video/mp4".into()),
            size: 100,
            complete: false,
            ranges: vec![
                CachedRange { start: 0, end: 20 },
                CachedRange { start: 30, end: 40 },
            ],
            validator: Some("\"v1\"".into()),
            blocks: Vec::new(),
        };
        assert_eq!(
            intersecting_missing_ranges(&meta, CachedRange { start: 10, end: 35 }),
            vec![CachedRange { start: 20, end: 30 }]
        );
    }

    #[test]
    fn corrupt_block_is_removed_without_discarding_good_coverage() {
        let mut ranges = vec![CachedRange { start: 0, end: 100 }];
        remove_range(&mut ranges, CachedRange { start: 20, end: 30 });
        assert_eq!(
            ranges,
            vec![
                CachedRange { start: 0, end: 20 },
                CachedRange {
                    start: 30,
                    end: 100
                },
            ]
        );
    }

    #[test]
    fn extracts_authoritative_digest_only_from_cas_filename() {
        let digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let path = format!("/uploads/shards/01/23/{digest}.mp4?download=1");
        assert_eq!(expected_digest(&path), Some(digest));
        assert_eq!(expected_digest("/uploads/avatars/user.webp"), None);
    }

    #[cfg(desktop)]
    #[test]
    fn desktop_filename_is_confined_to_its_basename() {
        assert_eq!(sanitize_filename("../../photo.jpg"), "photo.jpg");
        assert_eq!(sanitize_filename(""), "download");
    }
}

#[tauri::command]
pub(crate) async fn cache_media(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ProxyState>,
    path: String,
) -> Result<CachedMediaFile, String> {
    let media = ensure_cached_file(&app, &proxy, &path).await?;
    cached_media_file(&app, &proxy, &path, media).await
}

/// Renderer-owned native download task. It reuses the exact media cache pipeline used by media:// and
/// save_media_desktop, but adds a task-scoped progress event + cancellation token. The returned path is
/// the private cache file; the renderer continues to display the canonical media:// URL so no file://
/// permission is exposed to the WebView.
#[tauri::command]
pub(crate) async fn download_media(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ProxyState>,
    path: String,
    task_id: String,
) -> Result<CachedMediaFile, String> {
    if !valid_download_task_id(&task_id) {
        return Err("invalid media download task id".into());
    }
    validate_path(&path)?;
    let cancel = CancellationToken::new();
    {
        let mut tasks = proxy
            .media_download_cancels
            .lock()
            .expect("media_download_cancels lock");
        if let Some(previous) = tasks.insert(task_id.clone(), cancel.clone()) {
            previous.cancel();
        }
    }
    let observer = MediaDownloadObserver {
        app: app.clone(),
        task_id: task_id.clone(),
        cancel: cancel.clone(),
    };
    let result = get_or_fetch_inner(&app, &proxy, &path, false, Some(&observer)).await;
    proxy
        .media_download_cancels
        .lock()
        .expect("media_download_cancels lock")
        .remove(&task_id);
    let media = result?;
    cached_media_file(&app, &proxy, &path, media).await
}

#[tauri::command]
pub(crate) fn cancel_media_download(proxy: tauri::State<'_, ProxyState>, task_id: String) -> bool {
    let token = proxy
        .media_download_cancels
        .lock()
        .expect("media_download_cancels lock")
        .remove(&task_id);
    if let Some(token) = token {
        token.cancel();
        true
    } else {
        false
    }
}

async fn cached_media_file(
    app: &tauri::AppHandle,
    proxy: &ProxyState,
    path: &str,
    media: CachedMedia,
) -> Result<CachedMediaFile, String> {
    let (_, _, key) = request_identity(proxy, path);
    let (data_path, _) = cache_paths(app, &key)?;
    Ok(CachedMediaFile {
        path: data_path.to_string_lossy().into_owned(),
        content_type: media.content_type,
        size: tokio::fs::metadata(&data_path)
            .await
            .map_err(|e| format!("stat cached media: {e}"))?
            .len(),
    })
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) async fn save_media_desktop(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ProxyState>,
    path: String,
    filename: String,
) -> Result<String, String> {
    let cached = cache_media(app.clone(), proxy, path).await?;
    let safe_name = sanitize_filename(&filename);
    let downloads = app
        .path()
        .download_dir()
        .map_err(|e| format!("resolve downloads directory: {e}"))?;
    std::fs::create_dir_all(&downloads).map_err(|e| format!("create downloads directory: {e}"))?;
    let destination = unique_destination(&downloads, &safe_name);
    tokio::fs::copy(&cached.path, &destination)
        .await
        .map_err(|e| format!("save media: {e}"))?;
    Ok(destination.to_string_lossy().into_owned())
}

#[cfg(desktop)]
fn sanitize_filename(filename: &str) -> String {
    let name = filename.rsplit(['/', '\\']).next().unwrap_or("").trim();
    if name.is_empty() || name == "." || name == ".." {
        "download".to_string()
    } else {
        name.chars()
            .map(|ch| if ch.is_control() { '_' } else { ch })
            .collect()
    }
}

#[cfg(desktop)]
fn unique_destination(dir: &Path, filename: &str) -> PathBuf {
    let initial = dir.join(filename);
    if !initial.exists() {
        return initial;
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("download");
    let extension = path.extension().and_then(|s| s.to_str());
    for index in 1..10_000 {
        let candidate = match extension {
            Some(ext) => dir.join(format!("{stem} ({index}).{ext}")),
            None => dir.join(format!("{stem} ({index})")),
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}-{}", std::process::id()))
}
