# Federation Overview

SOMS federation v1 is a signed, pull-based protocol under `/api/v1`. The URL prefix is the protocol
version; bodies do not repeat a version field. The current endpoint-level contract is documented in
[federation-s2s-api.md](../api/federation-s2s-api.md), and the audited implementation baseline is in
[protocol-baseline.md](../federation/protocol-baseline.md).

## Identity and recovery

Nodes discover public keys through `/.well-known/soms`. First contact uses `POST /s2s/ignite`, which
atomically pins identity continuity and initializes state/message cursors. Subsequent requests are RFC
9421 signed.

Temporary signed-request failures may move a peer from `trusted` to `demoted`; they do not discard its
pinned identity. Recovery verifies `/s2s/identity`, performs a signed `/s2s/ping`, drains state, and then
drains messages. A changed root fingerprint, pairwise server identity, or identity epoch enters
`identity_lost` and requires an explicit administrator reset. An administrator `blocked` decision is a
durable policy state and cannot be overwritten by an in-flight ignite or heartbeat.

## State before messages

Every lightweight `POST /s2s/feed-rev` carries two decimal-string high-water marks:

- `stateFeedRev` for compacted relationship, profile, and group state;
- `messageFeedRev` for durable message discovery.

The receiver always commits `/s2s/state-feed` before requesting `/s2s/message-feed`. Wake-ups are
ephemeral and may be lost, duplicated, delayed, or reordered; startup and periodic reconciliation read
the source revisions again. Both receivers reject cursor rollback.

State pages and their cursor advance commit in one transaction. A malformed item rolls back the whole
page. The source compacts by event key and overwrites only with a strictly newer business revision.

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
does not embed member avatars. When a group origin learns a member profile update, it relays that profile
to the other member servers; leaving a group does not produce a profile-deletion event.

The user client exposes one `stateRevision` cursor for thread membership and cached profile changes.
`HELLO` and `STATE_REV_UPDATED` carry that name. The client applies profile state before membership state,
then processes the missed-message summary. There are no chat-open profile/meta revision probes.

## Message and media delivery

Messages allocate a durable per-peer discovery change in the same transaction as the message and its
audience. `/message-feed` carries ordered changes and advances with `scannedThrough`, including across
compaction or deletion gaps. Pulled messages are idempotent by stable author identity and `originSeq`.

For group leave, the leaving server first writes a structured `GROUP_LEFT` SYSTEM message, allocates its
change id, freezes the creator audience through that boundary, and only then closes membership. The
origin can therefore apply the final state snapshot first and still pull the boundary message afterward.
The origin keeps a member-server's thread audience open while that server has any active member, so a
rejoining local user sees history retained by the shared mirror. When its last member leaves, the origin
freezes that peer audience at the inclusive current change id. Rejoining reuses the mirror and resumes
future delivery, but deliberately does not backfill messages from the no-member interval.

SYSTEM messages contain only a structured event type and optional stable subject identity. Clients
render locale-specific text and time. Client-authored SYSTEM messages and message operations such as
forward, quote, report, or withdraw are rejected.

Media message persistence is independent from byte localization. Authorized CAS range downloads and
forward-bundle closure downloads validate the message/bundle binding. Durable pending-media rows survive
restart, quota pause, and transient chunk loss; a failed download does not block later message-feed cursor
progress.

## Current S2S surface

- `POST /s2s/ignite`
- `GET /s2s/identity`, `GET /s2s/ping`
- `POST|GET /s2s/feed-rev`
- `GET /s2s/state-feed-rev`, `GET /s2s/state-feed`
- `GET /s2s/message-feed`
- `POST /s2s/call`
- `GET /s2s/users/:account`
- `GET /s2s/get_file`
- `GET /s2s/forward-bundles/:bundleId`

The former S2S invite commands, `/init`, `/thread-access`, profile/meta probes, `/new-msg-map`, thread-level
message pulls, and `/miss-feed` are removed and intentionally not compatible.
