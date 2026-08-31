# Domain Command Scheduling

Status: accepted design; implemented for user-initiated friend and group
relationship mutations. Each review checkpoint
in this document was accepted before its corresponding implementation began.
Federation wire behavior remains defined by the normative documents under
[`spec/v1`](../../spec/v1/).

The rollout covers local and addressed federated friend request send, accept,
reject, revoke, and friendship termination. It also covers group invitation,
application decisions, invitation acceptance and revocation, federated group
join request and revoke, leave, kick, role changes, ownership transfer, and
dissolution. Group profile updates remain ordinary synchronous mutations because
they do not change a relationship.

`POST /group/dissolve` now durably accepts `DISBAND_GROUP`. Its handler commits
the terminal group marker, checkpoints roster fan-out, and creates one
parent-linked `REVOKE_DISSOLVED_GROUP_MEMBER` command per active member.

## 1. Purpose and scope

Relationship and group mutation APIs currently execute their complete business
transaction in the request path. The transactions already serialize business
aggregates with PostgreSQL advisory locks and fixed row-lock order, but every new
API entry point must still participate in that concurrency model correctly.

The command scheduler moves mutation execution behind a small, durable,
database-backed domain command queue. It has four responsibilities:

1. persist an accepted command before returning from the API;
2. execute commands for one business aggregate in insertion order;
3. execute commands for unrelated aggregates concurrently up to a configured
   process limit; and
4. leave an unexpected failure visible and blocking instead of automatically
   retrying or allowing later commands to pass it.

This is a domain-specific scheduler, not a general background-job framework. It
does not provide cron scheduling, retry backoff, leases, dead-letter queues,
automatic command cleanup, or network-delivery auditing.

The first implementation covers user-initiated relationship and group mutation APIs.
Federation State Feed consumption, message synchronization, media processing,
SSE, and the existing coalesced State Feed high-water-mark push remain outside
this scheduler.

**Review checkpoint 1 — accepted:** the scheduler boundary and the features
that are deliberately excluded.

## 2. Command identity and aggregate scopes

Every accepted command receives a database-generated command ID. API responses
serialize the ID as a string. Sequence gaps caused by rolled-back inserts are
valid and carry no meaning.

`aggregateKey` identifies the business scope whose commands must not execute
concurrently. It uses the same canonical representation as the business
advisory lock:

```text
["business-scope", "USER_PAIR", [domainA, accountA], [domainB, accountB]]
["business-scope", "GROUP", groupDomain, groupAccount]
```

User-pair endpoints are sorted lexicographically by normalized domain and then
account. A group-member mutation uses the complete `GROUP` key, not a finer
group-member key, because the existing transaction locks and updates group-wide
state and projections. Different user pairs and different groups may execute
concurrently.

Enqueue obtains the same transaction-scoped aggregate advisory lock before it
allocates a new command ID. This
short lock covers only lookup and insertion. It prevents two concurrent enqueue
transactions for one aggregate from establishing an order different from their
committed command IDs.

The business transaction still obtains its existing aggregate advisory lock.
The scheduler is the normal ordering mechanism; the database lock remains the
final correctness boundary for direct callers, mixed-version deployments, and
code paths not yet routed through the scheduler.

**Review checkpoint 2 — accepted:** the canonical keys, command-ID semantics,
and continued use of business advisory locks.

## 3. Persistence model

The application owns one PostgreSQL table rather than depending on a third-party
queue schema. The proposed logical shape is:

