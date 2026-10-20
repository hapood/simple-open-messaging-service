# Server-Owned Requests: First-Round Review

Status: review checkpoint, not implementation completion or release approval.

Confirmed correction: the slot table and supporting unique index are removed.
Only RelationshipIntent.requestId is added: nullable bigint referencing the
request with ON DELETE SET NULL. There is no reverse intentId, new intent
identity, or explicit NEW/RETRY command discriminator. Request decisions must
find an associated REQUESTED intent; missing associations and terminal intents
fail. Friendship removal is separate and does not rewrite request history.

This review covers permanent request storage, HTTP and local-storage contracts,
and retirement of device request projections. Business lifecycle integration
remains unfinished. It does not freeze the federation draft.

## Source of truth

- [Design](server-owned-request-projections.md)
- [Database checklist and verification](request-projection-database-review.md)
- [AccountState and IPC contract](account-state-storage-contract.md)
- [PostgreSQL baseline](../../database/migrations/0000_base.sql)
- [Drizzle schema](../../src/database/schema.ts)
- [Shared request types](../../shared/relationship-request.ts)
- [HTTP application boundary](../../src/relationship/request/relationship-request.service.ts)
- [Internal transaction contract draft](../../src/relationship/request/request-transaction.contract.ts)

## Contract inventory

### Server storage

- `RelationshipRequest`: permanent row per round, bigint ID, kind, ordered
  author/receiver identities, status, author profile coordinates, snapshot,
  note, requestedAt, expiresAt, createdAt, updatedAt. No thread FK, retainUntil,
  or history GC. Local authors require a snapshot; remote authors store NULL.
- `RelationshipIntent.requestId`: nullable, indexed FK to the associated request.
  Request deletion clears this reference; intent deletion preserves history.
- `Account.requestEndId/requestReadId`: durable incoming-only heads,
  `0 <= read <= end`. No sent head or server optimistic field.
- `ClientStateFeed`: append-only (userId, feedId) primary key; each published
  head version is one immutable row and future state kinds append on the same
  per-account feedId sequence. JSON coordinates are decimal strings; feedId
  remains a separate feed cursor.
- Namespace FKs use RESTRICT. Baseline FK installation was moved after the
  namespace primary key to fix a real full-DDL application failure.

### Public and application boundaries

Routes below are relative to `/api/v1`; group routes use the existing controller
prefixes. Authentication and the normal response envelope remain in place.

| Route                               | Request capability                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| POST relationship/requests          | queryPersonal(userId, bucket/before/take)                                              |
| POST relationship/requests/read     | markRead(userId, requestReadId)                                                        |
| POST relationship/accept            | userIntents.decidePersonalRequest(userId, requestId, ACCEPT)                           |
| POST relationship/revoke            | endEstablishedRelationship(userId, threadId); established P2P only                     |
| POST relationship/requests/reject   | userIntents.decidePersonalRequest(userId, requestId, REJECT)                           |
| POST relationship/requests/withdraw | userIntents.decidePersonalRequest(userId, requestId, WITHDRAW)                         |
| POST group/join-requests            | queryGroup(..., APPLICATION, before/take)                                              |
| POST group/invitations              | queryGroup(..., INVITATION, before/take)                                               |
| POST group/join-request/accept      | decideGroup(..., APPLICATION, ACCEPT)                                                  |
| POST group/join-request/reject      | decideGroup(..., APPLICATION, REJECT)                                                  |
| POST group/invitation/revoke        | decideGroup(..., INVITATION, WITHDRAW)                                                 |
| POST group/join-request             | memberIntents.execute(ACCEPTED) gated by requestDecision on the exact invitation round |

Request authoring retains address-based routes. Decisions about an existing
request use its exact requestId. Established relationship revocation must not
remain an address-based escape hatch for pending-request decisions.

Pages return items, hasMore, before; personal pages also return incomingHead,
and group pages retain the manager head pair. Items have closed incoming
(authorProfile) and outgoing (snapshot) variants. Decision results are OK with
nullable threadId, STALE_REQUEST, or EXPIRED; failures remain
subject to the API's error envelope.

### Local storage and IPC

Web `accountState` and Rust `account_state` expose fixed `AccountState` fields:

- schemaVersion (still 1)
- selfProfile, selfIdentity, composerDrafts
- threadFeedCursor, stateFeedId, stateFeedFullThrough
- profileNamespaceChangeEndId
- intentRequestEndId, intentRequestReadId, intentRequestOptimisticReadId

