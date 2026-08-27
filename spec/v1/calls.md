# Simple Open Messaging Federation Protocol v1 Call Signaling

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document is entirely normative.

This document defines the complete server-to-server contract for one-to-one
calls. Federation v1 defines the signed `POST /s2s/v1/call` operation and its
protocol lifecycle events. Media, SDP, ICE, STUN, and TURN remain governed by
the external standards listed in Section 13.

This operation also follows the shared types and response envelope in the
[core protocol](./protocol.md), identity and HTTP Message Signature rules in
[Transport and Security](./transport-security.md), and business codes in the
[stable error registry](./errors.md). The JSON Schema is a non-normative
machine-readable validation resource and cannot override this text.

## 1. Protocol scope

Federation v1 provides:

- ephemeral call state between a caller server and callee server;
- transparent relay of endpoint-generated SDP, ICE, and protocol
  `video-state` payloads;
- ringing, acceptance, connection, termination, and AUDIO-to-VIDEO upgrade
  events; and
- frame ordering, retry, idempotency, race convergence, and bounded call
  tombstones.

Media does not pass through `/s2s/v1/call`, the state feed, or the message feed.
Federation servers MUST NOT decrypt, transcode, mix, or relay media, and MUST
NOT parse or rewrite SDP or ICE to make negotiation decisions for endpoints.

WebRTC and JSEP do not define this application signaling transport. Delivery,
idempotency, and error handling therefore follow this document rather than
being inferred from SDP, ICE, or WebRTC transport state.

## 2. Roles, identities, and correlation keys

- The **caller** initiates the call using an account hosted by the caller
  server.
- The **callee** receives or declines it using an account hosted by the callee
  server.
- The **caller server** sends `incoming` and arbitrates the authoritative
  lifecycle result.
- The **callee server** receives `incoming` and maintains the ephemeral peer
  signaling state.
- An **endpoint** produces or consumes WebRTC signaling and media.
- `callId` is the canonical UUID correlation key for one call. The caller
  server MUST NOT reuse it for another call and MUST preserve it when retrying
  the same call.
- `signal.payload.signalId` is the canonical UUID idempotency key for one logical
  signal. A sending server MUST use a distinct value for each logical signal
  in a call and preserve it across retries of that signal.

Both UUID fields follow `common.schema.json#/$defs/canonicalUuid`: RFC 9562,
version field 1–8, RFC variant, lowercase hyphenated `8-4-4-4-12` form. v1 does
not vary behavior by UUID version. The sending server is responsible for every
wire ID regardless of whether an endpoint or server generated it.

Only `incoming` carries accounts:

- `payload.callerAccount` is hosted by the verified signer domain.
- `payload.calleeAccount` is hosted by the receiving authority domain.
- Domains are derived from the signature and request authority and are not
  repeated in the frame.

After accepting `incoming`, the receiver MUST bind
`(signer domain, callId)` to both accounts, their roles, and the initial
`mediaType`. Later frames use only that binding and do not repeat accounts.

## 3. HTTP operation

| Property           | Requirement                                                                |
| ------------------ | -------------------------------------------------------------------------- |
| Method             | `POST`                                                                     |
| Path               | `/s2s/v1/call`                                                             |
| Query              | None                                                                       |
| Request media type | UTF-8 `application/json`                                                   |
| Authentication     | Federation v1 HTTP Message Signature using the `recognized signed` context |
| Request body       | One closed Call Frame from Section 4                                       |
| Success            | HTTP `200` JSON success envelope                                           |
| Error              | Section 11 and the stable error registry                                   |

The request MUST contain `Content-Type`, `Date`, `Content-Digest`,
`Signature-Input`, and `Signature`. Their exact syntax, signed-component order,
time window, and raw-body digest follow the common transport rules. This
operation defines no alternative signature label, algorithm, or component set.

