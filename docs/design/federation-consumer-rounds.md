# Federation Consumer Rounds

Status: implementation design for the local federation consumer. Protocol requirements
remain defined by the normative documents under [`spec/v1`](../../spec/v1/).

## 1. Purpose and boundaries

The consumer coordinates two kinds of work:

- A forward content round incorporates frozen per-thread message and deletion
  targets discovered together by the State Feed consumer.
- A reverse reconstruction round builds an older message window on demand and
  advances its reconstruction cursor only after its dependent facts are ready.

A round is local scheduling state, not a federation resource or source-side
session. Its current targets may remain in memory. Durable feed cursors, thread
coverage, messages, pending inbound messages, tombstones, and profile facts are
the recovery truth. A process restart may abandon an incomplete in-memory round
and derive a new target from those facts.

The design does not add a persistent work-item queue. A scheduler derives work
from durable boundaries and uses coalesced in-memory wake-ups. Notifications are
hints; every continuation decision is rechecked against the database.

The implementation keeps these responsibilities separate. The reverse round
service owns only boundary decisions. Its executor resolves the source, performs
signed resource reads, checks pending frontiers, and commits the reverse CAS.
Departed-member profile validation and persistence live in a dedicated consumer.
The general federation service exposes only narrow signed thread-resource and
historical-message storage adapters to this path; it does not own reverse page
loops or scheduling.

`Group.federationAuthorized` is a local projection used only for a remote
group. It is true exactly when at least one active `GROUP_MEMBER` relationship
connects that group to a local user. Local groups always store false. The
relationship transaction serializes changes on the Group row, updates
`RelationshipPair.active`, and then rebuilds this projection before commit; an
intent observation by itself never changes the value.

## 2. Coordinates

The consumer keeps protocol coordinates distinct from local query coordinates.
Durable synchronization state is keyed by `(localThreadId, peerDomain)`, because
one local group thread may simultaneously consume the group origin's coordinate
space and submission/receipt coordinate spaces published by member servers.
For one such publisher coordinate space, the state is:

| Field                         | Meaning                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| `messageTargetSeq`            | Greatest message target merged from committed thread-content items.  |
| `deletionTargetSeq`           | Greatest deletion target merged from committed thread-content items. |
| `messageProcessedThroughSeq`  | Greatest source message seq durably scanned by forward queries.      |
| `deletionProcessedThroughSeq` | Greatest source deletion seq durably scanned by forward queries.     |
| `reverseNextBeforeSeq`        | Exclusive `before` cursor for the next reverse message query.        |
| `reverseClosureOriginSeq`     | Existing source message coordinate whose rescan closes history.      |
| `historyBoundaryReached`      | Whether the selected reverse history boundary has been reached.      |

Names may change when the schema is implemented, but their coordinate meanings
must not be combined. In particular, `reverseNextBeforeSeq` is the wire-level
`before` cursor; the two processed-through fields remain inclusive forward
watermarks copied from successful responses.

The State Feed consumer resolves each wire Thread Address to a local `threadId`
and merges both targets into the row for `(threadId, sourcePeerDomain)` in the
same transaction that commits the State Feed cursor. Targets are monotonic. A
process restart therefore rebuilds work from these rows rather than from an
in-memory queue. P2P and remote-origin group rows initialize forward and reverse
work. A local-origin group row for a member server initializes forward work
only, because that server is a submission/receipt source rather than the
authority for older group history.

After the first `THREAD_CONTENT_HEAD` advertises `messageEndSeq=E`, reverse-tail
initialization is:

```text
messageTargetSeq = E
messageProcessedThroughSeq = E
deletionTargetSeq = tombstoneEndSeq
reverseNextBeforeSeq = E + 1
reverseClosureOriginSeq = max(existing Message.originSeq <= E), or null
historyBoundaryReached = false
```

Later thread-content items merge both targets without moving an active or
completed reverse boundary. A thread-content item always carries a positive
message target; a tombstone cannot create synchronization state independently.
Forward query completion is represented by the two processed-through fields,
not by overwriting either target. Each successful page applies its facts and
advances its processed-through coordinate in one transaction.

The closure target is selected only when reverse state is first initialized. It
is the greatest existing durable Message `originSeq` strictly below the initial
`before` cursor. It identifies the newest coordinate in an older history segment
that must be reached to join the new reverse window to that segment. PendingMedia
does not establish this initial target. Later thread-content observations do not
replace it.

Initialization converts the inclusive advertised message bound into the
exclusive cursor expected by the query API exactly once. The first reverse
request then reads the stored value directly:

```text
B = reverseNextBeforeSeq
before = B
```

Therefore the initial value is `E+1`. Later rounds never add or subtract one:
they persist the preceding response's `scannedThrough` as the next exclusive
cursor.

