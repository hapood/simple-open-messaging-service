# Durable task responsibilities and business locks

Status: current implementation inventory, checked on 2026-09-11 against
[DurableTaskType](../../src/durable-task/durable-task.constants.ts) and its execution
paths. This is a lookup index, not a claim that every existing task has already
adopted the [business mutation SQL pattern](./business-mutation-sql-pattern.md).

## How to read the lock column

The target terminology has exactly three explicit business-lock classes:
**Account State Lock**, **Relationship Pair Lock**, and **Thread Content Lock**.
The first two are transaction-scoped advisory locks; Thread Content is the
canonical `MessageThread FOR NO KEY UPDATE` lock represented by a
transaction-bound capability. The tables below inventory current paths.

| Scope             | Actual business lock                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Account state     | One transaction advisory lock for each account whose owned mutable state changes, deduplicated and sorted by canonical key. Referencing an account as a Pair endpoint does not by itself require its Account State Lock. |
| Relationship pair | One transaction advisory lock for the canonical unordered endpoint pair. It protects both authored Intents and relationship-derived state for either endpoint.                                                           |
| Thread content    | One canonical `MessageThread FOR NO KEY UPDATE` lock for message, deletion, and content-projection changes.                                                                                                              |
| None at execution | The task uses the row/allocator locks described in its row, without an ACCOUNT advisory business scope. Admission may have a different lock path.                                                                        |

The ACCOUNT scope is encoded as:

```text
["business-scope", "ACCOUNT", domain.toLowerCase(), account]
```

[lockBusinessAccountsInTx](../../src/common/locks/account-business-lock.ts) applies
`pg_advisory_xact_lock(hashtextextended(key, 0))`. The lock lasts until the owning
transaction commits or rolls back. Paginated and asynchronous tasks reacquire
required locks for each database transaction; no lock is held across HTTP work.

A `DurableTask.scopeType`, `scopeKey`, or coalescing key controls scheduling and
admission. It is not, by itself, evidence of a PostgreSQL business lock.
`RelationshipPair`, `AccountThreadState`, task rows, and feed allocators have
additional implicit row locks. Those are not separate business-lock classes.
Read-only/no-op paths may return before acquiring the mutation locks below.

The global explicit order is Account State, Relationship Pair, then Thread
Content. Implicit conflicts must either be dominated by a shared explicit lock
or use a canonical row order. The target feed allocators are
`Account.clientStateFeedEndId` for local clients and
`IdentityNamespace.stateFeedEndId` for outbound federation. They are implicit
shared rows ordered respectively by account ID and namespace ID; advancing one
does not require an unrelated explicit lock class. Namespace `0/local` keeps
zero; inbound progress uses `PeerStateFeedPullCursor.committedThrough`.

## User relationship commands

The authored P2P commands (send/accept/reject/revoke local and addressed),
including query-authorization denial cleanup, run inline through the user
intent family (`UserIntentService` / `ReceivedUserIntentService`) inside one
transaction. They therefore do not appear in the durable task inventory.

## Group commands

