use super::*;
use crate::login_connection::LoginConnection;
use crate::login_session_store::LoginSessionId;
use futures_util::FutureExt;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// All drains in this file target one thread id because the open-thread guard is a process
/// static and tests run concurrently: every observation stays `Some(THREAD_ID)`.
const THREAD_ID: i64 = 52;

fn sentinel(repair: bool) -> &'static str {
    if repair {
        "native cache work superseded"
    } else {
        "native login superseded"
    }
}

fn origins(proxy: &ServerSessionState, origin: &str) {
    *proxy.api_origin.lock().unwrap() = origin.into();
    *proxy.api_origin_primary.lock().unwrap() = origin.into();
    *proxy.api_origin_secondary.lock().unwrap() = None;
}

fn seed_group_thread(conn: &mut Connection, user_id: i64, meta_end: &str) {
    let tx = conn.transaction().unwrap();
    let snapshot = serde_json::from_value::<super::super::attention::ThreadFeedSnapshot>(json!({
        "type": "GROUP", "threadId": THREAD_ID, "publisherNamespaceId": 0,
        "selfMentionNamespaceId": 0, "conversationState": "ACTIVE", "blocked": false,
        "role": "MEMBER", "profileAccount": "!dev", "profileRev": 3,
        "threadFeedId": 5, "alias": null, "messageEndSeq": 0, "tombstoneEndSeq": 0,
        "groupMetaFeedEndId": meta_end, "joinRequestEndFeedId": 0,
        "joinRequestReadFeedId": -1, "groupInviteEndFeedId": 0, "lastReadSeq": 0,
        "announcementReadFeedId": 0, "unreadCount": 0, "lastMentionSeq": null,
        "previews": [],
    }))
    .unwrap();
    super::super::client_state::ensure_thread_identity(&tx, user_id, &snapshot).unwrap();
    tx.commit().unwrap();
}

fn fixture(proxy: &ServerSessionState, group: bool) -> FeedIntent {
    let mut database = Connection::open_in_memory().unwrap();
    crate::native_db::create_cache_schema(&database).unwrap();
    if group {
        seed_group_thread(&mut database, 42, "2");
        database
            .execute_batch(
                "CREATE TEMP TABLE meta_cursor_proof(value TEXT);
                 CREATE TEMP TRIGGER meta_cursor_connection_proof
                 AFTER UPDATE OF feed_id ON main.group_meta
                 BEGIN INSERT INTO meta_cursor_proof VALUES(NEW.feed_id); END;
                 CREATE TEMP TABLE profile_proof(account TEXT);
                 CREATE TEMP TRIGGER profile_connection_proof AFTER INSERT ON main.profiles
                 BEGIN INSERT INTO profile_proof VALUES(NEW.account); END;",
            )
            .unwrap();
    } else {
        seed_p2p_thread(&mut database, 42, 5);
        database
            .execute_batch(
                "CREATE TEMP TABLE tombstone_proof(kind TEXT);
                 CREATE TEMP TRIGGER tombstone_message_proof AFTER INSERT ON main.messages
                 BEGIN INSERT INTO tombstone_proof VALUES('message'); END;
                 CREATE TEMP TRIGGER tombstone_hwm_proof AFTER INSERT ON main.thread_sync_state
                 BEGIN INSERT INTO tombstone_proof VALUES('hwm'); END;",
            )
            .unwrap();
    }
    let owner = LoginConnection::preparing(
        LoginSessionId::try_from(uuid::Uuid::new_v4().to_string()).unwrap(),
        database,
    );
    owner
        .begin_activation()
        .unwrap()
        .commit("drain-token".into())
        .unwrap();
    FeedIntent::from_parts(
        42,
        owner.capture_database_work().unwrap(),
        LoginRequest::capture(proxy, owner.clone()).unwrap(),
    )
    .unwrap()
}

fn close(intent: &FeedIntent) {
    intent.work.owner().end().unwrap();
    intent.work.owner().close().unwrap();
}

async fn read_request(socket: &mut TcpStream) -> (String, Value) {
    let mut bytes = Vec::new();
    let header_end = loop {
        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            break end + 4;
        }
        let mut buffer = [0; 1024];
        let count = socket.read(&mut buffer).await.unwrap();
        assert_ne!(count, 0);
        bytes.extend_from_slice(&buffer[..count]);
    };
    let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
    let length: usize = headers
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| value.trim().parse().unwrap())
        .unwrap_or(0);
    while bytes.len() < header_end + length {
        let mut buffer = [0; 1024];
        let count = socket.read(&mut buffer).await.unwrap();
        assert_ne!(count, 0);
        bytes.extend_from_slice(&buffer[..count]);
    }
    (
        headers,
        if length == 0 {
            Value::Null
        } else {
            serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap()
        },
    )
}

