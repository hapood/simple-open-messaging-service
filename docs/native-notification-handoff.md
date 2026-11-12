# Native notification and unread migration handoff

## Serial migration update — 2026-11-07 — start here

This section supersedes the historical device-transfer and implementation notes below. The user has authorized full validation, commit, and push to `dev` for acceptance on other machines. Work remains serial; application installation/launch and erasing user caches/credentials are not authorized.

### Full-suite validation for alpha.2

Fresh local runs passed: backend unit tests (2,531), PostgreSQL integration tests (807 across 111 files), Web component tests (2,098 across 250 files), Web helper tests (39), administration tests (176), Playground browser scenarios (24), Rust library tests (377), and the full Android JVM suite with `--rerun-tasks`. Backend, Web, and administration production builds passed, along with cycle checks, version synchronization, federation conformance, and browser/cross-platform harness unit tests.

The first CI-equivalent pass exposed missing/stale native IPC permissions, obsolete auth viewport style assertions, and a missing Playwright browser binary. The permission list and assertions were corrected without changing authentication behavior, and the test browser was installed. Follow-up checks passed: native IPC permissions (1), repository tooling (280), Web build/style tests (63), Windows target test-code compilation, and Android ARM64 library compilation. Remote CI results remain separate from local validation. Real-device notification acceptance remains the next manual step.

### Approved Linux and uncertain-result policy — latest update

Linux starts with no adopted notification cards. Startup performs no OS cleanup/import/reconstruction. Ordinary show/remove no longer falls back to persisted registry IDs when the shared delivery state has no previous handle; a fresh show uses replaces_id = 0. Existing OS cards may remain alongside new ones. Explicit login/logout cleanup remains unchanged. This is the approved platform behavior, not an outstanding requirement to implement Linux enumeration.

An uncertain OS result now logs a content-free warning and finishes the attempt as unsuccessful. Pending state is released, committed card/content and accepted-alert timestamps are unchanged, and subsequent deliveries or recovery rounds can proceed. A late receipt for that retired operation cannot commit over a newer one. Adapter execution errors use the same settlement. No automatic retry/reconciliation was added; possible OS side effects, duplicate cards and repeated alerts on later attempts are an accepted tradeoff. Recovery failures still end the current round and retain candidates for a later round, just like definite rejection.

Validation: Rust library **377 passed**, including uncertainty release, late receipt rejection, unchanged alert eligibility, reconstruction retry and execution-error settlement. Windows target test-code checking and Android ARM64 library checking passed after the production changes. No App launch/install, data deletion, commit or push occurred. macOS target compilation and real OS notification validation remain unperformed.

### Full Windows target checking passed — 2026-11-08

Unpacked the distribution's MinGW GCC/G++/binutils and Windows headers into `/tmp/opencode/mingw-toolchain`, without system installation or global configuration changes. With that toolchain on the command-local PATH, both full-project `cargo check --target x86_64-pc-windows-gnu --offline --locked --lib` and `--tests` passed. This supersedes the earlier missing-C-compiler and missing-crate blockers. The checks include the actual Windows notification adapter and startup wiring, not only a standalone API probe. Existing dead-code warnings remain; no business code changed during this validation step.

These are cross-target compile checks, not executed Windows tests, linking/package validation or OS notification verification. History-object dismissal callbacks, replacement, startup clicks and logout must still be exercised on Windows. macOS target compilation and Linux's delivered-card enumeration limitation remain open, as does automatic reconciliation of uncertain native OS outcomes. No application was installed or launched; no user data was deleted, committed or pushed.

### Windows validation progress — earlier checkpoint

Installed the Rust `x86_64-pc-windows-gnu` standard-library target and populated missing Cargo cache entries using checksums from the existing project lockfile. No project dependency versions or global Cargo configuration were changed. The earlier `uds_windows` download blocker is resolved. Full project Windows checking now reaches native dependency compilation and fails because `x86_64-w64-mingw32-gcc` is absent (`ring` build script).

An isolated compile-only probe under `/tmp/opencode/windows-notification-check` passed for the Windows target using exactly `windows = 0.61.3` and the project's enabled features. It checks history enumeration, XML launch extraction, tag/group access, dismissal registration/removal and notification submission signatures, including the `i64` event token. This validates those API calls, **not the complete application or runtime delivery of callbacks on history objects**. The full Windows application, macOS target and real OS behavior remain unverified. No application was installed or launched; no commit or push occurred.

### Validation checkpoint — 2026-11-08

Final checks after the expanded regression fixes: Web development build passed; Android ARM64 offline/locked Rust check passed; Android notification/navigation Gradle validation completed successfully (the test task was UP-TO-DATE and reused its previous result); `git diff --check` passed. The preceding fresh runs remain **253 Web tests across 28 files** and **376 Rust host tests**. No additional recovery mechanism was added in this validation step.

Outstanding limitations must not be described as completed: Windows source is not target-compiled (offline dependency `uds_windows` unavailable); macOS Rust/Objective-C changes are not target-compiled on this host; Linux cannot enumerate delivered cards through the standard notification protocol and does not perform startup intersection reconstruction. Uncertain native OS outcomes still remain pending and block further preparation; automatic reconciliation has not been implemented. Real OS acceptance, replacement, dismissal and restart behavior has not been exercised because application launch/installation is not authorized. Worker lifetime replacement is tested through the host harness, not actual browser process termination.

### Expanded regression validation — latest update

Expanded Web validation to notification projection/adapters, Push, browser/native authentication, navigation, session ownership and database/SSE workers. This uncovered a real delta-projection regression: reading the current database state had replaced the three transient feed previews with the single preview intentionally retained in the cache. Delta selection now retains current local read state while taking previews from the matching consumed feed snapshot. Complete reconstruction continues to use only the current persisted projection. The regression test verifies both outputs without changing cache retention or alert policy.

Two Android navigation tests were stale after the native receipt migration. They now exercise the actual `{id, threadId}` bridge payload, exact receipt acknowledgement and malformed coordinate rejection, without restoring the removed notification-specific session/origin fields.

Validation: **28 Web files / 253 tests passed**; native host library re-run **376 passed**. These are expanded focused suites, not the entire repository test suite or real-device verification. Windows/macOS target validation and Linux's lack of a standard delivered-card enumeration remain limitations. No app installation/launch, user cache/credential deletion, commit or push occurred.

### Worker restart starts a new recovery round — latest approved behavior

A newly started Service Worker begins a fresh recovery round from the notifications currently in the OS. “Enumerate once” means once per recovery round, not preserving the original Notification objects across Worker lifetimes. The unconnected document-owner prototype and its protocol additions have been deleted; no persistent state, keepalive or page-owned notification executor is introduced.

Both initial wake paths now enter recovery: Push uses its existing capture/fetch/merge/rebuild path; the first online PRESENT captures current cards even when its entries are empty. A complete online synchronization triggers silent intersection reconstruction; a partial synchronization retains that round's candidates and pauses new offline wakes while its page remains present. Callbacks retire candidates within the round, with no per-card or post-fetch requery. Cards closed while the Worker was stopped are absent from the next round's initial capture. Previously admitted races remain uncompensated.

The earlier expected-failure tests have been replaced by ordinary tests for the approved new-round behavior. Nine focused Web suites pass **105 tests**, with no expected failures in the notification suites. Tests cover Push-first restart, empty-online-first restart, partial-to-complete online recovery without recapture, and dismissal during Worker downtime. Web development build passed. Tests simulate Worker lifetime replacement; no real application/browser termination was performed. Native verification remains the previously recorded 376 host tests, with Windows/macOS target validation and Linux's enumeration limitation still open.