If the response reports `scannedThrough=L`, the actual scanned interval is
`[L, B)`, including holes and tombstoned coordinates. The next stored cursor is
`L`, so the next wire request uses `before=L` without cursor arithmetic.
The response boundary, rather than the last returned message, is authoritative:
an empty page can still advance `scannedThrough`.

The reverse reconstruction storage path deliberately preserves
`Message.seq=originSeq` for newly inserted historical messages, after validating
that each coordinate is positive and strictly below the round's frozen
`beforeSeq`. An inbound PendingMedia row retains that target in `originSeq` and
uses it as `Message.seq` when promoted. A pre-existing row at the same local seq
is idempotent only when it represents the same federated message identity;
otherwise the round fails with a coordinate conflict. Other message paths and
older local data are not assumed to share coordinates, which is why the
persisted closure target is expressed explicitly in source `originSeq`.

The page validator applies the frozen interval before any message side effect:
every publisher `seq` is positive, less than `reverseNextBeforeSeq`, and, when a
closure target exists, greater than or equal to `reverseClosureOriginSeq`.
Self-authored items are the intentional exception to local seq preservation: the
existing local Message keeps its receiver-local `seq`, while the publisher
coordinate is backfilled into `originSeq` and `federationSourceDomain`. A retry
with the same coordinate is idempotent; a different coordinate conflicts. The
per-peer receipt remains available for additional peer-to-message mappings.

### 2.1 Source-side thread-content projection

The implementation stores message and deletion discovery as one compacted
State Feed projection per peer and wire Thread Address. Its body contains the
current `messageEndSeq` and `tombstoneEndSeq`. A message commit merges the new
message end while retaining the deletion end; a deletion commit merges the new
deletion end while retaining the message end. Either change allocates one new
State Feed position for the same projection key.

The State Feed allocator is the serialization point for dependency order. The
publisher writes relationship, profile, and Group Meta projections before the
dependent thread-content projection in the same business transaction. When a
compacted dependency is reallocated later, the implementation force-reindexes
each dependent thread-content projection after it. This preserves protocol
ordering for a fresh consumer even though State Feed retains only the newest
item for each projection.

Opening an audience does not create a thread-content projection until a message
is queryable. Closing an audience removes its current projection without a
terminal thread item. The per-peer State Feed high-water mark remains monotonic.
Lightweight push therefore reads only that high-water mark and sends only
`stateFeedEndId`.

## 3. Forward reconciliation

A forward content round is keyed by `(localThreadId, peerDomain)`. It reads and
freezes the current `messageTargetSeq` and `deletionTargetSeq` once. A later State Feed commit
schedules a subsequent round and does not enlarge the active round. The
single-flight marker and frozen targets remain process-local; durable targets,
processed-through coordinates, messages, pending messages, and tombstones are
the restart truth.

State Feed and Group Meta have independent consumers. Their source-scoped
profile upserts use identity uniqueness and `profileRev`, so different threads
may converge profiles concurrently. A forward group message should normally
wait for current Group Meta, but a missing projection is a display-quality
condition rather than a content-validity barrier: the client may temporarily
show the stable author Address with a placeholder and must replace it when the
profile arrives.

The per-thread content shape is:

```text
bounded messages ─────────────────┐
                                  ├─ complete round and emit its SSE effects
bounded tombstones(maxMessageSeq) ┘
```

The two bounded drains may execute concurrently. `maxMessageSeq` is frozen at
the message boundary selected for the round. Completion waits for both drains;
the reverse-only departed-member profile query is not part of forward
processing. A round may run only the tombstone branch when its message target is
already processed; it still shares the forward single-flight for that
`(threadId, peerDomain)`. Message and tombstone facts retain
their existing transactional application behavior, so a message may be
queryable before the other branch finishes and a later tombstone may delete an
already queryable message. The round delays its collected SSE effects until
both branches complete; it does not add another Message visibility projection.

An inbound message whose media or quoted dependency is unresolved remains a
durable pending message. A forward round does not complete or permit the next
forward round while a pending message in its frozen thread interval remains
unresolved. It becomes ready only when every such pending message is promoted
successfully or terminated by an authoritative tombstone. A timeout, ordinary
download failure, quota pause, duplicate wake-up, or process restart does not
bypass the barrier.

## 4. Reverse reconstruction

A reverse round is scheduled when synchronization state is first initialized.
It keeps yielding after one bounded batch and is rescheduled until the durable
history boundary is reached. It does not persist a separate target for the
oldest coordinate of its current batch. It begins with messages because their
response determines that coordinate. With `take` supplied by the scheduler:

