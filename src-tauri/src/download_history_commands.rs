use crate::download_history::{delete_recorded_file, DownloadHistoryStorage, StoredDownloadRecord};

async fn with_store<T: Send + 'static>(
    operation: impl FnOnce(DownloadHistoryStorage<'_>) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let work = crate::native_db::capture_database_work()?;
    tauri::async_runtime::spawn_blocking(move || {
        work.with_database(|connection| operation(DownloadHistoryStorage::new(connection)))
            .map_err(|error| error.to_string())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn native_download_put(record: StoredDownloadRecord) -> Result<(), String> {
    with_store(move |store| store.put(&record)).await
}

#[tauri::command]
pub(crate) async fn native_download_list() -> Result<Vec<StoredDownloadRecord>, String> {
    with_store(|store| store.list()).await
}

#[tauri::command]
pub(crate) async fn native_download_remove(id: String) -> Result<(), String> {
    with_store(move |store| store.remove(&id)).await
}

#[tauri::command]
pub(crate) async fn native_download_clear(delete_files: bool) -> Result<Vec<String>, String> {
    let destinations = with_store(|store| store.clear()).await?;
    if !delete_files {
        return Ok(Vec::new());
    }
    let mut content_uris = Vec::new();
    for destination in destinations {
        if destination.starts_with("content://") {
            content_uris.push(destination);
        } else {
            delete_recorded_file(&destination)?;
        }
    }
    Ok(content_uris)
}
