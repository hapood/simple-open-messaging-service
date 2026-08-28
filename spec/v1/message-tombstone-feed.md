# Simple Open Messaging Federation Protocol v1 Message Tombstone Query

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document is entirely normative.

This document defines the per-thread authoritative deletion query
`GET /s2s/v1/message-tombstones`. The compacted `thread + messageEndSeq +
tombstoneEndSeq` discovery projection is a `THREAD_CONTENT_HEAD` item in
[State Feed](./state-feed.md#7-thread_content_head).

## 1. Authoritative deletion facts

```ts
type MessageTombstoneType = 'USER_RETRACTION' | 'MODERATION_REMOVAL';

interface MessageTombstone {
  deletionSeq: PositiveThreadSequence;
  thread: ThreadAddress;
  messageSeq: ThreadSequence;
  type: MessageTombstoneType;
  deletedAt: EpochMilliseconds;
}
```

`USER_RETRACTION` is a retraction enacted by the message author.
`MODERATION_REMOVAL` is a moderation deletion enacted by the thread authority.
Both are irreversible terminal states in which the message is no longer visible.

The stable target is `(publisher domain, thread, messageSeq)`. `messageSeq`
MUST equal the `FederatedMessage.seq` with which the current tombstone
publisher originally exposed the target message to this consumer through the
message query. It therefore uses that publisher's thread-message coordinate.
It is neither a copy of the target message's nullable outer `originSeq` nor a
globally stable coordinate across arbitrary publishers.

For a P2P `USER_RETRACTION`, the authority is the target message author's domain. For
a group message, the authoritative publisher is always the group origin. A
third-party member home server MAY only submit a `USER_RETRACTION` for its local
author to the origin. The origin validates the submission, creates the
authoritative group fact, and distributes it to mirrors. Only the group
origin's moderation process MAY create a `MODERATION_REMOVAL`. A mirror MUST NOT relay a
group tombstone further.

`deletionSeq` is the tombstone's independent positive thread-local identifier. It
MUST strictly increase without reuse within a thread. The protocol requires
neither contiguous values nor a separate allocator for every thread. It is
independent of message `seq`, `messageSeq`, and feed IDs. A publisher MUST NOT
allocate `deletionSeq` greater than `SafeInteger - 1`; `messageSeq` has the
same limit because it references a message `seq`. `tombstoneEndSeq` MUST also
be a JSON `PositiveThreadSequence`. Tombstone-query response boundaries are
JSON `SafeInteger` values. A publisher MUST retain authoritative tombstones
permanently and MUST NOT discard them or
reset their sequence because of capacity, age, peer acknowledgement, renewed
friendship, or group re-entry.

To apply a tombstone, a consumer locates its local target using the persistently
stored source domain, thread, and source message `seq`. When a group member's
home server submits a `USER_RETRACTION` to the group origin, it uses the `seq` with
which it exposed that message to the origin. When the origin publishes the
resulting authoritative tombstone to a mirror, it instead uses the `seq` with
which the origin exposed the target message to that mirror. A publisher MUST
NOT forward the previous hop's `messageSeq` without translating coordinates.

## 2. Tombstone query

`GET /s2s/v1/message-tombstones` uses the same account-grammar-discriminated
thread selector and P2P `peerAccount` as the message query, but it is
forward-only. `after` is the exclusive cursor and `through` is the fixed
inclusive upper bound. Both belong to the thread-local `deletionSeq` space,
not the State Feed ID or message-sequence space. The selected window is
`(after, through]` in increasing order. `before` is not a valid parameter.
Invalid combinations or bounds return `400 FEDERATION_MALFORMED`.
`after` and `through` are canonical decimal HTTP query strings whose parsed
values MUST be at most `SafeInteger`; they are not JSON string representations
of the response coordinates.

A query MAY also carry `maxMessageSeq`, a non-negative canonical decimal string
no greater than `SafeInteger - 1`. It is an inclusive upper bound in the
publisher's exposed `MessageTombstone.messageSeq` coordinate, not in the
deletion coordinate. Omission retains the unfiltered behavior for compatibility.
A consumer that supplies it MUST freeze the value for the complete bounded
query drain, including retries and cursor recovery; increasing it creates
later-round work rather than enlarging the active drain.

The wire representation, default, and pagination behavior of `includeSelf`
are identical to the message query. With `includeSelf=false`, the source uses
its authoritative target-message record to omit tombstones whose author domain
equals the verified signer domain. The author does not thereby become a
tombstone wire field. A filtered `deletionSeq` is a scannable gap and does not
prevent `scannedThrough` from advancing. Filtering does not delete the
authoritative tombstone.

There are exactly two valid publication paths for group tombstones: a member
home server provides the group origin with a `USER_RETRACTION` submission for
its local author, and the group origin provides enacted authoritative
tombstones to a peer holding a mirror of that group. A mirror MUST NOT return a
group tombstone to a non-origin peer and MUST NOT create or relay a
`MODERATION_REMOVAL`.

When `after` is omitted, the source returns
`FEDERATION_FEED_CURSOR_UNAVAILABLE { resumeAfter, resumeBefore }` instead of a
page. The two fields describe the open authorized deletion-sequence window, and
the query starts with `after=resumeAfter`. `resumeBefore` remains the exclusive
upper boundary of the common cursor-recovery shape; it does not enable reverse
tombstone querying. Because tombstones are retained permanently, cleanup MUST
NOT increase `resumeAfter`. A cursor outside the current open window may receive
the same two-boundary correction.

```ts
interface MessageTombstoneQueryPage {
  tombstones: MessageTombstone[];
  scannedThrough: SafeInteger;
  hasMore: boolean;
}
```

The query window is `(after, min(through, currentTombstoneEndSeq)]`.
`candidates` consists of all authoritative tombstones in the selected window
that this peer may learn and, when `maxMessageSeq` is present, whose exposed
`messageSeq` is at most that bound.
Increasing ordering, `scannedThrough`, `hasMore`, gaps, next-page cursor, and
fixed-`through` calculations are identical to the forward rules in Message
Query Section 2.2. An empty page may advance to the selected bound but MUST NOT
skip an authoritative fact in the interval that this peer may learn.

A tombstone excluded only by `maxMessageSeq` is a scannable gap. The source
MUST still advance `scannedThrough` according to the deletion window and MUST
NOT alter or discard the authoritative fact. This is safe for an ordinary
forward round because the consumer chooses the bound from message coordinates
it has already durably covered, while the source's message query omits messages
that were already tombstoned. A deletion committed after a message page was
served is discovered by a later `THREAD_CONTENT_HEAD` update, when the consumer's
durable message boundary includes that message.

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
A `THREAD_CONTENT_HEAD` item is not proof of authorization. Authorization evaluation MAY
idempotently materialize immediate friendship or group state derived from
existing durable facts, but the GET request itself MUST NOT create or broaden
authorization.

After receiving relationship termination through the state feed, a consumer
MUST invalidate that peer/thread's current deletion target. If a
tombstone query first returns `FORBIDDEN` because the current relationship is
invalid, the consumer MUST stop querying that thread, invalidate its pending
end, and prioritize draining the state feed again. It MUST NOT decrease the
State Feed cursor or undo an applied authoritative tombstone.

When the source cannot serve the query because its quota is exhausted, it MAY
return HTTP `200 FEDERATION_QUOTA_EXCEEDED` with the sole structured data
`{ retryAfter }`. The consumer MUST NOT advance the thread deletion cursor or
change peer lifecycle state, and MUST wait at least that many seconds before
retrying. Quota thresholds, units, windows, and algorithms are outside this
protocol and MUST NOT be returned as structured fields.

## 4. Consumer application and races

The consumer MUST validate the authority binding: a P2P source MUST be the
target message author's domain, and a group tombstone source MUST be the known
group origin. If a tombstone arrives before its target message, the accepted
fact remains effective for `(source domain, thread, messageSeq)` and the
consumer completes author-binding validation when the message arrives. A
mismatch rejects the target message and has no other protocol effect. A member's withdrawal
submission to the origin is not an authoritative query item that a mirror can
apply.

A query page and its thread deletion cursor MUST be accepted atomically. A
consumer MUST fail closed for the affected target whenever it can identify an
invalid tombstone safely. Each accepted tombstone is applied idempotently to
its stable target:

- If the message exists, it enters the irreversible invisible state. Any
  derived local views MUST reflect that state.
- If the message has not arrived, the accepted tombstone prevents a later or
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

`feed-heads` carries only `stateFeedEndId`. The consumer drains State Feed,
merges both coordinates from each `THREAD_CONTENT_HEAD`, and then invokes the
per-thread queries. Hints may be lost, duplicated, or reordered, so startup and
periodic reconciliation MUST also drain State Feed without relying on a hint.

For a thread discovered in the same reconciliation pass, the consumer MAY drain
the tombstone query to `tombstoneEndSeq` concurrently with the message query to
`messageEndSeq`. The stable-target convergence rules in Section 4 MUST ensure
the same result regardless of arrival order.

Reverse message reconstruction uses only this forward tombstone drain; its
ordering is defined by Protocol Section 9.3.
