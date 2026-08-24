# Simple Open Messaging Federation Protocol v1 Message Feed and Query

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)
Normative scope: this entire document is normative.

This document defines the compacted message-index feed `GET /s2s/v1/message-feed` and the per-thread message-content query `GET /s2s/v1/messages`. The feed answers only which thread's queryable upper bound advanced; authorization, message return, and content-retention policy are applied by the query operation. See [Message](./message.md) for message schemas and [Protocol](./protocol.md) for common rules.

## 1. Message feed

### 1.1 Request

The query is a closed parameter set:

| Field     | Type                               | Rule                                                                                                                                |
| --------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `after`   | `DecimalString`                    | Optional exclusive scan position. When omitted, query only the starting position and return no page.                                |
| `take`    | `PositiveSafeInteger` query string | Optional suggested maximum number of items on this page. The source MAY return fewer but MUST NOT return more.                      |
| `through` | `DecimalString`                    | Optional inclusive upper bound. MUST be greater than or equal to `after` and remain unchanged across continuous bounded pagination. |

`take` and `through` may appear only when `after` is present. An unknown, duplicate, or malformed parameter returns `400 FEDERATION_MALFORMED`. `after`, `through`, and every feed coordinate are canonical non-negative decimal strings; feed item IDs are positive integers. `0` is the exclusive cursor before the first item, not an item ID.

`take` does not guarantee that the response reaches that count and does not relax the source's local page-byte limit. The source MUST ensure that its endpoint can return any individually allocated feed item in full. Every `take` satisfying `PositiveSafeInteger` MUST be accepted. The source MAY return fewer items under a finite local limit and MUST NOT return `FEDERATION_MALFORMED` merely because the requested value exceeds its local page size.

When `after` is omitted, the source MUST return HTTP `200 FEDERATION_FEED_CURSOR_UNAVAILABLE` with both exclusive boundaries: `resumeAfter` is the available starting position and `resumeBefore` is `messageFeedEndId + 1`. The consumer stores the window atomically and begins forward draining with `after=resumeAfter`. Re-establishing a friendship, rejoining a group, or changing the relationship epoch for the same account MUST NOT move a saved feed cursor backward, substitute another cursor, or reset it.

The source stores no ACK for the consumer and does not enforce cursor monotonicity. It MAY establish a retained lower boundary when service capacity is insufficient and MAY remove message-index projections below that boundary. Any `after` within the advertised available window remains valid. An omitted cursor, a cursor below `resumeAfter`, or a cursor beyond the current end returns `FEDERATION_FEED_CURSOR_UNAVAILABLE` with the current `resumeAfter` and `resumeBefore`. The source MUST NOT return a successful empty page that conceals a pruned interval.

### 1.2 Page

```ts
interface MessageFeedPage {
  items: MessageFeedItem[];
  scannedThrough: DecimalString;
  messageFeedEndId: DecimalString;
  hasMore: boolean;
}

interface MessageFeedItem {
  feedId: PositiveDecimalString;
  thread: ThreadAddress;
  messageEndSeq: DecimalString;
}
```

The stable key is `(target peer, thread)`. For P2P, `thread.account` is the
source-hosted user and `thread.localAccount` is the target-peer-hosted user; the
two domains come from the authenticated exchange. For a group, `thread.account`
is the globally unique group account and `localAccount` is absent; the target
peer is not keyed separately by each member hosted on that peer.
Relationship status, expiry, re-request, re-acceptance, friendship restoration,
group leave, and group rejoin do not create a new stable key.

`messageEndSeq` is the inclusive thread-sequence upper bound currently committed
by the source and queryable through message query; it is not a feed cursor. For
the same stable key, every `messageEndSeq` exposed to the target peer MUST be
greater than or equal to every value previously exposed for that key. A source
MUST NOT reset, decrease, replace, or reuse that sequence-coordinate space
across relationship-state transitions. When the upper bound strictly increases,
the source MUST allocate a new `feedId` for that stable key that is greater than
every ID previously allocated in the feed, and replace the old item with the new
item. An equal or smaller `messageEndSeq` is a no-op.

`messageEndSeq` and outer message `seq` MUST be at most `SafeInteger - 1`.
Message-query `after`, `before`, `through`, and `scannedThrough` MUST be at most
`SafeInteger`. The query coordinates and `messageEndSeq` use decimal strings on
the wire; message `seq` uses a JSON integer.

The message feed is a durable compacted discovery index: the source may delete an old item superseded by an update. When service capacity is insufficient it MAY also prune older current stable-key projections and advance `resumeAfter`. Such pruning affects discovery only; it does not itself delete message entities or change thread-query retention. A consumer whose cursor falls behind the new boundary receives an explicit cursor-unavailable result and adopts the advertised window. Within that window, retained projections MUST remain discoverable from every valid `after`.

