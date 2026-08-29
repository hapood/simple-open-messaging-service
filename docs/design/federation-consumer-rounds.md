# Federation Consumer Rounds

## 1. Purpose

This document describes the local implementation of bounded federation content
rounds. Wire-level query semantics remain in the protocol specification. The
local design has three independent concerns:

- State Feed application discovers durable per-thread targets.
- Forward and reverse content rounds commit ordered message facts.
- Content materialization changes committed placeholders to READY or FAILED.

A synchronization round never waits for media bytes or quote materialization.
Committing a Message STUB at its final local sequence is sufficient to commit
that publisher coordinate.

## 2. Durable state

`FederationThreadSyncState` is keyed by `(threadId, peerDomain)` and stores:

- the authorization epoch captured from MessageThread;
- monotonic message and deletion targets discovered through State Feed;
- the forward message and deletion coordinates already committed;
- the active recoverable history-gap id;
- whether no recoverable reverse gap remains.

`FederationThreadHistoryGap` stores an inclusive pending publisher interval
`[startSeq, endSeq]`. The boundaries are coordinates, not foreign keys to
Message rows. A request for the active interval uses:

```text
before = endSeq + 1
through = startSeq
```

No reverse network cursor is persisted separately. A restart derives the next
request only from the active gap. Message, STUB, PendingMedia, or downloaded
asset rows must not be used to infer reverse coverage.

## 3. State Feed application

One peer has at most one State Feed request-and-application flight. Items are
applied individually in increasing feed-id order. Applying one item and
advancing the durable State Feed cursor occur in the same transaction.

A `THREAD_CONTENT_HEAD` transaction locks MessageThread, checks that its
relationship is active, and reconciles `FederationThreadSyncState` against the
thread authorization epoch. The newest advertised message remains forward
work. Older skipped coordinates become a reverse gap.

For the first advertised message tail `E`:

- `E=0`: no message work;
- `E=1`: forward interval `(0,1]`, no reverse gap;
- `E>1`: forward interval `(E-1,E]` and reverse gap `[1,E-1]`.

When a reverse gap is created, the same transaction reserves the local message
sequence allocator through the gap's upper boundary. The newest advertised
message can then be applied by the ordinary forward path at the next local
sequence, while reverse insertion retains the publisher sequence positions
inside the reserved interval.

On an epoch change, let `C` be the old committed forward message coordinate and
`E` the new advertised tail. The skipped interval is `[C+1,E-1]`. Empty
intervals are ignored. Overlapping or adjacent recoverable gaps are merged.
A committed forward island keeps two gaps separate.

The committed State Feed transaction emits a scheduler wake. A wake is only a
hint; durable state remains authoritative.

## 4. Forward rounds

Forward messages and tombstones have independent scheduler queues,
single-flights, concurrency limits, retries, and fairness quanta. A committed
`THREAD_CONTENT_HEAD` starts both streams together by pairing its `feedId`,
`messageEndSeq`, and `tombstoneEndSeq`. After that start, the two streams run
concurrently and commit independently.

The tombstone query freezes `maxMessageSeq` when its bounded drain starts. On
the first head after an authorization-epoch change, the cutoff is the message
coordinate committed before that epoch change. For an ordinary head, it is the
paired `messageEndSeq`. A newer head received while a tombstone page is active
is retained in scheduler memory for the next round and does not enlarge the
active `through` or `maxMessageSeq`. Losing the epoch-transition cutoff on a
process restart is an accepted optimization loss: reconciliation uses the
latest head and may fetch additional harmless tombstone facts.

Each stream's final transaction compare-and-sets the MessageThread
authorization epoch, validates its response authority token, applies its page,
and advances only that stream's processed-through coordinate. Message pages
insert their messages at the final local sequence as READY when already
materialized or STUB when dependencies remain. Tombstone pages apply deletions,
including deletions targeting an existing STUB. Cursor-unavailable recovery
advances only the affected stream.

Forward insertion advances the compacted local `ClientMessageFeed`, including
for a committed STUB. It does not emit SSE. A target published while the round
is active remains dirty work for a later round.

## 5. Reverse rounds

One reverse round reads the current active gap and requests at most `take`
coordinates from its upper end. Group history concurrently requests the
departed-member profiles needed for exactly the scanned message interval.

A reverse round never queries `/message-tombstones`; that operation is
forward-only. Before completing a reverse message window, the consumer should
apply currently discovered forward tombstone work. The final transaction
therefore applies only authoritative tombstones already obtained and persisted
by the forward tombstone drain that match messages in this reverse batch. A
later deletion remains forward work discovered through a later
`THREAD_CONTENT_HEAD` and does not enlarge or rewind the active reverse round.

The message page and profile facts remain in process memory until both requests
finish. The final transaction:

1. compare-and-sets MessageThread authorization epoch;
2. locks and revalidates the active gap;
3. inserts the fetched historical messages at `Message.seq = publisher seq`;
4. applies matching previously discovered tombstones and departed-member
   profiles;
