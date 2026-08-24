# SOMS Simple Open Messaging Federation Protocol S2S API Reference

> Non-normative reference for the current SOMS `/s2s/v1` implementation. The
> [Federation Protocol v1](../../spec/v1/protocol.md) is the normative wire
> contract.

Every S2S operation uses RFC 9421 HTTP Message Signatures. `recognize` establishes
recognition in both directions, `healthy` checks availability for an already
pinned identity, and ordinary data operations require converged mutual
recognition.

## Endpoints

| Method | Path                         | Purpose                                                                    |
| ------ | ---------------------------- | -------------------------------------------------------------------------- |
| `POST` | `/recognize`                 | Establish one recognition direction and schedule reverse recognition.      |
| `POST` | `/healthy`                   | Privacy-preserving availability check for a recognized peer.               |
| `POST` | `/feed-heads`                | Lossy wake-up containing three independent feed end IDs.                   |
| `GET`  | `/state-feed`                | Read the compacted snapshot-bearing state feed.                            |
| `GET`  | `/message-feed`              | Read the compacted `thread + messageEndSeq` index.                         |
| `GET`  | `/message-tombstone-feed`    | Read the compacted `thread + tombstoneEndSeq` index.                       |
| `GET`  | `/messages`                  | Query message bodies by thread and sequence window.                        |
| `GET`  | `/message-tombstones`        | Query authoritative deletion facts by thread and deletion-sequence window. |
| `POST` | `/call`                      | Relay ephemeral WebRTC lifecycle, SDP, and ICE signalling.                 |
| `GET`  | `/users/:account`            | Return the minimal public identity card needed for first contact.          |
| `GET`  | `/media/:digest`             | Download CAS content with exact-message authorization and Range support.   |
| `GET`  | `/forward-bundles/:bundleId` | Return an authorized immutable forward-bundle closure.                     |

Paths in this table are relative to `/s2s/v1`.

## Shared compacted-feed model

All three feeds accept optional `after`, `take`, and `through` parameters.
`after` is exclusive, `through` is inclusive, and a drain covers
`(after, through]`. A bootstrap request has no query parameters: when `after` is
omitted, `take` and `through` must also be omitted. The source returns the open
window `(resumeAfter, resumeBefore)`, not a page. A new SOMS feed starts after
`0`; its first item ID is `1`. Feed IDs are positive integers, while cursors and
end values are non-negative.

The source stores no consumer ACK, last-served position, or monotonic validation
cursor. A consumer may reread with an older or duplicate `after` and atomically
commits each page with its own cursor. All feeds are durable compacted projections
and do not raise a minimum `after` as history is cleaned. When the value for a
stable key advances, the source allocates a new feed-wide `feedId`; it must not
rewrite the value in place under its old ID.

## State feed

The state feed carries complete snapshots for `PROFILE`, `MEMBER_PROFILE`, the
account-generic `RELATIONSHIP_INTENT`, and origin-authoritative `GROUP_META`.
Consumers apply snapshots idempotently by stable key in `feedId` order.

Relationship query authorization is directional: an effective source-authored
`REQUESTED` or valid `ACCEPTED` lets the target peer query that source without
waiting for the reverse direction, and both states grant identical query
permission. Before publishing either state, the source has already established
the thread, audience, and authorization needed to serve the query. A new empty
thread returns an empty page.
For a new user friend request, profile disclosure opens with the locally
published `REQUESTED`. The publisher force-reindexes the current `PROFILE`
immediately after that relationship item, even when `profileRev` is unchanged,
so the receiver can populate its address-keyed pending card before acceptance.
Crossed requests and a valid peer acceptance upgrade a local `REQUESTED` to
`ACCEPTED`; that state keeps disclosure open. For acceptance-dependent group
visibility, the publisher orders `ACCEPTED`, then `PROFILE`, then `GROUP_META`, then complete
`MEMBER_PROFILE` snapshots for the roster visible to that peer. Unchanged member
snapshots are not reindexed when the effective projection already carries the
publisher's current `profileRev` or `rosterRev`. Only a missing or older
dependency receives a new feed ID; the ordering requirement applies to newly
allocated dependencies. Reusing a revision with different snapshot content is
invalid.

When a member is neither a friend visible to the target peer nor a member of any
shared group, the publisher removes `MEMBER_PROFILE` directly from the projection;
it does not publish a deletion item. The consumer performs mark-and-sweep from
the latest friendship and roster closure only after fully draining a fixed state
target. It must not sweep between pages or erase stable author addresses required
by historical messages.

