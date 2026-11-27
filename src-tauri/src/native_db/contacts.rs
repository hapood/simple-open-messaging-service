use rusqlite::{params, OptionalExtension};
use serde_json::Value;

/// Test fixture only: production namespace bindings are written by profile-namespace commits.
#[cfg(test)]
pub(super) fn register_namespace(
    conn: &rusqlite::Connection,
    user_id: i64,
    namespace: i64,
    source: &str,
) -> Result<(), String> {
    if namespace < 0 || source.is_empty() {
        return Err("invalid profile namespace binding".into());
    }
    conn.execute(
        "INSERT INTO profile_namespaces(
           user_id,publisher_namespace_id,profile_namespace_id,domain,root_public_key,
           update_feed_id,change_seq,expired,status,refreshed_at
         ) VALUES(?1,?2,?2,?3,NULL,0,0,0,'ACTIVE',0)
         ON CONFLICT(user_id,publisher_namespace_id,profile_namespace_id) DO UPDATE SET
           domain=COALESCE(profile_namespaces.domain,excluded.domain)",
        params![user_id, namespace, source],
    )
    .map_err(|e| format!("register profile namespace binding: {e}"))?;
    Ok(())
}

pub(super) fn write_profile(
    conn: &rusqlite::Connection,
    user_id: i64,
    profile: &Value,
) -> Result<bool, String> {
    let account = profile
        .get("account")
        .and_then(Value::as_str)
        .ok_or("profile has no account")?;
    let publisher_namespace = profile
        .get("publisherNamespaceId")
        .and_then(Value::as_i64)
        .ok_or("profile has no publisher namespace")?;
    let profile_namespace = profile
        .get("profileNamespaceId")
        .and_then(Value::as_i64)
        .ok_or("profile has no profile namespace")?;
    // Display bindings arrive independently of immutable profile snapshots.
    let domain = profile
        .get("domain")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let rev = profile
        .get("profileRev")
        .and_then(Value::as_i64)
        .ok_or("profile has no revision")?;
    if rev < 1 {
        return Ok(false);
    }
    let name = profile
        .get("name")
        .and_then(Value::as_str)
        .ok_or("profile has no name")?;
    let avatar_digest = profile.get("avatarDigest").and_then(Value::as_str);
    let bio = profile
        .get("bio")
        .and_then(Value::as_str)
        .ok_or("profile has no bio")?;
    if let Some(domain) = domain {
        conn.execute(
            "INSERT INTO profile_namespaces(
               user_id,publisher_namespace_id,profile_namespace_id,domain,root_public_key,
               update_feed_id,change_seq,expired,status,refreshed_at
             ) VALUES(?1,?2,?3,?4,NULL,0,0,0,'ACTIVE',0)
             ON CONFLICT(user_id,publisher_namespace_id,profile_namespace_id) DO UPDATE SET
               domain=excluded.domain",
            params![user_id, publisher_namespace, profile_namespace, domain],
        )
        .map_err(|e| format!("write profile namespace binding: {e}"))?;
    }
    let existing: Option<(String, Option<String>, String)> = conn
        .query_row(
            "SELECT name, avatar_digest, bio FROM profiles
             WHERE user_id=?1 AND publisher_namespace_id=?2 AND profile_namespace_id=?3
               AND account=?4 AND profile_rev=?5",
            params![
                user_id,
                publisher_namespace,
                profile_namespace,
                account,
                rev
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((previous_name, previous_digest, previous_bio)) = existing {
        if previous_name != name
            || previous_bio != bio
            || previous_digest.as_deref() != avatar_digest
        {
            return Err("conflicting cached profile revision".into());
        }
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO profiles(
           user_id,publisher_namespace_id,profile_namespace_id,account,profile_rev,
           name,avatar_digest,bio
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            user_id,
            publisher_namespace,
            profile_namespace,
            account,
            rev,
            name,
            avatar_digest,
            bio
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Resolve an exact cached profile revision for either UI or background consumers.
/// The domain in the result is the display attribute of the
/// `(publisherNamespaceId, profileNamespaceId)` binding row; it is never taken
/// from caller coordinates. A missing binding leaves the display domain empty.
pub(super) fn read_profile(
    conn: &rusqlite::Connection,
    user_id: i64,
    publisher_namespace_id: i64,
    profile_namespace_id: i64,
    account: &str,
    profile_rev: i64,
) -> Result<Option<Value>, String> {
    let value: Option<(String, Option<String>, String, Option<String>)> = conn
        .query_row(
            "SELECT profile.name, profile.avatar_digest, profile.bio, binding.domain
         FROM profiles profile
         LEFT JOIN profile_namespaces binding
           ON binding.user_id=profile.user_id
          AND binding.publisher_namespace_id=profile.publisher_namespace_id
          AND binding.profile_namespace_id=profile.profile_namespace_id
         WHERE profile.user_id=?1 AND profile.publisher_namespace_id=?2
           AND profile.profile_namespace_id=?3 AND profile.account=?4 AND profile.profile_rev=?5",
            params![
                user_id,
                publisher_namespace_id,
                profile_namespace_id,
                account,
                profile_rev
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(value.map(|(name, avatar_digest, bio, binding_domain)| {
        serde_json::json!({
            "publisherNamespaceId": publisher_namespace_id,
            "account": account,
            "domain": binding_domain.unwrap_or_default(),
            "namespaceId": profile_namespace_id,
            "profileNamespaceId": profile_namespace_id,
            "profileRev": profile_rev, "name": name, "avatarDigest": avatar_digest, "bio": bio,
        })
    }))
}

/// Wire shape of the client profile demand. The `lookup` discriminator and its
/// companion fields choose the server-side resolution strategy; the cache read
/// only consumes the exact revision coordinates.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileDemandWire {
    publisher_namespace_id: i64,
    target: ProfileDemandTargetWire,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileDemandTargetWire {
    profile_namespace_id: i64,
    account: String,
    rev: i64,
}

#[tauri::command]
pub(crate) async fn native_db_get_profile(
    user_id: i64,
    demand: ProfileDemandWire,
) -> Result<Option<Value>, String> {
    super::spawn_login_database(move |conn| {
        read_profile(
            conn,
            user_id,
            demand.publisher_namespace_id,
            demand.target.profile_namespace_id,
            &demand.target.account,
            demand.target.rev,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