After a P2P friendship ends, the source MAY delete the current message-feed projection for that peer and thread. Deletion allocates no new `feedId` and does not move `messageFeedEndId` backward. The stable-key sets of message feed and tombstone feed are independent: a thread that has never produced a tombstone may exist only in message feed, and a consumer MUST NOT require both feeds to contain the same thread set or aligned end sequences. If the same relationship is re-established, the source MUST rebuild the projection with a new, larger `feedId`, even when the current `messageEndSeq` equals its value before deletion, so a consumer that passed the old item can discover it again.

Each page is computed from one consistent source snapshot:

```text
requestEnd = through is present ? min(through, messageFeedEndId) : messageFeedEndId
candidates = current items with feedId in (after, requestEnd], ordered by feedId
```

The source returns a prefix no larger than its page limit. If candidates remain, `scannedThrough` equals the last item `feedId` on the page and `hasMore: true`; otherwise, `scannedThrough=requestEnd` and `hasMore: false`. An empty page may advance directly to `requestEnd`. Every item lies in `(after, scannedThrough]` and is strictly increasing.

When compaction occurs between pages, a new item can receive only a larger `feedId`. It may exceed the frozen `through`, but MUST appear in a later feed head or reconciliation. It MUST NOT be rewritten in place with an ID less than or equal to the consumer's `after`, which would hide the change.

The consumer MUST validate the page, atomically merge the maximum `messageEndSeq` for each thread, and update its local feed cursor to `scannedThrough`. A feed page carries no message content and grants no read authorization. Relationship termination therefore does not carry a message-feed end ID in `RELATIONSHIP_INTENT/REVOKED`; current authorization is enforced by the thread query.

## 2. Message query

### 2.1 Thread-query union

`GET /s2s/v1/messages` uses a closed query. Common fields are `after`,
`before`, `through`, `take`, and `includeSelf`. `after` and `before` are optional
exclusive cursors and MUST NOT appear together. Omitting both bootstraps the
thread query; `take` and `through` then MUST also be omitted. With either cursor,
`through` is the fixed inclusive bound at the other end of the bounded query,
and `take` is the suggested maximum number of returned messages. All three
coordinates use non-negative `DecimalString` values no greater than
`SafeInteger`.

For a forward query, `after=A&through=T` covers `(A, T]`, requires `T >= A`,
and returns messages in increasing `seq` order. For a reverse query,
`before=B&through=T` covers `[T, B)`, requires `T <= B`, and returns messages in
decreasing `seq` order. An invalid combination or relation returns
`400 FEDERATION_MALFORMED`. The thread selector always contains `account`. Its
account grammar determines the thread kind; no separate type or mode parameter
is sent:

| Account kind   | Fields                    | Binding                                                                                           |
| -------------- | ------------------------- | ------------------------------------------------------------------------------------------------- |
| `UserAccount`  | `account`, `localAccount` | `account` is hosted by the source domain; `localAccount` is hosted by the verified signer domain. |
| `GroupAccount` | `account`                 | The globally unique `!` account identifies the origin thread or an authorized mirror.             |

For a `UserAccount` selector, `localAccount` MUST be present and MUST be a
`UserAccount`. For a `GroupAccount` selector, `localAccount` MUST be absent.

After normalization, the requested thread MUST exactly equal the feed item's
`ThreadAddress`. The source does not accept any domain parameter declared by the
requester. The peer domain comes only from the validated HTTP Message Signature,
and the selector MUST NOT address an identity belonging to an unrelated third
domain.

These query shapes use the same stable-key rule as the index feed. A P2P query
therefore continues the coordinate space for the same canonical user/user pair,
and a group query continues the coordinate space for the same group-address and
verified-peer pair, regardless of which users on that peer currently belong to
the group.

`includeSelf` is optional. Its wire value is lowercase `true` or `false`, and omission defaults to `true`. With `includeSelf=false`, the source omits messages whose `message.author.domain` equals the verified signer domain. This comparison uses only canonical Domain and MUST NOT be inferred from a local user ID, publisher-local `seq`, or `originSeq`. A filtered sequence is a scannable hole and does not prevent `scannedThrough` from advancing in the selected direction. The parameter affects only this page projection and does not delete a processing receipt, allocation proof, or message. The fixed query-key order is `account`, optional `localAccount`, `after`, `before`, `through`, `take`, then `includeSelf`; omitted optional fields leave no placeholder.

GROUP message query has exactly three valid directions:

