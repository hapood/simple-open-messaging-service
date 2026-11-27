use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize, Serializer};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AccountSelfProfile {
    id: i64,
    account: String,
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
    state_feed_target: i64,
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
         intent_request_end_id,intent_request_read_id,intent_request_optimistic_read_id,state_feed_target
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
                state_feed_target: row.get(11)?,
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
    super::spawn_login_database(move |conn| {
        if user_id <= 0 {
            return Err("invalid account ID".into());
        }
        conn.execute(
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

/// Discover self facts from the login-owned cache without a renderer-supplied account ID.
fn read_cached_self_profile(conn: &Connection) -> Result<Option<AccountSelfProfile>, String> {
    let mut statement = conn
        .prepare(
            "SELECT user_id,schema_version,self_profile_json,self_identity_json
         FROM account_state WHERE user_id > 0 LIMIT 2",
        )
        .map_err(|error| format!("prepare cached self read: {error}"))?;
    let mut rows = statement
        .query([])
        .map_err(|error| format!("query cached self: {error}"))?;
    let Some(row) = rows
        .next()
        .map_err(|error| format!("read cached self: {error}"))?
    else {
        return Ok(None);
    };
    let decode_row = || -> rusqlite::Result<_> {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Option<String>>(2)?
                .map(decode::<AccountSelfProfile>)
                .transpose()?,
            row.get::<_, Option<String>>(3)?
                .map(decode::<AccountSelfIdentity>)
                .transpose()?,
        ))
    };
    let (user_id, version, profile, identity) =
        decode_row().map_err(|error| format!("decode cached self: {error}"))?;
    if rows
        .next()
        .map_err(|error| format!("read cached self owner: {error}"))?
        .is_some()
    {
        return Err("ambiguous cached self owner".into());
    }
    if version != 1 {
        return Err("invalid cached account state version".into());
    }
    if let Some(profile) = &profile {
        if profile.id != user_id
            || identity.as_ref().map(|value| &value.account) != Some(&profile.account)
        {
            return Err("cached self identity mismatch".into());
        }
    }
    Ok(profile)
}

#[tauri::command]
pub(crate) async fn native_db_read_cached_self_profile(
) -> Result<Option<AccountSelfProfile>, String> {
    super::spawn_login_database(|conn| read_cached_self_profile(conn))
        .await
        .map_err(|error| format!("join cached self read: {error}"))?
}

#[tauri::command]
pub(crate) async fn native_db_read_account_state(user_id: i64) -> Result<AccountState, String> {
    super::spawn_login_database(move |conn| read(conn, user_id))
        .await
        .map_err(|error| format!("join account read: {error}"))?
}

#[tauri::command]
pub(crate) async fn native_db_write_self_profile(
    user_id: i64,
    profile: AccountSelfProfile,
) -> Result<(), String> {
    super::spawn_login_database(move |conn| {
        if profile.id != user_id || user_id <= 0 {
            return Err("profile account mismatch".into());
        }
        let identity = AccountSelfIdentity {
            account: profile.account.clone(),
        };
        let changed = conn.execute(
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
    let work = super::capture_database_work()?;
    super::spawn_owned_database(Ok(work.clone()), move |conn| {
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
        super::notifications::refresh_requests(work, user_id);
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
    super::spawn_login_database(move |conn| {
        if drafts
            .iter()
            .any(|draft| draft.thread_id <= 0 || draft.updated_at < 0)
        {
            return Err("invalid composer draft".into());
        }
        let changed = conn
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

#[cfg(test)]
mod tests {
    use super::*;

    fn cache() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::create_cache_schema(&conn).unwrap();
        conn
    }

    fn seed(conn: &Connection, user_id: i64, profile_id: i64) {
        let profile = serde_json::json!({
            "id": profile_id, "account": "alice", "namespaceId": 0,
            "profileRev": 7, "isGroup": false, "isDeleted": false,
        });
        conn.execute(
            "INSERT INTO account_state(user_id,self_profile_json,self_identity_json) VALUES(?1,?2,?3)",
            params![user_id, profile.to_string(), r#"{"account":"alice"}"#],
        ).unwrap();
    }

    #[test]
    fn cached_self_discovery_is_read_only_and_requires_positive_owner() {
        let conn = cache();
        assert!(read_cached_self_profile(&conn).unwrap().is_none());
        seed(&conn, 0, 0);
        assert!(read_cached_self_profile(&conn).unwrap().is_none());
        seed(&conn, 42, 42);
        let profile = read_cached_self_profile(&conn).unwrap().unwrap();
        assert_eq!(profile.id, 42);
        assert_eq!(profile.account, "alice");
        assert_eq!(profile.profile_rev, 7);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM account_state", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn cached_self_discovery_rejects_mismatched_or_ambiguous_owners() {
        let conn = cache();
        seed(&conn, 42, 43);
        assert!(read_cached_self_profile(&conn)
            .unwrap_err()
            .contains("identity mismatch"));
        conn.execute("DELETE FROM account_state", []).unwrap();
        seed(&conn, 42, 42);
        seed(&conn, 43, 43);
        assert!(read_cached_self_profile(&conn)
            .unwrap_err()
            .contains("ambiguous"));
    }

    #[test]
    fn cached_self_discovery_rejects_expired_database_work() {
        let conn = cache();
        seed(&conn, 42, 42);
        let id =
            crate::login_session_store::LoginSessionId::try_from(uuid::Uuid::new_v4().to_string())
                .unwrap();
        let owner = crate::login_connection::LoginConnection::preparing(id, conn);
        owner
            .begin_activation()
            .unwrap()
            .commit("test-token".into())
            .unwrap();
        let work = owner.capture_database_work().unwrap();
        assert_eq!(
            work.with_database(|conn| read_cached_self_profile(conn))
                .unwrap()
                .unwrap()
                .id,
            42
        );
        owner.end().unwrap();
        assert!(work
            .with_database(|conn| read_cached_self_profile(conn))
            .is_err());
    }

    #[test]
    fn self_account_state_contains_only_account_facts() {
        let facts = serde_json::json!({
            "id": 1, "account": "alice", "namespaceId": 0,
            "profileRev": 7, "isGroup": false, "isDeleted": false,
        });
        let account: AccountSelfProfile = serde_json::from_value(facts.clone()).unwrap();
        assert_eq!(serde_json::to_value(account).unwrap(), facts);
    }

    #[test]
    fn self_account_state_rejects_display_copies() {
        for field in ["name", "avatar", "bio"] {
            let mut facts = serde_json::json!({
                "id": 1, "account": "alice", "namespaceId": 0,
                "profileRev": 7, "isGroup": false, "isDeleted": false,
            });
            facts[field] = "obsolete".into();
            assert!(serde_json::from_value::<AccountSelfProfile>(facts).is_err());
        }
    }
}
