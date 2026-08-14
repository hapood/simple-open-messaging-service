# Federation Overview

SOMS federation v1 is a signed, pull-based protocol under `/s2s/v1`. The URL prefix is the protocol
version; bodies do not repeat a version field. The current endpoint-level contract is documented in
[federation-s2s-api.md](../api/federation-s2s-api.md), and the audited implementation baseline is in
[protocol-baseline.md](../federation/protocol-baseline.md).

## Identity and recovery

Nodes discover the root public key, root-authorized signing-key certificates and supported major versions
through `/.well-known/soms`. First contact uses signed, idempotent `POST /s2s/v1/recognize` in both
directions. Ordinary data traffic opens only after both directions and local availability facts converge.

`POST /s2s/v1/healthy` checks an existing pinned relationship without becoming a key-fetch oracle.
Temporary transport failures move a peer from `healthy` to `degraded` without discarding its recognition
facts. A changed root enters `halted` with an identity-mismatch reason; normal root-authorized signing-key rotation does not. After
DNS is repaired, a SUPER_ADMIN may recover only the exact original pinned root. A genuinely new root
requires destructive reset and fresh bilateral recognition. `blocked` and `reset_in_progress` are durable
policy states that an in-flight recognition request cannot overwrite.

## Compacted synchronization feeds

Every lightweight `POST /s2s/v1/feed-heads` carries three independent feed end IDs for state, message
discovery, and tombstone discovery. Wake-ups may be lost, duplicated, delayed, or reordered; startup and
periodic reconciliation read all three feeds directly.

All three feeds are durable compacted projections. The source does not maintain consumer ACK cursors or
require monotonic `after`; the consumer commits each page with its own cursor atomically. State feed items
carry mergeable snapshots. Message and tombstone feed items carry only a thread address and the latest
query end sequence; concrete messages and deletion facts are fetched through per-thread GET queries.

## Relationship model

Friendship consists of two directed `FriendRequest` facts and one canonical unordered `FriendPair` lock.
Each direction owns its note, business revision, request timestamp, and expiry. A `REQUESTED` direction
is a live request only before its absolute `expiresAt`; it is never sufficient to activate a thread.
The default source lifetime is seven days and a receiver never renews it. Only two explicit `FRIEND`
directions activate or restore the local P2P thread. Closing one direction leaves the opposite fact
intact, so a later one-sided request can start a new confirmation exchange.

Group membership is also directional: the group origin authors `GROUP_INVITE_INTENT`, and the member
server authors `GROUP_JOIN_INTENT`. The origin's `GROUP_META` snapshot is the final roster authority. A
member server may create an inert local mirror when it receives an invitation, but it activates the local
participant and audience only after a newer origin snapshot confirms membership.

## Profiles and client state

`PROFILE` is an independently revisioned snapshot and may carry localized avatar bytes. `GROUP_META`
does not embed member avatars. A required `MEMBER_PROFILE` is indexed before the group revision that first
references it. Once a person is neither a local member's friend nor a shared-group member, the publisher
omits that profile from its current projection without a deletion item; the consumer garbage-collects
unreferenced source-scoped profiles only after a complete state drain.

The user client exposes one `stateRevision` cursor for thread membership and cached profile changes.
`HELLO` and `STATE_REV_UPDATED` carry that name. The client applies profile state before membership state,
then processes the missed-message summary. There are no chat-open profile/meta revision probes.

## Message and media delivery

`/s2s/v1/message-feed` and `/s2s/v1/message-tombstone-feed` are index-only compacted feeds. Their items
advance per-thread `messageEndSeq` and `tombstoneEndSeq`; `/s2s/v1/messages` and
`/s2s/v1/message-tombstones` return the concrete arrays after checking current durable authorization.
Pulled messages are idempotent by stable author identity and `originSeq`. Tombstone facts are permanent;
message bodies may be retained according to source policy and can return a corrected query `resumeAfter`.

For group leave, membership converges only through the state feed. The origin keeps a member-server's
thread audience open while that server has any active member, so a
rejoining local user sees history retained by the shared mirror. When its last member leaves, the origin
freezes that peer audience at the inclusive current change id. Rejoining reuses the mirror and resumes
future delivery, but deliberately does not backfill messages from the no-member interval.

The federation message query accepts only its documented content-type whitelist. Unknown values are
rejected uniformly; the index-only message feed never carries message content.

Media message persistence is independent from byte localization. Authorized CAS range downloads and
forward-bundle closure downloads validate the message/bundle binding. Durable pending-media rows survive
restart, quota pause, and transient chunk loss; a failed download does not block later message-feed cursor
progress.

## Voice and video calls

Endpoints use WebRTC/JSEP. Signed `/s2s/v1/call` frames relay the transient lifecycle, SDP, ICE and
in-place AUDIO-to-VIDEO upgrade; terminal history is an ordinary `CALL` message pulled through the message
feed. STUN/TURN selection and credentials stay between each endpoint and its home server. Federation relays
the resulting ICE candidates, including TURN `relay` candidates, without a credential exchange or
capability negotiation. See the normative [call specification](../../spec/v1/calls.md).

## Current S2S surface

- `GET /.well-known/soms`
- `POST /s2s/v1/recognize`
- `POST /s2s/v1/healthy`
- `POST /s2s/v1/feed-heads`
- `GET /s2s/v1/state-feed`
- `GET /s2s/v1/message-feed`
- `GET /s2s/v1/message-tombstone-feed`
- `GET /s2s/v1/messages`
- `GET /s2s/v1/message-tombstones`
- `POST /s2s/v1/call`
- `GET /s2s/v1/users/:account`
- `GET /s2s/v1/media/:digest`
- `GET /s2s/v1/forward-bundles/:bundleId`

This list is the complete v1 surface. Removed experimental paths and S2S invite commands are intentionally
not compatible.
