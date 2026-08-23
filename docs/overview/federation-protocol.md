# Federation Overview

SOMS federation v1 is a signed, pull-based protocol under `/s2s/v1`. The URL prefix is the protocol
version; bodies do not repeat a version field. The current endpoint-level contract is documented in
[federation-s2s-api.md](../api/federation-s2s-api.md), and the audited implementation baseline is in
[protocol-baseline.md](../federation/protocol-baseline.md).

## Identity and recovery

Nodes discover the root public key, root-authorized signing-key certificates and supported major versions
through `/.well-known/socfp`. First contact uses signed, idempotent `POST /s2s/v1/recognize` in both
directions. Each effective authored direction independently opens the source's data to its target peer; the reverse direction controls only the reverse query.

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

User/user friendship and user/group membership use the same two directed account
facts. Each direction owns its note, request timestamp, and expiry. A
`REQUESTED` direction is live only before its absolute `expiresAt`; its publisher
creates a local placeholder thread and immediately grants the target peer query
access. The default lifetime is seven days and a receiver never renews it. The
receiving side creates its thread when it accepts or independently initiates.
Group/group relationships are invalid.

Expiry removes authorization at the timestamp itself. A later source-side sweep may compact the
already-expired authored direction to `REVOKED` and publish that newer fact; a receiver never creates
or publishes a revocation on behalf of the remote author.

On the federation wire, peer `ACCEPTED` is valid only in a still-effective
request flow: it confirms a local request or completes a peer request already
accepted locally. A valid confirmation of the local `REQUESTED` upgrades and
publishes the local direction as `ACCEPTED`. Otherwise it is ignored for
admission and does not become an incoming request, and cannot materialize or
activate a relationship merely because a foreign account row exists. Accepting
each new peer request republishes the local `ACCEPTED` with a new feed ID, even
if the body is unchanged.

Every direction is independently authored. `REQUESTED` creates the initiating
side's local thread and authorization; `ACCEPTED` creates the accepting side's
thread and authorization. Crossed requests automatically upgrade each local
direction to `ACCEPTED`; a valid peer `ACCEPTED` likewise upgrades a matching
local `REQUESTED`, while an already accepted direction publishes no echo.
Each effective direction independently authorizes queries against its publisher.
A one-sided request therefore lets its recipient query the requester's new,
possibly empty thread, while the reverse query remains forbidden. The received
request itself remains address-only locally until local action.

## Profiles and client state

`PROFILE` is an independently revisioned snapshot and may carry localized avatar
bytes. It is published only after the local direction publishes `ACCEPTED`
through explicit acceptance, crossed requests, or valid peer confirmation.
`GROUP_META_FEED_HEAD.groupMetaFeedEndId` carries the target group feed's latest
`feedId`.
The separate `/s2s/v1/group-meta` feed carries members, roles, and source-scoped
display profiles. Full and Delta use the common `after/take/through` pagination
contract; Delta includes explicit `DELETE` records for departed members. A
Delta cursor older than retained history falls back to a bounded Full
replacement through the standard `resumeAfter/resumeBefore` window.
Different group origins may publish different display projections for the same
member address, so receivers cache them by source origin plus member address.

The user client exposes one `stateRevision` cursor for thread membership and cached profile changes.
`HELLO` and `STATE_REV_UPDATED` carry that name. The client applies relationship,
profile and group-member state in dependency order, then
processes the missed-message summary. There are no chat-open profile/meta
revision probes.

## Message and media delivery

`/s2s/v1/message-feed` and `/s2s/v1/message-tombstone-feed` are index-only compacted feeds. Their items
advance per-thread `messageEndSeq` and `tombstoneEndSeq`; `/s2s/v1/messages` and
`/s2s/v1/message-tombstones` return the concrete arrays after checking current durable authorization.
Pulled messages are idempotent by stable author identity and `originSeq`.
Thread queries scan forward with exclusive `after` or backward with exclusive
`before`; `through` is the fixed inclusive opposite bound. Cursor-unavailable
results always return the open serviceable window
`(resumeAfter, resumeBefore)`. Tombstone facts are permanent; message bodies may
be retained according to source policy and can return corrected window bounds.

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

- `GET /.well-known/socfp`
- `POST /s2s/v1/recognize`
- `POST /s2s/v1/healthy`
- `POST /s2s/v1/feed-heads`
- `GET /s2s/v1/state-feed`
- `GET /s2s/v1/group-meta`
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
