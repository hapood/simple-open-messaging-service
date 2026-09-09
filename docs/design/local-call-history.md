# Local call history

Status: implemented.

## Ownership and scope

A call-history notice is a local `Message` with `contentType: SYSTEM` and
`content.type: CALL_ENDED`. It is generated when the local call reaches a terminal
state, from authenticated peer lifecycle facts or local actions and failure
observations. Ringing, acceptance, media connection, and video upgrade update
live call state without creating timeline messages.

For a same-server call, write one notice in the shared P2P thread. For a
federated call, each participating server writes its own notice for its local
audience. Local message IDs, sequences, observation times, and provisional
failure outcomes need not match. A notice has no remote origin coordinate.

The federation message contract excludes CALL and SYSTEM, including forwarded
bundle entries. The real-time call protocol remains responsible for lifecycle
arbitration; local history does not introduce a second lifecycle authority.

## Content and outcomes

Extend the system-message parser with a closed discriminated CALL_ENDED branch,
rather than adding call-only optional fields to every system-message subtype.
The proposed local content is:

```ts
interface CallEndedContent {
  type: 'CALL_ENDED';
  callId: string;
  caller: { account: string; domain: string };
  callee: { account: string; domain: string };
  mediaType: 'AUDIO' | 'VIDEO';
  outcome:
    | 'completed'
    | 'cancelled'
    | 'declined'
    | 'missed'
    | 'failed'
    | 'unreachable';
  initiatedAt: number;
  connectedAt?: number;
  endedAt: number;
}
```

All timestamps are integer epoch milliseconds. Direction comes from the caller
address and viewing account, not the system message's creator. Media type is the
local server's confirmed business type at termination; a video upgrade does
not restart timing. The existing protocol can leave different confirmed types
on the two servers when upgrade confirmation crosses termination.

| Outcome | Terminal evidence | Connected time |
| --- | --- | --- |
| `completed` | Normal end after confirmed media connection | Required |
| `cancelled` | Caller cancels before connection | Absent |
| `declined` | Explicit callee refusal | Absent |
| `missed` | Local ringing deadline or accepted missed fact | Absent |
| `failed` | Connection failure/timeout or abnormal termination | Present only if connected |
| `unreachable` | Call admission or delivery could not establish the remote call | Absent |

An explicit busy response is an admission failure, not `declined`. Admission
rejection is not evidence that the remote user rang or refused. A malformed or
unauthorized local request that never creates a legitimate call attempt does
not create a history notice. Once connected, a peer communication failure is
`failed`, not `unreachable`.

## Time semantics

The revised federation call frames carry no business event timestamps. Remove
the previous `connected.payload.startedAt`; `connected` now has no payload.
No new wire fields are introduced. The runtime validator, sender, and receiver
now use this payloadless shape and capture the local connection time.

Persist only local processing times for new call history. Necessary lifecycle
observations contain the bound call identity, operation, relevant validated
facts, and `processedAt` (local wall-clock acceptance time). Do not add a remote
event-time field or a separate remote timestamp archive. Signature times remain
transport metadata, not call-history times. Retain only necessary lifecycle
facts, not SDP/ICE bodies in call history. Retries preserve the first accepted
observation instead of replacing its time.

The UI uses the same local time basis as stored history:

- `initiatedAt`: local admission time for the caller, or first accepted incoming
  time for the callee. On the callee this means observed call start, not the
  caller's exact initiation time.
- `connectedAt`: local acceptance of the protocol-confirmed connection fact.
  Do not derive this time from peer clocks or reset it on duplicate frames.
- `endedAt`: local terminal decision time, including local acceptance of an
  authenticated terminal fact. It is not message insertion or retry time.

Display call waiting time as `(connectedAt ?? endedAt) - initiatedAt`, and
connected duration as `endedAt - connectedAt`. An unconnected call has no
displayed talk duration. Acceptance alone does not start talk timing.

Keep raw local `processedAt` observations unchanged. Use a monotonic clock to
measure intervals during a process lifetime and an anchored epoch timeline for
the public display fields, so wall-clock adjustments cannot create negative
intervals. Both are local measurements. Do not persist a process-local monotonic
value as a cross-restart clock. Recovery retains committed observations and
marks an interrupted active call as a failure without claiming exact media
duration across the outage. Validate `initiatedAt <= connectedAt <= endedAt`
when connected, otherwise `initiatedAt <= endedAt`.

