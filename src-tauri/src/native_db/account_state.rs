use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize, Serializer};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AccountSelfProfile {
    id: i64,
    account: String,
    name: String,
    avatar: String,
    bio: String,
    is_group: bool,
    namespace_id: i64,
    profile_rev: i64,
    is_deleted: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AccountSelfIdentity {
    account: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AccountComposerDraft {
    thread_id: i64,
    html: String,
    plain_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    link_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation_expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation_triggered: Option<bool>,
    updated_at: i64,
}

/// Convert a wire coordinate to SQLite INTEGER without rounding or interpreting the ID.
pub(super) fn request_id_to_sqlite(value: &str) -> Result<i64, String> {
    let id = value.parse::<i64>().map_err(|_| "invalid request ID")?;
    if id < 0 || id.to_string() != value {
        return Err("invalid request ID".into());
    }
    Ok(id)
}

fn decimal<S: Serializer>(id: &Option<i64>, serializer: S) -> Result<S::Ok, S::Error> {
    id.map(|value| value.to_string()).serialize(serializer)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountState {
    schema_version: i64,
    self_profile: Option<AccountSelfProfile>,
    self_identity: Option<AccountSelfIdentity>,
    composer_drafts: Vec<AccountComposerDraft>,
    thread_feed_cursor: Option<i64>,
    state_feed_id: Option<i64>,
    state_feed_full_through: Option<i64>,
    profile_namespace_change_end_id: Option<i64>,
    #[serde(serialize_with = "decimal")]
    intent_request_end_id: Option<i64>,
    #[serde(serialize_with = "decimal")]
    intent_request_read_id: Option<i64>,
    #[serde(serialize_with = "decimal")]
    intent_request_optimistic_read_id: Option<i64>,
}

fn decode<T: serde::de::DeserializeOwned>(text: String) -> rusqlite::Result<T> {
    serde_json::from_str(&text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

pub(super) fn read(conn: &Connection, user_id: i64) -> Result<AccountState, String> {
    conn.query_row(
        "SELECT schema_version,self_profile_json,self_identity_json,composer_drafts_json,
         thread_feed_cursor,state_feed_id,state_feed_full_through,profile_namespace_change_end_id,
         intent_request_end_id,intent_request_read_id,intent_request_optimistic_read_id
         FROM account_state WHERE user_id=?1",
        [user_id],
        |row| {
            Ok(AccountState {
                schema_version: row.get(0)?,
                self_profile: row.get::<_, Option<String>>(1)?.map(decode).transpose()?,
                self_identity: row.get::<_, Option<String>>(2)?.map(decode).transpose()?,
                composer_drafts: decode(row.get(3)?)?,
                thread_feed_cursor: row.get(4)?,
                state_feed_id: row.get(5)?,
                state_feed_full_through: row.get(6)?,
                profile_namespace_change_end_id: row.get(7)?,
                intent_request_end_id: row.get(8)?,
                intent_request_read_id: row.get(9)?,
                intent_request_optimistic_read_id: row.get(10)?,
            })
        },
    )
    .optional()
    .map_err(|error| format!("read account state: {error}"))?
    .ok_or_else(|| "missing account state".into())
}

/** Explicit initialization is separate from strict reads; it creates no observed heads. */
#[tauri::command]
pub(crate) async fn native_db_initialize_account_state(user_id: i64) -> Result<(), String> {
    super::lifetime::spawn(move || {
        if user_id <= 0 {
            return Err("invalid account ID".into());
        }
        super::open()?
            .execute(
                "INSERT INTO account_state(user_id) VALUES(?1)
            ON CONFLICT(user_id) DO NOTHING",
                [user_id],
            )
            .map_err(|error| format!("initialize account state: {error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("join account initialization: {error}"))?
}

#[tauri::command]
pub(crate) async fn native_db_read_account_state(user_id: i64) -> Result<AccountState, String> {
    super::lifetime::spawn(move || read(&super::open()?, user_id))
        .await
        .map_err(|error| format!("join account read: {error}"))?
}

#[tauri::command]
pub(crate) async fn native_db_write_self_profile(
    user_id: i64,
    profile: AccountSelfProfile,
) -> Result<(), String> {
    super::lifetime::spawn(move || {
        if profile.id != user_id || user_id <= 0 {
            return Err("profile account mismatch".into());
        }
        let identity = AccountSelfIdentity {
            account: profile.account.clone(),
        };
        let changed = super::open()?.execute(
            "UPDATE account_state SET self_profile_json=?2,self_identity_json=?3 WHERE user_id=?1",
            params![user_id, serde_json::to_string(&profile).map_err(|e| e.to_string())?,
                serde_json::to_string(&identity).map_err(|e| e.to_string())?],
        ).map_err(|error| format!("write self profile: {error}"))?;
        if changed != 1 {
            return Err("missing account state".into());
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("join profile write: {error}"))?
}

/** Persist only the local read intent. Network submission and retry belong to the runtime. */
#[tauri::command]
pub(crate) async fn native_db_advance_intent_request_read(
    user_id: i64,
    observed_end_id: String,
) -> Result<AccountState, String> {
    let target = request_id_to_sqlite(&observed_end_id)?;
    super::lifetime::spawn(move || {
        let mut conn = super::open()?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| format!("begin request read intent: {error}"))?;
        let changed = tx
            .execute(
                "UPDATE account_state SET intent_request_optimistic_read_id=CASE
             WHEN ?2 <= COALESCE(intent_request_read_id,0) THEN intent_request_optimistic_read_id
             ELSE MAX(COALESCE(intent_request_optimistic_read_id,0),?2) END WHERE user_id=?1",
                params![user_id, target],
            )
            .map_err(|error| format!("persist request read intent: {error}"))?;
        if changed != 1 {
            return Err("missing account state".into());
        }
        let state = read(&tx, user_id)?;
        tx.commit()
            .map_err(|error| format!("commit request read intent: {error}"))?;
        Ok(state)
    })
    .await
    .map_err(|error| format!("join request read intent: {error}"))?
}

#[tauri::command]
pub(crate) async fn native_db_write_composer_drafts(
    user_id: i64,
    drafts: Vec<AccountComposerDraft>,
) -> Result<(), String> {
    super::lifetime::spawn(move || {
        if drafts
            .iter()
            .any(|draft| draft.thread_id <= 0 || draft.updated_at < 0)
        {
            return Err("invalid composer draft".into());
        }
        let changed = super::open()?
            .execute(
                "UPDATE account_state SET composer_drafts_json=?2 WHERE user_id=?1",
                params![
                    user_id,
                    serde_json::to_string(&drafts).map_err(|e| e.to_string())?
                ],
            )
            .map_err(|error| format!("write composer drafts: {error}"))?;
        if changed != 1 {
            return Err("missing account state".into());
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("join draft write: {error}"))?
}