The five typed commands cover initialize, read, write profile, write drafts,
and advance received-read intent. Registration and permissions exist. No request
page cache, generic account metadata dictionary, or old-layout compatibility
reader is intended. Physical cache ownership remains with the session subsystem.

### Web client consumption

Both request UIs are online-only clients of the routes above. The personal page
queries by bucket and decides by exact requestId; the group page uses the shared
GroupRequestPage and keys actions, list merge, and history rounds by requestId.
A STALE_REQUEST/EXPIRED decision never becomes a local terminal state — the page
reloads the authoritative record. The received-page read intent is persisted
before publication, seeded from durable state on session establish/restore, and
retired when a confirmed read covers it. A persisted-but-unconfirmed target is
resubmitted once on session establish; further retries ride the next page view.

## Verification results

| Check                                                 | Result / scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend TypeScript                                    | Passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Backend unit suite                                    | 223 files, 2017 tests passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Web spec TypeScript                                   | Passed after owner WIP update                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Angular: request component, UserService, WebdbService | Earlier 3-file run: 101 passed. Latest request component run: 18 passed, including STALE_REQUEST/EXPIRED failures never becoming accepted/rejected/withdrawn. UserService now 37 passed, including persist-before-publish ordering, optimistic retire-on-confirm, and durable seeding                                                                                                                                                                                                                                                                                        |
| Angular: group join-request component                 | 7 passed, including stale-decision reload and requestId-keyed actions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Vitest: group-join-request-state                      | 5 passed: id-keyed round history merge, bigint ordering, REQUESTED-only transitions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Angular: other storage/worker suites                  | 5 files, 60 tests passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Angular: full suite                                   | Latest run: 203 files / 1578 tests passed, including the previously blocked session-cache fixture suites (owner WIP landed)                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| admin-web                                             | tsc -b clean; vitest 63 passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Spec conformance                                      | npm run federation:conformance: SOMFP v1 conformance package PASS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Documentation references                              | All source/doc links in the four request-design documents resolve                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Rust library tests                                    | Latest run: 156 passed (previously 144 before the current session WIP additions)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Full PostgreSQL baseline application                  | Passed in a newly created isolated database                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| PostgreSQL request constraints                        | Earlier 19-assertion run covered the superseded slot schema; current full DDL and nullable intent link deletion/repoint behavior passed in a fresh isolated database                                                                                                                                                                                                                                                                                                                                                                                                         |
| Drizzle↔baseline SQL parity                          | New audit compares columns/order, NOT NULL, PK, UNIQUE, CHECK names, FK names/actions and index columns (incl. DESC) for Account, AccountThreadState, ClientStateFeed, RelationshipIntent, RelationshipRequest: PASS. Fixed real drift: FK names on RelationshipRequest namespace references, three missing AccountThreadState Drizzle checks (groupInvite/joinRequest end/read), and CREATE TABLE column order for Account/AccountThreadState/RelationshipIntent aligned to the schema declarations. Post-fix isolated PG applies the full baseline (60 tables, 541 CHECKs) |
| Historical visibility                                 | Old row remains stored while a seven-day SQL predicate excludes it; not an API test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Query plans                                           | Results below; synthetic planner evidence, not a performance SLA                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Logs from this review session are in `/tmp/request-round1-backend-all.log`,
`/tmp/request-round1-web-current.log`,
`/tmp/request-round1-web-storage-current.log`,
`/tmp/request-round1-rust-current.log`,
`/tmp/request-round1-pg-constraints.log`,
`/tmp/request-round1-pg-plans.log`, and
`/tmp/request-round1-pg-dense-plans.log`.
These temporary logs are not durable CI artifacts.

### Query-plan evidence and limits

Current indexes are `(namespaceId, account, createdAt DESC, id DESC)` on both
endpoint sides. Test queries use endpoint scope, the seven-day createdAt
predicate, optional `id < before`, `ORDER BY id DESC`, and `LIMIT 21`.

With 200,000 old rows split between two flows and 100 recent rows in one flow:

- Received and sent first pages use their scoped time indexes, visiting 100
  recent rows and sorting by ID (7 shared buffer hits).
- The received next page visits 79 candidates with the ID bound (10 hits).
- History-only recipients/authors return zero rows with 3 shared buffer hits;
  the old histories are not scanned.

