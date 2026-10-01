# Federation Consumer Rounds

## 1. Purpose

This document describes the local implementation of bounded federation content
rounds. A local content round is one scheduler batch, not the protocol's
multi-page reconciliation round. Wire-level query semantics remain in the
protocol specification. The local design has three independent concerns:

- State Feed application discovers durable per-thread targets.
- Forward and reverse content rounds commit ordered message facts.
- Content materialization changes committed placeholders to READY or FAILED.

A synchronization round never waits for media bytes or quote materialization.
Committing a Message STUB at its final local sequence is sufficient to commit
that publisher coordinate.

## 2. Durable state

`FederationThreadSyncState` is keyed by `(threadId, namespaceId)` and stores:

- the authorization epoch captured from MessageThread;
- monotonic message and deletion targets discovered through State Feed;
- the forward message and deletion coordinates already committed;
- the active recoverable history-gap id;
- whether no recoverable reverse gap remains.

The publisher namespace is explicit. A mirrored group pulls its authority's
coordinate space, but a locally authoritative group receives independent
submissions from multiple peers. Its local authority namespace (`0`) must not
be used to identify those incoming streams. State Feed cursors and in-memory
queue keys do not substitute for source-scoped durable message progress.

`FederationThreadHistoryGap` stores an inclusive pending publisher interval
`[startSeq, endSeq]` for `(threadId, namespaceId)` and its fixed non-negative `messageSeqOffset`. The
boundaries are coordinates, not foreign keys to Message rows. A request for the
active interval uses:

```text
before = endSeq + 1
through = startSeq
```

No reverse network cursor is persisted separately. A restart derives the next
request only from the active gap. Message, STUB, PendingMedia, or downloaded
asset rows must not be used to infer reverse coverage.

## 3. State Feed application

One peer has at most one State Feed request-and-application flight. Each flight
is a fixed-through synchronization round and may require multiple pages. A
normal round starts at the committed cursor (logical delta); cursor-unavailable
recovery starts at the advertised reconstructable boundary (logical full).
These are consumer modes, not additional State Feed wire fields.

Items are applied individually in increasing feed-id order. Applying one item
and advancing the durable State Feed processing cursor occur in the same
transaction. Item and page commits persist facts, compacted local projections,
and recovery progress only. They emit no side effect from inside the
transaction. After each item transaction commits, its thread-scheduler wakes,
system messages, profile-resolution requests, peer State Feed pushes, and
client State Feed high-watermark hints are handed to their process-wide
schedulers.

Peer State Feed head publication has its own process-wide scheduler; it is not
part of the message/tombstone/reverse thread-round scheduler. Producers only
emit a domain-scoped wake after committing the compacted State Feed fact. The
State Feed push scheduler coalesces independently per domain, enforces the
minimum interval, keeps one request in flight per domain, and reschedules
temporary failures. Its one-attempt client reads the latest committed head at
execution time and sends `/feed-heads`. The transport acquires the shared
global/per-domain HTTP concurrency slot for every attempt. Business producers
never invoke or await this HTTP client directly.

The relationship activation transaction locks MessageThread and initializes
`FederationThreadSyncState` against the thread authorization epoch using the
remote intent's retained, simultaneous message/tombstone snapshot. The newest advertised message remains forward
work. Older skipped coordinates become a reverse gap.

For the message tail `E` carried by that authorization:

- `E=0`: no message work;
- `E=1`: forward interval `(0,1]`, no reverse gap;
- `E>1`: forward interval `(E-1,E]` and reverse gap `[1,E-1]`.

The same relationship transaction initializes
`deletionProcessedThroughSeq=deletionTargetSeq`. A new mirror has no older
publisher-coordinate message replica, so it creates no tombstone work for the
initial deletion history. Later `THREAD_CONTENT_HEAD` transactions only advance
existing targets in the current epoch. They never create a state row or reverse
gap. In particular, `0/0` initialization leaves both committed cursors at zero
until forward work commits, even if the first head advertises multiple messages.

When a reverse gap is created, the same transaction has already locked
MessageThread. With publisher gap `[S,E-1]` and locked local tail `L`, it stores
`messageSeqOffset=max(0,L+1-S)`, reserves the allocator through
`E-1+messageSeqOffset`, and leaves the newest publisher item for the ordinary
forward path at `E+messageSeqOffset`. Reverse insertion uses
`localSeq=sourceSeq+messageSeqOffset`, so local system messages written between
authorization epochs cannot collide with reconstructed history.

On an epoch change, let `C` be the old committed forward message coordinate and
`E` the new advertised tail. The skipped interval is `[C+1,E-1]`. Empty
intervals are ignored. Overlapping or adjacent recoverable gaps are merged only
when their sequence offsets match. Different epoch mappings and committed
forward islands keep gaps separate.

