# Durable Task Scheduling

Status: Durable Task naming, persistence, mutation schedulers,
checkpointed group-dissolution fan-out, scheduler-driven mirror Group Meta
rounds, Group Meta publication through thread fan-out, authoritative membership-fact folding, and
final audience/task admission for membership mutations are implemented. Group
profile mutation integration and pending group-member intent slots are also
implemented. Friend-intent supersession remains separate work.

This document describes application implementation. It does not define or
change federation wire behavior; the normative federation contract remains
under [`spec/v1`](../../spec/v1/).

The shared classification and cooperative-yield rules for compacted,
ephemeral, and exhaustive fan-out are defined in
[`fan-out-execution.md`](./fan-out-execution.md).

## 1. Terminology and boundary

`DurableTask` is the shared persistence and execution mechanism. It supports
two task kinds:

- `MUTATION` changes authoritative relationship or group state.
- `PROJECTION` derives State Feed or another read model from
  already committed authoritative state.

Application code uses task terminology throughout: `DurableTaskQueueService`,
`DurableTaskSchedulerService`, `DurableTaskDispatcherService`, and
`DurableTaskHandler`. A service that directly changes domain state is named for
that operation, such as `GroupRelationshipMutationService`; it is not
called a task unless it represents durable queued work.

`scope` identifies the serialization boundary of a task. It replaces the old
`aggregate` queue terminology because a projection has an ordering scope but
does not operate on a domain aggregate.

The scheduler is not a general background-job framework. It does not provide
cron scheduling, retry backoff, dead-letter queues, automatic history cleanup,
or network-delivery auditing.

During graceful shutdown, both execution lanes stop accepting in-memory work
and await their currently active bounded executions, including terminal status
writes, before the database pool closes. Pending durable rows and asynchronous
rows not admitted before shutdown remain recoverable on the next startup.

## 2. Scope and ordering

The supported task scope types are `USER_PAIR` and `GROUP`. Scope keys identify
task coalescing and scheduling boundaries; business advisory locks separately
use the participating account addresses:

```text
["task-scope", "USER_PAIR", [domainA, accountA], [domainB, accountB]]
["business-scope", "ACCOUNT", groupDomain, groupAccount]
```

User-pair endpoints are ordered lexicographically by normalized domain and
account. Enqueue takes both corresponding short-lived account advisory locks;
group enqueue takes the group account lock. Committed task IDs therefore
establish the same order as concurrent accepted requests.

Task execution is serialized by `(kind, scopeKey)`, not by `scopeKey` alone.
Consequently, a `PROJECTION` for a group never blocks a later `MUTATION` for the
same group. Existing business advisory locks and stable row-lock order remain
the final correctness boundary for authoritative mutations.

Every accepted mutation request returns a durable task ID as a string. A new
row receives a database-generated ID; an exact duplicate or in-place pending
replacement returns the retained row's ID:

```json
{
  "taskId": "123",
  "status": "PENDING"
}
```

This response means the task was durably accepted, not that its mutation has
completed.

## 3. Persistence model

The [SQL baseline](../../database/migrations/0000_base.sql) defines the following
durable task model.

| Field           | Meaning                                                                         |
| --------------- | ------------------------------------------------------------------------------- |
| `id`            | Durable task sequence and public task ID                                        |
| `kind`          | `MUTATION` or `PROJECTION`                                                      |
| `scopeType`     | `USER_PAIR` or `GROUP`                                                          |
| `scopeKey`      | Canonical serialization scope                                                   |
| `taskType`      | Stable uppercase task discriminator                                             |
| `actorUserId`   | Business operator (local user or system account), when applicable               |
| `payload`       | Normalized JSON; immutable after claim, replaceable in an eligible pending slot |
| `checkpoint`    | Required JSON object containing type-specific durable progress                  |
| `coalescingKey` | Optional desired-state slot used by supersession                                |
| `status`        | Task lifecycle state                                                            |
| `resultCode`    | Stable business rejection/result code                                           |
| `lastError`     | Bounded sanitized unexpected error                                              |
| timestamps      | Acceptance, first claim, and terminal times                                     |

