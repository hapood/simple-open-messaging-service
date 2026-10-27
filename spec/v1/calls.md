# Simple Open Messaging Federation Protocol v1 Call Signaling

Status: `DRAFT` — Final Review (`v1.0.0-draft.2`)

This document defines normative requirements. Examples and the explicitly
non-normative operational defaults illustrate those requirements without
adding to them.

This document defines the mandatory end-to-end interoperability profile for
one-to-one calls. It covers both the signed `POST /s2s/v1/call`
server-to-server operation and the WebRTC/JSEP behavior required of the endpoint
subsystems that produce and consume its signaling. Media, SDP, ICE, STUN, and
TURN remain governed by the external standards listed in Section 13.

This operation also follows the shared types and response envelope in the
[core protocol](./protocol.md), identity and HTTP Message Signature rules in
[Transport and Security](./transport-security.md), and business codes in the
[stable error registry](./errors.md). The JSON Schema is a non-normative
machine-readable validation resource and cannot override this text.

## 1. Protocol scope and conformance boundary

Federation v1 provides:

- a call lifecycle shared by the caller server and callee server;
- transparent relay of endpoint-generated SDP, ICE, and protocol
  `video-state` payloads;
- ringing, acceptance, connection, termination, and AUDIO-to-VIDEO upgrade
  events; and
- frame ordering, retry, idempotency, race convergence, and bounded call
  tombstones.

The Call Profile spans the Federation wire between the caller and callee
servers and the endpoint WebRTC/JSEP behavior required to give relayed payloads
one deterministic end-to-end meaning. The local API or transport between a
server and its endpoint subsystem is not part of the SOMFP wire protocol. A
deployment MAY use WebSocket, push delivery, HTTP, native IPC, or another local
mechanism, but its server and every supported call endpoint MUST jointly satisfy
this profile.

Call is a mandatory v1 feature, not a negotiated capability. A node publishing
`1` in `protocolVersions` MUST implement this complete profile and MUST NOT
claim v1 conformance if its supported endpoints cannot perform the required
WebRTC/JSEP behavior.

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
- The **callee server** receives `incoming` and participates in the call
  lifecycle and signaling exchange.
- The **caller endpoint subsystem** is the local component or coordinated set
  of components that owns the caller-side `RTCPeerConnection` and produces or
  consumes caller-side WebRTC signaling and media.
- The **callee endpoint subsystem** has the corresponding callee-side role.
- `callId` is the canonical UUID correlation key for one call. The caller
  server MUST NOT reuse it for another call and MUST preserve it when retrying
  the same call.
- `signal.payload.signalId` is the canonical UUID idempotency key for one logical
  signal. A sending server MUST use a distinct value for each logical signal
  in a call and preserve it across retries of that signal.

These IDs and answer `inReplyTo` use the shared `CanonicalUuid` type defined by the
[Core Protocol](./protocol.md#62-shared-federation-types): version field 1–8,
RFC variant, lowercase hyphenated `8-4-4-4-12` form. v1 does
not vary behavior by UUID version. The sending server is responsible for every
wire ID regardless of whether an endpoint or server generated it.

An endpoint subsystem MAY be one process, multiple cooperating components, or
one endpoint selected from several user devices. That decomposition and the
local selection mechanism are implementation choices. For one accepted call
binding, exactly one logical endpoint instance on each side MUST own an active
WebRTC negotiation at a time.

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
non-terminal retries, and apply the Section 10 terminal protection. Later frames
fail with the registered fatal reason before call-binding lookup. The policy,
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
  usernameFragment: string;
}

interface VideoState {
  enabled: boolean;
}

interface CallFrameBase {
  callId: CanonicalUuid;
  operation: CallOperation;
}

type CallSignalPayload =
  | {
      signalId: CanonicalUuid;
      signalType: 'offer';
      data: SdpText;
    }
  | {
      signalId: CanonicalUuid;
      signalType: 'answer';
      inReplyTo: CanonicalUuid;
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
      mediaType: MediaType;
      payload: { callerAccount: UserAccount; calleeAccount: UserAccount };
    })
  | (CallFrameBase & {
      operation: 'ringing' | 'accepted' | 'declined' | 'cancelled' | 'missed';
    })
  | (CallFrameBase & { operation: 'signal'; payload: CallSignalPayload })
  | (CallFrameBase & { operation: 'connected' })
  | (CallFrameBase & { operation: 'video-upgraded' })
  | (CallFrameBase & {
      operation: 'ended';
      payload: { endReason: CallEndReason };
    });
