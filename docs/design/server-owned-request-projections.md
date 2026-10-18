# Server-Owned Request Projections for Client State Feed

Status: PROPOSED — product decisions below require review before implementation.

## 1. Goal and scope

Move user-facing relationship request state from client-side intent folding to
server-owned, durable request projections. A retained request must be restorable
from one complete record, including its terminal status, original note, identity,
and send-time snapshot. Devices must not need the original REQUESTED event or
both intent directions to display it.

This proposal changes the **request family of ClientStateFeed**, not the
federation State Feed. S2S continues to carry independently authored intents.
The existing protocol remains unchanged: receiving REVOKED concludes an effective
local REQUESTED or ACCEPTED with a locally authored REVOKED in the same atomic
relationship transition. Rejection ends the request flow; a later request starts
a new flow.

RelationshipIntent, pair folding, authorization epochs, group roster facts, and
ThreadFeed retain their owners. A request projection never grants access, creates
a conversation, or establishes membership. ThreadFeed remains the conversation
read model. Group Meta remains the roster/profile read model.

There is no legacy API, payload, SQL-data, or client-cache compatibility layer.
Update `database/migrations/0000_base.sql` and `src/database/schema.ts` directly.
This is not permission to reset shared databases or caches during development.

### What this does and does not guarantee

There will be one request presentation decision on the server, replicated to all
devices. This removes device-dependent folding and missing-predecessor failures.
It does not eliminate transport delay, offline state, races in publishing,
server bugs, or missing S2S history. Atomic publication, cursor correctness,
strict validation, and recovery tests remain essential.

## 2. Current implementation findings

- `src/client-state-feed/client-state-feed.service.ts` compacts relationship
  intent bodies and filters them using a seven-day `updatedAt` window. A terminal
  body is not a complete request record.
- `web/src/app/services/friend-request-state.ts` updates only existing live
  REQUESTED projections. A terminal fact cannot create history. Its feed-id
  guard prevents old facts from overwriting newer projections.
- `web/src/app/services/webdb-storage.ts` additionally settles both group request
  directions on a group ACK. Local accept actions also write projection state.
- `src-tauri/src/native_db/relationship_projection.rs` has a separate intent
  interpreter. These interpreters are not identical; moving ownership requires
  deleting both, not keeping either as a fallback.
- `GroupRequestProjection` is already a server read model, but currently stores
  the latest row per group/member/direction, has no explicit request-generation
  token for actions, and shares expiry/GC concerns. It is a reference, not a
  complete model to copy unchanged.
- Personal request unread state is partly local: clients advance
  `relationshipRequestStateRevision` when an incoming request becomes actionable.
  Only `readThroughFeedId` is currently server-owned via INCOMING_INVITE_HEAD.
- Group manager state uses `joinRequestEndFeedId`, `joinRequestReadFeedId`, and
  `groupInviteEndFeedId`. Manager heads are propagated by durable fan-out and
  ThreadFeed. Invitation updates and application updates have distinct streams.
- Group GC currently advances read heads using removed projection feed IDs.
  This must not be copied into a new arrival-watermark design: deleting history
  is not evidence that a user read another request.
- Restoring the original protocol exposed pre-existing implementation gaps in
  P2P received rejection and same-node group rejection. They must be tested and
  aligned with the original protocol, not hidden by presentation changes.

## 3. Request identity and rounds

Recommended initial product behavior: **one latest request per ordered request
slot**, not an inbox retaining every historical round.

A slot contains:

- request kind: FRIEND, GROUP_APPLICATION, or GROUP_INVITATION;
- author identity: account + namespaceId;
- receiver identity: account + namespaceId;
- viewer scope: local user or authoritative group management view.

Each new request flow receives an opaque `requestId`. Retries of the same live
flow retain it. After rejection, withdrawal, or expiry, a new flow receives a new
ID and captures a new outgoing snapshot. The previous round is replaced in that
slot. Opposite request directions are different slots.

`requestId` is a presentation/action generation token, not federation authority
and not an S2S identifier. A local shared group projection and its local user
view must refer to the same locally observed flow. A different node may allocate
a different local ID; the wire does not gain a new field.

Remote flow detection must use validated intent transitions and existing wire
request coordinates, with duplicate-delivery tracking. It must not use receive
time, profile revision changes, or an assumed globally unique timestamp.
Delayed wire facts obey the existing S2S cursor and intent validation rules.

Accept/reject/withdraw request-card APIs carry `requestId` and target identity.
Under the existing business locks, a stale ID returns an explicit stale-request
result without acting on a newer round. General relationship removal/leave/kick
commands remain separate from request-card actions.

If retaining *all* rounds is desired instead, that is a product decision changing
keys, pagination, storage limits, and GC. It must be chosen before SQL work.

## 4. Durable ownership and data layout