With 100,000 recent rows all belonging to one flow, PostgreSQL selects a backward
primary-key scan for first, middle, and deep pages, returning 21 rows with 3–4
buffer hits. This is an intentionally dense case, not evidence that a global
primary-key scan is efficient for sparse interleaved recipients.

No planner settings were forced and no indexes were changed. The current index
order favors bounded time-window reads but does not directly satisfy ID ordering
across distinct createdAt values. Sparse interleaving, skewed multi-recipient
loads, group authorization joins and production-scale statistics need workload
validation before calling index tuning complete. Do not replace the current
indexes merely to eliminate a sort while reintroducing unbounded old-history
scans.

## Explicit outstanding work

The test-wide TypeScript check (`tsc --noEmit -p test/tsconfig.json`) is not
clean: older E2E suites still reference removed ClientStateFeed columns,
writeInTx, and request authoring commands without snapshots. Passing backend
unit types, Angular tests or the four new P2P PostgreSQL cases does not imply
these older integration suites are migrated. The new P2P spec has no diagnostics
in that check. The catch-up suite's obsolete age-filtered intent-projection
case was replaced by standalone real-PostgreSQL head/feed tests in
[client-state-request-head.e2e-spec.ts](../../test/client-state-request-head.e2e-spec.ts):
four tests pass for append/deduplication with bigint string precision, old-head
retention and range boundaries, atomic rollback, and account isolation plus
composite-key uniqueness. The incoming-invite-read HTTP suite now uses string
requestReadId, checks both immutable head versions, monotonic replay, and rejects
an ahead request ID without modifying the account or feed. It no longer uses
writeInTx, eventType, or a state-feed cursor as a request-read coordinate.
No diagnostics remain in these three migrated files; the incoming-read HTTP
suite is not run until its concrete request provider is available.

The first-message-after-friend fixture now supplies explicit target snapshots
for both federated REQUESTED commands. The group-application snapshot suite no
longer imports the deleted Web projection reducer or rebuilds requests from
ClientStateFeed. It checks RequestRecord history via online SENT pages,
immutable same-round evidence, new-round IDs, the intent requestId reference,
exact-ID rejection/acceptance, and stale-ID failure without mutating the new
round. Both files have no diagnostics in the test-wide type check, but their
HTTP suites remain unexecuted until lifecycle providers are implemented.
Latest snapshot-contract type evidence: /tmp/snapshot-e2e-contract-types.log.

The group-invite-address suite now supplies explicit snapshots, checks exact
snapshot forwarding alongside the deduplicated target, and checks that controller
execution leaves Account rows unchanged. It passes in the isolated PostgreSQL
harness (one test) without AppModule. Its group-intent port is a test double,
so this covers controller delegation and not locked friendship authorization.
There are no diagnostics for this file in /tmp/group-invite-address-types.log;
execution evidence: /tmp/group-invite-address-pg.log.

The mirror-group-intent suite now checks permanent RelationshipRequest rows
instead of deleted client/group request projections. Identical invitation
replays preserve both evidence and notification allocators, acceptance concludes
the invitation record, pending withdrawal records WITHDRAWN, and established
member departure preserves the accepted record byte-for-byte at the driver
boundary. The application-rejection fixture explicitly seeds a request and its
intent reference rather than expecting a REVOKED message to reconstruct missing
evidence. Existing PeerStateFeed, membership, boundary-message and Group Meta
assertions remain. There are no type diagnostics for this file in
/tmp/mirror-request-history-types.log; the suite has not run because AppModule
still requires the unfinished request providers.

The group-join-request-projection HTTP suite has been rewritten around the
permanent-history contract, retaining six scenarios: rejection history outside
the online window and after participation deletion; invitation retry/withdrawal/
new rounds; application acceptance without an invented invitation; invitation
acceptance without an invented application and history preservation on leave;
a missing-round action that creates no history; and shared history across
manager promotion/demotion/departure. Its read test uses the page's manager
watermark, never a request ID. The old deleted-emitter test is replaced by the
missing-round HTTP action test, not claimed as coverage of inbound S2S terminal
facts. To avoid deciding the open list-window clock choice, the age fixture moves
both createdAt and requestedAt outside seven days while keeping updatedAt recent.
This suite is type-clean but not executed because request providers are missing.

