# Durable Task Scheduling

Status: Durable Task naming, persistence, mutation and asynchronous schedulers,
checkpointed group-dissolution fan-out, mirrored `SYNC_GROUP_META` rounds,
canonical Group Meta head fan-out, authoritative membership-fact folding, and
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
that operation, such as `FederationRelationshipMutationService`; it is not
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

Migration `0011_durable_tasks.sql` discards the old `DomainCommand` table and
creates the following clean-cut model. No old queue data or API field is
retained for compatibility.

| Field                | Meaning                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `id`                 | Durable task sequence and public task ID                                        |
| `parentTaskId`       | Optional generating task for internal fan-out                                   |
| `kind`               | `MUTATION` or `PROJECTION`                                                      |
| `scopeType`          | `USER_PAIR` or `GROUP`                                                          |
| `scopeKey`           | Canonical serialization scope                                                   |
| `taskType`           | Stable uppercase task discriminator                                             |
| `actorUserId`        | Authenticated local actor, when applicable                                      |
| `payload`            | Normalized JSON; immutable after claim, replaceable in an eligible pending slot |
| `checkpoint`         | Required JSON object containing type-specific durable progress                  |
| `coalescingKey`      | Optional desired-state slot used by supersession                                |
| `supersededByTaskId` | Replacing task when status is `SUPERSEDED`                                      |
| `status`             | Task lifecycle state                                                            |
| `resultCode`         | Stable business rejection/result code                                           |
| `lastError`          | Bounded sanitized unexpected error                                              |
| timestamps           | Acceptance, first claim, and terminal times                                     |

Statuses are `PENDING`, `PROCESSING`, `ASYNC_PROCESSING`, `SUCCEEDED`,
`REJECTED`, `FAILED`, and `SUPERSEDED`. The database enforces their timestamp
and supersession shapes. Only one task for a `(kind, scopeKey)` lane may be
either `PROCESSING` or `ASYNC_PROCESSING`.

`payload` contains stable identifiers and normalized values only. It never
contains request objects, authorization decisions, secrets, or network-delivery
state. Authorization and mutable business preconditions are re-read at
execution time.

Task rows remain operational history. Relationship and group tables remain the
authoritative domain state, and no task-history GC is currently defined.

## 4. Current mutation execution

`DurableTaskQueueService.enqueueTask()` currently creates `MUTATION` tasks.
The scheduler polls PostgreSQL and conditionally claims a `PENDING` row as
`PROCESSING`. A task is eligible only when no earlier non-successful task exists
in its `(kind, scopeKey)` lane and no task in that lane is already processing.

The process-local concurrency limit defaults to eight through
`DURABLE_TASK_MAX_CONCURRENCY`. Its active-lane set is an optimization only;
PostgreSQL remains the durable source of work.

`ASYNC_PROCESSING` transfers execution ownership to a process-wide asynchronous
scheduler. It retains the lane's ordering fence but is removed from the ordinary
executor's active-task count. The async runner has a separate concurrency limit,
configured by `DURABLE_ASYNC_TASK_MAX_CONCURRENCY` and defaulting to eight. Its
pending queue is currently unbounded. Network requests made by those active
tasks separately use the federation HTTP pool's global and per-peer concurrency
limits.

The handoff is an explicit state transition:

```text
PENDING -> PROCESSING -> ASYNC_PROCESSING -> SUCCEEDED | FAILED
```

The ordinary handler performs no external request before the handoff. It first
commits `ASYNC_PROCESSING`, then submits the row to the async runner and releases
its ordinary executor slot. The async runner calls the registered task-type
handler and awaits its result, while the handler delegates each HTTP operation
to the network scheduler and awaits the returned response. The network scheduler
never writes task or domain state.

After validating a page response, the async handler commits that page's domain
facts and durable checkpoint in one short transaction. On the final page, the
same transaction also moves the task from `ASYNC_PROCESSING` to `SUCCEEDED`.
Consequently, successful handler return means the handler has already completed
the terminal database transaction; the runner must not perform a second success
update. An unexpected handler rejection is sanitized and moves the task to
`FAILED`. Retryable network failures remain inside the network request lifecycle
and do not reject the async handler while retries remain valid.

An async-capable row left in `PROCESSING` by a shutdown is safe to run again
because this pre-handoff handler only requests the state transition. At
application bootstrap, rows already in `ASYNC_PROCESSING` are submitted once to
the async runner. The durable task ID identifies the row for checkpoint and
terminal updates; it is not an execution-instance ID or a process-local
deduplication mechanism.

Execution outcomes are:

