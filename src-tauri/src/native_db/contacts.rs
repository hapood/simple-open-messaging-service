use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use super::parse_json;

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

#[tauri::command]
pub(crate) async fn native_db_get_group_member(
    user_id: i64,
    thread_id: i64,
    account: String,
    namespace_id: i64,
) -> Result<Option<Value>, String> {
    super::spawn_login_database(move |conn| {
        let value = conn
            .query_row(
                "SELECT json_object(
               'threadId',member.thread_id,'account',member.member_account,
               'domain',COALESCE(binding.domain,''),
               'namespaceId',member.namespace_id,
               'role',member.role,'left',json('false'),
               'profileRev',member.profile_rev,
               'resolvedProfileRev',identity.profile_rev,
               'profileName',identity.name,
               'profileBio',COALESCE(identity.bio,''),
               'user',json(CASE WHEN identity.profile_rev IS NOT NULL THEN
                 json_object('account',identity.account,'domain',COALESCE(binding.domain,''),
                   'publisherNamespaceId',thread.authority_namespace_id,'profileNamespaceId',member.namespace_id,
                   'namespaceId',identity.profile_namespace_id,'profileRev',identity.profile_rev,
                   'name',identity.name,'avatarDigest',identity.avatar_digest,'bio',identity.bio)
               ELSE json_object('account',member.member_account,'domain',COALESCE(binding.domain,''),
                 'publisherNamespaceId',thread.authority_namespace_id,'profileNamespaceId',member.namespace_id,
                 'namespaceId',member.namespace_id,'profileRev',member.profile_rev,'name',member.member_account,'avatarDigest',json('null'),'bio','') END))
             FROM members member
             JOIN threads thread ON thread.user_id=member.user_id AND thread.thread_id=member.thread_id AND thread.kind='GROUP'
             LEFT JOIN profiles identity
               ON identity.user_id=member.user_id AND identity.account=member.member_account
              AND identity.publisher_namespace_id=thread.authority_namespace_id AND identity.profile_namespace_id=member.namespace_id AND identity.profile_rev=member.profile_rev
             LEFT JOIN profile_namespaces binding
               ON binding.user_id=member.user_id
              AND binding.publisher_namespace_id=thread.authority_namespace_id
              AND binding.profile_namespace_id=member.namespace_id
             WHERE member.user_id=?1 AND member.thread_id=?2 AND member.member_account=?3
               AND member.namespace_id=?4
               AND member.left_state=0",
                params![user_id, thread_id, account, namespace_id],
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
    exclude_account: Option<String>,
    exclude_namespace_id: Option<i64>,
) -> Result<Vec<Value>, String> {
    super::spawn_login_database(move |conn| {
        query_group_members(
            conn,
            user_id,
            thread_id,
            &after_identity,
            take,
            &search,
            exclude_account.as_deref(),
            exclude_namespace_id,
        )
    })
    .await
    .map_err(|e| format!("join group member page: {e}"))?
}

/// Local roster lookup shared by the PC command and native presentation hosts.
/// No profile resolution or network request is scheduled by a search.
pub(super) fn query_group_members(
    conn: &rusqlite::Connection,
    user_id: i64,
    thread_id: i64,
    after_identity: &str,
    take: i64,
    search: &str,
    exclude_account: Option<&str>,
    exclude_namespace_id: Option<i64>,
) -> Result<Vec<Value>, String> {
    // SQLite's built-in lower() only folds ASCII. Match the browser's Unicode
    // lowercase substring search without depending on the device's locale.
    conn.create_scalar_function(
        "member_search_key",
        1,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            Ok(context
                .get::<Option<String>>(0)?
                .map(|value| value.to_lowercase()))
        },
    )
    .map_err(|e| format!("register member search key: {e}"))?;
    let cursor: Value =
        serde_json::from_str(after_identity).unwrap_or_else(|_| serde_json::json!([0, ""]));
    let after_namespace = cursor.get(0).and_then(Value::as_i64).unwrap_or(0);
    let after_account = cursor.get(1).and_then(Value::as_str).unwrap_or("");
    let mut statement = conn
            .prepare(
                "SELECT json_object(
                   'threadId', member.thread_id,
                   'account', member.member_account,
                   'domain', COALESCE(binding.domain,''),
                   'namespaceId', member.namespace_id,
                   'role', member.role,
                   'left', json('false'),
                   'profileRev',member.profile_rev,
                   'resolvedProfileRev',identity.profile_rev,
                   'profileName',identity.name,
                   'profileBio',COALESCE(identity.bio,''),
                   'user', json(CASE WHEN identity.profile_rev IS NOT NULL THEN
                     json_object('account',identity.account,'domain',COALESCE(binding.domain,''),
                       'publisherNamespaceId',thread.authority_namespace_id,'profileNamespaceId',member.namespace_id,
                       'namespaceId',identity.profile_namespace_id,'profileRev',identity.profile_rev,
                       'name',identity.name,'avatarDigest',identity.avatar_digest,'bio',identity.bio)
                   ELSE json_object('account',member.member_account,'domain',COALESCE(binding.domain,''),
                     'publisherNamespaceId',thread.authority_namespace_id,'profileNamespaceId',member.namespace_id,
                     'namespaceId',member.namespace_id,'profileRev',member.profile_rev,'name',member.member_account,'avatarDigest',json('null'),'bio','') END)
                 )
                 FROM members member
                 JOIN threads thread ON thread.user_id=member.user_id AND thread.thread_id=member.thread_id AND thread.kind='GROUP'
                 LEFT JOIN profiles identity
                   ON identity.user_id=member.user_id
                  AND identity.account=member.member_account
                  AND identity.publisher_namespace_id=thread.authority_namespace_id AND identity.profile_namespace_id=member.namespace_id AND identity.profile_rev=member.profile_rev
                 LEFT JOIN profile_namespaces binding
                   ON binding.user_id=member.user_id
                  AND binding.publisher_namespace_id=thread.authority_namespace_id
                  AND binding.profile_namespace_id=member.namespace_id
                 WHERE member.user_id=?1 AND member.thread_id=?2 AND member.left_state=0
                   AND (member.namespace_id,member.member_account)>(?3,?4)
                   AND (?7 IS NULL OR ?8 IS NULL OR NOT
                        (member.member_account=?7 AND member.namespace_id=?8))
                   AND (?5='' OR instr(member_search_key(identity.name),member_search_key(?5))>0
                                OR instr(member_search_key(member.member_account),member_search_key(?5))>0)
                 ORDER BY member.namespace_id,member.member_account LIMIT ?6",
            )
            .map_err(|e| format!("prepare group member page: {e}"))?;
    let rows = statement
        .query_map(
            params![
                user_id,
                thread_id,
                after_namespace,
                after_account,
                search,
                take,
                exclude_account,
                exclude_namespace_id
            ],
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
}

#[cfg(test)]
mod search_tests {
    use super::*;

    #[test]
    fn local_member_search_filters_before_limit_and_joins_only_the_selected_profile() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        super::super::create_cache_schema(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO threads(
          user_id,thread_id,kind,authority_namespace_id,subject_account,thread_feed_id,
          conversation_state,blocked,thread_profile_rev,message_end_seq,tombstone_end_seq,
          join_request_end_feed_id,join_request_read_feed_id,group_invite_end_feed_id,
          server_last_read_seq,announcement_read_feed_id,server_unread_count,local_read_seq)
          VALUES(1,9,'GROUP',7,'!team',1,'ACTIVE',0,0,0,0,0,0,0,0,0,0,0);
          INSERT INTO members(user_id,thread_id,member_account,namespace_id,role,profile_rev)
          VALUES(1,9,'self',0,'OWNER',1),(1,9,'alice',12,'MEMBER',3),
                (1,9,'bob',12,'MEMBER',1);
          INSERT INTO profiles(user_id,publisher_namespace_id,profile_namespace_id,
            account,profile_rev,name,bio)
          VALUES(1,7,12,'alice',3,'Alice in team',''),
                (1,7,12,'alice',4,'Wrong revision',''),
                (1,8,12,'alice',3,'Wrong publisher','');",
        )
        .unwrap();
        let query = |search: &str, take: i64| {
            query_group_members(&conn, 1, 9, "", take, search, Some("self"), Some(0)).unwrap()
        };
        assert_eq!(query("", 1)[0]["account"], "alice");
        assert_eq!(query("IN TEAM", 5)[0]["user"]["name"], "Alice in team");
        assert_eq!(query("BO", 5)[0]["account"], "bob");
        assert!(query("Wrong", 5).is_empty());
        conn.execute("UPDATE profiles SET name='Älice in team' WHERE publisher_namespace_id=7 AND profile_rev=3", []).unwrap();
        assert_eq!(query("äl", 5)[0]["account"], "alice");
        conn.execute(
            "UPDATE members SET left_state=1 WHERE member_account='alice'",
            [],
        )
        .unwrap();
        assert_eq!(query("", 1)[0]["account"], "bob");
        conn.execute_batch(
            "INSERT INTO members(user_id,thread_id,member_account,namespace_id,role)
            VALUES(1,9,'a-z',12,'MEMBER'),(1,9,'a_z',12,'MEMBER');",
        )
        .unwrap();
        let accounts: Vec<String> = query("", 5)
            .iter()
            .map(|member| member["account"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(accounts, vec!["a-z", "a_z", "bob"]);
    }
}