Exact `/users/:account` lookup is a bounded proxy query and does not create a
remote account. Local initiation or acceptance creates the placeholder account
and thread; merely receiving a request or a `REVOKED` snapshot does not. An
unsolicited `ACCEPTED` is ignored for admission regardless of
stub existence. Accepting a new peer request always republishes the local
`ACCEPTED` with a new feed ID, even when its body is unchanged. All relationship
requests use absolute expiration no more than seven days away.
Expired `REQUESTED` entries may disappear silently. `REVOKED` has no expiry and
should be retained as capacity permits, but may later be omitted; live message
and resource authorization still rejects stale access.

The unified state delta sent to local SOMS clients also carries complete
`MEMBER_PROFILE` snapshots. Clients persist each snapshot by source peer and
address, then render group members in `(threadId, userId)` context without a
follow-up roster request. The server sweeps only after committing a complete
fixed-bound drain.

## Message and tombstone discovery

The message-feed stable key is `(peer, thread)` and each item contains only
`feedId`, `thread`, and `messageEndSeq`. The tombstone feed is symmetric and
contains `tombstoneEndSeq`. These end sequences are independent thread-local query
coordinates, not feed IDs. Message and tombstone arrays come only from their
respective query operations.

Thread queries accept either exclusive `after` for an increasing scan or
exclusive `before` for a decreasing scan, never both. `through` is the fixed
inclusive bound at the other end, and direction-relative `scannedThrough`
becomes the next cursor of the same kind. A cursor-unavailable result always
returns the open serviceable window `(resumeAfter, resumeBefore)`; forward
queries adopt the lower boundary and reverse queries adopt the upper boundary.

A message source may clean old bodies. If a requested position is outside the
serviceable window, it may return corrected `resumeAfter` and `resumeBefore`
boundaries. Tombstone facts and their deletion sequences are permanent; cleanup
cannot skip them.

Query `through` is the inclusive thread-sequence endpoint frozen for one bounded
drain, not a feed ID. Every page in that drain keeps the same value so concurrent
writes cannot make the task endless. `/messages` may return HTTP `200` with
`FEDERATION_MESSAGE_QUERY_RATE_LIMITED` or
`FEDERATION_MESSAGE_QUERY_TEMPORARILY_UNAVAILABLE`; both include a seconds-based
`retryAfter`, advance no query cursor, and do not change peer lifecycle state.

`/messages`, `/message-tombstones`, `/media/:digest`, and
`/forward-bundles/:bundleId` may return HTTP `200 FEDERATION_QUOTA_EXCEEDED`.
Its closed data shape is `{ retryAfter }`. The operation already supplies the
business context, so the protocol does not expose category, limit, unit, window,
or algorithm.

Both query operations recompute authorization for every request; a feed item is
not proof of access. Authorization may idempotently materialize effective state
derived from existing durable facts, but the GET itself must not create an invite,
accept a friendship, join a group, or broaden current access.

## Wake-up and drain order

```text
POST /feed-heads (S, M, D)
  -> GET /state-feed?after=<stateCursor>&through=S
  -> after state reaches S: GET /message-tombstone-feed?after=<tombstoneFeedCursor>&through=D
  -> GET /message-feed?after=<messageFeedCursor>&through=M
  -> merge per-thread tombstoneEndSeq and messageEndSeq
  -> GET /message-tombstones for each changed thread
  -> GET /messages for each changed thread
```

The thread sets in the message and tombstone indexes are independent. A thread
that has messages but no deletions normally appears only in the message feed.
After a P2P relationship ends, the source may remove that thread independently
from both projections. The consumer treats state-feed `REVOKED` as the primary
cleanup signal. If an older query first returns `FORBIDDEN`, it stops that thread
query and prioritizes a new state drain without rolling back the global feed
cursor.

`RELATIONSHIP_INTENT/REVOKED` carries no message or tombstone feed end ID. Those IDs appear
only in feed pages and `feed-heads`. Index feeds carry no message body, and a
relationship close no longer uses a feed end as a body-delivery boundary.

Federation thread coordinates survive relationship-state changes. P2P matches
the canonical source-user/target-peer-user pair; group delivery matches the
group address and target peer domain, not an individual member on that peer.
For either key, previously exposed message and tombstone sequence bounds never
decrease or reset after expiry, revocation, re-request, or confirmation.

Wake-ups may be lost, duplicated, or reordered, and their three coordinates may
be max-coalesced independently. Startup and periodic reconciliation read the feeds
in state, tombstone, message order even without a hint. An index that references
an unknown thread rolls back its page, drains state again, and retries. For one
thread, apply tombstones before messages; if they arrive in reverse order, pending
tombstones must still prevent resurrection.

## Calls and resources

`/call` carries ephemeral WebRTC/JSEP frames. Terminal call history remains an
ordinary `CALL` message. Media and forward bundles use exact message identity as
their authorization coordinate. After accepting a message query result, a
consumer may continue media localization with resumable Range requests; a later
resource failure does not invalidate that accepted result.
