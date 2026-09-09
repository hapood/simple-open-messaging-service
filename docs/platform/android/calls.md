# Android Client — 1:1 Voice/Video Calls

This document records the client-facing contract used by the implemented Android
1:1 calling stack. It covers same-server and federated calls through the same
endpoint-facing contract.

## 1. Server contract (the source of truth)

Auth is the global `SessionAuthGuard` — native clients send `Authorization: Bearer <sessionToken>`.
All routes are under the `/api/v1` prefix. Every response is the `ApiResult` envelope
`{ code, message, data?, hasMore? }`; `code: 0` = OK.

### REST endpoints (`src/controller/calls.controller.ts`, `src/dto/call.dto.ts`)

| Method | Path                        | Body                                       | Purpose                                                                                                                                                                                                                               |
| ------ | --------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/calls/ice-servers`        | —                                          | WebRTC ICE config (STUN plus time-limited TURN REST credentials when configured). Call before creating the `RTCPeerConnection`.                                                                                                       |
| POST   | `/calls/initiate`           | `{ callSid, calleeUserId, callType }`      | Caller starts a call. Returns `{ callSid, threadId }`.                                                                                                                                                                                |
| POST   | `/calls/accept`             | `{ callSid }`                              | Callee answered (negotiating — NOT connected yet).                                                                                                                                                                                    |
| POST   | `/calls/ringing`            | `{ callSid }`                              | Callee reports that incoming alerting started. Advisory and idempotent.                                                                                                                                                               |
| POST   | `/calls/connected`          | `{ callSid }`                              | Callee: **the media leg is actually up** (DTLS-SRTP connected). This supplies the connection fact; each server records its local processing time. A caller report after acceptance and a repeated callee report are no-ops.                            |
| POST   | `/calls/upgrade-video`      | `{ callSid }`                              | Caller commits a successfully renegotiated AUDIO call as VIDEO. Idempotent; there is no VIDEO→AUDIO transition.                                                                                                                       |
| POST   | `/calls/decline`            | `{ callSid }`                              | Callee rejects (ringing only).                                                                                                                                                                                                        |
| POST   | `/calls/cancel`             | `{ callSid }`                              | Caller cancels (ringing only).                                                                                                                                                                                                        |
| POST   | `/calls/end`                | `{ callSid, endReason? }`                  | Either side hangs up. `endReason ∈ {completed, timeout, failed}`.                                                                                                                                                                     |
| POST   | `/calls/signal`             | `{ id, callSid, toUserId, kind, payload }` | Relay one WebRTC frame. `id` is the endpoint-generated canonical UUID retained end-to-end for deduplication. `kind ∈ {offer, answer, ice, video-state}`; `payload` is an opaque string (≤32 KB). `toUserId` is the other participant. |
| GET    | `/calls/:callSid/signaling` | —                                          | Recover the current signaling snapshot after reconnect or process restoration.                                                                                                                                                        |

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
  - `connected`: the media leg is up. `+ { startedAt }`, the local server's first connection processing time. Federation connected frames carry no timestamp.
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

### Terminal call history

Finished calls use locally generated `SYSTEM / CALL_ENDED` notices, as defined
in the [local call-history design](../../design/local-call-history.md). Deploy
matching clients and servers together.

The client renders one notice only after termination, with audio/video,
outcome, direction from caller identity, locally observed call time, and connected
duration when available. Ringing and connection UI continues to use live call
events. A system notice does not trigger native ringing or revive call state.
Each server creates its own history; notices are not pulled from the peer.
See the design for timestamp provenance, legacy data, and failure handling.

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
- Media is **P2P, E2E (DTLS-SRTP)** — the server never carries media. Without configured TURN,
  a hard-NAT pair may fail and the client reports `/calls/end {endReason:'failed'}`.

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

## 3. Known limitations

- **TURN is optional**. Without it, hard-NAT calls may fail. Deploy coturn separately and set
  `SOMS_TURN_URLS`/`SOMS_TURN_REST_SECRET` to enable time-limited credentials.
- **Glare** (A calls B while B calls A): currently both fail fast with `CALL_PEER_UNREACHABLE` (safe,
  symmetric). Auto-connect-on-glare is deferred.
- **Federated TURN guest-credential** (callee's coturn): parked until TURN is deployed.