Statuses are `PENDING`, `PROCESSING`, `SUCCEEDED`, `REJECTED`, `FAILED`, and
`SUPERSEDED`. The database enforces their timestamp and supersession shapes.
Only one task for a `(kind, scopeKey)` lane may be `PROCESSING`.

`payload` contains stable identifiers and normalized values only. It never
contains request objects, authorization decisions, secrets, or network-delivery
state. Authorization and mutable business preconditions are re-read at
execution time.

Task rows remain operational history. Relationship and group tables remain the
authoritative domain state, and no task-history GC is currently defined.

### 3.1 Shared admission operations

All task insertion uses `insertPendingTaskInTx`. Pending changes use
`updatePendingTaskInTx`, which conditionally updates only a still-pending row
and returns whether it succeeded. `supersedePendingTasksInTx` applies an explicit
target predicate plus the pending-state guard and sets the completion timestamp.
These operations never open transactions or acquire business locks themselves.

Domain admission methods retain validation, lock ordering, scope selection and
merge policy, including independent two-head fanout MAX merges, combined
thread-head replacement, and Group Meta sync dependency coverage. A thread
fanout losing a claim race appends work; Group Meta sync admission locks its
pending row and rejects an unexpected lost update. Running-task handoff and
terminal transitions remain execution operations, not pending admission updates.

## 4. Current mutation execution

`DurableTaskQueueService.enqueueTask()` currently creates `MUTATION` tasks.
The scheduler is triggered by committed PostgreSQL task notifications and
conditionally claims a `PENDING` row as `PROCESSING`. It drains available work
up to the concurrency limit, refills slots when executions finish, and exits
when no task is eligible. There is no periodic task polling while idle or busy.
A task is eligible only when no earlier unfinished task exists in its
`(kind, scopeKey)` lane and no task in that lane is already processing.
`SUCCEEDED`, `REJECTED`, `FAILED`, and `SUPERSEDED` are all terminal and release
successors; a failed task is not automatically retried.

The [wake migration](../../database/migrations/0002_durable_task_wake.sql) emits
`durable_task_work` notifications for pending inserts, pending input changes,
and status transitions. Database triggers cover admission in caller-owned
transactions and terminal completions. Rollbacks emit no notifications; repeated
notifications with the same payload within one transaction are coalesced by
PostgreSQL. Checkpoint-only writes on running tasks do not wake discovery.
A dedicated connection commits `LISTEN` before scanning existing work. Listener
reconnection repeats that scan to cover disconnected intervals, without
re-executing local `PROCESSING` tasks. Initial startup recovery still runs once.
Discovery query failures and listener disconnections schedule recovery retries;
an empty successful scan schedules no timer. Notifications arriving during a
scan request another pass through the same pump.

The process-local concurrency limit defaults to eight through
`DURABLE_TASK_MAX_CONCURRENCY`. Its active-lane set is an optimization only;
PostgreSQL remains the durable source of work.

Federation message, tombstone, reverse, Group Meta, and State Feed rounds are a
separate process-local execution mechanism. Their durable cursors live in their
own domain tables; they are not durable-task rows or durable-task statuses. The
federation scheduler bounds concurrency, queues follow-up rounds, and recovers
unfinished cursor ranges at application bootstrap. Network requests enter the
federation HTTP pool's global and per-peer concurrency limits.

Checkpoint-only durable-task writes use `saveTaskCheckpointInTx`. The helper
requires `PROCESSING`, updates exactly one row, and never opens its own
transaction. Terminal transitions commit status and final effects together
where the handler owns both.

Execution outcomes are:

| Outcome                                    | Status       | Later tasks in lane |
| ------------------------------------------ | ------------ | ------------------- |
| Mutation committed                         | `SUCCEEDED`  | Allowed             |
| Valid business refusal                     | `REJECTED`   | Allowed             |
| Unexpected error                           | `FAILED`     | Allowed             |
| Process stops after an ordinary task claim | `PROCESSING` | Blocked             |