A cached `degraded` availability state is not wire authorization and MUST NOT
by itself cause rejection of an otherwise valid frame. A valid request may
restore transport-only degradation under the recognition rules.

`halted` is a hard gate, not an availability cache. On entering it, a server
MUST terminate every active call with that peer locally as `failed`, stop all
non-terminal retries, and create the Section 10 tombstone. Later frames fail
with the registered fatal reason before call-binding lookup. The policy,
identity, or version reason that caused the halt MUST be retained independently
of the call lifecycle.

Success is:

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"code":0,"message":"successful","data":null}
```

It means the receiving server validated and applied the frame. It does not
mean an endpoint received the event or that media is connected. A non-zero
business code in HTTP `200` is not success.

## 4. Call Frame

Every body is a closed JSON object. An unknown or missing field, wrong type,
invalid enum, or field not permitted for that `operation` returns
`FEDERATION_MALFORMED`.

```ts
type CallOperation =
  | 'incoming'
  | 'accepted'
  | 'ringing'
  | 'declined'
  | 'cancelled'
  | 'ended'
  | 'missed'
  | 'signal'
  | 'connected'
  | 'video-upgraded';

type MediaType = 'AUDIO' | 'VIDEO';
type CallSignalType = 'offer' | 'answer' | 'ice' | 'video-state';
type CallEndReason = 'completed' | 'timeout' | 'failed';
type SdpText = string;
type JsonText<T> = string;

interface RTCIceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

interface VideoState {
  enabled: boolean;
}

interface CallFrameBase {
  callId: CanonicalUuid;
  operation: CallOperation;
  mediaType: MediaType;
}

type CallSignalPayload =
  | {
      signalId: CanonicalUuid;
      signalType: 'offer' | 'answer';
      data: SdpText;
    }
  | {
      signalId: CanonicalUuid;
      signalType: 'ice';
      data: JsonText<RTCIceCandidateInit>;
    }
  | {
      signalId: CanonicalUuid;
      signalType: 'video-state';
      data: JsonText<VideoState>;
    };

type CallFrame =
  | (CallFrameBase & {
      operation: 'incoming';
      payload: { callerAccount: UserAccount; calleeAccount: UserAccount };
    })
  | (CallFrameBase & {
      operation: 'ringing' | 'accepted' | 'declined' | 'cancelled' | 'missed';
    })
  | (CallFrameBase & { operation: 'signal'; payload: CallSignalPayload })
  | (CallFrameBase & {
      operation: 'connected';
      payload: { startedAt: EpochMilliseconds };
    })
  | (CallFrameBase & { operation: 'video-upgraded'; mediaType: 'VIDEO' })
  | (CallFrameBase & {
      operation: 'ended';
      payload: { endReason: CallEndReason };
    });
```

`callId`, `operation`, and `mediaType` are required in every frame. Except for
`video-upgraded`, `mediaType` MUST equal the receiver's current stored type.
During upgrade negotiation it remains `AUDIO`; it becomes `VIDEO` only when
`video-upgraded` is accepted. v1 does not permit downgrade to AUDIO.

`payload` is an operation-specific closed object. It is required only for
`incoming`, `signal`, `connected`, and `ended`, and forbidden for every other
operation. The optional members of `RTCIceCandidateInit` retain the defaults
and semantics defined by the
[WebRTC 1.0 `RTCIceCandidateInit` dictionary](https://www.w3.org/TR/webrtc/#dom-rtcicecandidateinit);
they are not protocol-level optional metadata and cannot be made universally
required by this profile.

## 5. Lifecycle state machine

The caller server arbitrates terminal races and owns the authoritative result.
The callee server maintains only the ephemeral protocol state needed to
participate. The wire lifecycle has four stages: `ringing`, `accepted`,
`connected`, and `terminal`. Internal pending states do not alter the observable
rules below.

| Stage       | Entry                                                         | Meaning                                                                 |
| ----------- | ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `none`      | No accepted `incoming`                                        | No active binding; another op cannot create one.                        |
| `ringing`   | Accepted `incoming`                                           | Binding exists and awaits acceptance; endpoint alerting is not implied. |
| `accepted`  | Accepted `accepted`                                           | The callee accepted; SDP/ICE negotiation may continue.                  |
| `connected` | Accepted callee `connected(startedAt)`                        | The authoritative media connection was established.                     |
| `terminal`  | First valid terminal frame or authoritative local termination | Irreversible; only the bounded tombstone remains.                       |

The `ringing` operation is an advisory acknowledgement that the callee
endpoint actually began alerting the user. It does not change the `ringing`
stage.

```text
none --incoming--> ringing --accepted--> accepted --connected--> connected
ringing   --declined/missed/cancelled-----------------> terminal
accepted  --cancelled/ended(completed|timeout|failed)-> terminal
connected --ended(completed|failed)-------------------> terminal

