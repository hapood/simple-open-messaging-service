# Request Database Change Checklist

Status: FIRST-ROUND WORK IN PROGRESS — baseline DDL and contracts have been edited;
cleanup and validation are incomplete. This is not a runnable implementation.

The authoritative current proposal is
[Server-Owned Request Lists and Incoming Read Heads](server-owned-request-projections.md).
This checklist supersedes the earlier latest-slot overwrite, AccountRequest
association, retainUntil, threadId, four-head, and history-GC suggestions.

## PostgreSQL

| Object | Change |
| --- | --- |
| RelationshipRequest | New permanent row per round; bigint ID, kind, ordered endpoint identities, status, exact author reference, snapshot, note, requestedAt, expiresAt, createdAt, updatedAt |
| Intent request reference | Nullable indexed RelationshipIntent.requestId FK, ON DELETE SET NULL; no reverse intentId or slot table |
| Account | Add requestEndId and requestReadId directly; no separate state table or sent/change/optimistic fields |
| GroupRequestProjection | Replace independent lifecycle table with unified request records and authorized group queries |
| RelationshipIntent | Move presentation-only snapshot to request records after writers are connected; preserve protocol status, timing, note, profile evidence, and expiry constraints |
| ClientStateFeed | Keep userId primary key, feedId, body and timestamps; remove id/sequence, eventType, compactionKey, address columns/FK and redundant indexes; only the incoming head remains |
| GroupMeta / AccountThreadState | Reuse scoped manager heads and durable fan-out; new-round notification allocation only, no GC-driven read advancement; verify trigger/Drizzle parity |
| 0000_base.sql | Update directly alongside Drizzle; no old-data migration or fallback |

No request history TTL, retainUntil, thread FK/cascade, or seven-day storage CHECK.
The API applies the seven-day visibility predicate; history is not deleted or
replaced when another round begins. The protocol's request validity limits are
not database-history retention and remain unchanged.

Constraints must enforce required local-authored snapshot shape, remote-authored
NULL snapshot, valid namespace/profile coordinates, request expiry after request
time, valid status/kind, and nonnegative read <= end. SQL CHECK expressions must
reject UNKNOWN for malformed JSON, not merely assert TypeScript validity.
Namespace references use RESTRICT. Scoped account/group visibility is verified
by domain queries; foreign keys are not authorization evidence.

Indexes must support receiver/author scoped newest-ID lists with a seven-day
createdAt filter, including accounts with large old histories but no recent
rows. Check actual query plans before finalizing the index order. Do not introduce
MAX(id) scans as a substitute for persisted notification heads. Allocate IDs only
after obtaining applicable recipient/group locks so commit ordering is safe.

## Web IndexedDB

- Remove relationshipRequests, its bucketStatus index, schema definitions,
  projection writes, request paging, local accept patches, cleanup, and rebuild.
- Remove relationshipRequestStateRevision, relationshipIntentStateRevision,
  relationshipRequestReadHead, and relationshipRequestCleanupAt sync keys.
- Merge account meta and syncState into fixed `accountState`, shared type
  `AccountState`. Include typed selfProfile, selfIdentity, composerDrafts and
  schemaVersion alongside the existing synchronization coordinates.
- Store server request coordinates as intentRequestEndId/intentRequestReadId.
  Add intentRequestOptimisticReadId for durable optimistic received-request reads.
  No SENT head. Commit the server head atomically with the state-feed cursor.
- No durable request-page cache. Preserve profile, thread, message, preference,
  and session responsibilities. Keep schema version 1, validate the fixed layout,
  and coordinate with concurrent session-lifecycle work; no legacy import.

## Native SQLite

- Remove relationship_requests and relationship_requests_direction_status,
  request_store/relationship_projection responsibilities, cleanup, and related IPC.
- Use fixed-column account_state with the same semantics as Web accountState.
  Merge account metadata here; do not introduce account_meta.
- Keep cache schema version 1 and strictly validate the new layout; dropping an
  old table from a required list alone would still accept an old layout.
  Do not repurpose media-specific
  PRAGMA user_version or delete the SQLite file/preferences.
- Keep Rust as native lifecycle/session/cancellation owner.

## Existing implementation issues to cover

- Current group snapshot CHECK permits NULL invitations.
- Current group composite key overwrites old rounds and has no action round ID.
- Current group expiresAt doubles as GC time, and thread/namespace FKs cascade.
- Current head contains only readThroughFeedId; its replacement requires both
  incoming coordinates, represented as decimal strings on JSON interfaces.