There is no automatic task retry. Failed rows remain available for investigation
and do not block later tasks. A mutation may commit just
before its terminal task update is lost; such a row deliberately remains
`PROCESSING` for manual investigation instead of being executed again.

SSE and federation wake-ups are post-commit hints. Their success never
participates in the task transaction or lifecycle result.

Federated friend and group request tasks also remain local-only. Client address
resolution completes both recognition directions and confirms reachability
before request submission. The request task does not discover or recognize a
peer; it requires an existing active namespace inside its transaction and
writes no request when that precondition is absent.

## 5. Checkpointed group dissolution

`DISBAND_GROUP` is the current resumable exception. Its first short transaction
commits only the permanent `Group.dissolvedAt` authorization fact. Dissolution
retains group rows, historical Group Meta, State Feed, membership history, and
message history; it creates no metadata-cleanup projection.

The parent then enumerates active membership relationships one at a time using
the monotonic `RelationshipPair.id`. Its checkpoint has this shape:

```json
{
  "afterPairId": "123"
}
```

Each member admission is one short transaction:

```text
lock the group business scope and thread
lock the parent DurableTask row
read the next active GROUP_MEMBER pair where id > checkpoint.afterPairId
resolve its member user
admit FORCE_REVOKE_GROUP_MEMBER through enqueueTaskInTx
advance checkpoint.afterPairId to that pair ID
commit
```

Forced member revocations use the same canonical member merge identity as
ordinary group commands. Local addressed members normalize to Account.id.
`FORCE_REVOKE_GROUP_MEMBER` is the exception to ordinary pending replacement:
while it is pending, later commands for the same member and authored direction
return its task ID without replacing its payload or appending another task.
Mandatory cleanup must complete even if a later application would be rejected
by execution-time permission checks. The barrier does not apply to the opposite
direction, processing work, or terminal tasks. A forced revoke replaces ordinary
pending work in its direction and supersedes any older pending slots atomically.
All other directional commands follow the default rule: different behavior
replaces pending work; identical behavior returns success without appending work.
Processing work remains immutable and may have a pending successor.
Child admission and the parent's
shared checkpoint write commit or roll back together.

Child insertion and checkpoint advancement commit atomically. Restart resumes a
`PROCESSING DISBAND_GROUP` from the last committed pair. The parent retains task
ownership and immediately admits the next member; this exhaustive fan-out
cannot yield to a replacement. It becomes `SUCCEEDED` after every child has
been durably inserted and does not wait for the children to execute.

### 5.1 Authenticated group query denial

`REVOKE_FORBIDDEN_GROUP` shares `GroupRevokeFanoutService` with dissolution.
It has no coalescing key and never cooperatively yields. The denial transaction
checks the frozen authorization epoch under the group business lock and thread
row lock, then admits this parent through `enqueueTaskInTx`.

For a remotely authoritative mirror, a denial admits no task and changes no
relationship or round state. The scheduler logs the denial at debug level,
stops the current round, and waits for a later State Feed push. For a locally
authoritative group, optional cleanup leaves the thread epoch and round
admission unchanged: only members at the denied peer and namespace receive
group-authored forced revocations.

Each child uses `FORCE_REVOKE_GROUP_MEMBER` with the matching `direction` and
denied source coordinates. It rechecks the frozen epoch inside the existing
group mutation transaction, then uses the existing relationship-intent writer.
This path does not synthesize a voluntary departure system message.
The parent saves `afterPairId` with each child admission and completes once all
children are admitted. Both parent and forced children support startup recovery;
neither needs a parent link or waits for downstream delivery.

## 6. Group Meta through thread fan-out

Canonical Group Meta mutations remain O(1) authoritative writes. In the same
transaction, a metadata change admits the existing local and federation thread
fan-out tasks with the current complete message and tombstone coordinates. The
tasks read `GroupMeta.metaEndId` during execution and publish it as part of the
thread head; there is no standalone Group Meta projection task.

The two task types are:

