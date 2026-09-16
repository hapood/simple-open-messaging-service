# Simple Open Messaging Federation Protocol v1 Message Query

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)
Normative scope: this entire document is normative.

This document defines the per-thread message-content query
`GET /s2s/v1/messages`. The compacted `thread + messageEndSeq +
tombstoneEndSeq` discovery projection is a `THREAD_CONTENT_HEAD` item in
[State Feed](./state-feed.md#6-thread_content_head). Authorization, message
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

After normalization, the requested thread MUST exactly equal the authorized
stable Thread Address. When a committed `THREAD_CONTENT_HEAD` exists, its
Thread Address MUST match; the absence of a head MUST NOT prevent a passive
query authorized by an effective intent. The source does not accept any
domain parameter declared by the
requester. The peer domain comes only from the validated HTTP Message Signature,
and the selector MUST NOT address an identity belonging to an unrelated third
domain.

These query shapes use the same stable-key rule as `THREAD_CONTENT_HEAD`. A P2P query
therefore continues the coordinate space for the same canonical user/user pair,
and a group query continues the coordinate space for the same group-address and
verified-peer pair, regardless of which users on that peer currently belong to
the group.

`includeSelf` is optional. Its wire value is lowercase `true` or `false`, and omission defaults to `true`.
With `includeSelf=false`, P2P omits `authorRef=THREAD_PEER_ACCOUNT`. When a group authority queries a
member home server's mirror, the mirror returns only messages authored by users managed in its own
domain; copies of all other group members are excluded, not just authors hosted by the requester.
For authoritative group distribution, `false` excludes authors hosted by the requesting member home
server. Filtering uses canonical author domains and the authenticated group direction, not local user
IDs or message coordinates. Group authorities MAY use `false` for a submission-only scan;
they MUST use `true` to consume mirror processing receipts as well as submissions,
in either forward or reverse scans. Mirrors MUST use `true` when pulling from the authority so their own
submissions can receive authoritative coordinate confirmation.

A filtered sequence is a scannable hole and does not prevent `scannedThrough` from advancing in the
selected direction. Receivers MUST independently reject unexpected mirror authors in new
submissions even if the sender ignores the filter. A processing receipt may name any
author of the origin's previously published target and follows Message Envelope Section 8.
Within an otherwise valid ordered page, malformed items are skipped with a bounded
warning and do not prevent processing later items or advancing the validated scan boundary. No message
or receipt is created for a skipped item. Invalid page boundaries, authentication failures, and local
storage failures MUST NOT be treated as skippable message errors.

The parameter affects only this page projection and does not delete a processing receipt,
history-policy decision, or message. The fixed query-key order is `account`, optional `peerAccount`,
`after`, `before`, `through`, `take`, then `includeSelf`; omitted optional fields leave no placeholder.

GROUP message query has exactly three valid directions:

- A member home server returns to the group origin only submissions authored by
  users in its own domain. These feed items are not authoritative group facts
  until the origin validates and durably accepts them.
- The group origin returns its accepted authoritative timeline to a member home
  server holding a mirror.
- A mirror MAY return to the group origin only non-authoritative copies pulled
  directly from that origin, as processing receipts.

Before generating a page, the source MUST distinguish a member submission,
authoritative distribution, and a processing receipt using the group authority,
signer domain, author domain, message direct source, and intent direction. A
mirror MUST NOT return a group message to a peer other than its group origin.
A member home server MUST NOT return a submission authored outside its own
domain. A feed query transports these durable items; it does not turn them into
requests.

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
message sequence. The source MUST begin its message coordinate space at `1`,
but later allocation need not be contiguous.

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

Unallocated sequences, positions omitted by the source's local history policy,
and positions with an authoritative tombstone are scannable holes in either
direction and do not block `scannedThrough`. The protocol does not require a
publisher to expose or suppress messages produced during a prior authorization
absence; that retained-history choice is implementation policy. Continuous
bounded pagination MUST retain the original
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

A consumer MAY initialize passive history from the simultaneous sequence pair
in an effective intent without waiting for a thread head. It MAY retain all,
some, or none of that available history. For an initial reverse query, it uses
`before=E+1`, where `E` is the selected intent snapshot's `messageEndSeq`.
It MUST apply the discard and tombstone safety rules below to any history it
elects to skip. This passive initialization does not waive the publisher's
obligation to publish an initialization head after relationship confirmation.

A consumer MAY enter skip mode after confirmation to retain only recent history,
or later when finite local storage or processing capacity
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
`THREAD_CONTENT_HEAD` projection MUST use the intent-based passive initialization
above rather than claim that it has committed a head-based tail.

A skip-mode consumer MUST atomically adopt `E` as its committed forward query
position and treat every skipped coordinate through that position as
intentionally discarded. It MUST NOT represent the skipped interval as
completely replicated or processed, generate a processing receipt for a skipped
message, or infer any source-side deletion or acknowledgement. This choice does
not alter source data, authorization, history policy, or query coordinates.

For a GROUP reverse reconstruction, the first message query starts with the
exclusive boundary `E+1` derived from the committed `messageEndSeq=E`. Later
pages continue only from successfully committed `scannedThrough` values. After
reconstruction, ordinary forward processing continues from the latest position
adopted before the reverse drain; reverse progress does not move that position
backward.

A reverse message batch is not reconciled until the consumer has applied the
required Group Meta state and every authoritative tombstone it has already
discovered for that batch. Display profiles MAY be resolved lazily per message
and do not block message-coordinate acceptance.

## 4. Authorization and state reconciliation

On every query, the source MUST recompute access from its durable authored
relationship direction, block state, thread authority, and local policy. The
presence of a `THREAD_CONTENT_HEAD` item is not authorization proof. A P2P query
requires an effective source-authored user-to-user
`REQUESTED` or `ACCEPTED` direction for the exact selector. A GROUP authoritative
distribution query requires at least one effective source-authored
group-to-member `REQUESTED` or `ACCEPTED` direction whose member belongs to the
verified signer peer. In the reverse direction, the signer MUST be the exact
authority of the mirrored group. That authority binding permits the origin to
query member submissions authored in the source domain and processing receipts
whose direct federation source is the origin; it does not require a
source-authored member-to-group intent. An effective `REQUESTED` expires at its
absolute `expiresAt`; an `ACCEPTED` remains effective until superseded.

The source MUST have established the stable thread and query state before
publishing the positive intent. A one-way grant authorizes passive querying but
MUST NOT publish `THREAD_CONTENT_HEAD` or another content wake
until the applicable relationship is confirmed. For GROUP, at least one member
hosted by that peer MUST remain confirmed.
`REQUESTED` and `ACCEPTED` grant identical query permission for the same stable
key. Confirmation or later reauthorization MUST NOT replace the stable thread's
sequence-coordinate space. If the same stable-key relationship is later
re-established, its original coordinate identity resumes. The publisher MAY expose retained
messages from before or during an authorization absence, or leave those
positions as holes, according to its local history policy. That choice MUST be
stable for a repeated query snapshot and MUST NOT bypass current authorization.
Content-retention policy may still skip a purged prefix through `resumeAfter`
under Section 2.2.

After receiving relationship-termination state from State Feed, the consumer MUST invalidate the current message target for that peer and thread and stop retrying its query. If state notification is delayed, lost, or not yet locally converged, message-query `FORBIDDEN` is the fast-convergence fallback signal. Before authoring a transition, the consumer MUST atomically revalidate the current relationship state. If that state has changed since the denied request began, the denial MUST NOT author a transition and the consumer MUST resume from current durable state.

When the revalidated state still authorizes the denied request, the consumer MUST stop every query direction for that peer and thread, invalidate its current pending ends, and publish `REVOKED` for each still-active direction authored by the consumer and covered by the denied peer authority. For P2P this is the consumer-authored user direction. For a GROUP owned by the peer, this is every local member-to-group direction. For a locally owned GROUP, this is every group-to-member direction whose member is hosted by that peer. The consumer MUST NOT manufacture or rewrite a peer-authored direction, and MUST NOT publish another transition for a direction that is already `REVOKED` or absent. It then prioritizes the resulting State Feed convergence. This handling does not move the State Feed cursor backward, delete idempotently committed messages, or discard already established query progress.

Authorization calculation MAY atomically derive immediately available state from existing authoritative facts, such as request expiration, friendship validity, or group-audience validity. This reconciliation MUST be idempotent and MUST NOT create an invitation, accept a friendship, join a group, or expand the current request's authorization merely because the peer issued a GET.

The consumer receives messages idempotently by `(source domain, thread, seq)`.
Every message carries a required, non-null author `profileRev`. A positive value
is an exact immutable profile reference; `0` means no profile and MUST NOT
trigger a profile request. A forward
consumer MAY fetch a bounded message interval concurrently with its bounded authoritative
tombstone drain, but it does not complete reconciliation of that interval until
both results have been applied. For a GROUP interval, it SHOULD first commit
the required role-and-profile-reference Group Meta coordinate. If Group Meta has not converged, the
stable author Address remains valid, the consumer MUST continue Group Meta
drain, and it MUST NOT infer a role or current-membership state. The consumer
MAY fetch display data using [Message Author Profile](./message-author-profile.md)
after accepting the message coordinate. For P2P thread display, the greatest
committed `seq` authored by the peer selects its carried `profileRev`; the
consumer MUST NOT compare revision numbers or let a self-authored message
replace the peer selection. Media and forward bundles continue to use the exact
message binding in [Resources](./resources.md).

For group member display, a consumer SHOULD keep the selected revision scoped
to `(group thread, author Address)`. Within that scope, the greatest committed
message `seq` authored by that member selects its carried `profileRev`.
Selection in one group MUST NOT replace the member display selection in another
group. This local materialization rule does not add member profile data to
Group Meta and does not change group-profile selection for the thread avatar.

## 5. Query-specific deferral results

When the request is correctly authenticated and peer lifecycle can continue, message query may use these HTTP `200` application results:

- `FEDERATION_QUOTA_EXCEEDED`: the quota defined for this operation is exhausted; carries only `{ retryAfter }`.
- `FEDERATION_MESSAGE_QUERY_RATE_LIMITED`: the current signer, thread, or query budget is receiving requests too frequently.
- `FEDERATION_MESSAGE_QUERY_TEMPORARILY_UNAVAILABLE`: query materialization, storage, or background reconciliation for the thread temporarily cannot provide a consistent page.

All three MUST carry `{ retryAfter }`, a non-negative integer number of seconds measured from complete receipt of the response. The consumer MUST NOT advance the message-query cursor or mark the peer `degraded`; it retries after waiting at least `retryAfter`, using locally bounded, jittered behavior. The latter two codes apply only to `GET /s2s/v1/messages`; the common quota code may also be used by other operations under their own documents. None may replace HTTP `503` for federation-wide service unavailability.