| Outcome                                    | Status             | Later tasks in lane |
| ------------------------------------------ | ------------------ | ------------------- |
| Mutation committed                         | `SUCCEEDED`        | Allowed             |
| Valid business refusal                     | `REJECTED`         | Allowed             |
| Unexpected error                           | `FAILED`           | Blocked             |
| Process stops after an ordinary task claim | `PROCESSING`       | Blocked             |
| Work handed to an async scheduler          | `ASYNC_PROCESSING` | Blocked             |

There is no automatic retry or failed-task bypass. A mutation may commit just
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
lock the parent DurableTask row
read the next active GROUP_MEMBER pair where id > checkpoint.afterPairId
resolve its member user
insert one REVOKE_DISSOLVED_GROUP_MEMBER child mutation task
advance checkpoint.afterPairId to that pair ID
commit
```

Child insertion and checkpoint advancement commit atomically. Restart resumes a
`PROCESSING DISBAND_GROUP` from the last committed pair. The parent retains task
ownership and immediately admits the next member; this exhaustive fan-out
cannot yield to a replacement. It becomes `SUCCEEDED` after every child has
been durably inserted and does not wait for the children to execute.

## 6. Group Meta head fan-out

Canonical Group Meta mutations are authoritative O(1) writes in the group
transaction, not projection work. There is exactly one group projection task:

| Task type                 | Desired state written                                                         |
| ------------------------- | ----------------------------------------------------------------------------- |
| `FAN_OUT_GROUP_META_HEAD` | Compacted client and peer State Feed heads for the latest canonical group end |

An invitation or join request does not append a canonical member item or create
head fan-out merely because the request was created, accepted by one side,
rejected, or revoked. A task is created only after a canonical membership,
role, ownership, or group profile item commits. Group dissolution creates no
projection cleanup: it revokes relationships while retaining historical Group
Meta and State Feed data.

User-profile changes do not enter this queue. They create an immutable profile
version and advance `defaultProfileRev` in constant work. Receivers discover the
revision from later messages or relationship flows. The initial member
`profileRev` comes from the effective member-authored join intent. A default
user-profile update does not rewrite it.

The authority/mirror ownership model is defined in
[Canonical Group Meta and Asymmetric Mirrors](./canonical-group-meta.md).

### 6.1 Mutation transaction boundary

The authoritative mutation and creation of its projection task are one database
transaction:

```text
take the normal group mutation locks
fold relationship and authorization state
append one canonical UPSERT, DEPART, or GROUP_PROFILE when state changed
write AccountThreadState and final ThreadAudience state
insert or coalesce FAN_OUT_GROUP_META_HEAD
commit the mutation
```

The projection is inserted only after the final `ThreadAudience` state has been
written. If the mutation rolls back, the projection task rolls back with it. The
transaction does not enumerate listeners or write audience-specific Group Meta
rows. The canonical item is part of the mutation; only State Feed head fan-out
is deferred. After commit, the mutation can finish independently of projection
execution because `MUTATION` and `PROJECTION` use separate scheduler lanes.

No separate member table duplicates a group roster. A mirror retains the
validated Group Meta pages once as its group-scoped replica. It does not author
canonical Group Meta.

Both delta and full synchronization may require multiple pages. Every page
transaction persists replica facts and its round checkpoint but writes no local
head and emits no wake hint. A full round additionally marks observed rows and
removes unobserved rows in bounded cleanup pages. After the fixed-through round
is complete, one short transaction advances the mirror's committed end and
completes `SYNC_GROUP_META`. A local completion wake retries the blocked State
Feed item, whose transaction derives client-visible effects from the committed
replica. Full and delta consumers serialize in the same per-group lane. No read
gate is added; clients follow head-driven pulling, and unsolicited reads during
a round may observe intermediate facts.

`DurableTaskQueueService` exposes a transaction-only admission method for Group
Meta head fan-out. It requires the caller's existing
transaction, reacquires the canonical group advisory lock in that transaction,
and cannot accidentally commit independently of the authoritative mutation.

### 6.2 Payload and coalescing keys

The payload identifies only the locally authoritative thread whose latest
canonical Group Meta end must be published. Mirrors do not run this task; they
publish client state while retrying the ordered State Feed item after
`SYNC_GROUP_META` completes. The payload embeds no member IDs, listener snapshot,
feed end, revision, or precomputed body:

```json
{ "threadId": 42 }
```

Membership and group-profile changes therefore collapse into the same pending
desired-state task.

The canonical coalescing keys are JSON tuples:

```text
["FAN_OUT_GROUP_META_HEAD", threadId]
```

The task uses the group's canonical `GROUP` scope. A processing task remains
immutable; a later mutation inserts or replaces one pending successor starting
at audience cursor zero. Internal integer IDs are payload locators only and
never replace the externally stable group address in `scopeKey`.

### 6.3 Audience pagination and page transaction

The task scans the current `ThreadAudience` of one group thread using the
monotonic `ThreadAudience.id` as a keyset cursor. The initial and subsequently
committed checkpoint is:

```json
{
  "afterAudienceId": "0"
}
```

The bigint cursor is encoded as a decimal string so JSON round-trips exactly.
There is no separate expansion table and no phase that first materializes every
listener. One bounded audience page is one transaction:

```text
lock and re-read the PROCESSING DurableTask row
stop at this page boundary if a newer pending task has the same coalescing key
read ThreadAudience where threadId = payload.threadId
  and id > checkpoint.afterAudienceId, ordered by id, limited to one page
