# Simple Open Messaging Federation Protocol v1 Message Tombstone Feed and Query

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document is entirely normative.

This document defines the compact tombstone index feed
`GET /s2s/v1/message-tombstone-feed` and the per-thread authoritative deletion
query `GET /s2s/v1/message-tombstones`. The feed contains only
`thread + tombstoneEndSeq`; it does not contain tombstones.

## 1. Authoritative deletion facts

```ts
type MessageTombstoneType = 'WITHDRAW' | 'REPORT';

interface MessageTombstone {
  deletionSeq: PositiveDecimalString;
  thread: ThreadAddress;
  messageSeq: ThreadSequence;
  type: MessageTombstoneType;
  deletedAt: EpochMilliseconds;
}
```

`WITHDRAW` is an author withdrawal. `REPORT` is a moderation deletion enacted
by the thread authority. Both are irreversible terminal states in which the
message is no longer visible.

The stable target is `(publisher domain, thread, messageSeq)`. `messageSeq`
MUST equal the `FederatedMessage.seq` with which the current tombstone
publisher originally exposed the target message to this consumer through the
message query. It therefore uses that publisher's thread-message coordinate.
It is neither a copy of the target message's nullable outer `originSeq` nor a
globally stable coordinate across arbitrary publishers.

For a P2P `WITHDRAW`, the authority is the target message author's domain. For
a group message, the authoritative publisher is always the group origin. A
third-party member home server MAY only submit a `WITHDRAW` for its local
author to the origin. The origin validates the submission, creates the
authoritative group fact, and distributes it to mirrors. Only the group
origin's moderation process MAY create a `REPORT`. A mirror MUST NOT relay a
group tombstone further.

`deletionSeq` is the tombstone's independent positive-integer identifier. It
MUST strictly increase without reuse within a thread. The protocol requires
neither contiguous values nor a separate allocator for every thread. It is
independent of message `seq`, `messageSeq`, and feed IDs. A publisher MUST NOT
allocate `deletionSeq` greater than `SafeInteger - 1`; `messageSeq` has the
same limit because it references a message `seq`. `tombstoneEndSeq` MUST also
be at most `SafeInteger - 1`. A publisher MUST retain authoritative tombstones
permanently and MUST NOT discard them or
reset their sequence because of capacity, age, peer acknowledgement, renewed
friendship, or group re-entry.

To apply a tombstone, a consumer locates its local target using the persistently
stored source domain, thread, and source message `seq`. When a group member's
home server submits a `WITHDRAW` to the group origin, it uses the `seq` with
which it exposed that message to the origin. When the origin publishes the
resulting authoritative tombstone to a mirror, it instead uses the `seq` with
which the origin exposed the target message to that mirror. A publisher MUST
NOT forward the previous hop's `messageSeq` without translating coordinates.

## 2. Tombstone feed

