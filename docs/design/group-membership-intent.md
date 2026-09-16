# Group membership intent architecture

Status: current business-layer architecture and federation receive behavior.
The normative directed-intent state machine is defined by
[Federation v1 State Feed](../../spec/v1/state-feed.md). This document describes
the local implementation and does not extend the wire protocol.

## Scope and ownership

Every group/member relationship is one `GROUP_MEMBER` pair with two independently
authored directions:

```text
side A: group  -> member
side B: member -> group
```

The group origin owns side A and canonical Group Meta. The member's home owns
side B. A mirror stores received side A, its local member's authored side B,
and derived local projections; it never becomes roster authority.

The implementation is split by authorship and ingress:

- `authored/group-authored-membership-intent.service.ts` handles invitation,
  application decision, invitation cancellation, and kick for an authoritative
  local group.
- `authored/member-authored-group-membership-intent.service.ts` handles apply,
  invitation acceptance/decline, withdrawal, and leave for a local member.
- `received/remote-member-membership-intent.service.ts` applies a peer member's
  side B to an authoritative local group.
- `received/mirror-group-membership-intent.service.ts` applies a peer group's
  side A to a local mirror.
- `shared/` owns composed acceptance/revocation SQL, pair state, projection
  fan-out, and pair minting used by more than one side.

Files under `authored/` may author only a locally owned direction. Files under
`received/` validate and persist a peer-owned wire snapshot; they must not
relabel it as local authorship. Shared SQL accepts an explicit received-writer
fragment only at that boundary.

## Command result contract

Authored command entries return a discriminated result:

| Status     | Meaning                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `APPLIED`  | The requested transition and all atomic side effects committed.                                                           |
| `NO_OP`    | The requested end state was already satisfied. A stable reason identifies the idempotent branch.                          |
| `REJECTED` | An expected business condition refused the command. The result carries a stable reason, `BusinessCode`, and safe message. |

Missing or expired intents, missing targets, a dissolved group, capacity, and
role authorization are `REJECTED`; they do not throw. HTTP handlers serialize
this as the existing HTTP-200 business envelope. Durable-task handlers return
it to the scheduler, which persists `REJECTED + resultCode`.

Throws are reserved for malformed or unauthorized federation input and
implementation failures that make continuation unsafe: a lost lock capability,
a protected row disappearing, invalid internal identity/namespace data,
conflicting immutable heads, or database/transport failure. A durable task maps
those unexpected exceptions to `FAILED`.

Received feed entries return a routing result instead. Ordinary divergence is a
route (`mismatch`, `rejection`, `conclusion`, or `noop:*`), so a valid but stale
peer item cannot freeze the namespace cursor. Invalid wire items use
`InvalidReceivedIntentError` and are handled by the consumer's permanent-item
policy.

## Entry-state rules

An effective request is `REQUESTED` with `expiresAt > now`; `ACCEPTED` remains
effective until its author revokes it.

| Input                | Relevant reverse/local state                 | Result                                                                                                                         |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `REQUESTED`          | no effective opposite direction              | write or refresh the request                                                                                                   |
| `REQUESTED`          | effective opposite `REQUESTED` or `ACCEPTED` | collapse through acceptance                                                                                                    |
| `ACCEPTED`           | matching effective request                   | activate or complete membership                                                                                                |
| `ACCEPTED`           | no matching effective request                | authored command: `REJECTED`; received item: persist mismatch as required and enqueue the locally authored negative conclusion |
| `REVOKED`            | active relationship pair                     | deactivate, publish departure effects, and conclude the opposite authored direction when required                              |
| `REVOKED`            | live pending request                         | reject, decline, or withdraw without departure effects                                                                         |
| any positive command | dissolved authoritative group                | `REJECTED/GROUP_DISSOLVED`                                                                                                     |

