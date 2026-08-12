# Android Client — 1:1 Voice/Video Calls (implementation brief)

A self-contained brief for implementing the **Android client** of 1:1 calling against the SOMS server.
It covers same-server and federated calls through the same endpoint-facing contract. This document is
the authoritative client contract; implementation pointers are collected in section 4.

## 1. Server contract (the source of truth)

Auth is the global `SessionAuthGuard` — native clients send `Authorization: Bearer <sessionToken>`.
All routes are under the `/api/v1` prefix. Every response is the `ApiResult` envelope
`{ code, message, data?, hasMore? }`; `code: 0` = OK.

### REST endpoints (`src/controller/calls.controller.ts`, `src/dto/call.dto.ts`)

| Method | Path                   | Body                                       | Purpose                                                                                                                                                                                                                               |
| ------ | ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/calls/ice-servers`   | —                                          | WebRTC ICE config (STUN + time-limited TURN REST creds, **TURN currently OFF** → STUN-only/empty). Call BEFORE creating the `RTCPeerConnection`.                                                                                      |
| POST   | `/calls/initiate`      | `{ callSid, calleeUserId, callType }`      | Caller starts a call. Returns `{ callSid, threadId }`.                                                                                                                                                                                |
| POST   | `/calls/accept`        | `{ callSid }`                              | Callee answered (negotiating — NOT connected yet).                                                                                                                                                                                    |
| POST   | `/calls/connected`     | `{ callSid }`                              | Callee: **the media leg is actually up** (DTLS-SRTP connected). This is the authoritative connect marker and duration timestamp. A caller report after acceptance and a repeated callee report are no-ops.                            |
| POST   | `/calls/upgrade-video` | `{ callSid }`                              | Caller commits a successfully renegotiated AUDIO call as VIDEO. Idempotent; there is no VIDEO→AUDIO transition.                                                                                                                       |
| POST   | `/calls/decline`       | `{ callSid }`                              | Callee rejects (ringing only).                                                                                                                                                                                                        |
| POST   | `/calls/cancel`        | `{ callSid }`                              | Caller cancels (ringing only).                                                                                                                                                                                                        |
| POST   | `/calls/end`           | `{ callSid, endReason? }`                  | Either side hangs up. `endReason ∈ {completed, timeout, failed}`.                                                                                                                                                                     |
| POST   | `/calls/signal`        | `{ id, callSid, toUserId, kind, payload }` | Relay one WebRTC frame. `id` is the endpoint-generated canonical UUID retained end-to-end for deduplication. `kind ∈ {offer, answer, ice, video-state}`; `payload` is an opaque string (≤32 KB). `toUserId` is the other participant. |

**`callSid`** and signal **`id`** are client-generated canonical lowercase RFC UUIDs (hyphenated
`8-4-4-4-12`, version 1..8, RFC variant). `callSid` is the call idempotency/address key; `id` identifies
one logical signal and must be reused only when retrying that signal. `callType ∈ AUDIO | VIDEO`.

**Business codes (70xxx, `src/common/business-code.ts`)** the client should handle:
`CALL_NOT_ALLOWED` (70001, not friends), `CALL_NOT_FOUND` (70002, no such/active call),
`CALL_NOT_PARTICIPANT` (70003), `CALL_BUSY` (70004, one active call per user),
`CALL_INVALID_TRANSITION` (70005), `CALL_PEER_UNREACHABLE` (70006, a federated ring failed — show
"couldn't reach").

### Realtime events (SSE `GET /events` — payloads ride INLINE, not identity-only)

Two event names, pushed per-user to ALL of that user's live SSE connections:

- **`CALL_EVENT`** — lifecycle. `{ event:'CALL_EVENT', type, callSid, ts, … }` where `type` ∈
  `incoming | ringing | accepted | connected | video-upgraded | declined | cancelled | ended | missed`.
  - `incoming` (callee only): `+ { threadId, callerUserId, callerName, callerAvatar, callType }` → render the incoming-call UI without a fetch.
  - `accepted`: callee answered / negotiating. `+ { threadId }`.
  - `connected`: the media leg is up. `+ { startedAt }`.
  - `declined | cancelled | ended`: terminal (the other side acted).
  - `missed`: ringing timed out; both sides and sibling devices dismiss their live UI.
- **`CALL_SIGNAL`** — WebRTC relay.
  `{ event:'CALL_SIGNAL', id, callSid, fromUserId, kind, payload }`. Deduplicate by `(callSid,id)` before
  applying it to WebRTC, then parse/apply `payload` according to `kind`.

The incoming ring is ALSO delivered as a **high-priority push** (`dispatchForCall`, all devices — the
phone rings even when the desktop SSE is live). The push carries `{ callSid, callerUserId, threadId,
callType }`; the display name/avatar come from the `CALL_EVENT{incoming}` SSE frame.

### The call state machine (client view)

```text
none ──initiate/incoming──▶ ringing ──accept──▶ accepted ──callee media up──▶ connected
                                │                   │                            │
                    decline/cancel/missed      ended(timeout/failed)      ended(completed/failed)
                                │                   │                            │
                                +───────────────────+────────────────────────────+──▶ terminal