### Windows startup capture — earlier update

Windows now reads `ToastNotificationManager.History().GetHistoryWithId` during storage initialization, before the WebView and HELLO. Only message-group cards are candidates; Rust validates the existing launch URL against the exact tag and retains the OS tag/group handle. Shared selection keeps one instance per thread and the adapter removes surplus handles. Captured toast objects receive dismissal subscriptions without fabricated process-local operation receipts. Their callbacks retire only the imported version, not a subsequently accepted update. Startup imports the candidates into the same shared reconstruction lane already used by desktop SSE batches.

Validation: Rust host library **376 passed**, including Windows activation/handle validation and imported-object callback tests; Linux normal library check passed. Windows offline target check remains **blocked by missing `uds_windows v1.2.1`**, so the WinRT code has not been target-compiled or exercised. This is source wiring, not verified Windows runtime completion. Linux still has no standard OS-card enumeration; macOS target validation and the browser Worker-termination gap remain open. No app install/launch, cache or credential deletion, commit or push occurred.

### Android offline admission — earlier update

The actual FCM and periodic background notification paths converge on JNI `queryNotifications` and shared Rust `notifications::synchronize`. This entry now samples reconstruction admission once, before scheduling synchronization. Pending or currently executing reconstruction returns `None` immediately, without waiting for recovery and without querying the feed. JNI returns null and the Kotlin adapter returns normally; a skipped wake is not an exception or a retry request. Online SSE continues to assemble with `from_result` and execute the shared batch path.

The existing native lifecycle integration test now exercises this real entry: a wake skipped during recovery stays skipped even if recovery ends before it is polled; holding the reconstruction lane does not block admission; a previously admitted wake continues if reconstruction begins before it runs. Ordinary captured-work cancellation remains unchanged. Validation: Rust library **374 passed**, Android ARM64 offline/locked check passed, Android notification/navigation JVM tests passed. No device or headless process-launch verification was performed. Windows startup capture and the Linux enumeration limitation remain open, as do macOS target validation and the browser Worker-termination lifecycle gap. No app launch/install, credential/cache deletion, commit or push occurred.

### Desktop batch and macOS startup wiring — earlier update

Desktop SSE batches now call the same `notifications/runtime.rs` orchestration as Android; the separate desktop batch loop has been removed. Platform callbacks can capture their host resources, while shared Rust still owns reconstruction, candidate/delta separation and receipt handling. Desktop execution uses the batch's captured work rather than a second caller-supplied owner.

macOS storage initialization now captures delivered message notifications before attaching the WebView and before HELLO. The Objective-C adapter returns only identifier/thread facts. Rust validates these facts, selects one candidate per thread, removes surplus identifiers, and imports retained handles before activation. The first successfully synchronized batch, including an empty delta, invokes shared intersection reconstruction. No OS requery, new persistent store, expiration change or in-flight recovery mechanism was added.

Validation: Rust library **374 passed**, Linux normal library check passed, Android ARM64 check passed. New host tests cover macOS observation decoding and pre-activation import followed by empty-successful-batch reconstruction with exact handles. **macOS Rust/Objective-C target compilation and OS behavior remain unverified on this Linux host.** Windows startup enumeration/import remains unwired. Linux's standard notification protocol has no delivered-card enumeration; the persisted handle registry is not proof of current OS presence and is not used to fabricate reconstruction candidates. Native offline admission review and the previously noted browser lifecycle validation gap remain open. No application installation/launch, cache deletion, commit or push occurred.

### Page startup wiring — earlier update

The page enters notification restoration through `BrowserSessionService.withRestoration` before local restoration publishes the session and before HELLO. It sends `RESTORE` to the existing Push Worker, which disables new offline message delivery for that document and captures candidates once. It does not drain or compensate already admitted Push work. Removed the mistaken online `PRESENT` / presentation-change pause guards. A closed restoring document no longer blocks background recovery.

The online database worker now sends an explicit `syncComplete` result even for an empty delta. The page relays it unchanged. After successful merge, the Push Worker reads the complete local projection and silently reconstructs the captured intersection before processing ordinary noncandidate entries. Failed reconstruction retains candidates for the next successful online batch. Notification close/click callbacks retire candidates without OS requery. Explicit session cleanup resets Worker recovery and alert memory in addition to closing system cards.

Validation for this slice: nine focused Web suites, **101 tests passed**, covering the database-worker empty result, page relay, pre-HELLO handshake, offline admission, reconstruction/retry/dismissal, closed-document recovery, cleanup, and no waiting for in-flight Push work. Web development build passed. These are host tests, not a real browser lifecycle/device test. Service Worker termination during the page restoration interval is not covered by an end-to-end test; no new persisted recovery state was added. Desktop startup reconstruction and native lifecycle admission review remain unfinished. Native code was not changed or revalidated in this slice (previous host suite: 371 passed).

### Simplified event-driven restoration — earlier update

Startup enumerates system notifications once and retains one candidate per thread. During fetch/merge and reconstruction, click/dismissal callbacks retire in-memory instances. Removed the extra post-fetch and per-card OS re-enumeration from native recovery and Web reconstruction. Check in-memory instance identity and cancellation before execution; accept the small non-atomic import/submission race rather than add polling or compensation. An unmatched removal observation logs a content-free warning only.

Native batch recovery orchestration now lives in `notifications/runtime.rs`, called by the Android adapter. Web `notificationclick` and `notificationclose` synchronously retire reconstruction candidates; the original thread candidate set remains available for same-round delta exclusion. Normal browser delivery still queries the OS set; reconstruction does not. Tests assert reconstruction performs no new enumeration and an unmatched callback cannot mutate another candidate.

Latest verification: Rust library **369 passed** (two OS-recheck tests removed, one diagnostic behavior test added); Android ARM64 check passed after native simplification; five focused Web suites **81 passed** after Web simplification. Historical verification counts and re-enumeration descriptions below are superseded by this section. Desktop startup recovery and the Web page-to-first-online-sync barrier remain incomplete; no real-device verification was performed.

### Clarified restoration contract

Login/logout clears notifications. Runtime restart enters the existing pre-HELLO restoration flow, first stopping new offline notification delivery without draining or compensating already in-flight operations. Capture existing notification instances as candidates, fetch server changes and merge local state, then reconstruct only the intersection of still-live candidates and the complete eligible projection. Update surviving instances silently in place and remove expired candidates. Never create projection-only cards during reconstruction; ordinary new-message delivery is separate.

A click or swipe retires its candidate immediately, including while fetching. Recheck exact instance presence before updating so an old snapshot cannot resurrect a removed card or overwrite a newer instance. This supersedes the earlier clicked-thread suppression proposal: no temporary suppression state is needed. Retain navigation separately. Web and Rust must share these semantics; the phase is not a new identity or authentication protocol.

The browser restoration entry now holds the existing `soms-notification-projection` lock while local resources restore, draining Worker projection first and retaining synchronous logout cancellation. Three focused suites (notification-session, browser-session-owner, session-bootstrap) pass **36 tests**. This is only the local-restoration portion: the barrier does not yet extend through post-fetch reconstruction. The browser now has separate explicit delta and complete-state reconstruction projection entries sharing content rules. The Push Worker invokes candidate capture before its first background synchronization, retains candidates across failures, and silently reconstructs the live intersection after successful merge. Candidate threads are excluded from that round's ordinary delta delivery so a click during fetch cannot recreate them. Non-candidate new-message deltas remain ordinary delivery. Five focused Web suites pass **80 tests**, including real Push entry reconstruction and retry cases. This does not yet wire page startup through the post-HELLO online synchronization barrier; Worker startup and page startup are distinct lifetimes.

