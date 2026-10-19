use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;

use super::client_state::{apply_state_feed_page_with_resume, ClientStateFeedItem};
use super::{capture_database_work, spawn_owned_database};
use crate::{login_request::LoginRequest, ServerSessionState};

// This lane owns the persisted state-feed cursor. Network waits do not hold the cache-lifetime lock.
static STATE_FEED_SYNC: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    mode: String,
    items: Vec<ClientStateFeedItem>,
    scanned_through: i64,
    state_feed_end_id: i64,
    has_more: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Recovery {
    resume_after: i64,
    resume_before: i64,
}

#[derive(Deserialize)]
struct Envelope {
    code: i32,
    data: Option<Value>,
}

fn cursor(conn: &Connection, user_id: i64) -> Result<(i64, Option<i64>), String> {
    let (cursor, full_through) = conn
        .query_row(
            "SELECT COALESCE(state_feed_id,0),state_feed_full_through
         FROM account_state WHERE user_id=?1",
            [user_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .optional()
        .map_err(|e| format!("read state-feed coordinates: {e}"))?
        .unwrap_or((0, None));
    if cursor < 0 || full_through.is_some_and(|boundary| boundary <= cursor) {
        return Err("invalid state-feed cursor or full boundary".into());
    }
    Ok((cursor, full_through))
}

fn validate(page: &Page, mode: &str, after: i64, through: i64) -> Result<(), String> {
    if page.mode != mode
        || page.scanned_through <= after
        || page.scanned_through > through
        || page.state_feed_end_id < page.scanned_through
        || (page.has_more && page.scanned_through >= through)
        || page.items.iter().any(|item| {
            item.feed_id
                .is_none_or(|id| id <= after || id > page.scanned_through)
        })
        || page
            .items
            .windows(2)
            .any(|pair| pair[0].feed_id >= pair[1].feed_id)
    {
        return Err("invalid state-feed page".into());
    }
    Ok(())
}

/// Consume one native state-feed wake. Rust fetches and validates pages before atomically applying
/// each page with its cursor. A concurrent wake observes the new cursor after this lane finishes.
pub(crate) fn synchronize(
    proxy: &ServerSessionState,
    user_id: i64,
    target: i64,
) -> impl std::future::Future<Output = Result<i64, String>> + Send + 'static {
    // Capture before returning a future: callers may schedule/poll it after the login changes.
    let intent = (|| {
        if user_id <= 0 || target < 0 {
            return Err("invalid state-feed target".to_string());
        }
        let (work, request) = match crate::realtime::WORK_RUN.try_with(|run| run.login_request()) {
            Ok(intent) => intent?,
            Err(_) => {
                let work = capture_database_work()?;
                let request = LoginRequest::capture(proxy, work.owner().clone())?;
                (work, request)
            }
        };
        work.assert_current().map_err(|e| e.to_string())?;
        Ok((work, request))
    })();
    async move {
        let (work, request) = intent?;
        synchronize_owned(work, request, user_id, target).await
    }
}

/// A caller coordinating several feeds passes its original binding instead of recapturing globals.
pub(crate) async fn synchronize_owned(
    work: crate::login_connection::DatabaseWork,
    mut request: LoginRequest,
    user_id: i64,
    target: i64,
) -> Result<i64, String> {
    if user_id <= 0 || target < 0 {
        return Err("invalid state-feed target".into());
    }
    work.assert_current().map_err(|e| e.to_string())?;
    request.assert_owner(work.owner())?;
    let cancellation = work.cancellation();
    let _lane = tokio::select! {
        biased;
        _ = cancellation.cancelled() => {
            work.assert_current().map_err(|e| e.to_string())?;
            return Err("native cache work superseded".into());
        },
        lane = STATE_FEED_SYNC.lock() => lane,
    };
    work.assert_current().map_err(|e| e.to_string())?;
    let (mut after, persisted_full) =
        spawn_owned_database(Ok(work.clone()), move |conn| cursor(conn, user_id))
            .await
            .map_err(|e| format!("join state-feed cursor read: {e}"))??;
    let mut target = target;
    let mut full_through = persisted_full.or_else(|| (after == 0 && target > 0).then_some(target));
    target = target.max(full_through.unwrap_or(0));
    let mut recovery_attempted = false;
    while after < target {
        work.assert_current().map_err(|e| e.to_string())?;
        let through = full_through.unwrap_or(target);
        let mode = if full_through.is_some() {
            "full"
        } else {
            "delta"
        };
        let response = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                work.assert_current().map_err(|e| e.to_string())?;
                return Err("native cache work superseded".into());
            }
            response = request.get(format!(
                "/api/v1/user/state-feed?mode={mode}&after={after}&through={through}&take=100"
            )) => response?,
        };
        if !(200..300).contains(&response.status) {
            return Err(format!("state-feed HTTP {}", response.status));
        }
        let envelope: Envelope = serde_json::from_str(&response.body)
            .map_err(|e| format!("decode state-feed response: {e}"))?;
        if envelope.code == 30006 {
            if recovery_attempted {
                return Err("state-feed recovery did not progress".into());
            }
            let recovery: Recovery =
                serde_json::from_value(envelope.data.ok_or("missing recovery window")?)
                    .map_err(|e| format!("decode state-feed recovery: {e}"))?;
            if recovery.resume_after < 0 || recovery.resume_before <= recovery.resume_after {
                return Err("invalid state-feed recovery window".into());
            }
            after = recovery.resume_after;
            target = recovery.resume_before - 1;
            full_through = (after < target).then_some(target);
            recovery_attempted = true;
            if target == after {
                spawn_owned_database(Ok(work.clone()), move |conn| {
                    apply_state_feed_page_with_resume(
                        conn,
                        user_id,
                        Vec::new(),
                        after,
                        Vec::new(),
                        Some(None),
                    )
                })
                .await
                .map_err(|e| format!("join empty state-feed recovery: {e}"))??;
            }
            continue;
        }
        if envelope.code != 0 {
            return Err(format!("state-feed business code {}", envelope.code));
        }
        let page: Page = serde_json::from_value(envelope.data.ok_or("missing state-feed page")?)
            .map_err(|e| format!("decode state-feed page: {e}"))?;
        validate(&page, mode, after, through)?;
        let scanned = page.scanned_through;
        let head = page.state_feed_end_id;
        let next_full = full_through.filter(|boundary| scanned < *boundary);
        let full_marker = full_through.map(|_| next_full);
        spawn_owned_database(Ok(work.clone()), move |conn| {
            apply_state_feed_page_with_resume(
                conn,
                user_id,
                page.items,
                scanned,
                Vec::new(),
                full_marker,
            )
        })
        .await
        .map_err(|e| format!("join state-feed page commit: {e}"))??;
        after = scanned;
        if full_through.is_some_and(|boundary| after >= boundary) {
            full_through = None;
        }
        target = target.max(head);
        if !page.has_more && after < through {
            return Err("state-feed response ended before requested boundary".into());
        }
    }
    work.assert_current().map_err(|e| e.to_string())?;
    Ok(after)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(mode: &str, scanned: i64, head: i64, ids: &[i64]) -> Page {
        Page {
            mode: mode.into(),
            scanned_through: scanned,
            state_feed_end_id: head,
            has_more: scanned < head,
            items: ids
                .iter()
                .map(|id| {
                    serde_json::from_value(serde_json::json!({
                        "feedId": id,
                        "body": { "requestEndId": id.to_string(), "requestReadId": "0" },
                    }))
                    .unwrap()
                })
                .collect(),
        }
    }

    #[test]
    fn full_snapshot_boundary_survives_restart_and_clears_with_last_page() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE client_preferences(scope TEXT,key TEXT,value_json TEXT,updated_at INTEGER,PRIMARY KEY(scope,key));").unwrap();
        super::super::create_cache_schema(&conn).unwrap();
        apply_state_feed_page_with_resume(&mut conn, 1, Vec::new(), 1, Vec::new(), Some(Some(3)))
            .unwrap();
        assert_eq!(cursor(&conn, 1).unwrap(), (1, Some(3)));
        apply_state_feed_page_with_resume(&mut conn, 1, Vec::new(), 3, Vec::new(), Some(None))
            .unwrap();
        assert_eq!(cursor(&conn, 1).unwrap(), (3, None));
    }

    #[test]
    fn refuses_unordered_and_stalled_state_pages() {
        assert!(validate(&page("delta", 3, 3, &[2, 3]), "delta", 1, 3).is_ok());
        assert!(validate(&page("delta", 3, 3, &[3, 2]), "delta", 1, 3).is_err());
        assert!(validate(&page("delta", 1, 3, &[]), "delta", 1, 3).is_err());
        assert!(validate(&page("full", 3, 3, &[]), "delta", 1, 3).is_err());
    }
}