Introduce a domain-owned request capability under `src/relationship/request/`.
It defines lifecycle transitions and immutable request presentation fields.
Group membership services remain responsible for group decisions and manager
authorization. Generic ClientStateFeed code only serializes/allocates/transports
already-decided records; it must not become the business state machine.

Use a durable request-round record and explicit user/group projection scopes:

1. A request round stores its ID, ordered endpoints, kind, status, note,
   requestedAt, requestExpiresAt, retainUntil, and the original presentation
   evidence. It remains after its originating intent is overwritten by REVOKED.
2. A current-slot constraint identifies the latest round. Replace the slot
   atomically on a new flow; retain no accidental historical duplicates.
3. Local-user projections carry viewer direction and the appropriate presentation
   variant. Group manager projections remain shared, not duplicated per manager.
4. ClientStateFeed stores the complete transport snapshot for a user slot.
   Group listing endpoints read the corresponding shared group projection.
5. Personal request notification heads are stored durably even when individual
   requests are collected.

Implementation must choose concrete normalized tables and constraints during
schema review; do not maintain independently mutable lifecycle copies. Where a
feed body duplicates a projection, update it in the same transaction. Existing
GroupRequestProjection must be integrated with the common round semantics, not
left as an alternative transition system.

Required constraints include unique slot identity, valid namespace coordinates,
allowed status/kind/direction combinations, non-null request times, bounded
retention, and strict presentation variants. Thread references must be nullable
or safely detached on shell deletion: deleting a message-free thread must not
cascade away retained request history.

## 5. Complete client contract

Replace client RELATIONSHIP_INTENT with a distinct event family, provisionally
`REQUEST_PROJECTION`. Do not reuse the old name with a different body.

A full UPSERT contains:

- opaque slot key and `requestId`;
- kind, viewer direction/bucket, ordered endpoint identities;
- status: REQUESTED, ACCEPTED, REJECTED, WITHDRAWN, or EXPIRED;
- note, requestedAt, requestExpiresAt, retainUntil, server updatedAt;
- nullable local thread reference, without conversation authority;
- complete, discriminated presentation data;
- immutable incoming-arrival coordinate where applicable.

OUTGOING presentation contains a required `{displayName, avatar}` send-time
snapshot. INCOMING presentation contains the original author's exact profile
reference. Group manager applications use member author references; invitations
use the invitee snapshot. No optional snapshot fallback, empty synthetic
snapshot, or current-profile substitution is allowed. Snapshot does not enter
S2S and cannot be used as authorization evidence.

A terminal UPSERT has exactly the same completeness requirements. It must work
when the client has no prior row. Use explicit nullable fields rather than
omitted predecessor-dependent fields. Domain display is derived independently
from namespace identity.

Feed compaction identity is the viewer's request slot, not an intent direction
misused as a presentation key. A new round replaces the slot with a new
requestId. The feedId orders snapshots; it is not the round ID.

The client validates and atomically replaces a slot only for a newer feedId.
It does not infer direction from `!`, merge opposite intents, decide a terminal
status, or patch ACCEPTED locally after an HTTP response. A successful action
returns a committed feed head; the UI may show a transient pending action while
sync catches up, but the durable card is server-owned.

Snapshot avatar references must remain readable throughout retainUntil, including
another device after relationship revocation. Define a durable asset strategy
and access policy before shipping; a syntactically valid URL is insufficient.
Incoming exact-profile references likewise do not grant new access after
revocation. Resource availability and safe placeholders must be tested without
silently fetching a newer profile.

## 6. Transactional lifecycle

For every authored or received intent command:

1. Acquire the established domain/account/pair/intent locks in the existing order.
2. Validate the command, wire item, and requestId where supplied.
3. Capture the request transition and its causal role before automatic reciprocal
   conclusions erase the distinction between reject and withdraw.
4. Apply authoritative intents, reciprocal REVOKED where required, pair folding,
   authorization epochs, and any roster/thread effects.
5. Update the matching request round and all local views, publish complete user
   snapshots, and durably admit manager fan-out when necessary.
6. Commit; only then emit wakes. A wake is a hint, not the durable work record.

Lifecycle rules:

| Input | Projection result |
| --- | --- |
| New valid request | Create REQUESTED round and initial presentation |
| Duplicate/same-flow request | Keep round/presentation; no duplicate arrival |
| Accepted live request | REQUESTED to ACCEPTED |
| Receiver rejects | REQUESTED to REJECTED |
| Author withdraws | REQUESTED to WITHDRAWN |
| Validity expires | REQUESTED to EXPIRED |
| Reciprocal convergence after a terminal decision | Preserve terminal result |
| Terminal intent with no observed request | Do not invent request history |
| New request after a closed flow | New requestId, new presentation, new arrival |

Crossed requests and group invitation completion must be explicit test cases:
settle the actual observed request rounds, rather than treating any ACK as a
fresh request. Internal group founding must not create a phantom notification.

