use futures_util::{future::BoxFuture, FutureExt, StreamExt};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

// A caller owns one Shared clone. Dropping it stops only that caller's observation;
// the remaining callers keep polling the same request. The last drop cancels work.
type Flight = futures_util::future::Shared<BoxFuture<'static, Result<Vec<u8>, String>>>;
type Flights = Mutex<HashMap<(PathBuf, String), Weak<Flight>>>;
static FLIGHTS: OnceLock<Flights> = OnceLock::new();

/// Query parameters are not part of a content digest's identity. Require the exact
/// sharded route so aliases and malformed paths cannot create additional cache entries.
pub(super) fn canonical_path(path: &str) -> Result<String, String> {
    super::validate_path(path)?;
    let path = path.split('?').next().unwrap_or(path);
    let digest = super::expected_digest(path).ok_or("invalid thumbnail digest")?;
    let canonical = format!(
        "/uploads/thumbnails/{}/{}/{digest}",
        &digest[..2],
        &digest[2..4]
    );
    if path != canonical {
        return Err("invalid thumbnail path".into());
    }
    Ok(canonical)
}

pub(super) async fn fetch(
    output: PathBuf,
    session: String,
    request: reqwest::RequestBuilder,
    cancel: CancellationToken,
    is_current: impl Fn() -> bool + Send + Sync + 'static,
) -> Result<Vec<u8>, String> {
    let flight = {
        let mut flights = FLIGHTS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| "thumbnail flights lock poisoned")?;
        flights.retain(|_, flight| flight.strong_count() > 0);
        let key = (output.clone(), session);
        if let Some(flight) = flights.get(&key).and_then(Weak::upgrade) {
            flight
        } else {
            let flight = Arc::new(
                async move {
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => Err("thumbnail session changed".into()),
                        result = fetch_inner(&output, request, &is_current) => result,
                    }
                }
                .boxed()
                .shared(),
            );
            flights.insert(key, Arc::downgrade(&flight));
            flight
        }
    };
    flight.as_ref().clone().await
}

async fn fetch_inner(
    output: &Path,
    request: reqwest::RequestBuilder,
    is_current: &impl Fn() -> bool,
) -> Result<Vec<u8>, String> {
    let maintenance = super::CACHE_MAINTENANCE.get_or_init(|| RwLock::new(()));
    let failure = output.with_extension("failure");
    let generation;
    {
        let _guard = maintenance.read().await;
        generation = super::THUMBNAIL_CACHE_GENERATION.load(std::sync::atomic::Ordering::Acquire);
        ensure_current(is_current)?;
        // Only a missing entry is a miss. Unreadable failure records must not trigger
        // repeated network requests, and failure records are not evicted by byte LRU.
        if let Some(error) = read_entry(&failure).await? {
            return Err(String::from_utf8(error).map_err(|_| "invalid thumbnail failure record")?);
        }
        if let Some(bytes) = read_entry(output).await? {
            ensure_current(is_current)?;
            return Ok(bytes);
        }
    }
    let result = download(request).await;
    let _guard = maintenance.read().await;
    ensure_current(is_current)?;
    if generation != super::THUMBNAIL_CACHE_GENERATION.load(std::sync::atomic::Ordering::Acquire) {
        return Err("thumbnail cache cleared".into());
    }
    // Session cancellation and local storage errors are not download failures. Only
    // an actual HTTP/transport/integrity failure becomes a durable negative entry.
    match &result {
        Ok(bytes) => write_entry(output, bytes).await?,
        Err(error) => write_entry(&failure, error.as_bytes()).await?,
    }
    ensure_current(is_current)?;
    result
}

fn ensure_current(is_current: &impl Fn() -> bool) -> Result<(), String> {
    if is_current() {
        Ok(())
    } else {
        Err("thumbnail session changed".into())
    }
}

async fn read_entry(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("read thumbnail cache: {error}")),
    }
}

async fn write_entry(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let root = path.parent().ok_or("thumbnail cache has no directory")?;
    tokio::fs::create_dir_all(root)
        .await
        .map_err(|e| format!("create thumbnail cache: {e}"))?;
    // A dropped filesystem future may still complete on Tokio's blocking pool.
    // Unique temporary names keep that write separate from a subsequent attempt.
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    tokio::fs::write(&temporary, bytes)
        .await
        .map_err(|e| format!("write thumbnail cache: {e}"))?;
    tokio::fs::rename(&temporary, path)
        .await
        .map_err(|e| format!("commit thumbnail cache: {e}"))
}

async fn download(request: reqwest::RequestBuilder) -> Result<Vec<u8>, String> {
    let response = request
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    if !response.status().is_success() {
        return Err(format!("thumbnail HTTP {}", response.status()));
    }
    let digest = response
        .headers()
        .get("x-thumbnail-digest")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing thumbnail digest")?
        .to_string();
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.without_url().to_string())?;
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err("thumbnail too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if super::sha256_hex(&bytes) != digest {
        return Err("thumbnail digest mismatch".into());
    }
    Ok(bytes)
}

#[cfg(test)]
#[path = "../tests/thumbnail_cache_tests.rs"]
mod tests;
