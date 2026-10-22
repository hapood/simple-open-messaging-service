# Server-Owned Request Lists and Incoming Read Heads

Status: REVIEW PROPOSAL. Transport, notification, and storage-retention rules
below reflect the latest product decisions. Schema/API details require review
before implementation. This document supersedes the earlier projection-feed,
seven-day-GC, optimistic-read, and outgoing-head proposals.

## 1. Confirmed boundaries

- Request lists are online server queries, not client-replicated projections.
- Delete Web/SQLite request projection stores and client intent interpreters.
- Keep ClientStateFeed and its cursor for the single incoming read head. Remove
  client intent events and the now-redundant eventType discriminator; do not
  replace them with request-record events.
- The head contains only current incoming request ID and read incoming request ID.
  No outgoing heads, arrival-versus-change pair, or local optimistic read values.
- Only a new request ID advances the incoming head. In-place status changes do
  not create unread notifications. Read state is account-wide and monotonic.
- Do not garbage-collect request history. Apply a seven-day window in list APIs
  only. Do not impose a seven-day storage-retention CHECK or store retainUntil.
- S2S intents, their validity rules, and reciprocal REVOKED remain unchanged.
  Request-history GC is distinct from authoritative intent expiry/conclusion.
- No legacy data/API/cache compatibility. Edit 0000_base.sql and Drizzle together;
  no deployment, commit, or shared-cache/database reset is implied.

## 2. PostgreSQL proposal

Confirmed correction: no RelationshipRequestSlot or new intent identity column.
RelationshipIntent.requestId is a nullable bigint foreign key to
RelationshipRequest.id with ON DELETE SET NULL. Request rows have no reverse
intentId. Existing intent identity and state transitions remain authoritative.

### 2.1 RelationshipRequest: one record per observed request round

Use one domain-owned table for friend requests, group applications, and group
invitations. Both local personal views and authoritative manager views read the
same lifecycle record. Replace the independent GroupRequestProjection storage.

| Column | Proposed representation and meaning |
| --- | --- |
| id | bigint generated primary key; immutable local round identity |
| kind | FRIEND / GROUP_APPLICATION / GROUP_INVITATION |
| authorAccount, authorNamespaceId | Ordered author identity |
| receiverAccount, receiverNamespaceId | Ordered receiver identity |
| status | Existing RequestProjectionStatus enum |
| authorProfileNamespaceId, authorProfileRev | Original exact author profile evidence |
| snapshot | Required target snapshot for locally authored visible requests; NULL for remote authors |
| note | Original request note, NOT NULL; empty string is valid |
| requestedAt | Protocol request time, NOT NULL |
| expiresAt | Original request validity deadline, NOT NULL even after conclusion |
| createdAt | First local insertion time for this round, DB-generated |
| updatedAt | Last actual lifecycle modification time, DB-generated |

No threadId, retainUntil, sourceFeedId, requestedSort, display-domain copy, or
per-view duplicate lifecycle rows. Navigation obtains a thread from action
results or the conversation read model. Namespace/account identities drive
request queries and authorization; a request row is never an authority grant.

Same-flow retries retain the ID, presentation, and creation time. Terminal
changes update the same row and updatedAt, leaving the ID unchanged. A new flow
inserts a new row; old rounds remain. This is the proposed interpretation of
"database does not delete": no replacement of old rounds by a slot upsert.

Use bigint in TypeScript/Rust storage and decimal strings in JSON; never convert
request IDs to JS numbers. Do not add a redundant UUID generation token: the
immutable request ID also guards actions against newer rounds.

### 2.2 Owning intent association

RelationshipIntent retains its four-column identity key and adds nullable
requestId pointing at the associated visible request round. A new admitted
round updates this reference; old request history remains independently stored.
No reverse field or separate current-round table is needed. An index on the
intent reference supports request actions and foreign-key deletion checks.
Deleting a request sets referencing intent.requestId to NULL; deleting an intent
does not delete or change request history. Normal operation does not GC requests.

Request actions locate the intent through requestId under existing business
locks. Missing association fails; do not fall back to endpoints or a newer round.
Only REQUESTED admits further request decisions. ACCEPTED (ACK) and REVOKED are
terminal for this request round. Accepting friendship updates the associated
request presentation; later ending friendship is a different operation and must
not rewrite that accepted record. Same-round authoring retries preserve evidence;
terminal request-action retries are failures, not successful idempotence.