The browser card owner and Rust delivery state have tested intersection-reconstruction operations. Native complete-state projection now has an explicit `for_reconstruction` entry that shares content assembly with the delta path without setting synthetic `notification_changed` flags. Regression coverage verifies unchanged states are included only by reconstruction and an empty supplied set remains empty. Desktop startup OS enumeration/import and lifecycle invocation of that projection and intersection delivery are still not wired. Android now writes the existing Rust thread target into notification extras as `soms_thread_id`, alongside the unchanged click Intent target. `currentMessageNotifications` enumerates message cards with that field and returns actual thread/tag/integer-ID facts; the JNI `current_cards` bridge decodes and validates them without merging same-thread instances. Enumeration exceptions and malformed results are errors, not an empty success. Older cards lacking the field are not imported; no legacy ID guessing was added. Android now invokes the bridge during process runtime initialization before credential activation, imports the observed cards, and retains original candidates in the login owner's reconstruction lane. The first successfully synchronized batch reads the complete merged state, re-enumerates OS presence, and invokes shared serial intersection delivery. The same batch excludes original candidate threads from ordinary delta delivery. Failed synchronization/reconstruction retains candidates; cancellation of the batch waiter does not abandon accepted operations. Android target compilation passes and the host Rust suite passes 366 tests, but this Android path has not been device-tested. Rust selects one instance per thread in stable instance/handle order, removes surplus Android handles through the existing command/result adapter, then imports the retained cards. Web candidate capture applies the same one-per-thread rule and closes surplus message cards without touching probe notifications. Selection does not infer recency from UUIDs. A selected card dismissed during fetching is not replaced by a discarded duplicate. OS enumeration versus final update is not atomic. This does not implement desktop restart recovery or the Web page pre-HELLO barrier. Rust candidates currently come from published in-process cards; that is not yet OS restart recovery. Browser OS presence is rechecked after asynchronous preparation, but the browser API offers no atomic update-if-still-present operation, so dismissal racing the final OS submission still requires lifecycle review.

Implemented and wired:

- Native desktop, Android SSE, and Android explicit synchronization use shared Rust `delivery::deliver` prepare/execute/complete ordering. Removed eager `LoginConnection` alert mutation and Kotlin notification projection queue/callback paths. Caller cancellation does not abandon a submitted operation.
- Android executes one command synchronously and returns an operation-correlated result. Rust uses the saved tag/integer ID and validates both in accepted show receipts. JNI preparation failures before invoking Kotlin are not executed; failures after invocation remain uncertain unless Kotlin supplies a definite result. Receipt parsing has host regression tests; this is not real Binder failure injection.
- Linux uses direct D-Bus calls to the captured unique daemon and retains returned numeric handles. Signal matches are installed before submission; listener cleanup is operation-correlated. Removed unused `notify-rust`. A successful OS reply remains accepted even when local registry persistence fails. The process retains the latest registry snapshot and retries it on subsequent writes; this does not solve crash/restart recovery.
- Desktop adapter failures now carry explicit not-executed/rejected/uncertain types rather than diagnostic-string prefixes. Linux missing-reply, timeout, and disconnect errors remain uncertain even when D-Bus represents them as method errors. Windows submission-call failures are conservatively uncertain; its pre-submission preparation failures are not executed. macOS completion errors and missing completion results remain distinct.
- Windows dismissal subscriptions report exact operation/instance observations. Click URLs contain only thread and instance identity. These adapter changes have not been target-compiled or exercised on Windows.
- Web Worker records cooldown only after successful `showNotification`, and uses OS-card metadata for once-per-thread behavior. Removed upstream constant renotify values. Browser notification clicks retain the existing browser session contract; native click targets do not carry it.

Latest validation in this checkout:

- Host Rust full library suite: **368 passed**, including intersection-reconstruction, receipt identity, registry persistence-failure, and explicit desktop failure-classification regressions.
- Browser notification-cards, push-worker, notification-session, browser-session-owner, and session-bootstrap suites: **80 passed** across five files, including one-per-thread restoration and Push entry coverage.
- Android ARM64 offline/locked library check: passed after startup reconstruction and duplicate-handle cleanup wiring.
- Android notification-batch/navigation JVM tests: passed after adding notification extras and the enumeration method. These do not exercise a real NotificationManager query.
- Linux normal library check: passed after the explicit desktop failure-type and D-Bus error-classification changes.
- Earlier in this serial migration: Android notification-batch/navigation JVM tests passed; six focused Web suites passed **60 tests**. Neither is a claim of real OS notification validation.
- Windows offline check was blocked by missing target/dependencies (`uds_windows`); macOS target compilation was not performed here.

Still incomplete:

- Desktop candidate capture/import and startup reconstruction; Web page restoration through its first online synchronization (distinct from the wired Push Worker path); Android end-to-end device verification. The former clicked-thread suppression proposal is superseded; no suppression state was added.
- Reconciliation of uncertain OS results. An uncertain operation remains pending and blocks preparation; do not convert it to rejection just to unblock the lane.
- Platform lifecycle/resource review and real-device notification acceptance, dismissal, replacement, and logout verification, particularly Windows/macOS.
- Web cooldown survives only within the current Worker process; no new persistent history/database has been introduced.
- `DeliveryState` still contains committed alert metadata plus published content/handles; do not claim final state-model consolidation.

## Historical device-transfer checkpoint

This is an intentionally unfinished development checkpoint on `dev`, not a release. The user requested committing and pushing the current workspace to continue on another device. The snapshot includes other previously dirty work (admin/UI, chat scrolling, native launch and settings), not just notification changes. Do not discard or assume those changes were covered by notification tests.

On the next device:

1. Fetch `origin`, check local work first, and update `dev` with a fast-forward only. Read `AGENTS.md`, this section, and `docs/notification-delivery-transactions.md` before editing.
2. Inspect current source rather than treating the chronological notes below as simultaneous truth. Later sections supersede earlier ones.
3. Continue in meaningful end-to-end slices; the user explicitly objected to stopping after tiny cleanups/tests. Finish wiring and delete replaced paths instead of repeatedly growing prototypes.
4. Do not install/launch the app or erase caches/credentials. Commit/push permission here applies to this device-transfer checkpoint, not automatic future releases.

Current production state:

- macOS uses serial Rust delivery transactions, full OS instance identifiers, accepted-content/handle tracking, and acceptance-time cooldown. Callbacks return full OS identifier; Rust parses instance identity. Logout drains the presentation lane before resource cleanup. Foreground policy is visible AND focused; only the open thread is suppressed/removed.
- Android consumes Rust-sanitized content, Rust instance IDs, and shared alert decisions. Kotlin old throttle/ID derivation/descriptor extras were removed. Android still uses eager state mutation, legacy identity checks and Kotlin projection orchestration. Its delivery transaction and click/session cleanup are NOT finished.
- Windows/Linux still use legacy ID/alert paths. Linux resource handle registry requires careful daemon-identity preservation during migration.
- Web online/PUSH delivery now shares Service Worker-owned instance tags and uses existing OS cards as a restart-recoverable ledger. Removed upstream stable thread-tag generation and page-selected thread removal; page sends presentation wake, Worker queries facts. Browser cooldown/once-per-thread policy and session-scoped clicks still differ from target semantics.
- Native restart reconstruction/uncertain outcome reconciliation are NOT implemented. A missing memory Map while OS cards remain can still create duplicate instances after restart. This is a priority, not a completed feature.
- `DeliveryState` currently contains both committed alert-card metadata and published content/handles; future consolidation must retain transactional behavior. Inspect before claiming a single finalized Map model.

