use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::open;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileNamespacePair {
    publisher_namespace_id: i64,
    profile_namespace_id: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileNamespaceEntry {
    publisher_namespace_id: i64,
    profile_namespace_id: i64,
    domain: Option<String>,
    root_public_key: Option<String>,
    update_feed_id: i64,
    expired: bool,
    status: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileNamespaceBinding {
    publisher_namespace_id: i64,
    profile_namespace_id: i64,
    domain: Option<String>,
    root_public_key: Option<String>,
    update_feed_id: i64,
    change_seq: i64,
    expired: bool,
    status: String,
    refreshed_at: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileNamespaceChange {
    publisher_namespace_id: i64,
    profile_namespace_id: i64,
    change_id: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileTombKey {
    publisher_namespace_id: i64,
    profile_namespace_id: i64,
    account: String,
}

fn validate_pair(pair: &ProfileNamespacePair) -> Result<(), String> {
    if pair.publisher_namespace_id < 0 || pair.profile_namespace_id < 0 {
        return Err("profile namespace pair must be non-negative".into());
    }
    Ok(())
}

fn validate_entry(entry: &ProfileNamespaceEntry) -> Result<(), String> {
    validate_pair(&ProfileNamespacePair {
        publisher_namespace_id: entry.publisher_namespace_id,
        profile_namespace_id: entry.profile_namespace_id,
    })?;
    if entry.update_feed_id < 0 {
        return Err("profile namespace update feed id must be non-negative".into());
    }
    if !matches!(entry.status.as_str(), "ACTIVE" | "ARCHIVED") {
        return Err("invalid profile namespace status".into());
    }
    if entry.domain.as_deref() == Some("") {
        return Err("profile namespace domain must be null or non-empty".into());
    }
    if entry.root_public_key.as_deref() == Some("") {
        return Err("profile namespace root public key must be null or non-empty".into());
    }
    Ok(())
}

fn read_bindings(
    conn: &Connection,
    user_id: i64,
    pairs: &[ProfileNamespacePair],
) -> Result<Vec<ProfileNamespaceBinding>, String> {
    let mut rows = Vec::with_capacity(pairs.len());
    for pair in pairs {
        validate_pair(pair)?;
        let binding = conn
            .query_row(
                "SELECT domain,root_public_key,update_feed_id,change_seq,expired,status,refreshed_at
                 FROM profile_namespaces
                 WHERE user_id=?1 AND publisher_namespace_id=?2 AND profile_namespace_id=?3",
                params![
                    user_id,
                    pair.publisher_namespace_id,
                    pair.profile_namespace_id
                ],
                |row| {
                    Ok(ProfileNamespaceBinding {
                        publisher_namespace_id: pair.publisher_namespace_id,
                        profile_namespace_id: pair.profile_namespace_id,
                        domain: row.get(0)?,
                        root_public_key: row.get(1)?,
                        update_feed_id: row.get(2)?,
                        change_seq: row.get(3)?,
                        expired: row.get(4)?,
                        status: row.get(5)?,
                        refreshed_at: row.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(|error| format!("read profile namespace binding: {error}"))?;
        if let Some(binding) = binding {
            rows.push(binding);
        }
    }
    Ok(rows)
}

fn commit_bindings(
    conn: &mut Connection,
    user_id: i64,
    entries: &[ProfileNamespaceEntry],
    round_end: i64,
    refreshed_at: i64,
) -> Result<(), String> {
    if round_end < 0 {
        return Err("profile namespace round end must be non-negative".into());
    }
    for entry in entries {
        validate_entry(entry)?;
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("begin profile namespace binding commit: {error}"))?;
    for entry in entries {
        tx.execute(
            "INSERT INTO profile_namespaces(
               user_id,publisher_namespace_id,profile_namespace_id,domain,root_public_key,
               update_feed_id,change_seq,expired,status,refreshed_at
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
             ON CONFLICT(user_id,publisher_namespace_id,profile_namespace_id) DO UPDATE SET
               domain=excluded.domain,
               root_public_key=excluded.root_public_key,
               update_feed_id=excluded.update_feed_id,
               change_seq=MAX(profile_namespaces.change_seq,excluded.change_seq),
               expired=excluded.expired,
               status=excluded.status,
               refreshed_at=excluded.refreshed_at
             WHERE profile_namespaces.change_seq <= excluded.change_seq
               AND profile_namespaces.update_feed_id <= excluded.update_feed_id",
            params![
                user_id,
                entry.publisher_namespace_id,
                entry.profile_namespace_id,
                entry.domain,
                entry.root_public_key,
                entry.update_feed_id,
                round_end,
                entry.expired,
                entry.status,
                refreshed_at,
            ],
        )
        .map_err(|error| format!("commit profile namespace binding: {error}"))?;
    }
    tx.commit()
        .map_err(|error| format!("finish profile namespace binding commit: {error}"))
}

fn apply_changes(
    conn: &mut Connection,
    user_id: i64,
    items: &[ProfileNamespaceChange],
) -> Result<Vec<ProfileNamespacePair>, String> {
    for item in items {
        validate_pair(&ProfileNamespacePair {
            publisher_namespace_id: item.publisher_namespace_id,
            profile_namespace_id: item.profile_namespace_id,
        })?;
        if item.change_id < 0 {
            return Err("profile namespace change id must be non-negative".into());
        }
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("begin profile namespace change commit: {error}"))?;
    let mut touched = Vec::with_capacity(items.len());
    for item in items {
        let changed = tx
            .execute(
                "INSERT INTO profile_namespaces(
                   user_id,publisher_namespace_id,profile_namespace_id,domain,root_public_key,
                   update_feed_id,change_seq,expired,status,refreshed_at
                 ) VALUES(?1,?2,?3,NULL,NULL,0,?4,1,'ACTIVE',0)
                 ON CONFLICT(user_id,publisher_namespace_id,profile_namespace_id) DO UPDATE SET
                   change_seq=excluded.change_seq,expired=1
                 WHERE profile_namespaces.change_seq < excluded.change_seq
                    OR (profile_namespaces.change_seq = excluded.change_seq
                        AND profile_namespaces.expired = 0)",
                params![
                    user_id,
                    item.publisher_namespace_id,
                    item.profile_namespace_id,
                    item.change_id,
                ],
            )
            .map_err(|error| format!("apply profile namespace change: {error}"))?;
        if changed != 0 {
            touched.push(ProfileNamespacePair {
                publisher_namespace_id: item.publisher_namespace_id,
                profile_namespace_id: item.profile_namespace_id,
            });
        }
    }
    tx.commit()
        .map_err(|error| format!("finish profile namespace change commit: {error}"))?;
    Ok(touched)
}

fn write_namespace_tomb(
    conn: &Connection,
    user_id: i64,
    pair: &ProfileNamespacePair,
    created_at: i64,
) -> Result<(), String> {
    validate_pair(pair)?;
    conn.execute(
        "INSERT INTO profile_namespace_tombs(
           user_id,publisher_namespace_id,profile_namespace_id,created_at
         ) VALUES(?1,?2,?3,?4)
         ON CONFLICT(user_id,publisher_namespace_id,profile_namespace_id) DO UPDATE SET
           created_at=MAX(profile_namespace_tombs.created_at,excluded.created_at)",
        params![
            user_id,
            pair.publisher_namespace_id,
            pair.profile_namespace_id,
            created_at
        ],
    )
    .map_err(|error| format!("write profile namespace tomb: {error}"))?;
    Ok(())
}

fn write_profile_tomb(
    conn: &Connection,
    user_id: i64,
    key: &ProfileTombKey,
    created_at: i64,
) -> Result<(), String> {
    validate_pair(&ProfileNamespacePair {
        publisher_namespace_id: key.publisher_namespace_id,
        profile_namespace_id: key.profile_namespace_id,
    })?;
    if key.account.is_empty() {
        return Err("profile tomb account must be non-empty".into());
    }
    conn.execute(
        "INSERT INTO profile_tombs(
           user_id,publisher_namespace_id,profile_namespace_id,account,created_at
         ) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(user_id,publisher_namespace_id,profile_namespace_id,account) DO UPDATE SET
           created_at=MAX(profile_tombs.created_at,excluded.created_at)",
        params![
            user_id,
            key.publisher_namespace_id,
            key.profile_namespace_id,
            key.account,
            created_at
        ],
    )
    .map_err(|error| format!("write profile tomb: {error}"))?;
    Ok(())
}

/// Read the display domain for one exact namespace binding. Domain is nullable
/// because unresolved and archived bindings may legitimately have no display value.
pub(super) fn display_domain(
    conn: &Connection,
    user_id: i64,
    publisher_namespace_id: i64,
    profile_namespace_id: i64,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT domain FROM profile_namespaces
         WHERE user_id=?1 AND publisher_namespace_id=?2 AND profile_namespace_id=?3",
        params![user_id, publisher_namespace_id, profile_namespace_id],
        |row| row.get(0),
    )
    .optional()
    .map(|domain| domain.flatten().filter(|value: &String| !value.is_empty()))
    .map_err(|error| format!("read profile namespace display domain: {error}"))
}

#[tauri::command]
pub(crate) async fn native_db_profile_namespace_bindings(
    user_id: i64,
    pairs: Vec<ProfileNamespacePair>,
) -> Result<Vec<ProfileNamespaceBinding>, String> {
    super::lifetime::spawn(move || read_bindings(&open()?, user_id, &pairs))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn native_db_commit_profile_namespace_bindings(
    user_id: i64,
    entries: Vec<ProfileNamespaceEntry>,
    round_end: i64,
) -> Result<(), String> {
    super::lifetime::spawn(move || {
        commit_bindings(
            &mut open()?,
            user_id,
            &entries,
            round_end,
            super::client_state::chrono_millis(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn native_db_apply_profile_namespace_changes(
    user_id: i64,
    items: Vec<ProfileNamespaceChange>,
) -> Result<Vec<ProfileNamespacePair>, String> {
    super::lifetime::spawn(move || apply_changes(&mut open()?, user_id, &items))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn native_db_write_profile_namespace_tomb(
    user_id: i64,
    pair: ProfileNamespacePair,
) -> Result<(), String> {
    super::lifetime::spawn(move || {
        write_namespace_tomb(
            &open()?,
            user_id,
            &pair,
            super::client_state::chrono_millis(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn native_db_write_profile_tomb(
    user_id: i64,
    key: ProfileTombKey,
) -> Result<(), String> {
    super::lifetime::spawn(move || {
        write_profile_tomb(
            &open()?,
            user_id,
            &key,
            super::client_state::chrono_millis(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE profile_namespaces (
               user_id INTEGER NOT NULL,
               publisher_namespace_id INTEGER NOT NULL,
               profile_namespace_id INTEGER NOT NULL,
               domain TEXT,
               root_public_key TEXT,
               update_feed_id INTEGER NOT NULL,
               change_seq INTEGER NOT NULL,
               expired INTEGER NOT NULL CHECK(expired IN (0,1)),
               status TEXT NOT NULL CHECK(status IN ('ACTIVE','ARCHIVED')),
               refreshed_at INTEGER NOT NULL,
               PRIMARY KEY(user_id,publisher_namespace_id,profile_namespace_id)
             );
             CREATE TABLE profile_namespace_tombs (
               user_id INTEGER NOT NULL,
               publisher_namespace_id INTEGER NOT NULL,
               profile_namespace_id INTEGER NOT NULL,
               created_at INTEGER NOT NULL,
               PRIMARY KEY(user_id,publisher_namespace_id,profile_namespace_id)
             );
             CREATE TABLE profile_tombs (
               user_id INTEGER NOT NULL,
               publisher_namespace_id INTEGER NOT NULL,
               profile_namespace_id INTEGER NOT NULL,
               account TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               PRIMARY KEY(user_id,publisher_namespace_id,profile_namespace_id,account)
             );
             CREATE TABLE profiles (
               user_id INTEGER NOT NULL,
               publisher_namespace_id INTEGER NOT NULL,
               profile_namespace_id INTEGER NOT NULL,
               account TEXT NOT NULL,
               profile_rev INTEGER NOT NULL,
               name TEXT NOT NULL,
               avatar_digest TEXT,
               bio TEXT NOT NULL,
               PRIMARY KEY(user_id,publisher_namespace_id,profile_namespace_id,account,profile_rev)
             );",
        )
        .unwrap();
        conn
    }

    fn entry(publisher: i64, profile: i64, domain: &str, feed: i64) -> ProfileNamespaceEntry {
        ProfileNamespaceEntry {
            publisher_namespace_id: publisher,
            profile_namespace_id: profile,
            domain: Some(domain.into()),
            root_public_key: Some(format!("key-{publisher}-{profile}")),
            update_feed_id: feed,
            expired: false,
            status: "ACTIVE".into(),
        }
    }

    #[test]
    fn native_profile_namespace_bindings_keep_exact_pairs_and_real_domains() {
        let mut conn = database();
        commit_bindings(
            &mut conn,
            1,
            &[
                entry(0, 0, "chat.example.test", 3),
                entry(7, 0, "shared.example.test", 4),
                entry(8, 2, "shared.example.test", 5),
            ],
            9,
            100,
        )
        .unwrap();
        let rows = read_bindings(
            &conn,
            1,
            &[
                ProfileNamespacePair {
                    publisher_namespace_id: 0,
                    profile_namespace_id: 0,
                },
                ProfileNamespacePair {
                    publisher_namespace_id: 8,
                    profile_namespace_id: 2,
                },
            ],
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].domain.as_deref(), Some("chat.example.test"));
        assert_eq!(rows[1].domain.as_deref(), Some("shared.example.test"));
    }

    #[test]
    fn native_profile_namespace_binding_rejects_older_coordinates() {
        let mut conn = database();
        commit_bindings(&mut conn, 1, &[entry(7, 2, "new.test", 8)], 10, 100).unwrap();
        commit_bindings(&mut conn, 1, &[entry(7, 2, "old-change.test", 9)], 9, 200).unwrap();
        commit_bindings(&mut conn, 1, &[entry(7, 2, "old-feed.test", 7)], 10, 300).unwrap();
        let current = read_bindings(
            &conn,
            1,
            &[ProfileNamespacePair {
                publisher_namespace_id: 7,
                profile_namespace_id: 2,
            }],
        )
        .unwrap()
        .remove(0);
        assert_eq!(current.domain.as_deref(), Some("new.test"));
        assert_eq!((current.change_seq, current.update_feed_id), (10, 8));

        commit_bindings(&mut conn, 1, &[entry(7, 2, "equal.test", 8)], 10, 400).unwrap();
        let equal = read_bindings(
            &conn,
            1,
            &[ProfileNamespacePair {
                publisher_namespace_id: 7,
                profile_namespace_id: 2,
            }],
        )
        .unwrap()
        .remove(0);
        assert_eq!(equal.domain.as_deref(), Some("equal.test"));
        assert_eq!(equal.refreshed_at, 400);
    }

    #[test]
    fn native_profile_namespace_archives_without_losing_binding() {
        let mut conn = database();
        let mut archived = entry(7, 2, "archive.example.test", 8);
        archived.status = "ARCHIVED".into();
        commit_bindings(&mut conn, 1, &[archived], 10, 100).unwrap();
        let row = read_bindings(
            &conn,
            1,
            &[ProfileNamespacePair {
                publisher_namespace_id: 7,
                profile_namespace_id: 2,
            }],
        )
        .unwrap()
        .remove(0);
        assert_eq!(row.status, "ARCHIVED");
        assert!(!row.expired);
        assert_eq!(row.domain.as_deref(), Some("archive.example.test"));
        assert_eq!(row.root_public_key.as_deref(), Some("key-7-2"));
    }

    #[test]
    fn native_profile_namespace_changes_expire_only_current_or_newer_rows() {
        let mut conn = database();
        commit_bindings(&mut conn, 1, &[entry(7, 2, "current.test", 8)], 10, 100).unwrap();
        let stale = apply_changes(
            &mut conn,
            1,
            &[ProfileNamespaceChange {
                publisher_namespace_id: 7,
                profile_namespace_id: 2,
                change_id: 9,
            }],
        )
        .unwrap();
        assert!(stale.is_empty());
        let touched = apply_changes(
            &mut conn,
            1,
            &[ProfileNamespaceChange {
                publisher_namespace_id: 7,
                profile_namespace_id: 2,
                change_id: 11,
            }],
        )
        .unwrap();
        assert_eq!(touched.len(), 1);
        let row = read_bindings(
            &conn,
            1,
            &[ProfileNamespacePair {
                publisher_namespace_id: 7,
                profile_namespace_id: 2,
            }],
        )
        .unwrap()
        .remove(0);
        assert!(row.expired);
        assert_eq!(row.change_seq, 11);
        assert_eq!(row.domain.as_deref(), Some("current.test"));
        let replay = apply_changes(
            &mut conn,
            1,
            &[ProfileNamespaceChange {
                publisher_namespace_id: 7,
                profile_namespace_id: 2,
                change_id: 11,
            }],
        )
        .unwrap();
        assert!(replay.is_empty());
    }

    #[test]
    fn native_profile_tombs_are_sparse_and_do_not_delete_cached_content() {
        let mut conn = database();
        commit_bindings(&mut conn, 1, &[entry(7, 2, "current.test", 8)], 10, 100).unwrap();
        conn.execute(
            "INSERT INTO profiles VALUES(1,7,2,'alice',3,'Alice',NULL,'bio')",
            [],
        )
        .unwrap();
        let pair = ProfileNamespacePair {
            publisher_namespace_id: 7,
            profile_namespace_id: 2,
        };
        write_namespace_tomb(&conn, 1, &pair, 200).unwrap();
        write_profile_tomb(
            &conn,
            1,
            &ProfileTombKey {
                publisher_namespace_id: 7,
                profile_namespace_id: 2,
                account: "alice".into(),
            },
            200,
        )
        .unwrap();
        write_profile_tomb(
            &conn,
            1,
            &ProfileTombKey {
                publisher_namespace_id: 7,
                profile_namespace_id: 2,
                account: "alice".into(),
            },
            100,
        )
        .unwrap();
        let counts: (i64, i64, i64) = conn
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM profile_namespaces),
                   (SELECT COUNT(*) FROM profiles),
                   (SELECT created_at FROM profile_tombs)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(counts, (1, 1, 200));
    }
}
