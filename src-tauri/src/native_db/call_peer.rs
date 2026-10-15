use base64::Engine;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use super::{contacts, profile_avatars};
#[cfg(target_os = "android")]
use super::{lifetime::CACHE_LIFETIME, open};

/// Resolve only the exact P2P identity selected by this local thread. The Android call surface
/// must never open the Rust-owned SQLite file with the OS SQLite library, which may be older.
/// The display name follows the shared ordering (the same chain as the web `displayThreadName`):
/// thread alias → cached profile name → cached thread peer name → account; the result is non-empty.
#[cfg(target_os = "android")]
pub(crate) fn read_call_peer(
    user_id: i64,
    thread_id: i64,
    account: &str,
    namespace_id: i64,
) -> Result<Option<Value>, String> {
    if user_id <= 0 || thread_id <= 0 {
        return Ok(None);
    }
    let epoch = CACHE_LIFETIME.capture()?;
    let _guard = CACHE_LIFETIME.admit(epoch)?;
    read_call_peer_from_connection(&open()?, user_id, thread_id, account, namespace_id)
}

fn read_call_peer_from_connection(
    conn: &rusqlite::Connection,
    user_id: i64,
    thread_id: i64,
    account: &str,
    namespace_id: i64,
) -> Result<Option<Value>, String> {
    let Some(thread) = super::thread_store::read(conn, user_id, thread_id)? else {
        return Ok(None);
    };
    let peer = &thread["peerUser"];
    if thread["type"] != "P2P" {
        return Ok(None);
    }
    let local_account = peer["account"]
        .as_str()
        .ok_or("call peer account missing")?;
    let local_namespace_id = peer["namespaceId"]
        .as_i64()
        .ok_or("call peer namespace missing")?;
    // Supplied coordinates are consistency checks against the owner-scoped thread record, never an
    // override of cached identity. An empty account or a negative namespace id means "not supplied"
    // (HELLO recovery may omit them); the cached thread record then supplies identity on its own.
    if (!account.is_empty() && account != local_account)
        || (namespace_id >= 0 && namespace_id != local_namespace_id)
    {
        return Ok(None);
    }
    let account = local_account;
    let namespace_id = local_namespace_id;
    let profile_rev: i64 = conn
        .query_row(
            "SELECT thread_profile_rev FROM threads
         WHERE user_id=?1 AND thread_id=?2 AND kind='P2P'
           AND subject_account=?3 AND subject_namespace_id=?4",
            params![user_id, thread_id, account, namespace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("read call peer revision: {e}"))?
        .ok_or("call peer thread state missing")?;
    let profile = if profile_rev > 0 {
        contacts::read_profile(
            &conn,
            user_id,
            namespace_id,
            namespace_id,
            account,
            profile_rev,
        )?
    } else {
        None
    };
    let name = thread["alias"]
        .as_str()
        .filter(|alias| !alias.is_empty())
        .or_else(|| {
            profile
                .as_ref()
                .and_then(|value| value["name"].as_str())
                .filter(|name| !name.is_empty())
        })
        .or_else(|| peer["name"].as_str().filter(|name| !name.is_empty()))
        .unwrap_or(account);
    let avatar = profile
        .as_ref()
        .and_then(|value| value["avatarDigest"].as_str())
        .map(|digest| profile_avatars::read(user_id, digest))
        .transpose()?
        .flatten()
        .and_then(|bytes| {
            let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                "image/png"
            } else if bytes.starts_with(b"\xff\xd8\xff") {
                "image/jpeg"
            } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
                "image/webp"
            } else {
                return None;
            };
            Some(format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ))
        })
        .or_else(|| {
            peer["avatar"]
                .as_str()
                .filter(|url| url.starts_with("data:image/") && url.contains(";base64,"))
                .map(str::to_owned)
        });
    Ok(Some(json!({ "name": name, "avatarDataUrl": avatar })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn call_peer_is_scoped_to_thread_owner_and_exact_address() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE profile_namespaces(user_id INTEGER,publisher_namespace_id INTEGER,
               profile_namespace_id INTEGER,domain TEXT,
               PRIMARY KEY(user_id,publisher_namespace_id,profile_namespace_id));
             INSERT INTO profile_namespaces VALUES(41,1,1,'remote.test');",
        )
        .unwrap();
        conn.execute_batch(super::super::thread_store::SCHEMA)
            .unwrap();
        super::super::thread_store::write(
            &conn,
            41,
            7,
            &json!({
                "threadId":7,"type":"P2P","authorityNamespaceId":1,
                "peerUser":{"account":"bob","namespaceId":1,"name":"Bob"},
                "threadFeedId":1,"conversationState":"ACTIVE","blocked":false,"alias":null,
                "threadProfileRev":0,"messageEndSeq":0,"tombstoneEndSeq":0,
                "groupMetaFeedEndId":null,"joinRequestEndFeedId":0,"joinRequestReadFeedId":0,
                "groupInviteEndFeedId":0,"serverLastReadSeq":0,"announcementReadFeedId":0,
                "serverUnreadCount":0,"lastMentionSeq":null,"localReadSeq":0
            }),
        )
        .unwrap();
        assert_eq!(
            read_call_peer_from_connection(&conn, 41, 7, "bob", 1)
                .unwrap()
                .unwrap()["name"],
            "Bob"
        );
        assert_eq!(
            read_call_peer_from_connection(&conn, 41, 7, "", -1)
                .unwrap()
                .unwrap()["name"],
            "Bob",
        );
        assert!(read_call_peer_from_connection(&conn, 41, 7, "alice", -1)
            .unwrap()
            .is_none());
        assert!(read_call_peer_from_connection(&conn, 42, 7, "", -1)
            .unwrap()
            .is_none());
        assert!(read_call_peer_from_connection(&conn, 41, 7, "bob", 2)
            .unwrap()
            .is_none());
        assert!(read_call_peer_from_connection(&conn, 42, 7, "bob", 1)
            .unwrap()
            .is_none());
    }

    #[test]
    fn call_peer_name_prefers_alias_over_profile_and_account() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE profile_namespaces(user_id INTEGER,publisher_namespace_id INTEGER,
               profile_namespace_id INTEGER,domain TEXT,
               PRIMARY KEY(user_id,publisher_namespace_id,profile_namespace_id));",
        )
        .unwrap();
        conn.execute_batch(super::super::thread_store::SCHEMA)
            .unwrap();
        let thread = json!({
            "threadId":7,"type":"P2P","authorityNamespaceId":1,
            "peerUser":{"account":"bob","namespaceId":1,"name":"Cached Bob"},
            "threadFeedId":1,"conversationState":"ACTIVE","blocked":false,"alias":null,
            "threadProfileRev":0,"messageEndSeq":0,"tombstoneEndSeq":0,
            "groupMetaFeedEndId":null,"joinRequestEndFeedId":0,"joinRequestReadFeedId":0,
            "groupInviteEndFeedId":0,"serverLastReadSeq":0,"announcementReadFeedId":0,
            "serverUnreadCount":0,"lastMentionSeq":null,"localReadSeq":0
        });
        super::super::thread_store::write(&conn, 41, 7, &thread).unwrap();
        // No profile and no alias: the cached thread name, then the account, are the fallbacks.
        assert_eq!(
            read_call_peer_from_connection(&conn, 41, 7, "", -1)
                .unwrap()
                .unwrap()["name"],
            "Cached Bob"
        );
        let mut aliased = thread.clone();
        aliased["alias"] = json!("Best Friend");
        // `write` upserts server facts; alias is client-owned state written by the attention layer.
        super::super::thread_store::write(&conn, 41, 7, &aliased).unwrap();
        conn.execute(
            "UPDATE threads SET alias='Best Friend' WHERE user_id=41 AND thread_id=7",
            [],
        )
        .unwrap();
        assert_eq!(
            read_call_peer_from_connection(&conn, 41, 7, "", -1)
                .unwrap()
                .unwrap()["name"],
            "Best Friend"
        );
    }
}
