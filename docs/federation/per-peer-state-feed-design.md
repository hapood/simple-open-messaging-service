# Per-Peer State Feed Design History

> Historical implementation note, originally completed on 2026-08-08 and
> superseded by the final v1 state-feed contract. Use
> [Federation v1 State Feed](../../spec/v1/state-feed.md) for normative behavior
> and [the implementation baseline](./protocol-baseline.md) for current SOMS
> behavior.

## Problem it solved

Earlier federation behavior refreshed relationship, profile, and group metadata
when a chat was opened or after a business command. That coupled convergence to
UI activity and additional synchronous requests. The per-peer state feed replaced
those probes with a durable, compacted projection containing complete snapshots.

The core implementation decisions that survived into v1 are:

- each recognized peer has an independent state projection;
- a stable key retains only its newest complete body;
- business mutation, feed allocation, and projection update
  commit in one PostgreSQL transaction;
- feed IDs/cursors use bigint transport coordinates, while object revisions use
  integer business coordinates;
- lossy wake-ups only accelerate work; durable feed ends and consumer-owned
  cursors provide recovery;
- a receiver validates and applies an entire page with its cursor in one local
  transaction;
- group metadata is origin-authoritative and is followed by the complete member
  profile closure that it references;
- message/tombstone discovery remains independent from state convergence.

## Changes made by the final protocol

The early design used names such as `P2P_META`, `FRIEND`, and `NOT_FRIEND`. The
published contract uses one account-generic `RELATIONSHIP_INTENT` with
`REQUESTED`, `ACCEPTED`, and `REVOKED`. Requests have an absolute lifetime of at most
seven days. `REVOKED` itself has no expiration.

Message-feed and tombstone-feed authorization is directional. An effective
source-authored `REQUESTED` or valid `ACCEPTED` lets the target peer query that
source immediately, including an empty thread before acceptance; it does not
grant the reverse query direction. Crossed requests automatically upgrade
each local direction to `ACCEPTED`; a valid `ACCEPTED` also upgrades a matching
local `REQUESTED`. An already accepted direction never echoes another intent.
Profile, group-meta, and member-profile publication starts after that locally
published `ACCEPTED` and follows it in feed order. A feed-head
notification alone grants nothing.

The source no longer stores or validates a consumer ACK/cursor. Consumers own
their cursors and may reread old pages. Bootstrap returns a `resumeAfter` cursor,
and later drains use fixed inclusive `through` bounds.

`MEMBER_PROFILE` cleanup is projection omission rather than a deletion event.
The source removes a member after all visibility sources disappear. A consumer
may sweep source-scoped member profiles only after completely committing a fixed
state drain; it must preserve stable author addresses used by message history.

An exact account query does not materialize a remote account or thread. Those
objects appear when the local side initiates or accepts; state-feed
profiles follow that confirmation.

For relationship admission, `ACCEPTED` is valid only within a still-effective request
flow: it confirms a local request or completes a peer request already accepted
locally. An unsolicited `ACCEPTED` has no relationship effect and
cannot be promoted merely because the foreign user was already materialized.
Conversely, accepting a new peer request always reindexes the local `ACCEPTED`
at a new feed position, even when the body is unchanged, so a peer that passed
an earlier unsolicited snapshot receives a confirmation for the current flow.

`RELATIONSHIP_INTENT/REVOKED` does not carry message or tombstone feed ends. The data feeds
are separate compacted thread end-sequence indexes, and concrete content comes
from per-thread queries.

## Durable implementation constraints

These constraints remain useful when changing the SOMS implementation:

1. Allocate per-peer feed IDs while holding targets in a stable peer-domain lock
   order so multi-peer group transactions do not deadlock.
2. Route a removal to the union of peers visible before and after the mutation so
   the last remote member still receives the final authoritative snapshot.
3. Allocate no feed ID for an unchanged body except for relationship
   confirmation or dependency repair that requires a new scan position.
4. Publish a wake-up only after commit. Lost, duplicate, reordered, or stale
   wake-ups must not affect correctness.
5. The current receiver isolates self-contained invalid items. Page-envelope,
   ordering, local-storage, and consistency failures abort the current page.
   Do not perform secondary remote lookups while applying the page.
6. Cascade peer deletion through the projection, allocator, pull cursor, and
   remote mirror state. A reset identity cannot inherit old authorization or
   cursors.
7. Bound both item count and encoded bytes. Profiles and large rosters make a row
   count alone insufficient protection.

## Regression evidence to preserve

Tests should continue to cover stable-key compaction, independent peers, revision
idempotency, item isolation, page-failure recovery, wake-up loss/reordering,
group-before-member ordering, final group snapshots, multi-peer lock ordering,
oversized or invalid profile/roster data, page-level atomicity, deletion/reset,
and two-node convergence without chat-open probes or follow-up synchronization
POSTs.

The detailed proposed tables, provisional JSON bodies, migration sequence, and
pre-v1 endpoint shapes were intentionally removed from this note. They describe
an intermediate design and are recoverable from Git history if needed.
