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

The signed endpoint is:

```text
GET /api/v1/s2s/message-deletions
```

It uses the same three address shapes as the message endpoint:

- P2P author stream: `fromAccount`, `toAccount`, `toDomain`, `afterId`, `take`.
- Group mirror stream from the group origin: `toAccount=!group`, `toDomain`, `afterId`, `take`.
- Group-origin per-author stream: the group parameters plus `fromAccount` and `fromDomain`.

Responses contain ascending deletion IDs, stable creator/origin coordinates, deletion type, and deletion time. Pagination continues until a short or empty page; there is no snapshot maximum.

`FederationDeletedCursor` stores one HWM per ordered remote stream. A group mirror has one group-origin stream; a group origin has one stream per remote author server/account. Cursor advancement is committed in the same transaction as `FederatedMessageTombstone` and any matching local message update.

Federated message insertion and tombstone insertion take the same PostgreSQL transaction-scoped advisory lock derived from `(threadId, creatorId, originSeq)`. Therefore either ordering converges:

1. Message first: the tombstone transaction marks it deleted and writes a local `DeletedMessage` row.
2. Tombstone first: the later message insert sees it, inserts the message as deleted, and writes the local deletion row.

Existing federation message hints are reused as lossy wake-up signals. Every triggered P2P/group pull fetches deletions before messages, and opening a conversation is the durable recovery path after lost pushes or process restarts.