```

`callId` and `operation` are required in every frame. `mediaType` is required
only on `incoming` and MUST be absent from every other operation, including
`video-upgraded`. It declares the initial type bound to this call.

The current business type changes only through the AUDIO-to-VIDEO transition in
Section 9. Other frames refer to the existing call binding and neither assert
nor change its current type. Receivers MUST NOT infer a business-type change
from SDP, ICE, or `video-state`. v1 does not permit downgrade to AUDIO.

`payload` is an operation-specific closed object. It is required only for
`incoming`, `signal`, and `ended`, and forbidden for every other
operation. `inReplyTo` is REQUIRED for answer and FORBIDDEN for every other
signal type. It references the original offer's `signalId` within the authenticated
call binding, not a globally searchable ID.

This endpoint profile requires `usernameFragment` to be a nonempty valid ICE
ufrag: 4–256 characters from ASCII letters, digits, `+`, and `/` (RFC 8445).
It MUST carry the candidate's actual local ICE generation unchanged, including
on native endpoints; no missing-field fallback is permitted. This is an application
interoperability requirement, not a WebRTC dictionary requirement. Other members
retain the defaults and semantics of the
[WebRTC 1.0 `RTCIceCandidateInit` dictionary](https://www.w3.org/TR/webrtc/#dom-rtcicecandidateinit).
There is no outer ICE generation field. Servers MUST NOT parse the inner ICE
JSON or SDP, or validate ICE generations.

## 5. Lifecycle state machine

The caller server arbitrates terminal races and owns the authoritative result.
The callee server participates in the lifecycle without publishing a competing
authoritative result. The wire lifecycle has four stages: `ringing`, `accepted`,
`connected`, and `terminal`. `none` denotes the absence of an active binding,
not an additional active stage.

A stage describes a server's committed protocol lifecycle for
`(peer domain, callId)`. It is not endpoint UI state or
`RTCPeerConnection.signalingState`, `iceConnectionState`, or `connectionState`.
The two servers may temporarily observe different stages while a frame or its
response is in flight. The receiver commits the transition before returning
`200/code=0`; the sender regards that transition as federatively committed only
after receiving that response, as specified in Section 6.

Here, committing a transition means that subsequent frame handling follows its
resulting protocol stage. A local acceptance or media-connection indication does
not by itself confirm that the corresponding lifecycle frame was accepted by
the peer. The term `pending` in the sequences below denotes that absence of
confirmation, not an additional lifecycle stage.

| Stage       | Entry                                                         | Meaning                                                                 |
| ----------- | ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `none`      | No accepted `incoming`                                        | No active binding; another op cannot create one.                        |
| `ringing`   | Accepted `incoming`                                           | Binding exists and awaits acceptance; endpoint alerting is not implied. |
| `accepted`  | Successfully applied `accepted` frame                                           | The callee accepted; SDP/ICE negotiation may continue.                  |
| `connected` | Successfully applied callee `connected` frame                        | The authoritative media connection was established.                     |
| `terminal`  | First valid terminal frame or authoritative local termination | Irreversible; late-frame handling follows Section 10.                  |

The `ringing` operation is an advisory acknowledgement that the callee
endpoint actually began alerting the user. It does not change the `ringing`
stage.

```text
none --incoming--> ringing --accepted--> accepted --connected--> connected
ringing   --declined/missed/cancelled/ended(failed)---> terminal
accepted  --cancelled/ended(completed|timeout|failed)-> terminal
connected --ended(completed|failed)-------------------> terminal

