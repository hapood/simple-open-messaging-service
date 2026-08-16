# SOMS Federation Implementation Baseline

> This is an implementation snapshot, not a data model that third-party nodes
> must reproduce. The [Federation Protocol v1](../../spec/v1/protocol.md) is the
> normative wire contract. Database fields, local limits, and background work in
> this document explain how SOMS satisfies that contract. See the
> [S2S API reference](../api/federation-s2s-api.md) for endpoint behavior.

## Public surface

| Method | Path | Authentication and purpose |
| --- | --- | --- |
| `GET` | `/.well-known/socfp` | Public server identity, keys, and protocol discovery. |
| `POST` | `/s2s/v1/recognize` | Establish one recognition direction and persistently schedule the reverse direction. |
| `POST` | `/s2s/v1/healthy` | Check an existing recognized relationship without fetching keys for an unknown caller. |
| `POST` | `/s2s/v1/feed-heads` | Lightweight state/message/tombstone end-ID wake-up. |
| `GET` | `/s2s/v1/state-feed` | Profiles, directional friendship/group facts, and origin group snapshots. |
| `GET` | `/s2s/v1/message-feed` | Durable message-discovery index. |
| `GET` | `/s2s/v1/message-tombstone-feed` | Durable deletion-discovery index. |
| `GET` | `/s2s/v1/messages` | Query concrete messages by thread. |
| `GET` | `/s2s/v1/message-tombstones` | Query permanent authoritative deletion facts by thread. |
| `POST` | `/s2s/v1/call` | Relay ephemeral WebRTC lifecycle, SDP, and ICE data. |
| `GET` | `/s2s/v1/users/:account` | Return the public profile required for first contact. |
| `GET` | `/s2s/v1/media/:digest` | CAS Range download bound to exact message/thread ownership. |
| `GET` | `/s2s/v1/forward-bundles/:bundleId` | Return an authorized immutable forwarding closure. |

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

- Friendship is derived from two directional facts. A time-limited `REQUESTED`
  intent may expire and be recreated at a higher revision. A P2P thread becomes
  active only when both directions converge to non-expiring `ACCEPTED`.
- A newer local negative fact cannot be overwritten by a stale remote acceptance
  or group snapshot. The local node advances and republishes its negative intent.
  A valid local request may instead advance to acceptance when the peer confirms.
- Re-friending or rejoining need not wait for the peer to consume the removal.
  Stable-key compaction retains the newest revision. A group origin republishes
  `GROUP_META` for a new join revision even if its previous roster was still active.
- Group membership combines an origin invitation and a member join direction.
  Origin-authored `GROUP_META` is the final roster authority.
- Group invitations require an established P2P relationship between inviter and
  invitee. The invitation transaction publishes `GROUP_INVITE_INTENT` and the
  required group `PROFILE`. Before publishing `GROUP_META`, it also publishes all
  referenced `MEMBER_PROFILE` dependencies to the target peer.
- `PROFILE` has its own revision and group metadata does not embed avatars. A
  member server may apply a profile relayed by the group origin.
- An equal or older business revision does not rewrite a body. Dependency repair
  may reindex semantically unchanged `GROUP_META` to restore member-before-group
  ordering in the current projection.
- Per-peer state feeds compact by stable key. Transport `feedId` and cursors are
  bigint values; stable-key business `revision` is an integer. They are distinct
  coordinate systems.
- A receiver applies a state page and advances its cursor in one transaction. Any
  invalid item rolls back the complete page.
- Member snapshots precede the group revision that references them. When the last
  visibility source disappears, the source omits that member from its projection
  and the consumer cleans the reference closure only after a complete state drain.

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
