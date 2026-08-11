# Bounded in-memory message feed

The S2S message feed uses a bounded process-local delivery index. The old `DiscoveryChange` and
`DiscoveryTarget` tables are removed completely. Local clients already recover from thread revisions and
per-thread message seq, while federation keeps its allocation HWM directly on `FederationServeCursor`.
The cut-over persists `HISTORY_TRUNCATED` as an explicit service-degradation marker.

## Durable recovery state

`FederationAudienceEpoch` records immutable `(peer, thread, fromSeq, throughSeq)` access intervals.
`FederationThreadCheckpoint` records the greatest acknowledged message seq for each epoch. The current
`ThreadAudience` row remains the authorization source; database triggers open and close recovery epochs
at the transactionally allocated `MessageThread.curSeq` boundary.

Loaded but unacknowledged message references live in `Map<peerDomain, FederationChangeBuffer>`. A crash
discards them. On restart the fulfiller scans every epoch after its durable checkpoint and assigns new,
monotonically increasing change IDs. The receiver already deduplicates the replay by stable message
identity, so this is an at-least-once feed.

## Capacity and acknowledgement

Each peer buffer contains at most 10,000 references and is split into 512-entry chunks. Reaching the
limit freezes allocation for that peer; it never evicts unacknowledged entries. The message write still
commits to PostgreSQL and remains recoverable from its audience epoch. A later `after=N` request writes
the covered per-epoch checkpoints in the source cursor transaction, retires the acknowledged chunk
prefix, and refills only the released capacity.

The active post-commit path and a PostgreSQL commit notification immediately offer a new thread seq. A
singleton fulfiller performs one finite startup rebuild with a deduplicated pending set and at most four
concurrent peers. Runtime work is event-driven: `FULL` and `CAUGHT_UP` peers are not polled or requeued;
an ACK, a committed message, a feed request, or process startup is the next trigger. All paths share the
same per-peer mutex and stable message-key set.

The state sentinel has four values: `NEEDS_FILL`, `FILLING`, `FULL`, and `CAUGHT_UP`. Only
`NEEDS_FILL` is eligible for scheduler admission. A failed fill returns to `NEEDS_FILL`, but is not put
into a recursive retry loop; the next external event or startup rebuild retries it.

## Deployment ownership

The global change-ID order cannot be independently constructed by two API processes. The memory-feed
service therefore holds a session advisory owner lock scoped to the PostgreSQL database for its complete
lifetime. A second API process using the same database fails startup instead of serving an inconsistent
feed. Multi-instance federation requires a future peer-owner routing/forwarding layer; ordinary Nest
provider singleton scope is not sufficient.
