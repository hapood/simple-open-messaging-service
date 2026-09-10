# Transactional Thread Preview Sequences

Status: backend database preview cutover implemented and under verification.
Migrations `0013` through `0016` are prepared and have only been applied to isolated
test databases, not the business database.

Implementation checkpoint: Drizzle and migration `0013` declare `previewSeqs`.
The existing `ThreadFeedHeadWriter` now applies signed interval counts during
fanout/read writes. Migration `0015` removes source-message count updates and
trigger-owned read deltas. Both writers and lifecycle boundary reconciliation
reuse `thread_unread_count`; no second count implementation is introduced.
Visibility/block changes and history clearing still reconcile in their existing
transactions, bounded by the published message end. Preview references now update
in the same writer transaction, with no parallel projection service or cache fallback.
The shared `resolveReadPositionInTx` clamps the effective read position to mapped,
recoverable gap boundaries at admission and execution, logging adjustments at debug
level rather than rejecting them. It clips gaps to visible history and excludes
retired/inactive sources. New-window initialization uses the reserved local start
position in the window transaction. Backend counting includes tomb slots; message
query and client tomb persistence are implemented. The latest client lifecycle
and notification work still requires final verification before deployment.
Reverse mapped-message storage no longer admits content fanout, including media
stubs. The reverse executor now uses its existing database transaction directly,
without a preview service/cache barrier; message application, finalization, and
gap progress remain atomic. Forward storage and its fanout are unchanged at this
checkpoint.
Ordinary sending, outbound-media materialization, and system-message insertion
do not implicitly advance read or admit read tasks. The obsolete system-message
`markReadUserId` option and its relationship/group callers are removed. Explicit
client read requests use the shared durable admission/writer path; lifecycle
initialization remains a separate, intentional transaction boundary.
Mention projection now shares the fanout/read head writer. Migration `0014`
removes independent mention admission and legacy mention tasks; it has not been
applied to the business database. Migration `0015` discards old count/head snapshots
rather than importing them; it also remains unapplied to the business database.
Migration `0016` publishes preview-only changes and removes obsolete CACHE-phase
task data. Memory windows, startup hydration, cache-removal callbacks, post-commit
cache application, and the fanout cache barrier are deleted. Source page/deletion
work uses its existing database transaction; single-message writes retain the
existing `commitMessage` transaction and its client/federation fanout admission.

This replaces the memory-preview lifecycle, source-write unread arithmetic,
startup hydration, cache-key policy, and cache-before-fanout requirements in
[Unified Thread Feed](thread-feed.md). Durable projection/read transactions use
exact interval count deltas, including tomb messages, and database preview
references. This supersedes the earlier full-recomputation and count-cap proposal.
Source message storage no longer updates account unread projections.

## Database schema

Add one column to `AccountThreadState`:

```ts
previewSeqs: integer().array().notNull().default(sql`'{}'::integer[]`)
```

- Default: an empty array, including existing rows at cutover. Do not import the
  old memory cache or backfill historical previews.
- Values: positive int32 thread-local message sequences, unique and strictly
  descending. They are not `Message.id` values. The shared writer and its tests
  enforce these properties; no array-validation database function or CHECK is used.
- Capacity: `THREAD_PREVIEW_LIMIT`, currently defaulting to 5. Do not encode a
  fixed capacity of 5 in a database constraint.
- Store neither content nor author, timestamp, deletion status, or media status.
- No array index or new message lookup index is necessary: existing
  `Message_threadId_seq_key` and `DeletedMessage_threadId_messageSeq_key` support
  exact preview lookups. Array elements do not have individual foreign keys.

The current definitions are in the [Drizzle schema](../../src/database/schema.ts).
Deployment changes live in [SQL migrations](../../database/migrations/), including
the database-preview cutover. Do not rewrite migrations that may already have
been deployed.

## Fact storage and durable projection

Messages remain direct database writes. Ordinary message and deletion source
transactions admit `FAN_OUT_THREAD_CONTENT` and
`FAN_OUT_FEDERATION_THREAD_CONTENT`, atomically with facts and any forward
source-page cursor. System-message writes admit only the client task. Pending
head work MAX-merges independently for each task type; admission does not
guarantee a new row per message. There is no message-storage task, immutable
seq-batch task, or account-level fanout child task.

Group and P2P use the same executor and current-audience lookup. Sort eligible
local account IDs and process them in bounded batches (currently 50). Zero
recipients completes immediately; one or multiple recipients use the same loop
and writer, with no thread-type-specific branch.