- `FAN_OUT_THREAD_CONTENT` for local `AccountThreadState` snapshots.
- `FAN_OUT_FEDERATION_THREAD_CONTENT` for peer `THREAD_CONTENT_HEAD` items.

Both coalesce by thread and preserve the maximum message and tombstone targets.
A Meta-only mutation can therefore reuse unchanged content coordinates while the
latest canonical Meta coordinate still makes the complete snapshot advance.
Each executor holds the thread content lock, revalidates its current audience or
route, and emits only a best-effort wake after the durable projection commits.
A rollback persists neither the canonical mutation nor either fan-out admission.

Mirrors never publish an origin-owned Meta coordinate back to the origin. After
a mirror Group Meta round commits, local thread fan-out advances the mirror users’
thread snapshots; the compacted group profile remains a client state-feed fact.

## 7. Pending group-member intent slots

Selected group membership mutations represent the latest desired value of one
authored intent. Their coalescing key is directional:

Authored membership commands execute synchronously and do not occupy durable
mutation slots. The directional group-member key remains for mandatory cleanup
such as `FORCE_REVOKE_GROUP_MEMBER`; member-side and group-side cleanup remain
separate.

Admission takes the normal business-scope lock and evaluates only existing
cleanup rows in the same `GROUP` mutation lane:

| Existing state                                                                        | New request                        | Admission result                                                                                |
| ------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| No matching pending or identical running row                                          | Any                                | Insert a new pending row with the directional key                                               |
| Matching `PENDING FORCE_REVOKE_GROUP_MEMBER`                                          | Any command in the same direction  | Preserve mandatory cleanup and return its task ID                                               |
| Matching `PENDING`, identical type/actor/payload                                      | Exact duplicate                    | Return its task ID                                                                              |
| Matching `PENDING`                                                                    | Different desired state or payload | Rewrite in place regardless of intervening work; supersede other pending rows in this direction |
| Identical `PROCESSING` type/actor/payload, no pending successor                       | Exact duplicate                    | Return the running task ID; append nothing                                                      |
| Running task, different new intent                                                    | Different desired state or payload | Keep running work immutable and admit a pending successor                                       |
| Matching task is terminal                                                             | Any                                | Ignore it and insert a new pending row                                                          |

`FAILED` is a terminal row and is never edited by admission. It does not block
successors. Claimed task inputs remain immutable.
Pending replacement represents the latest desired state for that direction and does
not preserve ordering relative to intervening opposite-direction or other group
commands. Different directions remain separate. User-authored revocation, group
departure, invitation revocation, application rejection, and member removal execute
synchronously in their authored business transactions. The remaining directional
task slots are used by mandatory cleanup tasks such as
`FORCE_REVOKE_GROUP_MEMBER`. A captured P2P query denial calls the authored P2P
revoke business transaction directly; that transaction validates the captured
thread authorization epoch after acquiring its normal business locks.

Thread fan-out merges maximum message and tombstone coordinates into an
existing `PENDING` row. A claimed task remains immutable; later work creates a
pending successor. At a page boundary, the running executor may yield only
after that successor covers both of its content coordinates. Meta progress is
read from canonical storage during execution, so it needs no payload field or
separate supersession state machine.

## 8. Projection verification matrix

Projection implementation is not complete until the following unit and
PostgreSQL-backed end-to-end scenarios pass. Tests assert persisted facts and
feed cursors, not only handler return values.

### 8.1 Mutation and enqueue atomicity

- A committed membership entry, departure, role change, ownership transfer, or
  group-profile change first appends its canonical Group Meta item and then
  admits local and federation thread fan-out in the same transaction.
- Every payload contains only the thread and current message/tombstone
  coordinates; it contains no member, audience, or Meta snapshot.
- A mutation rollback persists neither its authoritative changes nor its
  projection task.
- A business no-op creates no projection task.
- Creating, rejecting, or revoking an invitation or join request without an
  active-membership transition appends no canonical member item and creates no
  head projection.
- Group dissolution and its member-revocation fan-out create no Group Meta
  cleanup projection.
