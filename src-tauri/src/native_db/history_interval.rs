use super::*;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum HistoryIntervalEvent {
    Page { page: HistoryIntervalPage },
    Failed { reason: String },
}

#[derive(Debug, Serialize)]
pub(crate) struct HistoryIntervalPage {
    left: i64,
    right: i64,
    items: Vec<NativeHistoryItem>,
}

#[derive(Default)]
struct DirtyInterval {
    pending: Mutex<Option<MessageInterval>>,
    wake: Notify,
}
impl DirtyInterval {
    fn mark(&self, interval: MessageInterval) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        *pending = Some(match *pending {
            Some(old) => MessageInterval {
                left: old.left.min(interval.left),
                right: old.right.max(interval.right),
            },
            None => interval,
        });
        self.wake.notify_one();
    }
    fn take(&self) -> Option<MessageInterval> {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
    }
}

fn notification(data: &Value, thread_id: i64, bounds: MessageInterval) -> Option<MessageInterval> {
    if data.get("threadId")?.as_i64()? != thread_id {
        return None;
    }
    let left = data.get("left")?.as_i64()?.max(bounds.left);
    let right = data.get("right")?.as_i64()?.min(bounds.right);
    (left < right).then_some(MessageInterval { left, right })
}

impl NativeHistoryIntent {
    /// One local-server page, even for an already classified SERVER_PENDING range.
    /// Never call the ordinary recursive walker from a notification.
    async fn refresh_interval(
        &mut self,
        interval: MessageInterval,
        direction: HistoryDirection,
    ) -> Result<Option<HistoryIntervalPage>, String> {
        self.work.assert_current().map_err(|e| e.to_string())?;
        let request_body = match direction {
            HistoryDirection::Older => serde_json::json!({
                "threadId": self.thread_id, "before": interval.right + 1,
                "through": interval.left + 1, "take": 50,
            }),
            HistoryDirection::Newer => serde_json::json!({
                "threadId": self.thread_id, "after": interval.left,
                "through": interval.right, "take": 50,
            }),
        };
        let response = query_message_backend(&self.work, &mut self.request, request_body).await?;
        let page = match response {
            MessageBackendResponse::Cursor(_) => return Ok(None),
            MessageBackendResponse::Page(page) => page,
        };
        let out_of_bounds = match direction {
            HistoryDirection::Older => {
                page.scanned_through < interval.left + 1
                    || page.scanned_through > interval.right + 1
            }
            HistoryDirection::Newer => {
                page.scanned_through < interval.left || page.scanned_through > interval.right
            }
        };
        if out_of_bounds {
            return Err("history interval scan escaped its bounds".into());
        }
        let cursor = match direction {
            HistoryDirection::Older => interval.right + 1,
            HistoryDirection::Newer => interval.left,
        };
        let Some(scan) = scan_for_page(direction, cursor, page.scanned_through)? else {
            return Ok(None);
        };
        if scan.left < interval.left || scan.right > interval.right || page.messages.len() > 50 {
            return Err("history interval page escaped its bounds".into());
        }
        for message in &page.messages {
            let seq = message_seq(message, self.thread_id)?;
            if seq <= scan.left || seq > scan.right {
                return Err("history interval message escaped its scan".into());
            }
        }
        let gaps = wire_gaps_to_ranges(page.gaps)?
            .into_iter()
            .map(|gap| {
                if gap.right > 9_007_199_254_740_991
                    || gap.right <= scan.left
                    || gap.left >= scan.right
                {
                    return Err("invalid or nonintersecting history interval gap".to_string());
                }
                // The wire contract returns full intersecting gaps. Only this
                // page's actual scan may alter the mounted interval's coverage.
                Ok(ServerMessageRange {
                    left: gap.left.max(scan.left),
                    right: gap.right.min(scan.right),
                    state: gap.state,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let committed = commit_native_message_page(
            self.work.clone(),
            self.user_id,
            self.thread_id,
            Some(scan),
            page.messages,
            gaps.clone(),
            None,
        )
        .await?;
        self.work.assert_current().map_err(|e| e.to_string())?;
        emit_message_commit(&self.events, self.user_id, self.thread_id);
        {
            super::super::resource_scheduler::wake_tomb_cutoff(
                self.work.clone(),
                self.request.clone(),
                self.user_id,
                self.thread_id,
                self.events.clone(),
            );
        }
        let remaining_gaps: Vec<ServerMessageRange> = committed
            .ranges
            .iter()
            .filter(|range| {
                range.state != MessageRangeState::LocalCovered
                    && range.right > scan.left
                    && range.left < scan.right
            })
            .map(|range| ServerMessageRange {
                left: range.left.max(scan.left),
                right: range.right.min(scan.right),
                state: range.state,
            })
            .collect();
        Ok(Some(HistoryIntervalPage {
            left: scan.left,
            right: scan.right,
            items: page_items(
                self.thread_id,
                HistoryDirection::Newer,
                scan,
                committed.messages,
                &remaining_gaps,
            )?,
        }))
    }

    pub(crate) async fn watch_interval(
        mut self,
        left: i64,
        right: i64,
        direction: HistoryDirection,
        events: tauri::ipc::Channel<HistoryIntervalEvent>,
    ) -> Result<(), String> {
        if left < 0 || left >= right || right >= 9_007_199_254_740_991 {
            return Err("invalid history interval".into());
        }
        let dirty = Arc::new(DirtyInterval::default());
        let bounds = MessageInterval { left, right };
        let stream = stream_intervals(
            self.work.clone(),
            self.request.clone(),
            self.thread_id,
            bounds,
            dirty.clone(),
        );
        let pages = async {
            loop {
                dirty.wake.notified().await;
                while let Some(interval) = dirty.take() {
                    match self.refresh_interval(interval, direction).await {
                        Ok(Some(page)) => {
                            self.work.assert_current().map_err(|e| e.to_string())?;
                            events
                                .send(HistoryIntervalEvent::Page { page })
                                .map_err(|e| e.to_string())?;
                        }
                        Ok(None) => {}
                        Err(_) => {
                            self.work.assert_current().map_err(|e| e.to_string())?;
                            dirty.mark(interval);
                            tokio::time::sleep(Duration::from_secs(1)).await;
                        }
                    }
                }
            }
            #[allow(unreachable_code)]
            Ok::<(), String>(())
        };
        tokio::select! {
            result = stream => result,
            result = pages => result,
        }
    }
}

/// The stream remains readable while the page is in flight. Bursts merge into
/// one pending bounded refresh rather than allocating a page task per frame.
async fn stream_intervals(
    work: DatabaseWork,
    mut request: LoginRequest,
    thread_id: i64,
    bounds: MessageInterval,
    dirty: Arc<DirtyInterval>,
) -> Result<(), String> {
    let path = format!(
        "/api/v1/message/history-interval?threadId={thread_id}&left={}&right={}",
        bounds.left, bounds.right
    );
    let mut failures = 0u32;
    loop {
        work.assert_current().map_err(|e| e.to_string())?;
        let endpoint = request.endpoint()?;
        let attempt = async {
            let response = crate::http_stream::open(
                endpoint
                    .client
                    .get(format!("{}{path}", endpoint.origin))
                    .bearer_auth(&endpoint.credential)
                    .header("accept", "text/event-stream"),
            )
            .await
            .map_err(|e| format!("history interval stream: {e:?}"))?;
            if matches!(response.status().as_u16(), 401 | 403 | 404) {
                return Ok(None);
            }
            if !response.status().is_success() {
                return Err("history interval stream rejected".into());
            }
            failures = 0;
            let mut body = crate::http_stream::Body::new(response);
            let mut framer = crate::sse::sse_framer::SseFramer::with_limit(64 * 1024);
            while let Some(bytes) = body
                .next()
                .await
                .map_err(|e| format!("history interval receive: {e:?}"))?
            {
                work.assert_current().map_err(|e| e.to_string())?;
                for byte in bytes {
                    let Some(frame) = framer.push(byte).map_err(str::to_owned)? else {
                        continue;
                    };
                    if let Some(frame) = crate::sse::parse_sse_frame(&frame) {
                        if frame.event == "MESSAGE_HISTORY_INTERVAL_EVICTED" {
                            return Ok(Some(false));
                        }
                        if frame.event == "MESSAGE_HISTORY_INTERVAL" {
                            if let Some(interval) = notification(&frame.data, thread_id, bounds) {
                                dirty.mark(interval);
                            }
                        }
                    }
                }
            }
            Ok::<Option<bool>, String>(Some(true))
        }
        .await;
        if matches!(attempt, Ok(None)) {
            return Err("history interval authorization ended".into());
        }
        if matches!(attempt, Ok(Some(false))) {
            return Err("history interval subscription evicted".into());
        }
        work.assert_current().map_err(|e| e.to_string())?;
        failures = failures.saturating_add(1);
        tokio::time::sleep(Duration::from_millis(
            (500u64 << failures.min(5)).min(15_000),
        ))
        .await;
        if let Some((endpoint, _)) = request.select_endpoint().await {
            request = request.at_endpoint(&endpoint);
        }
    }
}

#[cfg(test)]
#[path = "../tests/native_history_interval_tests.rs"]
mod tests;