connected/AUDIO --video-upgraded--> connected/VIDEO
ringing(op), signal: no stage change
```

| `operation`      | Direction        | First effective stage         | Result                     | Successful no-op                              |
| ---------------- | ---------------- | ----------------------------- | -------------------------- | --------------------------------------------- |
| `incoming`       | caller → callee  | `none`                        | Create `ringing`           | Identical binding in an active stage          |
| `ringing`        | callee → caller  | `ringing`                     | Record advisory fact       | Already recorded, accepted, or connected      |
| `accepted`       | callee → caller  | `ringing`                     | Enter `accepted`           | Already accepted or connected                 |
| `connected`      | callee → caller  | `accepted`                    | Enter `connected`          | Already connected; preserve first `startedAt` |
| `video-upgraded` | caller → callee  | Connected and currently AUDIO | Change type to VIDEO       | Initially AUDIO and already upgraded          |
| `declined`       | callee → caller  | `ringing`                     | Enter `terminal`           | Already terminal                              |
| `missed`         | callee → caller  | `ringing`                     | Enter `terminal`           | Already terminal                              |
| `cancelled`      | caller → callee  | `ringing` or `accepted`       | Enter `terminal`           | Already terminal                              |
| `ended`          | Either direction | `accepted` or `connected`     | Enter `terminal`           | Already terminal                              |
| `signal`         | Section 8        | Section 8                     | Relay without stage change | Signal ID already processed                   |

The callee server MUST send `ringing` only after local confirmation that the
callee endpoint began alerting. Failure of this advisory frame MUST NOT block
acceptance or fail the call.

`cancelled` applies in `accepted` to converge a race in which the caller
cancelled before observing acceptance. After the caller server has accepted
`accepted`, a later local hang-up uses `ended`, not a newly generated
`cancelled`.

`connected.payload.startedAt` is the callee endpoint's first confirmation of a
media connection, expressed as an integer in `0..9007199254740991`. Only the
callee server sends `connected`; a caller endpoint does not create a second
federation timestamp.

| `endReason` | Permitted stage           | Meaning                                                                       |
| ----------- | ------------------------- | ----------------------------------------------------------------------------- |
| `completed` | `accepted` or `connected` | Normal hang-up after acceptance, with or without a completed media connection |
| `timeout`   | `accepted`                | Media did not connect within the local post-acceptance deadline               |
| `failed`    | `accepted` or `connected` | Non-timeout technical failure or unrecoverable connected-media failure        |

## 6. Commit, ordering, and races

### 6.1 Per-sender ordering

A sender MUST serialize state-changing frames for the same
`(peer domain, callId)` in creation order and await the previous HTTP response
before sending a dependent state. On failure it retries the identical frame or
terminates according to the caller action; it MUST NOT skip forward. A signal
waits for any lifecycle change on which it depends, although independent
signals may be concurrent.

The advisory `ringing` frame is outside that dependency chain and may overlap
acceptance. Its failure does not block `accepted`; a late `ringing` after
acceptance is a successful historical no-op.

The receiver MUST validate and commit a state transition before returning
`200/code=0`. A sender regards it as federatively committed only after receiving
that response. `CALL_CANCELLED` or `CALL_TERMINATED` terminates any dependent
pending work. The callee MUST receive success for `signal(answer)` before
sending a `connected` that depends on that answer. ICE remains independently
deliverable and may arrive out of order.

### 6.2 Normal sequence

```text
caller server                         callee server
     | incoming                            |
     |------------------------------------>|
     |<----------------------------- 200 --|
     |<----------- ringing (advisory) -----|
     | signal(offer)                       |
     |------------------------------------>|
     |<------------------------- accepted -|
     |------------------------------- 200 >|
     |<-------------------- signal(answer) |
     |------------------------------- 200 >|
     |<-------------- connected(startedAt) |
     |------------------------------- 200 >|
