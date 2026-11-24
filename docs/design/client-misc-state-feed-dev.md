# Deferred implementation: client tombstone and metadata state feed

Status: agreed follow-up direction, not implemented. Recorded on 2026-11-22.
Complete the existing federation reverse-tail/tombstone/history-gap work before
starting this change. This is a development handoff, not a federation protocol
change. Do not modify `spec/v1` for this client-only work.

## 1. Current client state-feed inventory

The client state feed currently has one semantic item body:

```text
{ feedId, body: { requestEndId, requestReadId } }
```

It represents the account's incoming personal request attention, including friend
requests and group invitations. There is currently no item-type discriminant.

- `src/client-state-feed/client-state-feed.service.ts` publishes the request head.
- `src/controller/user.controller.ts` returns the state-feed page.
- `shared/relationship-request.ts` defines `IncomingRequestHead`.
- `ClientStateFeed` in `src/database/schema.ts` stores user ID, feed ID, and body.

The response envelope also carries `profileNamespaceChangeEndId`. This is the
head of a separate profile-namespace change feed, not another state-feed item.
The internal `PendingClientStateFeedUpdate.kind` variants are post-commit wake
categories, not client state-feed payload types. Group join-request attention is
currently represented through thread-feed coordinates.

Today `tombstoneEndSeq` and `groupMetaFeedEndId` travel in thread-feed snapshots.
Web and Rust drain them on chat opening and re-wake only the open conversation.
Ordinary list rows use `threadFeedId` for ordering, so tomb/meta-only revisions
currently move rows even if the message sequence did not change.

## 2. Agreed follow-up behavior

### Separate resource heads from conversation attention

Add a client state-feed item kind for per-thread tombstone and Group Meta heads.
Move these synchronization heads out of thread feed; do not merely copy them
into both feeds or continue using thread feed as the scheduler input.

Use the envelope `{ feedId, type, body }` with these explicit types:

- `REQUEST_HEAD`: account-level `{ requestEndId, requestReadId }`.
- `THREAD_RESOURCE_HEAD`: per-thread
  `{ threadId, tombstoneEndSeq, groupMetaFeedEndId }`; the metadata head is null
  for P2P threads.

Preserve the existing request-head behavior. Do not infer the type from the
presence of `threadId` or other body fields. Versioning and migration details
must be settled in implementation. Reuse the existing `STATE_FEED_UPDATED` SSE
wake; a new item type does not require a new SSE event.

This uses the existing account state-feed transport and cursor, not a new
federation event or an additional independent network feed. Payloads contain
resource coordinates, not tombstone bodies, member rosters, or profiles.

Publishing must respect current audience authorization. Full recovery must
reconstruct the authorized resource heads. Targets must be retained even if the
corresponding local thread projection has not arrived yet; resolving that
ordering must not depend on opening a chat.

The current request-head publisher compares against the account's latest feed
row without a type filter. Once multiple kinds exist, lookup/deduplication must
be scoped to the correct kind and resource. Add new deployed-schema migrations;
do not rewrite existing migrations.

A tomb/meta-only change must not reorder the conversation list. Moving their
heads must also remove their incidental thread-feed ordering effects. Updating a
preview to show a deletion is still allowed, but must not count as new message
activity. A simultaneous genuine new message may still change order.

### Runtime-owned global scheduling

Delete the chat-open-driven tomb/meta synchronization path, including the
open-thread admission predicate and the renderer feedback loop. Do not retain
opening a chat as an alternative scheduler owner. UI open-thread state can remain
for presentation, notifications, and read behavior, not for background pulls.

Create an app-initialized singleton scheduler in each host:

- Browser: owned by the browser synchronization runtime/worker.
- Native: owned by shared Rust, including operation without a renderer.

The implementations must have equivalent state transitions and test scenarios.
Use a simplified version of the backend federation round scheduler with message
round scheduling omitted: only tombstone and metadata lanes belong here. This
does not remove demand-driven client message/history loading or backend message
scheduling. Do not copy federation source selection or per-peer queue machinery.