```text
beforeSeq = reverseNextBeforeSeq
GET /messages?before=beforeSeq&take=take
batchOldestSeq = response.scannedThrough
actual batch window = [batchOldestSeq, beforeSeq)
```

When `reverseClosureOriginSeq` is present, the message request also uses
`through=reverseClosureOriginSeq`. The target is inclusive. Reaching
`scannedThrough <= reverseClosureOriginSeq` closes reconstruction even if the
target message body is absent because a tombstone became effective. Completion
then clears `reverseClosureOriginSeq` and records
`historyBoundaryReached=true` in the same transaction as the final cursor
commit.

Immediately after freezing `beforeSeq`, the consumer checks whether an inbound
pending message occupies the current publication frontier. If so, it exits the
round before local batch derivation or any federation request. Promotion or
authoritative tombstone termination emits a thread wake-up, and the scheduler
starts a new reverse round rather than retaining a waiting task.

Messages and inbound pending messages are stored immediately. A stored Message
is queryable from the ordinary local message table even while the round remains
incomplete; `FederationThreadSyncState` is not a second client-visibility index.
For a group, the consumer then drains the departed-member profile query with `before=beforeSeq` and
`through=batchOldestSeq`. A P2P round omits that query. A reverse round does not
initiate a tombstone query; tombstone facts already committed locally continue
to apply. Group Meta may converge independently, using a stable author Address
and placeholder profile while needed. The reverse query may therefore expose a
historical message briefly before its departed-author profile is available.
Only after the required profile dependency succeeds does the consumer commit
`reverseNextBeforeSeq=batchOldestSeq`.

As soon as the message stage returns, the round stores
`closesReverseHistory` in its in-memory frozen context. The value is derived from
the page's `hasMore` and `scannedThrough`, or from a locally reused batch reaching
the closure target. Later dependency work does not recompute it. At completion,
the driver maps this in-memory conclusion to the persisted
`historyBoundaryReached` value while the CAS still compares both frozen reverse
coordinates.

Each returned departed profile carries its compressed selection coordinate
`lastSentSeq`. The consumer validates
`batchOldestSeq <= lastSentSeq < beforeSeq` and the required descending order
before committing the profile page. The coordinate identifies where the
compressed member fact was selected; it is not evidence that the message itself
was returned or retained, and it does not assert current membership or a
historical role.

An interrupted round may leave a durable, partially reconciled prefix. Its
Message rows remain queryable, while a departed-author profile may still be
missing. On recovery, the new round uses the durable thread boundary as its
minimum baseline and extends from the Message and inbound-pending rows already
stored above that baseline. It may reuse the interrupted prefix before retrying
the profile dependency. Idempotent profile and tombstone application makes this
safe.

Before issuing a remote message request, the consumer selects the greatest
`take` distinct source message coordinates below `beforeSeq` from durable
Message and inbound-pending facts for the same local thread. If `take` are
already present, their smallest coordinate becomes `batchOldestSeq` and the
consumer proceeds directly to the profile dependency. If fewer are present, it
must query the source: local row count alone cannot distinguish the source's end
from a partially fetched page or a scannable gap. `take` defaults to 50 until
the scheduler supplies its configured value; both forward and reverse rounds
use the same validated page-size input.

A pending message at `batchOldestSeq` does not prevent the scan coordinate from
advancing: the pending row is already a durable receipt of that source fact. It
remains individually unavailable until promotion or an authoritative
tombstone. A pending message at the current reverse frontier must be resolved
before the next round crosses that frontier. Because the reverse message
request is strictly below `beforeSeq`, it cannot introduce a new pending message
at that frozen frontier after the initial check.

PendingMedia persists `useOriginSeqAsMessageSeq` rather than duplicating the
publisher coordinate. Reverse storage sets it to true and keeps the target in
the existing `originSeq`; promotion then uses that value as `Message.seq`
without advancing `MessageThread.curSeq`. Ordinary forward pending rows keep the
flag false and retain local seq allocation. The existing federated-identity lock
serializes one publisher coordinate, while partial PendingMedia uniqueness and
Message `(threadId, seq)` uniqueness reject coordinate conflicts without a
thread-wide lock.

For a remote page, `hasMore=false` proves that the frozen serviceable historical
boundary has been reached; the consumer commits the returned `scannedThrough`
and marks history complete after its dependencies finish. A cursor-unavailable
response may produce the same terminal state only when it independently proves
that boundary. A cursor error caused by a changed current `resumeBefore`
instead requires reconciliation and is not history completion. A locally
reused full batch cannot prove the source boundary and therefore never marks
history complete by row count alone.

An exception is a persisted closure target. Local reuse is restricted to source
coordinates at or above that target. If the local batch already contains the
exact target coordinate, it can close reconstruction even with fewer than
`take` coordinates; the target was durable before the interrupted round and is
the intended overlap point rather than an inferred source boundary.