- A mirror applying an inbound page never authors canonical Group Meta. It
  stores the page once, advances its cursor, and creates
  the same head task for local audiences in that transaction.
- Mirror delta and full drains write bounded fact pages without Client State
  Feed allocation or wake hints. Only round finalization publishes the cursor
  and admits one task.
- A full drain additionally uses a durable run marker and bounded absence
  cleanup before finalization.
- A crash during delta/full page application or full cleanup resumes from its
  durable cursors; delta and full application for that group cannot overlap.
- The task is inserted after the mutation's final `ThreadAudience` write, and a
  handler can never observe an uncommitted audience state.

### 8.2 Pending-task coalescing

- An identical pending group-member mutation returns the existing task ID and
  performs no insert or update.
- A different value for the same directional group-member intent rewrites the
  same-direction pending row in place and retains its task ID, except for
  pending `FORCE_REVOKE_GROUP_MEMBER` work.
- A pending forced revoke retains its type and payload when a later command
  arrives in the same direction. Opposite-direction commands are unaffected.
- Intervening work does not prevent ordinary pending replacement.
- Member-authored and group-authored intent slots never coalesce with each
  other.
- A claimed or failed mutation is never edited; a later intent becomes a
  pending successor unless it exactly duplicates the running task.
- With no pending task, enqueue inserts one normalized pending projection.
- Membership and group-profile changes replace the same pending head task; the
  replacement still contains only `threadId` and publishes the latest end.
- Replacement insertion and the older task's `SUPERSEDED` transition are
  atomic; forced rollback retains the older pending task unchanged.
- A processing task is never modified or superseded. Enqueue creates a pending
  successor starting at audience cursor zero.
- If processing and pending tasks both exist, a newer enqueue replaces only the
  pending successor unless it exactly duplicates the running task.
- Concurrent mutation transactions for the same group leave at most one pending
  row for the head coalescing key without losing any committed canonical item.
- Tasks for different groups never coalesce.
- `SUPERSEDED` tasks do not block the projection lane. No replacement pointer
  is retained. Fan-out producers complete after admitting all follow-up work;
  they do not wait for that work to complete or retain parent-task links.

### 8.3 Scheduler lane behavior

- A projection and mutation for the same group can execute concurrently because
  their kinds form different lanes.
- Two projections in the same group lane execute in durable task order, even
  when their task types differ.
- A failed projection releases later projections for that group and does not
  prevent a later group mutation from being claimed.
- A processing projection is discoverable for restart recovery; ordinary
  processing mutations remain non-resumable.
- Scheduler shutdown starts no new page while allowing the current page
  transaction to reach a defined commit or rollback boundary.

### 8.4 Pagination and concurrent audience changes

- The first page starts after audience ID zero; each later page reads strictly
  greater IDs in ascending order with the configured bound.
- Each successful page advances the checkpoint to the last scanned audience ID,
  including targets skipped after revalidation.
- Page effects and checkpoint advancement commit atomically.
- A target deleted before its page is read is skipped and receives no feed
  update.
- When revocation commits before the projection fence, the epoch compare-and-set
  fails, the complete page rolls back, and retry skips the removed target.
- When the projection fence commits first, its feed allocation precedes
  revocation. A deliberately delayed wake hint may arrive afterward, but Group
  Meta and dependent resource reads are denied by current authorization.
- An epoch mismatch allocates no State Feed ID and does not advance
  `afterAudienceId`; the canonical Group Meta item is already committed by its
  mutation and is unaffected.
- An audience inserted with a greater ID during a scan is either processed by
  that scan or by the inserting mutation's successor task.
- A mutation committing a greater canonical end after an audience is already
  behind the running cursor creates a successor that starts at zero and repairs
  it.
- An empty final page completes the task without allocating a feed ID.
- Multiple recovery runners serialize on the task row, never commit the same
  page twice, and stop when another runner has made the task terminal.
- Page execution takes no group business advisory lock and no
  `ThreadAudience` row lock; a concurrent authoritative group mutation can
  run while projection work is active and waits at most for the bounded
  thread-row commit fence.

