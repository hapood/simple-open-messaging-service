# Business mutation SQL pattern

Status: agreed implementation standard for subsequent business-mutation refactors.
The [group join acceptance experiment](./group-join-decision-experiment.md) is the
first reference implementation. Adopting this standard does not itself switch an
existing production handler or authorize unrelated business changes.

The [task responsibility and lock index](./durable-task-responsibilities-and-locks.md)
records each current task's responsibility, business scope, and execution reference.
Update that index when a task is added or its scope changes.

## New implementation boundary

New use cases live under `src/business-v2/`. API and durable-task handlers call
use-case entries there after the specific flow has been reviewed for routing.
Keep domain SQL beside its use case and established reusable fragments under
`shared/sql`; new lock primitives belong under `shared/locks`.

Only the implemented join-decision experiment and its direct shared dependencies
have moved so far. Do not scaffold or migrate invitations, friendship requests,
or other business flows as part of this move. Existing production handlers and
domain implementations remain unchanged.

## Transaction ownership and locks

One outer entry owns the write transaction, business locks, authorization,
business updates, and durable task admission. Internal SQL fragments and update
helpers consume that transaction and its validated context; they do not open
transactions or reacquire the same business/relationship lock set.

Use two independent business-lock names and responsibilities:

| Name | Protected business state |
| --- | --- |
| Account Meta Lock | One account's own metadata, whether the account represents a user or a group. |
| Relationship Pair Lock | The relationship between two canonical endpoints, including both authored Intents. |

Both are exclusive transaction-scoped advisory locks, acquired with
`pg_advisory_xact_lock(hashtextextended(key, 0))`. An Account Meta Lock is not a
row lock on the `Account` table. A Relationship Pair Lock is not the row lock on
`RelationshipPair`. These are independent responsibilities, not parent and child
business scopes. A relationship-only mutation does not require an Account Meta
Lock merely because an endpoint is a group or because a user initiated it.
Any Intent modification requires its Relationship Pair Lock. A mutation that
also changes account metadata requires the applicable Account Meta Locks.

The transaction owner declares its complete business scope set and acquires
Account Meta Locks before Relationship Pair Locks, then necessary row/allocator
locks. Deduplicate and sort keys within each scope class. This acquisition order
does not imply a semantic hierarchy. Internal helpers consume the validated
context and do not add business scopes after writes begin.

Retain the existing `['business-scope', 'ACCOUNT', domain, account]` key encoding
for account metadata; do not rename the wire-independent lock key to `META`.
Changing the key would stop old and new writers from excluding one another.
Legacy ACCOUNT locks currently protect broader aggregate operations, including
group roster changes. The join-decision experiment also retains that broader
group lock. Their current behavior is not an implementation of metadata-only
scope selection. Before narrowing a flow's lock set, explicitly preserve
cross-Pair invariants, shared roster/authorization state, and compatibility with
legacy writers that do not acquire the new Pair advisory lock. This naming
standard does not remove those existing protections.

Use canonical stored endpoint identities and relationship namespaces for the Pair
key, with endpoints sorted so both authored directions share a key. Do not use a
request ID, Intent author side, or caller-relative address order as its identity.
The [task index](./durable-task-responsibilities-and-locks.md) distinguishes current
production scopes from the fork's new scope requirements.
Keep the row and allocator locks required for shared records, foreign-key
concurrency, and triggers. Central ownership removes redundant locking, not
necessary protection. Ordinary reads do not acquire business locks implicitly.

Independent business scopes do not guarantee freedom from deadlocks. Acquire
all required `PeerStateFeedTarget` allocators in peer-domain/namespace order
before any `Account` state-feed allocator, including allocations or locks taken
by triggers. Acquire Account allocators in account-ID order. Lock preparation
must not issue redundant business updates that trigger early feed allocation.
SQL writes and foreign-key checks still acquire implicit locks; include them
when reviewing the complete transaction order.

Authorization must use a fresh statement snapshot after waiting for business
locks. A SELECT before a lock may locate identity, but cannot authorize the
mutation. Do not combine a waiting advisory-lock call and authorization reads
into one ordinary SQL statement and assume its snapshot refreshes after waiting.

## Four business phases

| Phase | Responsibility |
| --- | --- |
| 1. Authorize and select | One SQL validates the actor, target, request/intent validity, current business state, and update feasibility. Return the local/federated branch and its required identities. |
| 2. Apply | One composed SQL performs the branch's canonical writes and immediate projections. Return the business result and directly affected peer, if any. |
| 3. Admit | One SQL determines whether new fanout work is required and replaces eligible PENDING work under the existing task contract. |
| 4. Insert | Insert one task row when required; skip when unnecessary. Do not create a task for every recipient. |

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
- Admit `FAN_OUT_GROUP_META_HEAD` with `{ threadId }`. The existing executor
  reads the latest canonical Meta head and allocates each audience's state feed
  position for its `GROUP_META_FEED_HEAD` entry.
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

Apply this pattern one business flow at a time. Isolated experimental methods
and temporary forks are allowed while establishing equivalence. Keep production
routing on the existing path until the specific replacement is reviewed.

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