- A member home server MAY return to the group origin only submissions authored by users in its own domain. The data is not an authoritative group fact until the origin validates and durably accepts it.
- The group origin MAY return an accepted authoritative timeline only to a peer that holds a mirror of the group.
- After a mirror durably persists an authoritative message pulled directly from the group origin, it SHOULD return its local durable copy to that origin as a processing receipt. If returned, it MUST be returned only to that origin. The copy's `originSeq/originCreatedAt` equals the origin item's `seq/createdAt`, allowing the origin to associate its earlier authoritative publication.

A mirror MUST NOT return a group message to a peer other than that message's direct publisher. A member home server likewise MUST NOT return a message authored outside its domain in a submission. Before generating a page, the source MUST distinguish the three directions using signer domain, group origin, author domain, durable group-membership facts, and the copy's direct origin. On receiving a processing receipt, the origin associates `(thread, author, originSeq)` with local `(thread, author, seq)`; it creates no message or new message-feed item and MUST NOT write back to the original message. The v1 group-message topology ends here: there is no protocol step for a mirror to relay to another peer or redistribute a receipt.

Omitting both `after` and `before` bootstraps this thread query. The source
returns `FEDERATION_FEED_CURSOR_UNAVAILABLE { resumeAfter, resumeBefore }` and no
messages. The two exclusive cursors describe the current open serviceable window
`(resumeAfter, resumeBefore)`. A forward query starts with
`after=resumeAfter`; a reverse query starts with `before=resumeBefore`.
If the first potentially serviceable sequence is `N`, `resumeAfter=N-1`; if the
last is `M`, `resumeBefore=M+1`. Neither adjacent sequence is guaranteed to
contain a message because the coordinate space may contain holes.
Re-establishing the same stable-key relationship does not create a smaller
query-coordinate space. `0` is the exclusive cursor before the first valid
message sequence. The minimum message sequence is `1`, but the source MAY begin
allocation at a larger value and need not allocate contiguously.

### 2.2 Query page

```ts
interface MessageQueryPage {
  messages: FederatedMessage[];
  scannedThrough: DecimalString;
  hasMore: boolean;
}
```

At request start, the source reads a consistent `currentMessageEndSeq`. A
forward query computes:

```text
queryEnd = through is present ? min(through, currentMessageEndSeq) : currentMessageEndSeq
candidates = messages authorized for the current peer whose content is retained and whose seq is in (after, queryEnd], ordered by seq
```

A reverse query computes:

```text
queryStart = through is present ? through : resumeAfter + 1
queryBefore = min(before, currentMessageEndSeq + 1)
candidates = messages authorized for the current peer whose content is retained and whose seq is in [queryStart, queryBefore), ordered by seq descending
```

The source returns a candidate prefix no larger than its local item/page-byte limits and valid `take`, without skipping a queryable message in that prefix. The source MAY return fewer but MUST NOT exceed the requested `take`. The source MUST be able to return an individually allocated message in full and MUST NOT skip it with a permanently empty page.

`take` is only an item-count suggestion. The source MUST accept any `PositiveSafeInteger` value and MAY return fewer items under finite local item/page-byte limits. It MUST NOT return `FEDERATION_MALFORMED` merely because `take` exceeds the local page size. One item MUST NOT be split across pages. Publishers and consumers MAY set separate finite local byte limits for JSON objects, pages, and durable JSON/JSONB; v1 defines no common numeric value. A publisher or consumer MUST NOT accept truncated JSON or a partial object as a valid application fact.

For a forward query, if candidates remain after the response,
`scannedThrough` equals the last returned message `seq` and `hasMore: true`;
otherwise, `scannedThrough=queryEnd` and `hasMore: false`. An empty page may
advance directly to `queryEnd`. Returned messages are strictly increasing and
lie in `(after, scannedThrough]`. The next page uses
`after=scannedThrough`.

For a reverse query, `scannedThrough` is direction-relative despite its name.
If candidates remain below the response, it equals the last and therefore
smallest returned message `seq` and `hasMore: true`; otherwise, it equals the
inclusive lower `through` bound and `hasMore: false`. Returned messages are
strictly decreasing and lie in `[scannedThrough, before)`. The next page uses
`before=scannedThrough`. An empty page may scan directly down to `through`.

Unallocated sequences, sequences not allocated to this peer, and positions with
an authoritative tombstone are scannable holes in either direction and do not
block `scannedThrough`. Continuous bounded pagination MUST retain the original
`through` and direction. Repeated GETs against the same snapshot and parameters
MUST be semantically idempotent.

