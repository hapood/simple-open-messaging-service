use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;

use super::client_state::{apply_state_feed_page_with_resume, ClientStateFeedItem};
use super::{lifetime, open};
use crate::{proxy::perform_api_request_with_events, ProxyState};

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
    let raw: Option<String> = conn
        .query_row(
            "SELECT value_json FROM sync_state WHERE user_id=?1 AND key='stateFeedId'",
            [user_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("read state-feed cursor: {e}"))?;
    let cursor = raw
        .map(|value| value.parse::<i64>())
        .transpose()
        .map_err(|e| format!("decode state-feed cursor: {e}"))?
        .unwrap_or(0);
    let pending: Option<String> = conn
        .query_row(
            "SELECT value_json FROM sync_state WHERE user_id=?1 AND key='stateFeedFullThrough'",
            [user_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("read state-feed full boundary: {e}"))?;
    let full_through = pending
        .map(|value| value.parse::<i64>())
        .transpose()
        .map_err(|e| format!("decode state-feed full boundary: {e}"))?;
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
pub(crate) async fn synchronize(
    proxy: &ProxyState,
    user_id: i64,
    target: i64,
) -> Result<i64, String> {
    if user_id <= 0 || target < 0 {
        return Err("invalid state-feed target".into());
    }
    let epoch = lifetime::CACHE_LIFETIME.capture()?;
    let _lane = STATE_FEED_SYNC.lock().await;
    drop(lifetime::CACHE_LIFETIME.admit(epoch)?);
    let (mut after, persisted_full) =
        lifetime::spawn_at(Ok(epoch), move || cursor(&open()?, user_id))
            .await
            .map_err(|e| format!("join state-feed cursor read: {e}"))??;
    let mut target = target;
    let mut full_through = persisted_full.or_else(|| (after == 0 && target > 0).then_some(target));
    target = target.max(full_through.unwrap_or(0));
    let mut reset_projection = after == 0 && full_through.is_some();
    let mut recovery_attempted = false;
    while after < target {
        drop(lifetime::CACHE_LIFETIME.admit(epoch)?);
        let through = full_through.unwrap_or(target);
        let mode = if full_through.is_some() {
            "full"
        } else {
            "delta"
        };
        let response = perform_api_request_with_events(
            None,
            proxy,
            "GET".into(),
            format!("/api/v1/user/state-feed?mode={mode}&after={after}&through={through}&take=100"),
            Default::default(),
            None,
            true,
        )
        .await?;
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
            reset_projection = true;
            recovery_attempted = true;
            if target == after {
                lifetime::spawn_at(Ok(epoch), move || {
                    apply_state_feed_page_with_resume(
                        &mut open()?,
                        user_id,
                        Vec::new(),
                        after,
                        Vec::new(),
                        true,
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
        lifetime::spawn_at(Ok(epoch), move || {
            apply_state_feed_page_with_resume(
                &mut open()?,
                user_id,
                page.items,
                scanned,
                Vec::new(),
                reset_projection,
                full_marker,
            )
        })
        .await
        .map_err(|e| format!("join state-feed page commit: {e}"))??;
        after = scanned;
        reset_projection = false;
        if full_through.is_some_and(|boundary| after >= boundary) {
            full_through = None;
        }
        target = target.max(head);
        if !page.has_more && after < through {
            return Err("state-feed response ended before requested boundary".into());
        }
    }
    drop(lifetime::CACHE_LIFETIME.admit(epoch)?);
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
                        "feedId": id, "namespaceId": 0,
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
        apply_state_feed_page_with_resume(
            &mut conn,
            1,
            Vec::new(),
            1,
            Vec::new(),
            true,
            Some(Some(3)),
        )
        .unwrap();
        assert_eq!(cursor(&conn, 1).unwrap(), (1, Some(3)));
        apply_state_feed_page_with_resume(
            &mut conn,
            1,
            Vec::new(),
            3,
            Vec::new(),
            false,
            Some(None),
        )
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
