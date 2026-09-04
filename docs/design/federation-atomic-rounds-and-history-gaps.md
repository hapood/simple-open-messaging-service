# Federation Atomic Rounds and Recoverable History Gaps

## 1. Scope

This document defines the local consumer design for authorization epochs,
durable message staging, atomic per-stream page commits, and recoverable
reverse-history gaps. It does not change the federation wire protocol. Wire
messages, message and tombstone cursors, State Feed items, and lazy exact-
message profile references retain their protocol meanings.

The design makes one bounded scheduler batch the atomic commit unit. A logical
round ends once every message inspected by that batch has a durable Message row
at its final timeline position and the matching synchronization progress is
committed. A Message may still be a STUB at that point; downloading and other
local content materialization are not synchronization-round dependencies.

## 2. Durable model

### 2.1 Thread authorization epoch

`MessageThread.authorizationEpoch` is the durable generation number of one
thread's continuous federation-authorization interval. Equal values mean that
work was admitted within the same uninterrupted interval. A greater value means
that effective authorization ended after the older work was admitted, even if
the relationship is active again now. This distinction closes the
active-inactive-active ABA race that a current authorization check alone cannot
detect.

The value is a non-negative integer initialized to zero. It belongs to
MessageThread rather than Group because both P2P and GROUP threads use the same
federation round machinery.

Every effective `active -> inactive` relationship transition increments the
epoch in the caller-owned relationship transaction. Repeated inactive writes do
not increment it. The transaction acquires the canonical USER_PAIR or GROUP
business lock first and then locks MessageThread before changing the epoch.

A State Feed target application or content round captures the current epoch.
Its commit transaction performs an atomic compare-and-set against MessageThread.
The compare-and-set is a no-op update conditioned on the captured epoch, so a
successful statement also holds the row lock until transaction commit. A
mismatch invalidates the complete operation. The result must not insert the
round's placeholders, apply tombstones or profiles, or advance thread
synchronization state.

`FederationThreadSyncState` also stores the authorization epoch for which its
current targets and committed progress were initialized. A process scheduler
must not run a state row whose epoch differs from MessageThread. A later valid
`THREAD_CONTENT_HEAD` reconciles the old segment and reinitializes that row for
the active thread epoch.

The process-local State Feed single-flight and the pull worker's peer-level
single-flight prevent concurrent drains for one peer. They do not replace the
authorization-epoch check: a relationship transaction can overlap the network
request even when only one State Feed drain exists.

### 2.2 Local message state

Message gains a local-only state:

```text
Message.localState = STUB | FAILED | READY
```

`READY` is the default for existing and locally authored messages. `STUB` means
that the row owns its final timeline position and immutable message identity
while local materialization is still in progress. `FAILED` means that local
materialization failed and may be retried. All three states are visible in
ordinary client history at their final timeline position. STUB and FAILED are
local placeholder projections rather than federation message types.

`contentType` always contains the real message type. A STUB is not a protocol
content type. `content` contains the normalized final metadata received from the
wire, including file names and content digests. It must not contain a fabricated
placeholder payload.

For an ordinary remote item, a STUB stores:

| Field                    | Value                                                       |
| ------------------------ | ----------------------------------------------------------- |
| `threadId`               | Resolved local thread                                       |
| `seq`                    | Final local timeline position                               |
| `contentType`            | Real wire content type                                      |
| `content`                | Final wire-to-local converted metadata                      |
| `creatorAccount/domain`  | Final author snapshot; the database may use `local` locally |
| `originSeq`              | Direct publisher's `item.seq`                               |
| `originServerTime`       | Wire `createdAt`                                            |
| `federationSourceDomain` | Authenticated direct publisher                              |
| `clientMessageId`        | Wire value when present                                     |
| `isDeleted`              | False unless a durable tombstone already proves deletion    |
| `localState`             | `STUB`                                                      |

Reverse staging preserves direct-publisher order but does not require publisher
and local coordinates to be equal. Each gap owns a fixed `messageSeqOffset`, and
items in that gap use `localSeq = sourceSeq + messageSeqOffset`. Forward staging
allocates local sequences in ascending response order. Every fetched message in
a logical round, not only media messages, is staged. Staging only media messages
would allocate their positions ahead of earlier in-memory non-media messages
and reorder the local timeline.