### 8.5 Canonical mutation and head behavior

- Entry appends one canonical `UPSERT` using the effective member-authored
  intent revision; departure appends one bodyless `DEPART`.
- Role and ownership changes append only the required canonical member items;
  group-profile changes append one canonical `GROUP_PROFILE`.
- These items commit before task admission and are never rewritten or
  coalesced by projection execution.
- An existing audience receives only a compacted head referencing the latest
  committed canonical end.
- Replaying a head task against an unchanged end allocates no State Feed ID.
- The first active member from a peer namespace creates an audience whose
  visibility floor is the canonical end established by that transaction.
- Removing one of several members in a namespace retains its audience and
  publishes a head covering the departure.
- Removing the last member removes the audience; that peer receives no terminal
  head, while remaining audiences can observe the same canonical departure.
- A dissolved group retains canonical Group Meta and existing State Feed
  history and receives no empty-roster reconciliation.
- Authored positive group intents are ignored after dissolution. Request and
  acceptance transactions check the terminal state under the group business and
  thread locks before writing intents or projections. A repeated federated join
  request completes successfully without charging request quota or publishing
  client/peer feed updates. Revocation remains permitted for terminal cleanup.

### 8.6 Profile behavior

- The first membership UPSERT uses the member-authored join intent revision,
  never a later default revision read by asynchronous work.
- A committed member-authored positive `REQUESTED` may start independent
  best-effort warm-up of its exact revision before membership becomes active.
- A positive UPSERT commits without waiting for the exact profile snapshot to
  be present or retrievable.
- Default user-profile changes and messages append no Group Meta item, create no
  head task, and do not update canonical or replica member `profileRev`.
- Multiple canonical membership or group-profile changes before fan-out publish
  only the latest canonical end to each audience.
- Group Meta Profile is served only by the group origin to a currently
  authorized mirror for a current matching UPSERT.

### 8.7 Crash, retry, and notification boundaries

- A process stop before a page transaction commits leaves both projection rows
  and checkpoint unchanged; restart safely repeats the page.
- A process stop after page commit retains both effects and the advanced
  checkpoint; restart begins strictly after that page.
- A process stop after the final page but before terminalization can complete
  the same task without generating duplicate feed items.
- A process stop after database commit but before a wake hint does not roll back
  feed state or checkpoint progress; normal polling remains sufficient for
  correctness.
- A wake hint whose HTTP delivery is delayed until after authorization
  revocation is accepted as a wake-up only; the receiver cannot use it to read
  now-forbidden Group Meta or resources.
- Wake hints are emitted only after commit and are coalesced to the greatest
  committed feed ID for each target.
- A failed wake hint does not mark the projection failed or repeat committed
  feed allocation.
- An unexpected page error marks the projection `FAILED` with a bounded,
  sanitized error and does not partially advance its checkpoint.

### 8.8 Locking and feed invariants

- Page targets are processed in stable order and allocator locks follow the
  same order, preventing reversed lock acquisition between concurrent writers.
- Each selected audience row is locked and revalidated before feed allocation,
  and wake hints are filtered against current audience again after commit.
- Canonical Group Meta rows commit in the authoritative mutation before any
  asynchronous client or peer State Feed head can commit.
- Every published head names an end ID that is already readable in the matching
  Group Meta feed.
- Local and peer feed IDs remain monotonic under concurrent projection and
  non-projection writers.
- A projection never widens authorization: every target is revalidated from
  current relationship and audience facts before writing.
- A stale or delayed hint cannot make Group Meta, State Feed dependencies,
  messages, media, or profile data readable after authoritative access has been
  revoked.

The end-to-end suite must include transactions from separate PostgreSQL
connections for coalescing, page/mutation concurrency, recovery-runner races,
and feed-allocation ordering. Pure mocks are insufficient for those guarantees.

### Administrative message deletion

