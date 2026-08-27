# Message deletion and federation

## Invariants

- A withdrawn message is a deleted message. `Message.isDeleted=true` is authoritative for reads; clients do not render the deleted message as a placeholder. A separate structured system event records the visible timeline notice.
- An effective moderation action uses the same deletion log with type `MODERATION_REMOVAL`. A report that only changes the reporter's local visibility is not a federated deletion.
- Federation propagation depends on whether the remote node is entitled to replicate the conversation, not on whether the reason is `USER_RETRACTION` or `MODERATION_REMOVAL`.
- P2P withdrawal authority is the creator's home server. A group origin is the authority for its accepted group timeline: a foreign author submits a withdrawal, and the origin validates and directly publishes the resulting group deletion.
- The stable federated target is `(thread, creator account, creator domain, originSeq)`. A receiver's local `Message.seq` is never sent or persisted in the federated tombstone.

## Local flow

`DeletedMessage` is an append-only per-server log. Each row contains its local `threadId`, local `seq`, deletion type, `createdAt`, and `updatedAt`. Message queries exclude `isDeleted=true` rows.

On the account's first thread-list initialization, the app stores the current global deletion HWM before consuming thread data. That value is only a baseline: when a thread is first opened it becomes that thread's HWM, and subsequent pulls advance the per-thread value. Entering a thread performs a non-blocking deletion pull. `DELETED_MESSAGE_UPDATED` SSE is only a wake-up signal for the same pull.

The browser and native clients persist tombstones in their ordinary message store. Applying a deletion page and advancing its HWM is one transaction. A later or concurrent message-page write cannot replace a tombstone. Mounted messages are removed; a deleted member of a merged media album rebuilds the row from the remaining members with viewport-anchor compensation. Message-scoped viewers and menus close when their target is deleted.

The transaction that first creates a local deletion fact also creates a local-only structured system
message. Withdrawals render as `You withdrew a message` or `<account> withdrew a message`. An upheld
moderation batch creates one `An administrator deleted <count> message(s)` event per affected thread.
These notices are presentation history, not deletion authority, and idempotent deletion retries do not
create duplicates. Because system messages are deliberately excluded from federation message feeds, a
receiving server creates its corresponding local notice when it first applies the authoritative tombstone.

## Federation flow

Federation v1 propagates withdrawals and effective moderation deletions through the durable
`GET /s2s/v1/message-tombstone-feed`; see the normative
[Message Tombstone Feed](../../spec/v1/message-tombstone-feed.md). The ordinary message feed keeps
authored message bodies immutable and does not encode deletion through `updatedAt` or a special content type.

Both `USER_RETRACTION` and `MODERATION_REMOVAL` remove the target at the receiver. A report that only changes the reporter's
local visibility is not federated. P2P uses the author's home server; a group uses its origin as timeline
authority after validating a foreign author's withdrawal submission. Mirrors never republish either fact.
The stable target is `(thread, creator, originSeq)`, and tombstone authorization uses an exact durable
`(peer, message)` delivery proof, so leave/rejoin gaps do not expose targets a peer never received.

The message and tombstone feeds use independent per-peer feed-ID spaces, allocators, ACKs, retention floors
and pull cursors. Recovery drains state, then
tombstones, then messages. Message insertion and tombstone application serialize on the same stable identity,
so message-first and tombstone-first delivery both converge without resurrection.