| Field             | Purpose                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `id`              | Database command sequence and public command ID                       |
| `parentCommandId` | Optional generating parent for an internal fan-out command            |
| `aggregateType`   | `USER_PAIR` or `GROUP`                                                |
| `aggregateKey`    | Canonical serialized business scope                                   |
| `commandType`     | Stable application command discriminator                              |
| `actorUserId`     | Authenticated local actor, when the command has one                   |
| `payload`         | Normalized immutable JSONB command input                              |
| `progressCursor`  | Optional durable keyset cursor for an explicitly checkpointed command |
| `status`          | `PENDING`, `PROCESSING`, `SUCCEEDED`, `REJECTED`, or `FAILED`         |
| `resultCode`      | Optional stable business outcome code                                 |
| `lastError`       | Bounded diagnostic text for an unexpected failure                     |
| `createdAt`       | Acceptance time                                                       |
| `startedAt`       | Claim time                                                            |
| `completedAt`     | Terminal outcome time                                                 |

Command rows are retained in the first implementation. No success-record GC is
introduced. Retained rows are operational history, not an authoritative source
for relationship or group state; the existing domain tables remain
authoritative.

Payloads must contain stable identifiers and normalized values only. They must
not contain request objects, authorization decisions, precomputed state-machine
results, secrets, or network-delivery state. Mutable authorization and business
preconditions are re-read when the command executes.

**Review checkpoint 3 — accepted:** the application-owned table, retained
terminal records, and immutable payload boundary.

## 4. Enqueue identity

The first implementation has no client idempotency key, equivalence fingerprint,
or pending-command deduplication. Every accepted API request inserts a new
`PENDING` command and receives a new command ID, including when an older command
has identical actor, aggregate, type, and payload.

Duplicate commands execute in aggregate order and rely on the existing
idempotent business semantics. This keeps enqueue independent of
command-specific equality rules.

The enqueue transaction is:

1. normalize and validate the command input;
2. derive `aggregateKey`;
3. acquire the aggregate advisory lock;
4. insert a new `PENDING` row and return its command ID.

**Review checkpoint 4 — accepted, revised:** every accepted request inserts a
new command; the first implementation performs no enqueue deduplication.

## 5. Scheduling and bounded concurrency

One process-local scheduler owns a configurable maximum number of active
command executions. The initial default is proposed as eight. The limit bounds
application work in one backend process; multiple backend processes sharing a
database multiply the effective limit.

The scheduler keeps its pump guard, active-command set, active aggregate keys,
and concurrency slots in process memory. These values are scheduling
optimizations only; they are rebuilt empty after restart and are never the
durable source of pending work.

A command is eligible only when:

- its status is `PENDING`;
- no command for the same aggregate is `PROCESSING`; and
- no earlier command for the same aggregate has a status outside
  `SUCCEEDED` and `REJECTED`.

Consequently, an earlier `PENDING`, `PROCESSING`, or `FAILED` command blocks the
aggregate. Terminal commands for unrelated aggregates never reduce their
available concurrency.

The scheduler does not use explicit `FOR UPDATE SKIP LOCKED` selection. After
choosing an eligible candidate, it claims the command with one conditional
update from `PENDING` to `PROCESSING`. Execution begins only when the update
returns the changed row. If two backend processes observe the same candidate,
only one conditional update can succeed. The other process discards that
candidate and pumps again.

Aggregate mutual exclusion for actual domain state remains the responsibility
of the existing business advisory lock. The conditional command update prevents
duplicate claim; it is not a second aggregate-locking mechanism.

The first implementation uses bounded polling as its reliable wake mechanism.
An optional in-process wake can reduce latency after a local insert, but losing
that wake cannot lose work because `PENDING` rows remain in PostgreSQL.

**Review checkpoint 5 — accepted:** the eligibility rule, in-memory per-process
concurrency management, conditional database claim, and polling model.

## 6. Execution and failure semantics

Handlers are thin adapters over the existing application services. Ordinary
friend request, acknowledgement/acceptance, revocation, group invitation,
membership acknowledgement, and membership revocation retain their current
complete business transaction. The scheduler does not duplicate their state
machines or move network operations into their database transactions.

Execution outcomes are:

| Outcome                                   | Command status | Later commands for aggregate |
| ----------------------------------------- | -------------- | ---------------------------- |
| Business transaction committed            | `SUCCEEDED`    | Allowed                      |
| Validly processed but business-disallowed | `REJECTED`     | Allowed                      |
| Unexpected execution failure              | `FAILED`       | Blocked                      |
| Process stops after claim                 | `PROCESSING`   | Blocked                      |

There is no automatic retry, lease expiry, or failed-command bypass. A stuck
aggregate is deliberately visible for later manual investigation. A manual
reset or skip operation is outside the first implementation.

An explicitly checkpointed `DISBAND_GROUP` fan-out is the sole initial restart
exception. A process restart may resume that command while it remains
`PROCESSING`, because every completed page has a durable cursor committed with
its child insertions. A command marked `FAILED` is never resumed automatically.

Existing business operations are idempotent. There is nevertheless an explicit
crash window when an existing service commits its transaction and the process
stops before the scheduler records `SUCCEEDED`; the row remains `PROCESSING` and
blocks instead of being executed automatically. This is an accepted first
version tradeoff that avoids modifying every existing transaction boundary.

Business exceptions are recorded as `REJECTED`, not `FAILED`. Infrastructure
errors, violated invariants, and unexpected exceptions are recorded as
`FAILED`. Diagnostic recording must bound and sanitize `lastError` and must not
persist secrets or arbitrary remote response bodies.

SSE notifications and the existing one-second coalesced Federation State Feed
push remain post-commit hints. Their success or failure never changes command
status and is not audited by the command scheduler.

**Review checkpoint 6 — accepted:** reuse of existing transactions, no
automatic recovery, and the distinction between `REJECTED` and `FAILED`.

## 7. API acceptance contract

Mutation endpoints authenticate the caller, validate and normalize their DTO,
resolve enough stable identity to derive the aggregate key, and enqueue the
command. A successful response means that PostgreSQL contains the newly
inserted `PENDING` command.

The response includes the new command ID:

```json
{
  "commandId": "123",
  "status": "PENDING"
}
```

The HTTP endpoint may retain the application's existing success-status
convention. The contract must describe success as durable acceptance, not as
completed business execution. Mutable authorization and state-machine outcomes
may later produce `REJECTED`.

The first implementation does not require a command-status query endpoint. The
returned ID is retained for log correlation, investigation, and a possible
future status API. Existing Client State Feed and SSE behavior remains the
source of client-visible state convergence.

**Review checkpoint 7 — accepted:** acceptance-time success and the response
shape.

## 8. Group dissolution fan-out

Group dissolution is the only initial command that changes the current business
transaction boundary. The existing implementation updates the terminal group
marker, every member, every active relationship, pending invitations, and
per-recipient effects in one transaction. That work grows with group size.

`DISBAND_GROUP` instead performs these phases:

### 8.1 Commit the terminal group fact

One short business transaction acquires the existing `GROUP` advisory scope,
revalidates ownership, and sets the permanent `Group.dissolvedAt` marker. It
writes the bounded group-level state needed to make that terminal fact visible.
It does not update every member in this transaction.

Once `dissolvedAt` commits, every authorization and mutation path treats the
group as terminal. No new active membership may be established. Group rows,
history, and membership records are retained; dissolution performs no GC.

### 8.2 Enumerate the active roster without a long-held lock

After the terminal transaction commits, the `DISBAND_GROUP` command remains
`PROCESSING` while its handler reads active roster members in bounded pages. It
does not hold a database transaction or advisory lock across pages. The parent
command's `progressCursor` stores the greatest member user ID through which
child insertion has committed.

Pages use stable keyset pagination, for example:

```text
threadId = dissolved thread
left = false
userId > previousUserId
ORDER BY userId
LIMIT pageSize
```

`OFFSET` pagination and repeatedly querying the first active page are
forbidden. Member rows remain active until their later revoke command executes,
so either approach could repeat or skip work.