connected/AUDIO --video-upgraded--> connected/VIDEO
ringing(op), signal: no stage change
```

The matrix describes the receiving server's first effective application of a
valid frame. A successful no-op is a permitted duplicate or an event on an
already traversed path. Other active-stage combinations are invalid; terminal
handling follows Sections 7 and 10. The sender's local triggers and delivery
prerequisites are specified in this section and Section 6; the matrix does not
make both servers change stage simultaneously.

| `operation`      | Direction        | First effective stage         | Result                     | Successful no-op                              |
| ---------------- | ---------------- | ----------------------------- | -------------------------- | --------------------------------------------- |
| `incoming`       | caller → callee  | `none`                        | Create `ringing`           | Identical binding in an active stage          |
| `ringing`        | callee → caller  | `ringing`                     | Record advisory fact       | Already recorded, accepted, or connected      |
| `accepted`       | callee → caller  | `ringing`                     | Enter `accepted`           | Already accepted or connected                 |
| `connected`      | callee → caller  | `accepted`                    | Enter `connected`          | Already connected; no repeated effects |
| `video-upgraded` | caller → callee  | Connected and currently AUDIO | Change type to VIDEO       | Initially AUDIO and already upgraded          |
| `declined`       | callee → caller  | `ringing`                     | Enter `terminal`           | Already terminal                              |
| `missed`         | callee → caller  | `ringing`                     | Enter `terminal`           | Already terminal                              |
| `cancelled`      | caller → callee  | `ringing` or `accepted`       | Enter `terminal`           | Already terminal                              |
| `ended`          | Either direction | Any active stage for `failed`; otherwise the end-reason table below | Enter `terminal` | Already terminal |
| `signal`         | Section 8        | Section 8                     | Relay without stage change | Signal ID already processed                   |

The callee server MUST send `ringing` only after its endpoint subsystem provides
a trustworthy indication that user-visible alerting began for this call
binding. Delivery of `incoming` to a device, acceptance by a push service, or
creation of server-side call state alone is insufficient. How the endpoint
provides the indication is local. Failure of this advisory frame MUST NOT block
acceptance or fail the call.

The callee server MUST send `accepted` only after one callee endpoint instance
has claimed the call binding and the deployment prevents another endpoint from
independently accepting the same binding. Multi-device arbitration is local,
but its result MUST be externally equivalent to one logical callee endpoint.

`cancelled` applies in `accepted` to converge a race in which the caller
cancelled before observing acceptance. After the caller server has accepted
`accepted`, a later local hang-up uses `ended`, not a newly generated
`cancelled`.

The callee endpoint subsystem MUST report connection only after its
`RTCPeerConnection.connectionState` first becomes `connected`; candidate
discovery, successful SDP application, or the start of ICE or DTLS negotiation
alone is insufficient. Only the callee server sends `connected`. The frame
asserts the connection fact and carries no payload or event timestamp.
Ordering, authorization, expiry, and race resolution follow the rules in this
profile.

| `endReason` | Permitted stage           | Meaning                                                                       |
| ----------- | ------------------------- | ----------------------------------------------------------------------------- |
| `completed` | `accepted` or `connected` | Normal hang-up after acceptance, with or without a completed media connection |
| `timeout`   | `accepted`                | The connection evidence defined for this server in Section 10 did not arrive before its post-acceptance deadline |
| `failed`    | `ringing`, `accepted`, or `connected` | Non-timeout technical failure before or after acceptance or connection |

Either server MAY originate `ended(failed)` for a technical failure in any
active stage. A receiver with an active binding MUST allow this end reason in
`ringing`, `accepted`, or `connected`, subject to the other frame validation
rules. In particular, failure of an initial offer before user acceptance follows
the failure-convergence rule in Section 8 without requiring an `accepted` event
first. This transition does not assert user acceptance or media connection.

This rule does not create a binding for an unknown call, bypass Section 6's
delivery prerequisites, or change the permitted stages for `completed` and
`timeout`. Terminal retries continue to follow Sections 7 and 10.

## 6. Commit, ordering, and races

### 6.1 Per-sender ordering

A sender MUST send state-changing frames for the same
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
that response. On `CALL_CANCELLED` or `CALL_TERMINATED`, the sender MUST stop
sending or retrying dependent non-terminal frames. The callee MUST receive
success for `signal(answer)` before sending a `connected` that depends on that
answer. ICE remains independently deliverable and may arrive out of order.

### 6.2 Normal sequence

The following sequence illustrates the lifecycle and delivery prerequisites.
Local arrows represent endpoint/server interactions, not prescribed local API
operations or transports. Independent ICE and some HTTP responses are omitted.

```text
Caller endpoint    Caller server          Callee server     Callee endpoint
      | initiate         |                     |                  |
      |----------------->| [ringing]           |                  |
      |                  | incoming            |                  |
      |                  |-------------------->| [ringing]        |
      |                  |<------- 200 --------|                  |
      |                  |                     | alert request    |
      |                  |                     |----------------->|
      |                  |                     |<-- alerting -----|
      |                  |<-- ringing ---------|                  |
      |                  |    (advisory; may overlap acceptance)  |
      | local offer      |                     |                  |
      |----------------->| signal(offer)       |                  |
      |                  |-------------------->|-- local offer -->|
      |                  |                     |<-- acceptance ---|
      |                  |                     | [accept pending] |
      |                  |<----- accepted -----|                  |
      |                  | [accepted]          |                  |
      |                  |-------- 200 ------->| [accepted]       |
      |                  |                     |<-- local answer -|
      |                  |<-- signal(answer) --|                  |
      |<-- local answer -|-------- 200 ------->|                  |
      |                  |                     |<-- media up -----|
      |                  |                     | [connect pending]|
      |                  |<-- connected -------|                  |
      |                  | [connected]         |                  |
      |                  |-------- 200 ------->| [connected]      |
      |<-- connected ----|                     |                  |
