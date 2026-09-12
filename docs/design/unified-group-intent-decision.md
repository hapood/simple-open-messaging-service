# Unified group intent decision

Status: owner-approved extension of the
[join decision experiment](./group-membership-intent.md). Production
handlers stay unchanged and no new handler is registered in this round. The
new service evolves from "join request decision" into a unified
group-authored intent decision family with three commands: **ACK**,
**REVOKE**, and **REQUESTED**. The same family now covers the user-authored
side (P2P pairs) — see [User intent family](#user-intent-family-p2p).

## Requirements

- ACK, REVOKE, and REQUESTED reuse one intent semantic; the entry state of the
  other side selects the branch. The authorization SQL determines the branch.
- REQUESTED (an invitation) arrives with the target address instead of a
  request id, because no intent may exist yet; the transaction mints the
  canonical pair when absent. `req + req/ack = ack`: a live application or an
  outstanding invitation collapses into the ACK path with the authorization
  row already in hand. Every other reverse state (none, REVOKED, expired)
  receives a fresh invitation; a rostered member and a dissolved group are
  silent no-ops — the dissolved check runs at the locator, before any write,
  so no pair is minted.
- ACK accepts both effective reverse states: side B `REQUESTED` (join
  application, today's path) and side B `ACCEPTED` (our invitation was acked by
  the invitee; we promote side A and run the same activation). Side B
  `REVOKED` is a silent no-op, matching the dissolved-group precedent.
- REVOKE does not distinguish rejecting an application from removing a
  membership. One group-authored side A `REVOKED` business covers both; the
  roster-presence fact (`currentMember`) returned by the authorization SQL
  gates the member effects. Kicking additionally requires an undissolved group
  and a strictly higher operator role (OWNER outranks ADMIN outranks MEMBER;
  the owner and same-rank managers — including the operator — are out of
  reach), while rejection and invitation cancellation stay available on a
  dissolved group. The reverse-task entry (after a member leaves and authors
  side B `REVOKED`) calls the same business with a system caller and bypasses
  the kick gates, so the dissolved-group fan-out can still depart members.
- ACK enforces the server capacity gate (`SERVER_MAX_GROUP_MEMBERS`) whenever
  the member's own pair is not already in the authorization set (side A
  `ACCEPTED`, or an unexpired group invitation). Rejections, cancellations,
  already-authorized completions, and idempotent no-ops stay exempt. This
  converges the legacy member-side enforcement points (`acceptGroupRequest`
  and the mirrored member-authored intent) onto the group-side activation.
  REQUESTED stays capacity-free, exactly like the legacy invite, so pending
  invitations may still overshoot the limit while actual membership cannot.
- ACK's composed business SQL is already the
  [pattern target](./business-mutation-sql-pattern.md)
  (`groupJoinAcceptanceSql` + admission + insert); this round changes only the
  authorization entry. REVOKE gets a new composed statement and, per owner
  decision, folds the system message, the thread-content fanout, the departure
  fanout, the meta-head admission, and the reverse task into it.

## Entry states