```

An initial offer may be sent after `incoming` succeeds and before acceptance.
An answer is sent only after `accepted`. A `200` response acknowledges the
frame itself; it is not an SDP answer.

### 6.3 Acceptance/cancellation race

The caller server resolves a crossing `accepted` and local `cancelled` by its
actual processing order, not by comparing wall clocks. If it committed
cancellation first, late acceptance receives `CALL_CANCELLED`. If it committed
acceptance first, the accepted state wins and a subsequent local hang-up uses
`ended`. On the callee server, a valid caller `cancelled` terminates a call that
is ringing, accepting, or accepted but not connected. No late event may revive
a terminal call.

### 6.4 Bidirectional terminal events

Both sides may send `ended` concurrently. The caller server's first committed
terminal result is authoritative. The callee's ephemeral terminal record MUST
NOT create a competing result. Both sides stop the call's media and active
semantics when entering `terminal`.

## 7. Lifecycle idempotency

Lifecycle idempotency follows the monotonic state machine and has no separate
request ID. A valid event on an already traversed path returns `200/code=0`
without repeating effects, creating another result, or moving state backward.
A competing branch not on that path remains invalid—for example, `declined`
or `missed` after acceptance.

- A repeated active `incoming` is a retry only if signer, both accounts,
  `callId`, and initial `mediaType` are identical. Otherwise it is a callId
  collision and returns `FEDERATION_MALFORMED`. Once accepted, an identical
  retry remains successful even if local admission policy later changes.
- The first accepted `connected.startedAt` is authoritative. A duplicate is a
  no-op and does not compare or replace the value.
- A repeated `video-upgraded` is a no-op only for a call initially created as
  AUDIO and already upgraded. It is malformed for a call initially VIDEO.
- The first terminal event wins. A later terminal frame is a no-op and does not
  compare operation, type, or reason. Other late frames receive the terminal
  business result described in Sections 10 and 11.

## 8. Signal payloads, phases, and retries

`signal.payload.data` is a string of 1–32768 Unicode code points. Federation
servers validate only its outer type, length, ID, and active binding. They MUST
NOT parse, normalize, reserialize, or rewrite it.

`JsonText<T>` documents the structure an endpoint obtains after `JSON.parse`;
the wire field remains an unmodified JSON string. The producer MUST generate
the specified inner structure, and the consuming side validates it before use.
Invalid inner content may terminate or be ignored by local negotiation but does
not retroactively change server-level signal idempotency.

| `signalType`  | Direction       | Permitted stage                    | `data`                                                                                                                              |
| ------------- | --------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `offer`       | caller → callee | `ringing`, `accepted`, `connected` | SDP offer produced under [JSEP](https://www.rfc-editor.org/rfc/rfc8829.html) and [SDP](https://www.rfc-editor.org/rfc/rfc8866.html) |
| `answer`      | callee → caller | `accepted`, `connected`            | SDP answer produced under JSEP and SDP                                                                                              |
| `ice`         | Either          | `ringing`, `accepted`, `connected` | JSON text whose decoded value conforms to WebRTC 1.0 `RTCIceCandidateInit`                                                          |
| `video-state` | Either          | `connected`                        | JSON text whose decoded value conforms to the closed `VideoState` interface above                                                   |

At most one negotiation for a call may be incomplete at a time. The caller may
create another offer only after the previous answer was successfully applied
and endpoint signaling returned to `stable`. The callee produces at most one
answer for each valid offer.

The sender MUST use an unused `payload.signalId` for each new logical signal. A
retry MUST preserve both the ID and the complete original signal body. For
`(signer domain, callId, payload.signalId)`, the receiver accepts only the first
signal. A repeated ID returns `200/code=0` without another application effect.
It does not rewrite or invalidate the accepted signal based on a later body.
The receiver retains this deduplication information for the Section 10
tombstone lifetime.

ICE may arrive out of order relative to an offer or answer. A federation server
MUST NOT reject, reorder, or interpret ICE according to JSEP ordering; it
validates the outer frame and relays it unchanged. Endpoints buffer and apply
it according to their WebRTC signaling state. ICE restart creates no lifecycle
event. A successful AUDIO-to-VIDEO negotiation uses Section 9.

## 9. AUDIO-to-VIDEO upgrade

The caller endpoint is the offerer and the callee endpoint is the answerer for
all v1 negotiations. This application profile avoids offer glare; it is not a
restriction imposed by RFC 3264.

When the callee requests an upgrade, it first sends
`video-state {"enabled":true}` and the caller creates the new offer. A caller
request also results in a caller-generated offer. Offer, answer, and ICE frames
remain `mediaType: "AUDIO"` during negotiation. Only after the caller endpoint
successfully applies the corresponding answer does the caller server send:

```json
{
  "callId": "550e8400-e29b-41d4-a716-446655440000",
  "operation": "video-upgraded",
  "mediaType": "VIDEO"
}
```

The callee does not send this frame or commit the upgrade merely after applying
its local answer. Both sides change the current type only when this frame is
accepted. Disabling a camera sends only `video-state` and does not downgrade
the business type. ICE restart or renegotiation without new video media MUST
NOT create `video-upgraded`.

## 10. Tombstones, replay, and restart

After accepting `declined`, `cancelled`, `missed`, or `ended`, active state
immediately becomes terminal and creates a bounded tombstone whose expiry is:

```text
min(terminal request Signature-Input.expires,
    local terminal-acceptance time + 300 seconds)