```

An initial offer MAY be sent after `incoming` succeeds and before acceptance.
The callee server MUST establish the binding before returning success for
`incoming`; the caller waits for that success before sending the offer. Thus
an initial offer cannot precede its target binding through this sequence.

The callee sends `signal(answer)` only after `accepted` succeeds, and sends a
`connected` dependent on that answer only after `signal(answer)` succeeds.
A local SDP answer is an endpoint/server interaction; `signal(answer)` is the
S2S frame carrying that description. Neither is an HTTP response. Success for a
signal acknowledges server-level acceptance, not endpoint application, as
specified in Section 8.

The pending annotations illustrate the interval before S2S success is observed.
The receiver has already committed when it sends success. If that response is lost,
the sender has not confirmed the commit and follows the retry and idempotency
rules; it cannot infer that the receiver rejected or rolled back the frame.
The diagram does not imply an atomic commit across both servers.

The `ringing` advisory is outside these dependencies. It MAY arrive before or
after `accepted`, or fail, without blocking acceptance. Local alert delivery and
other independent work need not follow the illustrative scheduling above.

### 6.3 Acceptance/cancellation race

The caller server resolves a crossing `accepted` and local `cancelled` by its
actual processing order, not by comparing wall clocks. If it committed
cancellation first, late acceptance receives `CALL_CANCELLED`. If it committed
acceptance first, the accepted state wins and a subsequent local hang-up uses
`ended`. On the callee server, a valid caller `cancelled` terminates a call that
is ringing or accepted, including while acceptance awaits confirmation, but
not connected. Late-frame handling remains subject to Section 10.

```text
Callee server                         Caller server (authority)
  accepted, awaiting confirmation ------->|
                                         | still ringing: commit accepted
                                         | cancelled: CALL_CANCELLED
                                         | other terminal: CALL_TERMINATED

Caller server                         Callee server
  cancel before processing accepted ----->|
                                         | ringing / acceptance pending /
                                         | accepted: enter terminal