| Command   | Caller                | Side B state                        | Effect                                                                                                                |
| --------- | --------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| REQUESTED | manager               | none (no pair or intent)            | mint inactive pair, author side A `REQUESTED`                                                                         |
| REQUESTED | manager               | `REQUESTED` (unexpired)             | collapse into ACK: accept the application                                                                             |
| REQUESTED | manager               | `ACCEPTED` + outstanding invitation | collapse into ACK: complete the invitation                                                                            |
| REQUESTED | manager               | `REVOKED` or expired `REQUESTED`    | fresh invitation (side B untouched)                                                                                   |
| REQUESTED | manager               | on roster                           | silent no-op (checked before the collapse)                                                                            |
| ACK       | manager               | `REQUESTED` (unexpired)             | accept application (today's flow)                                                                                     |
| ACK       | manager               | `ACCEPTED`                          | promote side A, activate membership (invitation completion)                                                           |
| ACK       | manager               | `REVOKED`                           | silent no-op                                                                                                          |
| ACK       | manager               | rostered, side B `REQUESTED` stale  | `NOT_FOUND` — a duplicate approval of the application that created the membership is stale, not satisfied             |
| REVOKE    | manager               | `REQUESTED`, not on roster          | rejection shape: intent + pair + audience + projection + notify                                                       |
| REVOKE    | manager               | on roster                           | kick shape: rejection shape + member effects below; requires an undissolved group and a strictly higher operator role |
| REVOKE    | system (reverse task) | on roster                           | kick shape without manager authorization; bypasses the role and dissolved gates                                       |

## Kick-shape effect inventory

Everything below is what the legacy chain performs for an active→inactive
transition and must be reproduced by the composed REVOKE statement, gated on
`currentMember`:

1. Roster DEPART fact. Last feed entry per member decides (any operation,
   ordered by `feedId`): write `DEPART` with body `{}` only when the last
   entry is not already the same departure
   ([group-meta-feed.service.ts:133](../../src/federation/group-meta-feed.service.ts));
   allocate one `GroupMeta.metaEndId` for it.
2. GROUP_LEFT system message
   ([message.service.ts:507](../../src/message/message.service.ts)). Content is
   `{type:'GROUP_LEFT', member:{account,domain}}`
   ([system-message.ts:33](../../src/message/system-message.ts)). Effects:
   `curSeq` allocation on `MessageThread` (`RETURNING` also yields
   `tombstoneEndSeq`), one `Message` row (`creatorAccount
'$system'`, `contentType SYSTEM`), thread `updatedAt` touch, and the
   kicked local member's watermark
   `AccountThreadState.messageVisibleThroughSeq = seq`
   ([group.service.ts:1240](../../src/group/group.service.ts)).
3. Thread content fanout task: merge-or-insert
   `FAN_OUT_THREAD_CONTENT` (`scopeType THREAD`, payload
   `{threadId, messageEndSeq, tombstoneEndSeq}`); a PENDING row is merged with
   per-field `max`, never overwritten
   ([thread-fanout-task.ts:51](../../src/message/thread-fanout-task.ts)).
4. Departure fanout: one `FAN_OUT_ACCOUNT_THREAD_CONTENT` task per departing
   local member account
   ([account-thread-fanout-task.ts:46](../../src/message/account-thread-fanout-task.ts)).
   Remote targets have no local account and get none.
5. Group meta head admission: supersede PENDING `FAN_OUT_GROUP_META_HEAD`
   (same scope/coalescing contract as
   `admitGroupJoinFanoutInTx`), insert with checkpoint
   `{afterAudienceId:'0'}`; required by the DEPART fact.
6. Reverse task, local target only: `REVOKE_USER_RELATIONSHIP` with scope
   `{type:'GROUP', address}`, system actor, payload
   `{operation:'RESPOND_TO_REVOKE', threadId, memberUserId,
intentAuthorUserId}`
   ([reverse-revoke-task.ts:33](../../src/relationship/reverse-revoke-task.ts)).
   The remote member learns through the peer `RELATIONSHIP_INTENT REVOKED`
   write instead.
7. Pair deactivation only updates the pair row for an authoritative local
   group: the epoch/`federationRoundsEnabled` branch in
   `setLockedGroupPairActiveInTx` is gated on
   `group_profile.domain <> 'local'` and never fires here.
8. Audience close: local member row deleted unconditionally on inactive;
   federated audience closed only when no other active `GROUP_MEMBER` pair
   shares the domain
   ([authoritative-group-membership-finalizer.service.ts:103](../../src/federation/authoritative-group-membership-finalizer.service.ts)).

## Composed REVOKE statement

Single statement, CTE dependencies via `RETURNING` and `CROSS JOIN` barriers;
`currentMember` and the authorization results are bound inputs:

`authored_intent` (shared fragment, REVOKED) → `pair_change` →
`member_state` (lateral last feed entry) → `depart_alloc` + `depart_fact` →
`seq_alloc` → `system_message` → `member_watermark` → `thread_touch` →
`thread_fanout_merge` + `thread_fanout_insert` → `departure_task` →
`meta_admission_supersede` + `meta_admission_insert` → `reverse_task` →
`request_projection` (shared fragment, REVOKED) → `audience_close` →
recipient write (local dedupe pattern / single peer event) → result SELECT.

## Composed REQUESTED statement

Single statement (`groupIntentRequestSql`), same fallback discipline as
REVOKE: `authored` (shared fragment, REQUESTED with note and the seven-day
expiry) → `request_state` (UNION ALL read-back) → `projection_alloc` (advance
`GroupMeta.invitationEndId`, the invitation number stream) →
`request_projection` (upsert one INVITATION row per manager, all sharing the
group's event number) → invitee recipient (local dedupe / single peer event) →
`audience_open` (remote only, history-setting floor) → result SELECT. It
writes no roster fact, no system message, and no meta-head task; membership
effects wait for the invitee's ack and the completion ACK. The projection
fan-out task (`FAN_OUT_GROUP_PROJECTION`, insert-then-supersede with the
`afterManagerId` checkpoint) is admitted when manager rows changed; only the
invitee receives one post-commit in-process wake, and the per-manager
notification is the task's job. Manager cosmetic feed rows
(GROUP_JOIN_REQUEST_HEAD, PROFILE) stay with the reconcile path, matching the
decision-time flip-only doctrine. The executor advances each manager's two
per-direction watermarks (`joinRequestEndFeedId` from `applicationEndId`,
`groupInviteEndFeedId` from `invitationEndId`); either column moving rides the
thread-feed trigger like read/head updates, and the per-column forward-only
guard publishes only a bigger id over a smaller one.

## Preserved asymmetries

- Rejection keeps side B at `REQUESTED` so re-application works through the
  existing prior-side-A gate; only kick/leave revokes both sides (via the
  reverse task).
- The legacy invite's friendship precondition (`FRIEND_NOT_FOUND` when the
  target shares no P2P thread with the inviter) is deliberately dropped:
  invitations carry manager authorization only (owner-approved deviation).
- The manager projection flip uses the shared `managerProjections` fragment
  parameterized by status; the member's projection rows flip for the direction
  they were written under, guarded by `status IS DISTINCT FROM 'REVOKED'`.
- `authoredIntentWriteSql` already implements the REVOKED semantics (preserve
  revoked heads, keep `requestedAt`, idempotent guard).

## Statement budget

Lock preamble (unchanged) + 1 authorization + 1 composed statement. Measured
on 2026-09-11 (35 tests passing), grouped by command:

- **ACK** — accept a local applicant 15, a remote applicant 18, complete an
  acked invitation 15.
- **REVOKE** — reject a local applicant 13, kick a local member 13, kick a
  remote member 15.
- **REQUESTED** — invite a fresh local member 15, a fresh remote member 17,
  collapse into ACK (pending application or outstanding invitation) 15.

## Verification

The comparison suite covers: kick of a local rostered member (system message,
watermark, DEPART fact, meta-head admission with checkpoint, thread-content
merge, departure fanout, reverse task), kick of a remote rostered member (peer
REVOKED event, audience close, no reverse/departure tasks), ACK completing an
invitation whose invitee already acked (side A promotion preserving the
invitation note, activation), ACK on a withdrawn application as a silent
no-op, and the previous acceptance/rejection scenarios unchanged. The
REQUESTED scenarios add: collapse of a pending application and of an
outstanding invitation, a fresh local invitation (pair mint, projection row
with the group's number, invitee feed, projection-fanout admission, lock
order), a fresh remote invitation (peer event, audience open, wake), a
re-invite after withdrawal, and the rostered-member, stranger, and dissolved
no-ops. Statement counts are reported, not asserted absolutely.

The gates added with the capacity work are covered by: an administrator may
only remove members strictly below their role (removing the owner, a peer
manager, or themselves is forbidden; the owner may remove an administrator),
rejection still applies on a dissolved group while removing a rostered member
there is forbidden, and acceptance rejects at the server capacity limit while
completing an already-authorized invitation succeeds at the limit.

## User intent family (P2P)

The same experiment shape now covers the user-authored side:
[UserIntentService](../../src/business/user/p2p-intent/user-intent.service.ts)
(`execute({userId, decision, target, note?})`), unregistered like the
group command family. A P2P pair is the identical `RelationshipPair` state machine — the
actor authors **their own canonical side** instead of a fixed side A, and the
reverse side's state selects the branch:

| Command | Reverse state | Effect |
| --- | --- | --- |
| REQUESTED | live (REQUESTED unexpired or ACCEPTED) | collapse into ACK (`req + req/ack = ack`; crossed requests re-friend) |
| REQUESTED | none / REVOKED / expired | fresh or refreshed request: thread shell + intent (7d TTL) + recipient feeds; no activation |
| ACCEPTED | pair already active | silent no-op |
| ACCEPTED | REQUESTED unexpired | own ACCEPTED + local-peer reverse upgrade + activation |
| ACCEPTED | ACCEPTED (our withdrawal left their confirmation) | complete the activation |
| ACCEPTED | none / REVOKED / expired | `NOT_FOUND` |
| REVOKED | anything live on either side | own REVOKED; departure effects gate on the pair transition |
| REVOKED | nothing live | `NOT_FOUND` |

Activation effects: audiences (local rows for both endpoints, remote row with
the history-setting floor), read windows (own statement — see below),
FRIEND_ADDED, thread fan-out admission. Deactivation effects (kick shape):
FRIEND_REMOVED with initiator, both endpoints' watermarks, audience close,
epoch bump with `federationRoundsEnabled=false`, thread + per-endpoint
departure fan-outs, and the local peer's `REVOKE_USER_RELATIONSHIP` reverse
task (`USER_PAIR` scope, `intentAuthorUserId` = the peer, `targetUserId` = the
revoker's address). Remote acceptance additionally calls the existing
`initializeRelationshipThreadStateInTx` (gap recovery included) inside the
transaction; composing that subsystem was out of proportion.

Lock order: both endpoint ACCOUNT scopes → the implementational P2P Pair scope →
pair row (mint-if-absent for REQUESTED, else lock) → thread shell mint →
thread content lock → intent rows → one post-lock authorization statement →
participant reset/lock → Account row locks → peer target lock.

PostgreSQL constraints this family documents for both command families:

- **One update per row per statement.** Two data-modifying CTEs that update
  the same row silently apply only one of them (it is not predictable which),
  and a BEFORE-trigger write to a row a CTE already wrote (either order)
  raises `27000`. The thread's head allocation, touch, epoch, and round flag
  therefore share one CTE (`seq_alloc`), and read windows live in their own
  preamble statement because the participant trigger writes the same `Account`
  rows as the statement's feed allocation. The group REVOKE had the same
  latent double-write (`seq_alloc` + `thread_touch`) and was fixed the same
  way.
- Sibling CTEs cannot see one another's base-table writes: every published
  body derives the authored direction from the statement's `UNION ALL`
  read-back, never from the base table.

Measured 2026-09-12 (12 tests passing): REQUESTED local 15 (baseline 97),
ACCEPTED 14 (baseline 170), REVOKED 14 (baseline 72), REQ+REQ collapse 14,
re-request after withdrawal 14, REQUESTED remote 18. Coverage: fresh local and
remote requests (shell-only effects; peer feed body with the thread head
snapshot), acceptance vs baseline, crossed-request collapse with note
preservation, active-pair no-op, stale `NOT_FOUND`, pending withdraw and
incoming reject through one revocation, the full departure effect set
(watermarks, epoch, audience close, thread/departure fan-outs, reverse task,
sticky `established`), re-friend after withdrawal, lock order
(`[actor scope, target scope, pair scope]`), and late-failure rollback.

## Out of scope

Registering handlers, switching production kick/leave/reject flows, and the
reverse-task handler entry remain separate changes.
