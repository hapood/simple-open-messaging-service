# Simple Open Messaging Federation Protocol v1 Message Query

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)
Normative scope: this entire document is normative.

This document defines the per-thread message-content query
`GET /s2s/v1/messages`. The compacted `thread + messageEndSeq +
tombstoneEndSeq` discovery projection is a `THREAD_CONTENT_HEAD` item in
[State Feed](./state-feed.md#7-thread_content_head). Authorization, message
return, and content-retention policy are applied by the query operation. See
[Message](./message.md) for message schemas and [Protocol](./protocol.md) for
common rules.

## 1. Thread-query union

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

| Account kind   | Fields                   | Binding                                                                                          |
| -------------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| `UserAccount`  | `account`, `peerAccount` | `account` is hosted by the source domain; `peerAccount` is hosted by the verified signer domain. |
| `GroupAccount` | `account`                | The globally unique `!` account identifies the origin thread or an authorized mirror.            |

For a `UserAccount` selector, `peerAccount` MUST be present and MUST be a
`UserAccount`. For a `GroupAccount` selector, `peerAccount` MUST be absent.

After normalization, the requested thread MUST exactly equal the committed
`THREAD_CONTENT_HEAD` item's Thread Address. The source does not accept any
domain parameter declared by the
requester. The peer domain comes only from the validated HTTP Message Signature,
and the selector MUST NOT address an identity belonging to an unrelated third
domain.

These query shapes use the same stable-key rule as `THREAD_CONTENT_HEAD`. A P2P query
therefore continues the coordinate space for the same canonical user/user pair,
and a group query continues the coordinate space for the same group-address and
verified-peer pair, regardless of which users on that peer currently belong to
the group.

`includeSelf` is optional. Its wire value is lowercase `true` or `false`, and omission defaults to `true`. With `includeSelf=false`, the source omits messages whose reconstructed author domain equals the verified signer domain. For P2P this is exactly `authorRef=THREAD_PEER_ACCOUNT`. For GROUP it filters the messages of every member identity hosted by the verified peer, not merely one selected member or the member that caused authorization; this is determined by `message.author.domain` after canonical Domain validation. This comparison MUST NOT be inferred from a local user ID, publisher-local `seq`, or `originSeq`. A filtered sequence is a scannable hole and does not prevent `scannedThrough` from advancing in the selected direction. The parameter affects only this page projection and does not delete a processing receipt, allocation proof, or message. The fixed query-key order is `account`, optional `peerAccount`, `after`, `before`, `through`, `take`, then `includeSelf`; omitted optional fields leave no placeholder.

GROUP message query has exactly three valid directions:

- A member home server MAY return to the group origin only submissions authored by users in its own domain. The data is not an authoritative group fact until the origin validates and durably accepts it.
- The group origin MAY return an accepted authoritative timeline only to a peer that holds a mirror of the group.
- After a mirror durably persists an authoritative message pulled directly from the group origin, it SHOULD return its local durable copy to that origin as a processing receipt. If returned, it MUST be returned only to that origin. The copy's `originSeq/originCreatedAt` equals the origin item's `seq/createdAt`, allowing the origin to associate its earlier authoritative publication.

A mirror MUST NOT return a group message to a peer other than that message's direct publisher. A member home server likewise MUST NOT return a message authored outside its domain in a submission. Before generating a page, the source MUST distinguish the three directions using signer domain, group origin, author domain, durable group-membership facts, and the copy's direct origin. On receiving a processing receipt, the origin associates `(thread, author, originSeq)` with local `(thread, author, seq)`; it creates no message or new thread-content item and MUST NOT write back to the original message. The v1 group-message topology ends here: there is no protocol step for a mirror to relay to another peer or redistribute a receipt.

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

## 2. Query page

```ts
interface MessageQueryPage {
  messages: FederatedMessage[];
  scannedThrough: SafeInteger;
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
skip State Feed discovery. A forward consumer applies the common start and gap-recovery
rules in [Protocol Section 9.1](./protocol.md#91-feed-coordinate-vocabulary).

## 3. Consumer fast-forward and tail initialization

A consumer MAY enter skip mode either during initial synchronization to retain
only recent history, or later when finite local storage or processing capacity
makes its saved forward backlog impractical to drain. It MUST first converge
current state, complete a current Group Meta full drain for a GROUP thread, and
commit a current `THREAD_CONTENT_HEAD` item for the thread. Let that item's inclusive
`messageEndSeq` be `E`. The consumer adopts `E` as its new forward position and
MAY reconstruct only the history it chooses to retain. Its first reverse
message query uses the exclusive cursor `before=E+1`; this is the conversion of
the committed inclusive feed boundary, not an arbitrarily selected
intermediate cursor. If that cursor is no longer in the source's serviceable
window, the consumer applies the cursor-unavailable recovery rules and creates
new work from a newly reconciled thread-content boundary. A thread with no
`THREAD_CONTENT_HEAD` projection has no advertised message tail to reconstruct.

A skip-mode consumer MUST atomically adopt `E` as its committed forward query
position and treat every skipped coordinate through that position as
intentionally discarded. It MUST NOT represent the skipped interval as
completely replicated or processed, generate a processing receipt for a skipped
message, or infer any source-side deletion or acknowledgement. This choice does
not alter source data, authorization, allocation proofs, or query coordinates.

For a GROUP reverse reconstruction, message and departed-member profile windows
MUST both start with the exclusive boundary `E+1` derived from the same
committed `messageEndSeq=E`. Each actual reverse message batch ends at the
message response's direction-relative `scannedThrough`, including when the page
contains no message. The corresponding departed-member profile drain MUST cover
that same source-sequence window. Later pages continue only from successfully
committed `scannedThrough` values. A consumer MUST NOT bootstrap either query
at an unrelated intermediate `before`. After reconstruction, ordinary forward
processing continues from the latest position adopted before the reverse drain;
reverse progress does not move that position backward.

A reverse message batch is not reconciled until the consumer has applied the
required Group Meta state, the corresponding departed-member profile pages, and
every authoritative tombstone it has already discovered for that batch. An
unresolved message dependency prevents reconciliation until the message can be
accepted or an authoritative tombstone terminates it.

## 4. Authorization and state reconciliation

On every query, the source MUST recompute access from its durable authored relationship direction, group audience, block, thread authority, historical allocation proof, and local policy. The presence of a `THREAD_CONTENT_HEAD` item is not authorization proof. For both user/user and user/group relationships, an unexpired source-authored `REQUESTED` or valid `ACCEPTED` grants the target peer query access without requiring the reverse direction. Before publishing either state, the source MUST have established every thread, audience, and authorization fact needed to serve that query. A newly requested thread with no allocated messages returns a successful empty page.

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

After receiving relationship-termination state from State Feed, the consumer MUST invalidate the current message target for that peer and thread and stop retrying its query. If state notification is delayed, lost, or not yet locally converged, P2P message-query `FORBIDDEN` is the fast-convergence fallback signal: the consumer MUST stop that thread query and invalidate its current pending end. If both retained authored directions are still `REQUESTED` or `ACCEPTED`, the consumer MUST publish `REVOKED` for its own direction. It MUST NOT manufacture or rewrite the peer-authored direction, and it MUST NOT publish another transition if either retained direction is already `REVOKED` or absent. The consumer then prioritizes the resulting state convergence. This handling does not move the State Feed cursor backward, delete idempotently committed messages, or discard already established query progress. A GROUP query has no unique consumer-authored member direction at the peer boundary, so its `FORBIDDEN` stops the query and prioritizes state drain without authoring a relationship transition.

Authorization calculation MAY atomically derive immediately available state from existing authoritative facts, such as request expiration, friendship validity, or group-audience validity. This reconciliation MUST be idempotent and MUST NOT create an invitation, accept a friendship, join a group, or expand the current request's authorization merely because the peer issued a GET.

The consumer receives messages idempotently by `(source domain, thread, seq)`. A forward consumer MAY fetch a bounded message interval concurrently with its bounded authoritative tombstone drain, but it does not complete reconciliation of that interval until both results have been applied. For an ordinary forward GROUP interval, it SHOULD first commit the required Group Meta head, including complete profile-bearing `DEPART` items, and MUST NOT query the reverse-only [Departed Member Profile Feed](./departed-member-profile-query.md). If Group Meta has not converged, the stable author Address remains valid, the consumer MUST continue the Group Meta drain, and it MUST NOT infer a role or current-membership state from the absent profile projection. Reverse reconstruction MUST apply its corresponding departed-member profile page before completing reconciliation of the reconstructed window. Concurrent forward fetching does not permit a required reverse profile page to be bypassed. Media and forward bundles continue to use the exact message binding in [Resources](./resources.md).

## 5. Query-specific deferral results

When the request is correctly authenticated and peer lifecycle can continue, message query may use these HTTP `200` application results:

- `FEDERATION_QUOTA_EXCEEDED`: the quota defined for this operation is exhausted; carries only `{ retryAfter }`.
- `FEDERATION_MESSAGE_QUERY_RATE_LIMITED`: the current signer, thread, or query budget is receiving requests too frequently.
- `FEDERATION_MESSAGE_QUERY_TEMPORARILY_UNAVAILABLE`: query materialization, storage, or background reconciliation for the thread temporarily cannot provide a consistent page.

All three MUST carry `{ retryAfter }`, a non-negative integer number of seconds measured from complete receipt of the response. The consumer MUST NOT advance the message-query cursor or mark the peer `degraded`; it retries after waiting at least `retryAfter`, using locally bounded, jittered behavior. The latter two codes apply only to `GET /s2s/v1/messages`; the common quota code may also be used by other operations under their own documents. None may replace HTTP `503` for federation-wide service unavailability.
