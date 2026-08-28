# Message deletion and federation

## Invariants

- A withdrawn message is a deleted message. `Message.isDeleted=true` is authoritative for reads; clients do not render the deleted message as a placeholder. A separate structured system event records the visible timeline notice.
- An effective moderation action uses the same deletion log with type `MODERATION_REMOVAL`. A report that only changes the reporter's local visibility is not a federated deletion.
- Federation propagation depends on whether the remote node is entitled to replicate the conversation, not on whether the reason is `USER_RETRACTION` or `MODERATION_REMOVAL`.
- P2P withdrawal authority is the creator's home server. A group origin is the authority for its accepted group timeline: a foreign author submits a withdrawal, and the origin validates and directly publishes the resulting group deletion.
- The stable federated target is `(thread, creator account, creator domain, originSeq)`. A receiver's local `Message.seq` is never sent or persisted in the federated tombstone.

## Local flow

`DeletedMessage` is an append-only per-thread log. Each row contains
`threadId`, thread-local `deletionSeq`, target `messageSeq`, deletion type,
`createdAt`, and `updatedAt`. Its primary key is `(threadId, deletionSeq)`, and
`(threadId, messageSeq)` is unique because a message reaches only one terminal
deletion fact. `MessageThread.deletionSeqAllocatedThrough` allocates the next
deletion sequence atomically and starts at `0` before the first deletion. There
is no global `DeletedMessage.id`; database identity, local queries, client
hints, and federation publication all use the explicit thread coordinate.

No new table is required. `MessageThread` owns the allocator and
`DeletedMessage` owns the facts. The former global tombstone-source
`sourceScannedThrough` tied to `DeletedMessage.id` is removed with that ID;
projection maintenance compares or publishes each thread's explicit deletion
end instead.

The compact client tombstone feed retains its outer feed IDs. Federation
publishes each thread's deletion end together with its message end in the
compacted State Feed `THREAD_CONTENT_HEAD`; the thread-level deletion query
uses `DeletedMessage.deletionSeq` directly. A federation pending fact is deduplicated by
`(sourceDomain, thread, remoteDeletionSeq)`, because a source may reuse the same
thread-local deletion sequence in different threads.

On thread-list initialization, the app consumes the compact tombstone feed and
stores each thread's advertised `tombstoneEndSeq`. Opening a thread performs a
non-blocking forward deletion pull from its persisted thread-local committed
position. `DELETED_MESSAGE_UPDATED` SSE is only a wake-up signal for the same
pull; it does not introduce another cursor.

The browser and native clients persist tombstones in their ordinary message store. Applying a deletion page and advancing its HWM is one transaction. A later or concurrent message-page write cannot replace a tombstone. Mounted messages are removed; a deleted member of a merged media album rebuilds the row from the remaining members with viewport-anchor compensation. Message-scoped viewers and menus close when their target is deleted.

The transaction that first creates a local deletion fact also creates a local-only structured system
message. Withdrawals render as `You withdrew a message` or `<account> withdrew a message`. An upheld
moderation batch creates one `An administrator deleted <count> message(s)` event per affected thread.
These notices are presentation history, not deletion authority, and idempotent deletion retries do not
create duplicates. Because system messages are deliberately excluded from federation message feeds, a
receiving server creates its corresponding local notice when it first applies the authoritative tombstone.

## Federation flow

Federation v1 discovers withdrawals and effective moderation deletions through
`THREAD_CONTENT_HEAD.tombstoneEndSeq`, then reads them through
`GET /s2s/v1/message-tombstones`; see the normative
[Message Tombstone Query](../../spec/v1/message-tombstone-feed.md). The ordinary message query keeps
authored message bodies immutable and does not encode deletion through `updatedAt` or a special content type.

Both `USER_RETRACTION` and `MODERATION_REMOVAL` remove the target at the receiver. A report that only changes the reporter's
local visibility is not federated. P2P uses the author's home server; a group uses its origin as timeline
authority after validating a foreign author's withdrawal submission. Mirrors never republish either fact.
The stable target is `(thread, creator, originSeq)`, and tombstone authorization uses an exact durable
`(peer, message)` delivery proof, so leave/rejoin gaps do not expose targets a peer never received.

Message and tombstone targets share one compacted State Feed item but retain
independent thread-local sequence spaces and processed positions. A forward
round may fetch tombstones and messages concurrently. Message insertion and tombstone application serialize on the same stable identity,
so message-first and tombstone-first delivery both converge without resurrection.

## Migration

An existing installation backfills `deletionSeq` from the former global row ID
after proving every value fits the supported integer range. This intentionally
leaves cross-thread gaps and initially unique values; neither property changes
the thread-local meaning. Per-thread allocators are initialized to each
thread's maximum backfilled value before the old ID and its sequence are
removed. Existing published ends and durable consumer cursors therefore do not
move backward or change identity during the migration.
