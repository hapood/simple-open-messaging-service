# Database Concurrency and Locking

## Design principle

Reads use MVCC snapshots; writes serialize only where correctness requires it.
Preserve concurrency between non-key updates and foreign-key checks. Use
`FOR NO KEY UPDATE` for read-modify-write operations on non-key fields, and avoid
`FOR UPDATE` unless the transaction requires its stronger protection.

Ordinary `SELECT` statements do not acquire row locks and are not blocked by
these row-lock modes. Foreign-key checks are different: they acquire `KEY SHARE`
on the referenced row. `FOR UPDATE` conflicts with that lock; `FOR NO KEY UPDATE`
does not. Neither choice promises freedom from schema-level locks such as DDL.

## Selecting a lock mode

| Operation | Default approach |
| --- | --- |
| Ordinary query | Plain MVCC `SELECT`, without a locking clause |
| Authorization and a multi-statement page read | One `REPEATABLE READ, READ ONLY` transaction |
| Atomic counter or conditional state change | An `UPDATE` with the required predicate; no separate read lock unless needed |
| Read-modify-write of non-key fields | `FOR NO KEY UPDATE`, held until the transaction ends |
| Foreign-key validation | Let PostgreSQL acquire its normal `KEY SHARE` lock |
| Physical deletion or changing a referenced key | Retain the required stronger lock; acquire it initially when a preparatory locking read is necessary |

`FOR SHARE` is not the default for a transaction that will write. It blocks
other writers and must be upgraded before writing, which can create a deadlock
between transactions that already hold compatible shared locks. Use it only
when a commit-time invariant specifically requires a locking read, and explain
that invariant in the source.

A `FOR UPDATE` exception must have a concrete deletion or key-protection reason.
Do not use it merely because code runs in a transaction or because a row is
about to receive a non-key update. Logical deletion flags, status changes,
checkpoints, profile revisions, feed counters, and authorization epochs are
non-key updates.

## No lock upgrades in ordinary write paths

Choose the required lock mode before modifying the row. Keep that mode consistent
across services, helpers, foreign-key effects, and triggers. Do not update a
non-key field and subsequently request `FOR UPDATE` on the same row.

For example, participant insertion updates `Account.threadFeedEndId` in a BEFORE
trigger. Its AFTER trigger publishes the account's conversation snapshot using
`FOR NO KEY UPDATE`. Requesting `FOR UPDATE` there would upgrade the lock while
retaining the earlier write lock: a concurrent foreign-key holder could block
that upgrade while waiting to update the same account, forming a cycle.

Likewise, canonical relationship-pair acquisition must not upgrade the lock
obtained by updating `RelationshipPair.threadId`. Repeated acquisition uses the
same non-key write-lock mode.

Preserve the established business-scope and parent/child acquisition order.
A compatible lock mode does not fix a cycle caused by inconsistent resource
ordering. When changing an application lock, review every trigger that can
reacquire the affected row's lock in the same transaction.

## Queries and authorization epochs

Federation message, tombstone, group-meta, and group-profile queries read
authorization and data from the same read-only snapshot. They do not hold intent
rows against concurrent revocation or deletion. An in-flight page may complete
from its earlier committed snapshot; a new page sees the committed change.

Receiving round writers atomically validate their captured `authorizationEpoch`
before committing facts and progress. A stale epoch rejects the write instead
of requiring a query to hold authorization locks across the operation. This
check is a conditional write, not a separate unlocked read followed by a write.

Epoch validation does not replace every commit-time authorization check.
Authority-side removal of one group audience does not increment the thread
epoch. A round therefore still validates that audience under the common
business/content locks before committing. These checks protect writes; they
are not row locks imposed on read-only query endpoints.

Physical deletion retains PostgreSQL's required row locks while ordinary MVCC
queries continue reading their snapshots. Do not weaken deletion protection to
make queries concurrent: ordinary reads already have that concurrency.

## Implementation and verification

- [Thread content locks](../../src/relationship/thread-content-lock.ts)
- [Relationship-pair writes](../../src/relationship/relationship-intent.service.ts)
- [Trigger lock modes](../../database/migrations/0001_non_key_write_locks.sql)
- [Snapshot authorization](../../src/federation/federation-thread-query-authorization.ts)
- [Atomic epoch validation](../../src/federation/federation-thread-sync-state.service.ts)
- [Federation rounds and history gaps](./federation-atomic-rounds-and-history-gaps.md)

Validate lock changes with real PostgreSQL transactions. Unit-test SQL mocks
cannot establish lock compatibility. Regression coverage includes publication
while a foreign-key transaction remains open, repeated pair acquisition beside
a KEY SHARE holder, reads during revocation and deletion, and rejection of stale
epochs at commit:

- [Account publication and snapshot reads](../../test/thread-state.e2e-spec.ts)
- [Pair locks and parent ordering](../../test/federation-thread-parent-lock.e2e-spec.ts)
- [Epoch invalidation](../../test/federation-thread-sync-state.e2e-spec.ts)
