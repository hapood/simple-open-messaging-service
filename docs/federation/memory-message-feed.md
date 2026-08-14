# Bounded in-memory message feed

> Superseded design note. Federation v1 now specifies a durable compacted `(peer, thread)` index without
> source-side ACK/cursor validation. This document describes the pre-query implementation and must not be
> used as the target contract; see [Message Feed and Query](./spec/v1/message-feed.md).

The S2S message feed uses a bounded process-local delivery index. The old `DiscoveryChange` and
`DiscoveryTarget` tables are removed completely. Local clients already recover from thread revisions and
per-thread message seq, while federation keeps its allocation upper bound directly on `FederationServeCursor.allocatedThrough`.
The cut-over persists `HISTORY_TRUNCATED` as an explicit service-degradation marker.

## Durable recovery state

The current `ThreadAudience` row is both the authorization source and the durable scan position. Opening
an audience stores the thread's committed `curSeq`; closing it first drains every message through the
committed `curSeq`, then stores the inclusive peer feed-ID boundary. Reopening resets that same row at the
new committed end. No historical audience generation is retained.

Loaded message references live in `Map<peerDomain, FederationChangeBuffer>`. Before a reference becomes
visible, its `(peer, feedId, message)` allocation is committed to PostgreSQL together with the
allocator advance. A crash discards only the memory index; restart reloads every unacknowledged allocation
with the same `feedId`, then continues filling after the audience's durable scan position. The feed remains
at-least-once, but retry identity is stable across restart.

## Capacity and acknowledgement

Each peer buffer contains at most 10,000 references and is split into 512-entry chunks. Reaching the
limit freezes allocation for that peer; it never evicts unacknowledged entries. The message write still
commits to PostgreSQL and remains recoverable from the durable audience scan position. A later `after=N`
request retires the covered memory prefix after the source cursor transaction commits and refills only
the released capacity. A compact `(peer, message)` delivery ledger remains as the exact proof for future
tombstone authorization; it can be reclaimed with the corresponding Message by later GC.

The active post-commit path and a PostgreSQL commit notification immediately offer a new thread seq. A
singleton fulfiller uses a deduplicated FIFO peer queue with at most four concurrent peers. One peer turn
may scan at most 500 units of message and tombstone work combined; unfinished peers return to the queue
tail, and message/tombstone priority alternates between turns. Audience scanning also remembers the next
audience so one busy thread cannot consume every turn. Runtime work remains event-driven: `FULL` peers wait
for ACK capacity and `CAUGHT_UP` peers wait for a committed message, deletion, feed request, or process
startup. All paths share the same per-peer mutex and stable message-key set.

The state sentinel has four values: `NEEDS_FILL`, `FILLING`, `FULL`, and `CAUGHT_UP`. Only
`NEEDS_FILL` is eligible for scheduler admission. Consuming a complete quantum while durable work remains
returns to `NEEDS_FILL` and is immediately requeued behind existing peers. A failed fill also returns to
`NEEDS_FILL`, but is not immediately requeued; the next external event or startup rebuild retries it.

## Deployment ownership

The per-peer feed-ID order and its process-local indexes cannot be independently served by two API processes. The memory-feed
service therefore holds a session advisory owner lock scoped to the PostgreSQL database for its complete
lifetime. A second API process using the same database fails startup instead of serving an inconsistent
feed. Multi-instance federation requires a future peer-owner routing/forwarding layer; ordinary Nest
provider singleton scope is not sufficient.