Each batch commits its account projections and `afterAccountId` checkpoint in
one transaction. Between batches, reuse the existing `yieldToNewer` operation:
newer pending work must cover both content heads and start audience processing
from the beginning before the old task can complete. Save coverage and old-task
completion together, without successor or parent IDs. If no covering work exists,
continue processing. Recovery resumes after the saved account ID.

The source transaction does not iterate recipients. The executor neither creates
child tasks nor starts a second audience loop. It rechecks current authorization
and block state during projection; an earlier audience snapshot does not preserve
access after departure. Sender inclusion and client-owned mute behavior remain
unchanged. SSE/push hints run after commit and do not gate task completion.

Fanout and read tasks progress independently, calculating interval deltas against
locked current account/thread state. The independent federation task traverses
current direct peers, including a mirrored group's origin, using immutable
namespace IDs as its cursor. Each peer head and `afterNamespaceId` checkpoint
commit together. Both tasks share admission, target merging, yielding, and
transactional checkpoint persistence. Neither scope blocks the other in the
scheduler; their database work still observes the same business/thread locks.

After a peer transaction commits, its lossy wake-up enters the existing
per-peer one-second State Feed push scheduler. HTTP completion is not a durable
task completion condition. There is no additional controller, upload, media
completion, or message-query publication fanout path.

## Task types and reuse

| Task type | Scope | Responsibility |
| --- | --- | --- |
| `FAN_OUT_THREAD_CONTENT` | Existing `THREAD` projection scope | Discover current audience, project batches, checkpoint, and hand off only to covering work |
| `FAN_OUT_FEDERATION_THREAD_CONTENT` | Independent `THREAD` projection scope | Project current peer heads, checkpoint each peer, and yield only to covering federation work |
| `COMMIT_THREAD_READ_POSITION` | Existing `ACCOUNT_THREAD` mutation scope | Resolve client read intent and update count/previews through the shared writer |

Both fanouts share this payload, with distinct scope and coalescing keys:

```ts
type ThreadFanoutTarget = {
  threadId: number;
  messageEndSeq: number;
  tombstoneEndSeq: number;
};
// Client: JSON.stringify(['THREAD_FANOUT', threadId])
// Federation: JSON.stringify(['FEDERATION_THREAD_FANOUT', threadId])
```

Reuse `enqueueMessageFanoutsInTx`, `enqueueThreadFanoutInTx`,
`mergeThreadFanoutTargets`, `yieldThreadFanoutInTx`, and
`saveTaskCheckpointInTx`. Client projection uses
`ThreadFeedHeadWriter.advanceInTx`; federation projection uses
`FederationThreadContentHeadService.refreshInTx`. The read writer uses the
same account projection calculations. Keep audience authorization and cursor
validation specific to each executor; do not duplicate projection calculations.

`FAN_OUT_GROUP_META_HEAD`, relationship, and group dissolution/membership tasks
retain their existing business responsibilities. Do not change their task types,
child-task workflows, or completion conditions as part of thread content fanout.

Remove memory preview barriers and CACHE-only progress when database previews
replace the cache; remove obsolete stored checkpoints offline, not with a runtime
compatibility branch. Reuse held content-lock capabilities and the canonical
parent/thread/sorted-state/account-allocator lock order.

Verification gate: empty/single/multiple audiences share the same loop; projection
and progress roll back together; restart skips committed batches; newer work
covers both heads before handoff; source admission stays singular; no recipient
child tasks are created. Runtime now has the shared group/P2P loop with count and
database-preview integration.

## Projection transaction rules

| Operation | Preview update in that same database transaction |
| --- | --- |
| New empty account/thread state | `lastReadSeq = 0`, `unreadCount = 0`, `previewSeqs = []`; no nullable initialization marker |
| Actual friendship/member activation or reentry | Explicitly set `[]`; retain local-thread read initialization, but initialize federated history boundaries when establishing the forward window |
| Duplicate activation or profile/role update | No initialization/reset |
| Forward/local content fanout, including a media stub | Add the newly covered interval count and refresh highest N eligible preview seqs within the projected window |
| Reverse history insertion | No unread/preview fanout; inserted seqs must be at or below the read boundary |
| Durable read-position update | Apply a signed interval count delta and refresh previews using the actual stored read position |
| Forced backwards read | Clamp to recoverable-gap/visible bounds, then add the newly unread interval count |
| Retraction or moderation projection | Do not change count; publish the deletion head and resolve preview slots as tombs |
| Relationship deletion or group departure | No preview-specific update |
| Peer/namespace replacement or retirement | No preview-specific update |
| History clearing | Recompute according to the new visible history boundary |