The single-message admin endpoint calls `DeletedMessageService.deleteByModeration`
directly and returns `{ threadId, messageSeq, deletionSeq }` after commit.
Multi-selection is a frontend loop over that endpoint, retaining failed targets.
The shared writer used by withdrawals persists one deletion fact, soft-deletes
the message and any active report, and admits both client and federation content
fanouts in the same transaction. Repeated deletion reuses the fact without
duplicating tombstones or fanouts. There is no separate deletion task.

### Independent content projections

`FAN_OUT_THREAD_CONTENT` uses `['THREAD_FANOUT', threadId]`;
`FAN_OUT_FEDERATION_THREAD_CONTENT` uses
`['FEDERATION_THREAD_FANOUT', threadId]`. Both are `PROJECTION` tasks with
`THREAD` scope. The scheduler serializes by scope key, so these keys must differ.
Ordinary source transactions admit both; system-message writers admit only the
client task. Both types participate in startup recovery.

Pending admission and cooperative yielding share the same two-head MAX merge.
A yielding task completes atomically with successor coverage, without a parent
or successor pointer. Client progress uses `afterAccountId`; federation progress
uses `afterNamespaceId`. Projection writes and their cursor commit in one
transaction through the shared checkpoint writer. After commit, federation wake
hints use the existing per-peer one-second scheduler without awaiting HTTP.

### Automatic relationship revocation attribution

The reserved local `$system` account (`Account.kind = SYSTEM`) identifies the
operator of automatic query-denial revocations. It has no password or published
profile, remains disabled, and is excluded from ordinary user discovery. Its ID
is allocated by the database rather than hard-coded.

P2P automatic revocations record the system ID in `actorUserId` and the local
relationship author in `payload.intentAuthorUserId`. Admission and execution use
the relationship author for direction and authorization boundaries; changing the
operator must not change the relationship being revoked. User-initiated tasks
continue to use `actorUserId` as their author when no separate author is present.
Group query-denial parent tasks carry the system operator, which their member
revocation children inherit. Administrator-initiated work retains the administrator.

Received federation revocations are admitted as remote-initiated durable
relationship work. The state-feed consumer validates and queues the command in
the same transaction as cursor advancement; it does not first revoke the remote
intent outside the task. The handler reuses the existing transactional intent
application and projection methods. A later intent for the same remote direction
replaces a pending command, while processing work remains immutable.

Every revoke task changes one authored direction. This applies to both local
pairs and federation relationships, including group/member pairs. The transition
from an active relationship to an inactive relationship creates the system
message, visibility boundary, and a system-initiated reverse task for the locally
owned opposite direction in one transaction. The reverse task uses the existing
directional writer. The relationship is already inactive, so that transition
naturally produces neither another departure message nor another reverse task.
No extra message/reverse-task suppression flag is required. Forced dissolution cleanup retains its mandatory local-direction cleanup; it is outside ordinary replaceable revoke work. Only an actual local
intent change to `REVOKED` publishes that direction to federation; an incoming
remote fact is never echoed as a locally authored fact.

The reverse task shares the intent author's pending request/acknowledgement/revoke
slot. Except for the pending forced-revoke barrier above, a newer command with different behavior replaces pending work; identical
behavior returns success without appending work. Processing tasks retain their
payload and checkpoint, with a pending successor when needed. A task checkpoint
commits with its business writes so crash recovery cannot replay a completed
revoke over a later authorization.

## Notification attribution

Task `actorUserId` identifies the business operator, not the handler or worker
executing it. Relationship intent ownership is separate. System notifications
always use `$system@local` as their sender and describe event participants with
event-specific content fields; they do not copy the task actor into a generic
message actor. See [system messages](system-messages.md).

State feed delivery is not a durable task. Source transactions commit feed
heads and the call path emits best-effort post-commit wakes; see
[fan-out execution](./fan-out-execution.md).

`FAN_OUT_THREAD_CONTENT`, `FAN_OUT_ACCOUNT_THREAD_CONTENT`, and
`FAN_OUT_FEDERATION_THREAD_CONTENT` retain their separate delivery scopes and
reuse internal projection helpers. Only thread content needs the federation
system-message filter.