Concurrent local writers must serialize projections with their owning business
state. Use NO KEY UPDATE for non-key writes where appropriate. Multiple local
recipients acquire allocator locks in canonical order. SQL sibling CTEs must
read their writes through RETURNING, not assume base-table visibility.

The server projection is derived, but **not reconstructible from only today's
compacted intents**. It is durable user history within retention and belongs in
backups. Repair can republish ClientStateFeed from these rows; losing the rows
cannot be repaired by fabricating original requests.

## 7. Red-dot compatibility

### Personal friend requests and received group invitations

Keep the product formula `arrivalHead > readThrough`, but make both operands
server-owned and durable. Recommended meaning: **new incoming requests not yet
acknowledged by opening the received list**, not the number of pending actions.

- A genuinely new incoming request round advances arrivalHead using its first
  user feed position. Outgoing requests, terminal changes, profile changes,
  retries, and repeated sync do not advance it.
- Publish a complete account notification-head snapshot containing arrivalHead
  and readThrough. It survives request compaction and request-history GC.
- Keep a separate generic request-change revision for refreshing an open list.
  Do not use it as the unread numerator.
- A read command carries the arrivalHead actually observed after the client page
  transaction committed. The server advances readThrough monotonically, bounded
  by the current arrivalHead, under the same account allocator lock.
- A concurrent newer arrival remains unread. Reading on one device propagates to
  every device through the head snapshot. A cold device reads the same two heads
  even if all individual requests are already terminal.
- Under this recommended meaning, terminal changes and GC do not automatically
  clear unread. If the desired badge is "unseen actionable requests only", use
  a server-derived set/count with read watermarks instead; do not approximate it
  by changing readThrough during GC. This needs product confirmation.

The existing comparison and cross-device read concept are reusable; the existing
client-derived numerator and `markRelationshipRequestsRead()` submission of the
whole applied state-feed cursor are not reused unchanged.

### Group manager badge

Keep manager request scope and authorization separate from personal notifications.
Maintain a list-change head for all application updates and a distinct arrival
head for new applications. `groupInviteEndFeedId` remains an invitation-list
refresh coordinate, not an application-unread coordinate.

Managers compare application arrival head with their own per-group read head.
A newly promoted manager starts read at the current arrival head, matching the
current policy that old requests are not newly unread. ADMIN/OWNER transitions
preserve the heads; loss of manager role removes capability and cached manager
views. Any new head propagation must use existing durable fan-out, monotonic
updates, and commit-time role checks. Delayed fan-out is allowed; lost work is
not. Request listing and actions still revalidate current authority.

This deliberately separates list refresh from unread arrival. Existing end/read
fields are therefore not blindly reusable with identical meaning.

## 8. Retention, expiry, and deletion

Recommended policy to confirm: retain each latest request until
`requestedAt + 7 days`, independent of terminal updates. Validity has its own
`requestExpiresAt`; ordinary intent expiry may be shorter. Retries, profile
changes, and rejects must not extend retainUntil.

The server owns expiry transitions. Clients may disable actions after the
explicit requestExpiresAt and hide records after retainUntil while offline;
they must not persist locally invented terminal status or advance server heads.
All decision endpoints enforce validity independently of scheduler timeliness.

Publish an explicit DELETE for a collected slot, carrying its generation and a
new feed position, so an incremental device removes it. Retain deletion evidence
until the feed recovery policy permits collection. Define a durable cursor floor:
a client older than that floor must do a full rebuild, never silently miss a
delete. A slot recreated before an old DELETE arrives is protected by feed order
and generation identity. Never delete intents or authorization facts as part of
request-history GC.

## 9. Pagination and full recovery

A full page of a compacted table bounded by `through` is not automatically an
as-of snapshot: a concurrent update can move an unseen slot past that boundary.
The new design must account for this rather than relying on HTTP 200 or an empty
page as proof of completeness.

Use a staged full rebuild: clear/stage the request replica once, scan the bounded
full feed, then catch up deltas past that boundary before promoting the staged
replica. Updates that moved out of the initial range are picked up by catch-up.
Persist the rebuild marker and cursor so interruption restarts or resumes safely.
A continuously changing server permits convergence, not an impossible promise
of instantaneous global equality. Per-page snapshots and cursor-floor checks
must be coherent database reads. If the cursor falls below the floor at any
point, restart full recovery. Stage notification heads with request data to avoid
transient full-rebuild badge decisions.

Commit projection replacements, deletions, notification heads, list-change
revision, and applied cursor in one IndexedDB/SQLite transaction. Rust owns native
execution and cancellation/session epochs; platform adapters gain no request
state machine. Replaying a page must be idempotent.

## 10. Missing federation history boundary

