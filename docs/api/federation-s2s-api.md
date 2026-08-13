# SOMS Federation S2S API

> Non-normative SOMS implementation reference for the current `/s2s/v1` surface. The normative
> wire contract is [Federation Protocol v1](../federation/spec/v1/protocol.md). Database fields, local
> limits and worker behavior described here are examples, not requirements on another implementation.

All S2S endpoints are RFC 9421 signed. `recognize` is the bootstrap operation, `healthy` is the
privacy-preserving availability operation, and ordinary data operations require converged bilateral
recognition facts. Wire identities are `{ account, domain }`; database ids never cross S2S.

## Endpoints

| Method | Path                         | Purpose                                                                        |
| ------ | ---------------------------- | ------------------------------------------------------------------------------ |
| `POST` | `/recognize`                 | Confirm one recognition direction and schedule the reverse direction.          |
| `POST` | `/healthy`                   | Return `healthy`, `degraded`, or privacy-preserving `unavailable`.             |
| `POST` | `/feed-heads`                | Ephemeral wake-up carrying the three independent feed end IDs.                 |
| `GET`  | `/state-feed`                | Pull compacted relationship/profile/group state after a feed ID.               |
| `GET`  | `/message-feed`              | Pull durable message discovery after a feed ID.                                |
| `GET`  | `/message-tombstone-feed`    | Pull durable withdrawals and effective moderation deletions.                   |
| `POST` | `/call`                      | Ephemeral WebRTC lifecycle, SDP/ICE and video-upgrade signalling.              |
| `GET`  | `/users/:account`            | Resolve a local user's public profile for first-contact lookup.                |
| `GET`  | `/media/:digest`             | Exact-message-authorized range download of a content-addressed asset.          |
| `GET`  | `/forward-bundles/:bundleId` | Authorized immutable forward-bundle closure.                                   |

## Wake-up and drain order

```text
POST /feed-heads
  → drain /state-feed completely
  → commit state page and state cursor atomically
  → drain /message-tombstone-feed
  → commit tombstone page and tombstone cursor atomically
  → drain /message-feed
  → commit message page and message cursor atomically
```

The POST is only a hint. Lost, duplicated and out-of-order hints are safe because startup and periodic
reconciliation directly request all three feeds. Advertised end IDs are max-coalesced and no pull cursor
may move backwards.

State, message, and tombstone feeds each have an independent per-peer feed-ID allocator and independent
ACK/pull cursors. A drain freezes `stateFeedEndId`, `tombstoneFeedEndId`, and `messageFeedEndId` as the
respective `through` bounds; an ID from one feed has no ordering meaning in another feed.

After a process restart the recovery sequence is:

```text
POST /healthy → state feed → message tombstone feed → message feed
```

`healthy` never establishes identity and never fetches an unknown signer's keys. Missing recognition
facts are repaired through idempotent bilateral `recognize`; a pure transport failure moves the peer to
`degraded` without erasing authorization. A root contradiction enters `halted` with an identity-mismatch reason. After DNS is
repaired, a SUPER_ADMIN may restore only the exact pinned root with a currently valid root-authorized
signing certificate. A genuinely new root still requires destructive reset and fresh recognition.

## State feed

Query parameters:

- `after`: exclusive feed cursor already committed by the receiver; omit it only for initial positioning.
- `take`: preferred scan size, capped or adjusted by the server; requires `after`.
- `through`: optional inclusive feed-ID upper bound; requires `after`.

A bootstrap request without `after` returns `FEDERATION_FEED_CURSOR_UNAVAILABLE` with an exclusive
`resumeAfter`; it returns no page. A successful response contains decimal strings `stateFeedEndId`,
`scannedThrough`, each item's `feedId`, and its independent business `revision`. Feed IDs and cursors are
BigInt decimal strings. Business revisions belong to stable keys and are not feed cursors.

Event keys and bodies:

- `PROFILE(account)`: public profile snapshot, including avatar bytes; applies only when its business
  revision is strictly newer than `remoteProfileRev`.
- `MEMBER_PROFILE(account)`: source-scoped display snapshot for a person visible through an explicit source.
- `P2P_INTENT(requester, target)`: one directed friend intent with `REQUESTED`, `ACCEPTED`, or `REVOKED`.
- `GROUP_INVITE_INTENT(group, member)`: origin's directed invitation fact.
- `GROUP_JOIN_INTENT(group, member)`: member's directed join/leave fact.
- `GROUP_META(group)`: origin-authoritative roster and group snapshot. Meta JSON does not contain member
  avatars; member profiles arrive as independently revisioned `MEMBER_PROFILE` items.

The feed is compacted by `(peer, eventType, account, subjectAccount)`. A same or older business revision
is a complete no-op: it does not rewrite the fact, refresh `updatedAt`, mutate a projection, allocate a
new feed revision, or trigger downstream state. A page is applied in one transaction; any invalid item
rolls back the entire page and cursor.

The state feed is likewise target-allocated, not filtered by who first proposed a fact. A peer may
receive a fact it originally published after the other side has persisted and confirmed, rejected, or
revision-bumped that direction. The receiver always merges by compacted key and business revision; it
must not discard an item merely because the underlying identity or proposal originated locally.