Latest executed validation: host Rust `cargo test --manifest-path src-tauri/Cargo.toml --offline --lib`: 341 passed. Five Web suites (notification-cards, push-worker, thread-notification, unread-attention, browser-notification.adapter): 47 passed. No claim of full Web/admin regression or real OS notification tests.

Android validation is blocked on this device: missing generated `tauri.settings.gradle`, NDK, Android Rust targets, and no modern JDK found via java_home (only JDK 8). Set up the supported Android/Tauri build on the next device; do not fabricate configuration or overwrite customized generated source to hide failures. Run Android JVM tests and target compile before further large Android changes.

Next priorities: validate Android compilation, finish native restart/uncertain reconciliation, wire Android prepare/execute/result transactions and remove eager APIs, then migrate Windows/Linux and browser alert semantics. Preserve instance IDs across updates, return OS-assigned handles, correlate results by operation ID, and never introduce notification login-identity guards.

Local `/tmp` logs and backup stashes mentioned below are not transported by Git. No build/install was performed for these migration changes. The installed app on the original device does not reflect this checkpoint.

## Working context

Repository: `/Users/hapood/Projects/simple-open-chat-service`. Work is in the shared checkout with extensive pre-existing and concurrent dirty changes. Do not reset, restore whole files, or commit/push without permission. Inspect current status/diffs first. Earlier base was branch `dev` at `37d4f127`; verify current HEAD rather than assuming it is unchanged. A previous backup stash was `4ff60c8b66de5a62f16388c2f7e9c8c588ba0071`.

No application packaging/replacement has been done during this extended migration. Installed `/Applications/SOMS.app` is an older diagnostic build, not current source. Normal delivery requested earlier: build, back up and replace app, leave stopped for user GUI launch; do not launch with inherited terminal proxies. Preserve login data and caches.

Delegation previously failed with `Direct delegation requires a Herdr-managed Pi pane (HERDR_ENV=1)`. Do not assume delegation is available. Read repository AGENTS.md and the delegation skill before using workers.

## User-approved architecture (important)

- All native business decisions belong in shared Rust, not WebView or Kotlin.
- Rust produces final notification instructions: show/upsert, remove, clear, content/name/avatar/message list, grouping/identity of the notification, sound decisions and click target. OS adapters render and report facts only.
- WebView must not push generated notifications to Rust or explicitly select notifications to remove. It may report presentation facts. Current desktop observation command is parameterless `desktop_notification_presentation_changed`; Rust reads window state and existing open-thread state itself.
- Browser Web remains a separate host. Its Worker/Push Worker business semantics must agree with Rust; do not invent browser Rust runtime.
- Shared Rust computes unread totals from durable unread projection. Notification dismissal does not mark read or decrement unread. Muted conversations remain included in the existing macOS total.
- User swipes away a system notification: OS removes directly; optionally report dismissal to Rust to retire alert bookkeeping. No round trip for deletion authorization. Clicking reports a thread target; clicking alone is not a read receipt.
- Notification presentation and deletion must not perform duplicate login/session/origin checks. Login/logout transitions stop old work and clear notifications before a successor login. Remove notification-specific identity state and payloads. Ordinary captured business work cancellation remains in Rust; do not confuse it with duplicate notification authorization.
- User explicitly wants no Web notification `generation` concept. Removed redundant generations in renderer notification paths; unrelated call/media/launch generations were not removed.
- Keep 2s/5s cooldown and once-per-thread alert policies, but own them in shared Rust; remove Android's parallel implementation after switching consumers. Existing 5s default is retained as native shared default, not an Android special case.
- Avoid endless parallel scaffolding. Many helpers below were added incrementally; finish actual migration and delete obsolete paths rather than continuing to add unused modules.

## Original goals still relevant

Fix macOS message notifications (renderer previously discarded due to empty origin), minimize main window rather than exit on close, clean settings layout/remove app updater. Native close-to-minimize and initial notification authorization fixes exist in dirty source. Broad session ownership work also exists: persistent SessionStore and worker/native LoginConnection.

## Current notification state

### Desktop production path switched

`src-tauri/src/sse.rs` now captures `intent.database_work()` on Android and desktop. After thread synchronization:
- macOS invokes `desktop_badge::refresh_owned` using captured work.
- Android still publishes original `Output::Notifications(batch)` to old Kotlin consumer.
- desktop calls `notifications::from_result`, then `desktop_notifications::deliver_batch`.

`web/src/app/services/unread-attention.service.ts` no longer subscribes to `convList.threadNotifications$` for native presentation. Removed its `present()` method, desktop cursor/queue/generation and content/profile dependencies. Browser Worker-to-Push-Worker relay unchanged.

Deleted `desktop_notification_update` IPC. Rust internal delivery remains. Deleted Tauri `showDescriptor()`. Deleted unused `web/src/app/services/notification-adapter.ts` and unreferenced `notification-trace.ts`.

`TauriNotificationAdapter` now has `presentationChanged()` (no args), `dispose()` and `clear()`. Its `disposed` flag only protects adapter destruction. It still uses SessionLifecycle to avoid obsolete page observations and still sends clear on lifecycle invalidation; review this against final ownership boundary. `UnreadAttentionService` distinguishes native observer and browser dismiss adapter without casts.

### Desktop notification identity removed

- Removed `LoginConnection.notification_identity`, setter/getter/test, and HELLO notification binding. Ordinary realtime `Identity(user, session)` output remains.
- `DesktopNotification` no longer carries session ID/origin; display does not wait for HELLO identity.
- macOS Rust FFI and `macos_notifications.m` post/tap signatures only carry thread target and display values. No session/origin userInfo.
- Linux action listener carries thread only.
- Windows activation format is exactly `soms-notification://thread/<positive canonical i32>`. Old session/origin URL compatibility removed. Windows/Linux target compilation has NOT been run.
- `PendingTap` has `id`, `thread_id`; acknowledge receives receipt id + thread id only.
- Web `ThreadNavigationIntent` is a discriminated union: desktop has no sessionId; Android/Web still require it. Coordinator only compares server session for non-desktop intents, still waits for navigation hydration.
- Desktop page navigation no longer checks notification origin/session. Regular page/navigation lifecycle invalidation remains.

### Shared Rust notification helpers

`src-tauri/src/native_db/notifications.rs`:
- Existing original native assembler reconciles local read positions, profiles, tombstones, avatars, consumed feed work.
- `NotificationBatch` now includes typed `threads: Vec<NotificationThread>` and `unread_total`, plus old Android metadata JSON, avatars, login_session_id.
- Metadata includes `unreadTotal`. Total is read within assembly transaction using shared unread helper, not sum of notification delta.
- Blocked conversation produces unread_count=0 and no previews/avatars; does NOT alter account unread total.
- IMPORTANT last change: assembled preview JSON now removes `createdAt`, adds integer `timestamp` milliseconds parsed in Rust using chrono RFC3339. Android consumer updated accordingly. This is a coordinated source change but Android tests/build not yet run.