read the latest locally serviceable groupMetaFeedEndId
lock and revalidate every selected audience row
write only compacted client or peer GROUP_META_FEED_HEAD state projections
advance afterAudienceId to the last scanned row, including skipped rows
commit
revalidate current audience and publish coalesced local and peer wake hints
```

The page writes no canonical or replica Group Meta member or profile
row. It does not take the group business advisory lock. The bounded current
audience rows and State Feed allocator rows are locked in stable target order
only while the page writes its monotonically increasing feed IDs.

Audience-row locking gives the two legal commit orders:

```text
projection locks the audience and commits -> audience removal commits
audience removal commits                  -> projection revalidation skips it
```

After the page commits, wake hints are filtered once more against current
audience. The first order may leave a historical compacted projection if the
audience is removed immediately afterwards, but serving still checks current
authorization and the removed target receives no departure notification. The
page lock is bounded and a mutation never waits for the whole projection task
or for network notification.

A target deleted before it is selected is absent and receives no departure
notification. A leaving member learns the local client effect from the
relationship authorization cut; the origin does not encode a federation leave
notification for that member. Every serving endpoint still enforces current
authorization independently because neither a projection nor a hint is an
authorization source.

Repeated projection writes must be idempotent: if the target already references
the same canonical end, no new State Feed ID is allocated.
Wake-ups are lightweight post-commit hints and are coalesced to the highest
committed feed ID per local account or peer namespace.

An audience row inserted concurrently always receives a greater ID. It is
therefore either observed by the current scan or covered by the successor task
created by the inserting mutation. At the next page boundary, a running task
that sees such a pending successor ends successfully. The successor starts at
cursor zero and reconciles both the new audience and every target already
passed by the old cursor against the latest canonical end. Correctness never
relies on changing the checkpoint of a running task.

### 6.4 Projection execution state machine

Unlike an ordinary mutation, a projection is safe to resume because every page
commits its effects and checkpoint atomically and every write reconciles desired
state:

```text
PENDING
  | conditional claim
  v
PROCESSING -- page commit --> PROCESSING with a greater afterAudienceId
  |                                |
  | no remaining audience          | newer pending successor
  v                                v
SUCCEEDED                    SUCCEEDED (yielded at page boundary)

