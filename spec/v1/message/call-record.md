# `CALL` Message Record

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document defines the persisted terminal call record in a P2P timeline. It is not a real-time signaling payload: ringing, SDP, ICE, and transient lifecycle frames are carried only through `/s2s/v1/call`. See [Message Envelope](./envelope.md) for the shared outer message shape and [Calls](../calls.md) for the real-time state machine.

## 1. Content schema

```ts
type CallMediaType = 'AUDIO' | 'VIDEO';

type CallOutcome =
  | 'completed'
  | 'cancelled'
  | 'declined'
  | 'missed'
  | 'failed'
  | 'unreachable';

interface UnconnectedCallRecordContent {
  callSid: CanonicalUuid;
  callType: CallMediaType;
  status: CallOutcome;
  endedAt: EpochMilliseconds;
}

interface ConnectedCallRecordContent {
  callSid: CanonicalUuid;
  callType: CallMediaType;
  status: 'completed' | 'failed';
  startedAt: EpochMilliseconds;
  endedAt: EpochMilliseconds;
}

type CallRecordContent =
  | UnconnectedCallRecordContent
  | ConnectedCallRecordContent;
```

Both branches are closed schemas. `startedAt` is conditionally required: it is required after a valid `connected.startedAt` has been accepted and forbidden otherwise. The consumer derives duration; it is not repeated on the wire.

## 2. Outcome and field matrix

| `status` | Not connected | Connected | Meaning |
| -------- | ------------ | ------------ | ---- |
| `completed` | Allowed | Allowed | May end normally after acceptance, either before or after media connects |
| `failed` | Allowed | Allowed | Failure before or after connection |
| `cancelled` | Allowed | Forbidden | Caller cancels before connection |
| `declined` | Allowed | Forbidden | Callee declines |
| `missed` | Allowed | Forbidden | No-answer timeout |
| `unreachable` | Allowed | Forbidden | No remote lifecycle frame can be sent or accepted |

Every outcome MUST include `endedAt`. A connected outcome MUST also satisfy:

```text
endedAt >= startedAt
durationMs = endedAt - startedAt
```

The `durationMs` expression above is locally derived and is not a content field.

Application times are asserted by the publisher that generates the terminal record and do not participate in cross-server ordering.

## 3. Outer message constraints

- The thread MUST be P2P and contain exactly two distinct addresses: caller and callee.
- The outer message `author` is the caller; the other participant is the callee.
- Content MUST NOT repeat the caller, callee, or any local user ID.
- Content `callSid` MUST be the same `CanonicalUuid` as the real-time call operation.
- `assets` MUST be empty.

Real-time call operations map to terminal records as follows:

- `ended(completed)` → `completed`
- `ended(timeout|failed)` → `failed`
- `declined/cancelled/missed` → the identically named outcome
- A locally authoritative failure path with no usable remote lifecycle frame → `unreachable`

## 4. Complete connected example

```json
{
  "thread": {
    "type": "P2P",
    "participants": [
      { "account": "alice", "domain": "a.example" },
      { "account": "bob", "domain": "b.example" }
    ]
  },
  "author": { "account": "alice", "domain": "a.example" },
  "seq": 81,
  "originSeq": null,
  "originCreatedAt": null,
  "createdAt": 1770000061000,
  "contentType": "CALL",
  "content": "{\"callSid\":\"018f0f4e-7b2a-7c3d-8e9f-0123456789ab\",\"callType\":\"VIDEO\",\"status\":\"completed\",\"startedAt\":1770000000000,\"endedAt\":1770000060000}",
  "assets": []
}
```

## 5. Complete unconnected example

```json
{
  "thread": {
    "type": "P2P",
    "participants": [
      { "account": "alice", "domain": "a.example" },
      { "account": "bob", "domain": "b.example" }
    ]
  },
  "author": { "account": "alice", "domain": "a.example" },
  "seq": 82,
  "originSeq": null,
  "originCreatedAt": null,
  "createdAt": 1770000100000,
  "contentType": "CALL",
  "content": "{\"callSid\":\"018f0f4e-7b2a-7c3d-8e9f-1123456789ab\",\"callType\":\"AUDIO\",\"status\":\"declined\",\"endedAt\":1770000099000}",
  "assets": []
}
```

## 6. Required rejections

A consumer MUST reject at least the following cases:

- CALL is in a GROUP thread.
- `callSid`, `callType`, `status`, or `endedAt` is absent or invalid.
- `endedAt < startedAt`.
- Content carries the derived field `durationMs`.
- `cancelled`, `declined`, `missed`, or `unreachable` carries a connected-only field.
- Content carries caller, callee, a local ID, or an unknown field.
- The outer message `assets` is non-empty.