```

Here `acceptance pending` denotes an unconfirmed local action, not another
protocol stage. Endpoint acceptance alone does not override the caller's
cancellation decision.

### 6.4 Bidirectional terminal events

Both sides may send `ended` concurrently. The caller server's first committed
terminal result is authoritative. The callee MUST NOT publish a competing
terminal result. Both sides stop the call's media and active
semantics when entering `terminal`.

### 6.5 Connection/timeout race

Connection-deadline completion and confirmation of a lifecycle frame are
different events. Section 10 defines the connection evidence for each server.
The following cases use A for the caller server and B for the callee server.

| Order | Result |
| --- | --- |
| B accepts its endpoint connection indication; A accepts `connected`; the success response to B is delayed or lost | B's connection deadline has already ceased. B follows bounded delivery retry rules and MUST NOT generate `ended(timeout)` merely because confirmation is missing. A handles a duplicate `connected` as a no-op. |
| B accepts its endpoint connection indication; A commits its connection timeout before processing `connected` | A is terminal and returns `CALL_TERMINATED` to the late frame. B converges to terminal even though its endpoint connected locally. B's unconfirmed connection indication does not override A's result. |
| A accepts `connected` before its connection timeout decision | A's connection deadline ceases. A MUST NOT subsequently originate `ended(timeout)` for that expired establishment timer. |
| B commits its connection timeout before accepting an endpoint connection indication | B is terminal and MUST NOT originate a late `connected`. It sends `ended(timeout)` under the existing ordering rules; no endpoint event revives the call. |

Each order is the relevant server's local processing order, not a comparison of
clocks between servers. A late HTTP success MUST NOT
revive a call that has already terminated locally.

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
- The first accepted `connected` applies the connection transition. A duplicate
  is a no-op and MUST NOT repeat connection effects or reset local timing.
- A repeated `video-upgraded` is a no-op only for a call initially created as
  AUDIO and already upgraded. It is malformed for a call initially VIDEO.
- The first terminal event wins. A later terminal frame is a no-op and does not
  compare operation, type, or reason. Other late frames receive the terminal
  business result described in Sections 10 and 11.

## 8. Signal payloads, phases, and retries

The caller endpoint subsystem MUST be the offerer and the callee endpoint
subsystem MUST be the answerer for the initial negotiation, media
renegotiation, ICE restart, and AUDIO-to-VIDEO upgrade. A callee-side
`negotiationneeded` event MUST NOT directly produce an offer. This SOMFP
application rule avoids offer glare; WebRTC 1.0, JSEP, and RFC 3264 do not
require one fixed side to remain the offerer.

Offer ownership is distinct from requesting a media change. Section 9 defines
how a callee's video request triggers a caller-generated offer. v1 defines no
callee-to-caller request for ICE restart or general renegotiation. The caller
initiates those negotiations based on its own endpoint observations and local
policy; a callee-local need does not by itself notify the caller. Recovery
triggers, retry counts, and waiting periods are local policy. An unrecoverable
media failure follows the existing `ended(failed)` rules in Sections 5 and 10.

Endpoint subsystems MUST perform offer/answer processing with the
`RTCPeerConnection` signaling state machine defined by
[WebRTC 1.0](https://www.w3.org/TR/webrtc/) and the offer/answer procedures in
[RFC 8829 JSEP](https://www.rfc-editor.org/rfc/rfc8829.html). Those standards
define how session descriptions are parsed, applied, and used to create offers
and answers; this profile does not reproduce or replace their algorithms.

In particular, an answerer MUST successfully apply a remote offer with
`setRemoteDescription` before invoking `createAnswer`, and MUST successfully
apply its generated answer with `setLocalDescription` before sending that
answer. The offerer MUST successfully apply the remote answer with
`setRemoteDescription` before treating that negotiation as complete. A failed
description operation is not a completed negotiation and follows the SOMFP
failure-convergence rule below.

`signal.payload.data` is a string of 1–32768 Unicode code points. Federation
servers validate only the outer shape, type, length, IDs, correlation, direction,
stage, and active binding. They MUST
NOT parse, normalize, reserialize, or rewrite it.

`JsonText<T>` documents the structure an endpoint obtains after `JSON.parse`;
the wire field remains an unmodified JSON string. Opaque to Federation servers
does not mean unvalidated end to end: the producing endpoint subsystem MUST
generate the specified inner structure, and the consuming endpoint subsystem
MUST validate it before use. An invalid offer or answer MUST fail the active
negotiation and converge the call through `ended(failed)`. An invalid individual
ICE candidate MUST be ignored without undoing server-level signal acceptance.
An invalid `video-state` payload MUST be ignored and MUST NOT by itself terminate
an otherwise usable call. Invalid inner content does not make an accepted
`signalId` reusable or retroactively change server-level idempotency.

| `signalType`  | Direction       | Permitted stage                    | `data`                                                                                                                              |
| ------------- | --------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `offer`       | caller → callee | `ringing`, `accepted`, `connected` | SDP offer produced under [JSEP](https://www.rfc-editor.org/rfc/rfc8829.html) and [SDP](https://www.rfc-editor.org/rfc/rfc8866.html) |
| `answer`      | callee → caller | `accepted`, `connected`            | SDP answer produced under JSEP and SDP                                                                                              |
| `ice`         | Either          | `ringing`, `accepted`, `connected` | JSON text whose decoded value conforms to WebRTC 1.0 `RTCIceCandidateInit`                                                          |
| `video-state` | Either          | `connected`                        | JSON text whose decoded value conforms to the closed `VideoState` interface above                                                   |

At most one negotiation for a call may be incomplete at a time. The caller may
create another offer only after the previous answer was successfully applied
and endpoint signaling returned to `stable`. The callee produces at most one
answer for each valid offer. Requests while an answer is outstanding MUST queue
or coalesce; endpoints MUST NOT replace an outstanding offer after a timeout.
If negotiation cannot safely complete, bounded failure/termination is required.

The offer producer MUST assign its signal ID before asynchronous sending. The
answer producer MUST retain the received offer identity through buffering,
media-permission retries, and SDP application, and capture it as `inReplyTo` when
creating the answer. IDs and correlation MUST survive relay and retry unchanged.
Endpoint delivery MUST preserve each signal's ID, payload, and answer
`inReplyTo` association. Local APIs and storage representations are not
prescribed.

For a NEW answer, after role and stage checks the server MUST verify that
`inReplyTo` equals the latest admitted caller offer ID in this call and that no
logical answer has yet been admitted for that offer. Unknown, cross-call,
superseded references and a second answer with a new ID return HTTP 400
`FEDERATION_MALFORMED`. Invalid answers MUST NOT enter deduplication or replace
an accepted answer. The server MUST preserve the offer/answer association needed
for subsequent correlation checks, including renegotiation; cleanup of temporary
data MUST NOT invalidate those checks.
Server admission does not prove successful endpoint SDP application or stability.

Endpoints MUST apply an answer only if `inReplyTo` matches the active local offer,
the same call/peer-connection generation is alive, and JSEP permits application.
Known old or duplicate completions have no effect; unexplained conflicting
signaling follows failed-negotiation convergence. A mismatched answer MUST NOT
release the negotiation lock or complete a video upgrade.

The sender MUST use an unused `payload.signalId` for each new logical signal. A
retry MUST preserve both the ID and the complete original signal body. For
`(signer domain, callId, payload.signalId)`, the receiver accepts only the first
signal. A repeated ID returns `200/code=0` without another application effect.
It does not rewrite or invalidate the accepted signal based on a later body.
Closed-shape validation still precedes replay handling: missing or invalid
`inReplyTo` fails even for a replay. A valid-shape accepted-ID replay is a no-op
before transition and correlation checks, including after a newer negotiation.
The receiver retains this deduplication information for the Section 10
tombstone lifetime.

ICE may arrive out of order relative to an offer or answer. A federation server
MUST NOT reject, reorder, or interpret ICE according to JSEP ordering; it
validates the outer frame and relays it unchanged. Endpoints buffer and apply
it through `addIceCandidate` according to the WebRTC 1.0 and JSEP signaling
state. Endpoints MUST bind candidates to the matching remote SDP ICE credentials
and media section, buffering pre-SDP candidates within bounded limits. Known
obsolete generations MUST be ignored, never applied merely to whichever generation
is current at delivery. Ordinary renegotiation may reuse credentials and MUST
continue to accept that generation's candidates. End-of-candidates indications,
if emitted, MUST also be generation-bound. Offer IDs are not ICE generation
identities. ICE restart creates no lifecycle event. A successful AUDIO-to-VIDEO
negotiation uses Section 9.

HTTP `200/code=0` acknowledges server-level validation and acceptance, not
endpoint delivery or successful application. Endpoint application failure MUST
converge through a later lifecycle frame or the applicable finite deadline; it
MUST NOT cause reuse of the accepted `signalId`.

## 9. AUDIO-to-VIDEO upgrade

When the callee requests an upgrade, it first sends
`video-state {"enabled":true}` and the caller creates the new offer. A caller
request also results in a caller-generated offer. Offer, answer, and ICE frames
carry no business media type. The AUDIO-to-VIDEO business transition still
requires `video-upgraded`; successful endpoint negotiation alone does not commit
it. Only after the caller endpoint successfully applies the corresponding
answer matching its active offer and confirms negotiated video capability for
the requested direction does the caller server send:

```json
{
  "callId": "550e8400-e29b-41d4-a716-446655440000",
  "operation": "video-upgraded"
}
```

The callee does not send this frame or commit the upgrade merely after applying
its local answer. The upgrade follows Section 6's confirmation rules:

- The callee changes its current business type to VIDEO when it accepts
  `video-upgraded`, before returning `200/code=0`.
- The caller changes its current business type to VIDEO when it receives that
  success response while the call is still active. Until then, the upgrade is
  unconfirmed at the caller.
- A missing response does not undo the callee's accepted upgrade. An identical
  retry while active is a no-op under Section 7. A terminal response instead
  ends the pending exchange under Sections 6 and 10.

The caller's first terminal decision fixes the authoritative result using the
business type it has confirmed at that point. If upgrade confirmation precedes
termination, the final type is VIDEO; if termination precedes confirmation of
an AUDIO call's upgrade, the final type remains AUDIO. A late success response
MUST NOT revise that lifecycle result. This is the protocol business type, not
an assertion about every media track that may have been negotiated.

Acquiring a camera or receiving an unrelated answer is insufficient for upgrade.
Caller-camera-off/callee-camera-on MUST be supported without requiring caller
camera permission. SDP completion and business-type persistence MUST NOT depend
on decoded frame arrival; render readiness is independent.

Disabling a camera sends only `video-state` and does not downgrade the business
type. ICE restart or renegotiation without new video media MUST NOT create
`video-upgraded`.

An independent signal may cross the upgrade frame or its HTTP response. Its
arrival does not assert the sender's current business type, and the receiver
validates it using the existing binding, direction, phase and signal-ID rules.
An ICE signal created before the upgrade remains subject to endpoint WebRTC
processing when delivered afterward; its age relative to the business upgrade
is not itself a reason for server rejection. The same absence of a type snapshot
prevents a crossing terminal frame from failing a media-type equality check.
Neither rule relaxes terminal handling or signal validation.

| Order | Required behavior |
| --- | --- |
| An ICE frame is sent during AUDIO; the upgrade is confirmed; that ICE then arrives | Validate and relay the bound signal under Section 8. Do not reject it merely because the business type is now VIDEO. |
| The callee accepts `video-upgraded`; its HTTP response is delayed; an independent callee signal reaches the caller | Process the signal under Section 8. The signal neither confirms the pending upgrade nor changes the caller's business type. |
| Upgrade success reaches the caller before it commits termination | The caller confirms VIDEO; its final record uses VIDEO. |
| The caller commits termination before upgrade success reaches it | The caller's final record retains AUDIO; late upgrade success does not change it. The callee does not publish another result. |
| The callee terminates before receiving `video-upgraded` | Terminal protection rejects the late upgrade with the retained terminal result. The upgrade cannot revive the call. |

## 10. Terminal protection and request expiry

After accepting `declined`, `cancelled`, `missed`, or `ended`, active state
immediately becomes terminal. The receiver MUST apply terminal protection
(called a tombstone in this document) until:

```text
min(terminal request Signature-Input.expires,
    local terminal-acceptance time + 300 seconds)