No AccountRequest association is needed initially: personal visibility is the
exact local account identity on either endpoint, and manager visibility is the
authoritative group endpoint plus current role authorization. Use two indexed
personal branches for RECEIVED/SENT, not a full-table OR scan.

### 2.3 Constraints and indexes

- Explicit allowed kind/status values; namespace FKs RESTRICT.
- Exact snapshot shape via the existing parser and equivalent strict JSON CHECK.
  SQL NULL is required for remote authors and forbidden for locally authored
  visible requests. Internal founding transitions create no user-visible round.
  Local incoming API responses still expose author evidence, not the stored
  outgoing snapshot belonging to the other local viewer.
- expiresAt > requestedAt; nonnegative profile coordinates; required times/note.
- No seven-day storage limit, expiry cascade, or thread FK.
- Index `(receiverNamespaceId, receiverAccount, id DESC)` and the corresponding
  author index for personal lists; group endpoints use the same ordered indexes.
  Include kind where query-plan evidence warrants it.
- createdAt supports the list-window predicate; check query plans with large
  permanent history, including queries whose recent window is empty. Do not
  assume an ID-ordered scan is bounded just because LIMIT is small. Choose a
  composite/time index or a bounded indexed candidate query from measurements.

### 2.4 Snapshot ownership and preserved authority

Move target snapshot ownership out of RelationshipIntent into the request round
when all writers have been connected. RelationshipIntent retains its protocol
status, author profile evidence, note, times, and content heads. Keep its existing
wire validity limits, including any seven-day REQUESTED validity rule: removing
history retention does not amend the federation protocol.

The request round is durable, not rebuildable from current compacted intents.
A receiver node that never saw the original S2S REQUESTED cannot fabricate its
history from REVOKED. Apply revocation effects without inventing a request record.

### 2.5 Account incoming head

Add the following fields directly to Account; do not create a separate state table:

- requestEndId: bigint NOT NULL DEFAULT 0;
- requestReadId: bigint NOT NULL DEFAULT 0;
- CHECK 0 <= requestReadId <= requestEndId.

These are request IDs, not ClientStateFeed positions. No FK to an arbitrary global
request ID is sufficient proof of ownership; domain writes must ensure the end
belongs to an incoming request for that account. A read command is bounded by
that account's current end and only advances read monotonically. It grants no
other capability.

On new incoming request insertion, update requestEndId and publish the complete
head in the business transaction. On a read change, update requestReadId and
publish it. Terminal changes do neither. Lock all affected account/group scopes
in the established order **before allocating the new request ID**: a global
sequence alone does not guarantee commit ordering. A late lower ID must not
appear behind an already acknowledged higher incoming ID for the same recipient.

### 2.6 ClientStateFeed

Retain userId, feedId, body, createdAt, and updatedAt with a composite
(userId, feedId) primary key: every published version appends one immutable
row, and a record keeps the feedId it was published under. Retain the
Account.clientStateFeedEndId allocator. Remove id and its sequence, eventType,
compactionKey, and their constraints. The composite key handles both identity
and the per-user cursor range scan without a second index. Remove intent-only
account/namespaceId/subjectAccount/subjectNamespaceId columns and the namespace
FK. Preserve the profileNamespaceChangeEndId response hint. Future state kinds
append their own rows on the same per-account feedId sequence; the typed body
discriminates content, so no event-type column is needed.

The single head body (no event discriminator):

```json
{ "requestEndId": "42", "requestReadId": "37" }
```

The ordinary envelope feedId orders complete head snapshots and cursor commits;
it is not a third request watermark. Remove intent-age filtering from feed query.
Published rows are permanent transport history with no GC expiry; clients fold
the range into their current head and may forget coordinates older than their
full-sync boundary.

### 2.7 Group manager state

Reuse existing group request counters, manager read fields, ThreadFeed delivery,
and durable fan-out, but allocate new-request coordinates only for new rounds.
Terminal changes must not advance manager unread heads. Keep existing invitation
head behavior only where it is still required by group management consumers;
do not add a personal sent head or silently remove unrelated group fields.

Group query responses return their group-scoped application read/end coordinates;
they are distinct from global round IDs and personal notification heads. Maintain
request ID as the action identity even when manager read transport uses existing
scoped coordinates. Preserve new-manager initialization and role-change checks.
Remove GC-driven read advancement. Audit SQL triggers and Drizzle constraints
for parity before changing any manager field meaning.