Use the backend's process-local model: pending queues, active task sets, dirty
flags, and retry timers live in memory. Resource targets and processed cursors
remain durable; startup reconstructs pending work from them. Do not introduce a
durable job table for this scheduler.

Set independent concurrency limits to 4 tombstone tasks and 2 metadata tasks,
with no additional combined limit in this design. A slot covers one page round,
including its HTTP request and database commit. Reserve a slot before launching
work and release it on either success or failure; retry delays occupy no slot.
Rust must reserve/release under protected queue state without holding the lock
across network or database work.

For each login/cache generation, thread, and lane:

- An idle task is enqueued; an already queued task is not duplicated.
- A wake during execution sets dirty rather than launching a second task.
- A wake during retry backoff records pending work without bypassing its deadline.
- At round start, clear the previous dirty flag and read the durable target.
- At successful round completion, requeue if there is actionable continuation
  or dirty was set again. Requeue fairly instead of holding a slot for a whole
  thread drain. Errors follow cancellation/terminal/retry classification.
- A lightweight kick fills available slots. Coalesce duplicate pump invocations,
  but never discard new work simply because the scheduler is already running.
  Task admission and pump exit must not leave a lost-wake window.

Tombstone and metadata work remain independent, with same-thread/same-lane
single flight. Apply error retry/backoff and generation fencing consistently.

A committed state-feed update schedules affected work immediately, regardless of
which chat is open. Persist resource targets with the state-feed cursor before
publishing wakes. Startup, reconnect, and cache recovery reconcile durable pending
work so a crash between commit and wake cannot strand it. Queued and in-flight
work must remain fenced by login and cache generation. Offline/suspended work
resumes when the host can run; this does not promise execution while the OS has
suspended the app.

Cached message writes independently wake tombstone work. Tombstone cutoff
exhaustion is a blocked/no-progress result, not an immediate retry loop merely
because the applied cursor remains below the target. Resume on meaningful new
input such as cache growth or a newer target.

### Tombstone cutoff and storage

Keep the already implemented page request rules:

- `after`: last processed tombstone sequence.
- `through`: advertised tombstone target, now owned by the new state-feed item.
- `maxMessageSeq`: maximum sequence of actual messages currently cached for this
  thread, reread before each request; never capped by a remembered/advertised head.
- `take`: 50.
- Do not persist response `scannedThrough` as applied progress.

Do not persist an independent client tombstone table. Persist processed progress
and atomically apply deletion state/reason to affected cached messages. This does
not remove the backend `FederatedMessageTombstone` or `DeletedMessage` tables.

These stores already exist in the current implementation, rather than being
hypothetical future tables:

- IndexedDB object store `messageDeletions`, created in
  `web/src/app/services/webdb-storage.ts`.
- SQLite table `message_deletions`, created by `MESSAGE_DELETIONS_SCHEMA` in
  `src-tauri/src/native_db.rs`.

Explicitly remove both through versioned client database upgrades. Before dropping
them, preserve deletion state/reasons needed by existing cached messages. Remove
obsolete creation/migration paths that would recreate them, plus their live
read/write, eviction, repair, and adapter dependencies. Update tests that currently
assert independent tomb persistence. Verify upgrades from existing populated
caches as well as fresh databases; a cache repair must not resurrect the old store.
Do not change the backend tombstone tables as part of this removal.

These stores also support history TOMB results, mounted-row deletion rechecks,
and stale-response resurrection prevention. Replace these responsibilities
deliberately before removing the tables. Cover absent bodies, history TOMB rendering, cache eviction,
and in-flight history responses older than a committed deletion. A cursor alone
must not be treated as proof that a stale message response is safe to insert.

Current new-thread initialization sets the processed tomb cursor to the advertised
target. Align initialization with actual processed progress rather than falsely
claiming the initial target was applied. Define processing of deletion facts whose
message body is absent without retaining those facts in a separate durable table.

### Backend publication boundary

Unconsumed federated tombstones must not publish client deletion updates. Existing
late-tombstone processing consumes the fact and admits client fan-out in the same
transaction. Deliver the committed deletion head through the new state-feed kind.

