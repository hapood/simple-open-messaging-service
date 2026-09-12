# Mirror group intent application

Status: owner-approved design for the mirror-side counterpart of the
[unified group intent decision](./unified-group-intent-decision.md). This is an
opt-in implementation experiment under the
[business mutation SQL standard](./business-mutation-sql-pattern.md): production
consumer branches stay unchanged, and no provider, endpoint, or task handler is
registered or routed in this round.

## Purpose

The unified intent decision implements the group-authored **ACK**, **REVOKE**,
and **REQUESTED** family for locally authoritative groups. This document defines
the receiving side: when this server hosts a **mirror** of a peer's group, the
peer group's authored intent arrives as a group-keyed `RELATIONSHIP_INTENT`
State Feed item and must be applied to the local mirror with the same composed
SQL discipline.

The legacy reference implementations are the mirror branches of
`FederationStateFeedConsumerService.applyPageInTx`
(`federation-state-feed-consumer.service.ts:519-637` invitation,
`:776-808` activation, `:809-904` deactivation and client feed row). The
experiment re-derives their effects as composed statements; production routing
remains on the legacy path until the experiment is reviewed.

## Principles

- **No new event type.** The wire contract is unchanged: a group-keyed
  `RELATIONSHIP_INTENT` item (`account` starts with `!`) whose body carries
  `{status, profileRev, note, requestedAt, expiresAt}` plus
  `messageEndSeq`/`tombstoneEndSeq` for non-REVOKED statuses. A sibling
  `THREAD_CONTENT_HEAD` item continues to be applied by its own consumer branch
  and is not touched by the applier.
- **One-side authoring, system proxy writes.** A business flow authors only the
  intent of the side it represents. A received remote intent is persisted by a
  system proxy write of the remote author's side. The system may also author the
  local side only as a derived consequence of a confirmed relationship: the
  `REQUESTED → ACCEPTED` promotion, the acceptance ack-back, and the mismatch
  REVOKED write-back below. The
  [authoritative experiment](./unified-group-intent-decision.md) conforms (it
  authors side A only); the mirror applier follows the same doctrine from the
  other end.
- **Mirror simplifications (owner-approved).** The applier never writes
  `GroupRequestProjection`, `GroupMeta` or any meta feed row, admits no
  meta-head fanout task, creates no `ThreadAudience`
  ([mirror doctrine](./canonical-group-meta.md)), and writes **no system
  messages**. Mirror GROUP_JOINED/GROUP_LEFT continue to be produced by the
  existing `SYNC_GROUP_META` delta finalizer
  (`group-meta-sync-task-execution.service.ts:526-580`), which also owns the
  departure watermark; see the divergence list.
- **The thread is established inside the applier transaction.** Activation does
  not wait for any later system-authored intent: the mirror thread shell, the
  canonical pair, the pair activation, the local `AccountThreadState`, and the
  synchronization-state initialization all commit in the command's transaction.

## Entry states

Local state is side B (the local member's own authored intent) plus
`RelationshipPair.active`. Effectiveness follows
`relationship-intent-state.ts`: ACCEPTED always effective, REQUESTED effective
while unexpired, REVOKED never; both sides effective is a confirmed membership.
The incoming `status` is the peer group's side-A intent.

### Received REQUESTED (invitation)

| Local state | Branch | Effects |
| --- | --- | --- |
| No pair (stranger) | New invitation | Mint thread shell (`ensureFederatedGroupRequestShellInTx`) and canonical pair (inactive) in-tx; persist side A `REQUESTED` (note, requestedAt, expiresAt from the body) → client feed row + wake |
| Side B `REQUESTED` unexpired | Collapse into ACK | Run the activation branch below (both sides effective) |
| Side B `REVOKED` or expired | Fresh invitation | Refresh side A `REQUESTED`; side B untouched → client feed row |
| On roster (active) | Silent no-op | — |

### Received ACK (acceptance / invitation completion)

| Local state | Branch | Effects |
| --- | --- | --- |
| Side B `REQUESTED` unexpired | Activate | Persist side A `ACCEPTED`; promote side B `REQUESTED → ACCEPTED` (system proxy, `publishAccepted`); pair `active`/`established`; `AccountThreadState` initialized at the thread tail; `FederationThreadSyncState` initialized from the body coordinates; ack-back `ACCEPTED` to the origin → client feed row + wake |
| Side B `ACCEPTED`, invitation outstanding | Activate (completion) | Same as above (both sides ACCEPTED) |
| Side B `REVOKED`, expired, or otherwise not activatable | **Mismatch** | Persist side A `ACCEPTED`; **no activation**; enqueue the system REVOKED write-back (below) |
| Already rostered | No-op | — |

### Received REVOKE (rejection / kick)

| Local state | Branch | Effects |
| --- | --- | --- |
| On roster (was active) | Kick | Persist side A `REVOKED`; pair deactivated (epoch rules below); enqueue reverse revoke `author: 'MEMBER'` (system-authored side B `REVOKED`, the local departure) → client feed row |
| Side B `REQUESTED`, not on roster | Rejection | Persist side A `REVOKED` only; side B stays `REQUESTED` so re-application keeps working → client feed row |
| No pair / already revoked | No-op | Body-level compaction already suppresses the item |

Per-command effects that apply in every activating or deactivating branch:
one client `ClientStateFeed` `RELATIONSHIP_INTENT` row (body-compacted
dedupe, group presentation with `isLocal: false`) and one post-commit
in-process wake via the returned `clientFeedUpdates`. The applier admits **no**
fanout task: thread content flows through the existing round machinery, and the
`THREAD_CONTENT_HEAD` sibling item updates synchronization targets through its
own branch.

## ACK mismatch write-back

When the peer group's ACK cannot be honored locally (side B revoked or expired,
no effective request), the applier records the received side-A intent and
repairs the origin with a **system-generated member-authored REVOKED**:

```ts
await this.reverseRevokes.enqueueGroupInTx(tx, {
  threadId,
  group: { account: groupAccount, domain: peerDomain },
  memberUserId,
  author: 'MEMBER',
});
```

This reuses `FederationReverseRevokeService.enqueueGroupInTx`
(`federation-reverse-revoke.service.ts:51`) verbatim — the same entry the
legacy consumer already uses for kicks (`:712-721`). `enqueueReverseGroupRevokeInTx`
(`reverse-revoke-task.ts:33`) stamps
`actorUserId = systemAccountIdInTx` and payload `RESPOND_TO_REVOKE`; execution
runs later in its own transaction through
`writeMemberRelationshipIntentInTx(..., 'REVOKED', ...)`, which owns the member
intent write, the peer publication, and the client feed row. The origin then
converges through its existing member-REVOKED branch
(`federation-state-feed-consumer.service.ts:1005-1047`): deactivate with the
GROUP_LEFT boundary when it still considered the member active, otherwise
record only.

The enqueue must be gated on a real transition (the composed statement's
mismatch flag flips only when local state actually rules out activation), so
replayed or re-applied items never enqueue twice. This is symmetric to the
origin's own defense at `:905-929`, which rejects an unsupported member-authored
ACCEPTED by authoring a group REVOKED back.

## Transaction shape and locks

One outer transaction owns the command, following the
[standard](./business-mutation-sql-pattern.md): pre-lock locator, business
locks, one authorization statement, the composed business statement, task
admission (reverse-revoke enqueue only), single insert.

Lock order (mirrored group scope):

```text
lockBusinessAccountsInTx([{ account: groupAccount, domain: peerDomain }])
lockRelationshipPairsInTx(GROUP_MEMBER pair, sorted addresses)
thread content lock under the group, canonical pair FOR NO KEY UPDATE,
  RelationshipIntent rows in author-side order, AccountThreadState rows
stateFeed.lockTargetsInTx([{ peerDomain, namespaceId }])   -- before any
                                                           -- client-feed allocator write
writes (shell/pair mint, intents, pair.active, AccountThreadState,
  FederationThreadSyncState, client feed row, ack-back peer row)
```

The group ACCOUNT scope uses the **authority domain** for mirrors
([task index](./durable-task-responsibilities-and-locks.md)), acquired before
the Pair scope, once per transaction. `ensureFederatedGroupRequestShellInTx`
acquires the same advisory scope internally; acquiring it beforehand is
re-entrant and keeps the locator-before-scope ordering honest. Row preparation
must not issue business updates that trigger early feed allocation before
`lockTargetsInTx` (the `prepareRecipient` precedent in
`group-membership-acceptance-sql.ts`).

The applier must remain callable from the deferred path
(`APPLY_FEDERATED_RELATIONSHIP_INTENT` re-running the item with
`execution: 'TASK'`); it must not assume feed context. The event type is
unchanged, so `federation-relationship-task.handler.ts` keeps validating it.

## Reuse map

