# Notification delivery transaction design

## Agreed ownership

Rust owns native notification card state; the browser notification worker owns the equivalent browser state. Platform adapters execute commands and return observations/results, without a second business card map. Platform-specific object references may remain in adapters solely for resource safety.

A card is keyed by thread and contains an instance ID, platform handle, published content/version, and last accepted alert event/time. The platform handle is a tagged union: Android tag plus integer ID, macOS request identifier, Windows tag/group, or Linux daemon identity plus assigned ID. Browser tags use instance IDs. Replacements reuse the card instance; removal followed by creation gets a new instance.

Notification instance identity must not be confused with a login UUID, service session, origin, or operation identity.

## Historical failure mode before migration

`AlertState::apply` changes the live map and global cooldown before delivery. Android `notification_object` calls this while serializing JNI output. Java object allocation, queue admission, descriptor decoding, permission checks, avatar conversion, and OS submission all happen afterward. Therefore failures can leave a card recorded without a successful submission.

Android realtime output enters `RealtimeService.onNotifications`, whose dispatch can discard work before rendering. The renderer can also return early when its adapter is invalid, when NotificationManager is unavailable, or when legacy session/origin lookups fail. A callback added only after `notify` would not cover these paths.

Desktop `deliver_batch` also prepares all alert state before executing commands sequentially. Failure halfway through the batch currently consumes state for later, unattempted commands.

The recent atomic ID extraction prevents mismatched IDs within the map lock. It does not fix transaction ordering or publication races.

## Required execution contract

Each delivery has:

- `operationId`: unique for this execution, including updates of the same card.
- `notificationId`: stable for the current card instance.
- `threadId`: domain lookup key.
- An explicit show/remove operation and already-decided display/alert values.
- A Rust-owned captured work/cancellation context, never an OS payload identity.

Results are explicit:

- Accepted: OS API accepted submission, with its actual handle where applicable.
- Rejected: OS API reported failure or known notification permission/channel denial.
- Not executed: adapter closed or cancelled before OS submission.
- Uncertain: interruption prevents proving whether submission happened. Log a content-free warning and finish the attempt as unsuccessful, without committing alert/card changes. Release pending state so subsequent delivery can proceed. This deliberately tolerates possible OS side effects and duplicate cards/alerts on later attempts; no automatic reconciliation is required.

Accepted does not mean the user saw a notification or heard sound. Focus Assist, Do Not Disturb, launcher behavior, device state, and OS delivery policies remain authoritative. Name stored timestamps accordingly (for example, last accepted alert), not actual sound playback.

A notification ID alone cannot correlate results: two replacements have the same ID. A late result for operation A must not overwrite operation B's content, handle, or alert history.

## Ordered owner flow

1. Queue notification work in one Rust-owned presentation lane. Preserve cancellation and avoid holding a state mutex across OS calls.
2. Read current committed card state and host facts at execution time.
3. Prepare exactly one operation without changing committed card or cooldown state. Reserve a fresh instance for creation; use the committed instance for updates/removal.
4. Submit through the adapter. Every accepted adapter invocation must settle to an explicit result, including exceptions and cancellation before execution.
5. On accepted show, commit that operation's card state and alert history. On accepted removal, retire that exact instance. On definite failure, leave the previous committed card intact and do not consume alert eligibility.
6. Only then prepare the next command. This allows another eligible card to claim an alert when the previous submission failed, and makes global cooldown decisions consistent across SSE/FCM/lifecycle triggers.
7. Unknown delivery outcomes log a warning and release the pending attempt without committing. Later delivery may allocate a new instance; possible duplicates are an accepted tradeoff.

A separate pending-operation record is legitimate, but must not be represented as an already published card. It must retain the original operation/owner until completion and be bounded by lifecycle shutdown. Do not add a Kotlin business queue or another notification identity epoch.

## Dismissal and immediate removal

User dismissal identifies the exact notification instance. It is an observation, not another removal command and not a read receipt. A delayed dismissal cannot retire a newer instance for the same thread.