Creating a reverse gap locks MessageThread and reads its allocated local tail.
If the gap starts at `S`, ends at `E - 1`, and the locked local tail is `L`, the
transaction stores `messageSeqOffset = L + 1 - S` and reserves the local
allocator through `(E - 1) + messageSeqOffset`. Equivalently, the newest item
left to the forward path is allocated at
`forwardStartSeq = E - S + L + 1`. Local relationship system messages are
therefore never overwritten by a later reverse reconstruction.

A returned item with non-null `originSeq` whose reconstructed author domain is
the consumer's real domain is a processing receipt. It creates no STUB. The
consumer looks up `(threadId, Message.seq = item.originSeq)` and backfills that
row with `originSeq = item.seq` and
`federationSourceDomain = authenticatedPeerDomain`. A missing row is warned and
skipped.

Normal client history returns STUB, FAILED, and READY messages together with
their local state. Search, unread calculation, previews, federation publication,
forwarding, notifications, and SSE consume only READY messages. A STUB written
by the round's final transaction proves that its publisher coordinate was
committed and therefore advances synchronization progress. It does not prove
that the message content is locally usable.

### 2.3 Download jobs

PendingMedia continues to serve both existing outbound upload staging and
inbound federation downloads. Outbound behavior is unchanged: an OUTBOUND row
exists before its Message and therefore has no `messageId`. An INBOUND row
references its staged `messageId`; the Message owns the authoritative identity,
content type, author, content, and final sequence. FileSyncProgress remains the
per-file transfer state.

A tombstone that is already available for a staged media item makes the Message
deleted and cancels unnecessary downloads. Otherwise PendingMedia and
FileSyncProgress continue independently after the synchronization round commits.
Download completion changes that Message from STUB to READY in its own
transaction and publishes the READY-only local projections. A terminal download
failure changes STUB to FAILED. Neither outcome moves federation synchronization
progress or wakes a content round.

## 3. Recoverable reverse-history gaps

`FederationThreadHistoryGap` records an inclusive publisher-sequence interval
that has not completed its local logical commit. Its coordinates do not depend
on Message rows already existing. A thread has only one reverse authority in
the current topology, so `threadId` identifies the source context and the table
does not repeat `peerDomain`.

The row contains:

```text
id
threadId
startSeq
endSeq
messageSeqOffset
recoverable
createdAt
updatedAt
```

`startSeq` and `endSeq` are inclusive publisher coordinates and satisfy
`1 <= startSeq <= endSeq`. `messageSeqOffset` is non-negative and immutable for
the lifetime of the gap. A reverse request for the interval uses:

```text
before = endSeq + 1
through = startSeq
```

Committed STUB, FAILED, and READY rows may already exist inside an interval
after an interrupted scheduler process. They do not define or infer its bounds.
Each successful reverse batch atomically shrinks the durable interval by the
coordinates it inspected. The row is removed after its remaining interval is
empty, or retained with `recoverable=false` after the publisher proves it
unavailable.

An effective inactive transition only increments
MessageThread.authorizationEpoch inside the canonical relationship transaction.
It does not depend on scheduler memory and does not construct a gap.

A later valid THREAD_CONTENT_HEAD compares MessageThread.authorizationEpoch
with the epoch retained by FederationThreadSyncState. For an origin capable of
reverse history, the newest advertised message always remains forward work. If
`C` is the old committed forward coordinate and `E` is the new advertised tail,
the new reverse interval is `[C + 1, E - 1]`. An empty interval creates no gap.
Recoverable gaps that overlap or touch this interval are merged only when they
share the same local-sequence offset. Different epoch mappings remain separate;
overlap with different mappings is an invariant violation. A committed forward
island between intervals also keeps them separate. No Message row or in-memory
reverse page cursor participates in this derivation.

This is sound because each forward stream advances its own processed-through
value only in the transaction that applies that stream's page, and each such
transaction compare-and-sets MessageThread.authorizationEpoch. A failed or
partially fetched page cannot move its committed endpoint.

## 4. State Feed application and initialization

State Feed transport remains paginated. A consumer fixes one `through` target
for the complete synchronization round, both for an ordinary delta drain and a
cursor-unavailable full rebuild. Application is item-by-item in strictly
increasing feedId order. Each item and its inclusive processing cursor are
committed in one database transaction. After all returned items are committed,
a cursor-only transaction may advance across compacted or trailing holes to the
page's `scannedThrough`. The next request passes that inclusive cursor as
`after`; it does not derive the request cursor by adding one.