For each active member the handler enqueues one internal
`REVOKE_DISSOLVED_GROUP_MEMBER` command. Its semantics include the group and
member identity. Child commands use the same canonical `GROUP` aggregate key
because the existing
membership-revocation transaction locks and updates group-wide state. Every
child stores the dissolve command ID as `parentCommandId`; this link records its
origin but does not implement a generic dependency scheduler.

One page is one short transaction. It locks the parent command row, re-reads its
current cursor, selects the next page, inserts every child, and advances
`progressCursor` to the page's last member ID. Child insertion and cursor
advancement must commit or roll back together. The parent row lock protects this
checkpoint if two backend processes overlap during restart; it is not held
while child business transactions execute.

The parent and children therefore have this order:

```text
DISBAND_GROUP (PROCESSING)
  -> enqueue member revoke commands
DISBAND_GROUP (SUCCEEDED)
  -> member revokes execute serially for this group
```

Different dissolved groups may fan out and revoke concurrently within the
global scheduler limit.

### 8.3 Failure and restart behavior

If the process stops without recording an execution failure, the parent remains
`PROCESSING`; its group aggregate stays blocked and its inserted children remain
durable. Application bootstrap resumes this explicitly checkpointed command
from `progressCursor`. A page committed before the stop is never regenerated;
a page that did not commit advanced neither its children nor its cursor.

If enumeration reports a definite unexpected failure, the parent becomes
`FAILED` and is not resumed automatically. Already inserted child commands stay
blocked behind it.

The parent becomes `SUCCEEDED` only after it has enumerated the complete active
roster and durably inserted all required child commands. It does not wait for
the child commands to execute. The authoritative group dissolution already
took effect when `dissolvedAt` committed.

Each child reuses the existing per-member revoke/acknowledgement transaction.
The existing one-second State Feed push coalescing naturally combines the
durable feed changes produced by successive children; the command handler does
not send or audit network push attempts.

**Review checkpoint 8 — accepted:** immediate terminal marking, checkpointed
keyset enumeration, parent-linked child commands, restart recovery from the
durable cursor, and parent completion after durable fan-out rather than after
child execution.

## 9. Required invariants

- A command belongs to exactly one aggregate.
- At most one command for an aggregate may be `PROCESSING`.
- Commands for an aggregate execute in committed command-ID order.
- `FAILED` and `PROCESSING` block every later command for that aggregate.
- Only an explicitly checkpointed `PROCESSING DISBAND_GROUP` may resume after a
  process restart; a `FAILED` command never resumes automatically.
- Every accepted request owns a distinct command ID; enqueue performs no
  equivalence deduplication.
- Command acceptance and command execution never depend on an in-memory queue.
- Existing business advisory locks and row-lock ordering remain authoritative.
- A command database transaction never includes network push delivery.
- `Group.dissolvedAt` is the immediate terminal authorization fact; per-member
  revocation is a subsequent durable projection process.
- Command retention is not the retention model for domain state.

## 10. Verification before rollout

Implementation must include PostgreSQL-backed concurrency coverage for:

1. concurrent equivalent enqueue returning distinct, ordered command IDs;
2. non-equivalent commands for one aggregate retaining order;
3. unrelated aggregates reaching the configured concurrency;
4. concurrent conditional claims allowing only one worker to execute a command;
5. a `FAILED` or abandoned `PROCESSING` command blocking successors;
6. `REJECTED` allowing successors;
7. service restart retaining `PENDING` work;
8. successful existing relationship handlers reached through the scheduler;
9. dissolution becoming terminal before member revoke execution;
10. paginated dissolution fan-out committing child insertion and cursor
    advancement atomically;
11. process restart resuming dissolution after the last committed cursor
    without regenerating a committed page;
12. no network push attempt participating in command status or transaction
    completion.

Implementation and endpoint migration should proceed command type by command
type. A command type is routed exclusively through either the old direct entry
point or the scheduler during a deployment stage; dual execution is forbidden.
