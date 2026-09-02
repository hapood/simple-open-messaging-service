# Simple Open Messaging Federation Protocol v1 Message Tombstone Query

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document is entirely normative.

This document defines the per-thread authoritative deletion query
`GET /s2s/v1/message-tombstones`. The compacted `thread + messageEndSeq +
tombstoneEndSeq` discovery projection is a `THREAD_CONTENT_HEAD` item in
[State Feed](./state-feed.md#6-thread_content_head).

## 1. Authoritative deletion facts

```ts
type MessageTombstoneType = 'USER_RETRACTION' | 'MODERATION_REMOVAL';

interface MessageTombstone {
  deletionSeq: PositiveThreadSequence;
  thread: ThreadAddress;
  messageSeq: PositiveThreadSequence;
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

For a P2P `USER_RETRACTION`, the authority is the target message author's
domain. For a group message authored by one of its local users, a member home
server directly publishes the `USER_RETRACTION` in its tombstone feed to the
group origin. This is an author-enacted deletion fact, not a request. The origin
validates the author and target binding, accepts the deletion into the
authoritative group timeline, translates its coordinate, and publishes the
result to mirrors. Only the group origin's moderation process MAY create a
`MODERATION_REMOVAL`. A mirror MUST NOT relay a group tombstone to a peer other
than its group origin.

`deletionSeq` is the tombstone's independent positive thread-local identifier. It
MUST strictly increase without reuse within a thread. The protocol requires
neither contiguous values nor a separate allocator for every thread. It is
independent of message `seq`, `messageSeq`, and feed IDs. A publisher MUST NOT
allocate `deletionSeq` greater than `SafeInteger - 1`; `messageSeq` has the
same limit because it references a message `seq`. `tombstoneEndSeq` is a JSON
`ThreadSequence`: it is `0` when no deletion exists and otherwise identifies
the inclusive positive deletion end. Tombstone-query response boundaries are
JSON `SafeInteger` values. A publisher MUST retain authoritative tombstones
permanently and MUST NOT discard them or
reset their sequence because of capacity, age, peer acknowledgement, renewed
friendship, or group re-entry.

To apply a tombstone, a consumer locates its local target using the persistently
stored source domain, thread, and source message `seq`. When a group member's
home server publishes a `USER_RETRACTION` to the group origin, it uses the `seq`
with which it exposed that message to the origin. When the origin publishes the
accepted tombstone to a mirror, it instead uses the `seq` with which the origin
exposed the target message to that mirror. A publisher MUST NOT forward the
previous hop's `messageSeq` without translating coordinates.

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
deletion coordinate. This parameter is used only by the first deletion drain
after an existing relationship is reauthorized. Its value is the greatest
publisher message coordinate that the consumer had continuously committed
before the preceding authorization loss. The value and the drain's `through`
MUST remain fixed across every page, retry, and cursor recovery in that bounded
drain. Every later deletion drain for the authorization segment MUST omit
`maxMessageSeq` and therefore uses the unfiltered behavior.

The wire representation, default, and pagination behavior of `includeSelf`
are identical to the message query. With `includeSelf=false`, the source uses
its authoritative target-message record to omit tombstones whose author domain
equals the verified signer domain. For GROUP this covers every member identity
hosted by that peer, not one selected member. The author does not thereby become
a tombstone wire field. A filtered `deletionSeq` is a scannable gap and does not
prevent `scannedThrough` from advancing. Filtering does not delete the
authoritative tombstone.

The fixed query-key order is `account`, optional `peerAccount`, `after`,
`through`, `take`, `includeSelf`, then `maxMessageSeq`; omitted optional fields
leave no placeholder.

There are exactly two valid group publication paths through this query:

- A member home server publishes `USER_RETRACTION` tombstones only for messages
  authored by its local users to the group origin.
- The group origin publishes accepted `USER_RETRACTION` and enacted
  `MODERATION_REMOVAL` tombstones to member home servers holding mirrors.

A mirror MUST NOT publish a group tombstone to a peer other than its group
origin and MUST NOT create or relay a `MODERATION_REMOVAL`.

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
NOT alter or discard the authoritative fact. This lets the reauthorization
drain return withdrawals that can target retained pre-loss replicas while
fast-forwarding deletion facts whose target message coordinate is greater than
the consumer's pre-loss committed message boundary. Completing that bounded
drain commits its full `scannedThrough`, not merely the greatest returned
tombstone. A later `THREAD_CONTENT_HEAD` creates an ordinary unfiltered deletion
drain.

A consumer initializing a thread for which it has no previous replica in the
publisher's message-coordinate space MUST NOT query the tombstone history that
precedes its first committed `THREAD_CONTENT_HEAD`. It initializes its deletion
cursor directly to that item's `tombstoneEndSeq`. This is safe because the
source message query does not return messages already terminated by an
authoritative tombstone, and the consumer has no older local replica to remove.
This initial cursor adoption is not relationship reauthorization and MUST NOT
cause a `maxMessageSeq` request.

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

For every query, the source MUST revalidate its durable authored relationship
direction, thread authority, local history policy, current blocking, and local
policy. A P2P query requires an effective source-authored user-to-user
`REQUESTED` or `ACCEPTED` direction for the exact selector. A GROUP query is
served by a group origin under at least one effective source-authored
group-to-member `REQUESTED` or `ACCEPTED` direction whose member belongs to the
verified signer peer. In the reverse direction, the signer MUST be the exact
authority of the mirrored group, and the source may return only
`USER_RETRACTION` tombstones whose target author belongs to the source domain.
That reverse authority binding does not require a source-authored
member-to-group intent. An effective `REQUESTED` expires at its absolute
`expiresAt`; an `ACCEPTED` remains effective until superseded. A
`THREAD_CONTENT_HEAD` is not authorization proof.

The source MUST establish the stable query state before publishing a positive
intent. A one-way grant authorizes passive querying but MUST NOT publish content
heads or wake hints until the applicable relationship is confirmed. For GROUP,
at least one member hosted by that peer MUST remain confirmed. `REQUESTED` and
`ACCEPTED` grant identical query permission
for the same stable key. Confirmation or later reauthorization MUST NOT replace
the stable thread's deletion-sequence coordinate space. Authorization evaluation
MAY idempotently materialize state derived from existing durable facts, but the
GET request itself MUST NOT create or broaden authorization.

After receiving relationship termination through the state feed, a consumer
MUST invalidate that peer/thread's current deletion target. If a tombstone
query first returns `FORBIDDEN` because the current relationship is invalid,
the consumer MUST apply the current-state-guarded P2P or GROUP convergence rules in
[Message Feed](./message-feed.md), stop every query direction covered by a
matching epoch, invalidate its pending ends, and prioritize draining the State
Feed again. A denial invalidated by newer relationship state authors no
transition and resumes from current durable state. This handling MUST NOT
decrease the State Feed cursor or undo an applied authoritative tombstone.

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