Relationship deletion does not schedule or directly perform array cleanup. If a
business operation independently advances the read position, the common read
projection rule still applies; it must not have a separate memory deletion path.

For block, retain stored references but suppress preview presentation and content
fanout. Actual unblock uses the shared initialization path: empty references and
the current visible read head. Repeated unblock is a no-op. Initialization does
not create a preview hydration task. Ordinary read requests retain their durable
task path; do not move them back into the HTTP transaction.

Message eligibility requires an active relationship/member, an available local
owner, an unblocked state, the current nonretired authority namespace, and the
message being inside the visible window with `seq > lastReadSeq`. Exclude the
owner's own messages before applying capacity. Preserve the current exclusion of
authorless system rows from previews. A tombstone already associated with an
inserted message may occupy its seq slot with a deleted status.

Use one transaction-level fact projection writer for fanout and read tasks.
Pass N explicitly
from application configuration; database functions must not rely on a nonexistent
access to the process environment or on session settings leaking between pooled
connections. Merge against the locked current state row, not a caller snapshot.

Remove the existing source-message unread increments/decrements. Replace the
existing read delta with the projected-end-bounded calculation below. Retain
necessary message locking; do not drop a shared trigger's unrelated responsibilities. The state
trigger owns feed allocation, not a second competing count algorithm.

Mention projection runs in that same writer transaction. Scan added message
intervals for the latest semantic mention. For tomb advancement, rescan surviving
unread mentions only when the new tomb interval contains the current pointer.
Read advancement clears a passed pointer; force rollback searches the newly
unread history. Clearing history also invalidates pointers through the shared
writer. There is no independent mention task or mention-task admission trigger.

Count message slots regardless of `isDeleted`; a tomb retains its original seq
and sender and is not a second message. Exclude own messages using the same
identity rule before and after deletion. Preserve existing system-message count
eligibility; do not silently equate it with the authorless-row preview exclusion.
Select the largest N eligible other-sender preview seqs within `(R, E]`, including
tomb slots. Preview capacity does not limit the count.

Persist `unreadCount`, `previewSeqs`, the fact heads used by that calculation, and
task progress atomically. Do not calculate current facts and then write an older
task target as though it described the result. The preview array is descending;
the public preview response remains ascending.

Covered content heads may skip duplicate projection. The completeness invariant
below must prevent a later unread insertion below an already projected end.
Reverse insertion is deliberately outside the unread window and creates no
unread/preview work. A changed read position still updates its interval and
previews even if both heads match.
Lifecycle/visibility changes must not be mistaken for duplicate content hints.

Only material projection changes allocate a feed ID. A changed tombstone head
must allocate and wake notifications even if count and seq array are unchanged,
because referenced preview deletion states can change. Media download completion
does not republish previews. Notify SSE/push after commit; notification delivery
does not determine durable task completion.

### Exact interval counts and read admission

Let `R = lastReadSeq`, `E = messageEndSeq`, and `C(a, b]` count eligible message
slots, including tombs, in that local-sequence interval. An empty interval counts
as zero. `unreadCount = C(R, E]`; it is exact and nonnegative, with no cap of 100.

- Forward projection `E0 -> E1`: add `C(max(E0, R), E1]`.
- Read advance `R0 -> R1`: subtract `C(R0, min(R1, E)]`.
- Forced read retreat `R0 -> R1`: add `C(R1, min(R0, E)]`.
- Retraction/admin deletion: no count delta, regardless of task execution order.

Persist the interval delta, actual read/end positions, preview references, and
task checkpoint atomically. Read may move beyond E; clamping read deltas at E
prevents subtracting messages not yet counted. Fanout must advance to a committed,
complete local boundary, not a remote advertised target or an unfilled reservation.

All future reverse backfill must lie at or below R. No unresolved interval that
can later materialize eligible messages may intersect `(R, E]`. Read admission
and execution, including force, clamp positions below the latest applicable gap
upper boundary to that boundary in local coordinates and emit a debug log. A
present row alone does not prove completeness. Resolve again under the canonical
locks because gaps can change after admission. Positions above the visible upper
bound are also clamped with a debug log. Negative or noninteger coordinates still
produce validation errors; monotonic reads never decrease an already stored read.

When admitting a non-force read, a larger processing/pending read in the same
account/thread scope can cover the new request. Do not create redundant lower
work, and never cancel the larger existing task. Do not compare across a force
barrier: `read 100 -> force 20 -> read 50` must retain the last request. Execution
still uses the actual stored read position and monotonic non-force semantics.