The independent relationship-request-storage PostgreSQL suite passes three tests:
all three request kinds retain old terminal history; intent repoint/deletion
preserves both rounds; and the requestId foreign key rejects missing targets and
SET NULL preserves every other intent field. Its initial terminal-intent fixture
was corrected to use expiresAt NULL as required by the existing state CHECK;
no schema constraint was relaxed. These are storage tests, not evidence of
implemented lifecycle writers, online query authorization, or window filtering.
Evidence: /tmp/permanent-request-storage-pg-final.log (3 passed),
/tmp/permanent-request-storage-types.log (both migrated/new files have no
diagnostics; other suites still fail), and /tmp/group-history-contract-units.log
(45 contract/controller/DTO tests passed).

The user-intent-http suite is rewritten around the separated contracts: pending
rounds are decided only by exact requestId (`relationship/accept`,
`relationship/requests/reject`, `relationship/requests/withdraw`) and only an
established pair is ended by `relationship/revoke {threadId}`. Nine scenarios
cover: synchronous recipient-head commit with online RECEIVED evidence and a
ClientStateFeed head-only delta; author-side acceptance returning STALE without
changing the round; exact-round acceptance returning the thread, preserving the
incoming head and rejecting replay; a stranger thread revoke that stays
non-leaking (THREAD_NOT_FOUND) without touching history; withdrawal without
departure, new-round ID allocation, intent repoint and stale old-ID failure;
rejection concluding the requester round and permitting a new round; expiry
renewal with immutable first-round evidence and crossed-request activation; the
closed EXPIRED decision result; and established-thread termination preserving
the accepted record byte-for-byte. The old address-based revoke and
RELATIONSHIP_INTENT projection assertions are removed without compatibility
paths. Type-clean (/tmp/user-http-final-types.log); HTTP execution remains
blocked by missing request providers.

The remaining single-diagnostic suites media-stage and departure-system-message
now supply explicit REQUESTED snapshots (the target's account as the display
name); both files are type-clean in the same log.

federation-state-boundaries' three REQUESTED commands now carry explicit target
snapshots, and the federation suite's federated join-application scenario is
migrated to permanent request history: the receiver-side RelationshipRequest
row on the origin node replaces groupRequestProjection (same row ID across
reject/withdraw conclusions, new ID for the renewed round, exactly two rows at
the end), the manager rejects by exact requestId from the online list, and the
author withdraws her pending round by the exact ID from her node's SENT list
instead of the deleted address-based relationship/revoke. Both apply/renew
requests and four later address-form payloads now send explicit snapshots
instead of the retired displayName wire field; the remaining displayName
occurrences in these files are genuine profile/contact-card fixtures. Both
files are type-clean (/tmp/fed-snapshot-types.log). The multi-node suite is not
executed: it needs full application boots on both nodes, which the missing
request providers still block.

Current failing-test-wide
tally: group-join-decision 70, federation-address-friend 17,
user-intent-decision 11.

federation-address-friend is now migrated and type-clean: the address-based
friend test accepts Bob's exact receiver-side round ID (remote authors carry an
exact profile reference with snapshot NULL); the refresh test becomes a
same-round-retry test — admission is charged again while the intent, the round
evidence and the mirrored receiver state stay byte-identical, followed by an
exact-ID withdraw (WITHDRAWN on the same row) instead of the deleted
address-based revoke; and the double-rejection test concludes each round by its
exact ID on both nodes with per-node round allocation (second round IDs greater
than first, exactly two terminal rows, immutable notes/snapshots), keeping the
PeerStateFeed revocation-item equality checks. All five old displayName wire
fields in this file now send explicit snapshots. Not executed: the suite needs
both federated application boots, which the missing request providers block.

Current failing-test-wide tally: group-join-decision 70, user-intent-decision 11.

user-intent-decision is migrated and type-clean: the runIntent helper takes a
discriminated command union (REQUESTED requires its snapshot), all direct
REQUESTED call sites supply explicit snapshots, and the state() helper now
collects permanent RelationshipRequest rounds for the pair plus both local
accounts' incoming heads instead of deleted RELATIONSHIP_INTENT feed rows.
Assertions were translated to the request model: one round serves both
viewpoints with only the receiver's head moving; acceptance/withdraw/reject
conclude the exact round without allocating request numbers or advancing
heads; friendship departure creates no request history (the mirror suite
already covers accepted-round preservation with real rounds); remote targets
get one row and no local head; rollback tests compare rounds and heads; the
concurrent-acceptance race concludes the single round exactly once. Lock
ordering, thread/audience, system-message and PeerStateFeed assertions are
unchanged. Not executed: the suite imports AppModule, whose request providers
are still unimplemented.