Dismissal can race an in-flight show completion. The presentation lane must serialize the observation with the result and remember retirement of the in-flight instance so a late accepted result cannot resurrect it.

The current immediate foreground path removes the map entry before OS cancellation. Replace it with the same queued remove operation used by business deltas. Returning an ID from `remove_notification_instance` fixes only the two-lock race; it is not the final removal transaction.

Clicks and Android auto-cancel need explicit lifecycle treatment. Click navigation is separate from read state; auto-cancel retirement must not be mistaken for a swipe callback (Android deleteIntent does not cover click cancellation).

## Lifecycle and recovery

Logout/new-login must stop admission, settle or reconcile outstanding OS work, clear notifications, then release authentication admission. Avoid bolting login-field checks onto notification display/click payloads.

On process/worker restart, recover current cards where the platform supports enumeration. A new browser Worker starts a new recovery round. Linux deliberately starts with empty in-process card state: do not clear, enumerate, import, or reuse persisted handles during startup. New deliveries without an accepted current-process handle use Notify with replaces_id = 0, tolerating old cards remaining on the OS panel. Replacement of a known current-process handle still validates the daemon identity. Explicit login/logout cleanup remains separate from startup behavior.

Web must choose one authoritative card owner. The existing Service Worker receives both online-worker presentation and push wakes under `soms-notification-projection`; do not duplicate the map in the online business worker. Each new Service Worker lifetime reconstructs from currently delivered OS cards; no additional durable card ledger is required. Browser success means the showNotification promise resolves, not user visibility.

## Implementation slices and removal gates

1. Introduce and test prepared operation/result state in the existing Rust card runtime; replace eager mutation rather than leave it as a second policy path.
2. Wire desktop execution to prepare/submit/commit sequentially, including real platform handles. Delete the old eager batch alert interface after Android also switches.
3. Replace Android's queued raw batch handoff with an invocation contract that can prove execution or nonexecution. Remove session/origin-dependent silent skips together with navigation contract migration, not independently.
4. Route immediate removal, system dismissal, and click auto-cancel through the same instance lifecycle.
5. Implement browser owner with equivalent fixtures and restart handling; remove stable thread-derived tag generation and page-owned removal decisions.
6. Remove obsolete thread-only dismiss APIs, base-plus-thread IDs, parallel card registries, and old tests once all actual consumers have switched. Keep adapter-only listener/handle ownership where required by the OS.

## Acceptance cases

- Failed first show creates no committed card and consumes no cooldown.
- Failed update preserves the last accepted contents, handle, and alert state.
- Failed removal preserves the card for retry/reconciliation.
- Accepted update reuses instance and handle where supported.
- Dismiss then recreate yields a new instance; old callbacks cannot affect it.
- Reordered update acknowledgements cannot overwrite newer state.
- Dismiss during submission cannot resurrect the dismissed card on a late result.
- Multi-card batches decide the next alert after the prior result.
- Adapter destruction settles queued but unexecuted work.
- Logout cannot complete while a pending submission may publish after clearing.
- Restart reconstructs existing OS cards and replaces them without duplicates.
- All paths preserve unread counts independently of cards and clicks.

## Validation status

The migration wires the shared transaction into native delivery and removes the eager paths described in the historical section. See the latest checkpoint in [native-notification-handoff.md](native-notification-handoff.md) for validation and remaining gaps. Host Rust tests, Android ARM64 library checking, and Windows target test-code checking have passed. Linux empty-state startup and warning-only uncertain-result settlement are approved behavior, not outstanding recovery work. macOS target validation and real OS acceptance remain unverified locally; compile checks and simulated lifecycle tests do not establish real OS behavior.

An OS acceptance receipt and local registry persistence are separate outcomes. Linux retains a successful show/remove receipt when subsequent bookkeeping persistence fails, keeps the latest live handle snapshot, and logs the persistence error. Later writes retry the snapshot. This protects subsequent operations in the same process from stale disk handles, but does not provide crash recovery. Android accepted show receipts must match the operation ID and the submitted tag/integer ID; malformed or mismatched post-invocation receipts remain uncertain.
