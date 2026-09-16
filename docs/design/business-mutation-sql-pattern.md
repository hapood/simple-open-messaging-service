# Business mutation SQL pattern

Status: agreed implementation standard for business-mutation code.
The [group membership intent implementation](./group-membership-intent.md) is
the first reference implementation.

The [task responsibility and lock index](./durable-task-responsibilities-and-locks.md)
records each current task's responsibility, business scope, and execution reference.
Update that index when a task is added or its scope changes.

## New implementation boundary

New use cases live under the owning domain's `src/<domain>/business/`
directory. API and durable-task handlers call use-case entries there after the
specific flow has been reviewed for routing. Keep domain SQL beside its use
case. Put established cross-domain SQL fragments under
`src/common/business/sql/` and cross-domain lock primitives under
`src/common/business/locks/`; domain-specific primitives stay with their
owning domain.

Migrate one complete business entry at a time. Once an entry uses this standard,
remove its old writer instead of retaining a compatibility path or dual write.

## Command results and failures

A business command returns a discriminated result. `APPLIED` means it committed
the requested transition; `NO_OP` means the requested end state was already
satisfied; `REJECTED` carries a stable reason, business code, and safe message
for an expected refusal such as a missing or expired intent, a dissolved group,
capacity, or authorization. These outcomes do not use exceptions as control
flow.

HTTP handlers serialize `REJECTED` as the existing HTTP-200 business envelope.
Durable-task handlers return `REJECTED` to the scheduler, which persists the
task with that terminal status and `resultCode`. They do not throw merely to
reach the rejected terminal state.

Throw only when continuing the operation or advancing an input stream would be
unsafe: malformed or unauthorized wire input, a lost lock capability, a row
that disappeared despite its protecting lock, conflicting immutable content,
database/transport failure, or another violated implementation invariant. A
durable task records these unexpected exceptions as `FAILED`; a federation
consumer applies its documented permanent-item or retry policy.

## Transaction ownership and locks

One outer entry owns the write transaction, business locks, authorization,
business updates, and durable task admission. Internal SQL fragments and update
helpers consume that transaction and its validated context; they do not open
transactions or reacquire the same business/relationship lock set.

Use exactly three explicit business-lock names and responsibilities:

| Name                   | Protected business state                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Account State Lock     | Mutable business state owned by one acting user or group account. It never grants authority to change another account's owned state.        |
| Relationship Pair Lock | The relationship between two canonical endpoints, including both authored Intents and relationship-derived projections for either endpoint. |
| Thread Content Lock    | Message and deletion sequences, thread content state, and content-derived projections for one thread.                                       |

Account State and Relationship Pair locks are exclusive transaction-scoped
advisory locks acquired with
`pg_advisory_xact_lock(hashtextextended(key, 0))`. A Thread Content Lock is the
canonical `MessageThread FOR NO KEY UPDATE` lock represented by a transaction-bound
capability. These locks describe independent ownership domains rather than a
parent-child hierarchy.

An account command changes only the acting account's owned state. A Pair command
may change either endpoint's Intent and relationship-derived projection without
thereby acquiring authority over the endpoint's account-owned state. Sending or
changing content requires the Thread Content Lock. A command that crosses more
than one ownership domain acquires every applicable lock.

The transaction owner declares its complete business scope set before mutation
and acquires locks in this global order:

```text
Account State Locks (canonical account-address order)
Relationship Pair Locks (canonical pair-key order)
Thread Content Locks (thread-id order)
implicit row and allocator locks (their documented canonical order)
```

Deduplicate keys within each class. Internal helpers consume transaction-bound
lock capabilities and never acquire an earlier lock class after a later class or
after writes begin.

The Account State Lock retains the key encoding
`['business-scope', 'ACCOUNT', domain, account]`. The word `ACCOUNT` identifies
the owned account state domain; it does not mean that every relationship
containing that address belongs to the account lock.

Use canonical stored endpoint identities and relationship namespaces for the Pair
key, with endpoints sorted so both authored directions share a key. Do not use a
request ID, Intent author side, or caller-relative address order as its identity.
The [task index](./durable-task-responsibilities-and-locks.md) distinguishes current
production scopes from the implementation's new scope requirements.
Keep the row and allocator locks required for shared records, foreign-key
concurrency, and triggers. Central ownership removes redundant locking, not
necessary protection. Ordinary reads do not acquire business locks implicitly.

The three explicit lock classes close the business ownership model. Deadlock
freedom additionally requires every implicit database lock either to be dominated
by one common explicit lock or to follow one canonical row order. Acquire
federation namespace allocators in namespace-ID order and account-owned allocators
in account-ID order. Lock preparation must not issue redundant writes that trigger
early allocation. SQL writes, triggers, task rows, and foreign-key checks still
acquire implicit locks and remain part of the transaction-order review; they do
not constitute additional explicit business-lock classes.

Use distinct feed coordinates:

- `Account.clientStateFeedEndId` is the unified local-client state-feed end for
  that account. Account-, Pair-, and Thread-derived projections may advance it
  under their respective explicit locks, so it is an implicit shared allocator
  acquired in account-ID order rather than a reason to acquire another account's
  Account State Lock.