Current failing-test-wide tally at that checkpoint: group-join-decision 70.

The first part of group-join-decision is now migrated. Its shared state helper
reads endpoint-scoped permanent request history and the applicant's incoming
head, not deleted request projections. Acceptance/rejection, retained history,
concurrent approvals, withdrawal and manager/application crossing assertions
now inspect real request records. The profile-change test uses the actual
GroupMeta application allocator for the manager read watermark rather than
coercing a request ID into a notification coordinate; it retains the original
author revision, snapshot, timestamps and request ID while the current roster
and Group Meta use their own facts. A new invitation has one request row plus a
head-only ClientStateFeed version and an explicit intent.requestId reference.
The direction-counter test separately verifies global request IDs and independent
manager notification allocators. Established-member removal compares all request
history to its accepted pre-removal state. Fresh/re-invite/forbidden/dissolved
invitation fixtures have explicit snapshots. The remaining nested member-side
request scenarios are not yet migrated.

A missed old P2P intent assertion was also corrected: same-node rejection must
conclude both effective intent directions, not leave the author REQUESTED.
Neither this service suite nor group-join-decision has been executed; missing
providers still prevent their AppModule fixture from compiling. Independent
storage/thread-revocation PostgreSQL regressions pass seven tests in two files
(/tmp/group-decision-storage-regression.log). Test-wide types still fail only
in group-join-decision, then 41 diagnostics (/tmp/group-decision-stage-types.log).

Latest closeout: all test-wide TypeScript diagnostics are now clear
(/tmp/request-e2e-closeout-types.log). The member-side group scenarios now use
permanent request records and explicit snapshots: same-round application retries
preserve the entire record, intent and manager allocators; outgoing applications
do not allocate a personal incoming head or body-feed entry; acceptance/crossed
requests conclude the existing invitation without inventing an application;
withdrawal preserves notification versions; same-node invitation rejection must
conclude both local intents; and leaving compares the complete accepted history
before/after instead of a vacuously true every() assertion. This is still a test
contract migration, not implemented domain behavior. Untyped HTTP payloads in
other scenarios still require auditing; a passing tsc cannot validate supertest
send() objects against DTOs.

Two previously migrated federation history lookups now explicitly order by ID
DESC before selecting the latest round; they cannot rely on table/driver order
once history has multiple rows. The double-rejection test also waits for the
sender's terminal record after the receiver commits, then verifies that the
first terminal record is unchanged throughout the second round.

An actual isolated PostgreSQL run of group-join-decision fails during Nest
module compilation: GroupRelationshipMutationService is missing the
FederationGroupRequestProjectionService provider at constructor index 1 in
FederationModule. All 42 tests are skipped, not passed
(/tmp/group-decision-provider-check.log). No placeholder provider was installed.
The latest controller/DTO/shared-contract unit batch passes 68 tests in five
files (/tmp/request-e2e-closeout-units.log); git diff --check is clean.

A subsequent AST audit of literal POST routes with inline send() objects found
32 suspicious payloads despite clean test-wide types (snapshot-less requests,
address-based accepts and groupId-based invitation accepts, plus unresolved
spreads). The audit is a temporary diagnostic at /tmp/request-wire-audit.mjs,
not a complete HTTP contract validator: helper/dynamic routes, nonliteral bodies,
nested invitation snapshots and deliberately invalid fixtures need manual review.
After the migrations below, it reports 24 candidates from 52 inspected inline
calls, including 20 without spreads; the other suites still need migration
(/tmp/request-wire-audit-after.log).

Added test/support/received-request.ts: it queries the authenticated receiver's
online RECEIVED pages, matches the complete kind/author/receiver namespace flow,
accepts only a pending INCOMING record, follows all returned cursors, fails on
business errors or cursor cycles and bounds the wait. It never borrows a sender
node's request ID or synthesizes one from an address. Its HTTP-fixture unit
suite passes five tests, and vitest.config.ts now includes test/support unit
specs. These test fixtures prove lookup mechanics only, not request lifecycle
or authorization implementations.