## 5. Pagination and events

Every successful page advances by `scannedThrough`.

- `hasMore=true` schedules another page against the same frozen bound.
- `hasMore=false` completes only that frozen bounded drain; it is not a claim
  that the source can never publish or retain another coordinate.
- A cursor-unavailable result abandons the invalid page sequence and starts
  recovery from the returned serviceable window and newly reconciled durable
  feed state.
- A new thread-content observation schedules a later forward round.
- Initial thread synchronization schedules reverse reconstruction. Each bounded
  reverse batch yields to the scheduler and is rescheduled until its selected
  boundary is reached.

An empty response may still complete a coordinate interval. Consequently,
message rows alone are sufficient for reusing a full local batch, but they are
not a durable replacement for committed continuous coverage.

## 6. Pending-message continuation

Successful inbound promotion and authoritative tombstone termination emit the
same local synchronization wake-up after their transaction commits. The wake-up
contains enough identity to coalesce work by thread and direction; it is not proof
that a barrier has cleared.

On wake-up, the scheduler queries inbound pending messages by thread and the
active source-sequence interval. It continues only when the
relevant interval has no blocking pending row. The existing pending-message
identity and source sequence are sufficient to derive whether a row belongs to
a forward or reverse interval; a stored synchronization-direction field is not
required.

## 7. Process-local round scheduler

Thread-round scheduling is separate from ordinary federation HTTP admission.
`FederationHttpScheduler` limits individual signed requests globally and per
peer. The thread-round scheduler limits longer logical rounds and delegates each
request made by a round to that existing HTTP scheduler. Connection reuse
remains a transport concern of the per-peer dispatcher.

The scheduler keeps one peer queue containing coalesced thread identities for
each direction. Forward and reverse directions have independent global active
limits. A local thread can have at most one active round in one direction, while
its opposite direction and unrelated threads may run concurrently. Ready peers
rotate round-robin, and a completed thread quantum returns to the tail when more
durable work remains. A peer with many threads therefore cannot monopolize all
round slots.

One quantum runs at most the configured `take`, defaulting to 50. It freezes the
current durable coordinates, executes exactly one forward or reverse round, and
then rereads durable state. It is requeued only when the reread proves more work:

- forward when either processed-through coordinate remains below its target;
- reverse when `historyBoundaryReached=false` and the round is not blocked by a
  pending message at its current frontier.

Wake-ups are idempotent hints. A wake-up for a queued or active thread sets one
coalesced pending bit; it never starts a second same-direction round. Targets
committed while a forward round is active are not absorbed into its frozen
coordinates. The completion reread observes them and schedules the next
quantum. A reverse round does not react to later State Feed targets because its
boundary was selected at initialization.

The first committed creation of `FederationThreadSyncState` wakes both
directions. Later committed target merges wake only the forward direction. Feed
page application collects affected local thread ids inside its transaction and
delivers the hints only after that transaction commits. Failed or rolled-back
pages therefore cannot create runnable work.

Startup recovery scans synchronization state rather than a persistent work
queue. It queues forward work whose target exceeds its processed position and
reverse work whose history boundary has not been reached. The source peer is
resolved from the current federated group or P2P mapping. Missing, local,
truncated, or inactive sources are ignored until relationship reconciliation
creates another valid wake-up.

A reverse quantum blocked by pending media exits without immediate requeue, so
it cannot form a hot loop. Successful promotion or authoritative tombstone
termination emits a post-commit reverse wake-up for that thread. The scheduler
then rereads the durable frontier; no pending-specific scheduler field is
stored.

Shutdown stops admitting new rounds and waits for already active quanta. A
process crash may discard every in-memory queue, pending bit, and frozen target;
the startup scan reconstructs the same required work from
`FederationThreadSyncState`, Message, PendingMedia, and tombstone facts. No
database-backed scheduler queue or execution lock is required.

Startup recovery performs the same database checks for threads with incomplete
durable coverage. Correctness therefore does not depend on delivery of an
in-memory wake-up.

## 7. Completion and publication invariants

- Forward message storage retains the existing Message visibility behavior;
  completing the round controls its collected SSE effects, not queryability.
- A skipped coordinate is intentionally unreplicated, not acknowledged or
  processed.
- Reverse cursor progress never crosses an unresolved message at its current
  frontier.
- Reverse historical insertion does not update the thread's latest-message
  summary and does not emit realtime new-message, deletion, or federation hint
  notifications. Pending historical media still uses the durable downloader.
- Reverse progress never moves a committed forward cursor backward.
- Feed events merge durable per-thread targets and may create later work, but
  never change an active bounded page sequence.
- All page application, dependency merges, and boundary publications are
  idempotent under retry.
