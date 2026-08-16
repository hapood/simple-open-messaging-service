# SOMS Federation API Closure Audit

> SOMS protocol/implementation gap audit, verified on 2026-08-16. See the
> [S2S API reference](../api/federation-s2s-api.md) for endpoint summaries and
> [Federation v1](../../spec/v1/README.md) for normative requirements.

## Closed recovery loop

```text
first contact
  -> well-known discovery
  -> signed Recognize in both directions
  -> persist recognition facts and pin the root identity

restart or transient failure
  -> Healthy using the pinned certificate cache
  -> fresh Recognize only when recognition facts are missing
  -> state feed
  -> message and tombstone index feeds
  -> per-thread message and tombstone queries

local business transaction
  -> mutate a fact or snapshot and increment its business revision
  -> compact the per-peer state projection or thread end-sequence indexes
  -> commit
  -> send a lightweight feed-heads wake-up
```

The v1 surface, fields, errors, and recovery rules are part of the
[formal protocol](../../spec/v1/protocol.md). `CLOSED` means the current SOMS
implementation has a producer, consumer, recovery path, and regression evidence;
it does not imply that internal implementation work has ended.

## Surface audit

| Endpoint | Status | Closure evidence |
| --- | --- | --- |
| `/.well-known/socfp` | CLOSED | Publishes the root/signing identity and protocol version without capability forks. |
| `/s2s/v1/recognize` | CLOSED | Persists the directional fact, schedules reverse recognition, pins the root, initializes cursors, and converges bidirectionally. |
| `/s2s/v1/healthy` | CLOSED | Verifies through the pinned cache, returns a uniform privacy-preserving unavailable response, and recovers degraded peers. |
| `/s2s/v1/feed-heads` | CLOSED | Treats wake-ups as lossy, duplicate, and unordered; coordinates are max-coalesced and never persisted as facts. |
| `/s2s/v1/state-feed` | CLOSED | Uses consumer-owned cursors, projection omission, dependency repair, fixed drain bounds, and atomic page application. |
| `/s2s/v1/message-feed` | CLOSED | Serves a durable compacted `(peer, thread) -> messageEndSeq` index with bootstrap and reset handling. |
| `/s2s/v1/message-tombstone-feed` | CLOSED | Serves the independent durable `(peer, thread) -> tombstoneEndSeq` index. |
| `/s2s/v1/messages` | CLOSED | Queries thread message windows with live authorization, bounded drains, retry outcomes, and correctable body cursors. |
| `/s2s/v1/message-tombstones` | CLOSED | Queries permanent authoritative deletion facts and converges pending deletions. |
| `/s2s/v1/users/:account` | CLOSED | Supports bounded explicit first-contact profile lookup and is not used as a chat-open freshness probe. |
| `/s2s/v1/call` | CLOSED | Relays ephemeral signalling; terminal records use ordinary messages, while in-flight signalling is not crash-durable. |
| `/s2s/v1/media/:digest` | CLOSED | Enforces Range behavior, exact message/thread/source-sequence/digest ownership, resume, garbage collection, and tombstone revocation. |
| `/s2s/v1/forward-bundles/:bundleId` | CLOSED | Validates closure digest, depth, resources, and message visibility. |

Relationship and group membership changes travel through the state feed. Message
sends rely on locally converged state and do not synchronously query a remote node.

Unit tests compare normative field unions with code enums. The route-manifest,
PostgreSQL E2E, and two-node E2E suites cover the surface, transaction recovery,
and interoperable recovery loop respectively. JSON Schema, vectors, and the
offline conformance tool ship with v1 but are not prerequisites for endpoint
closure or runtime interoperability.
