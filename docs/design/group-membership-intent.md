# Group membership intent architecture

Status: migration implementation. Production handlers are switched one business entry at a time.

[GroupAuthoredMembershipIntentService](../../src/business/group/membership-intent/group-authored-membership-intent.service.ts)
exposes `handleJoinRequest` for acceptance and rejection of applications to authoritative
local groups, including applicants hosted by another server. It is not a Nest provider,
HTTP endpoint, or durable-task handler. The
[PostgreSQL comparison suite](../../test/group-join-decision-experiment.e2e-spec.ts)
constructs it explicitly from application services.

## Approved development contract

The target business-lock terminology is **Account Meta Lock** and
**Relationship Pair Lock**. This implementation still uses the legacy, broader group
ACCOUNT scope to protect roster and other aggregate effects. References to its
group lock below describe that current implementation, not a rule that all group
operations require an Account Meta Lock. Narrowing this scope requires a separate
review of cross-Pair invariants and coexistence with legacy writers.

Follow the [business mutation SQL standard](./business-mutation-sql-pattern.md)
for subsequent flows. This document records the acceptance-specific implementation
and measurements.

The first implementation is group join-request acceptance (group ACK against an
applicant's effective REQ/ACK). The command-specific request must still be valid;
only the group-authored intent is changed. Keep the existing command entry and
handler on their current implementation until the implementation is reviewed and
explicitly approved for rollout. Temporary migration adapters are allowed.

The scope ends at fanout task admission. Refactor authorization, business writes,
pending-task decisions, and the single task insertion. Recipient selection,
notification coverage, delivery, pagination, and execution checkpoints belong to
the existing fanout implementation and are not redesigned in this implementation.
Do not introduce a new fanout executor or scan feeds/request projections to build
notification recipient lists in the approval flow.

Reuse parameterized Drizzle `sql` fragments with named CTE input/output contracts.
Compose local-member and federated-member branches from those fragments; do not
build a general-purpose SQL orchestration framework. SQL values remain bound
parameters. A fragment's position is not an execution-order guarantee: express
write dependencies through `RETURNING`, and avoid modifying a row twice in sibling
CTEs. Drizzle continues to own the connection and transaction.

The implementation lives under `src/business/group/membership-intent/`, with its shared
SQL and Pair lock primitive under `src/business/shared/`. Only implemented
code and its direct dependencies are moved; other business flows are not included.

Group-authored approval acquires the **group Account State scope**, encoded as
`["business-scope", "ACCOUNT", "local", groupAccount]`, followed by the **Pair
scope** for the group and applicant. Member-authored commands instead acquire
the local member's Account State scope before the same Pair scope; referencing
the group does not acquire its Account State scope. The Pair key is derived from
complete lowercase endpoint addresses (`account@domain`) that the caller
composes from identities already in hand; the lock primitive performs no
normalization, validation, or canonicalization lookup. Explicit locks are
acquired once, before thread/Pair/Intent/allocator row locks. The old production
lock helpers and handlers remain unchanged.
See the [per-task responsibility and lock index](./durable-task-responsibilities-and-locks.md).

## Transaction and phase boundaries

One outer write transaction owns all locks, source writes, feed projections, and
outbox admission. Acquire business locks before the authorization statement:
waiting for an advisory lock inside that same statement would not refresh its
MVCC snapshot. Preserve the established business/row/allocator lock ordering.

After business-lock acquisition, organize the command into four phases:

1. One authorization/feasibility SQL statement validates the manager, pending
   request, effective applicant intent, authoritative group, and branch identities.
   It returns the local/federated branch and data needed by the update. Complete
   required allocator locks before source writes or triggers allocate feed IDs.
2. One composed business SQL statement writes the group intent, pair, Group Meta,
   branch-specific member/read/synchronization state, audience, manager projections,
   and recipient feed state. It returns the business result needed for task admission.
3. One task-admission SQL statement decides whether this group needs a new fanout
   task and supersedes replaceable PENDING work. It does not merge notification
   payloads or checkpoints. A worker winning a claim must cause conditional
   updates to fail safely and preserve the need for a successor task.
4. One single-row INSERT persists the existing independent fanout task when
   needed. This is not a batch insertion or one task per notification recipient.

"Cancel itself" means suppressing a redundant fanout insertion; it never means
canceling the approval command. Running tasks
must not be overwritten.

Four phase statements are a design target, not a claim of four total network
round trips. Count transaction control, identity location, and lock acquisition
separately and report them rather than hiding them in the measurement.

After commit, a federated acceptance passes its single applicant peer to the
existing `pushStateFeedDomains` notification path, which routes through the
existing peer push scheduling/throttling mechanism. The target comes from the
validated applicant identity and the written ACK feed result; no recipient scan
or additional SQL is needed. Local acceptance has no peer target. A notification
failure does not roll back committed business state.

Transport wake-ups happen only after commit. Any failure before commit, including
task admission or insertion, rolls back the entire command. No new handler is registered.

## Fanout task admission principles

These rules govern admission only. Preserve the existing fanout task's identity,
payload contract, replacement scope, and initial checkpoint format.

- Admission inserts at most one fanout task for the approval, never a batch or
  one task per recipient.
- Replace eligible older PENDING work by marking it SUPERSEDED and inserting
  the new task in the same transaction. Do not merge notification ranges,
  recipient lists, or execution progress.
- Initialize the replacement as a new task using the existing task contract.
  Do not inherit the replaced task's execution checkpoint.
- Do not overwrite or supersede PROCESSING work. When new work is needed,
  insert a PENDING successor. A concurrent worker claim must not cause the
  new task requirement to be lost.
- Skip insertion when the existing admission semantics determine that no new
  fanout task is needed. The presence of a PROCESSING task alone is not proof
  that new work can be suppressed.

How the executor discovers recipients, covers notifications, handles a successor,
paginates, or resumes execution remains its responsibility. Those mechanisms are
outside this change; do not add new requirements for them to justify pending
replacement. Admission tests should verify task state, payload, initialization,
claim races, and atomic rollback without introducing a new delivery design.

## Meta head carried by thread fan-out

Status: owner-approved requirements change for this implementation, recorded before
implementation.

This change supersedes the meta-head admission above: the implementation stops admitting
`FAN_OUT_GROUP_META_HEAD` and stops publishing the standalone
`GROUP_META_FEED_HEAD` state-feed item. The group meta feed end id instead
travels with the thread's own publications as an optional field — a union type.
Client thread feed items carry it for GROUP threads only; federated
`THREAD_CONTENT_HEAD` bodies carry it for group-authored heads only, and a P2P
head carrying the field is a permanent protocol violation. The field joins the
peer item's snapshot revision, so the compaction guard's "changed without
advancing" invariant stays unreachable for legitimate progress. Legacy flows
outside this implementation (role and profile mutations, dissolution, the membership
finalizer, and the mirror round's local publication) keep the existing item and
task untouched. Both channels publish the same canonical `GroupMeta.metaEndId`,
so the mixed period stays additive on the client.

### Authoritative write side

- Admission rule: every implementation transaction that advances `GroupMeta.metaEndId`
  admits thread fan-out. Acceptance admits `FAN_OUT_THREAD_CONTENT` and
  `FAN_OUT_FEDERATION_THREAD_CONTENT` — the federation task is admitted for
  every roster change, not only a peer-hosted member, because the inline peer
  write covers just the new member's peer; it no-ops through its route scan
  when the group has no federated audiences. A kick adds the federation task to
  its existing local fan-outs. Rejection and invitation admit nothing (no meta
  change), as before. The gate is `canonicalRosterChanged || audienceChanged`;
  the `recipientFeedId` component is dropped because it states a one-person
  notification fact whose only previous role was letting the meta-head task's
  wake sweep carry the applicant. The applicant's wake becomes an explicit
  post-commit notify built from the returned `recipientUserId` and
  `recipientFeedId`, exactly like the revocation branch.
- Acceptance writes its `GROUP_JOINED` system message inline, symmetric with
  the revocation path's `GROUP_LEFT`, and inserts the new member's
  `AccountThreadState` row with the current meta head in the same statement.
  The member's initial read boundary remains the pre-message `curSeq`
  (`join_source` is materialized first), matching the legacy post-commit
  publication where the join message stays unread.
- Assignment is execution-time. The fan-out executor reads the canonical head —
  the fan-out payload contract is unchanged — and writes
  `GREATEST(stored, canonical)` only when the stored value is behind,
  independent of content-head progress, because meta-only changes advance no
  message sequence. A concurrent legacy meta mutation holds no thread lock, so
  the executor may observe a pre-commit head; the `GREATEST` guard keeps the
  column monotonic and the next fan-out reconciles.

### Mirror side

The `THREAD_CONTENT_HEAD` consumer branch validates the optional field and
starts the group meta sync task; the legacy `GROUP_META_FEED_HEAD` branch
remains for old-version interop. Once the sync applies facts, the mirror fans
out to its local users only: join and leave facts already enqueue the client
fan-out through their system message, so the sync task admits the local thread
fan-out explicitly only for meta-only facts that write no message. A mirror
never enqueues the federation fan-out for origin-driven meta changes: the route
query's mirror branch would re-publish origin facts back to the origin.

### Schema and trigger contract

`AccountThreadState` gains a nullable `groupMetaFeedEndId` (NULL for P2P). The
`thread_feed_before_write` allocation condition list gains the column with a
NULL-safe `IS DISTINCT FROM` check. This is not optional: the thread feed delta
scans a `threadFeedId` range, so a changed row without a freshly allocated id is
silently invisible, and the column changes alone — meta-only mutations advance
no content head to fall back on. Writers inside SQL cannot allocate in
application code, so the trigger remains the single allocation mechanism; any
new client-visible column must join its condition list. No backfill:
environments reset their data, and rows converge on the next fan-out.

### Edge behavior

- The fan-out skips blocked recipients. Unblocking assigns the current head in
  the same lock scope (`setBlocked`), so a long-blocked member does not resume
  with a stale roster and no hint.
- Legacy-only mutations keep publishing the old item during the mixed period;
  duplicated wake-ups across the two channels are harmless.

### Verification updates

The admission test that asserts exactly one inserted task changes to the new
task set with no meta-head task. Measured statement counts change with the
inline system message and the added admission statement.

## Branch rules

Local-member activation initializes the read boundary and clears preview/mention
state without adding a join-time history visibility floor. Preserve monotonic read
positions, unrelated preferences, and existing source coordinates on re-entry.

Federated-member activation initializes or advances the appropriate namespace's
synchronization state, preserving processed coordinates and epoch/recovery rules.
The history-access setting remains effective and is read in the business SQL:
allowing history chooses floor zero, otherwise a new audience starts at the current
thread tail. Existing audience boundaries remain unchanged.

The initial rejection experiment remains separate from acceptance's composed
SQL no longer: per the owner-approved requirements change recorded in the
[unified group intent decision](./unified-group-intent-decision.md), both
commands share one authorization statement and REVOKED gained a composed
statement covering rejection and kick alike, plus the ACK entry states for a
pending application and an already-acked invitation. The same authorization
statement now also carries the operator/target roster roles and the server
capacity count, so kick rank/dissolved gates and the capacity gate stay
inside the single post-lock feasibility read; the unified decision document
records those gates.

## Verification and rollout

Run:

```sh
DATABASE_QUERY_LOG=0 npm run test:e2e -- test/group-join-decision-experiment.e2e-spec.ts
```

The suite exercises the existing and new paths against PostgreSQL,
checks local and remote membership effects, measures application-issued SQL
statements, and tests authorization, expiry, late failure rollback, and competing
withdrawal, manager authorization removal, dissolution, and duplicate approvals.
History-setting tests cover the default, disabled history, and an existing audience
boundary that must be preserved. Admission tests verify the existing task contract, one-row insertion, pending
replacement, suppression, and a competing worker claim. Pair-lock tests verify
group-before-pair ordering, one acquisition of each, direction-independent keys,
and waiting for a competing Pair lock before the ACK is written. Schedulers are not started,
so committed tasks remain available for inspection.

Statement counts include transaction boundaries. They exclude SQL executed
internally by PostgreSQL triggers and are not latency benchmarks. The fixtures
are small and do not reproduce a loaded multi-server federation lab.

Keep this implementation bounded to join decisions. Before any production switch, compare
it in the federation workload, expand shared behavioral coverage as needed, and
review the lock and SQL boundaries. Wiring handlers and deleting the old path
are separate changes; neither is part of this implementation.

## Member-authored family

[MemberAuthoredGroupMembershipIntentService](../../src/business/group/membership-intent/member-authored-group-membership-intent.service.ts)
extends the implementation to the reverse authority: a local user acting on their
own membership pair. The command set is REQUESTED (apply to an authoritative
local group — pair minted when absent, no friendship precondition, seven-day
TTL), ACCEPTED (complete an outstanding invitation), and REVOKED (withdraw a
pending application, decline an outstanding invitation, or leave the roster).

Reuse over new SQL: the application statement mirrors the invitation's shape
against the `applicationEndId` stream with the applicant as the sole inline
recipient; the member's ACCEPTED reuses `groupJoinAcceptanceSql` with
`projectionDirections: ['INVITATION']` and `authorMemberSide` — the statement
authors side B as well (the family's only side B ACCEPTED writer) and reads the
written row back through `join_source`; REVOKED reuses `groupIntentRevocationSql`
with `authorSide: 'B'`, collapsing to the rejection shape unless the member is
rostered. Manager authorization and the outrank gate have no member-side
equivalent: the actor is the pair's own endpoint B. Manager notification is
never an in-process wake — the application's `FAN_OUT_GROUP_PROJECTION`
admission and the executor's per-direction watermark advance own it (see the
[notification policy](./group-intent-wake-and-notification-policy.md)).

## Review entry points

- [Transaction owner](../../src/business/group/membership-intent/group-authored-membership-intent.service.ts):
  acquire the group and Pair business locks once each, validate, select the address branch, and
  execute the business update and task admission in the same transaction.
- [Authorization SQL](../../src/business/group/membership-intent/group-authored-membership-authorization-sql.ts):
  read the request, manager authorization, group profile, and branch identities
  in one statement after business-lock acquisition; the invitation variant keys
  on the target address and the minted pair.
- [Business SQL](../../src/business/group/membership-intent/group-membership-acceptance-sql.ts):
  compose shared relationship/roster/manager fragments with local or remote
  membership and recipient-feed writes.
- [Task admission](../../src/business/group/membership-intent/group-join-fanout.ts):
  decide and replace PENDING work in one statement, then insert at most one
  `FAN_OUT_GROUP_META_HEAD` task using the existing payload and checkpoint.
  No executor is added or modified. (Superseded for this implementation by the approved
  "Meta head carried by thread fan-out" change above, pending implementation.)

## Measured statement counts

PostgreSQL comparison run on 2026-09-11 (35 tests passed), grouped by command:

| Command   | Scenario                                  | Existing path | Experiment | Reduction |
| --------- | ----------------------------------------- | ------------: | ---------: | --------: |
| ACK       | Accept a local applicant                  |           131 |         15 |       116 |
| ACK       | Accept a remote applicant                 |           141 |         18 |       123 |
| ACK       | Complete an acked invitation              |             — |         15 |         — |
| REVOKE    | Reject a local applicant                  |            82 |         13 |        69 |
| REVOKE    | Kick a local member                       |             — |         13 |         — |
| REVOKE    | Kick a remote member                      |             — |         15 |         — |
| REQUESTED | Invite a fresh local member               |             — |         15 |         — |
| REQUESTED | Invite a fresh remote member              |             — |         17 |         — |
| REQUESTED | Collapse into ACK: pending application    |             — |         15 |         — |
| REQUESTED | Collapse into ACK: outstanding invitation |             — |         15 |         — |

The unified kick runs the same composed statement as rejection: every roster,
system-message, fan-out, and reverse-task effect is gated on roster presence
inside that one statement, so removing a member costs nothing beyond what a
rejection costs. The two REQUESTED collapses dispatch into the ACK path with
the authorization row already in hand, so they cost exactly what the
corresponding ACK costs. A fresh invitation carries the same shape — intent,
projection row, invitee recipient, projection fan-out admission — with no
roster or system-message effects.

The implementation acquires one group business lock and one Pair business lock, then locks
the existing pending Pair without a redundant insert or threadId update. Authorization, business writes, admission, and task insertion each use one
statement. The remaining statements are transaction control, identity location,
and existing lock/allocator preparation. They are deliberately included in the
reported totals; this is not yet four total transaction round trips. These counts
support a reduction in round trips, not a measured production latency improvement.