A dissolved mirror is recoverable local state, not authority. A successfully
authored local-member `REQUESTED` or `ACCEPTED` clears the mirror dissolution
marker and resumes federation rounds. Dissolution of a locally authoritative
group is permanent and every positive command remains rejected.

The capacity gate applies only when a command would add a new authorized member
or outstanding invitation. Existing capacity-set membership retains its slot.
Manager removal requires strict role outranking: owner outranks admin, admin
outranks member, and peers never outrank one another.

## Received mismatch and conclusion

A peer `ACCEPTED` that cannot be honored is an expected convergence case, not
an exception. The receiver persists the peer-authored fact and, on a real local
transition, authors the required local `REVOKED` conclusion in the same business
transaction. Replays do not duplicate the conclusion.

A peer `REVOKED` against an active pair performs the departure boundary and
authors the receiver-owned opposite revoke. Against a pending request or a
dangling local `ACCEPTED`, it also concludes the receiver-owned positive
direction as `REVOKED`; pair-transition-gated departure effects remain off.
The author can later publish a new `REQUESTED` revision to reapply.

The received direction is never published as the receiver's own direction.
For example, a remote member's application creates only member-authored side B
on the group origin. Withdrawal updates that side-B mirror without creating or
publishing side A. If the origin has already authored an effective side-A
invitation or acceptance, it separately concludes and publishes side A as
`REVOKED`. Only an active-to-inactive pair transition produces departure effects.

On either ingress, a late peer `ACCEPTED` after the local direction is already
`REVOKED` and the pair is inactive retains the peer-authored snapshot but is
`noop:dropped-ack` for membership and local authorship. The existing local
revoke remains at its original feed coordinate; the ACK does not publish it
again.

For P2P, a received `ACCEPTED` against an already locally authored `REVOKED` is
`noop:dropped-ack`. The already-persisted authored `REVOKED` feed item remains
the convergence source; the ACK does not reindex or resend it.

## Transaction and lock shape

Each command owns one outer transaction. Locks follow the global order from
[Business mutation SQL pattern](./business-mutation-sql-pattern.md):

```text
Account State -> Relationship Pair -> Thread Content -> row/allocator locks
```

The pre-lock locator names scopes only. Mutable authorization and state are
re-read after the locks. Account and pair advisory keys use complete normalized
addresses. The pair lock protects both intents and pair-derived state; an
account lock is acquired only for account-owned state that the command mutates.

The composed statement makes authored intent, pair activation, roster/meta,
audience, system message, projections, client/peer feed rows, and task admission
atomic. SQL CTE order is expressed by data dependencies and `RETURNING`, never
by textual position. A missing result row after validated locks is an invariant
failure.

## Projection and wake ownership

- A local recipient feed row is written in the business transaction and woken
  directly after commit.
- A peer relationship-intent row is written in the same transaction; the peer
  domain is returned for a post-commit wake.
- Manager application/invitation projections use the durable membership
  projection fan-out. Its executor advances direction watermarks and owns the
  manager wake.
- Roster/meta changes admit normal thread-content fan-out. A mirror never
  republishes origin-owned Group Meta.
- Best-effort wake failure never rolls back committed state; durable feed heads
  remain discoverable on reconnect.

## Mirror dissolution

An origin denial can terminate a mirror without a final Group Meta page. The
mirror disband parent records `groupDissolvedAt`, disables federation rounds,
and advances the authorization epoch. A durable pair-cursor sweep then revokes
each still-active local member, writes the local `GROUP_LEFT` boundary and
client projection, and performs no Group Meta or peer-intent publication.
Repeated parent and child execution is idempotent.

## Verification

PostgreSQL-backed suites cover authored and received directions, crossed
requests, expiry, capacity, dissolution, role gates, rollback, replay,
concurrent pair mutation, mirror mismatch/conclusion, projection fan-out, and
local/remote wake ownership. Lock-order tests verify that a waiter re-reads
state after acquiring the pair lock. Protocol documentation tests keep the
wire schema and normative state machine aligned.
