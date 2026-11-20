//! Pending-send storage commands admitted through the existing database owner.
use crate::send_outbox::{SendOutboxStorage, StoredSendTask};

async fn with_store<T: Send + 'static>(
    operation: impl FnOnce(SendOutboxStorage<'_>) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    run_store(crate::native_db::capture_database_work()?, operation).await
}

async fn run_store<T: Send + 'static>(
    work: crate::login_connection::DatabaseWork,
    operation: impl FnOnce(SendOutboxStorage<'_>) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        work.with_database(|connection| operation(SendOutboxStorage::new(connection)))
            .map_err(|error| error.to_string())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn native_send_enqueue(task: StoredSendTask) -> Result<(), String> {
    with_store(move |store| store.enqueue(&task)).await
}

#[tauri::command]
pub(crate) async fn native_send_get(client_message_id: String) -> Result<Option<StoredSendTask>, String> {
    with_store(move |store| store.get(&client_message_id)).await
}

#[tauri::command]
pub(crate) async fn native_send_list() -> Result<Vec<StoredSendTask>, String> {
    with_store(|store| store.list()).await
}

#[tauri::command]
pub(crate) async fn native_send_remove(client_message_id: String) -> Result<(), String> {
    release_owned(with_store(move |store| store.remove(&client_message_id)).await?)
}

#[tauri::command]
pub(crate) async fn native_send_clear() -> Result<(), String> {
    release_owned(with_store(|store| store.clear()).await?)
}

fn release_owned(paths: Vec<String>) -> Result<(), String> {
    crate::send_outbox::release_owned_recordings(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{login_connection::LoginConnection, login_session_store::LoginSessionId};

    #[tokio::test]
    async fn pending_storage_uses_the_existing_owner_and_rejects_invalidated_work() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        SendOutboxStorage::initialize(&connection).unwrap();
        let owner = LoginConnection::preparing(
            LoginSessionId::try_from(uuid::Uuid::new_v4().to_string()).unwrap(), connection,
        );
        owner.begin_activation().unwrap().commit("credential".into()).unwrap();
        let task = StoredSendTask { client_message_id: "cid".into(), thread_id: 1,
            item: crate::send_outbox::StoredSendContent::Text { content: "hello".into() } };
        let saved = serde_json::from_value(serde_json::to_value(&task).unwrap()).unwrap();
        run_store(owner.capture_database_work().unwrap(), move |store| store.enqueue(&saved)).await.unwrap();
        assert_eq!(run_store(owner.capture_database_work().unwrap(), |store| store.list()).await.unwrap(), vec![task]);
        let stale = owner.capture_database_work().unwrap();
        owner.invalidate_database_work().unwrap();
        assert!(run_store(stale, |store| store.clear()).await.is_err());
        assert_eq!(run_store(owner.capture_database_work().unwrap(), |store| store.list()).await.unwrap().len(), 1);
        assert!(run_store(owner.capture_database_work().unwrap(), |store| store.remove("cid")).await.unwrap().is_empty());
        assert!(run_store(owner.capture_database_work().unwrap(), |store| store.list()).await.unwrap().is_empty());
        let ended = owner.capture_database_work().unwrap();
        owner.end().unwrap();
        assert!(run_store(ended, |store| store.clear()).await.is_err());
        owner.close().unwrap();
    }
}