video upgrade: connected/AUDIO ──caller commit──▶ connected/VIDEO
signal: ringing, accepted or connected inside a call; it does not change lifecycle state
```

- `accept` ≠ connected. Only the callee submits `/calls/connected`, after its
  `RTCPeerConnection.connectionState === 'connected'`; the caller waits for `CALL_EVENT{connected}`.
- `ringing` and `accepted` retries after the state has advanced are successful no-ops. Repeating a terminal
  operation is also a no-op and must not create another call record. An incompatible active branch returns
  `CALL_INVALID_TRANSITION`.
- `/calls/ringing` is advisory and non-blocking with respect to acceptance. The endpoint may submit
  `/calls/ringing` and `/calls/accept` concurrently; a ringing delivery failure does not prevent acceptance.
- `/calls/cancel` is for a caller whose home server is still `ringing`. After `accepted`, use `/calls/end`.
- `/calls/end` with `endReason=failed` = the media failed after connecting.

### The persisted call record = a chat bubble (`ContentType.CALL`)

A finished call is one `Message` of `contentType: 'CALL'` in the P2P thread, rendered as a special
bubble. Its `content` JSON (`src/calls/call-content.ts`):

```jsonc
{
  "type": "CALL",
  "callType": "AUDIO", // AUDIO | VIDEO
  "status": "completed", // completed | cancelled | declined | missed | failed | unreachable
  "callerId": 7,
  "calleeId": 4,
  "startedAt": 1234567890, // present iff the call actually connected
  "endedAt": 1234567990,
  "durationMs": 100000, // present iff connected
}
```

Direction is derived: `creator === me` → outgoing, else incoming. `failed` with no `startedAt` =
answered-but-never-connected; `failed` with `startedAt` = connected-then-dropped. The conversation-list
preview is a status-aware label (`[Missed call]`, `[Call]`, …) computed server-side in `derivePreview`.

## 2. WebRTC essentials

- Create `RTCPeerConnection({ iceServers })` from `GET /calls/ice-servers` **before** `createOffer`.
- Caller: `createOffer` → `setLocalDescription` → POST
  `/calls/signal {id, kind:'offer', payload:sdp}`.
  Trickle ICE candidates → POST `/calls/signal {kind:'ice', payload: candidate}` each.
- Callee: on `CALL_SIGNAL{kind:'offer'}` → `setRemoteDescription` → `createAnswer` →
  `setLocalDescription` → POST `/calls/signal {kind:'answer', …}` + ICE candidates.
- On the callee's `pc.connectionState === 'connected'` → POST `/calls/connected`; the caller transitions
  from the resulting `CALL_EVENT{connected}`.
- AUDIO→VIDEO is one-way. The enabling side adds/enables its video track and relays
  `video-state {enabled:true}`. To avoid offer glare, the original caller creates the renegotiation offer.
  After the answer exchange succeeds, the original caller POSTs `/calls/upgrade-video` (idempotent). Turning a
  camera off later relays `video-state {enabled:false}` and pauses only that track; it does not downgrade
  the call type.
- Media is **P2P, E2E (DTLS-SRTP)** — the server never carries media. TURN is OFF in current SOMS →
  STUN/P2P only; a hard-NAT pair fails → the client reports `/calls/end {endReason:'failed'}`.

### Local/Federation semantic alignment

The REST/SSE contract is the endpoint-facing projection of the Federation call state machine. Both paths
use the same transition, signal-direction, signal-phase, end-reason and timeout policy. Their wire formats
remain intentionally different: local REST authenticates a session and addresses numeric user IDs, while
Federation authenticates a server signature and addresses the active `(domain, callSid)` binding.

Signal rules are identical on both paths:

| kind          | sender | allowed lifecycle state      |
| ------------- | ------ | ---------------------------- |
| `offer`       | caller | ringing, accepted, connected |
| `answer`      | callee | accepted, connected          |
| `ice`         | either | ringing, accepted, connected |
| `video-state` | either | connected                    |

ICE may arrive before the corresponding SDP is applicable. The server validates only the outer call binding,
phase/direction and signal ID, then forwards it; the endpoint buffers and applies ICE according to its local
WebRTC signaling state.

## 3. Android integration points

**Key architectural decision for the new session:** is the call UI + WebRTC **native (Kotlin Activity +
`webrtc-android` SDK)** or **in the existing Angular WebView**? The codebase pattern is
_WebView UI + Kotlin transport_ (Kotlin owns `/events` SSE, the notification FGS, IME injection — see
`src-tauri/gen/android/.../RealtimeService.kt` + the memories below). But calling strongly favors
**native** (audio focus / `MODE_IN_COMMUNICATION`, `ConnectionService`/Telecom integration for the
system call screen, a reliable foreground service, camera capture). Recommend **native** for the call
screen + WebRTC, fed by the existing Kotlin SSE bridge.

Either way, the client must wire:

- **SSE bridge**: `CALL_EVENT` / `CALL_SIGNAL` arrive on the Kotlin-owned `/events` stream
  (`RealtimeService`), not a WebView EventSource. Bridge them to the call controller (native) or inject
  into the WebView. The signaling frames are the WebRTC transport.
- **Incoming-call wake-up**: the `CALL_INCOMING` push (data-only FCM, high priority) must start a
  Foreground Service (`dataSync` FGS per the multi-platform-notifications memory) that rings + renders
  the incoming UI, even from a killed process. The FGS reads the call context from the push +
  `/calls/ice-servers`.
- **Permissions**: `RECORD_AUDIO` (always), `CAMERA` (video). For the WebView path, delegate via
  `WebChromeClient.onPermissionRequest`.
- **Audio**: `AudioManager.MODE_IN_COMMUNICATION` + a `PARTIAL_WAKE_LOCK` for the call duration; release
  on `end`.
- **callSid generation**: mint a ULID/UUID client-side (the idempotency key).

## 4. Pointers (load these in the new session)

- **Memory (the architecture)**: `webrtc-1to1-calls-architecture` — server = signaling coordinator +
  lifecycle ONLY, never media; in-memory live state + terminal CALL bubble; bilateral; SSE
  CALL_EVENT/CALL_SIGNAL inline; ring pushes ALL devices; federated relay DONE; TURN helper-only + OFF.
- **Related memories** (the Android substrate): `session-token-native-realtime-rewrite` (Kotlin owns
  `/events` SSE), `api-proxy-rust-sse-unified-backend`, `multi-platform-notifications` (Android =
  dataSync FGS), `native-hello-cache-merge-replay`, `auth-cookie-browser-httponly-native-bearer`
  (native = Bearer), `android-emulator-debug-setup`, `huawei-rvl-al09-adb`, `dby-w09-adb` (debug
  tablets), `tauri-android-apk-build`, `realtime-transport-adapter`.
- **Server files** (read for exact shapes): `src/controller/calls.controller.ts`,
  `src/dto/call.dto.ts`, `src/calls/calls.service.ts` (the state machine), `src/calls/call-content.ts`
  (the bubble JSON), `src/calls/turn-credentials.ts` (`/calls/ice-servers`), `src/gateway/sse.service.ts`
  (`onCallEvent`/`onCallSignal`).
- **Verify the contract live**: `curl` two SSE streams on `/events`; `/calls/initiate` → observe
  `CALL_EVENT{incoming}` on the callee; `/calls/accept` → `accepted`; `/calls/signal` → `CALL_SIGNAL`
  relayed; `/calls/connected` then `/calls/end` → terminal.

## 5. Deferred / known limitations (don't block on these)

- **TURN is OFF** → STUN/P2P only; ~10–20% hard-NAT calls fail. Deploy coturn (its own host, not the
  SOMS image) + set `SOMS_TURN_URLS`/`SOMS_TURN_REST_SECRET` to enable.
- **Glare** (A calls B while B calls A): currently both fail fast with `CALL_PEER_UNREACHABLE` (safe,
  symmetric). Auto-connect-on-glare is deferred.
- ~~**HELLO active-call recovery**~~ ✅ Done: the SSE `HELLO` frame now carries `activeCall` (the user's
  live-call summary via `CallStateRegistry` → `sse.service.ts`), and `RealtimeService.reconcileActiveCall`
  re-seeds the incoming state for a reconnecting / freshly-booted callee that missed the `CALL_EVENT`.
  An SSE reconnect mid-call no longer loses the active call.
- **Federated TURN guest-credential** (callee's coturn): parked until TURN is deployed.