- `IdentityNamespace.stateFeedEndId` is the unified outbound State Feed end for
  one verified federation identity epoch. Pair and Thread projections may
  advance it under their respective explicit locks, so multi-namespace writers
  acquire namespace rows in namespace-ID order. It starts at zero. Namespace
  `0` (`local`) remains zero and is never used as an outbound peer allocator.
- `PeerStateFeedPullCursor.committedThrough` is inbound consumption progress and
  is not an authored feed end.

The separate `PeerStateFeedTarget` allocator is redundant in the target schema:
its state belongs on the corresponding remote `IdentityNamespace`. Empty-database
migration may remove the old table and writers directly; no backfill, dual write,
or compatibility adapter is required.

An `IdentityNamespace` allocator row is a terminal implicit resource. After a
transaction locks or updates one, it must not acquire an Account State,
Relationship Pair, or Thread Content lock. Namespace lifecycle operations obey
the same order. Federation reset only retires the namespace and updates peer
lifecycle state; it does not acquire a Thread Content lock or author messages
after locking the namespace row.

Authorization must use a fresh statement snapshot after waiting for business
locks. A SELECT before a lock may locate identity, but cannot authorize the
mutation. Do not combine a waiting advisory-lock call and authorization reads
into one ordinary SQL statement and assume its snapshot refreshes after waiting.

## Four business phases

| Phase                   | Responsibility                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Authorize and select | One SQL validates the actor, target, request/intent validity, current business state, and update feasibility. Return the local/federated branch and its required identities. |
| 2. Apply                | One composed SQL performs the branch's canonical writes and immediate projections. Return the business result and directly affected peer, if any.                            |
| 3. Admit                | One SQL determines whether new fanout work is required and replaces eligible PENDING work under the existing task contract.                                                  |
| 4. Insert               | Insert one task row when required; skip when unnecessary. Do not create a task for every recipient.                                                                          |

Complete required allocator preparation before writes or triggers allocate feed
positions. Transaction control and necessary identity/lock preparation are
additional statements. Four phases are the target structure, not permission to
remove correctness checks or claim four total round trips.

The single-task model applies to the established fanout responsibility of the
business flow. Preserve its semantics when applying the pattern elsewhere;
do not force unrelated tasks into an invented combined executor merely to fit
the statement count.

## SQL composition

Use parameterized Drizzle `sql` templates. Drizzle still owns the connection and
transaction; this pattern does not require stored procedures or abandoning its
query APIs for ordinary queries.

Reuse fragments with explicit inputs, output columns, and CTE dependencies.
Compose distinct local and federated branches where their effects differ.
Short branch-specific code may remain duplicated. Avoid a generic orchestration
framework or sharing code that obscures different authorization semantics.

CTE text order is not write execution order. Use `RETURNING` dependencies and
account for triggers. Do not modify the same row in sibling CTEs. Preserve
idempotency, revision rules, audience boundaries, and existing configuration
behavior. Decode raw SQL timestamps and bigint values explicitly where needed.

## Fanout boundary and pending replacement

The mutation prepares canonical state and admits the existing fanout task.
Keep that task's type, scope, payload, and initial checkpoint contract. Replace
eligible PENDING tasks atomically; do not merge recipient lists or progress.
Leave PROCESSING tasks intact and insert a successor when new work requires it.
A concurrent claim must not cause that successor to be lost.

Recipient enumeration, per-recipient projection/allocation, pagination, and task
execution belong to the existing fanout implementation. Do not move that work
into the mutation or redesign the executor as part of this refactor.

For group join acceptance specifically:

- The business SQL writes Group Meta once and authors the group's ACK in the
  relationship intent. It also writes the directed ACK into the applicant
  peer's state feed. It does not author the applicant's intent.
- Admit the local and federation thread fan-out tasks with the complete current
  message and tombstone coordinates. Their executors attach the latest
  canonical Meta coordinate to the thread head.
- The directed ACK and the group-wide Meta projection have different targets.
  The approval's immediate peer target is only the applicant's peer. Local
  acceptance has no peer target.

## Post-commit notification

Return directly affected notification targets from the transaction result.
After successful commit, pass them to the existing throttled peer HTTP
notification path. No additional recipient scan or task is needed merely to
wake the peer for an already-written ACK. Do not send HTTP inside the transaction.

Rollback must produce no external notification. Notification failures after
commit are handled by the existing notification mechanism; they cannot undo the
committed business mutation. Do not recreate scheduling or throttling inside the
business handler.

## Adoption and verification

Apply this pattern one complete business flow at a time. Review the replacement,
switch its production entry, and remove the old writer. Do not retain a dual-write
or compatibility adapter; the migration assumes an empty database.

Verify canonical state and immediate feed effects, invalid/stale requests,
branch-specific configuration behavior, idempotency, and transaction rollback.
Use PostgreSQL tests for lock waits, competing mutations, task claim races, and
pending replacement. Verify post-commit notification targets and ordering.
Existing fanout execution remains covered by its own tests.

Report application-issued SQL counts including BEGIN/COMMIT and lock preparation.
Distinguish statement count, database execution time, and transaction wall time.
A small-fixture reduction is evidence for this implementation pattern, not a
production latency guarantee. Carry forward the structure and invariants;
revalidate each business flow's semantics before switching its handler.