An item after-commit handler publishes only hints for facts committed by that
item. The client State Feed notifier maintains an independent one-second
coalescing window for each local account's feed. It also retains that feed's
greatest observed committed `feedId` monotonically for the process lifetime, so
a later stale call cannot publish a lower hint after the window expires. This
high watermark is not durable; reconnect recovery uses the database feed head.
The notifier never shares one timer across different accounts. Thread and peer
schedulers apply their own scope-specific coalescing.
A larger remote hint that arrives while the round is active becomes a later
round. Wakes remain hints; durable state remains authoritative, and unsolicited
local reads during a round may observe already committed intermediate facts.

A `THREAD_CONTENT_HEAD.groupMetaFeedEndId` coordinate supplies the fixed target for a resumable Group
Meta round on the scheduler's `meta` lane — at most one in-flight round per
mirror thread, with later heads coalesced as a dirty mark. Network requests and
bounded roster-page transactions occur outside the State Feed item transaction.
The item transaction merges the target into `GroupMeta.metaTargetId`, wakes the
lane, advances the State Feed cursor, and continues with later items without
waiting. A delta round freezes its `through` at the current `metaTargetId` in
scheduler memory and consumes one feed item per transaction, each committing
the replica fact, its transition system message or a direct local fan-out
admission, and the durable cursor to that item's feed id. An open
`metaRecoveryThroughId` selects a full-snapshot recovery drain. Full pages
are accumulated without replacing committed state. After the complete bounded
scan succeeds, one transaction replaces the roster, group-profile reference,
and announcement, advances the committed cursor and `metaEndId`, closes the
drain, and writes the derived client heads. An incomplete full drain leaves
committed state unchanged. Round completion publishes post-commit hints;
it does not wake or replay the already consumed State Feed item.

## 4. Forward rounds

Forward messages and tombstones have independent scheduler queues,
single-flights, concurrency limits, retries, and fairness quanta. A committed
`THREAD_CONTENT_HEAD` merges both targets into durable thread state and wakes
both streams. After that wake, the two streams read their own durable target,
run concurrently, and commit independently. The scheduler does not retain a
second authoritative copy of either target or of the recovery cutoff.

An ordinary tombstone drain carries no message-coordinate filter. On the first
authorization snapshot after an authorization-epoch change, the relationship
activation transaction creates a durable recovery drain with two frozen values:

- `deletionRecoveryThroughSeq`, copied from that snapshot's deletion target;
- `deletionRecoveryMaxMessageSeq`, copied from the message coordinate committed
  before the epoch change.

Every `take=50` scheduler quantum belonging to that bounded recovery drain sends
the same `maxMessageSeq` and scans toward the same `through`. Each returned page
may commit in its own transaction, but a partial commit does not end recovery:
the next quantum carries the filter again. Tombstones targeting a greater
publisher message coordinate are response holes but still advance
`scannedThrough`; tombstones at or below the cutoff are applied normally. Every
page advances the deletion cursor transactionally. The transaction for which
`deletionProcessedThroughSeq` reaches `deletionRecoveryThroughSeq` also clears
both recovery fields atomically. Later dirty tombstone targets run without
`maxMessageSeq`.
Because the pair is durable, a restart resumes the same recovery semantics
instead of silently turning a recovery drain into an ordinary drain.

Each stream's final transaction compare-and-sets the MessageThread
authorization epoch, validates its response authority token, applies its page,
and advances only that stream's processed-through coordinate. Message pages
insert their messages at the final local sequence as READY when already
materialized or STUB when dependencies remain. Tombstone pages apply deletions,
including deletions targeting an existing STUB. Cursor-unavailable recovery
advances only the affected stream.

Forward insertion advances the compacted local `ClientStateFeed`
`THREAD_CONTENT_HEAD`, including for a committed STUB. It does not emit SSE. A target published while the round
is active remains dirty work for a later round.

## 5. Reverse rounds

One reverse round reads the current active gap and requests at most `take`
coordinates from its upper end. Author display profiles are lazy exact-message
work and do not participate in the reverse gap commit boundary.

A reverse round never queries `/message-tombstones`; that operation is
forward-only. Before completing a reverse message window, the consumer should
apply currently discovered forward tombstone work. The final transaction
therefore applies only authoritative tombstones already obtained and persisted
by the forward tombstone drain that match messages in this reverse batch. A
later deletion remains forward work discovered through a later
`THREAD_CONTENT_HEAD` and does not enlarge or rewind the active reverse round.

The message page remains in process memory until the request finishes. The
final transaction:

1. compare-and-sets MessageThread authorization epoch;
2. locks and revalidates the active gap;
3. inserts historical messages at `Message.seq = publisher seq + messageSeqOffset`;
4. applies matching previously discovered tombstones;
5. shrinks the active gap using the response `scannedThrough` boundary.

After commit, newly selected message-author profile references are offered to
the application-wide profile-resolution scheduler. Resolution failure does not
rewind or block the committed message cursor.

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

Reverse insertion does not publish `THREAD_CONTENT_HEAD` and does not emit SSE.
It fills older history rather than announcing a new conversation tail. Client
history queries read committed STUB, FAILED, and READY rows directly.

If the source reports that the active reverse interval is no longer available,
the gap is retained with `recoverable=false`. It is not treated as copied. The
scheduler selects the next recoverable gap, if any.

## 6. STUB materialization

An inbound media STUB owns its final Message identity and
sequence. PendingMedia references that Message and FileSyncProgress tracks its
downloads. These rows do not belong to scheduler progress calculations.

An unresolved text quote is not a STUB dependency. Its message is accepted with
the scoped reference intact; target availability is resolved when reading.

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
reverse gap. A yielded continuation retains the authenticated peer domain and
namespace captured by the wake that started the round; it does not rediscover
identity context between pages. PendingMedia never suppresses or creates
scheduler work.

On restart the scheduler reads every `FederationThreadSyncState`, resolves its
explicit publisher namespace (not the thread authority namespace), revalidates
that its relationship still provides an active source, enqueues unfinished
forward and reverse work, drains every trusted peer's State Feed, and schedules
a coalesced lightweight state push. Transport connection and request limits
remain delegated to the federation HTTP scheduler.

Network failures, HTTP server failures, and the protocol's explicit deferred
query results are retried from durable state. A valid `retryAfter` is honored as
a minimum delay. Permanent protocol or business failures stop the affected
task instead of entering an unbounded retry loop.

An authenticated thread-query `FORBIDDEN` stops the affected round without
advancing its cursor or treating the denial as an empty page. Relationship
reconciliation follows [Message Query, Section 4](../../spec/v1/message-feed.md#4-authorization-and-state-reconciliation).

The handler revalidates the authorization state captured before the request.
A stale denial writes no revocation. Otherwise it invalidates the covered work
and revokes the still-active locally authored directions covered by the denied
peer authority. This applies to P2P, local groups, and mirrors; it is not
optional cleanup. Peer-authored directions are never rewritten, and a denial
is not authoritative group dissolution.

## 8. Publication invariants

- State Feed targets never regress.
- A synchronization coordinate advances only in the transaction that inserts
  or validates its durable local fact.
- State Feed item transactions emit no scheduler or client notification from
  inside the transaction. Each successfully committed item invokes its
  after-commit publication boundary before the next item is applied.
- A thread head carrying Group Meta progress atomically creates or merges its asynchronous durable
  task before the State Feed cursor advances. No State Feed database transaction
  contains a network request or roster-page transaction.
- Forward message and tombstone pages commit independently with their own
  processed-through coordinates.
- A reverse gap shrinks only in the transaction that inserts the corresponding
  historical batch and applies matching retained tombstones.
- STUB, READY, and FAILED are visible client history states; only READY is used
  by search, unread, preview, forwarding, and federation publication.
- Federation inbound processing and materialization do not emit SSE. Only the
  existing local client-send completion path emits a new-message SSE event.

## 9. Required State Feed round tests

- A multi-item logical delta commits and publishes each item in order. Every
  publication occurs after that item's fact and processing cursor commit and
  before the next item is applied.
- A cursor-unavailable logical full follows the same item boundary. An empty
  trailing page may advance `scannedThrough` without publishing an item effect.
- A failed middle item retains earlier item commits and publications, advances
  no cursor for the failed item, and publishes no effect for it. Retry resumes
  from the last durable item cursor.
- A greater advertised end received during a round is handled by a successor
  fixed-through round and does not extend the running target.
- Multiple committed items for one client State Feed within one second produce
  its greatest `feedId` hint. Its in-process high watermark remains monotonic
  after the window expires, while a different client's feed owns a separate
  timer and cannot be delayed by that window.
- A thread head with Group Meta progress atomically retains its dependency and
  advances the State Feed cursor without waiting for Group Meta. Failed Group
  Meta retrieval leaves the dependency pending and dependent content unexposed.
  No network request occurs inside the State Feed item transaction.
- Group Meta delta commits each item with its cursor. A full drain replaces
  committed state only after the entire scan succeeds. Both resume independently
  of the already consumed State Feed item and publish hints only after commit.

## 10. Source map

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