## 3. Web and native storage

Delete IndexedDB relationshipRequests and SQLite relationship_requests, their
indexes, query/cleanup APIs, reducer modules, request-store IPC, and request-only
reset/rebuild branches. Keep profile/thread/message storage and stateFeedCursor.

Remove the four old request sync keys:

- relationshipRequestStateRevision;
- relationshipIntentStateRevision;
- relationshipRequestReadHead;
- relationshipRequestCleanupAt.

Use one fixed account record: IndexedDB `accountState`, SQLite `account_state`,
and shared `AccountState`. Merge account metadata and synchronization coordinates;
there is no separate account_meta table or arbitrary sync key/value storage.
Keep schema version 1 and directly replace the baseline layout, without migration.

The fixed fields are schemaVersion, selfProfile, selfIdentity, composerDrafts,
threadFeedCursor, stateFeedId, stateFeedFullThrough,
profileNamespaceChangeEndId, intentRequestEndId, intentRequestReadId, and
intentRequestOptimisticReadId. Structured profile/identity/draft fields are typed
JSON, not an arbitrary metadata dictionary. Device preferences, session storage,
and message-cache schema metadata remain separate.

The server head maps to intentRequestEndId and intentRequestReadId and commits
atomically with stateFeedId. Source feed ordering uses the normal feed apply guard.
The local optimistic read target is intentRequestOptimisticReadId, not a separate
synchronization target. It comes only from an observed successful RECEIVED page,
is persisted before submission, and survives transient failures for retry. A
confirmation clears only a target it covers; stale responses must not clear newer
intent. Badge comparison uses end > max(confirmed read, optimistic read), with
bigint-safe comparison. No SENT notification or optimistic fields exist.
HTTP responses must not overwrite a newer durable feed head. Each owner updates
only its own fixed fields inside a transaction, preserving concurrent changes.
These storage contracts are approved; optimistic retry and UI orchestration
remain implementation work.

Change account-cache schema identity / strict validation as needed to reject old
layouts, with no old-request migration. Preserve preferences and session state;
coordinate with concurrent session/cache work. Do not use a blanket SQLite file
delete. Native PRAGMA user_version currently has a separate media cleanup meaning
and must not be repurposed. Message-cache schemas do not need changing solely
for request removal.

## 4. Shared method extraction and reuse

Inspected current implementations:

- Web friend-request-state.ts: applyFriendIntentToProjection,
  applyGroupIntentToProjection, updateLiveProjection, boundedIntentExpiry.
- ClientStateFeedService.writeGroupRequestInTx: shared group read/compare/write.
- group-membership-projection-sql.ts: requestProjectionFlipSql.
- FederationGroupRequestProjectionService.writeEffectsInTx: adapter from intent
  state to group presentation.
- GroupService.queryGroupRequests: shared group paging and computed expiry.

Move reusable request behavior to `src/relationship/request/`, not generic feed
infrastructure. Proposed capabilities:

1. `openRequestInTx`: detect retry/new flow under existing locks; create immutable
   presentation, owning-intent association, and new-request notification effects once.
2. `concludeRequestInTx`: update only the matching live REQUESTED round, with an
   explicit ACCEPT/REJECT/WITHDRAW/EXPIRE cause. Return changed/no-op. Reciprocal
   REVOKED must not rewrite an already-decided REJECTED into WITHDRAWN.
3. `requestStatusAt`: server-side effective status for query/action validity;
   share expiry logic across personal/group views. Querying never deletes rows.
4. `queryRequestPage`: shared window/keyset/DTO construction given an already
   authorized personal or group scope.
5. `markIncomingRequestsReadInTx`: reuse current account locking, monotonic read,
   atomic head write, and post-commit wake pattern with request IDs as the bound.

The definition-only internal port is now captured in
[request-transaction.contract.ts](../../src/relationship/request/request-transaction.contract.ts).
Its proposed responsibility split requires review before implementation:

- The existing intent state machine determines admission under its locks; the
  command no longer supplies a parallel NEW/RETRY decision. Newly admitted
  rounds store evidence and update intent.requestId atomically. Same-round
  authoring retries preserve the original evidence.
- Open returns CREATED/UNCHANGED plus the stored round and post-commit client
  hints, or STALE_REQUEST. A stale result never silently addresses a newer round.