- Current group SQL has manager-head CHECKs missing from the inspected Drizzle
  AccountThreadState declaration; keep them synchronized when editing.
- Current group writer uses note fallback and may refresh presentation; do not
  copy this into the immutable same-round contract.

## Verification gate

Apply new base SQL only to isolated PostgreSQL. Verify schema constraints,
triggers, indexes, transaction rollback, permanent history, API-window exclusion,
request-round action races, and same-recipient ID ordering. Create fresh Web and
native caches and verify absent request stores, retained heads/cursors, account
isolation, and strict rejection of incompatible layouts. No shared-data reset,
commit, deployment, or old-data compatibility is implied.

Concrete field/API definitions, reuse candidates, and remaining review questions
are in the main design document. This checklist is not an implementation approval.

## Current first-round verification and gaps

The confirmed replacement is nullable RelationshipIntent.requestId with
ON DELETE SET NULL and a lookup index. No intent identity change, reverse field,
or slot table remains. Current isolated PostgreSQL verification applied the full
baseline and checked NULL admission, reference replacement retaining history,
missing-target rejection, request deletion clearing the reference without
changing protocol status, and intent deletion retaining the request. The slot
table is absent. Log: /tmp/request-intent-link-pg.log. Earlier slot/RESTRICT
assertions below describe the superseded schema, not current verification.

- Backend `npx tsc --noEmit` passes after removing obsolete call sites and the
  invalid concrete registration of the abstract group-request adapter.
- Seven targeted contract/SQL/controller test files pass, 65 assertions/tests.
  These test routing, strict decimal IDs, complete heads, deduplication, and
  retained SQL effects, not implemented request lifecycle behavior.
- The abstract RelationshipRequestService and group-request adapter still have
  no concrete providers. The application is not bootable as a request solution;
  successful TypeScript checking does not establish DI or API readiness.
- Request-round insertion/conclusion, snapshot capture, head orchestration,
  query authorization, read retries, and UI integration remain unimplemented.
- The established-relationship revoke route still delegates to legacy domain
  commands that also permit pending revocation. It must be restricted to
  established relationships before requestId-based actions are considered safe.
- The group invitation acceptance route needs an explicit invitation-kind gate
  inside the request capability; a generic personal acceptance alone does not
  establish that route's authorization boundary.
- Web fixed-account-record production call sites and native test fixtures have
  been migrated. Old reducer-specific tests are retired; new lifecycle tests
  must exercise server-owned permanent rounds rather than resurrect device
  reconstruction. Rust `cargo test --lib` now passes 144 tests.
- Isolated PostgreSQL verification now applies the entire base SQL successfully.
  It caught and fixed a DDL ordering defect: request namespace foreign keys must
  be installed after the IdentityNamespace primary key. Constraint semantics
  were not changed. A second isolated run passed 19 assertions covering round
  identity, slot foreign keys and RESTRICT, snapshot shape/nullability,
  namespace references, kind/profile/expiry checks, account read <= end,
  bigint string fidelity, and retained historical rows excluded by a seven-day
  SQL predicate. This is not an implemented API-window test. Both page indexes
  exist; realistic EXPLAIN plans and concurrency remain unverified.
- The backend full unit run now passes all 223 files / 2017 tests. Obsolete
  request projection assertions were retired; replacement tests verify retained
  conversation-head capture, available-local-recipient filtering, threadless
  behavior, and remote peer allocator ordering. Backend type checking passes.
- After the session WIP updates, Web spec type checking passes with the normal
  configuration. Angular runs of FriendRequestsComponent, UserService, and
  WebdbService pass 101 tests across three files. Five more storage/worker
  suites pass 60 tests. Two suites (push-thread-sync.spec.ts and
  webdb.service.native.spec.ts) still fail 17 tests at their missing login-cache
  binding precondition. Their session fixture adaptation is reserved for the
  owner; no complete Web test pass is claimed. Temporary review tsconfigs have
  been removed.
- The Web received-read runtime is only partially wired: optimistic publication
  currently precedes durable persistence, does not restore/reset its signal
  with the account state, and has no durable retry loop. These are known
  integration gaps, not guarantees established by the storage contract/tests.
  Do not mark the received-read behavior complete until ordering, monotonicity,
  session ownership, confirmation, and retry are implemented and tested.
- No shared/local runtime database or cache was reset. No commit or deployment
  has been performed.
