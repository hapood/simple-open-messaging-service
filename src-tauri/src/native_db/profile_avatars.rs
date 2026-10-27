use base64::Engine;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

/// Binary delivery shared by native notifications and live presentation pages.
/// Metadata carries indices only; each cached digest crosses the boundary once.
#[cfg(any(target_os = "android", test))]
#[derive(Default)]
pub(super) struct AvatarBatch {
    pub(super) bytes: Vec<Vec<u8>>,
    indices: std::collections::BTreeMap<String, usize>,
}
#[cfg(any(target_os = "android", test))]
impl AvatarBatch {
    pub(super) fn index(&mut self, user_id: i64, digest: &str) -> Result<Option<usize>, String> {
        if let Some(index) = self.indices.get(digest) {
            return Ok(Some(*index));
        }
        let Some(bytes) = read(user_id, digest)? else {
            return Ok(None);
        };
        let index = self.bytes.len();
        self.bytes.push(bytes);
        self.indices.insert(digest.to_owned(), index);
        Ok(Some(index))
    }
}

fn root() -> Result<PathBuf, String> {
    Ok(super::db_path()?.with_extension("profile-avatars"))
}

fn path(user_id: i64, digest: &str) -> Result<PathBuf, String> {
    if user_id <= 0
        || digest.len() != 64
        || !digest
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("invalid profile avatar digest".into());
    }
    Ok(root()?
        .join(user_id.to_string())
        .join(&digest[..2])
        .join(digest))
}

pub(super) fn save(user_id: i64, base64: Option<&str>) -> Result<Option<String>, String> {
    let Some(base64) = base64 else {
        return Ok(None);
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64)
        .map_err(|e| format!("decode profile avatar: {e}"))?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let target = path(user_id, &digest)?;
    if target.exists() {
        if fs::read(&target).map_err(|e| format!("read profile avatar: {e}"))? == bytes {
            return Ok(Some(digest));
        }
    }
    fs::create_dir_all(target.parent().ok_or("invalid profile avatar path")?)
        .map_err(|e| format!("create profile avatar directory: {e}"))?;
    let sequence = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
    let temporary = target.with_extension(format!("{}.{}.tmp", std::process::id(), sequence));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| format!("create profile avatar: {e}"))?;
        file.write_all(&bytes)
            .map_err(|e| format!("write profile avatar: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("sync profile avatar: {e}"))?;
        fs::rename(&temporary, &target).map_err(|e| format!("publish profile avatar: {e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(Some(digest))
}

pub(super) fn read(user_id: i64, digest: &str) -> Result<Option<Vec<u8>>, String> {
    let target = path(user_id, digest)?;
    let bytes = match fs::read(&target) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read profile avatar: {error}")),
    };
    if format!("{:x}", Sha256::digest(&bytes)) != digest {
        return Err("cached profile avatar digest mismatch".into());
    }
    Ok(Some(bytes))
}

#[tauri::command]
pub(crate) async fn native_db_get_profile_avatar(
    user_id: i64,
    digest: String,
) -> Result<Option<Vec<u8>>, String> {
    // Avatar bytes live on the filesystem; the captured cache view only fences the login.
    let work = super::capture_database_work()?;
    super::spawn_owned_work(work, move || read(user_id, &digest))
        .await
        .map_err(|e| format!("join profile avatar read: {e}"))?
}

pub(super) fn clear() -> Result<(), String> {
    match fs::remove_dir_all(root()?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("clear profile avatar files: {error}")),
    }
}

pub(super) fn clear_user(user_id: i64) -> Result<(), String> {
    if user_id <= 0 {
        return Err("invalid profile avatar user".into());
    }
    match fs::remove_dir_all(root()?.join(user_id.to_string())) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("clear user profile avatar files: {error}")),
    }
}
