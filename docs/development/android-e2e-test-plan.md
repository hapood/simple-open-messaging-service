# Android E2E Test Plan

Companion to the [Web browser E2E test plan](./browser-e2e-test-plan.md). The
shared numbered business cases (chapters 0–10 and 12 there) also apply on
Android; this document holds the Android platform rules and the Android-only
execution checks. Case IDs `11.x` are Android-only and are retained from an
earlier shared numbering for continuity with recorded evidence; the shared
announcement chapter is `12.x`. Backend API calls may be used only to prepare
fixtures or verify a result after a visible client action; an API-only result
is not an E2E pass.

## Platform coverage

- Consumer cases run on both **browser** and **Android** by default. A pass on
  one platform is not a pass on the other.
- Administration cases run in a browser Admin context. When a case also
  affects a consumer, the resulting consumer behavior must be checked in both
  browser and Android runs.
- Android multi-user cases use one emulator/device or isolated app-data profile
  per account; never replace one account's session while the case still needs
  that participant.
- On Android, WebView content is operated in its WebView context. Native
  composer, system keyboard, emoji surface, pickers, permissions, notifications,
  and system Back are operated and asserted in `NATIVE_APP` context.
- Browser-only mechanics such as tab isolation do not substitute for Android
  lifecycle checks. Android-only mechanics do not change the business expected
  result.
- A platform exception must be stated in the numbered case itself. The runner
  must report an inapplicable platform as **SKIPPED**, not PASS.

## Execution

- Build the automation APK with `npm run build:android:e2e`. Android results
  are reported independently of browser runs.
- The adaptive runner reads this document's numbered cases when the scenario
  path points here:

```bash
CROSS_PLATFORM_PLATFORM=android \
CROSS_PLATFORM_SCENARIOS=docs/development/android-e2e-test-plan.md \
AI_TEST_CASE=11.5 AI_TEST_API_KEY=... npm run test:cross-platform
```

- Manual execution remains valid for the acceptance suite.
- Record coverage, build identity, case IDs, and evidence in local run artifacts,
  not a project progress dashboard or session handoff. This plan makes no
  completion claim; unresolved defect records remain separate.
- Reusable device-independent lessons live in
  [android-lab-testing-notes.md](./android-lab-testing-notes.md); device-specific
  run records sit beside it.

## Android platform supplement

These are Android-only execution checks in addition to the shared business cases,
not a second copy of those cases. Mark these items SKIPPED on browser. Repeat
relevant business assertions for local and federated peers; use separate devices
or isolated app sessions when both participants must remain active. A single
runner session cannot establish multi-participant delivery.

- **11.1** Record APK/build identity, Android and WebView versions, device/profile,
  home node and signed-in account. Verify the app reaches its configured lab node
  and preserves the full account/domain identity. Browser `localhost` URLs must
  not be assumed to address the host from Android.
- **11.2** Exercise native composer input, IME composition, emoji, mention
  selection, multiline editing and send. Switch between native and WebView
  surfaces where appropriate; verify no duplicate/lost text and exact mention
  identity. System Back first dismisses the active keyboard/dialog as expected;
  controls remain visible with keyboard and system insets.
- **11.3** Exercise system avatar/media pickers, crop/preview, cancel, save and
  permission denial/retry. Verify cancellation preserves the previous image,
  successful changes update the intended identity, and returning from the picker
  does not lose the editing/session state. Repeat the applicable Additional I cases.
- **11.4** Background and foreground the app, lock/unlock the device, disconnect
  and restore networking, and relaunch after process termination. Verify allowed
  messages and metadata converge without duplicates, stale loading or wrong-account
  data. Record OS background restrictions and distinguish process termination
  from force-stop; do not assume force-stopped apps receive background delivery.
- **11.5** Test notification permission grant/deny, enabled/disabled preferences,
  foreground/background receipt and tapping a notification. Verify the correct
  thread/account opens, read clearing converges and mention/withdrawal semantics
  follow the shared cases. Record transport/device conditions; a push probe alone
  does not establish real message notification delivery.
- **11.5a** On a device with working FCM, distinguish token registration, provider
  acceptance, device receipt, Android notification rendering, and tapping the
  actual conversation card. Verify text, file/media, mention, withdrawal, and
  privacy-mode previews against the authorized message; do not count tapping an
  OEM-collapsed foreground-service summary as tapping the conversation card.
  Two unread messages from one thread must appear in order on one updated card;
  messages from different threads must retain distinct cards and identities.
  Before tapping, record the server and Android unread counts; after opening,
  confirm the new messages appear once and the previous-read-position divider
  marks the first unread message (currently labeled "Unread messages" / "未读消息").
  Verify read clearing and notification cancellation on return and cold start,
  without moving the original divider ahead of the captured unread boundary.
- **11.5b** Verify a sender with a real avatar renders the correct image in the
  expanded Android MessagingStyle card, including after a profile revision while
  the recipient is mounted. The avatar must be a transparent-corner rounded
  square, not a stretched or mismatched identity. A sender without cached avatar
  bytes uses the transparent app logo, not the adaptive launcher background;
  privacy mode must not disclose the sender avatar when content is hidden.
- **11.5c** Toggle the foreground realtime service OFF and ON in-app and verify
  the persisted setting across relaunch. OFF must remove its persistent system
  notification without disabling FCM registration or ordinary foreground chat;
  ON must restore the documented background connection/notification behavior.
  Check Android notification grouping and individual-card deep links in both
  states; separately record OS restrictions and any background-delivery gap.
- **11.6** Repeat Profile/name/avatar changes while a native recipient's roster
  is already mounted. Verify visible convergence for immediate resolution and
  deferred availability where reproducible, rapid updates, reopening and app
  restart. Native SQLite materialization and native event delivery require their
  own evidence; Web IndexedDB tests and native routing mocks are insufficient.
- **11.7** Repeat voice/media and call cases with Android microphone/camera/audio
  routing and permission controls. Verify incoming-call UI, background return,
  normal hang-up and interrupted recording; distinguish fake-media signaling
  checks from audible/visible real media verification.
- **11.8** Log out and switch accounts, then relaunch and tap any retained
  notification. Verify previous-account data is not displayed to the new account
  and subscriptions/session state follow the active identity. Preserve other
  participants' sessions while observing the transition.
- **11.9** Repeat the announcement popup, backend acknowledgement,
  offline/online full recovery, and hardware-back steps from the shared
  chapter 12 in the Android app. Restart between pages of a multi-page full
  recovery and verify that native SQLite resumes the candidate projection
  without displaying an uncommitted announcement. The UI is the shared Angular
  chatbox; there is no independent native announcement popup.

## Result Template

Use the web plan's result template with these Android additions:

```text
Platform: android
Android device / OS / WebView / app-data profile: ...
APK build identity / SHA-256: ...
```
