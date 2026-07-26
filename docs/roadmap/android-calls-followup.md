# Android 1:1 Calls — Follow-up TODO

A self-contained task list spun off after the device-testing-driven stabilization session. The native call
client was implemented but **not device-verified** (`docs/android-calls-client.md`, memory
`webrtc-1to1-calls-architecture`); this session was the first real two-device pass and surfaced the bugs
below. Pick up any item; each has the context + the file pointers to do it.

## Status baseline (end of session)

All items in **Done** compile (web + native `make -C src-tauri apk-debug ABI=aarch64 WEB_BUILD=1` passes).

**2026-07-26 — happy-path two-device verified** on Huawei RVL-AL09 (Android 9) + DBY-W09 (Android 12): an
audio/video call connects + ends cleanly. This lifts the "not device-verified" blocker for the core flow and
confirms the accept-rejected fix resolved the dominant "stuck on connecting" cause. The edge-case + UX items
below remain.

## Done this session (compiles; needs device verification)

**Bug fixes**
- Accept success detection: `post`/`get`/`exec` in `CallController.kt` now return a `CallResp(ok, data)`; the
  `null`-on-no-data-success footgun is gone. `accept` uses `.ok`. Was the "callee accept rejected / no
  answer / stuck on connecting" root cause.
- One-way video: `offerAnswerConstraints()` `OfferToReceiveVideo` is now `callType`-aware (was hardcoded
  `false`, an AUDIO-only leftover → the offer was video-sendonly → caller never received the peer's video).
- `CallService.onStartCommand` calls `startForeground` FIRST (with a try/catch fallback) — was the
  `RemoteServiceException` crash on the callee (Android 9).
- `hangUp` routes `cancel` (pre-accept) vs `end` (post-accept) by phase — was the busy-lockout + the peer's
  incoming-UI-never-dismissed bug (server `/calls/end` rejects a `ringing` call).
- Full-screen intent is neutral `ACTION_SHOW_INCOMING` (was `ACTION_ANSWER` → auto-answered on FSI fire).
- SSE `CALL_EVENT{incoming}` now rings + posts the call notification when backgrounded (the FCM push is the
  killed-process fallback only; doze/quota make it unreliable).
- HELLO `activeCall` recovery: `RealtimeService.reconcileActiveCall` re-seeds incoming (rings + notifies)
  when a reconnecting/freshly-booted callee missed the `CALL_EVENT{incoming}`.

**Features**
- `LetterAvatar` (`LetterAvatar.kt`): initial-letter tile fallback for the call notification +
  the per-thread message notification when the avatar/composite is missing.
- UI step detail: `CallController.step` ("Offer sent" / "Answer received" / …) in the snapshot → web
  `CallSnapshot.step` → `call-screen.statusLabel` shows it.
- Channel ringtone (`CHANNEL_INCOMING` carries the device ringtone → heads-up banner on EMUI) +
  `CallRinger` rewritten to vibration-only (no MediaPlayer → no double sound).
- Outgoing avatar via IDB data URL (`AvatarRepository.getCachedDataUrl`) — no `/uploads` fetch on the
  outgoing path. `CallScreen` swapped to `UserAvatarComponent` (IDB-cached).
- `seedIncomingState` extracted — the 3 incoming trigger paths (SSE / FCM / HELLO) deduped.

**Cleanup**
- Server `[call]` lifecycle logs `warn` → `debug`.
- Channel names → string resources (en + zh-rCN).
- `onFrame` / `relink` (the two most frequent) demoted to `debug`.

## TODO (prioritized)

### P0 — reliability

- **Caller-side answer fetch.** ✅ **DONE (2026-07-26).** The callee's fetch (`fetchAndApplyStaged` in `accept`)
  is now symmetric: on the caller's `accepted`→`connecting` transition, `armAnswerFetchBackstop` posts a
  `CallFsm.ANSWER_FETCH_DELAY_MS` (3s) fallback; if the SSE-relayed answer hasn't arrived, it pulls the staged
  answer + callee ICE via `GET /calls/:sid/signaling` (the server already returns the caller its half —
  `CallsService.signaling`). The `answer` apply is idempotent (`answerApplied`, re-armed on each created offer
  so an ICE-restart answer still lands). `CallFsm.ANSWER_FETCH_DELAY_MS` + a unit test lock the window.

### P0 — UX regressions (must fix before release)

- **Vibration stops when entering the incoming UI.** Reported: the phone vibrates while backgrounded (FGS
  state) but stops the moment the incoming-call UI shows (foreground). Mainstream = continuous vibration
  until answer/decline. `startRing`/`stopRing` logs were added to `CallRinger.kt` — reproduce + read them
  to find what cancels the vibration on the foreground transition (suspect: a re-`seedIncoming` /
  `onResume` / an audio-mode change). Likely fix: the foreground SSE `incoming` path should NOT stop the
  background ring; or move ring ownership into one idempotent presenter (see "refactor" below).

- **Looping ringtone.** `CallRinger` was rewritten to vibration-only (the channel sound is the audible
  ring now). The channel sound plays **once** (Android notification sounds don't loop) → after the first
  ring cycle the call is silent (only vibration). A call must ring continuously until answer/timeout.
  Options: (a) silent channel sound (triggers the EMUI heads-up) + restore a MediaPlayer loop in
  `CallRinger` for the audible ring; (b) verify whether `NotificationCompat.CallStyle` loops the channel
  sound on the target versions. Verify EMUI's behavior with a silent sound before committing to (a).

### P1 — i18n / consistency

- **Step strings → i18n.** `CallController.step` sends hardcoded English ("Offer sent" / "Answer received"
  / …). Make the native send **codes** (`offer-sent`, `answer-received`, …) and localize on the web side
  (`call-screen.statusLabel` via transloco, en + zh-CN keys). Per the UI-text bilingual convention.

- **`LetterAvatar` color alignment.** `LetterAvatar.hueColor` uses HSV(0.65, 0.85); the in-app
  `UserAvatarComponent` + the server `AvatarStackService` use hsl(65%, 55%). Different color spaces → the
  notification's letter tile is a slightly different shade than the in-app avatar for the same identity.
  Convert hsl→hsv exactly + match.

- **Per-thread `LetterAvatar` color.** `SomsMessagingService.renderDescriptor` falls back to
  `LetterAvatar.render(ctx, d.title, d.title.hashCode())` — the color is hashed from the **title**, not the
  sender's userId, so the same sender can get a different color in the notification vs in-app. To fix, the
  `NotifDescriptor` (`NotifDescriptor.kt`) needs to carry the sender's userId (server
  `/notifications/missed` descriptor).

### P1 — verify the "stuck on connecting" is gone

- ✅ **DONE (2026-07-26, happy path).** A normal two-device call connects + ends cleanly — the accept-rejected
  fix resolved the dominant cause. The genuinely-failed-call branch (kill the callee mid-negotiate → the caller
  must NOT stick; the reconnect backstop + `fail()` end it) is still worth one adversarial device pass.

### P2 — cleanup / merge

- **Native diagnostic log audit.** Several session-debug logs are still at `info` (`onAddTrack`,
  `ensureRenderers`, `loadAvatar`, `startRing`/`stopRing`, `initiate`/`accept` entry). Demote the plumbing
  ones to `debug` pre-release; keep the significant milestones (`initiate`/`accept`/`connected`/`ended`) at
  `info` if ops visibility is wanted.

- **Split commits.** The session's work is one large uncommitted pile. Suggested logical commits:
  1. `fix(calls): accept success detection (CallResp/postOk)`
  2. `fix(calls): OfferToReceiveVideo dynamic (one-way video)`
  3. `fix(calls): CallService startForeground-first (crash)`
  4. `fix(calls): hangUp cancel/end routing by phase`
  5. `fix(calls): FSI neutral + SSE background ring/notify`
  6. `feat(calls): HELLO activeCall recovery`
  7. `feat(calls): LetterAvatar fallback`
  8. `feat(calls): UI step detail`
  9. `feat(calls): channel ringtone + CallRinger vibration`
  10. `refactor(calls): outgoing avatar via IDB + CallScreen UserAvatarComponent`
  11. `refactor(calls): seedIncomingState dedup`
  12. `chore(calls): log levels + channel i18n`

- **Device verification (the big one).** ✅ **Happy-path DONE 2026-07-26** (audio + video connect/end on
  RVL-AL09 + DBY-W09). Still outstanding: backgrounded callee, force-stop/killed callee (FCM wake), cancel
  before accept, decline, peer-hangup, mid-call background→PiP, mid-call SSE reconnect (the new caller-fetch
  fallback covers the last). Each phase in `docs/android-calls-client.md` gets a checkmark only after its pass.

## Pointers

- Native FSM: `src-tauri/gen/android/app/src/main/java/com/soms/client/CallController.kt`
- Call FGS + notifications: `…/CallService.kt`, `…/CallRinger.kt`, `…/LetterAvatar.kt`
- Video surfaces: `…/VideoSurfaceManager.kt`
- SSE / HELLO recovery: `…/RealtimeService.kt` (`reconcileActiveCall`, `onEvent`)
- Per-thread notification: `…/SomsMessagingService.kt` (`renderDescriptor`)
- Web call state: `web/src/app/services/call-adapter.ts`, `…/call-event.service.ts`,
  `…/avatar-cache.service.ts`
- Call UI: `web/src/app/components/call-screen/call-screen.component.ts`
- Server call FSM: `src/calls/calls.service.ts`, `src/controller/calls.controller.ts`
- Spec: `docs/android-calls-client.md`
- Test devices: Huawei RVL-AL09 (Android 9) + DBY-W09 (Android 12) — see memories
  `huawei-rvl-al09-adb`, `dby-w09-adb`.