5. shrinks the active gap using the response `scannedThrough` boundary.

An invalid reverse item or a local sequence collision aborts the complete
batch. Item-level isolation used by ordinary forward recovery must not permit a
reverse gap to shrink past a message that failed to stage.

For an active gap `[S,E]`, the request uses `before=E+1`. If the response scans
through `L` and `L>S`, the committed remainder becomes `[S,L-1]`. If `L=S`, the
gap is complete and is deleted after the synchronization state switches to the
next recoverable gap. This subtraction belongs to the inclusive gap model; the
wire `before` cursor itself is never manually decremented.

Every reverse batch is a complete logical round and scheduler fairness unit.
There is no process-local continuation across batches. A restart simply reads
the shrunken durable gap.

Reverse insertion does not update `ClientMessageFeed` and does not emit SSE.
It fills older history rather than announcing a new conversation tail. Client
history queries read committed STUB, FAILED, and READY rows directly.

If the source reports that the active reverse interval is no longer available,
the gap is retained with `recoverable=false`. It is not treated as copied. The
scheduler selects the next recoverable gap, if any.

## 6. STUB materialization

An inbound media or unresolved-quote STUB owns its final Message identity and
sequence. PendingMedia references that Message and FileSyncProgress tracks its
downloads. These rows do not belong to scheduler progress calculations.

After every required file succeeds, an independent transaction:

- locks the stable federated message identity;
- rechecks the inbound job and authorization epoch;
- writes localized content and MessageAsset rows;
- changes STUB to READY;
- deletes the completed PendingMedia and FileSyncProgress rows.

A terminal failure changes STUB to FAILED and removes the spent job. An
administrator can create a new inbound job from the FAILED Message for retry.
Neither transition changes federation synchronization cursors or wakes a
content round.

An authoritative tombstone targeting an existing STUB immediately creates the
formal `DeletedMessage`, sets `Message.isDeleted`, and cancels its inbound
download job. `FederatedMessageTombstone` is needed only while the corresponding
Message row does not exist. Message insertion consumes that temporary fact.

## 7. Scheduler

The scheduler is a process-wide singleton. It keeps separate peer-oriented
message-forward, tombstone-forward, and reverse queues with independent
concurrency limits. All three may run concurrently for one thread, while each
queue permits at most one active round for that `(thread, peer)` key.

After one batch commits, the thread yields to peer round-robin fairness. It is
requeued only when durable state still contains forward targets or a recoverable
reverse gap. PendingMedia never suppresses or creates scheduler work.

On restart the scheduler reads every `FederationThreadSyncState`, revalidates
that its relationship still provides an active source, enqueues unfinished
forward and reverse work, drains every trusted peer's State Feed, and schedules
a coalesced lightweight state push. Transport connection and request limits
remain delegated to the federation HTTP scheduler.

Network failures, HTTP server failures, and the protocol's explicit deferred
query results are retried from durable state. A valid `retryAfter` is honored as
a minimum delay. Permanent protocol or business failures stop the affected
task instead of entering an unbounded retry loop.

An authenticated `FORBIDDEN` stops all three directions for the thread-source
key and prioritizes a State Feed drain. For P2P, the scheduler passes the epoch
captured before the denied request into the ordinary relationship command: an
unchanged active pair revokes only the locally authored direction, while a
changed epoch makes the response stale. A GROUP denial authors no relationship
transition because it does not identify one member direction. A later committed
thread-head wake may enable the key again.

## 8. Publication invariants

- State Feed targets never regress.
- A synchronization coordinate advances only in the transaction that inserts
  or validates its durable local fact.
- Forward message and tombstone pages commit independently with their own
  processed-through coordinates.
- A reverse gap shrinks only in the transaction that inserts the corresponding
  historical batch and applies its departed profiles.
- STUB, READY, and FAILED are visible client history states; only READY is used
  by search, unread, preview, forwarding, and federation publication.
- Federation inbound processing and materialization do not emit SSE. Only the
  existing local client-send completion path emits a new-message SSE event.

## 9. Source map

- State reconciliation and gap commits:
  [`src/federation/federation-thread-sync-state.service.ts`](../../src/federation/federation-thread-sync-state.service.ts)
- Forward round orchestration:
  [`src/federation/federation-thread-forward-round.service.ts`](../../src/federation/federation-thread-forward-round.service.ts)
- Reverse round orchestration:
  [`src/federation/federation-thread-reverse-round.service.ts`](../../src/federation/federation-thread-reverse-round.service.ts)
- Process scheduler:
  [`src/federation/federation-thread-round-scheduler.service.ts`](../../src/federation/federation-thread-round-scheduler.service.ts)
- Inbound STUB materialization:
  [`src/federation/federation-pending-media-promoter.ts`](../../src/federation/federation-pending-media-promoter.ts)