The optional feed parameters are `after`, `take`, and `through`. Their shapes,
bootstrap behavior, half-open/half-closed window, page calculation, lack of
source-side acknowledgements, and absence of consumer-cursor monotonicity
checks are identical to [Message Feed Section 1](./message-feed.md#1-message-feed).
When `after` is omitted, the source returns
`FEDERATION_FEED_CURSOR_UNAVAILABLE { resumeAfter, resumeBefore }` instead of a
page, with `resumeBefore=tombstoneFeedEndId+1`.

```ts
interface MessageTombstoneFeedPage {
  items: MessageTombstoneFeedItem[];
  scannedThrough: DecimalString;
  tombstoneFeedEndId: DecimalString;
  hasMore: boolean;
}

interface MessageTombstoneFeedItem {
  feedId: PositiveDecimalString;
  thread: ThreadAddress;
  tombstoneEndSeq: DecimalString;
}
```

The stable key is `(target peer, thread)` and has the same identity as Message
Feed Section 1.2: a P2P thread uses the canonical source-user/target-peer-user
pair, while a group thread uses the group address and verified target peer
domain rather than an individual member on that peer. Relationship-state
transitions do not create a new stable key. For that key, every
`tombstoneEndSeq` exposed to the target peer MUST be greater than or equal to
every value previously exposed for the key. The source MUST NOT reset, decrease,
replace, or reuse this deletion-sequence coordinate space. Whenever the
`tombstoneEndSeq` visible to that peer strictly increases, the source MUST allocate a new
`feedId` greater than every earlier ID in that feed and replace the previous
item with the new item. An equal or lower end is a no-op.

The tombstone feed is a durable compact index. The source may remove an older
index item superseded by a newer item. For a thread that still has a current
audience or remains queryable, the source MUST NOT remove the current
projection because of compaction, history cleanup, or restart, and MUST NOT
require the consumer to advance `after`. An update MUST use a greater
`feedId`; it MUST NOT rewrite an ID that a consumer may already have passed.

After a P2P friendship ends, the source MAY independently remove that
peer/thread's current tombstone-feed projection. Removal neither allocates a
new `feedId` nor decreases `tombstoneFeedEndId`. The message and tombstone feeds
need not contain the same set of threads: a thread with no withdrawals has no
tombstone stable key. If the relationship is later restored and the projection
must be recreated, the source MUST allocate a new, greater `feedId` even when
`tombstoneEndSeq` has not changed.

A feed item is only a query-discovery index, not a deletion fact, and cannot by
itself cause a local message deletion. The consumer atomically merges the
greatest `tombstoneEndSeq` for each thread with feed `scannedThrough`, then uses
the query to retrieve the corresponding facts.

## 3. Tombstone query

`GET /s2s/v1/message-tombstones` uses the same account-grammar-discriminated
thread selector, P2P `localAccount`, exclusive `after`/`before`
choice, fixed inclusive `through`, and directional ordering as the message
query. Here, all three coordinates belong to the
thread-local `deletionSeq` space, not the tombstone-feed ID space. A forward
window is `(after, through]` in increasing order; a reverse window is
`[through, before)` in decreasing order. Invalid combinations or bounds return
`400 FEDERATION_MALFORMED`.

The wire representation, default, and pagination behavior of `includeSelf`
are identical to the message query. With `includeSelf=false`, the source uses
its authoritative target-message record to omit tombstones whose author domain
equals the verified signer domain. The author does not thereby become a
tombstone wire field. A filtered `deletionSeq` is a scannable gap and does not
prevent `scannedThrough` from advancing. Filtering does not delete the
authoritative tombstone.

There are exactly two valid directions for group tombstones: a member home
server provides the group origin with a `WITHDRAW` submission for its local
author, and the group origin provides enacted authoritative tombstones to a
peer holding a mirror of that group. A mirror MUST NOT return a group tombstone
to a non-origin peer and MUST NOT create or relay a `REPORT`.

When both `after` and `before` are omitted, the source returns
`FEDERATION_FEED_CURSOR_UNAVAILABLE { resumeAfter, resumeBefore }` instead of a
page. The two fields describe the open authorized deletion-sequence window. A
forward query starts with `after=resumeAfter`; a reverse query starts with
`before=resumeBefore`. Because tombstones are retained permanently, cleanup
MUST NOT increase `resumeAfter`. A cursor outside the current open window may
receive the same two-boundary correction.

```ts
interface MessageTombstoneQueryPage {
  tombstones: MessageTombstone[];
  scannedThrough: DecimalString;
  hasMore: boolean;
}
```

The forward query window is
`(after, min(through, currentTombstoneEndSeq)]`; the reverse query window is
`[queryStart, min(before, currentTombstoneEndSeq + 1))`, where `queryStart` is
the supplied `through` or `resumeAfter + 1` when `through` is omitted.
`candidates` consists of
all authoritative tombstones in the selected window that this peer may learn.
Ordering, direction-relative `scannedThrough`, `hasMore`, gaps, next-page cursor,
and fixed-`through` calculations are identical to Message Query Section 2.2. An
empty page may advance to the selected bound but MUST NOT skip an authoritative
fact in the interval that this peer may learn.

When starting or restarting a forward tombstone-query drain, a consumer MAY
advance its local `after` cursor to a greater position because of finite local
storage or processing capacity. The selected position MUST be within the
source-advertised serviceable window and MUST NOT move a committed cursor
backward.

Because a skipped tombstone may target any earlier message in the thread, the
consumer MUST atomically discard every locally retained message replica and
pending message-derived resource for that thread before committing the advanced
tombstone cursor. It MUST also mark the skipped deletion interval as
intentionally unreplicated and MUST NOT claim complete tombstone processing for
it. Fast-forward does not weaken or delete an authoritative tombstone, alter
source data, or acknowledge processing to the source.

For every query, the source MUST revalidate its current authored relationship
direction, thread authority, whether the target peer was granted visibility of
the target message, current blocking, and local policy. For both user/user and
user/group relationships, an unexpired source-authored `REQUESTED` or valid
`ACCEPTED` grants the target peer query access without requiring the reverse
direction. Before publishing either state, the source MUST have established
every thread, audience, and authorization fact needed to serve that query.
`REQUESTED` and `ACCEPTED` grant identical tombstone-query permission for the
same stable key; reverse confirmation MUST NOT expand, reset, shrink, or replace
that peer's deletion-sequence coordinate space solely because of confirmation.
A feed item is not proof of authorization. Authorization evaluation MAY
idempotently materialize immediate friendship or group state derived from
existing durable facts, but the GET request itself MUST NOT create or broaden
authorization.

After receiving relationship termination through the state feed, a consumer
MUST invalidate that peer/thread's current tombstone-feed target. If a
tombstone query first returns `FORBIDDEN` because the current relationship is
invalid, the consumer MUST stop querying that thread, invalidate its pending
end, and prioritize draining the state feed again. It MUST NOT decrease the
global tombstone-feed cursor or undo an applied authoritative tombstone.

When the source cannot serve the query because its quota is exhausted, it MAY
return HTTP `200 FEDERATION_QUOTA_EXCEEDED` with the sole structured data
`{ retryAfter }`. The consumer MUST NOT advance the thread deletion cursor or
change peer lifecycle state, and MUST wait at least that many seconds before
retrying. Quota thresholds, units, windows, and algorithms are outside this
protocol and MUST NOT be returned as structured fields.

## 4. Consumer application and races

The consumer MUST validate the authority binding: a P2P source MUST be the
target message author's domain, and a group tombstone source MUST be the known
group origin. If a tombstone arrives before its target message, the consumer
retains a pending fact keyed by `(source domain, thread, messageSeq)` and
completes author-binding validation when the message arrives. A mismatch leaves
the message invisible and has no other protocol effect. A member's withdrawal
submission to the origin is not an authoritative query item that a mirror can
apply.

A query page and the local thread deletion cursor MUST commit atomically. A
consumer MUST fail closed for the affected target whenever it can identify an
invalid tombstone safely. Each accepted tombstone is applied idempotently to its
stable target:

- If the message exists, it enters the irreversible invisible state. Any
  derived local views MUST reflect that state.
- If the message has not arrived, a pending tombstone prevents a later or
  replayed copy from reviving it.
- The consumer stops unfinished localization of the target message's media or
  bundle and grants no new resource access for it.
- An existing semantically identical fact is a no-op. Conflicting authority,
  `type`, or `deletedAt` is invalid and cannot replace the accepted fact.

Message acceptance, resource promotion, and tombstone application MUST share a
serialization boundary for the stable target. Whether the tombstone or message
arrives first, the outcome MUST converge to the same deleted state. A
temporarily absent tombstone target is not a query failure and MUST NOT block
the query cursor.

## 5. Relationship to lightweight push

The three core drain targets in `feed-heads` remain `stateFeedEndId`,
`messageFeedEndId`, and `tombstoneFeedEndId`. The consumer first drains the
state feed, then the tombstone
and message index feeds, merges their per-thread end sequences, and finally
invokes both per-thread queries. Hints may be lost, duplicated, or reordered,
so startup and periodic reconciliation MUST read all three feeds directly.

Deletion SHOULD be applied before message content. For a thread discovered in
the same reconciliation pass, the consumer SHOULD drain the tombstone query to
`tombstoneEndSeq` before draining the message query to `messageEndSeq`. If they
arrive in the opposite order, the pending mechanism in Section 4 MUST still
ensure convergence.

The same ordering applies to reverse history reads. Before accepting a reverse
message-query window, the consumer SHOULD query and apply the corresponding
reverse tombstone window. If the two sequence spaces have different resume
windows, each uses its own returned `(resumeAfter, resumeBefore)` boundaries;
the consumer MUST NOT copy a message cursor into the deletion-sequence space or
vice versa.