Keep the canonical business/pair/thread/state/account lock ordering and sorted
account writes. There is no memory operation to coordinate with commit or rollback.
Do not wait for network calls or scheduler execution while holding these locks.

Changing preview capacity applies on the next projection recomputation and to
response limits. No memory startup sweep is needed.

### Forward-window initialization

Creating account/thread state writes zero read/count and empty previews. The
transaction establishing a new federated forward window then advances read to
`max(existing lastReadSeq, reserved local window start position)` and adjusts the
count through the shared read writer. It commits together with the gap reservation
and initial source cursor, before the first forward page is consumed. This is
initialization, not a separately queued read request.

The current entry point is
[`reconcileThreadHeadInTx`](../../src/federation/federation-thread-sync-state.service.ts).
For a new reverse-enabled mirror, source history ends at `messageTargetSeq - 1`;
its local upper boundary is `endSeq + messageSeqOffset`. The newest advertised
message remains for forward consumption and must not be implicitly marked read.
An authorization-epoch transition can also establish a new historical gap and
must enforce the same boundary rule. Merely raising targets in an existing window
must not advance read. The reverse-disabled replay branch must be audited against
its existing local facts rather than treated as a new mirror.

Use existing synchronization state to distinguish initialization from ordinary
rounds; zero is a valid read position, not an initialization flag. Move federated
read-boundary setup out of relationship activation's `initializeReadWindowsInTx`.
Ordinary forward rounds and reverse rounds must not reset read. Lock order must
remain consistent with source-window, account-state, and feed-allocation writers.

## Query and API

Keep `POST /thread/feed-delta`, its pagination/cursors, `previewCount`, and the
existing `ThreadFeedPreview` response shape unchanged. `previewSeqs` is an internal
projection field, not an additional public response field.

For a page requesting previews:

1. Read the allocator, state rows, and referenced message/tombstone facts in the
   same repeatable-read snapshot.
2. Check current relationship, block, namespace, read, and visibility eligibility.
   An ineligible thread returns `previews: []`; it still participates in feed
   cursor consumption. Never expose retained references across namespace changes.
3. Select up to `previewCount` largest eligible stored sequences and return their
   previews in ascending seq order, as before. Batch lookups for the page rather
   than issuing a query per message.
4. Return `LIVE`, `USER_RETRACTION`, or `MODERATION_REMOVAL` from database facts.
   Deleted entries contain no original text. Keep client-side avatar resolution.

With `previewCount: 0`, omit previews and do not query message bodies. Empty arrays
or physically missing message facts produce fewer previews; never query arbitrary
history to refill. Querying does not change the stored array. No missing-cache-key
error, initialization readiness wait, or memory fallback remains.

Source facts may be newer than the published projection while a task is pending.
Count, preview references, and projection heads nevertheless describe one committed
calculation. Do not introduce a second preview feed to close this temporary gap.

Client message query APIs must return a
tomb message at a deleted message's original seq instead of omitting that slot.
The tomb contains sender identity and a withdrawal/admin-deletion discriminator,
never the original body. Keep tomb-feed transport for deletion synchronization;
receiving it before the message must not create a second counted slot.

The client history API now returns a query-only union, with `contentType: 'TOMB'`,
`isDeleted: true`, and `deletionType: 'USER_RETRACTION' | 'MODERATION_REMOVAL'`.
Tombs retain `threadId`, `seq`, `creator`, `profileRev`, `createdAt`, and `updatedAt`.
They contain no `content`, quote, asset, media-status, or internal database ID.
Deletion facts and page coordinates are selected in the same database snapshot;
only live rows enter quote/media enrichment. Both pagination directions count
tomb slots toward the page size. The stored/sendable `ContentType` enum is not
extended: clients cannot author a tomb as a message.

The query contract and browser tomb storage are implemented. Browser single-row
writes and page commits use one deletion-preserving merge. A deletion received
before its message stores only coordinates and reason; a later message supplies
identity without restoring body fields. Deleting an existing message erases its
body immediately. Browser cache versions are bumped for rebuilding, without
importing old deleted-body records. Tomb rows are not returned as newly mounted
messages.

Native single-row writes, page commits, and deletion consumption likewise use one
transactional slot writer. It removes the synthetic text placeholder and the old
skip-on-deletion upsert, retains only tomb identity/reason, and filters deleted
rows from newly mounted page results. Native cache version 21 requires rebuilding
old caches without importing their message bodies. Existing message-range and
deletion-cursor transaction boundaries are unchanged.

