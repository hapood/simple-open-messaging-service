# Notification parity audit

## Scope and status

This is an implementation audit, not a declaration that native notification migration is complete. The desktop production path still accepts renderer-built descriptors. Newly introduced Rust content/presentation helpers are not yet connected to synchronization. Android still interprets notification batches in Kotlin.

## Confirmed findings

### Blocked conversations are not consistently suppressed

- Browser descriptor assembly sets count to zero for blocked conversations: `web/src/app/services/thread-notification.ts` (`threadNotificationDescriptor`).
- Rust assembly reads the stored snapshot, including `blocked`, but calculates and publishes `projected_count` without applying blocking: `src-tauri/src/native_db/notifications.rs` (`assemble` loop over delivered states).
- Kotlin uses the Rust count to decide whether to cancel or post: `src-tauri/gen/android/app/src/main/java/com/soms/client/SomsMessagingService.kt` (`renderThreadDescriptors`).
- Both change detectors omit `blocked`: `shared/thread-attention.ts` (`threadNotificationChanged`) and `src-tauri/src/native_db/attention.rs` (snapshot merge's `notification_changed`). A blocked-only revision therefore does not generate a notification update, even where descriptor assembly would suppress it.

Required regression scenarios: blocked conversation receives a message; blocking while a card exists without changing unread counters; unblocking without a new message must not accidentally replay historical alerts. Separate card refresh/removal from sound eligibility rather than indiscriminately re-alerting metadata updates.

### Foreground suppression has different semantics

- Browser Push Worker uses visible AND focused active-page state and queries its active conversation, with a 500 ms response deadline. Failure to get an answer conservatively suppresses presentation: `web/src/push/push-worker.ts` (`visibleChat`).
- Kotlin filters the active conversation when `appInForeground` is true: `SomsMessagingService.kt` (`renderNativeBatch`, `renderAwayNotificationOnce`).
- New, currently unused Rust policy emits Remove for a visible, focused open conversation: `src-tauri/src/native_db/notifications/content.rs`.

Do not silently substitute removal for skipping. Audit existing conversation-open cancellation calls and establish a single desired policy, including split-screen, minimization, navigation away, and missing host observations.

### Alert policy is not shared

Android Kotlin owns process-wide cooldown claims and once-per-thread behavior in `renderThreadDescriptors`. Device preference `notificationAlertPolicy` defaults to `cooldown_5s` in `ClientStateDb.kt`. New Rust preferences currently cover enabled/sound/privacy, not this policy. No equivalent policy was found in the inspected browser notification preference/descriptor path.

Required scenarios: multiple conversations in one batch; muted first card followed by an unmuted card; removal-only batch; retries; cooldown boundary; foreground suppression. Determine when a sound slot is consumed before migrating the implementation.

### Content representation differs

- Browser body joins unread preview text with newlines.
- Android sorts previews by sequence, uses the last message for fallback body, and preserves a message list with timestamps, sender identity, and avatar bytes for MessagingStyle.
- New Rust NotificationContent only contains title/body/count/silent and cannot replace Android's complete descriptor without losing information.
- Kotlin rejects unknown preview status; the new Rust helper substitutes private fallback text. Both avoid intentionally displaying unknown-state text, but failure behavior differs.

Keep platform-specific rendering (MessagingStyle versus plain body) while sharing ordered, sanitized message data and policy. Preserve mention information, timestamps, sender identity and avatar indexing.

### Language source differs

Kotlin uses Android resources and Locale.getDefault(). Browser uses its selected application language. Newly introduced Rust copy reads the device `language` preference and defaults to English. The no-preference case must be reconciled with the application's system-language fallback before enabling this code.

## Existing reusable native foundation

`src-tauri/src/native_db/notifications.rs` already assembles from captured database work, reconciles local read progress, rejects superseded feed snapshots, resolves profile titles, and deduplicates avatar bytes. Reuse it for all native hosts instead of creating a second desktop assembler.

## Next verification work

1. Trace browser online and background preference application, feed cursor advancement, and duplicate suppression end to end.
2. Trace Android alert throttles and UI cancellation calls; identify business decisions to move out of Kotlin.
3. Define common fixture cases for counts, block/read changes, preview/tombstone handling, foreground facts and sound eligibility.
4. Run fixtures through browser and shared Rust implementations before replacing native adapters.
5. Delete renderer notification IPC and obsolete implementations only after native production routing is complete and tested.