- Conclusion names the exact flow/ID and explicit cause. It returns CHANGED or
  STALE_REQUEST. Missing intent association and terminal intent states fail;
  there is no ALREADY_COMPLETED success. The intent owner checks expiry and
  authorization; EXPIRE requires an elapsed deadline. Established friendship
  revocation does not conclude or rewrite the request record.
- Query receives a scope authorized in the same snapshot, a bigint cursor,
  take, and captured server time. The scope type itself is not a security grant.
- Read returns CHANGED/UNCHANGED with a complete bigint head and post-commit
  hints, or READ_AHEAD for the application to reject. Invalid negative input
  rejects. No method commits independently or publishes before commit.

These signatures do not register a provider, change the wire protocol, or fill
in the request lifecycle implementation. Existing raw-SQL intent operations
must share their semantics rather than grow a parallel decision engine.

Reuse shared/request-projection-status.ts and shared/request-snapshot.ts directly.
Use the existing intent services for business decisions, quota, authorization,
reciprocal conclusion, and ThreadFeed effects; do not create a competing decision
engine. Keep raw-SQL transactional callers: extract common SQL fragments where
needed rather than a second SQL-only rule set beside TypeScript behavior.

Do NOT copy client feedId guards, direction inference, local accept patches,
seven-day GC, default profile revisions, or `note || oldNote` fallback. Empty
note is valid. Client reducer fixtures should become domain tests for invariants,
not preserve transport-specific quirks. The existing group SQL's explicit
"only REQUESTED changes" guard is reusable; old cascade/key/storage layout is not.

## 5. HTTP API proposal

Reuse route conventions and existing domain command services. Names below are
relative to `/api/v1`. Responses use the normal API envelope.

### 5.1 Personal list: POST /relationship/requests

New endpoint, following existing group POST query conventions:

```json
{ "bucket": "RECEIVED", "before": null, "take": 20 }
```

bucket is RECEIVED or SENT; before is an exclusive request ID decimal string; take is
1..50, default 20. Initial before may be omitted. Query authenticated identity,
not a caller-supplied account ID.

Response data:

```json
{
  "items": [],
  "hasMore": false,
  "before": null,
  "incomingHead": { "requestEndId": "42", "requestReadId": "37" }
}
```

Each item contains id (decimal string), kind, direction, ordered endpoint
identities, status, note, requestedAt/expiresAt/createdAt/updatedAt, and strict
presentation. OUTGOING uses required snapshot; INCOMING uses exact author
reference. No threadId, domain string, sourceFeedId, or client reducer fields.
The head is account-scoped and may accompany either bucket; opening SENT must
not mark incoming requests read.

Recommended seven-day predicate: `createdAt >= statement_timestamp() - interval
'7 days'`. This means seven days since first local recording. It is not based on
updatedAt, so rejection/retry does not bring old requests back into the window.
The API never accepts a client-selected earlier window. This time basis remains
a review choice; requestedAt would instead mean seven days from original request.

Newest request IDs first, stable across status changes. Filter `id < before`
when supplied. Authorization scope and bucket come from the authenticated query,
not the cursor. Every page enforces both scope and the current seven-day window. New arrivals appear on a
refresh, not spliced into later pages. States are current at each page snapshot;
this is not an immutable multi-page history snapshot. No durable list-change
revision is needed. Read data and returned head in one read-only snapshot.

### 5.2 Existing POST /relationship/requests/read

Change body to `{ "requestReadId": "42" }`. Return the complete authoritative
incomingHead. Use the head observed with a successful RECEIVED query; do not use
a global feed cursor or mark read before loading the list. Duplicate/lower reads
are no-ops. A value above the account's current end is validation failure. The
concurrent new request remains unread. No local optimistic persistence or
optimistic badge clearing before server success.

Opening the list acknowledges its observed head, including older entries no
longer returned by the seven-day API. Time-window disappearance does not itself
advance read state or create a new notification.

### 5.3 Personal request decisions

Keep `/relationship/request` for new outgoing requests and existing quota/domain
orchestration. Reuse `/relationship/accept` as a request-only decision with
required requestId. Add `/relationship/requests/reject` and
`/relationship/requests/withdraw`, each requiring requestId, instead of ambiguously
using a general address-only revoke operation for a historical card.

