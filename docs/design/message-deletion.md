# Message deletion and federation

## Invariants

- A withdrawn message is a deleted message. `Message.isDeleted=true` is authoritative for reads; clients do not render the deleted message as a placeholder. A separate structured system event records the visible timeline notice.
- An effective moderation action uses the same deletion log with type `MODERATION_REMOVAL`. A report that only changes the reporter's local visibility is not a federated deletion.
- Federation propagation depends on whether the remote node is entitled to replicate the conversation, not on whether the reason is `USER_RETRACTION` or `MODERATION_REMOVAL`.
- P2P deletion publication belongs to the creator's home server; local moderation of a remote-authored P2P copy is not federated. A group origin is the authority for its accepted group timeline: a foreign author submits a withdrawal, and the origin validates and directly publishes the resulting group deletion. A mirror publishes only its own authors' group deletions; moderation of another home's member is local-only. An origin may moderate the mirror's local author, but cannot retract that author's home message.
- The wire target is `(publisher domain, thread, publisher messageSeq)`. A receiver maps that sequence to the peer-coordinate replica or a durable processing receipt for its own authored message; matching an unrelated local `seq` is forbidden.

## Local flow

Deletion, send, and content-round entry points use the same parent-first lock
order: group business scope and Group row for a group, or sorted endpoint account
business scopes and RelationshipPair for P2P, then MessageThread. An unbound P2P
shell has no relationship parent; locking does not itself grant authorization.
They lock `MessageThread` before locking or updating a `Message`.
Federated identity advisory locks are acquired after the thread lock
as well. Withdrawal locks only the target message, not the joined author row.
This order also covers implicit foreign-key locks: inserting a federation
receipt can lock its referenced message while already holding the thread lock.
Acquiring the thread lock only during deletion-sequence allocation is too late.

Nested content operations pass a `ThreadContentLock` capability acquired by the
transaction entry point. Reuse validates both transaction identity and thread ID
without issuing additional lock queries. Independent entry points acquire their
own capability. This is an in-process parameter, not stored data or a wire field.
The capability must not escape its transaction or survive rollback of the
savepoint under which it was acquired. Message pages acquire it before their
per-item savepoints; no transaction-global lock cache is maintained.

`DeletedMessage` is an append-only per-thread log. Each row contains
`threadId`, thread-local `deletionSeq`, target `messageSeq`, deletion type,
`createdAt`, and `updatedAt`. Its primary key is `(threadId, deletionSeq)`, and
`(threadId, messageSeq)` is unique because a message reaches only one terminal
deletion fact. `MessageThread.tombstoneEndSeq` allocates the next
deletion sequence atomically and starts at `0` before the first deletion. There
is no global `DeletedMessage.id`; database identity, local queries, client
hints, and federation publication all use the explicit thread coordinate.

No new table is required. `MessageThread` owns the allocator and
`DeletedMessage` owns the facts. The former global tombstone-source
`sourceScannedThrough` tied to `DeletedMessage.id` is removed with that ID;
projection maintenance compares or publishes each thread's explicit deletion
end instead.

The device-facing projection has one feed: `ClientStateFeed`. Each compacted
`THREAD_CONTENT_HEAD` publishes a thread's required `messageEndSeq` and
`tombstoneEndSeq` together. It contains neither presentation data nor a profile
selection hint. Message catch-up derives previews, while a mounted chat resolves
the exact author profile from each message's immutable profile reference. The
thread-level deletion query uses `DeletedMessage.deletionSeq` directly. A federation pending fact is deduplicated by
`(sourceDomain, thread, remoteDeletionSeq)`, because a source may reuse the same
thread-local deletion sequence in different threads.

The app consumes `THREAD_CONTENT_HEAD` while draining the ordinary state feed
and stores both ends atomically with its sole state-feed cursor. It does not
request tombstone bodies for a closed chatbox. On the first open, the client
reads that thread's newest locally persisted message and freezes both that
message sequence and the then-current `tombstoneEndSeq`. Every page of the
initial tombstone loop sends the frozen values as `maxMessageSeq` and `through`
until the frozen deletion end is reached. Later rounds omit `maxMessageSeq` and
use the newly published tombstone end as `through`. Message-body and
tombstone-body request loops remain independent. The ordinary
`STATE_FEED_UPDATED` wake covers tombstone-head changes; there is no separate
deletion SSE event.

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

Both `USER_RETRACTION` and `MODERATION_REMOVAL` remove an authorized target at the receiver; the exception is an origin's `USER_RETRACTION` of a mirror-local author, which is ignored. The first applied deletion fact is terminal: later facts, even with a different type, do not replace it. A report that only changes the reporter's
local visibility is not federated. P2P uses the author's home server; a group uses its origin as timeline
authority after validating a foreign author's withdrawal submission. Mirrors never republish either fact.
The target uses the publisher's message coordinate and its author binding; tombstone authorization uses an exact durable
`(peer, message)` delivery proof, so leave/rejoin gaps do not expose targets a peer never received.

Message and tombstone targets share one compacted State Feed item but retain
independent thread-local sequence spaces and processed positions. Initial mirror
creation adopts the first deletion target without querying it because no older
message replica exists locally. After relationship reauthorization, one durable
recovery drain returns tombstones at or below the pre-loss committed message
coordinate and fast-forwards later targets in the same deletion interval. Every
subsequent deletion drain is unfiltered and ordered only by deletion sequence.
Message insertion and tombstone application serialize on the same stable
identity, so message-first and tombstone-first delivery both converge without
resurrection.

## Migration

An existing installation backfills `deletionSeq` from the former global row ID
after proving every value fits the supported integer range. This intentionally
leaves cross-thread gaps and initially unique values; neither property changes
the thread-local meaning. Per-thread allocators are initialized to each
thread's maximum backfilled value before the old ID and its sequence are
removed. Existing published ends and durable consumer cursors therefore do not
move backward or change identity during the migration.
