# SOMS Federation S2S API

> Non-normative SOMS implementation reference for the current `/s2s/v1` surface. The normative
> wire contract is [Federation Protocol v1](../federation/spec/v1/protocol.md). Database fields, local
> limits and worker behavior described here are examples, not requirements on another implementation.

All endpoints except `ignite` and the public identity proof are RFC 9421 signed and gated by the
pinned peer identity. Wire identities are `{ account, domain }`; database ids never cross S2S.

## Endpoints

| Method | Path                         | Purpose                                                                        |
| ------ | ---------------------------- | ------------------------------------------------------------------------------ |
| `POST` | `/ignite`                    | First-contact trust establishment and cursor initialization.                   |
| `GET`  | `/identity`                  | Nonce-bound signed server identity proof.                                      |
| `POST` | `/feed-revisions`            | Ephemeral wake-up carrying decimal-string `stateFeedRev` and `messageFeedRev`. |
| `GET`  | `/state-feed`                | Pull compacted relationship/profile/group state after a revision.              |
| `GET`  | `/message-feed`              | Pull durable message discovery after a change revision.                        |
| `POST` | `/call`                      | Ephemeral WebRTC lifecycle, SDP/ICE and video-upgrade signalling.              |
| `GET`  | `/users/:account`            | Resolve a local user's public profile for first-contact lookup.                |
| `GET`  | `/media/:digest`             | Exact-message-authorized range download of a content-addressed asset.          |
| `GET`  | `/forward-bundles/:bundleId` | Authorized immutable forward-bundle closure.                                   |

## Wake-up and drain order

```text
POST /feed-revisions
  → drain /state-feed completely
  → commit state page and state cursor atomically
  → drain /message-feed
  → commit message page and message cursor atomically
```

The POST is only a hint. Lost, duplicated and out-of-order hints are safe because startup and periodic
reconciliation directly request both feeds; each page carries its source HWM. Advertised revisions are
max-coalesced and neither pull cursor may move backwards.

After a process restart the recovery sequence is:

```text
GET /identity → state feed → message feed
```

The nonce-bound identity request succeeds only with the previously pinned signing key and restores an
existing demoted trust edge. It never establishes a new identity. A fingerprint conflict enters
`identity_lost` and stops all automatic traffic. After DNS is repaired, a SUPER_ADMIN may explicitly
probe and restore the trust edge only when root fingerprint, signing key and pairwise ID all match the
original pin; this preserves `trustedAt`, cursors, mirrors and authorization. A genuinely new identity
still requires destructive reset.

## State feed

Query parameters:

- `after`: unsigned decimal revision already committed by the receiver.
- `take`: page item limit, capped by the server.

The response contains decimal strings `stateFeedRev`, `scannedThrough`, item `rev`, and business
`revision`. Feed revisions/cursors are bigint because they are unbounded transport allocators. Business
revisions are int because they belong to one bounded row and are validated as safe integers.

Event keys and bodies:

- `PROFILE(account)`: public profile snapshot, including avatar bytes; applies only when its business
  revision is strictly newer than `remoteProfileRev`.
- `P2P_META(requester, target)`: one directed friend fact with `REQUESTED`, `FRIEND`, or `NOT_FRIEND`.
- `GROUP_INVITE_INTENT(group, member)`: origin's directed invitation fact.
- `GROUP_JOIN_INTENT(group, member)`: member's directed join/leave fact.
- `GROUP_META(group)`: origin-authoritative roster and group snapshot. Meta JSON does not contain member
  avatars; member profiles arrive as independently revisioned `PROFILE` items.

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

Query parameters are `after` and `take`. The response contains `allocatedThrough`, `scannedThrough`,
ordered changes, and a required nullable `degradation` field. `degradation.kind = HISTORY_TRUNCATED`
means the publisher explicitly discarded history through the reported cursor; this is an exceptional
service degradation, not normal bounded-buffer behavior.

The feed is target-allocated, not filtered as “messages authored by someone else”. After SOMS commits a
message fetched from its author server, it allocates that self-authored item back to the author as a
delivery acknowledgement. `originSeq` identifies the author's published sequence and `createdAt` is the
receiving publisher's persistence time. The author matches it to its original message and does not insert
a duplicate. For a relayed message whose author differs from the immediate source peer, SOMS excludes
that source peer from the new allocation to prevent a direct reflection loop.

Messages carry stable author identity and source `originSeq`; receiver-local `seq` remains local. The feed
accepts only the content types defined by the federation schema and uniformly rejects unknown values.
Group membership changes converge through `GROUP_META` and membership state.

`after` may repeat the current acknowledged cursor for retry but cannot move behind the retained floor.
Change IDs are strictly increasing, not contiguous. A full source buffer freezes new allocation and waits
for acknowledgement; it does not normally prune unacknowledged history. An exceptional explicit history
truncation raises the retained floor, returns `FEDERATION_MISSED_CURSOR_INVALID` to an old cursor, and is
subsequently visible in every page's `degradation` field.

Media and forward-bundle authorization joins the signed peer's thread audience and then verifies the exact
message-to-digest/bundle binding. It does not depend on a message-feed change remaining after acknowledgement.

### SOMS receipt storage example

This subsection is implementation-specific. A newly authored SOMS `Message` keeps nullable
`originSeq` and `originServerTime` unset. While no receipt exists, the feed publisher serializes its
local `seq` as wire `originSeq`. When the self-authored item returns, SOMS stores its `originSeq` and the
item publisher's `createdAt` in those two columns. Other implementations may use a receipt table, an
event log, or no durable UI-facing receipt storage, provided their wire behavior and deduplication match
the protocol.

## Lightweight feed revision body

```ts
type FeedRevisionHint = {
  origin: string;
  stateFeedRev: string;
  messageFeedRev: string;
};
```

Both revisions are unsigned decimal strings. `origin` must equal the verified signer domain.

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