Message insertion that consumes an earlier tombstone remains a distinct path:
it soft-deletes the inserted message and retains the consumed federated fact,
without allocating a `DeletedMessage`. Do not restore that allocation simply to
create a wake. Preserve deleted-message visibility through message/history
updates; specify any additional wake consistently with the existing local
coordinate space rather than publishing a remote deletion coordinate as local.

### Metadata and presentation

Receiving a metadata head schedules metadata pulls without opening the thread.
Metadata synchronization must not trigger profile prefetch in either host.
Remove renderer completion-driven warming and Rust's post-drain profile warming;
review startup warming for the same unwanted behavior. Keep independent,
presentation-demand profile resolution.

Chatbox deletion consumers must reject events for a different thread before
applying them. The principal mounted-message, quote, and detached-surface paths
already have this filter; preserve it and test it with multi-thread background
completion and chat switching.

### Native HTTP infrastructure

Reuse `LoginRequest`, captured request ownership, cancellation, and existing
`reqwest` transport. The current single `(origin, client)` cache can churn between
primary and secondary origins; retain reusable clients across configured routes.
Pool idle-connection limits are not request concurrency limits. Add explicit
bounded admission for scheduled short requests without starving independent SSE
long-lived streams. Never hold lifecycle or database locks across network I/O.

## 3. Acceptance coverage for the deferred work

- Mixed request-head and thread-resource state-feed pages, typed deduplication,
  audience changes, full recovery, and resource heads arriving before thread rows.
- Tomb/meta updates for unopened threads, with no renderer in native tests.
- Feed commit followed by crash/restart before the scheduler wake.
- Burst coalescing, fair bounded concurrency, transient failure, and cutoff stalls.
- Logout/account switch/cache repair reject stale queued and network results.
- Actual-cache cutoff rereads and last-processed cursor advancement only.
- No independent client tomb table; stale-response and eviction tests still safe.
- Meta completion produces no profile prefetch requests on either host.
- Tomb/meta-only updates, including deletion preview changes, preserve list order
  during live updates and after restart.
- Thread-filtered chatbox delivery during simultaneous multi-thread drains.
- Configured-origin client reuse and short-request concurrency limits.

## 4. Prerequisite: finish the previous work first

Continue using `federation-message-tombstone-pull-dev.md` and
`chat-server-gap-and-arrival.md` for the current implementation. Do not mix the
new client state-feed/storage migration into that acceptance pass. This follow-up
supersedes the earlier client tomb-table target only when its phase begins; the
backend consumed-fact retention requirement is unchanged.

Outstanding work from the previous phase:

1. Finish backend `consumed` handling and migration validation. Update tests that
   still expect consumed rows to be deleted; verify client/peer filtering and
   unconsumed logical-gap boundaries. Do not restore insertion-path
   `DeletedMessage` writes.
2. Finish shared message-round preparation. The helper was extracted, but
   relationship activation still reaches the initial gap/reservation branch in
   `reconcileRelationshipAuthorizationInTx`. The prior claim that initialization
   was fully separated was premature. Separate relationship authorization heads
   from the common per-round alignment/reservation path, without dynamic-import
   workarounds for circular ownership.
3. Exclude simultaneous forward and reverse message work for the same thread.
   Tombstones remain independently scheduled. Preserve source-selected direction
   and explicit errors on mismatched direction.
4. Reverse completion must follow the agreed remote message-end error semantics,
   not simply `hasMore=false` or closure of the current gap. Distinguish page/gap
   completion from history completion, and retry other remote errors.
5. Remove the extra subtraction from reserved-tail read boundaries: cover the
   full reserved tail slot, not `reverseEndSeq + messageSeqOffset - 1`.
6. Validate the recent wake-field rename to `mode` and shared-preparation edits;
   earlier test passes do not validate subsequent edits automatically.
7. Resolve the previously failing sync-state PostgreSQL fixtures against the new
   tail boundaries and obtain a complete two-node reverse integration result.
   Run relevant backend, browser, and Rust regression checks, recording remaining
   gaps rather than treating earlier partial results as final acceptance.

Keep unrelated workspace work intact. Do not commit without an explicit request.