These are local observed durations, not guaranteed identical or exact endpoint
media durations. The only call-field change is removal of
`connected.payload.startedAt` and its payload container. No remote event times
are needed for storage or display.

## Delivery failures and missing peers

If incoming delivery is known not to have reached the remote server, write only
the caller's local unreachable notice and local device fanout. The remote side
has no ring, notice, or synthetic call state. Do not create a remote history
message to compensate for failed delivery.

A request timeout alone does not prove non-delivery: the receiver may have
accepted the call and lost its response. Use existing bounded protocol retries,
cancellation, and timeout rules to terminate any accepted remote state. Do not
promise that this ambiguous case has no remote effects.

## Persistence, idempotency, and recovery

Persist the admitted call binding and enough observations to recover an active
call. Persisting state while active does not create a system message. Deduplicate
by local thread, caller identity, call ID, and the peer namespace for federated
calls; same-server calls use a local scope. Bind the peer namespace at admission
so a reset or reauthorization cannot attach an old fact to a new call.

Journal the first terminal observation durably. Under the thread content lock,
commit the notice, completed projection marker, and local device fanout admission
in one transaction. Both observation/journal writes and message projection acquire
business account scopes in sorted order, then the relationship pair and thread,
before touching call-history rows. Projection then writes message and task rows.
The journal transaction releases all locks before the projection transaction
starts; never carry a child-row lock into parent-lock acquisition.
Enforce database uniqueness in addition to in-memory guards. A failed commit
must remain recoverable; releasing live media resources must not discard the
only pending history write. Call signaling remains a separate lifecycle path
with the existing protocol expiry, ordering, and terminal protection rules;
it does not use federation message fanout. Terminal protection and local history
writes are both attempted even if one fails, and live busy slots are released
regardless of their results. Persistence errors remain visible to the caller.
History recovery and retries isolate individual records so one failed projection
does not prevent other notices from being generated.

Use the system writer's `FAN_OUT_THREAD_CONTENT` admission only. Never enqueue
`FAN_OUT_FEDERATION_THREAD_CONTENT`, publish a remote content-head hint for the
notice, or expose it through federation message/history queries. Local devices
still receive normal history, unread, and preview projections.

Accept remote facts only after signature, namespace, participant binding, and
state-transition validation. An unknown terminal frame must not synthesize a
call or history notice. Retries and simultaneous hangups produce one notice.

The first explicit accepted terminal decision is final under the call protocol.
A later terminal frame cannot override it. A local fallback based only on
uncertain delivery may be refined by validated evidence only if protocol
retention and binding rules still authorize that evidence; refinement must not
revive a call or change an explicit committed decision. The current protocol
does not guarantee that such evidence will arrive, so both histories may differ.

Any supported refinement updates the same notice and publishes a durable local
revision/invalidation that online and offline devices consume. Re-running an
append-only sequence fanout is insufficient to update an already fetched row.
Until that local revision mechanism exists, retain the original observation;
do not silently mutate the message or append a duplicate correction notice.

## Implementation and rollout

The [terminal writer](../../src/calls/calls.service.ts) records local observations
through [CallHistoryService](../../src/calls/call-history.service.ts). The journal
retains a first terminal observation before projecting it into a system message;
the message, completed projection marker, and device fanout commit atomically.
Pending terminal projections retry, and startup resolves interrupted active calls
as failed. The frame validator, bridge, sender, and receiver use payloadless
connected frames and local connection timing.

The old CALL content type, parser, federation projection, and frontend row are
removed. New records use the system renderer. No compatibility parser or legacy
conversion is provided. The new database migration discards old CALL records
and removes the enum label; historical deployed migrations remain unchanged.

Deploy the backend and clients together. The revised release-candidate contract
is incompatible with peers that publish CALL messages or require timestamped
connected frames. No automatic old-peer fallback is defined.

## Required verification

- Same-server calls create one notice; federated calls create one per server.
- Every outcome and audio/video case has correct connection-time presence.
- Live state changes create no messages; upgrades preserve timing.
- Known non-delivery has only local effects; lost responses follow bounded
  cancellation/timeout without asserting remote silence.
- Retries, concurrent terminal paths, transaction failures, and restarts do not
  lose or duplicate history; namespace changes reject stale facts.
- Every notice admits local device fanout and no federation fanout or feed item.
- Migration removes retired call records and leaves no CALL enum or parser.
- Federation conformance rejects CALL in queries, content, and forward bundles.