| Task                        | Responsibility                                                                                                                                                                                    | Business scope during mutation                    | Execution reference                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISBAND_GROUP`             | Mark the group dissolved, then admit member-revocation children with a durable pair cursor.                                                                                                       | Group account in each transaction                 | [Handler](../../src/group/disband-group-task.handler.ts), [child admission](../../src/group/group-revoke-fanout.service.ts)                              |
| `REVOKE_FORBIDDEN_GROUP`    | Optionally enumerate peer-hosted members of a locally authoritative group after an authenticated query denial and admit revocation children; it never applies to a remotely authoritative mirror. | Group account in each child-admission transaction | [Handler](../../src/group/revoke-forbidden-group-task.handler.ts), [child admission](../../src/group/group-revoke-fanout.service.ts)                     |
| `FORCE_REVOKE_GROUP_MEMBER` | Revoke one member after authoritative dissolution or optional locally authoritative denial cleanup, respecting the applicable captured authorization epoch.                                       | Group account                                     | [Handler](../../src/group/force-revoke-group-member-task.handler.ts), [denial execution](../../src/federation/federation-thread-query-denial.service.ts) |

## Federation application and projections

| Task                                | Responsibility                                                                                                                                                                                                                                                                                                                           | Business scope during execution                   | Execution reference                                                                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FAN_OUT_THREAD_CONTENT`            | Project committed message/deletion changes into active local recipients' thread feeds and read/unread/preview state, then issue SSE/push hints. Each account-thread projection and its checkpoint commit in one short transaction; after the parent/thread locks it locks only that account's feed allocator before its participant row. | Thread parents for each account-thread projection | [Handler](../../src/message/thread-fanout-task.handler.ts), [progress service](../../src/message/thread-fanout-progress.service.ts)                                                                    |
| `FAN_OUT_ACCOUNT_THREAD_CONTENT`    | Project a thread-content change for one specified local account, including retained relationship and visibility checks. It uses the same single-account allocator-before-participant order and atomically completes its checkpoint.                                                                                                      | Thread parents for the account-thread projection  | [Handler](../../src/message/thread-fanout-task.handler.ts), [progress service](../../src/message/thread-fanout-progress.service.ts)                                                                    |
| `FAN_OUT_FEDERATION_THREAD_CONTENT` | Project committed content heads toward federation audiences and schedule peer state-feed notifications.                                                                                                                                                                                                                                  | Thread parents for each projection step           | [Handler](../../src/federation/federation-thread-fanout-task.handler.ts)                                                                                                                               |
| `FAN_OUT_GROUP_PROJECTION`          | Project the current join-request and invitation heads to local managers. Each manager projection and checkpoint commit in one short transaction; after the thread lock it locks that manager's Account feed allocator before participant and client-feed writes.                                                                         | Group thread for each manager projection          | [Handler](../../src/group/membership-intent/shared/group-membership-projection-fanout.handler.ts), [execution](../../src/group/membership-intent/shared/group-membership-projection-fanout.service.ts) |

## Membership-intent implementation

The implementation under `src/group/membership-intent/` acquires both:

1. The existing group account scope:
   `["business-scope", "ACCOUNT", "local", groupAccount]`.
2. The new Pair scope:
   `["business-scope", "PAIR", kind, endpoint1, endpoint2]`, where each endpoint
   is a complete lowercase address (`account@domain`, e.g. `alice@local`) and
   the two addresses are sorted. Callers compose these final-form addresses from
   identities already in hand; the primitive performs no normalization,
   validation, or canonicalization lookup.

[The Pair primitive](../../src/common/locks/relationship-pair-business-lock.ts)
is part of the business module. Account scopes are acquired before Pair scopes,
once per transaction, followed by Thread Content and implicit row/allocator
locks. Both local and federated applicants acquire their own member Pair lock.
The pending request already has a Pair row, so this path locks it directly.

The tables above describe current production paths. New Intent writers require
a Relationship Pair Lock; account-owned state writes require an Account State
Lock; content writes require a Thread Content Lock. Acquire them in that order.
There are no dual-write or alternate lock paths.

The mirror membership applier follows the same order from the receiving side:
the group ACCOUNT scope is taken at the
**authority domain** (`["business-scope", "ACCOUNT", groupDomain, groupAccount]`)
before the Pair scope, then the thread content lock, the pair row, the intent
rows, the member's `AccountThreadState` row, the peer outbound state-feed
allocator (`lockOutboundStateFeedNamespacesInTx`), and finally the client-feed
allocator. Canonical mirror pairs fold both endpoint namespaces to the peer
group's federation namespace, matching the key every group-relationship
mutation locks.

After commit, the directed ACK wakes only the applicant peer through the existing
throttled notification path. Group Meta progress is projected by the existing
local and federation thread fan-out tasks using the thread's complete current head.

## Maintenance rule

When adding a task or changing its responsibility/locking path, update its row
here in the same change. Keep branch-specific scopes explicit. Do not infer locks
from task names, queue lanes, or a helper's `InTx` suffix. Link the execution path
that actually acquires the lock, including transitive domain helpers.

This inventory records current durable behavior. Synchronous HTTP business
commands, including read-position commits, do not belong in this task table.
