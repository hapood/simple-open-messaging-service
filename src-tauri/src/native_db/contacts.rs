use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use super::{open, parse_json};

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
    super::lifetime::spawn(move || {
        read_profile(
            &open()?,
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

#[tauri::command]
pub(crate) async fn native_db_get_group_member(
    user_id: i64,
    thread_id: i64,
    account: String,
    domain: String,
    namespace_id: i64,
) -> Result<Option<Value>, String> {
    super::lifetime::spawn(move || {
        let value = open()?
            .query_row(
                "SELECT json_object(
               'threadId',member.thread_id,'account',member.member_account,
               'domain',member.member_domain,
               'namespaceId',member.namespace_id,
               'role',member.role,'left',json('false'),
               'profileRev',member.profile_rev,
               'profileMessageSeq',member.profile_message_seq,
               'resolvedProfileRev',identity.profile_rev,
               'profileName',identity.name,
               'profileBio',COALESCE(identity.bio,''),
               'user',json(CASE WHEN identity.profile_rev IS NOT NULL THEN
                 json_object('account',identity.account,'domain',identity.domain,
                   'namespaceId',identity.profile_namespace_id,'profileRev',identity.profile_rev,
                   'name',identity.name,'avatarDigest',identity.avatar_digest,'bio',identity.bio)
               ELSE json_object('account',member.member_account,'domain',member.member_domain,
                 'namespaceId',member.namespace_id,'profileRev',member.profile_rev,'name',member.member_account,'avatarDigest',json('null'),'bio','') END))
             FROM members member LEFT JOIN profiles identity
               ON identity.user_id=member.user_id AND identity.account=member.member_account
              AND identity.domain=member.member_domain
              AND identity.publisher_namespace_id=member.namespace_id AND identity.profile_namespace_id=member.namespace_id AND identity.profile_rev=member.profile_rev
             WHERE member.user_id=?1 AND member.thread_id=?2 AND member.member_account=?3
               AND member.member_domain=?4 AND member.namespace_id=?5
               AND member.left_state=0",
                params![user_id, thread_id, account, domain, namespace_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("get group member: {e}"))?;
        value.map(parse_json).transpose()
    })
    .await
    .map_err(|e| format!("join group member read: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_query_group_members(
    user_id: i64,
    thread_id: i64,
    after_identity: String,
    take: i64,
    search: String,
) -> Result<Vec<Value>, String> {
    super::lifetime::spawn(move || {
        let conn = open()?;
        let cursor: Value = serde_json::from_str(&after_identity)
            .unwrap_or_else(|_| serde_json::json!([0, "", ""]));
        let after_namespace = cursor.get(0).and_then(Value::as_i64).unwrap_or(0);
        let after_domain = cursor.get(1).and_then(Value::as_str).unwrap_or("");
        let after_account = cursor.get(2).and_then(Value::as_str).unwrap_or("");
        let mut statement = conn
            .prepare(
                "SELECT json_object(
                   'threadId', member.thread_id,
                   'account', member.member_account, 'domain', member.member_domain,
                   'namespaceId', member.namespace_id,
                   'role', member.role,
                   'left', json('false'),
                   'profileRev',member.profile_rev,
                   'profileMessageSeq',member.profile_message_seq,
                   'resolvedProfileRev',identity.profile_rev,
                   'profileName',identity.name,
                   'profileBio',COALESCE(identity.bio,''),
                   'user', json(CASE WHEN identity.profile_rev IS NOT NULL THEN
                     json_object('account',identity.account,'domain',identity.domain,
                       'namespaceId',identity.profile_namespace_id,'profileRev',identity.profile_rev,
                       'name',identity.name,'avatarDigest',identity.avatar_digest,'bio',identity.bio)
                   ELSE json_object('account',member.member_account,'domain',member.member_domain,
                     'namespaceId',member.namespace_id,'profileRev',member.profile_rev,'name',member.member_account,'avatarDigest',json('null'),'bio','') END)
                 )
                 FROM members member LEFT JOIN profiles identity
                   ON identity.user_id=member.user_id
                  AND identity.account=member.member_account
                  AND identity.domain=member.member_domain
                  AND identity.publisher_namespace_id=member.namespace_id AND identity.profile_namespace_id=member.namespace_id AND identity.profile_rev=member.profile_rev
                 WHERE member.user_id=?1 AND member.thread_id=?2 AND member.left_state=0
                   AND (member.namespace_id,member.member_domain,member.member_account)>(?3,?4,?5)
                   AND (?6='' OR instr(lower(identity.name),lower(?6))>0
                                OR instr(lower(member.member_account),lower(?6))>0)
                 ORDER BY member.namespace_id,member.member_domain,member.member_account LIMIT ?7",
            )
            .map_err(|e| format!("prepare group member page: {e}"))?;
        let rows = statement
            .query_map(
                params![user_id, thread_id, after_namespace, after_domain, after_account, search, take],
                |row| row.get::<_, String>(0),
            )
            .map_err(|e| format!("query group member page: {e}"))?;
        let mut values = Vec::new();
        for row in rows {
            values.push(
                row.map_err(|e| format!("read group member row: {e}"))
                    .and_then(parse_json)?,
            );
        }
        Ok(values)
    })
    .await
    .map_err(|e| format!("join group member page: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_record_group_member_profile_ref(
    user_id: i64,
    thread_id: i64,
    account: String,
    domain: String,
    namespace_id: i64,
    profile_rev: i64,
    message_seq: i64,
) -> Result<bool, String> {
    super::lifetime::spawn(move || {
        let changed = open()?
            .execute(
                "UPDATE members SET profile_rev=?6,profile_message_seq=?7
                 WHERE user_id=?1 AND thread_id=?2 AND member_account=?3
                   AND member_domain=?4 AND namespace_id=?5
                   AND left_state=0 AND COALESCE(profile_message_seq,0)<?7",
                params![
                    user_id,
                    thread_id,
                    account,
                    domain,
                    namespace_id,
                    profile_rev,
                    message_seq,
                ],
            )
            .map_err(|e| format!("record group member profile reference: {e}"))?;
        Ok(changed > 0)
    })
    .await
    .map_err(|e| format!("join group member profile reference write: {e}"))?
}
