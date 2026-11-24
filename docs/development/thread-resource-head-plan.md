# Thread resource-head fanout

Status: agreed direction for the current Group Meta cutover. Recorded on
2026-11-23. This is the executable slice of
[client miscellaneous state-feed](../design/client-misc-state-feed-dev.md).
It does not start that document's scheduler rewrite, tomb-store removal, or
HTTP-pool work.

## Why now

Client Group Meta facts already allocate `clientMetaEndId`. Tombstones already
allocate `tombstoneEndSeq`. Neither has its own wake. Both coordinates still
ride the thread-content fanout and the thread-feed snapshot. A count, profile,
announcement, or deletion that does not also move message content therefore
does not reliably wake a closed conversation.

## Scope

Publish one new client state-feed item, `THREAD_RESOURCE_HEAD`, and make
browser and native drains consume it without opening the chat.

Keep using the existing account state feed, cursor, and `STATE_FEED_UPDATED`
wake. Do not add an SSE event, a federation event, or a second feed.

Out of scope for this slice:

- The in-memory tomb/meta scheduler, concurrency limits, and crash-restart
  queue described in the miscellaneous plan.
- Removing IndexedDB `messageDeletions` and SQLite `message_deletions`.
- Profile-warming removal and origin HTTP client pooling.
- Changing S2S `THREAD_CONTENT_HEAD` or mirror source cursors.

Those remain in the miscellaneous plan. This slice must not block on them, and
must not invent a second temporary scheduler.

## Item

```ts
type ThreadResourceHead = {
  type: 'THREAD_RESOURCE_HEAD';
  threadId: number;
  tombstoneEndSeq: number;
  groupMetaFeedEndId: number | null;
};
```

- `groupMetaFeedEndId` is the client projection coordinate, `clientMetaEndId`.
  It is null for P2P. It is never `metaEndId`.
- `tombstoneEndSeq` is the local thread deletion head already stored on
  `MessageThread`.
- The body contains coordinates only. No roster, profile, tombstone body, or
  announcement text.
- Request-head items stay untyped until this cutover adds an explicit
  `REQUEST_HEAD` type on newly written rows. Readers accept a missing type as
  `REQUEST_HEAD` so old rows remain valid. New writes always include a type.
  Deduplicate and recover by type plus `threadId`, never by the latest row of
  any kind.

## Publication

One method owns the item. Callers do not build the body or decide the feed id.

Admission matches the other projection tasks. The source transaction only
enqueues `FAN_OUT_THREAD_RESOURCE_HEAD` under the thread-content lock. It does
not compare coordinates and does not write the client item.

- The payload is `{ threadId }`. The handler reads the current heads; the
  payload is not a stale snapshot to merge field by field.
- One `PENDING` task per thread. A later admission in the same or another
  transaction updates that pending row. If the scheduler has already claimed
  it, append a successor instead of dropping the wake.
- The handler publishes one `THREAD_RESOURCE_HEAD` per local member from the
  heads it reads, then notifies after each committed member. Push coalescing
  stays in `notifyFeedUpdated`.
- Retry of an unfinished task may publish the current heads again. That is
  the same lossy post-commit wake model as thread-content fanout, not a
  comparison against the previous item.

Admit this publication in the same transaction as the coordinate change:

- Authoritative announcement and profile methods, only when `clientMetaEndId`
  advances.
- Client member-count reconciliation, only when `changed` is true.
- Mirror profile, announcement, and completed count publication, on the same
  condition.
- Local deletion commit that advances `tombstoneEndSeq`, including consumed
  federated tombstones. Do not publish an unconsumed remote tombstone.
- Do not publish because `metaEndId` or a mirror source cursor moved.

A message-only thread fanout must not be required to deliver these heads.
Existing thread fanout may continue to publish message heads. It must stop
being the only path that advances a member's view of tomb or client meta.

## Client drain

Browser and native runtimes, not the open chatbox, consume
`THREAD_RESOURCE_HEAD`.

- Persist the head before acknowledging the state-feed cursor.
- A meta head schedules the existing Group Meta full/delta pull through
  `clientMetaEndId`. A tomb head schedules the existing tombstone page pull
  through `tombstoneEndSeq`.
- Opening a chat is not the scheduler. It may still render from already applied
  local state.
- Metadata completion must not prefetch profiles.
- A tomb-only or meta-only head must not change conversation list order. A
  real message fanout may still reorder.

Until the miscellaneous scheduler exists, each host may drain a received head
immediately on the existing state-feed worker, with the same generation fence
already used for request heads. Do not add a durable job table for this.

## Cutover

Old clients still learn tomb and meta from the thread snapshot. Keep writing
those snapshot fields during this slice so an old client does not go silent.
New clients prefer `THREAD_RESOURCE_HEAD` and must not treat a thread-feed
advance as proof that meta or tomb changed.

Do not rebase an old `groupMetaFeedEndId` that still holds an S2S coordinate.
A cursor beyond `clientMetaEndId` already takes the existing unavailable-cursor
recovery. The first resource head after cutover is what wakes that recovery
for members who are not otherwise pulling.

## Sequence

1. Add the typed item, reader compatibility, and `publishThreadResourceHeadInTx`.
   Test unchanged coordinates, per-member allocation, P2P null meta, and no
   thread-list reorder.
2. Call it from announcement, profile, count, and tombstone commits. Return
   wakes to existing post-commit notifiers.
3. Teach browser and native state-feed application to persist the head and
   start the existing meta and tomb pulls without opening the thread.
4. Stop depending on thread-content fanout for meta-only and tomb-only wakes.
   Leave message fanout unchanged.

## Non-goals

Do not remove member facts, change S2S Group Meta, or publish member events to
clients. Do not start the deferred tomb-store deletion or the four-slot
scheduler in this change.