```

Three hundred seconds is the maximum v1 call-tombstone lifetime. A retry with a
new signature MUST NOT extend the original tombstone. A locally generated
terminal event uses that side's own terminal request expiry for the same
calculation.

During this protection period, the receiver MUST apply Sections 7 and 8 as
follows:

- every terminal frame is a no-op that does not replace the first result;
- an already processed signal ID is a no-op;
- a new `incoming` or other late frame for a cancelled call returns
  `CALL_CANCELLED`;
- the equivalent frame for another terminal result returns `CALL_TERMINATED`;
  and
- no frame recreates or restores the call.

After learning or committing a terminal result, a sender MUST stop originating
and retrying non-terminal frames for that `callId`. It MUST NOT renew a
signature to replay an old `incoming` or signal.

Every request remains subject to the signature-time validation in
[Transport Security, Section 3.5](./transport-security.md). Expired signed
requests MUST be rejected regardless of the call's lifecycle or protection
period. Signature validity alone does not override active-call idempotency or
terminal protection.

Terminal protection guarantees the late-frame behavior above only for its
defined period; it does not guarantee that every in-flight request will arrive
within that period. After protection expires, v1 does not require indefinite
recognition of the historical call ID. The caller's prohibition on reusing a
call ID for another call remains in force. v1 defines no active-call recovery
operation.

Both servers MUST use finite unanswered and post-acceptance connection
deadlines. Their durations and relative ordering are local policy. On
acceptance, the unanswered deadline ceases and the connection deadline begins.

The post-acceptance connection deadline waits for the following evidence:

| Server | Evidence that completes the connection deadline |
| --- | --- |
| Callee server | Its first accepted endpoint connection indication satisfying Section 5, which supplies the local connection observation. |
| Caller server | Its first validation and commit of the callee's `connected` frame. The caller endpoint's own connection indication is not a substitute. |

Each server MUST cease its connection deadline when it accepts that evidence,
without waiting for a later HTTP response. If the callee already accepted its
endpoint connection indication before the connection deadline would begin,
that deadline is already satisfied and MUST NOT subsequently produce a timeout.
This does not bypass any prerequisite for sending `connected` or confirm its
federation commit; Section 6 continues to govern those steps.

Deadline completion and a timeout decision MUST respect the server's local
processing order. Before committing a timeout, the server MUST verify that the
call is still awaiting its connection evidence and has not terminated. Once the
evidence is accepted, this establishment deadline MUST NOT restart because of a
lost HTTP response, a duplicate lifecycle frame, or a later media disruption.
An unrecoverable later media failure follows `ended(failed)`.

Failure to deliver or confirm `connected` follows Section 11's retry and
terminal-response rules. Attempts to obtain confirmation MUST be bounded by a
finite local delivery deadline; retrying MUST NOT extend that deadline. If it
expires without confirmation or a remote terminal result, the callee MUST end
its local active call as a technical failure. Any terminal notification remains
subject to Section 6's delivery prerequisites; this rule does not authorize
skipping an unconfirmed predecessor.

Missing confirmation MUST NOT be reclassified as failure to establish media at
the callee or cause `ended(timeout)` there after the endpoint connection
indication. The delivery deadline's duration is local policy; it creates no new
wire field, lifecycle stage, or competing authoritative result.

As a non-normative operational default, a deployment can use approximately 45
seconds for both the unanswered and post-acceptance connection deadlines and a
longer caller-side safety deadline, such as 60 seconds, to cover peer-server
failure or partition. These values are not wire constants.

A transient S2S delivery failure does not extend a lifecycle deadline. The
bounded retry permitted by Section 11 may allow an identical frame to arrive
before that deadline, but the protocol does not guarantee that waiting restores
delivery or an active call. Once either side commits a terminal result, the
late-frame rules apply throughout the terminal protection period; no delayed
frame may revive the call during that period.

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
7. For another new frame, validate direction, stage, and
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

After a network failure or HTTP `503`, the sender MAY retry the identical frame
with bounded backoff. An HTTP `200` response still requires envelope parsing: only `code=0`
is success. Implementations MUST NOT branch on human-readable `message` text.

## 12. Examples

### 12.1 Lifecycle frames

```jsonl
{"callId":"550e8400-e29b-41d4-a716-446655440000","operation":"incoming","mediaType":"AUDIO","payload":{"callerAccount":"alice","calleeAccount":"bob"}}
{"callId":"550e8400-e29b-41d4-a716-446655440000","operation":"ringing"}
{"callId":"550e8400-e29b-41d4-a716-446655440000","operation":"accepted"}
{"callId":"550e8400-e29b-41d4-a716-446655440000","operation":"connected"}
{"callId":"550e8400-e29b-41d4-a716-446655440000","operation":"ended","payload":{"endReason":"completed"}}
```

These frames illustrate one successful lifecycle using a common `callId`.
Their senders and delivery prerequisites are defined in Sections 5 and 6.

### 12.2 Signal frames

```jsonl
{"callId":"550e8400-e29b-41d4-a716-446655440000","operation":"signal","payload":{"signalId":"c0a80101-0000-4000-8000-000000000001","signalType":"offer","data":"v=0\r\no=- 46117317 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"}}
{"callId":"550e8400-e29b-41d4-a716-446655440000","operation":"signal","payload":{"signalId":"c0a80101-0000-4000-8000-000000000002","signalType":"answer","inReplyTo":"c0a80101-0000-4000-8000-000000000001","data":"v=0\r\n"}}
{"callId":"550e8400-e29b-41d4-a716-446655440000","operation":"signal","payload":{"signalId":"c0a80101-0000-4000-8000-000000000003","signalType":"ice","data":"{\"candidate\":\"candidate:1 1 UDP 2122260223 192.0.2.10 54321 typ host\",\"sdpMid\":\"0\",\"sdpMLineIndex\":0,\"usernameFragment\":\"abcd1234\"}"}}
{"callId":"550e8400-e29b-41d4-a716-446655440000","operation":"signal","payload":{"signalId":"c0a80101-0000-4000-8000-000000000004","signalType":"video-state","data":"{\"enabled\":true}"}}
```

### 12.3 HTTP Message Signature

```http
POST /s2s/v1/call HTTP/1.1
Host: b.example
Content-Type: application/json
Date: Tue, 14 Nov 2023 22:13:20 GMT
S2S-Root-Key: A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=
Content-Digest: sha-256=:5Vam5Hnx5PiCFCTArcBqNj7xOJbq4ew+8MqnYTZLtDU=:
Signature-Input: sig1=("@method" "@path" "@query" "@authority" "date" "content-digest");created=1700000000;expires=1700000300;keyid="a.example/key-1";alg="ed25519"
Signature: sig1=:y1SUIdFIzCUFImKmlzx+FGEXURckBJ0iTG3W/jdxA7im1bsAd2i+1my7pAJYGZsl1gq+YQZfHuzywHjjV/a1Cg==:

{"callId":"550e8400-e29b-41d4-a716-446655440000","operation":"incoming","mediaType":"AUDIO","payload":{"callerAccount":"alice","calleeAccount":"bob"}}
```

Deterministic values are provided in
[`schema/vectors/call-http-message-signature.json`](./schema/vectors/call-http-message-signature.json).
The signature covers the exact UTF-8 bytes; changing whitespace requires a new
digest and signature.

## 13. External standards

The WebRTC 1.0 and RFC 8829 references above are normative for endpoint
offer/answer and `RTCPeerConnection` processing. SOMFP defines the signaling
transport, fixed endpoint roles, lifecycle, idempotency, and application
failure convergence around those algorithms; it does not modify or redefine
the external standards below:

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