The shared establishFederatedFriendship helper now sends an explicit snapshot
and accepts the exact receiver-side ID, checking the inner OK result. The
federation and federation-address-friend suites now use this receiver lookup
for their remaining positive friend/invitation/re-invitation accept calls,
and their group/invite payloads carry per-target snapshots. The deliberately
dishonest-mirror case still tests the origin authorization boundary: it explicitly
seeds a malicious request record plus intent.requestId on the mirror and accepts
that exact injected ID; it does not fabricate a legitimate origin invitation.
It must still be rejected by the origin, not silently converted into a valid
request by the test migration.

Latest evidence: /tmp/received-helper-types.log (all E2E types pass),
/tmp/received-helper-tests.log (five HTTP-fixture helper tests), and
/tmp/received-helper-contract-tests.log (55 helper/controller/shared tests).
No federated application workload was run; the provider boot blocker remains.

The next untyped-payload pass migrates first-message-after-friend,
group-disband-task, group-membership-reentry, link-preview,
federation-missed-two-node and federation-thread-reverse-two-node. Positive
requests now provide explicit snapshots; local/federated invitation decisions
query the exact receiver-node ID and send only requestId. Disband, re-entry,
link/media, SSE, reverse-round fault-injection and recovery assertions remain.
The reverse-round suite's helper uses the fixture thread only to obtain its
group identity for the authenticated RECEIVED query; the action itself never
uses threadId/groupId or an address as a request decision coordinate.

The receiver lookup now accepts Supertest's native HTTP-target type, supporting
both subprocess URLs and in-process servers with the same logic; a sixth unit
test verifies the in-process path. A nonliteral-body audit also found a missed
.send(target) established-friend revoke in federation-address-friend: it now
requires an active fixture pair and sends its threadId, never a request address.

