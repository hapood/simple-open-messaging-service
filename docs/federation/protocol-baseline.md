# SOMS Federation Implementation Baseline

> This is an implementation snapshot, not a data model that third-party nodes
> must reproduce. The [Federation Protocol v1](../../spec/v1/protocol.md) is the
> normative wire contract. Database fields, local limits, and background work in
> this document explain how SOMS satisfies that contract. See the
> [S2S API reference](../api/federation-s2s-api.md) for endpoint behavior.

## Public surface

| Method | Path                                | Authentication and purpose                                                             |
| ------ | ----------------------------------- | -------------------------------------------------------------------------------------- |
| `GET`  | `/.well-known/socfp`                | Public server identity, keys, and protocol discovery.                                  |
| `POST` | `/s2s/v1/recognize`                 | Establish one recognition direction and persistently schedule the reverse direction.   |
| `POST` | `/s2s/v1/healthy`                   | Check an existing recognized relationship without fetching keys for an unknown caller. |
| `POST` | `/s2s/v1/feed-heads`                | Lightweight state/message/tombstone end-ID wake-up.                                    |
| `GET`  | `/s2s/v1/state-feed`                | Profiles, directional relationship facts, and Group Meta feed-head hints.              |
| `GET`  | `/s2s/v1/group-meta`                | Per-peer full/delta group members, roles, and source-scoped profiles.                  |
| `GET`  | `/s2s/v1/message-feed`              | Durable message-discovery index.                                                       |
| `GET`  | `/s2s/v1/message-tombstone-feed`    | Durable deletion-discovery index.                                                      |
| `GET`  | `/s2s/v1/messages`                  | Query concrete messages by thread.                                                     |
| `GET`  | `/s2s/v1/message-tombstones`        | Query permanent authoritative deletion facts by thread.                                |
| `POST` | `/s2s/v1/call`                      | Relay ephemeral WebRTC lifecycle, SDP, and ICE data.                                   |
| `GET`  | `/s2s/v1/users/:account`            | Return the public profile required for first contact.                                  |
| `GET`  | `/s2s/v1/media/:digest`             | CAS Range download bound to exact message/thread ownership.                            |
| `GET`  | `/s2s/v1/forward-bundles/:bundleId` | Return an authorized immutable forwarding closure.                                     |

## Identity and trust

- Wire identity is `{ account, domain }`; database IDs never cross the wire.
- Each side of a P2P relationship has a local thread. A group uses its origin's
  `!account` as stable identity, while each participating server stores a mirror.
- `healthy` permits ordinary exchange. `degraded` retains the pinned identity but
  means recognition facts have not converged or the peer is temporarily
  unavailable.
- Restart recovery attempts `healthy` first. Missing directional facts trigger
  idempotent mutual `recognize`, followed by state and message reconciliation.
- A pinned-root conflict enters `halted` with an identity-mismatch reason. Signing
  certificate rotation authorized by the same root does not change identity.
  After DNS repair, an administrator may resume only the identical root; a new
  root requires destructive reset and fresh recognition.
- A late failure from an older network attempt cannot overwrite a newer successful
  health result.

### SOMS network boundary

This subsection is non-normative. SOMS discovery resolves SRV/apex records and
uses its native HTTP client for administrator-controlled peers. It does not reuse
the arbitrary-URL, SSRF-resistant link-preview connector. IP classification,
connect-time DNS pinning, and outbound firewalling are deployment choices, not
Federation v1 wire requirements.

## State consistency

- User/user friendship and user/group membership are derived from the same two
  directed account facts. A time-limited `REQUESTED` may expire and be recreated
  at a higher feed position. Initiating or accepting creates the local placeholder
  account and thread; later profile state fills its display fields.
- A peer `ACCEPTED` is valid only in a still-effective request flow: it either
  confirms the local `REQUESTED`, or completes a peer request already answered
  by the local `ACCEPTED`. Without either state it has no admission effect. It
  does not create an incoming request, and a foreign user stub never bypasses
  this gate.
- Accepting every new peer request publishes the local `ACCEPTED` at a new feed
  ID. Crossed requests and a valid peer `ACCEPTED` both upgrade a matching local
  `REQUESTED` to `ACCEPTED`. A direction already in `ACCEPTED` creates no echo.
- A newer local negative fact cannot be overwritten by a stale remote acceptance
  or group snapshot. Each authored direction remains independently controlled.
- Re-friending or rejoining need not wait for the peer to consume the removal.
  Stable-key compaction retains the newest revision. A group origin republishes
  `GROUP_META_FEED_HEAD` with the latest Group Meta `feedId` after new member
  records become visible.
- Group membership uses `RELATIONSHIP_INTENT`: group-to-user is the
  origin-authored direction and user-to-group is the member-authored direction.
  Group/group relationships are invalid. The group-meta feed aggregates the
  effective roster, roles, and source-scoped member profiles.
- A received pending request remains address-only until the local side accepts or
  independently initiates. Profile disclosure requires a locally published
  `ACCEPTED`; the publisher orders that item before `PROFILE` and
  `GROUP_META_FEED_HEAD`. The latter is applied only after pulling Group Meta.
- `PROFILE` has its own revision. Group-member display profiles are carried by
  the group-meta feed and are scoped by their publishing group origin.
- An unchanged body normally does not allocate another feed ID. Relationship
  confirmation may reindex `ACCEPTED`. An unchanged `PROFILE` business revision
  is reused. `GROUP_META_FEED_HEAD.groupMetaFeedEndId` is the latest Group Meta
  feed ID.
- Per-peer state feeds compact by stable key. Transport `feedId` and cursors are
  bigint values and provide the ordering coordinate for snapshots.
- Group Meta member `UPSERT` records contain complete roles and display
  profiles. Every record has a unique transport `feedId` and an independent
  stable-member `rev`; departures append `DELETE` records with both values
  advanced in their respective coordinate spaces.

## Messages and media

- Wake-ups carry no body. A receiver freezes three independent upper bounds and
  drains state, tombstones, then messages.
- Each feed has an independent `feedId` space and consumer-owned cursor. The
  source maintains no ACK or monotonic consumer cursor.
- Message and tombstone feeds are compacted `(peer, thread)` end-sequence indexes;
  per-thread queries return the concrete arrays.
- A third-party-authored relay message pulled from peer X is not reflected back to
  X, but may still be indexed for its author server or another authorized audience.
- Nullable `Message.originSeq` and `originServerTime` are local SOMS receipt
  storage, not required federation database fields.
- Unknown message content types make a message invalid. Index feeds contain no
  content payload.
- Group leave converges through state. While a server still has another active
  member, its shared mirror continues receiving history. When its last member
  leaves, the origin freezes that peer audience. Rejoining reuses the mirror and
  resumes new delivery without backfilling the unsubscribed interval.
- Message-body commit and media download are separate. Pending downloads survive
  restart; a quota pause stays recoverable and wakes after capacity is increased.
- CAS and forward-bundle access validates exact message/thread ownership and the
  digest or bundle binding.
- Resource authorization joins the signer's live thread audience and does not
  depend on a message-change row that garbage collection may remove.
- Current compacted projections are not evicted because of age, capacity, or
  restart. After a P2P relationship ends, each data-feed projection may omit the
  thread independently. Message-body retention may raise `resumeAfter`, while
  tombstone facts remain permanent.

## Current boundary

Federation v1 freezes the field and error model. JSON Schema and the conformance
tool ship with the specification and provide offline validation, but are not
runtime prerequisites.