async fn respond(socket: &mut TcpStream, body: Value) {
    let body = body.to_string();
    socket
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
}

fn group_meta_page(scanned: &str, has_more: bool, items: Value) -> Value {
    json!({"code": 0, "data": {
        "account": "!dev", "mode": "full", "items": items,
        "scannedThrough": scanned, "groupMetaFeedEndId": "2", "hasMore": has_more,
    }})
}

/// A drain scheduled but not yet polled must fail on its first poll after the login ended or
/// its cache view was invalidated; it cannot read plans, commit pages or adopt a successor.
fn seed_p2p_thread(conn: &mut Connection, user_id: i64, tombstone_end: i64) {
    let tx = conn.transaction().unwrap();
    let snapshot = serde_json::from_value::<super::super::attention::ThreadFeedSnapshot>(json!({
        "type": "P2P", "threadId": THREAD_ID, "publisherNamespaceId": 0,
        "selfMentionNamespaceId": 0, "conversationState": "ACTIVE", "blocked": false,
        "role": null, "profileAccount": "bob", "profileRev": 1,
        "threadFeedId": 5, "alias": null, "messageEndSeq": 0,
        "tombstoneEndSeq": tombstone_end, "groupMetaFeedEndId": null,
        "joinRequestEndFeedId": 0,
        "joinRequestReadFeedId": -1, "groupInviteEndFeedId": 0, "lastReadSeq": 0,
        "announcementReadFeedId": 0, "unreadCount": 0, "lastMentionSeq": null,
        "previews": [],
    }))
    .unwrap();
    super::super::client_state::ensure_thread_identity(&tx, user_id, &snapshot).unwrap();
    tx.commit().unwrap();
}