PROCESSING -- unexpected handled error --> FAILED
PENDING    -- replaced before claim ----> SUPERSEDED
```

On restart, the scheduler may resume `PROCESSING` projection tasks. Every page
transaction locks and re-reads the task row before reading its checkpoint, so
multiple application processes cannot claim the same page. A runner that finds
the task already terminal stops without writing. Detecting the empty final page
and the terminal transition must be coordinated with the locked task state so a
second recovery runner cannot reopen completed work.

An unexpected error marks the task `FAILED` and blocks later tasks only in that
group's `PROJECTION` lane pending investigation; it never blocks the group's
`MUTATION` lane. Automatic retry/backoff and failed-task operator actions remain
separate operational design work.

This task continues to use `DurableTask.checkpoint` and needs no task-specific
expansion table. The canonical Group Meta storage migration is a separate
database change. Separate membership/profile projection admission and handlers
are replaced by this task and must be removed rather than retained as
compatibility paths.

## 7. Pending group-member intent slots

Selected group membership mutations represent the latest desired value of one
authored intent. Their coalescing key is directional:

```text
["GROUP_MEMBER_INTENT", "MEMBER", localMemberUserId]
["GROUP_MEMBER_INTENT", "GROUP", targetMemberUserId]
```

Member-authored request, invitation acceptance, addressed invitation
acceptance, revoke, and leave tasks share the member-side slot. Group-authored
invite, join-request acceptance/rejection, invitation revoke, and kick tasks
share the group-side slot. Opposite directions never replace each other. Role,
ownership-transfer, dissolution, and projection tasks are outside these
mutation slots.

Admission takes the normal business-scope lock and evaluates only rows in the
same `GROUP` mutation lane:

| Existing state                                      | New request                        | Admission result                                          |
| --------------------------------------------------- | ---------------------------------- | --------------------------------------------------------- |
| No matching `PENDING` row                           | Any                                | Insert a new pending row with the directional key         |
| Matching `PENDING`, identical type/actor/payload    | Exact duplicate                    | Return its task ID and write nothing                      |
| Matching `PENDING` is the lane tail                 | Different desired state or payload | Rewrite type, actor, and payload in place; retain task ID |
| Matching `PENDING` has later blocking work          | Different desired state or payload | Append a new pending row so event order is preserved      |
| Matching task is `PROCESSING` or `ASYNC_PROCESSING` | Any                                | Do not edit it; append a pending successor                |
| Matching task is terminal                           | Any                                | Ignore it and insert a new pending row                    |

`FAILED` is a blocking row and is never edited. Once a row has been claimed,
its type, actor, payload, and task ID are immutable. In-place replacement is
restricted to a pending lane tail because moving a newer membership decision
ahead of an intervening role, ownership, or dissolution task would violate
accepted request order. A repeated leave with identical payload therefore
returns the first pending leave ID; a later acceptance can replace that leave
only when no intervening blocking mutation exists.

The existing `SUPERSEDED` lifecycle remains used by replace-by-successor
projection tasks. Group-member mutation slots deliberately retain the pending
row instead, as requested by their latest-value semantics.

Projection tasks may be superseded only at a committed page boundary by a newer
projection that reconciles the latest authoritative state. A running projection
is never edited or superseded. Its successor repairs targets that the running
cursor may already have passed.

The projection enqueue state machine, evaluated inside the authoritative
mutation transaction while holding the normal group mutation lock, is:

| Existing task with the same coalescing key | Enqueue action                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| None or terminal only                      | Insert one new `PENDING` task                                                 |
| One `PENDING` task                         | Insert the `threadId`-only replacement, then mark the older task `SUPERSEDED` |
| One `PROCESSING` task                      | Leave it unchanged and insert one `PENDING` successor                         |
| `PROCESSING` plus `PENDING`                | Leave the running task unchanged and replace the pending successor            |

The replacement row and the older row's `SUPERSEDED` transition commit
atomically. The group mutation lock serializes this admission decision, so at
most one pending task exists for each projection coalescing key after commit.
Every `FAN_OUT_GROUP_META_HEAD` replacement retains only `threadId`; canonical
feed mutations are already durable and therefore require no payload union.

This yields the following desired-state flow:

```text
mutation A commits -> projection A PROCESSING at audience cursor 100
mutation B commits -> projection B PENDING (projection A is untouched)
mutation C commits -> projection C PENDING, projection B SUPERSEDED
projection A ends  -> projection C scans from audience cursor 0
```

Projection admission implements this separate state machine. Friend-intent
supersession remains a separate code-review stage.

## 8. Projection verification matrix

Projection implementation is not complete until the following unit and
PostgreSQL-backed end-to-end scenarios pass. Tests assert persisted facts and
feed cursors, not only handler return values.

### 8.1 Mutation and enqueue atomicity

- A committed membership entry, departure, role change, ownership transfer, or
  group-profile change first appends its canonical Group Meta item and then
  creates `FAN_OUT_GROUP_META_HEAD` in the same transaction.
- Every payload contains only `threadId`; it contains no member, audience, feed,
  or profile snapshot.
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
  pending lane tail in place and retains its task ID.
- Intervening blocking mutation work prevents in-place movement; the new intent
  is appended after that work.
- Member-authored and group-authored intent slots never coalesce with each
  other.
- A claimed or failed mutation is never edited; a later intent becomes a
  pending successor.
- With no pending task, enqueue inserts one normalized pending projection.
- Membership and group-profile changes replace the same pending head task; the
  replacement still contains only `threadId` and publishes the latest end.
- Replacement insertion and the older task's `SUPERSEDED` transition are
  atomic; forced rollback retains the older pending task unchanged.
- A processing task is never modified or superseded. Enqueue creates a pending
  successor starting at audience cursor zero.
- If processing and pending tasks both exist, a newer enqueue replaces only the
  pending successor.
- Concurrent mutation transactions for the same group leave at most one pending
  row for the head coalescing key without losing any committed canonical item.
- Tasks for different groups never coalesce.
- `SUPERSEDED` tasks do not block the projection lane and retain a valid
  `supersededByTaskId` history link.

### 8.3 Scheduler lane behavior

- A projection and mutation for the same group can execute concurrently because
  their kinds form different lanes.
- Two projections in the same group lane execute in durable task order, even
  when their task types differ.
- A failed projection blocks later projections for that group but does not
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
- Group Member Profile is served only by the group origin to a currently
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