Item and page transactions write durable facts, local compacted projections,
and recovery progress but emit no side effect from inside the transaction.
After each item commits together with its processing cursor, the consumer hands
that item's wakes and client revision hints to the process-wide schedulers. The
client notifier coalesces the greatest committed revision for one second per
local account feed and retains a non-durable, process-lifetime monotonic high
watermark for each feed; different feeds never share that timer or high
watermark. The design does not block unsolicited reads of facts committed by an
incomplete round.

`GROUP_META_FEED_HEAD` supplies a fixed Group Meta sub-round target. The
consumer runs its HTTP and bounded member-page work outside the State Feed item
transaction. The item transaction durably creates or merges that work, advances
its own cursor, and may continue consuming later items immediately. Group Meta
pages emit no client notification. The task's final transaction advances the
mirror `feedEndId`, applies completed local projections, and writes compacted
client heads; only after that commit are their hints published.

RELATIONSHIP_INTENT application invokes the canonical relationship transaction
and advances the item cursor only when that transaction succeeds.

THREAD_CONTENT_HEAD application resolves the local thread, verifies that its
relationship is active, and locks MessageThread. The same transaction loads
FederationThreadSyncState and branches on its stored epoch:

- a missing row leaves the newest advertised message to the forward query and,
  when at least one older coordinate exists, creates `[1, messageTargetSeq - 1]`
  as its initial active gap, while initializing deletion processed-through to
  the advertised deletion target without issuing a tombstone query;
- a matching epoch only merges the monotonic forward targets;
- a mismatching epoch creates or merges `[oldCommitted + 1, newTail - 1]`,
  stores its mapping from publisher coordinates into the locked local timeline,
  selects the newest recoverable gap as `activeGapId`, leaves `newTail` to the
  forward query, and reinitializes the state for the locked thread epoch. When
  new deletion work exists, it also freezes the old committed message
  coordinate and the new deletion target as the recovery tombstone drain.

The transaction then advances the State Feed cursor through the current item.

The synchronization-state key remains `(threadId, peerDomain)`. A missing row is
created idempotently. Each item commit marks durable dirty work and its
after-commit handler is the scheduler-notification boundary.

If the relationship is no longer active when the thread row is locked, the item
is stale. The transaction writes no thread synchronization state or gap
selection, still advances the State Feed cursor through that item, and emits no
thread notification. A transient database or network failure does not advance
the item cursor.

For a missing synchronization row with advertised tail `E`:

- `E=0` creates no message work;
- `E=1` creates only forward `(0, 1]` work;
- `E>1` creates forward `(E-1, E]` work and reverse `[1, E-1]` work.

For a retained row whose epoch is older than MessageThread, the head starts a
new authorization segment:

- forward message work starts at the newly advertised tail only;
- forward tombstone recovery starts after the prior durably committed deletion
  cursor and filters target message coordinates above the old committed message
  coordinate for the complete frozen recovery drain;
- skipped older coordinates become an inclusive durable gap;
- adjacent unfinished gaps merge only when their local-sequence offsets match,
  while different mappings and READY forward islands keep gaps separate;
- the synchronization row adopts the current thread epoch.

Targets received while a round is active remain monotonic dirty work and do not
enlarge that round's frozen bounds.

FederationThreadSyncState does not persist a reverse page cursor. The scheduler
keeps the current page's exact `before` value in memory. On restart it loads
`activeGapId`, reconstructs `before=endSeq+1` and `through=startSeq`, and replays
idempotently from that durable upper bound using the selected gap's fixed
`messageSeqOffset`. Switching `activeGapId` therefore switches the mapping
without a second synchronization-state field. It never infers a network cursor
from Message or STUB rows.

## 5. Logical rounds and scheduler quanta

The scheduler's `take=50` is both a fairness bound and the maximum input batch
for one logical round. Forward message, forward tombstone, and reverse work use
independent queues and single-flights. A later page is a new round. Targets
published while one round is running are coalesced for a later round in that
same stream.

The in-memory context contains at least:

```text
threadId and direction
authorizationEpoch
frozen message target, tombstone target and message cutoff, or reverse boundaries
fetched message, tombstone, or departed-profile facts
dirty flag
```

