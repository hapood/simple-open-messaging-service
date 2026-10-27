//! Native profile-namespace change-feed lane. The browser executor drains this
//! feed from its worker; on native, Rust owns the drain end to end: pages are
//! fetched, validated and applied atomically with the cursor, converged pairs
//! wake the shared subscription flights, and undemanded pairs are warmed
//! through the same flights so background consumers (notifications, contacts)
//! keep fresh bindings exactly like a renderer prefetch.
use super::attention::FeedIntent;
use super::profile_namespaces::{
    apply_changes_with_checkpoint, ProfileNamespaceChange, ProfileNamespacePair,
};
use super::{capture_database_work, spawn_owned_database};
use crate::{login_request::LoginRequest, ServerSessionState};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use std::time::Duration;

// This lane owns the persisted change-feed cursor. Network waits never hold
// the cache-lifetime lock; concurrent wakes serialize here and a wake landing
// mid-drain is covered by the trailing page re-read.
static NAMESPACE_FEED_SYNC: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/** A wake normally converges the row; this bounds a lost-wake warm wait. */
const WARM_WINDOW: Duration = Duration::from_millis(30_000);

#[derive(Deserialize)]
struct Envelope {
    code: i32,
    data: Option<Page>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    items: Vec<ProfileNamespaceChange>,
    scanned_through: i64,
    end_id: i64,
    has_more: bool,
}

fn validate(page: &Page, after: i64) -> Result<(), String> {
    if page.scanned_through <= after
        || page.end_id < page.scanned_through
        || page
            .items
            .iter()
            .any(|item| item.change_id <= after || item.change_id > page.scanned_through)
    {
        return Err("invalid profile-namespace change page".into());
    }
    Ok(())
}

fn cursor(conn: &rusqlite::Connection, user_id: i64) -> Result<i64, String> {
    let cursor = conn
        .query_row(
            "SELECT COALESCE(profile_namespace_change_end_id,0)
         FROM account_state WHERE user_id=?1",
            [user_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| format!("read profile-namespace cursor: {e}"))?
        .unwrap_or(0);
    if cursor < 0 {
        return Err("invalid profile-namespace cursor".into());
    }
    Ok(cursor)
}

/// Consume one native change-feed wake (a `PROFILE_NAMESPACE_UPDATED` SSE event
/// or a login HELLO). Rust fetches and validates pages, applies each page with
/// its cursor atomically, wakes converged subscription flights, and warms
/// undemanded pairs through the same flights.
pub(crate) fn synchronize(
    proxy: &ServerSessionState,
    user_id: i64,
) -> impl std::future::Future<Output = Result<(), String>> + Send + 'static {
    // Capture before returning a future: callers may schedule/poll it after
    // the login changes.
    let intent = (|| {
        if user_id <= 0 {
            return Err("invalid user id".to_string());
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
        synchronize_owned(work, request, user_id).await
    }
}

async fn synchronize_owned(
    work: crate::login_connection::DatabaseWork,
    mut request: LoginRequest,
    user_id: i64,
) -> Result<(), String> {
    if user_id <= 0 {
        return Err("invalid user id".into());
    }
    work.assert_current().map_err(|e| e.to_string())?;
    request.assert_owner(work.owner())?;
    let cancellation = work.cancellation();
    let _lane = tokio::select! { biased;
        _ = cancellation.cancelled() => {
            work.assert_current().map_err(|e| e.to_string())?;
            return Err("native cache work superseded".into());
        },
        lane = NAMESPACE_FEED_SYNC.lock() => lane,
    };
    work.assert_current().map_err(|e| e.to_string())?;
    let mut after = spawn_owned_database(Ok(work.clone()), move |conn| cursor(conn, user_id))
        .await
        .map_err(|e| format!("join profile-namespace cursor read: {e}"))??;
    let mut reset_attempted = false;
    loop {
        work.assert_current().map_err(|e| e.to_string())?;
        let response = tokio::select! { biased;
            _ = cancellation.cancelled() => {
                work.assert_current().map_err(|e| e.to_string())?;
                return Err("native cache work superseded".into());
            }
            response = request.get(format!(
                "/api/v1/user/profile-namespace-feed?after={after}&take=100"
            )) => response?,
        };
        if response.status == 400 && after > 0 && !reset_attempted {
            // The server's coordinate space moved backwards (reset): resync
            // from the beginning, once per drain.
            after = 0;
            reset_attempted = true;
            continue;
        }
        if !(200..300).contains(&response.status) {
            return Err(format!(
                "profile-namespace change feed HTTP {}",
                response.status
            ));
        }
        let envelope: Envelope = serde_json::from_str(&response.body)
            .map_err(|e| format!("decode profile-namespace change feed: {e}"))?;
        if envelope.code != 0 {
            return Err(format!(
                "profile-namespace change feed code {}",
                envelope.code
            ));
        }
        let page = envelope
            .data
            .ok_or("missing profile-namespace change page")?;
        validate(&page, after)?;
        let scanned = page.scanned_through;
        let touched = spawn_owned_database(Ok(work.clone()), move |conn| {
            apply_changes_with_checkpoint(conn, user_id, &page.items, Some(scanned))
        })
        .await
        .map_err(|e| format!("join profile-namespace change commit: {e}"))??;
        if !touched.is_empty() {
            super::namespace_subscriptions::wake(user_id, &touched);
            let intent = FeedIntent::from_parts(user_id, work.clone(), request.clone())?;
            for pair in touched {
                spawn_warm(intent.clone(), pair);
            }
        }
        if !page.has_more {
            return Ok(());
        }
        after = scanned;
    }
}

/// Warm one undemanded converged pair through the shared flight machinery.
/// The wait is bounded by the PENDING window; dropping the subscription when
/// it settles releases the flight unless a live consumer still holds it.
fn spawn_warm(intent: FeedIntent, pair: ProfileNamespacePair) {
    tauri::async_runtime::spawn(async move {
        if let Ok(subscription) = super::namespace_subscriptions::watch(intent, pair) {
            let _ = subscription.first_settled(WARM_WINDOW).await;
        }
    });
}

#[cfg(test)]
#[path = "../tests/native_namespace_feed_tests.rs"]
pub(super) mod tests;