The source MAY purge old message content under local retention policy. Let
`(resumeAfter, resumeBefore)` be the thread's current open serviceable window.
For a forward query with `after < resumeAfter`, or a reverse query with
`before <= resumeAfter + 1`, the source MUST return
`FEDERATION_FEED_CURSOR_UNAVAILABLE { resumeAfter, resumeBefore }`. A forward
consumer resumes with `after=resumeAfter`; a reverse consumer may restart the
currently serviceable history with `before=resumeBefore` or stop.

If `after >= resumeBefore`, `before > resumeBefore`, or the fixed `through`
falls outside the selected direction's serviceable window, the source MAY
return the same result to correct the query to the current window. Both resume
fields MUST come from one consistent snapshot. These rules MUST NOT be used to
skip message feed.

### 2.3 Consumer fast-forward

When starting or restarting a forward message-query drain, a consumer MAY
advance its local `after` cursor to a greater position because of finite local
storage or processing capacity. The selected position MUST be within the
source-advertised serviceable window and MUST NOT move a committed cursor
backward. The consumer MUST atomically persist the new cursor and treat every
skipped coordinate through that position as intentionally discarded.

A consumer that fast-forwards MUST NOT represent the skipped interval as
completely replicated or processed, generate a processing receipt for a skipped
message, or infer any source-side deletion or acknowledgement. This is a local
replication decision and does not alter source data, authorization, allocation
proofs, or query coordinates.

### 2.4 Authorization and state reconciliation

On every query, the source MUST recompute access from its durable authored relationship direction, group audience, block, thread authority, historical allocation proof, and local policy. The presence of a feed item is not authorization proof. For both user/user and user/group relationships, an unexpired source-authored `REQUESTED` or valid `ACCEPTED` grants the target peer query access without requiring the reverse direction. Before publishing either state, the source MUST have established every thread, audience, and authorization fact needed to serve that query. A newly requested thread with no allocated messages returns a successful empty page.

For the same stable key, `REQUESTED` and `ACCEPTED` grant identical message-query
permission. Receiving the reverse `ACCEPTED`, or otherwise transitioning from
`REQUESTED` to mutually confirmed `ACCEPTED`, MUST NOT expand, reset, shrink, or
replace that peer's queryable sequence-coordinate space solely because of the
confirmation. When the authored grant or required peer-level group audience is
invalid, the source MUST return `FORBIDDEN`. If the same stable-key relationship
is later re-established, its original query coordinates resume and MUST NOT
reset or shrink. While access is valid, only messages with durable allocation
proof granted to that peer during a historically valid audience may be returned.
Sequences not allocated during an absence are holes and MUST NOT be backfilled
on rejoin. Content-retention policy may still skip a purged prefix through
`resumeAfter` under Section 2.2.

After receiving relationship-termination state from state-feed, the consumer MUST invalidate the current message-feed target for that peer and thread and stop retrying its query. If state notification is delayed, lost, or not yet locally converged, message-query `FORBIDDEN` is the fallback signal: the consumer MUST stop that thread query, invalidate its current pending end, and prioritize draining state feed again. This handling does not move the global message-feed cursor backward or delete idempotently committed messages or historical query cursors.

Authorization calculation MAY materialize immediately derivable state from existing durable facts in the same local transaction, such as request expiration, friendship validity, or group-audience validity. This reconciliation MUST be idempotent and MUST NOT create an invitation, accept a friendship, join a group, or expand the current request's authorization merely because the peer issued a GET.

The consumer receives messages idempotently by `(source domain, thread, seq)`. Before inserting or displaying any message, it MUST first apply queried authoritative tombstones to prevent a late message from being resurrected. Media and forward bundles continue to use the exact message binding in [Resources](./resources.md).

### 2.4 Query-specific deferral results

When the request is correctly authenticated and peer lifecycle can continue, message query may use these HTTP `200` application results:

- `FEDERATION_QUOTA_EXCEEDED`: the quota defined for this operation is exhausted; carries only `{ retryAfter }`.
- `FEDERATION_MESSAGE_QUERY_RATE_LIMITED`: the current signer, thread, or query budget is receiving requests too frequently.
- `FEDERATION_MESSAGE_QUERY_TEMPORARILY_UNAVAILABLE`: query materialization, storage, or background reconciliation for the thread temporarily cannot provide a consistent page.

All three MUST carry `{ retryAfter }`, a non-negative integer number of seconds measured from complete receipt of the response. The consumer MUST NOT advance the message-query cursor or mark the peer `degraded`; it retries after waiting at least `retryAfter`, using locally bounded, jittered behavior. The latter two codes apply only to `GET /s2s/v1/messages`; the common quota code may also be used by other operations under their own documents. None may replace HTTP `503` for federation-wide service unavailability.
