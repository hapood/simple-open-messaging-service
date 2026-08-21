# Simple Open Chat Federation Protocol v1 Message Feed and Query

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

When `after` is omitted, the source MUST return HTTP `200 FEDERATION_FEED_CURSOR_UNAVAILABLE` with data containing only `resumeAfter`. The source defines this value. The consumer MUST store it atomically and then request with that value as `after`. Re-establishing a friendship, rejoining a group, or changing the relationship epoch for the same account MUST NOT move a saved feed cursor backward, substitute another cursor, or reset it.

The source stores no ACK for the consumer and does not enforce cursor monotonicity. Any `after` in `[0, messageFeedEndId]` is a valid read position, including a duplicate or older position. The source may return `FEDERATION_FEED_CURSOR_UNAVAILABLE` with a valid `resumeAfter` only when `after` is omitted or clearly exceeds the current feed end. Compaction, holes, or cleanup of historical application data MUST NOT cause the message feed to return this result.

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

The stable key is `(target peer, thread)`. `messageEndSeq` is the inclusive thread-sequence upper bound currently committed by the source and queryable through message query; it is not a feed cursor. When a thread's upper bound strictly increases, the source MUST allocate a new `feedId` for that stable key that is greater than every ID previously allocated in the feed, and replace the old item with the new item. An equal or smaller `messageEndSeq` is a no-op.

`messageEndSeq`, message-query `after/through/scannedThrough`, and outer message `seq` MUST all be within the `SafeInteger` numeric range. The first four use decimal strings on the wire; message `seq` uses a JSON integer.

The message feed is a durable compacted index: the source may delete an old item superseded by an update. For a thread that still has a current audience, may still produce messages, or remains queryable, the source MUST NOT delete the current stable-key projection because of capacity, time, restart, or consumer read position. The current item MUST remain discoverable from any valid older `after`.

After a P2P friendship ends, the source MAY delete the current message-feed projection for that peer and thread. Deletion allocates no new `feedId` and does not move `messageFeedEndId` backward. The stable-key sets of message feed and tombstone feed are independent: a thread that has never produced a tombstone may exist only in message feed, and a consumer MUST NOT require both feeds to contain the same thread set or aligned end sequences. If the same relationship is re-established, the source MUST rebuild the projection with a new, larger `feedId`, even when the current `messageEndSeq` equals its value before deletion, so a consumer that passed the old item can discover it again.

Each page is computed from one consistent source snapshot:

```text
requestEnd = through is present ? min(through, messageFeedEndId) : messageFeedEndId
candidates = current items with feedId in (after, requestEnd], ordered by feedId
```

The source returns a prefix no larger than its page limit. If candidates remain, `scannedThrough` equals the last item `feedId` on the page and `hasMore: true`; otherwise, `scannedThrough=requestEnd` and `hasMore: false`. An empty page may advance directly to `requestEnd`. Every item lies in `(after, scannedThrough]` and is strictly increasing.

When compaction occurs between pages, a new item can receive only a larger `feedId`. It may exceed the frozen `through`, but MUST appear in a later feed head or reconciliation. It MUST NOT be rewritten in place with an ID less than or equal to the consumer's `after`, which would hide the change.

The consumer MUST validate the page, atomically merge the maximum `messageEndSeq` for each thread, and update its local feed cursor to `scannedThrough`. A feed page carries no message content and grants no read authorization. Relationship termination therefore does not carry a message-feed end ID in `P2P_INTENT/REVOKED`; current authorization is enforced by the thread query.

## 2. Message query

### 2.1 Thread-query union

`GET /s2s/v1/messages` uses a closed query. Common fields are `after`, `through`, `take`, and `includeSelf`. `after` is optional; `through` is the fixed inclusive `messageEndSeq` upper bound for this bounded drain; and `take` is the suggested maximum number of returned messages. `after` and `through` use non-negative `DecimalString` values no greater than `SafeInteger`. `take` and `through` may appear only with `after`; when present, `through` MUST satisfy `through >= after`, otherwise return `400 FEDERATION_MALFORMED`. The thread MUST have exactly one of these mutually exclusive shapes:

| Mode  | Required fields                             | Binding                                                                                          |
| ----- | ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| P2P   | `type=P2P`, `account`, `peerAccount`        | `account` is hosted by the source domain; `peerAccount` is hosted by the verified signer domain. |
| GROUP | `type=GROUP`, `groupAccount`, `groupDomain` | Complete group address; the source MUST hold the origin thread or an authorized mirror.          |

Fields from the two shapes MUST NOT be mixed. After normalization, the requested thread MUST exactly equal the feed item's `ThreadAddress`. The source does not accept a peer domain declared by the requester; that domain comes only from the validated HTTP Message Signature.

`includeSelf` is optional. Its wire value is lowercase `true` or `false`, and omission defaults to `true`. With `includeSelf=false`, the source omits messages whose `message.author.domain` equals the verified signer domain. This comparison uses only canonical Domain and MUST NOT be inferred from a local user ID, publisher-local `seq`, or `originSeq`. A filtered sequence is a scannable hole and does not prevent `scannedThrough` from advancing. The parameter affects only this page projection and does not delete a processing receipt, allocation proof, or message. The fixed query-key order is the thread-shape fields, `after`, `through`, `take`, then `includeSelf`; omitted optional fields leave no placeholder.

GROUP message query has exactly three valid directions:

- A member home server MAY return to the group origin only submissions authored by users in its own domain. The data is not an authoritative group fact until the origin validates and durably accepts it.
- The group origin MAY return an accepted authoritative timeline only to a peer that holds a mirror of the group.
- After a mirror durably persists an authoritative message pulled directly from the group origin, it SHOULD return its local durable copy to that origin as a processing receipt. If returned, it MUST be returned only to that origin. The copy's `originSeq/originCreatedAt` equals the origin item's `seq/createdAt`, allowing the origin to associate its earlier authoritative publication.

A mirror MUST NOT return a group message to a peer other than that message's direct publisher. A member home server likewise MUST NOT return a message authored outside its domain in a submission. Before generating a page, the source MUST distinguish the three directions using signer domain, group origin, author domain, durable group-membership facts, and the copy's direct origin. On receiving a processing receipt, the origin associates `(thread, author, originSeq)` with local `(thread, author, seq)`; it creates no message or new message-feed item and MUST NOT write back to the original message. The v1 group-message topology ends here: there is no protocol step for a mirror to relay to another peer or redistribute a receipt.

Omitting `after` bootstraps this thread query. The source returns `FEDERATION_FEED_CURSOR_UNAVAILABLE { resumeAfter }` and no messages. The source defines this starting point from the thread, verified peer, current relationship state, and retention policy; the protocol does not require `0`. Re-establishing a friendship for the same account or rejoining a group does not create a smaller query-coordinate space and does not allow the consumer to replace a committed position with a smaller `after`. `0` is the exclusive cursor before the first valid message sequence. The minimum message sequence is `1`, but the source MAY begin allocation at a larger value and need not allocate contiguously.

### 2.2 Query page

```ts
interface MessageQueryPage {
  messages: FederatedMessage[];
  scannedThrough: DecimalString;
  hasMore: boolean;
}
```

At request start, the source reads a consistent `currentMessageEndSeq` and computes:

```text
queryEnd = through is present ? min(through, currentMessageEndSeq) : currentMessageEndSeq
candidates = messages authorized for the current peer whose content is retained and whose seq is in (after, queryEnd], ordered by seq
```

The source returns a candidate prefix no larger than its local item/page-byte limits and valid `take`, without skipping a queryable message in that prefix. The source MAY return fewer but MUST NOT exceed the requested `take`. The source MUST be able to return an individually allocated message in full and MUST NOT skip it with a permanently empty page.

