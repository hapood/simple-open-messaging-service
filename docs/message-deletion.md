# Message deletion and federation

## Invariants

- A withdrawn message is a deleted message. `Message.isDeleted=true` is authoritative for reads; clients do not render a placeholder.
- An effective moderation report uses the same deletion log with type `REPORT`. A report that only changes the reporter's local visibility is not a federated deletion.
- Federation propagation depends on whether the remote node is entitled to replicate the conversation, not on whether the reason is `WITHDRAW` or `REPORT`.
- Only the message creator's home server may authorize a federated deletion. A group origin may relay an author's tombstone, but it does not acquire deletion authority.
- The stable federated target is `(thread, creator account, creator domain, originSeq)`. A receiver's local `Message.seq` is never sent or persisted in the federated tombstone.

## Local flow

`DeletedMessage` is an append-only per-server log. Each row contains its local `threadId`, local `seq`, deletion type, `createdAt`, and `updatedAt`. Message queries exclude `isDeleted=true` rows.

On the account's first thread-list initialization, the app stores the current global deletion HWM before consuming thread data. That value is only a baseline: when a thread is first opened it becomes that thread's HWM, and subsequent pulls advance the per-thread value. Entering a thread performs a non-blocking deletion pull. `DELETED_MESSAGE_UPDATED` SSE is only a wake-up signal for the same pull.

The browser and native clients persist tombstones in their ordinary message store. Applying a deletion page and advancing its HWM is one transaction. A later or concurrent message-page write cannot replace a tombstone. Mounted messages are removed; a deleted member of a merged media album rebuilds the row from the remaining members with viewport-anchor compensation. Message-scoped viewers and menus close when their target is deleted.

## Federation flow

Federation v1 does not define a message-deletion endpoint or deletion feed. The former standalone deletion
endpoint proposal is not part of the published surface and must not be exposed.
The message feed skips messages that were already deleted at its origin. Propagating a deletion after the
remote peer has received the original message is deliberately outside the v1 wire contract; local
`FederatedMessageTombstone` concurrency rules remain implementation detail and do not create an interoperable
S2S API.