Keep `/relationship/revoke` and RevokeRelationshipDto, now taking only
`{ threadId }` to remove an established P2P relationship, symmetric to group
leave. The former `{ account, namespaceId }` body is rejected, not supported as
a compatibility path. Recheck the active pair, thread and captured authorization
epoch under existing business locks before revocation; an unlocked locator is
not authorization. This operation does not rewrite ended request history and
is not a fallback path for request-card decisions. Existing group acceptance entry points
must also resolve/check the same round, not bypass a new requestId guard.

Resolve endpoints from the authorized request row. Under business locks verify
the intent's requestId association, requester/receiver role, REQUESTED status,
validity, and existing authorization. Explicitly reject stale/wrong-scope IDs;
a historical ID cannot act on the latest round. Completed request decisions
fail rather than returning an already-completed success. Seven-day list
visibility is not the authorization or validity check for an action.

Return the existing business outcome and a threadId only if the resulting domain
operation actually provides an active conversation. Client refetches after action;
it does not persist a local status patch.

### 5.4 Group management routes

Reuse POST /group/join-requests and /group/invitations with groupId, before, take.
Reuse guards, but revalidate manager authority in the same snapshot used to read
the page. Use the same seven-day window and record serializer as personal lists,
with group-specific scope and snapshot/reference direction.

Reuse /group/join-requests/read and its existing scoped read semantics. Add
required requestId to /group/join-request/accept, /group/join-request/reject, and
/group/invitation/revoke; resolve the member from that request and validate its
group/direction, rather than trusting redundant caller-provided member identity.
Keep group creation/invitation submission, roster changes, kick/leave, and role
APIs in their existing domains. Do not broaden request access through snapshots.

## 6. List refresh without notification watermarks

New incoming IDs naturally cause StateFeed wake/head sync. Terminal changes and
outgoing changes do not advance this head and must not generate a red dot.
Use an ephemeral post-commit list-invalidation SSE hint for currently authorized
viewers; no durable change counter is added. Coalesce hints and refetch only an
open list. After own actions, opening the list, reconnect, or application focus,
fetch again. A bounded polling interval while the list is visible (proposal:
30 seconds) repairs lost invalidations without durable request replication.

Ignore stale HTTP responses using in-memory account/session/filter/fetch
 generations. These are request-lifecycle guards, not stored read optimism.
Offline shows unavailable/stale state, not a successful empty list. Full
instantaneous cross-device agreement is not promised; every successful refresh
reads the same server authority.

## 7. Removal and verification checklist

Remove GroupService.garbageCollectJoinRequestProjections, its interval/callers,
GC-only SQL, auto-read advancement, and tests that expect deletion. Remove Web
cleanupRelationshipRequests, cleanup sync keys/timers, and native cleanup IPC/SQL.
Keep RelationshipIntentExpiryService and protocol conclusion jobs: expiry is
not deletion. Keep permanent rows after both expiry and the list time window.

Required tests:

- New round versus retry; only a new incoming ID lights the badge.
- Every terminal status preserves ID, original presentation, and history.
- Local/federated friend, application, invitation; crossed requests; reciprocal
  REVOKED; internal group founding; missing S2S predecessor.
- Two-device read synchronization, arrival racing read, no outgoing/terminal
  notification, and no optimistic local read state.
- Permanent old rows remain in SQL but never escape the API window, including
  cursor tampering, terminal updates, multiple pages, and query-plan worst cases.
- Stale requestId cannot affect a later round; manager permission races rejected.
- All intent/request/slot/head/feed writes roll back atomically; sequence allocation
  cannot introduce same-recipient out-of-order committed arrivals.
- Fresh online list restores terminal records without cached predecessors;
  Web/SQLite retired stores absent, heads/cursors survive restart.
- No database truncation in tests except isolated test-owned databases.

## 8. Remaining review choices

1. Approve append-per-round permanent history and current-slot pointer (rather
   than overwriting previous rounds).
2. Approve createdAt as the seven-day API window basis and newest-ID ordering.
3. Approve bigint round IDs as action tokens and personal incoming heads; normal
   ClientStateFeed cursor type remains unchanged.
4. Approve the route shapes/required request IDs and the visible-list refresh
   mechanism without a persisted change head.
5. Snapshot records remain forever; should their avatar assets remain accessible
   forever, or only throughout the API-visible window? Do not promise permanent
   media retention merely because the JSON record is permanent.

No unresolved point licenses changing the restored S2S protocol or adding back
client request projection storage, outgoing heads, optimistic reads, or history GC.
