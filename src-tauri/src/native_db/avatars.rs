use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use super::{chrono_millis, open};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_avatar_read_preserves_bytes_and_isolates_accounts() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE avatars(user_id INTEGER,identity TEXT,source_path TEXT,mime TEXT,data BLOB,last_render INTEGER);").unwrap();
        let bytes = vec![0_u8, 128, 255, 17];
        conn.execute(
            "INSERT INTO avatars VALUES(1,'peer','/avatar','image/png',?1,0)",
            [&bytes],
        )
        .unwrap();
        let avatar = read_avatar(&conn, 1, "peer").unwrap().unwrap();
        assert_eq!(avatar.data, bytes);
        assert_eq!(avatar.mime, "image/png");
        assert!(read_avatar(&conn, 2, "peer").unwrap().is_none());
        assert!(read_avatar(&conn, 1, "missing").unwrap().is_none());
        let touched: i64 = conn
            .query_row("SELECT last_render FROM avatars", [], |row| row.get(0))
            .unwrap();
        assert!(touched > 0);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeAvatar {
    identity: String,
    path: String,
    mime: String,
    pub(super) data: Vec<u8>,
    last_render: i64,
}

/// Shared by renderer commands and native notification assembly.
pub(super) fn read_avatar(
    conn: &rusqlite::Connection,
    user_id: i64,
    identity: &str,
) -> Result<Option<NativeAvatar>, String> {
    let avatar = conn
        .query_row(
            "SELECT source_path, mime, data, last_render FROM avatars
             WHERE user_id = ?1 AND identity = ?2",
            params![user_id, identity],
            |row| {
                Ok(NativeAvatar {
                    identity: identity.to_owned(),
                    path: row.get(0)?,
                    mime: row.get(1)?,
                    data: row.get(2)?,
                    last_render: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("get avatar: {e}"))?;
    if avatar.is_some() {
        conn.execute(
            "UPDATE avatars SET last_render = ?3 WHERE user_id = ?1 AND identity = ?2",
            params![user_id, identity, chrono_millis()],
        )
        .map_err(|e| format!("touch avatar: {e}"))?;
    }
    Ok(avatar)
}

#[cfg(any(target_os = "android", test))]
pub(super) fn read_avatar_by_source(
    conn: &rusqlite::Connection,
    user_id: i64,
    source: &str,
) -> Result<Option<NativeAvatar>, String> {
    let identity: Option<String> = conn.query_row(
        "SELECT identity FROM avatars WHERE user_id=?1 AND source_path=?2 ORDER BY last_render DESC LIMIT 1",
        params![user_id, source], |row| row.get(0),
    ).optional().map_err(|e| format!("resolve cached avatar: {e}"))?;
    identity
        .map(|identity| read_avatar(conn, user_id, &identity))
        .transpose()
        .map(Option::flatten)
}

#[tauri::command]
pub(crate) async fn native_db_get_avatar(
    user_id: i64,
    identity: String,
) -> Result<Option<NativeAvatar>, String> {
    super::lifetime::spawn(move || {
        let conn = open()?;
        read_avatar(&conn, user_id, &identity)
    })
    .await
    .map_err(|e| format!("join avatar read: {e}"))?
}

#[tauri::command]
pub(crate) async fn native_db_put_avatar(
    user_id: i64,
    identity: String,
    path: String,
    mime: String,
    data: Vec<u8>,
    last_render: i64,
) -> Result<(), String> {
    super::lifetime::spawn(move || {
        open()?
            .execute(
                "INSERT INTO avatars(user_id, identity, source_path, mime, data, last_render)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(user_id, identity) DO UPDATE SET
                   source_path = excluded.source_path,
                   mime = excluded.mime,
                   data = excluded.data,
                   last_render = excluded.last_render",
                params![user_id, identity, path, mime, data, last_render],
            )
            .map_err(|e| format!("put avatar: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("join avatar write: {e}"))?
}