`take` is only an item-count suggestion. The source MUST accept any `PositiveSafeInteger` value and MAY return fewer items under finite local item/page-byte limits. It MUST NOT return `FEDERATION_MALFORMED` merely because `take` exceeds the local page size. One item MUST NOT be split across pages. Publishers and consumers MAY set separate finite local byte limits for JSON objects, pages, and durable JSON/JSONB; v1 defines no common numeric value. A publisher or consumer MUST NOT accept truncated JSON or a partial object as a valid application fact.

If candidates remain after the response, `scannedThrough` equals the last returned message `seq` and `hasMore: true`; otherwise, `scannedThrough=queryEnd` and `hasMore: false`. An empty page with no candidate advances directly to `queryEnd`. Returned messages are strictly increasing by source-thread `seq` and all lie in `(after, scannedThrough]`. Unallocated sequences, sequences not allocated to this peer, and positions with an authoritative tombstone are scannable holes and do not block `scannedThrough`. Continuous bounded pagination MUST retain the original `through`. Repeated GETs against the same snapshot and parameters MUST be semantically idempotent.

The source MAY purge old message content under local retention policy. When `after` precedes the thread's current serviceable exclusive floor, the source MAY return `FEDERATION_FEED_CURSOR_UNAVAILABLE { resumeAfter }`; the consumer may atomically adopt it only when `resumeAfter > after`. If `after` clearly exceeds the current thread end, the source MAY return a strictly smaller valid `resumeAfter` to correct the out-of-range position. Each rule applies only to its explicit condition and MUST NOT be used to skip message feed.

### 2.3 Authorization and state reconciliation

On every query, the source MUST recompute access from durable current friendship, group membership, block, thread authority, historical allocation proof, and local policy. The presence of a feed item is not authorization proof. When the current P2P relationship or peer-level group audience is invalid, the source MUST return `FORBIDDEN`. After a relationship for the same account is re-established, the original query coordinates resume; the coordinate space MUST NOT reset or shrink. While the relationship is valid, only messages with durable allocation proof granted to that peer during a historically valid audience may be returned. Sequences not allocated during an absence are holes and MUST NOT be backfilled on rejoin. Content-retention policy may still skip a purged prefix through `resumeAfter` under Section 2.2.

After receiving relationship-termination state from state-feed, the consumer MUST invalidate the current message-feed target for that peer and thread and stop retrying its query. If state notification is delayed, lost, or not yet locally converged, message-query `FORBIDDEN` is the fallback signal: the consumer MUST stop that thread query, invalidate its current pending end, and prioritize draining state feed again. This handling does not move the global message-feed cursor backward or delete idempotently committed messages or historical query cursors.

Authorization calculation MAY materialize immediately derivable state from existing durable facts in the same local transaction, such as request expiration, friendship validity, or group-audience validity. This reconciliation MUST be idempotent and MUST NOT create an invitation, accept a friendship, join a group, or expand the current request's authorization merely because the peer issued a GET.

The consumer receives messages idempotently by `(source domain, thread, seq)`. Before inserting or displaying any message, it MUST first apply queried authoritative tombstones to prevent a late message from being resurrected. Media and forward bundles continue to use the exact message binding in [Resources](./resources.md).

### 2.4 Query-specific deferral results

When the request is correctly authenticated and peer lifecycle can continue, message query may use these HTTP `200` application results:

- `FEDERATION_QUOTA_EXCEEDED`: the quota defined for this operation is exhausted; carries only `{ retryAfter }`.
- `FEDERATION_MESSAGE_QUERY_RATE_LIMITED`: the current signer, thread, or query budget is receiving requests too frequently.
- `FEDERATION_MESSAGE_QUERY_TEMPORARILY_UNAVAILABLE`: query materialization, storage, or background reconciliation for the thread temporarily cannot provide a consistent page.

All three MUST carry `{ retryAfter }`, a non-negative integer number of seconds measured from complete receipt of the response. The consumer MUST NOT advance the message-query cursor or mark the peer `degraded`; it retries after waiting at least `retryAfter`, using locally bounded, jittered behavior. The latter two codes apply only to `GET /s2s/v1/messages`; the common quota code may also be used by other operations under their own documents. None may replace HTTP `503` for federation-wide service unavailability.