Latest evidence: /tmp/request-wire-local-types.log (all E2E types pass),
/tmp/request-wire-local-units.log (56 tests in four files pass, including six
lookup-helper tests), and /tmp/request-wire-nonliteral-audit.log. The bounded
literal-route audit has no unresolved nonliteral send() bodies; its four
remaining inline candidates are legitimate spreads (three explicit federated
targets and the snapshot suite's explicit local group target). These were
manually checked for account and namespaceId. This is not a complete repository
wire audit: dynamic route names, other shared helpers and all nested invitation
payloads still need separate review. No dependent AppModule/federated workloads
were run in this pass; clean types and helper tests do not remove the provider
boot blocker or prove the domain lifecycle is implemented.

OpenAPI type regeneration
remains blocked by the current live-server generator's dependency on a bootable
application; no empty request provider was added to unblock it.
The catch-up HTTP suite itself was not executed because AppModule still lacks
the request provider. Latest type-check evidence: /tmp/incoming-read-e2e-types.log;
PostgreSQL evidence: /tmp/client-head-pg.log.

1. No concrete provider implements RelationshipRequestService or the group
   request adapter. Type checking is not proof that the application can boot.
2. Internal transactional signatures now exist in RequestTransactionCapability:
   openRequestInTx, concludeRequestInTx, requestStatusAt, queryRequestPage, and
   markIncomingRequestsReadInTx. They are definition-only and require review:
   the existing intent state machine admits new rounds or reuses the associated
   round under its locks. Exact request actions require the linked intent to be
   REQUESTED. No ALREADY_COMPLETED success or endpoint fallback is allowed.
   These are contracts, not implemented transaction algorithms.
3. No complete round writer/intent-reference transition, immutable same-round capture,
   reciprocal conclusion, atomic allocator/head orchestration, or authorized
   query/decision implementation has been delivered.
4. The revoke route name is retained with a new threadId-only contract,
   symmetric to group leave. The address payload is removed. Its domain entry
   rechecks the active pair, thread and captured epoch after business locks.
   PostgreSQL regression coverage in
   [p2p-thread-revocation.e2e-spec.ts](../../test/p2p-thread-revocation.e2e-spec.ts)
   now passes four scenarios: inactive/outsider rejection, unchanged accepted
   request history, replacement pending request survival, and reactivated pair
   survival after an old captured revocation. It uses real domain services and
   isolated databases without starting AppModule or adding request providers.
   This does not validate the unfinished request writer or federation paths.
   Locator/delegation unit coverage also checks missing and
   inactive pairs, foreign callers, both local endpoint directions, remote
   namespaces, and exact thread/epoch fence forwarding. Four established-P2P
   E2E calls now use threadId; these E2E scenarios have not been executed.
   Generated OpenAPI types, workload runner and remaining pending-request E2E
   address payloads still require migration. Group invitation acceptance still needs an
   invitation-kind gate.
5. Session-sensitive fixture coordination resolved itself when the owner's
   session WIP landed; the full Angular suite now passes. Any future session
   lifecycle changes still belong to the owner, not to guessed fixtures.
6. PostgreSQL concurrency, commit ordering, authorization races, complete
   HTTP/E2E behavior, and protocol pending-REVOKED convergence remain unverified.

Completed during this round and no longer outstanding: the group Web client
migration onto GroupRequestPage/requestId decisions (see "Web client
consumption"), persist-before-publish optimistic read publication with
restore/reset seeding, and the Drizzle↔baseline parity fixes. The offline
durable resubmission loop now covers session-establish retry; no further
background retry is implemented, so repeated submission failures rely on the
next received-page view.

## Workload request-coordinate follow-up

The additional nested-payload AST audit inspected all 13 literal
`/api/v1/group/invite` calls found across test TypeScript files and found no
missing inline invitation snapshots. This diagnostic still does not establish
coverage of dynamic routes or externally constructed payloads.

The group-manager workload chain no longer reads the removed
`GroupRequestProjection` table. It joins permanent RelationshipRequest records
to current group threads by the group identity account and namespace, derives
member identity from the correct request endpoint rather than the author's
profile coordinate, and selects request IDs as decimal text. Both historical
and current rounds remain distinct. Normalization uses the shared request-ID
validator, so numeric or out-of-range coordinates are rejected rather than
rounded or reinterpreted.

Planner targets and journal deduplication now retain requestId independently
of manager feed coordinates. The three manager operations (accept application,
reject application, withdraw invitation) send exactly groupId/requestId. A
successful decision is recorded as SUCCEEDED; STALE_REQUEST and EXPIRED are
recorded with their actual result as OBSERVED_UNAVAILABLE, not successful
mutations. Unknown results, including obsolete task-shaped replies, fail.

Evidence: `/tmp/request-workload-group-tests.log` has 39 passing targeted tests;
`/tmp/request-workload-all-tests.log` has all 198 P2P lab unit tests passing;
`/tmp/request-workload-e2e-types.log` confirms all E2E types still pass. Coverage
includes bigint precision, per-round deduplication, exact manager payloads,
invalid-coordinate refusal without address/feed fallback, and non-success
result classification. SQL shape is inspected and database-result fixtures
are normalized, but the changed workload SQL has not yet been executed against
PostgreSQL. This is not evidence of an actual lab workload or request lifecycle.

The personal-request operations in the workload runner now also construct
explicit request snapshots via `parseRequestSnapshot`: `sendRequest` and group
application fetch the resolved or self-profile display name and avatar, while
group invite fetches each candidate's profile. No displayName string or
current-profile fallback is submitted on the wire.

Personal request actions (`ACCEPT_REQUEST`, `REJECT_REQUEST`, `WITHDRAW_REQUEST`)
send only `{ requestId }` parsed through `requestIdFromWire`. The member-side
`ACCEPT_GROUP_INVITATION` route `/api/v1/group/join-request` sends only
`{ requestId: observedFacts.groupRequestId }`; `REVOKE_GROUP_APPLICATION` calls
`/api/v1/relationship/requests/withdraw` with `{ requestId: observedFacts.userRequestId }`.
`REVOKE_RELATIONSHIP` requires an observed active thread and sends only
`{ threadId }`. All request decisions validate that the response status is one of
`OK`, `STALE_REQUEST`, or `EXPIRED`; non-OK responses are classified as
`OBSERVED_UNAVAILABLE` rather than mutations.

Evidence: `/tmp/request-workload-final-tests.log` confirms all 198 P2P lab tests
pass; `/tmp/request-all-e2e-types.log` confirms zero TypeScript errors across all
E2E suites.

The forward-relay scenario and its helpers (`waitForIncoming`) still reference the
old state feed event stream for invite detection; this scenario remains unexecuted
and does not validate runtime behavior. AppModule/provider boot blockers remain.

## Cleanup and review decision

All databases created for this review were dropped in finally blocks. The
review's temporary Web tsconfigs were removed. No shared runtime/cache reset,
commit, push, or deployment was performed.

Review the storage/API definitions now, but do not interpret this checkpoint as
all runtime behavior being complete. Review the newly typed internal domain
signatures and their responsibility choices before starting the next
implementation stage.