```

Three hundred seconds is the maximum v1 call-tombstone lifetime. A retry with a
new signature MUST NOT extend the original tombstone. A locally generated
terminal event uses that side's own terminal request expiry for the same
calculation.

The tombstone retains enough information for Sections 7 and 8. While present:

- every terminal frame is a no-op that does not replace the first result;
- an already processed signal ID is a no-op;
- a new `incoming` or other late frame for a cancelled call returns
  `CALL_CANCELLED`;
- the equivalent frame for another terminal result returns `CALL_TERMINATED`;
  and
- no frame recreates or restores the call.

After learning or committing a terminal result, a sender MUST atomically stop
all non-terminal work and retries for that `callId`. It MUST NOT renew a
signature to replay an old `incoming` or signal. Tombstones absorb in-flight
replays within the signed request window; they are not a permanent call-ID
registry. A restart may lose active media state but MUST retain unexpired
tombstones. v1 defines no active-call recovery operation.

Both servers MUST use finite unanswered and post-acceptance connection
deadlines. Their durations and relative ordering are local policy. On
acceptance, the unanswered deadline ceases and the connection deadline begins.

For interoperable default behavior, an implementation SHOULD use 45 seconds
for both the unanswered deadline and the post-acceptance connection deadline.
A caller-side safety deadline used to cover peer-server failure or partition
SHOULD be longer than the corresponding peer deadline plus an ordinary S2S
retry window; 60 seconds is the recommended default. These values are not wire
constants, and an implementation MAY choose different finite values for its
deployment conditions.

A transient S2S delivery failure does not extend a lifecycle deadline. The
bounded retry permitted by Section 11 may allow an identical frame to arrive
before that deadline, but the protocol does not guarantee that waiting restores
delivery or an active call. Once either side commits a terminal result, the
late-frame and tombstone rules apply and no delayed lifecycle or signal frame
may revive the call.

| Timeout                                   | Sender        | Required frame   |
| ----------------------------------------- | ------------- | ---------------- |
| Callee unanswered timeout                 | callee server | `missed`         |
| Caller unanswered timeout                 | caller server | `cancelled`      |
| Callee post-acceptance connection timeout | callee server | `ended(timeout)` |
| Caller post-acceptance connection timeout | caller server | `ended(timeout)` |

The first such event participates in the same terminal race rules.

## 11. Verification, errors, and caller actions

The receiver processes a frame in this order:

1. Validate the `recognized signed` context, signature, time fields, digest,
   media type, and body limit. A local `degraded` cache is not a rejection.
2. Validate the closed frame shape and shared federation types.
3. Look up an active binding or tombstone by `(signer domain, callId)`.
4. For a tombstone, accept terminal retries and recorded signal IDs as no-ops;
   return `CALL_CANCELLED` or `CALL_TERMINATED` for other frames.
5. For an active binding, handle a repeated `incoming` or recorded signal ID
   according to Section 7 or 8 before new-transition checks.
6. Only for a new `incoming`, validate account/domain binding and local call
   admission before creating the active binding.
7. For another new frame, validate direction, stage, `mediaType`, and
   operation-specific constraints; accept already traversed lifecycle events as
   no-ops.

For a new `incoming`, a missing or disabled callee, refusal of federation
calls, disallowed participant relationship, user block, tenant policy, or any
other admission detail that cannot safely be disclosed returns the single
privacy-collapsed result HTTP `200 CALL_NOT_ALLOWED`. These conditions MUST NOT
use `FEDERATION_MALFORMED`, `NOT_FOUND`, `FORBIDDEN`, distinct messages, or
structured data to reveal the cause.

Only after all privacy admission checks succeed may the receiver test whether
the callee is busy and return `CALL_BUSY`. An inadmissible call returns
`CALL_NOT_ALLOWED` even if the account also exists and is busy.

An unknown non-`incoming` call with no tombstone returns
`200 CALL_NOT_ALLOWED` and creates no state. Once a call is active, a later P2P
or user-call permission change does not block valid frames needed for safe
termination and convergence unless the federation peer enters the hard gate.

| Condition                                                          | HTTP / code                        | Action                                           |
| ------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------ |
| Invalid shape, field, ID, active binding, direction, or transition | `400 FEDERATION_MALFORMED`         | Correct before retrying.                         |
| Signer does not bind the `incoming` caller                         | `401 FEDERATION_BINDING_VIOLATION` | Do not retry unchanged.                          |
| Unknown call or privacy-collapsed admission failure                | `200 CALL_NOT_ALLOWED`             | End this call; do not degrade the peer.          |
| Late non-retry frame for a cancelled call                          | `200 CALL_CANCELLED`               | Converge to cancelled and stop dependent work.   |
| Late non-retry frame for another terminal call                     | `200 CALL_TERMINATED`              | Converge to terminal and stop dependent work.    |
| Callee is already in another active call                           | `200 CALL_BUSY`                    | End this attempt or later create a new `callId`. |

Network failure and HTTP `503` MAY retry the identical frame with bounded
backoff. An HTTP `200` response still requires envelope parsing: only `code=0`
is success. Implementations MUST NOT branch on human-readable `message` text.

## 12. Examples

### 12.1 Lifecycle frames

```jsonl
{"callId":"550e8400-e29b-41d4-a716-446655440000","operation":"incoming","mediaType":"AUDIO","payload":{"callerAccount":"alice","calleeAccount":"bob"}}
{"callId":"550e8400-e29b-41d4-a716-446655440000","operation":"ringing","mediaType":"AUDIO"}
{"callId":"550e8400-e29b-41d4-a716-446655440000","operation":"accepted","mediaType":"AUDIO"}
{"callId":"550e8400-e29b-41d4-a716-446655440000","operation":"connected","mediaType":"AUDIO","payload":{"startedAt":1700000000100}}
{"callId":"550e8400-e29b-41d4-a716-446655440000","operation":"ended","mediaType":"AUDIO","payload":{"endReason":"completed"}}
```

The common `callId` illustrates alternative frames; it does not imply that
one call traverses mutually exclusive terminal paths.

### 12.2 Signal frames

```jsonl
{"callId":"550e8400-e29b-41d4-a716-446655440000","operation":"signal","mediaType":"AUDIO","payload":{"signalId":"c0a80101-0000-4000-8000-000000000001","signalType":"offer","data":"v=0\r\no=- 46117317 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"}}
{"callId":"550e8400-e29b-41d4-a716-446655440000","operation":"signal","mediaType":"AUDIO","payload":{"signalId":"c0a80101-0000-4000-8000-000000000003","signalType":"ice","data":"{\"candidate\":\"candidate:1 1 UDP 2122260223 192.0.2.10 54321 typ host\",\"sdpMid\":\"0\",\"sdpMLineIndex\":0}"}}
{"callId":"550e8400-e29b-41d4-a716-446655440000","operation":"signal","mediaType":"VIDEO","payload":{"signalId":"c0a80101-0000-4000-8000-000000000004","signalType":"video-state","data":"{\"enabled\":true}"}}
```

### 12.3 HTTP Message Signature

```http
POST /s2s/v1/call HTTP/1.1
Host: b.example
Content-Type: application/json
Date: Tue, 14 Nov 2023 22:13:20 GMT
Content-Digest: sha-256=:<base64 digest of the exact body below>:
Signature-Input: sig1=("@method" "@path" "@query" "@authority" "date" "content-digest");created=1700000000;expires=1700000300;keyid="a.example/key-1";alg="ed25519"
Signature: sig1=:<Ed25519 signature>:

{"callId":"550e8400-e29b-41d4-a716-446655440000","operation":"incoming","mediaType":"AUDIO","payload":{"callerAccount":"alice","calleeAccount":"bob"}}
```

Deterministic values are provided in
[`schema/vectors/call-http-message-signature.json`](./schema/vectors/call-http-message-signature.json).
The signature covers the exact UTF-8 bytes; changing whitespace requires a new
digest and signature.

## 13. External standards

Federation v1 does not modify or redefine:

- [WebRTC 1.0](https://www.w3.org/TR/webrtc/)
- [RFC 8829 — JSEP](https://www.rfc-editor.org/rfc/rfc8829.html)
- [RFC 3264 — SDP Offer/Answer](https://www.rfc-editor.org/rfc/rfc3264.html)
- [RFC 8866 — SDP](https://www.rfc-editor.org/rfc/rfc8866.html)
- [RFC 8445 — ICE](https://www.rfc-editor.org/rfc/rfc8445.html)
- [RFC 8838 — Trickle ICE](https://www.rfc-editor.org/rfc/rfc8838.html)
- [RFC 8489 — STUN](https://www.rfc-editor.org/rfc/rfc8489.html)
- [RFC 8656 — TURN](https://www.rfc-editor.org/rfc/rfc8656.html)
- [RFC 8834](https://www.rfc-editor.org/rfc/rfc8834.html)
- [RFC 8835](https://www.rfc-editor.org/rfc/rfc8835.html)
- [RFC 8827](https://www.rfc-editor.org/rfc/rfc8827.html)
- [RFC 9421 — HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421.html)
- [RFC 9562 — UUID](https://www.rfc-editor.org/rfc/rfc9562.html)