`notifications/content.rs`:
- Shared `NotificationCopy` with English/Chinese localized copy (currently hardcoded; user language vs OS language fallback still unresolved).
- `NotificationMessage`: seq, sender_name, sender_key Option (`account@domain`), timestamp_ms Option, avatar_index Option, sanitized text.
- `NotificationContent`: thread_id/title/body/count/silent/messages/has_unread_mention.
- Serialized `NotificationCommand`: operation `show` or `remove`, payload under `notification`; show means upsert same thread card.
- Privacy mode emits generic body and empty messages; strips message sender/time/avatar refs. Conversation title still present.
- Filters read previews, sorts by seq, sanitizes retraction/removal. Unknown status uses private fallback (different from Kotlin's old throw).
- Foreground visible+focused open thread outputs Remove. Other states respect enabled/sound/privacy prefs.
- Content currently joins messages into newline body; Android old body uses latest message + MessagingStyle. Need preserve platform style while sharing ordered data.

`notifications/alert.rs`:
- `AlertPolicy::Cooldown(Duration)` or `OncePerThread`; from existing strings, default 5s.
- `AlertState` tracks last alert and alerted thread IDs; owned by LoginConnection (`notification_alerts`).
- Remove/muted/not-allowed instructions do not consume cooldown; first eligible show does. Once-per-thread resets on Remove or `dismissed(thread)`.
- `LoginConnection::apply_notification_alerts`, `notification_dismissed` methods. Dismissal isn't wired to OS callback yet.
- Remaining correctness gap: bookkeeping consumed before successful OS delivery; failure can consume alert eligibility. Global cooldown and once-per-thread behavior after user dismissal need full tests once wired.

`notifications/presentation.rs`:
- Shared async `prepare_batch(work, batch, facts, allow_alert)` reads persisted prefs + language, builds commands and applies owner alert state.
- Returns `PresentationBatch { commands, unread_total, avatars }`.
- Avatar package validates indices, copies only used avatars, remaps/dedups, excludes bytes from JSON serialization. Validation happens BEFORE alert state mutation.
- Desktop `deliver_batch` uses shared entry then executes commands; currently does not use full messages/avatar bytes (OS rendering still basic title/body). Android does NOT consume PresentationBatch yet.

`native_db/preferences.rs`:
- Shared notification prefs reader for enabled/sound/preview from existing device keys (single statement); no new store.
- `read_notification_preference` no longer Android-only; supports old preview/alert policy keys.
- `notification_language()` reads `language`, absent -> English. This differs from Android system locale and browser system fallback; resolve before claiming parity.

### Unread / badge

`native_db/unread.rs` extracted exact existing macOS sum:
`SUM(MAX(unread_count,0))` over threads for account with thread_feed_id>0; includes muted, uses optimistic read projection.
`desktop_badge.rs` uses it, keeps main-thread publication/revision protection against stale business results.
macOS SSE thread sync now calls `refresh_owned`. Old page `DesktopBadgeService` refresh still exists for other triggers (local reads/restoration); do not delete until all native triggers covered.
New logout coordinator now explicitly resets macOS badge when ending owner (it initially bypassed old reset helper).
Other platform global badges NOT wired. Android per-notification `setNumber(d.count)` isn't a global unread total and launchers have different behavior.

### Android old business logic remains (priority)

Files:
- `NativeNotificationBatch.kt`: still parses raw `threads/previews`, sorts, substitutes status text, privacy/body, constructs NotifDescriptor. **Last change removed SimpleDateFormat/TimeZone and reads `preview.getLong("timestamp")`**. Test fixture timestamps updated in `NativeNotificationBatchTest.kt`.
- `SomsMessagingService.kt`: `renderNativeBatch`, `renderAwayNotificationOnce`, `renderDescriptors`, `renderThreadDescriptors` still implement foreground filtering, coalescing/sync coordination, AlertThrottle2s/5s and once-per-thread decisions. Rust JNI still sends raw NotificationBatch, not PresentationBatch.
- `NotifDescriptor.kt`: Android rendering model with messages including senderKey/timestamp/avatar; retain only mechanical conversion/system rendering after migration.
- `ClientStateDb.kt`: existing preferences (`notificationAlertPolicy` default cooldown_5s).
- `AlertThrottle.kt`: delete only after shared Rust policy controls actual Android delivery.
- `android_runtime.rs::notification_object` constructs Java `NativeNotificationBatch(metadata, avatars, loginSessionId)`; called by queryNotifications and android_realtime output handler.
- `android_realtime.rs` still checks login_session_id for batch and invokes onNotifications; contains old session-coupled path.

Do NOT claim Android policy migration completed. Previous turns repeatedly proposed it but mostly only added shared helpers. User specifically expects substantial Kotlin deletion and one shared Rust pipeline.

## Web parity audit

`docs/notification-parity-audit.md` records evidence; some findings are now fixed, update it.
- Fixed blocked-only transition: both shared/thread-attention.ts and Rust attention merge trigger notification_changed only on false -> true blocking; unblocking alone doesn't re-alert history.
- Web descriptor already sets blocked count=0. Rust assembler now does too.
- Browser visibility asks active page with 500ms timeout; unknown visible page suppresses notifications. Native new policy removes active card; verify equivalent lifecycle semantics.
- Browser alert cooldown parity still NOT implemented.
- Browser and native use distinct session protocols; no new epochs/stale-push schemes wanted.

## Logout/session migration status

Web:
- SessionStore key stays `soms.login-session.v1`; legacy records accepted, nullable confirmed identity.
- `revoking` persistent phase retains identity while disabling Push Worker admission. Interrupted revocation cannot be restored as active or overwritten by login.
- BrowserSessionOwner.logoutWithDecision serializes auth, cancels work, keeps credential until remote confirmed/localOnly. 10s real transport timeout, explicit retry. Old `logout()` removed.
- AuthService browser explicit logout wired; single-flight duplicates join; forced local clear joins ongoing logout. LogoutDecisionService modal has Retry/Local-only; undefined dismissal rejects rather than authorizing deletion.
- Web revocation retry after page restart possible via persisted record at owner level; actual cold-start prompt NOT wired.

Rust/desktop:
- AuthLifecycle has Logout phase to block login/server setup across operation.
- Native SessionStore has Revoking, denies normal restore via explicit error (not None, which would trigger credential deletion), blocks new preparation/end_current; retains fingerprint.
- `native_logout.rs`: LogoutOperation/Coordinator retained in ServerSessionState Arc. Owns token, origin, auth guard, source owner and preparation/cleanup task handles. Retry preparation handles cancelled waiters without duplicate blocking tasks.
- Desktop `begin_logout` now invokes new coordinator; `try_logout` executes one bounded 10s revoke; `finish_logout(localOnly)` finalizes Rust OS storage + durable state. `logout_status` projection.
- Local-only decision and confirmed success retained in operation phase; failed cleanup remains retryable. Process restart restoration of operation/decision NOT complete.
- AuthService desktop wired begin -> release UI resources -> status/try -> modal -> finish -> clear UI/notifications. Native token retained until final cleanup.
- Android still old `begin_logout`/LogoutTasks tickets/wait_for_logout; old code cfg excluded on desktop, not deleted globally.
- User explicitly rejected deletion-layer identity validation. credential_storage::clear only serializes storage and executes callback, no UUID checks. secure_clear_token IPC/internal no longer take UUID. Normal write/business checks retained.
- Potential ordering issue to review: desktop Rust finish releases Logout guard before frontend notification clear; user expects notifications cleared before new login. Do not paper over with notification identity checks—fix coordinator ordering.

## Tests and operational evidence

Most recent change: Rust parses preview timestamps, Kotlin consumes numeric timestamp. Rust command:
`cargo test --manifest-path src-tauri/Cargo.toml --offline --lib native_db::notifications`
**28 passed**; log `/tmp/soms-rust-timestamp.log`.
Android JUnit/Gradle tests and Android Rust target build NOT run for this change.

Earlier Rust full library run: **317 passed** after correcting cancellation socket tests; counts fluctuate as tests added/deleted. `/tmp/soms-cancellation-regression.log`.
Earlier repeated failures were TCP cancellation tests expecting EOF only, while macOS returned ConnectionReset. Updated `src-tauri/src/tests/native_history_owner_tests.rs` and `login_request_tests.rs` to accept EOF/reset, still reject timeout/other errors/data. No production transport changes for that fix.

Web broad focused run (7 files) initially 104/105; corrected native IPC mocks to return Promises and support finish_logout, then auth native file 25/25 passed. Other six passed previously. Subsequent focused tests:
- unread + navigation: 13 passed (`/tmp/soms-unscoped-desktop-tap.log`).
- notification adapters/unread: 13 passed (`/tmp/soms-notification-adapter-cleanup.log`).
Older unrelated frontend compile blockers (followBottom config and localLatest test) disappeared due to other checkout activity; don't restore those files.

Native macOS full application build, real notifications, cold restart/logout prompts, Windows/Linux cross compilation and Android build remain unverified. macOS Objective-C deprecation warning for UNNotificationPresentationOptionAlert still exists.

## Follow-up validation

- Added `assembly_projects_rfc3339_timestamps_for_native_consumers` in `notifications.rs`. It exercises the actual database-backed assembler for UTC without fractional seconds, millisecond precision, and an explicit UTC offset; verifies both JNI metadata and typed previews contain integer `timestamp`, with no old `createdAt` field. Focused Rust test passed (log `/tmp/soms-timestamp-assembly.log`).
- Attempted `./gradlew :app:testDebugUnitTest --tests com.soms.client.NativeNotificationBatchTest` in `src-tauri/gen/android`. Gradle failed during settings evaluation because generated `tauri.settings.gradle` is absent, before any tests ran (log `/tmp/soms-android-notification-test.log`). Restore/generate the project through its supported Tauri tooling before claiming Android validation; do not fabricate plugin settings to bypass the failure.

- Desktop `finish_desktop` now owns notification/pending-tap clearing inside the retained blocking cleanup task, before credentials are deleted and the Logout admission guard is released. Cancellation of an IPC waiter therefore retains the same task. Existing native logout tests: 13 passed (`/tmp/soms-logout-clear.log`); no real OS notification test yet. The frontend clear path still remains and needs removal once other lifecycle paths have native coverage.

## Latest Android wiring changes

- `android_runtime::notification_object` now packages shared Rust `command_with_facts` output rather than raw previews. Kotlin reads `commands` and final message values; removed Kotlin preview sorting, status interpretation, and privacy-body selection. JNI forwards only avatars referenced by final messages. `commitEvent` and partial-sync error metadata remain preserved.
- Android reports existing visibility/open-thread observations through `@Keep @JvmStatic` getters. Rust applies shared foreground suppression; removed both Kotlin descriptor-filter branches. Visibility currently retains the old onResume/onStop interpretation (`focused = visible`); window-focus-specific facts remain future work. Observation-only reads are not an immediate lifecycle-triggered removal mechanism: suppression applies when a batch is presented. MainActivity still has separate selected-thread removal behavior to migrate.
- Kotlin `previewMode` is currently derived mechanically from whether the final message list is empty for choosing BigTextStyle vs MessagingStyle. No preference lookup is involved in content decoding.
- Alert throttling, once-per-thread logic, notification identity checks and coalescing remain Kotlin-owned; do not claim complete migration. JNI currently calls the shared content/package functions directly, not the async alert-enabled `prepare_batch` entry.
- Shared Rust notification suite remains 29 passed (`/tmp/soms-android-facts.log`). Android-specific Rust/JNI compilation and updated Kotlin tests remain unverified due to missing generated Gradle settings. New JNI getters must be validated in an Android build.

## Shared alert cutover follow-up

Android JNI now accepts `allowAlert` for explicit synchronization and applies Rust `AlertPolicy`/LoginConnection alert state before serialization; realtime batches currently pass true. Kotlin rendering uses only final `silent`, and no longer calculates cooldown/once-per-thread or uses Android `setOnlyAlertOnce` as policy. Deleted the unused Kotlin `AlertThrottle.kt` and `AlertThrottleTest.kt`. Shared tests now cover both 2s and 5s windows immediately before and exactly at the boundary, including non-extension by suppressed attempts: notification suite 30 passed (`/tmp/soms-shared-alert-regression.log`).

Remaining validation/design gaps: Android compilation still not run; notification_object currently obtains active_login at presentation time rather than carrying the original captured owner through the batch, which must be fixed to avoid applying old work to a successor owner. Delivery failure still consumes alert state, and OS dismissal callbacks are not wired to retire once-per-thread state. Coalescing/allowAlert wake selection remains in Kotlin. These are not completed by the alert cutover.

## Captured owner follow-up

Runtime notification assembly now retains its original `DatabaseWork` in the in-process batch. Android JNI requires that context, validates its ordinary cancellation, and applies alert state on that captured owner rather than looking up active_login at presentation time. Raw database-only assembly has no runtime context and is not a JNI delivery entry. Tests verify exact owner retention and cancellation after ending the owner; shared notification suite 30 passed (`/tmp/soms-captured-notification-owner.log`). This supersedes the active_login issue above; OS delivery failures/dismissal and Android build validation remain unresolved.

## Android dismissal observation

Added an explicit non-exported `NotificationDismissedReceiver` and immutable per-thread delete PendingIntent on message cards. It reports only threadId to Rust `notificationDismissed`; Rust retires that thread's once-per-thread alert bookkeeping if a runtime is active. No read receipt, badge mutation, notification removal, or session/origin payload is involved. This observation intentionally targets current in-memory bookkeeping, unlike asynchronous projection work, which retains its captured owner. Existing shared alert tests: 6 passed (`/tmp/soms-dismissal-alert.log`), including preserving other cards and global cooldown. Actual Android receiver/JNI behavior remains untested; Android target and generated Gradle settings are still unavailable. Programmatic removal and notification clicks are separate paths and are not covered by a delete-intent callback.

## Android immediate presentation observations

Removed MainActivity's selected-thread/foreground removal decision. Selection and onResume now call a platform observation adapter on the UI thread. Rust `notificationPresentationChanged` applies the same `visible_thread` predicate as batch content policy, retires that card's alert state, and returns an optional removal target encoded as positive thread ID (otherwise -1). Kotlin executes cancellation only for that returned target. This remains an immediate synchronous JNI path, separate from batch serialization; no read/badge mutation or identity payload. Notification suite 31 passed (`/tmp/soms-presentation-observation.log`), including exhaustive visible/focused/valid-target cases. Android build/runtime validation and actual focus observation (currently visible implies focused) remain outstanding.

## Latest user decision: foreground AND focused

The user reconsidered the foreground-only simplification and explicitly selected foreground AND focused. This supersedes earlier focus/visibility notes: suppress/remove the open thread only while visible and focused; background or unfocused hosts permit that thread's notifications subject to normal preferences. Android now reports real `onWindowFocusChanged` observations, initializes focus from `hasWindowFocus()` onResume, and resets it onStop. Both immediate JNI observations and batch facts include focus. Desktop reads window focus; Web Push checks visible plus focused, while the page combines visibility and document.hasFocus and observes blur/focus. Returning to focused foreground triggers current-thread removal. Rust notification tests 31 passed and Web push/unread tests 31 passed (`/tmp/soms-focus-policy.log`, `/tmp/soms-focus-policy-web.log`). Android-specific build and real host behavior remain unvalidated.

## Desktop native focus wake

Main-window focus gain now directly invokes Rust presentation observation from `window_lifecycle`, independent of WebView event forwarding. Shared visible-thread policy selects removal, and the owning alert state is retired for that card. Other windows and focus loss do not trigger clearing. Window lifecycle tests 2 passed (`/tmp/soms-window-policy.log`). Renderer observation remains for existing selected-thread changes; do not remove until native trigger coverage is audited. Real desktop restore/focus behavior remains untested.

## Focus regression validation

Web Push fixtures now model visibility and focus independently. Added cases for visible/unfocused, hidden/focused and hidden/unfocused: the open thread may notify and no active-chat query is needed. Existing visible/focused cases still suppress only the open thread. Web push/unread tests 34 passed (`/tmp/soms-focus-matrix-web.log`); full host Rust library suite 322 passed (`/tmp/soms-native-full-focus.log`). These are host tests, not Android JNI compilation or OS delivery validation.

## Card instance model migration (incomplete)

Latest user requirement: runtime owns a thread-to-current-card Map including notification instance ID and alert history. Updates reuse that instance, removal/dismissal retires it, new cards receive new IDs; platform/Worker execution must use the explicit instance ID. Old code must be deleted after cutover.

Replaced Rust AlertState.alerted_threads with a cards HashMap storing UUID notification instance IDs and per-card last_alert. Silent cards also create entries. Added exact-instance dismissal and ID accessors, tested update reuse, recreation with fresh ID, and rejection of a stale dismissal. Alert tests 8 passed (`/tmp/soms-card-map.log`). IMPORTANT: instance IDs are not yet emitted to platforms, existing thread-only callbacks remain, and state is still mutated before delivery success. This is an internal model step, not completed OS lifecycle ownership. Next work must wire IDs and delivery confirmation, remove thread-only dismissal, then migrate the Web Worker rather than adding a second card authority.

## Android instance ID adapter cleanup

Removed `NotifThreadLogic.notifId` and its base-plus-thread test. Android descriptor parsing now requires nonblank Rust IDs for show/update, preserves IDs as OS tags, and skips only removals explicitly lacking an existing instance. Deleted render-time empty-tag skipping. Updated JVM fixtures with explicit IDs and added missing-show-ID rejection / absent-card removal cases; these Kotlin tests have NOT run because Android Gradle setup remains incomplete. Targeted diff whitespace checks pass. Previous Android instance wiring uses Rust UUID tags plus a fixed integer OS ID, distinct delete/click PendingIntent data per instance, and tag-aware cancellation. Immediate removal returns the instance ID rather than threadId. Other platform IDs, delivery confirmation, restart recovery, and old identity payload cleanup remain incomplete.

## Atomic instance operations follow-up

Android batch alert preparation now captures each command's instance ID inside the same card-state lock (`prepare_notification_instances` / `apply_with_instances`), replacing before/after ID queries. Tests cover show/update/remove/recreate within one batch. Immediate presentation removal now atomically removes a card and returns its ID (`remove_notification_instance`), deleting the old read-ID-then-remove sequence. Alert suite 10 passed (`/tmp/soms-card-remove.log`). These operations still change state before OS acknowledgement; delivery confirmation remains a required architectural change, not solved by locking. Android target compilation remains outstanding.

## Delivery transaction design checkpoint

See [notification-delivery-transactions.md](notification-delivery-transactions.md) for the inspected Android early-return/queue-drop paths and the required prepared-operation / explicit-result / committed-card contract. Per-card instance ID is insufficient for successive update acknowledgements; each operation needs its own ID. This is an internal execution receipt, not login identity. OS acceptance is not proof of audible/visible delivery. No production transaction wiring was changed in this checkpoint; eager state mutation, immediate pre-OS removal, and platform recovery remain incomplete.

## Prepared-delivery implementation status

Added `notifications/delivery.rs`: a serial pending-operation prototype over a cloned candidate AlertState, exact operation receipts, definite rejection preserving committed state, and dismissal applied to both committed and pending candidates. Acceptance now timestamps alert history at receipt time rather than prepare time. Delivery tests 6 passed (`/tmp/soms-delivery-accept-time.log`), covering rejection, wrong/duplicate receipt, failed removal/update, dismissal before acceptance, and delayed acceptance cooldown. IMPORTANT: this module is not yet wired into production. Existing eager APIs remain live. The prototype does not yet retain complete content/platform handles or handle cancellation/reconciliation; do not claim the transaction migration is complete.

## First production transaction cutover: macOS

macOS `deliver_command` now owns a spawned transaction through OS completion under a per-owner asynchronous presentation lane, preparing before execution and committing on accepted completion. Batch packaging no longer eagerly consumes macOS alert state. Explicit OS errors reject; join failures retain an uncertain operation. Logout preparation ends owner admission and drains this lane before releasing resources. Host full suite 333 passed (`/tmp/soms-live-delivery.log`), then logout suite 13 passed after lane drain (`/tmp/soms-delivery-logout.log`).

This is NOT the final instance migration: macOS still posts thread-derived system identifiers and maps dismissal by that legacy handle. Pre-acceptance dismissal and old-handle reuse can still be ambiguous; replace FFI identifiers/callbacks with instance IDs next. Platform content/version/handle is now committed in DeliveryState, but uncertain reconciliation/restart recovery are absent. Android/Windows/Linux remain on eager state. No real OS test or application installation occurred.

## macOS OS instance ID cutover

macOS post/remove FFI now carries the Rust card instance UUID. OS identifiers use the existing SOMS prefix plus that UUID, with threadId separately in userInfo; no login fields. Tap/dismiss callbacks return instance UUID plus threadId and retire exactly that instance, including a pending candidate, before optional tap navigation. Removed parsing threadId from the OS identifier and removed DeliveryState.dismissed_platform lookup. No-card removal is a no-op, while show without an instance ID errors. Clear-all still removes the prefix, including old build cards, but old thread-derived clicks have no compatibility branch. Rust full suite 333 passed (`/tmp/soms-macos-instance.log`); includes Objective-C compilation, not real OS interaction. Stored PlatformHandle currently carries the unprefixed instance identifier and the ObjC adapter applies the fixed prefix. Restart reconciliation and migration of other platform transactions remain outstanding.

## Queued macOS facts recheck

After acquiring its presentation lane, macOS now rechecks a queued show against current window visibility/focus/open thread using shared `observe_before_delivery`. A newly active thread becomes Remove; existing removals never become shows when focus changes. This closes the queue-wait facts gap, not all OS submission races or read/content freshness gaps. Shared notification suite 44 passed (`/tmp/soms-queued-facts.log`).

## macOS obsolete owner-state cleanup

Excluded the old eager notification_alerts owner map and its mutation interfaces from macOS builds. Android-specific instance preparation/dismissal/removal APIs are now Android-only. macOS has only its transactional DeliveryState owner; other platforms retain their existing eager path until migrated. Full host Rust suite 335 passed (`/tmp/soms-retire-macos-alert-map.log`). This cfg cleanup is not proof that Android/Windows/Linux compile, and the eager implementation remains source-required for those consumers.

## Exact pending-dismissal matching

Fixed pending delivery dismissal to match both threadId and notification instance ID, like committed-card dismissal already does. A callback naming the wrong thread must not mark the candidate as retired while leaving alert state present. Added regression test; delivery suite 8 passed (`/tmp/soms-exact-dismissal.log`). No OS adapter or target-build validation in this step.

## Accepted card-content regression coverage

Added transaction tests proving rejected updates preserve accepted body/operation, accepted updates replace body/count/handle only on the matching receipt, late old receipts cannot overwrite new state, and accepted removal retires both card metadata and instance before recreation. Delivery suite 10 passed (`/tmp/soms-accepted-card-content.log`). Test-only follow-up; no additional platform migration in this step.

## macOS full platform handle ownership

Rust now stores the full prefixed macOS request identifier in PlatformHandle, reuses that committed handle for updates/removals, and passes it unchanged through FFI. Objective-C no longer constructs the system identifier during post/remove. Callback parsing still extracts the UUID from the known app prefix for exact instance matching. Full Rust suite 338 passed (`/tmp/soms-os-handle-owner.log`). This supersedes the earlier note that PlatformHandle stored only the bare UUID. Real OS validation remains outstanding.

## macOS callback identifier parsing ownership

Objective-C now forwards the full system identifier unchanged. Rust validates the app prefix and canonical UUID, extracts the instance ID, and retires the exact card. Invalid identifiers cannot trigger tap navigation. Removed Objective-C UUID parsing/substr extraction. Added Rust roundtrip/rejection test, 1 passed (`/tmp/soms-macos-id-parser.log`). No real OS callback test yet.

## Logout notification-drain regression

Extracted the production end-and-drain step into a small helper invoked by the retained blocking logout preparation task. Added a controlled test holding the macOS presentation lane: cancellation is signalled and new database work is rejected before preparation waits; preparation cannot complete until the held delivery releases. Native logout tests 14 passed (`/tmp/soms-notification-drain-test.log`). This tests in-process ordering, not uncertain OS outcomes or platform clear completion.

## Batch rejection handling

Desktop batch execution now collects individual delivery errors and attempts remaining commands while captured work stays current, instead of stopping on the first rejection. macOS rejected submission leaves alert capacity available for the next thread; uncertain pending operations still refuse subsequent preparation rather than replay. Added cross-thread rejection/cooldown test; notification suite 48 passed (`/tmp/soms-batch-rejection.log`). Other desktops still have eager alert preparation, so this does not fix their alert accounting. No real OS delivery tests yet.

## macOS obsolete policy-read cleanup

Removed the unused early alert-policy read/parse from macOS batch packaging. Content assembly reads content preferences/language; the serialized transaction reads alert policy when executing. Non-macOS consumers retain their existing eager policy path until cutover. Removed macOS unused mutable packaging state/import. Notification suite 48 passed (`/tmp/soms-policy-read-cleanup.log`).

## Desktop duplicate payload cleanup

Removed DesktopNotificationRequest, which had become identical to DesktopNotification after renderer update IPC removal. Commands now construct the internal platform payload directly; coordinate validation, captured-work cancellation, and transactional OS result handling remain unchanged. Full Rust suite 341 passed (`/tmp/soms-platform-payload-cleanup.log`); no old type references remain.

## Android obsolete descriptor fields

Removed unused Android descriptor `lang`/`renotify` and fixed `kind`, along with the always-true thread-message filter and platform locale lookup in final content decoding. Rendering entry is now private because both callers are internal. Instance IDs, sanitized content, sound decision and mention metadata remain. Targeted reference/whitespace checks passed; Android compiler/tests still not run, so this is not a build-pass claim.

## Typed Android rendering input

Replaced the single-field JSONObject descriptor data with typed threadId, updating renderer and tests. Removed derived previewMode strings; Android chooses BigTextStyle when Rust's final message list is empty, MessagingStyle otherwise. No Kotlin privacy preference decision was added. Reference/whitespace checks passed; Android compilation remains unverified.

## Web production instance lifecycle cutover

Both online-worker PRESENT and push synchronization now use `web/src/push/notification-cards.ts` inside the existing projection Web Lock. The Service Worker assigns UUID instance tags, reuses an existing card's tag for updates, and reconstructs current instances from `registration.getNotifications()` on each operation, including after restart. There is deliberately no second persistent in-memory card map: the browser's accepted notification set is the durable card ledger. A dismissed card disappears from that ledger and the next creation gets a fresh ID. Failed show promises do not create phantom records; failed updates preserve the previous OS card. Existing duplicate/legacy thread cards are retired only after successful replacement.

Removed descriptor.tag and thread-derived tag generation, duplicated showNotification message rendering, and the page's clearThread implementation. Page presentation changes now send a no-target wake; the Service Worker queries the active page's visibility/focus/open-thread facts and decides removal. Session-end clear still directly clears app notifications under existing lifecycle ordering; browser login/session click protocol remains unchanged and is NOT claimed migrated.

Tests cover instance reuse across reconstructed Worker owners, deletion/recreation, stale instance removal, failed show/update, and Worker-owned foreground removal. Five Web suites 47 passed (`/tmp/soms-web-instance-final.log`); full Rust host suite 341 passed (`/tmp/soms-final-web-native.log`). Production thread-derived descriptor-tag references are absent. Browser cooldown/once-per-thread alert history is NOT yet unified; current descriptor renotify semantics remain. Actual browser OS notification UI has not been tested.

Android toolchain reinspection: only JDK 8 reported by java_home, no SDK NDK directory found, and installed Rust targets are macOS only. Along with missing tauri.settings.gradle, these block honest Android build validation. No SDK installation, generated-project reset, app installation or launch was attempted. Android transaction cutover and Windows/Linux remain incomplete; do not label the entire migration finished.

## Recommended next steps

1. Inspect current diff/status and Android build tooling; run updated Android NativeNotificationBatchTest. Add assembly timestamp tests for RFC3339 variations (old content-level parser tests were replaced with timestamp forwarding tests).
2. Finish one complete Android migration: shared Rust presentation generates final commands/avatars/unread total using host facts; JNI conveys them; Kotlin mechanically renders. Remove raw descriptor generation, foreground business filtering and AlertThrottle once switched. Avoid new partial compatibility pipelines.
3. Reconcile user language fallback, sound eligibility on delivery failure, read/retraction/removal updates (must not re-alert old messages), muted/removed batches and dismissal bookkeeping. Use shared fixtures for Web/Rust parity.
4. Move notification clear into native logout/login transition completion before new login admission. Remove remaining page clear responsibilities after native lifecycle coverage is complete.
5. Wire local reads/restoration/settings changes to native notification/badge updates, then delete remaining renderer-driven refresh triggers. Keep shared counts separate from system cards.
6. Complete native click navigation/Android identity cleanup as directed, preserve only thread target and receipt identity. Keep normal resource cancellation without inventing extra notification epochs.
7. Update parity audit, remove obsolete code/tests, run full Rust + Web + Android checks, review real host behavior. Build/install only after validated completion; preserve data and leave application stopped.