#[tokio::test]
async fn delayed_drain_futures_reject_end_and_repair_before_any_work() {
    for repair in [false, true] {
        let proxy = ServerSessionState::new();
        let intent = fixture(&proxy, true);
        OPEN_THREAD_ID.store(THREAD_ID, std::sync::atomic::Ordering::Release);
        let group = Box::pin(sync_group_meta_thread(intent.clone(), THREAD_ID));
        let mut tombstone_intent = intent.clone();
        let tombstone = Box::pin(sync_tombstone_thread(&mut tombstone_intent, THREAD_ID));
        if repair {
            intent.work.owner().invalidate_database_work().unwrap();
        } else {
            intent.work.owner().end().unwrap();
        }
        let (changed, patches, error) = group.await;
        assert_eq!(error.as_deref(), Some(sentinel(repair)));
        assert!(changed.is_empty());
        assert!(patches.is_empty());
        assert_eq!(tombstone.await.unwrap_err(), sentinel(repair));
        let successor = fixture(&proxy, true);
        assert_eq!(
            successor
                .work
                .owner()
                .with_database(|conn| {
                    let (feed, members): (String, i64) = conn
                        .query_row(
                            "SELECT feed_id,
                                    (SELECT COUNT(*) FROM members
                                     WHERE user_id=42 AND thread_id=?1)
                             FROM group_meta WHERE user_id=42 AND thread_id=?1",
                            [THREAD_ID],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .map_err(|e| e.to_string())?;
                    Ok::<_, String>((feed, members))
                })
                .unwrap(),
            ("0".to_string(), 0)
        );
        close(&intent);
        close(&successor);
    }
}

/// A stalled Group Meta or tombstone response must close its actual socket when the login
/// ends or same-login repair supersedes the captured cache view.
#[tokio::test]
async fn stalled_drain_sockets_close_on_end_or_repair() {
    for group in [true, false] {
        for repair in [false, true] {
            let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let proxy = ServerSessionState::new();
            origins(&proxy, &format!("http://{}", server.local_addr().unwrap()));
            let intent = fixture(&proxy, group);
            OPEN_THREAD_ID.store(THREAD_ID, std::sync::atomic::Ordering::Release);
            let (started, ready) = tokio::sync::oneshot::channel();
            let expected = if group {
                "GET /api/v1/user/group-meta?threadId=52&mode=full&after=0&take=100&through=2 HTTP/1.1\r\n"
            } else {
                "POST /api/v1/deleted-messages/query HTTP/1.1\r\n"
            };
            let serving = tokio::spawn(async move {
                let (mut socket, _) = server.accept().await.unwrap();
                let (headers, _) = read_request(&mut socket).await;
                assert!(headers.starts_with(expected));
                assert!(headers
                    .to_ascii_lowercase()
                    .contains("authorization: bearer drain-token\r\n"));
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{",
                    )
                    .await
                    .unwrap();
                started.send(()).unwrap();
                let mut byte = [0; 1];
                let count = tokio::time::timeout(Duration::from_secs(2), socket.read(&mut byte))
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(count, 0, "cancelled drain must close its TCP connection");
            });
            let owner = intent.work.owner().clone();
            let error = if group {
                let moved = intent.clone();
                let pending =
                    tokio::spawn(async move { sync_group_meta_thread(moved, THREAD_ID).await });
                tokio::time::timeout(Duration::from_secs(2), ready)
                    .await
                    .unwrap()
                    .unwrap();
                if repair {
                    owner.invalidate_database_work().unwrap();
                } else {
                    owner.end().unwrap();
                }
                tokio::time::timeout(Duration::from_secs(2), pending)
                    .await
                    .unwrap()
                    .unwrap()
                    .2
                    .unwrap()
            } else {
                let mut moved = intent.clone();
                let pending =
                    tokio::spawn(async move { sync_tombstone_thread(&mut moved, THREAD_ID).await });
                tokio::time::timeout(Duration::from_secs(2), ready)
                    .await
                    .unwrap()
                    .unwrap();
                if repair {
                    owner.invalidate_database_work().unwrap();
                } else {
                    owner.end().unwrap();
                }
                tokio::time::timeout(Duration::from_secs(2), pending)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap_err()
            };
            assert_eq!(error, sentinel(repair));
            serving.await.unwrap();
            close(&intent);
        }
    }
}

/// A Group Meta page commit queued behind maintenance rejects repair or logout without
/// applying its roster, cursor or patch, and a successor cache keeps its seeded state.
#[tokio::test]
async fn a_queued_group_meta_page_commit_rejects_end_or_repair() {
    for repair in [false, true] {
        let proxy = ServerSessionState::new();
        let intent = fixture(&proxy, true);
        let update = ClientGroupMetaApply {
            thread_id: THREAD_ID,
            namespace_id: 0,
            page: serde_json::from_value(json!({
                "account": "!dev", "mode": "delta",
                "items": [{"feedId": "1", "operation": "MEMBER_UPSERT",
                           "body": {"account": "bob", "namespaceId": 0,
                                    "role": "MEMBER", "profileRev": 2}}],
                "scannedThrough": "2", "groupMetaFeedEndId": "2", "hasMore": false,
            }))
            .unwrap(),
        };
        let gate = super::super::lifetime::CACHE_LIFETIME.invalidate().unwrap();
        let mut pending =
            Box::pin(intent.db(move |conn| {
                super::super::client_state::apply_group_meta_page(conn, 42, update)
            }));
        assert!(pending.as_mut().now_or_never().is_none());
        if repair {
            intent.work.owner().invalidate_database_work().unwrap();
        } else {
            intent.work.owner().end().unwrap();
        }
        let successor = fixture(&proxy, true);
        drop(gate);
        assert_eq!(pending.await.err().unwrap(), sentinel(repair));
        let seeded = |owner: &Arc<LoginConnection>| {
            owner
                .with_database(|conn| {
                    let (feed, members): (String, i64) = conn
                        .query_row(
                            "SELECT feed_id,
                                    (SELECT COUNT(*) FROM members
                                     WHERE user_id=42 AND thread_id=?1)
                             FROM group_meta WHERE user_id=42 AND thread_id=?1",
                            [THREAD_ID],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .map_err(|e| e.to_string())?;
                    Ok::<_, String>((feed, members))
                })
                .unwrap()
        };
        assert_eq!(seeded(successor.work.owner()), ("0".to_string(), 0));
        if repair {
            assert_eq!(seeded(intent.work.owner()), ("0".to_string(), 0));
            intent
                .work
                .owner()
                .with_database(|conn| {
                    let cursors: Vec<String> = conn
                        .prepare("SELECT value FROM meta_cursor_proof")
                        .map_err(|e| e.to_string())?
                        .query_map([], |row| row.get(0))
                        .map_err(|e| e.to_string())?
                        .collect::<Result<_, _>>()
                        .map_err(|e| e.to_string())?;
                    assert!(cursors.is_empty(), "the page never touched the connection");
                    Ok(())
                })
                .unwrap();
        }
        close(&intent);
        close(&successor);
    }
}

/// A tombstone page commit queued behind maintenance rejects repair or logout without
/// writing its tomb or advancing the deletion high-water mark on any cache.
#[tokio::test]
async fn a_queued_tombstone_page_commit_rejects_end_or_repair() {
    for repair in [false, true] {
        let proxy = ServerSessionState::new();
        let intent = fixture(&proxy, false);
        let tombstones = vec![json!({
            "threadId": THREAD_ID, "deletionSeq": 1, "messageSeq": 3,
            "type": "USER_RETRACTION",
        })];
        let gate = super::super::lifetime::CACHE_LIFETIME.invalidate().unwrap();
        let mut pending = Box::pin(super::super::messages::apply_deleted_messages(
            intent.work.clone(),
            42,
            THREAD_ID,
            tombstones,
            5,
        ));
        assert!(pending.as_mut().now_or_never().is_none());
        if repair {
            intent.work.owner().invalidate_database_work().unwrap();
        } else {
            intent.work.owner().end().unwrap();
        }
        let successor = fixture(&proxy, false);
        drop(gate);
        assert_eq!(pending.await.unwrap_err(), sentinel(repair));
        let drained = |owner: &Arc<LoginConnection>| {
            owner
                .with_database(|conn| {
                    let hwm: Option<i64> = conn
                        .query_row(
                            "SELECT deleted_hwm FROM thread_sync_state
                             WHERE user_id=42 AND thread_id=?1",
                            [THREAD_ID],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(|e| e.to_string())?;
                    let messages: i64 = conn
                        .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
                        .map_err(|e| e.to_string())?;
                    Ok::<_, String>((hwm, messages))
                })
                .unwrap()
        };
        assert_eq!(drained(successor.work.owner()), (None, 0));
        if repair {
            assert_eq!(drained(intent.work.owner()), (None, 0));
        }
        close(&intent);
        close(&successor);
    }
}

/// The Group Meta drain keeps its captured endpoint, bearer and physical connection across
/// pages and profile warming, and materializes referenced profiles through the same owner.
#[tokio::test]
async fn group_meta_drain_retains_owner_and_materializes_profiles() {
    let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = ServerSessionState::new();
    origins(&proxy, &format!("http://{}", server.local_addr().unwrap()));
    let intent = fixture(&proxy, true);
    OPEN_THREAD_ID.store(THREAD_ID, std::sync::atomic::Ordering::Release);
    // Mutating runtime mirrors after capture cannot retarget any page or profile request.
    origins(&proxy, "http://127.0.0.1:1");
    *proxy.token.lock().unwrap() = Some("successor-token".into());
    let serving = tokio::spawn(async move {
        {
            let (mut socket, _) = server.accept().await.unwrap();
            let (headers, _) = read_request(&mut socket).await;
            assert!(headers.starts_with(
                "GET /api/v1/user/group-meta?threadId=52&mode=full&after=0&take=100&through=2 HTTP/1.1\r\n"
            ));
            assert!(headers
                .to_ascii_lowercase()
                .contains("authorization: bearer drain-token\r\n"));
            respond(
                &mut socket,
                group_meta_page(
                    "1",
                    true,
                    json!([{"feedId": "1", "operation": "MEMBER_UPSERT",
                            "body": {"account": "bob", "namespaceId": 0,
                                     "role": "MEMBER", "profileRev": 2}}]),
                ),
            )
            .await;
        }
        {
            let (mut socket, _) = server.accept().await.unwrap();
            let (headers, _) = read_request(&mut socket).await;
            assert!(headers.starts_with(
                "GET /api/v1/user/group-meta?threadId=52&mode=full&after=1&take=100&through=2 HTTP/1.1\r\n"
            ));
            assert!(headers
                .to_ascii_lowercase()
                .contains("authorization: bearer drain-token\r\n"));
            respond(
                &mut socket,
                group_meta_page(
                    "2",
                    false,
                    json!([{"feedId": "2", "operation": "GROUP_ANNOUNCEMENT",
                            "body": {"text": "hello"}}]),
                ),
            )
            .await;
        }
        let demands = [
            (
                json!({"publisherNamespaceId": 0, "lookup": "ACCOUNT_PROFILE",
                       "target": {"profileNamespaceId": 0, "account": "!dev", "rev": 3}}),
                json!({"code": 0, "data": {"status": "READY", "profile": {
                    "account": "!dev", "profileNamespaceId": 0, "rev": 3,
                    "publisherNamespaceId": 0, "name": "Dev", "bio": "group",
                }}}),
            ),
            (
                json!({"publisherNamespaceId": 0, "lookup": "GROUP_MEMBER_PROFILE",
                       "target": {"profileNamespaceId": 0, "account": "bob", "rev": 2},
                       "groupAccount": "!dev"}),
                json!({"code": 0, "data": {"status": "READY", "profile": {
                    "account": "bob", "profileNamespaceId": 0, "rev": 2,
                    "publisherNamespaceId": 0, "name": "Bob", "bio": "member",
                }}}),
            ),
        ];
        for (demand, reply) in demands {
            let (mut socket, _) = server.accept().await.unwrap();
            let (headers, body) = read_request(&mut socket).await;
            assert!(headers.starts_with("POST /api/v1/user/profile-resolution HTTP/1.1\r\n"));
            assert!(headers
                .to_ascii_lowercase()
                .contains("authorization: bearer drain-token\r\n"));
            assert_eq!(body, demand);
            respond(&mut socket, reply).await;
        }
    });
    let (changed, patches, error) = tokio::time::timeout(
        Duration::from_secs(5),
        sync_group_meta_thread(intent.clone(), THREAD_ID),
    )
    .await
    .unwrap();
    serving.await.unwrap();
    assert_eq!(error, None);
    assert_eq!(changed, vec![THREAD_ID]);
    assert_eq!(patches.len(), 2);
    assert_eq!(patches[0].group_meta_feed_id, "1");
    assert_eq!(patches[0].member_count, 1);
    assert!(patches[0].announcement_feed_id.is_none());
    assert!(patches[0].announcement_text.is_none());
    assert_eq!(patches[0].group_meta_recovery_through.as_deref(), Some("2"));
    assert_eq!(patches[1].group_meta_feed_id, "2");
    assert_eq!(patches[1].member_count, 1);
    assert_eq!(patches[1].announcement_text.as_deref(), Some("hello"));
    assert_eq!(patches[1].announcement_feed_id.as_deref(), Some("2"));
    assert_eq!(patches[1].group_meta_recovery_through, None);
    intent
        .work
        .owner()
        .with_database(|conn| {
            let (feed, recovery, members, announcement): (
                String,
                Option<String>,
                i64,
                Option<String>,
            ) = conn
                .query_row(
                    "SELECT feed_id, recovery_through,
                            member_count, announcement_text
                     FROM group_meta WHERE user_id=42 AND thread_id=?1",
                    [THREAD_ID],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .map_err(|e| e.to_string())?;
            assert_eq!(feed, "2");
            assert_eq!(recovery, None);
            assert_eq!(members, 1);
            assert_eq!(announcement.as_deref(), Some("hello"));
            let roster: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM members
                     WHERE user_id=42 AND thread_id=?1 AND left_state=0",
                    [THREAD_ID],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            assert_eq!(roster, 1);
            let profiles: Vec<String> = conn
                .prepare("SELECT account FROM profile_proof")
                .map_err(|e| e.to_string())?
                .query_map([], |row| row.get(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?;
            assert_eq!(profiles, vec!["!dev".to_string(), "bob".to_string()]);
            let cursors: Vec<String> = conn
                .prepare("SELECT value FROM meta_cursor_proof")
                .map_err(|e| e.to_string())?
                .query_map([], |row| row.get(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?;
            assert_eq!(
                cursors,
                vec!["0".to_string(), "1".to_string(), "2".to_string()]
            );
            Ok(())
        })
        .unwrap();
    close(&intent);
}

/// Profile warming is optional: a failed reference must not discard or hide the Group Meta
/// pages that already committed through the same owner.
#[tokio::test]
async fn failed_profile_warming_keeps_committed_group_meta_pages() {
    let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = ServerSessionState::new();
    origins(&proxy, &format!("http://{}", server.local_addr().unwrap()));
    let intent = fixture(&proxy, true);
    OPEN_THREAD_ID.store(THREAD_ID, std::sync::atomic::Ordering::Release);
    let serving = tokio::spawn(async move {
        {
            let (mut socket, _) = server.accept().await.unwrap();
            let (headers, _) = read_request(&mut socket).await;
            assert!(headers.starts_with(
                "GET /api/v1/user/group-meta?threadId=52&mode=full&after=0&take=100&through=2 HTTP/1.1\r\n"
            ));
            respond(&mut socket, group_meta_page("1", true, json!([]))).await;
        }
        {
            let (mut socket, _) = server.accept().await.unwrap();
            let (headers, _) = read_request(&mut socket).await;
            assert!(headers.starts_with(
                "GET /api/v1/user/group-meta?threadId=52&mode=full&after=1&take=100&through=2 HTTP/1.1\r\n"
            ));
            respond(&mut socket, group_meta_page("2", false, json!([]))).await;
        }
        {
            let (mut socket, _) = server.accept().await.unwrap();
            let _ = read_request(&mut socket).await;
            socket
                .write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
        }
    });
    let (changed, patches, error) = tokio::time::timeout(
        Duration::from_secs(5),
        sync_group_meta_thread(intent.clone(), THREAD_ID),
    )
    .await
    .unwrap();
    assert_eq!(error, None, "warming failure is retried on the next wake");
    tokio::time::timeout(Duration::from_secs(5), serving)
        .await
        .expect("mock server did not receive the expected Meta pages and profile demand")
        .unwrap();
    assert_eq!(changed, vec![THREAD_ID]);
    assert_eq!(patches.len(), 2);
    intent
        .work
        .owner()
        .with_database(|conn| {
            let feed: String = conn
                .query_row(
                    "SELECT feed_id FROM group_meta
                     WHERE user_id=42 AND thread_id=?1",
                    [THREAD_ID],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            assert_eq!(feed, "2");
            let profiles: i64 = conn
                .query_row("SELECT COUNT(*) FROM profiles", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            assert_eq!(profiles, 0);
            Ok(())
        })
        .unwrap();
    close(&intent);
}

/// A tombstone drain commits its tombs and high-water mark through the captured physical
/// connection, retaining the original endpoint and bearer across the POST.
#[tokio::test]
async fn tombstone_drain_commits_through_the_captured_connection() {
    let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = ServerSessionState::new();
    origins(&proxy, &format!("http://{}", server.local_addr().unwrap()));
    let intent = fixture(&proxy, false);
    OPEN_THREAD_ID.store(THREAD_ID, std::sync::atomic::Ordering::Release);
    origins(&proxy, "http://127.0.0.1:1");
    *proxy.token.lock().unwrap() = Some("successor-token".into());
    let serving = tokio::spawn(async move {
        let (mut socket, _) = server.accept().await.unwrap();
        let (headers, body) = read_request(&mut socket).await;
        assert!(headers.starts_with("POST /api/v1/deleted-messages/query HTTP/1.1\r\n"));
        assert!(headers
            .to_ascii_lowercase()
            .contains("authorization: bearer drain-token\r\n"));
        assert_eq!(
            body,
            json!({"threadId": 52, "after": 0, "take": 100, "through": 5})
        );
        respond(
            &mut socket,
            json!({"code": 0, "data": {
                "tombstones": [{"threadId": 52, "deletionSeq": 1, "messageSeq": 3,
                                "type": "USER_RETRACTION"}],
                "scannedThrough": 5, "hasMore": false,
            }}),
        )
        .await;
    });
    let mut drain_intent = intent.clone();
    let committed = tokio::time::timeout(
        Duration::from_secs(5),
        sync_tombstone_thread(&mut drain_intent, THREAD_ID),
    )
    .await
    .unwrap()
    .unwrap();
    serving.await.unwrap();
    assert_eq!(committed.len(), 1);
    assert_eq!(committed[0]["messageSeq"], 3);
    intent
        .work
        .owner()
        .with_database(|conn| {
            let hwm: Option<i64> = conn
                .query_row(
                    "SELECT deleted_hwm FROM thread_sync_state
                     WHERE user_id=42 AND thread_id=?1",
                    [THREAD_ID],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            assert_eq!(hwm, Some(5));
            let tombs: i64 = conn
                .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            assert_eq!(tombs, 1);
            let payload: String = conn
                .query_row(
                    "SELECT payload_json FROM messages WHERE user_id=42 AND thread_id=?1 AND seq=3",
                    [THREAD_ID],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            assert!(payload.contains("TOMB"));
            let mut proofs: Vec<String> = conn
                .prepare("SELECT kind FROM tombstone_proof")
                .map_err(|e| e.to_string())?
                .query_map([], |row| row.get(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?;
            proofs.sort();
            assert_eq!(proofs, vec!["hwm".to_string(), "message".to_string()]);
            Ok(())
        })
        .unwrap();
    close(&intent);
}