If the receiver node observed REQUESTED, its durable projection preserves the
later terminal request for all its devices. The sender node always has its
locally authored request projection.

If S2S compaction removed REQUESTED before the receiver node ever observed it,
receiving REVOKED alone cannot reveal the original note, timestamps, or profile
reference. This proposal does not change the wire to transfer that history.
The receiver applies revocation and authorization effects without inventing a
request card. Confirm that this node-level limitation is acceptable; fixing it
would be a separate S2S protocol/history-delivery project.

## 11. Implementation plan and gates

### P0 — Confirm contract

Resolve the decisions in section 13. Inventory every client intent producer and
consumer, including raw SQL writers, expiry, disband, namespace/key lifecycle,
local same-node commands, origin/mirror receive paths, and direct terminal cases.
Separate old protocol-compliance bugs from projection work, but test them in the
final contract. Do not silently change the restored S2S semantics.

### P1 — Schema and domain capability

Define round/slot identity, normalized source records, immutable presentation,
notification heads, retention/deletion floor, and strict discriminated DTOs.
Update the unpublished base SQL and Drizzle together. Add PostgreSQL constraint,
transaction rollback, generation, and round-retention tests.

### P2 — All server writers

Connect the capability to P2P and group authored/received commands. Integrate
shared manager projections and fan-out. Publish complete terminal snapshots in
the business transaction. Remove old client raw-intent publishing; preserve S2S
intent publishing and ThreadFeed. Add requestId guards to actions and responses.
No dual-write legacy client event path is kept as a supported mode.

### P3 — Client replication and red dots

Replace Web and Rust reducers with strict complete-snapshot upsert/delete.
Remove local durable accept patches and raw-intent-specific parsing. Update IDB,
SQLite, native IPC, list refresh, and notification-head storage together.
Reject/reinitialize old disposable cache layouts explicitly; do not import or
migrate their request records. Shared-cache resets are a separate operator action.

### P4 — Recovery, expiry, resource lifetime

Implement staged rebuild and cursor-floor handling, deterministic retention,
explicit deletion, server expiry, durable avatar behavior, and role-loss cleanup.
Update docs that still claim intent-driven conversation/request reconstruction.

### P5 — Verification and cleanup

Run isolated PostgreSQL and cross-device tests, then backend/Web/Rust/admin
regression suites. Remove obsolete reducers, contracts, fixtures, and dead SQL
helpers. No compatibility fallback. This work does not freeze or release the
federation draft, and does not authorize commit, deployment, or shared-data reset.

## 12. Acceptance matrix

- FRIEND, GROUP_APPLICATION, GROUP_INVITATION; local and federated directions.
- Request, same-flow retry, accept, reject, withdraw, expire, retry as new round,
  crossed requests, late ACK, duplicate REVOKED, invitation completion.
- Old requestId action racing a new round must not affect it.
- SQL intent/projection/feed atomic rollback and two-local-recipient consistency.
- Closed request retains snapshot/note/times, and current-profile changes neither
  mutate outgoing presentation nor advance request arrival/list heads needlessly.
- Fresh device after rejection/withdrawal/acceptance matches an existing device
  whenever the server observed the request, with no predecessor in the feed.
- No prior S2S REQUESTED: no fabricated history; revocation still removes grants.
- Duplicate pages, out-of-order old pages, process/SQLite reopen, real app restart,
  interrupted paged rebuild, concurrent compaction past `through`, lost wake,
  expired cursor floor, deletion followed by a new generation.
- Two devices: read-before-arrival, arrival-during-read, terminal-before-first-sync,
  history-GC-before-first-sync, outgoing-only changes, new manager, role loss,
  durable fan-out interruption, and reconnect without a wake.
- Snapshot avatar readable after revocation on another device; null/failed avatar
  never falls back to a live-profile demand. Incoming exact references remain
  authorization constrained.
- Established conversations and group roles converge via their own feeds, with
  no request-projection-based permission or conversation creation.

## 13. Decisions requiring confirmation

1. **Scope:** only client-facing request events change; S2S intents remain intact.
2. **History:** latest round per directional slot (recommended), or all rounds
   during retention? "New projection" alone does not decide this.
3. **Retention:** fixed seven days from request creation (recommended), or a
   separate period after terminal resolution? This affects GC and avatar lifetime.
4. **Badge meaning:** new incoming arrivals until viewed (recommended and closest
   to the current personal watermark model), or only unseen still-actionable
   requests? Apply the chosen meaning consistently to group manager applications.
5. **Missing node history:** accept that a node which never received REQUESTED
   cannot reconstruct that request from S2S REVOKED alone?
6. **Stale actions:** require requestId for request-card decisions and reject old
   rounds explicitly (recommended), with no legacy address-only action fallback.

These decisions, atomic domain publication, and durable recovery are the closure
conditions. Merely moving the client reducer to the server is not sufficient.