Friendship becomes active only when both directed facts are `FRIEND`. `REQUESTED` carries an absolute
expiry (default seven days), may be accepted only before that instant, and is treated as absent after
expiry so the same directional row can be recreated at a higher business revision. `FRIEND` and
`NOT_FRIEND` have no expiry. If a peer's established `FRIEND` arrives while the local direction is a
newer `NOT_FRIEND`, the receiver preserves the peer's standing consent but bumps and returns its local
`NOT_FRIEND`; it never silently reactivates the thread. A still-valid local `REQUESTED`, by contrast,
is promoted to `FRIEND` and returned as the confirmation.
The directional `note` is reused as request text for `REQUESTED` and as an optional removal/rejection
reason for `NOT_FRIEND` or `NOT_MEMBER`; send the empty string when there is no reason and never leak the
old request note into a terminal state.

Group membership uses two directions but the origin remains the roster authority. A mirror created by an
invitation is initially inactive; only a newer origin `GROUP_META` activates its participant and audience.
Invitation `REQUESTED` state expires; confirmed `MEMBER` state clears that TTL. Immediate leave→join is
legal before the origin observes the leave: compaction may expose only the newest JOIN, and the origin
must still resend authoritative `GROUP_META` even if its pair was already active. Conversely, a local
`NOT_MEMBER` wins over a stale roster entry and is revision-bumped back to the origin. There is no
member-profile delete event merely because a member leaves a group. The server-local 999-member policy is
not a wire-protocol constant; a full origin rejects by returning ordinary authoritative roster state.

## Message feed

Query parameters are optional `after`, `take`, `through`, and `excludeSelf`; the latter three require
`after`. A bootstrap request without `after` returns `FEDERATION_FEED_CURSOR_UNAVAILABLE` with the exact
exclusive `resumeAfter` to persist and use next. `take` is the
consumer's preferred scan size rather than a hard response limit; the source chooses the actual scan
size according to its capacity. The response contains ordered `messages`, `scannedThrough`, `hasMore`,
and optional `retryAfterMs`. If retained history moves beyond an old cursor, the source returns the same
`resumeAfter` result; successful pages do not expose allocation upper bounds or degradation metadata.

The feed is target-allocated, not filtered as “messages authored by someone else”. After SOMS commits a
message fetched from its author server, it allocates that self-authored item back to the author as a
delivery acknowledgement. `originSeq` identifies the author's published sequence and `createdAt` is the
receiving publisher's persistence time. The author matches it to its original message and does not insert
a duplicate. For a relayed message whose author differs from the immediate source peer, SOMS excludes
that source peer from the new allocation to prevent a direct reflection loop.

Messages carry stable author identity and source `originSeq`; receiver-local `seq` remains local. The feed
accepts only the content types defined by the federation schema and uniformly rejects unknown values.
Group membership changes converge through `GROUP_META` and membership state.

`after` may equal the current acknowledged cursor for retry or the last served cursor to confirm it.
Other values are rejected; callers cannot fast-forward. Feed IDs are strictly increasing but not contiguous,
and unacknowledged per-peer allocations are durable so process restart replays the same ID.

Media and forward-bundle authorization joins the signed peer's thread audience and then verifies the exact
message-to-digest/bundle binding. It does not depend on a message-feed change remaining after acknowledgement.

### SOMS receipt storage example

This subsection is implementation-specific. A newly authored SOMS `Message` keeps nullable
`originSeq` and `originServerTime` unset. While no receipt exists, the feed publisher serializes its
local `seq` as wire `originSeq`. When the self-authored item returns, SOMS stores its `originSeq` and the
item publisher's `createdAt` in those two columns. Other implementations may use a receipt table, an
event log, or no durable UI-facing receipt storage, provided their wire behavior and deduplication match
the protocol.

## Lightweight feed head body

```ts
type FeedHeadHint = {
  origin: string;
  stateFeedEndId: string;
  messageFeedEndId: string;
  tombstoneFeedEndId: string;
};
```

All three end IDs are BigInt decimal strings in independent feed spaces. `origin` must equal the verified
signer domain. The hint is not an acknowledgement and does not authorize cursor movement.

## Calls

Media uses WebRTC/JSEP; `/call` is the SOMS federation signaling plane, not SIP and not a media relay.
Its closed frame schema, lifecycle operations, four signal kinds and in-place AUDIO-to-VIDEO upgrade are
defined normatively by [Federation v1 Calls](../federation/spec/v1/calls.md). Real-time frames are
transient. Only the origin-authored terminal `CALL` message is durable and reaches the mirror through
the message feed. TURN URI and credentials stay between each endpoint and its own home server; federation
relays only the resulting `ice` frame, including `typ relay` candidates, and has no guest-credential
exchange or TURN capability negotiation.

## Media and forward assets

`media/:digest` supports HTTP Range. The signer domain comes only from the verified signature; query
parameters bind the stable author, source seq, thread recipient/group and optional forward bundle. The
server verifies the exact durable discovery allocation and digest membership before serving bytes.
Incoming media messages may commit as durable pending work while their files download;
download failure never rolls back an already admitted text/message-feed page. Quota-paused tasks stay
pending and are automatically re-driven after an administrator adds allowance.

Forward bundles are immutable manifest closures with bounded depth. The receiver verifies manifest
digests and separately downloads authorized binary assets through `media/:digest`.