Losing the context on restart is safe. FederationThreadSyncState has not moved,
the active gap boundaries remain durable, and no uncommitted in-memory fact is
treated as copied. A committed STUB has already advanced the same transaction's
durable progress and is idempotent if a response is replayed.

### 5.1 Forward commit condition

A forward message or tombstone round becomes committable when its one bounded
request has completed and the thread authorization epoch still matches. Each
final transaction compare-and-sets MessageThread against the round's captured
epoch, applies that stream's buffered facts, and advances only that stream's
processed-through cursor. Messages are inserted at least as STUBs; content
which is already complete may be READY in the same transaction. Pending content
remains STUB and is completed independently.

Ordinary tombstone rounds carry no message cutoff. The recovery drain after an
epoch change uses the persisted `deletionRecoveryMaxMessageSeq` and
`deletionRecoveryThroughSeq` for every bounded `take=50` page. Each page may
advance the deletion cursor in its own transaction, but every following page
continues to send the same filter until the committed cursor reaches the frozen
recovery target. A newer head received during that drain is dirty work for a
later unfiltered round and does not alter either recovery boundary. The
transaction that reaches the persisted recovery target clears both fields; a
partial page or failed transaction clears neither.

### 5.2 Reverse commit condition

A reverse logical round becomes committable when:

- one bounded reverse message batch has completed;
- the thread authorization epoch still matches.

The final transaction first atomically compare-and-sets MessageThread against
the round's captured epoch. It then inserts the fetched messages at least as
STUBs, applies the profiles and tombstones, and shrinks the active gap through
the response's `scannedThrough` boundary. If the current interval closes, the
same transaction removes that completed gap and selects the next recoverable
gap. It derives `before=endSeq+1` and `through=startSeq` directly from the next
gap and stores the selected row as `activeGapId`.
`historyBoundaryReached` becomes true only when the current segment is closed and
no recoverable gap remains.

Reverse history insertion does not publish a client `THREAD_CONTENT_HEAD` and does not
emit SSE: it fills older coordinates rather than advancing the conversation
tail. Ordinary client history reads the newly committed STUB rows directly.
Forward STUB insertion does publish the compacted client content head in its
commit transaction, but federation materialization still emits no SSE.

## 6. Failures

### 6.1 Authorization failure

An authorization failure is reconciled under the epoch captured before the
denied request. The failure handler locks the canonical USER_PAIR or GROUP
business scope and MessageThread and then compares the captured epoch:

- a changed epoch means another relationship transaction already invalidated
  the round, so no second revoke is written;
- an unchanged active P2P pair enters the normal command that revokes only the
  locally authored user direction;
- for an unchanged remotely owned GROUP, the normal commands revoke every
  active local member-to-group direction;
- for an unchanged locally owned GROUP, the normal commands revoke every active
  group-to-member direction for members hosted by the denied peer.

Matching-epoch handling stops continuation and retry for every direction of the
affected thread-source key and prioritizes State Feed convergence. A stale
denial writes nothing and reschedules from the current durable state. Neither
case writes a peer-authored direction.

No buffered fact or synchronization cursor from the failed round commits.

### 6.2 Reverse cursor unavailable

When the publisher can no longer serve a reverse interval, the corresponding
gap remains durable with `recoverable=false`. The scheduler then selects the next
recoverable gap. An unrecoverable gap is retained for local history diagnostics
but does not prevent `historyBoundaryReached=true` after all recoverable work is
closed.

## 7. Lock order

Relationship commands retain the established order:

1. canonical USER_PAIR or GROUP advisory lock;
2. relationship/group rows;
3. MessageThread row;
4. synchronization state, gap, Message, and projection rows.

Content-round commits do not acquire a relationship business scope after
locking MessageThread. They lock MessageThread first, compare the captured epoch,
and write only thread-local synchronization facts. This avoids reversing the
relationship-command lock order. A relationship transaction that commits first
causes an epoch mismatch; a round transaction that commits first was authorized
for its complete database commit and the following relationship transaction
then increments the epoch.

## 8. Client placeholder projection

Ordinary client history exposes STUB and FAILED rows at their final local
sequence positions. STUB represents in-progress local materialization; FAILED
represents a retryable failure. Other client and federation projections continue
to require READY. This local projection does not alter the federation message
representation.