| Concern | Reused as-is | Adapted |
| --- | --- | --- |
| Thread shell + authority namespace | `ensureFederatedGroupRequestShellInTx` (`:115`) | — |
| Canonical pair mint | The authoritative invitation mint (`group-authored-membership-intent.service.ts:302`) extracted into a shared fragment | — |
| Side-A intent persist | `authoredIntentWriteSql` shape | **Mirror variant**: `profileRev`, `messageEndSeq`, `tombstoneEndSeq` become bound parameters taken from the event body. The shared fragment derives them from `GroupAccount` and the local thread tail (`authored-relationship-intent-sql.ts:21-44`), which is wrong on a mirror (no `GroupAccount` row; the coordinates are the origin's, not the local tail's). |
| Promotion of local `REQUESTED` | `publishAccepted` semantics of `applyRemoteIntentOnPairInTx` (`relationship-intent.service.ts:677-690`) | Recomposed inside the activation SQL |
| Sync-state initialization | `initializeRelationshipThreadStateInTx` semantics | Must reproduce the gap rules verbatim (below) |
| Client feed row | `ClientStateFeedService.writeInTx` compaction + `publishEffect` contract | — |
| Mismatch / kick write-back | `FederationReverseRevokeService.enqueueGroupInTx` | — |
| Ack-back | `writeMemberRelationshipIntentInTx` peer-publishing branch | — |

## Implementation constraints

1. **Mirror side-A intent variant.** See the reuse map: wire-carried
   `profileRev`/coordinates as bound parameters; never re-derive from
   `GroupAccount` or the local thread tail.
2. **Epoch rule on deactivation.** The composed REVOKE advances the thread
   authorization epoch only after the **last** active `GROUP_MEMBER` pair for
   that group deactivates
   ([aggregate rule](./business-aggregate-locking.md)); activation flips
   `authorizationEpoch`/`federationRoundsEnabled` with `setGroupPairActiveInTx`
   semantics. `deactivateAfterInTx` is the behavioral reference; do not lose
   the rule in SQL.
3. **Synchronization-state initialization.** Reproduce
   `federation-consumer-rounds.md` exactly: tail `E=0` no work; `E=1` forward
   only; `E>1` forward `(E-1,E]` plus reverse gap `[1,E-1]`; `0/0`
   initialization leaves both cursors at zero; epoch compare-and-set with
   `messageSeqOffset = L+1-S` reservation. Reuse the existing initializer's
   semantics rather than re-deriving them.
4. **Index updates in the same change.** Per the task index maintenance rule,
   update `REVOKE_USER_RELATIONSHIP`'s responsibility (add "respond to an
   unsupported remote acceptance") and record the mirror experiment's lock
   combination under the experiment section.
5. **Idempotency under replay.** Ack-back and write-back enqueue are
   transition-gated. Identical-body compaction suppresses item repeats; the
   acceptance confirmation remains the documented exception
   ([fan-out execution](./fan-out-execution.md)), so origin-side repeats of the
   ack-back are tolerated by design.
6. **Statement budget reporting.** Report application-issued SQL counts
   including transaction boundaries, per the standard.

## Divergences from the legacy consumer path

Both divergences are owner-approved and must survive review:

1. **ACK mismatch write-back.** Legacy records an unhonorable ACCEPTED
   silently (the `:776` branch only handles `shouldBeActive`, everything else
   falls through), leaving the origin believing the member joined. The applier
   enqueues the system REVOKED repair described above.
2. **No in-item system message on kick.** Legacy writes GROUP_LEFT and the
   departure watermark inside the item transaction (`:825-852`). The applier
   writes no system message; the GROUP_LEFT boundary and the
   `messageVisibleThroughSeq` watermark move to the `SYNC_GROUP_META` delta
   finalizer when the roster DEPART lands. Between intent application and meta
   synchronization the client sees the REVOKED relationship fact but not yet
   the boundary message; `AccountThreadState` rows are retained, so the
   finalizer can still write both when it runs.

## Verification

A PostgreSQL comparison suite in the style of the authoritative experiment
constructs the applier explicitly; schedulers stay stopped and production
branches stay routed. Coverage:

- every entry-state row of the three tables, including the dissolved/
  unknown-group permanent-error paths the consumer already enforces;
- activation: shell/pair mint, promotion, pair flags, `AccountThreadState`
  initialization, sync-state gap shapes for `E=0/1/>1`, epoch compare-and-set;
- mismatch: write-back enqueued once per real transition, suppressed on replay;
  origin-side convergence after the reverse task executes;
- kick: epoch advances only on the last local member; reverse revoke enqueued
  with `author: 'MEMBER'`; no system message rows written by the applier;
- rejection: side B preserved for re-application;
- lock order tests: group (authority domain) scope before Pair scope,
  peer allocator before client-feed allocator, waiting on a competing Pair lock;
- idempotency: replayed items, duplicate ACKs, repeat REVOKEs;
- statement counts reported, compared against the legacy branches.

## Out of scope

Registering providers or handlers, switching the consumer's production
branches, `SYNC_GROUP_META` / projection / system-message behavior, new event
types, and any authoritative-side change. The reverse-task handler entry and
production cutover remain separate reviews.