Federation transport remains unchanged: existing message rows retain their local
coordinate and author when a tombstone is consumed; a tombstone arriving before
its message remains a pending deletion fact. Messages omitted before federation
delivery do not create local counted slots. The client query-only tomb union does
not extend the federation message protocol.

Browser and native storage expose the same interval count operation for the
existing attention reducer. It counts known slots in `(afterSeq, throughSeq]`,
including tombs and STUB/FAILED messages, excluding the owner's exact normalized
identity. Authorless system messages count; deletion-only markers and absent
sequences do not. Callers must intersect the range with the snapshot's published
message end and visibility bounds before querying. No count cap applies.

The foreground list now consumes `THREAD_FEED_UPDATED` and `thread/feed-delta`.
Thread snapshots and the page cursor commit through the common local merge;
browser core cache version 19 and native version 21 rebuild the renamed
`threadStates` / `thread_states` storage. `threadFeedId` orders snapshots and
`threadFeedCursor` tracks completed feed pages. The old read-delta endpoint,
read-revision SSE branch, pending-read barrier, and client State Feed content-head
consumer are removed. Viewport dwell submits reads directly and uses the existing
attention reducer plus the shared interval-query entry point for optimistic
counts. Local message commits also trigger that same projection. Count intervals
are capped by the snapshot's `messageEndSeq`, never by a newer locally cached head.
List previews come from the snapshot, without a separate message-body fetch.

Generated client types, system-notification consumers, and mounted-message tomb
presentation remain pending. This intermediate version must
not be deployed as a completed protocol cutover or with old clients.

Client databases retain a tomb record instead of deleting the message record.
Mounted messages transition to tomb presentation; unmounted records need no
immediate rendering. Optimistic read-count reconciliation counts these same tomb
slots and uses the remote read position as its correction baseline, without
overwriting the local optimistic read position. This protocol change must be
implemented jointly with backend count semantics; no old-client compatibility
branch is planned.

## Removal inventory and implementation gates

Removed runtime implementations and obsolete cache-only tests:

- `ThreadPreviewCache`, its window map, `initializeWindow`, `insert`, `delete`,
  `deleteFromThread`, `removeWindow`, `removeThread`, `captureRemoval`, `pruneRead`,
  readiness checks, and startup hydration.
- Cache wrappers `commitMessageNow`, `commitMessageBatch`,
  `commitDeletion`, `commitDeletionBatch`, `commitVisibilityChange`,
  `commitCacheRemoval`, `commitWindowChange`, `commitThreadMutation`, and
  `commitReadPosition`. Preserve their necessary database transaction boundaries
  in the owning writer; do not split messages from source cursors or task admission.
- `prepareMessageInTx`, `loadWindows`, `hydrate`, `applyWindow`, memory-oriented
  `previewMessages`, `serializeConsumption`, and `removeArchivedThreadPreviews`.
- `ThreadFanoutBarrier` and cache-only waits/checkpoint phase. Start fanout at its
  database projection phase; keep durable admission, scope ordering, yielding,
  checkpoints, recovery, and best-effort SSE/push unchanged. Remove obsolete
  cache-phase checkpoints in the migration, not a permanent runtime fallback.

`ThreadPreviewService` and its existing module now own only database preview reads,
transactional initialization, and the existing single-message `commitMessage`
transaction/admission. These are active database methods, not compatibility
wrappers; reuse them instead of adding another service. All memory members and
post-commit application methods are removed.

Retain the configured preview limit and shared message formatting, read-position
writer, and eligibility predicate, relocating/renaming them according to their
database responsibilities. Do not remove generic scheduler or database startup
requirements along with cache readiness. No column is removed by this preview
change; `lastReadSeq`, `unreadCount`, `lastMentionSeq`, and both content heads stay.

The database writer, snapshot query, and caller cutover are implemented. Next, inventory
message DTOs and client storage before choosing the concrete tomb wire union;
the existing database deletion facts need not be replaced by a new content enum.
Verify single/page insertion, reverse insertion at or below read without fanout,
own messages, read deltas/rollback, exact counts well above 100, deletion before
and after message projection, tomb-before-message delivery, new-window read
initialization, ordinary rounds preserving read, local gap coordinate mapping,
force clamping across unresolved gaps, read beyond projected end,
reentry reset, retained references after departure/namespace change, block/unblock,
and concurrent source/read/fanout transactions before the next review gate.
