# Durable task responsibilities and business locks

Status: current implementation inventory, checked on 2026-09-11 against
[DurableTaskType](../../src/durable-task/durable-task.constants.ts) and its execution
paths. This is a lookup index, not a claim that every existing task has already
adopted the [business mutation SQL pattern](./business-mutation-sql-pattern.md).

## How to read the lock column

The following names describe existing scopes; they are not new lock APIs.
The target terminology is **Account Meta Lock** for a user or group's own
metadata and **Relationship Pair Lock** for a relationship. Both use
transaction-scoped advisory locks. Existing group ACCOUNT scopes below protect
broader aggregate state and have not yet been narrowed to metadata-only use.

| Scope | Actual business lock |
| --- | --- |
| Group account | One transaction advisory lock for the group's `[domain, account]`. Local authority uses `local`; a mirrored group uses its authority domain. All members of that group share this scope. |
| User endpoints | Transaction advisory locks for both users' `[domain, account]`, deduplicated and sorted by canonical key. This is not a single pair-specific advisory lock. |
| Thread parents | `requireThreadContentLockInTx` resolves the thread: group account for a GROUP, both user endpoints for a bound P2P. It then locks the required pair/thread rows. An unbound P2P shell has no relationship parent yet. |
| None at execution | The task uses the row/allocator locks described in its row, without an ACCOUNT advisory business scope. Admission may have a different lock path. |

The ACCOUNT scope is encoded as:

```text
["business-scope", "ACCOUNT", domain.toLowerCase(), account]
```

[lockBusinessAccountsInTx](../../src/relationship/business-scope-lock.ts) applies
`pg_advisory_xact_lock(hashtextextended(key, 0))`. The lock lasts until the owning
transaction commits or rolls back. Paginated and asynchronous tasks reacquire
required locks for each database transaction; no lock is held across HTTP work.

A `DurableTask.scopeType`, `scopeKey`, or coalescing key controls scheduling and
admission. It is not, by itself, evidence of a PostgreSQL business lock.
`RelationshipPair`, `MessageThread`, `AccountThreadState`, task rows, and feed
allocators have additional row locks. Those are not separate business-lock classes.
Read-only/no-op paths may return before acquiring the mutation locks below.

## User relationship commands

| Task | Responsibility | Business scope during mutation | Execution reference |
| --- | --- | --- | --- |
| `SEND_LOCAL_RELATIONSHIP_REQUEST` | Author a local user's P2P request and publish its relationship effects. | User endpoints | [Handler](../../src/relationship/send-local-relationship-request-task.handler.ts), [relationship service](../../src/relationship/relationship.service.ts) |
| `ACCEPT_RELATIONSHIP_REQUEST` | Accept an incoming P2P request and update relationship activation and projections. | User endpoints | [Execution](../../src/relationship/relationship-request-task-execution.service.ts) |
| `REJECT_RELATIONSHIP_REQUEST` | Reject the incoming P2P direction and publish closure effects. | User endpoints | [Execution](../../src/relationship/relationship-request-task-execution.service.ts) |
| `REVOKE_RELATIONSHIP_REQUEST` | Revoke the actor's P2P request/direction. | User endpoints | [Execution](../../src/relationship/relationship-request-task-execution.service.ts) |
| `END_FRIENDSHIP` | End an established P2P relationship and retain the appropriate departure/read boundary. | User endpoints | [Handler](../../src/account-thread-state/end-friendship-task.handler.ts), [participant service](../../src/account-thread-state/account-thread-state.service.ts) |
| `SEND_FEDERATED_RELATIONSHIP_REQUEST` | Resolve an addressed peer user and author a federated P2P request. | User endpoints, including the peer user's authority domain | [Execution](../../src/federation/federated-relationship-request-task-execution.service.ts) |
| `ACCEPT_ADDRESSED_RELATIONSHIP_REQUEST` | Accept the request for an addressed federated P2P counterpart. | User endpoints | [Execution](../../src/federation/federated-relationship-request-task-execution.service.ts) |
| `REVOKE_ADDRESSED_RELATIONSHIP_REQUEST` | Revoke the actor's direction toward an addressed federated P2P counterpart. | User endpoints | [Execution](../../src/federation/federated-relationship-request-task-execution.service.ts) |
| `REVOKE_USER_RELATIONSHIP` | Dispatch user-authored closure: reject/revoke P2P, end friendship, withdraw a group request, leave a group, or respond to a remote revocation. | User endpoints for P2P; group account for group membership | [Handler and branch dispatch](../../src/relationship/revoke-user-relationship-task.handler.ts), [reverse revoke](../../src/federation/federation-reverse-revoke.service.ts) |

## Group commands

| Task | Responsibility | Business scope during mutation | Execution reference |
| --- | --- | --- | --- |
| `INVITE_GROUP_MEMBER` | Check invitation eligibility and author the group's invitation to the target member. | Group account | [Execution](../../src/group/group-invite-task-execution.service.ts) |
| `ACCEPT_GROUP_JOIN_REQUEST` | Validate manager and pending application; author the group ACK, activate membership, update Group Meta and immediate projections, and admit Meta head fanout. | Group account, shared across applicants | [Production handler](../../src/group/group-request-task.handlers.ts), [experimental transaction](../../src/business-v2/group/accept-join-request/group-join-decision.service.ts) |
| `REJECT_GROUP_JOIN_REQUEST` | Validate manager and application, then author the group-side rejection and its effects. | Group account | [Handlers](../../src/group/group-request-task.handlers.ts), [group service](../../src/group/group.service.ts) |
| `REVOKE_GROUP_INVITATION` | Validate manager and invitation, then revoke the group's invitation direction. | Group account | [Handlers](../../src/group/group-request-task.handlers.ts) |
| `ACCEPT_GROUP_INVITATION` | Accept a group invitation as the invited local user and fold membership. | Group account | [Handler](../../src/group/group-request-task.handlers.ts), [federation service](../../src/federation/federation.service.ts) |
| `LEAVE_GROUP` | Revoke the leaving user's member-side direction and update membership/departure state. | Group account | [Handlers](../../src/group/group-membership-task.handlers.ts) |
| `KICK_GROUP_MEMBER` | Validate the manager and revoke the group's direction toward the selected member. | Group account | [Handlers](../../src/group/group-membership-task.handlers.ts) |
| `TRANSFER_GROUP_OWNERSHIP` | Validate the current owner and target, then change canonical ownership roles. | Group account | [Handlers](../../src/group/group-membership-task.handlers.ts) |
| `SET_GROUP_MEMBER_ROLE` | Validate management authority and update the target's canonical group role. | Group account | [Handlers](../../src/group/group-membership-task.handlers.ts) |
| `REVOKE_GROUP_RELATIONSHIP` | Dispatch group-authored kick, request rejection, invitation revocation, or response to a remote revocation. | Group account | [Handler](../../src/relationship/revoke-group-relationship-task.handler.ts) |
| `DISBAND_GROUP` | Mark the group dissolved, then admit member-revocation children with a durable pair cursor. | Group account in each transaction | [Handler](../../src/group/disband-group-task.handler.ts), [child admission](../../src/group/group-revoke-fanout.service.ts) |
| `REVOKE_FORBIDDEN_GROUP` | Enumerate members for a captured group authorization denial and admit revocation children; does not itself declare the group dissolved. | Group account in each child-admission transaction | [Handler](../../src/group/revoke-forbidden-group-task.handler.ts), [child admission](../../src/group/group-revoke-fanout.service.ts) |
| `FORCE_REVOKE_GROUP_MEMBER` | Revoke one member after dissolution or a federation denial, respecting the applicable captured authorization epoch. | Group account | [Handler](../../src/group/force-revoke-group-member-task.handler.ts), [denial execution](../../src/federation/federation-thread-query-denial.service.ts) |
| `REQUEST_FEDERATED_GROUP_JOIN` | Resolve a remote group and author the local member's join request with its selected profile. | Remote group account | [Execution](../../src/federation/federated-group-task-execution.service.ts) |
| `REVOKE_FEDERATED_GROUP_JOIN` | Withdraw the local member's request/direction toward the remote group. | Remote group account | [Execution](../../src/federation/federated-group-task-execution.service.ts) |
| `ACCEPT_ADDRESSED_GROUP_INVITATION` | Accept an invitation identified by the remote group's address. | Remote group account | [Execution](../../src/federation/federated-group-task-execution.service.ts) |

## Federation application and projections

| Task | Responsibility | Business scope during execution | Execution reference |
| --- | --- | --- | --- |
| `APPLY_FEDERATED_RELATIONSHIP_INTENT` | Apply one received relationship intent and checkpoint its effects; discard application from a retired peer namespace. | User endpoints for P2P; group account for group membership. The `FederatedPeer` lifecycle row is fenced before business locks. | [Handler](../../src/federation/federation-relationship-task.handler.ts), [consumer](../../src/federation/federation-state-feed-consumer.service.ts) |
| `SYNC_GROUP_META` | Prepare asynchronous retrieval, apply remote Group Meta pages/recovery, and finalize the mirrored roster and local projections. Both handoff and async handlers use the same task type. | Remote group account for each prepare/apply/finalize transaction | [Handlers](../../src/federation/group-meta-sync-task.handlers.ts), [execution](../../src/federation/group-meta-sync-task-execution.service.ts) |
| `FAN_OUT_GROUP_META_HEAD` | Read the latest canonical group Meta head, enumerate audiences, and write each audience's state-feed Meta head reference and notification hints. Does not author the membership ACK or rewrite canonical Group Meta. | Group account for each projection page | [Execution](../../src/federation/group-projection-task-execution.service.ts) |
| `FAN_OUT_STATE_FEED` | Wake one local account or peer for already-persisted state-feed positions; does not generate group-wide Meta projections. | None at execution: lock the `Account` or `PeerStateFeedTarget` allocator and the task/admission rows | [Handler](../../src/state-feed/state-feed-fanout-task.handler.ts), [owner lock and coalescing](../../src/state-feed/state-feed-fanout-task.ts) |
| `FAN_OUT_THREAD_CONTENT` | Project committed message/deletion changes into active local recipients' thread feeds and read/unread/preview state, then issue SSE/push hints. | Thread parents for each projection batch | [Handler](../../src/message/thread-fanout-task.handler.ts), [progress service](../../src/message/thread-fanout-progress.service.ts) |
| `FAN_OUT_ACCOUNT_THREAD_CONTENT` | Project a thread-content change for one specified local account, including retained relationship and visibility checks. | Thread parents | [Handler](../../src/message/thread-fanout-task.handler.ts), [progress service](../../src/message/thread-fanout-progress.service.ts) |
| `FAN_OUT_FEDERATION_THREAD_CONTENT` | Project committed content heads toward federation audiences and schedule peer state-feed notifications. | Thread parents for each projection step | [Handler](../../src/federation/federation-thread-fanout-task.handler.ts) |
| `COMMIT_THREAD_READ_POSITION` | Apply an account's read intent, update read-related projections, and finalize the attention task atomically. | None at execution: current handler locks `MessageThread` directly with `FOR NO KEY UPDATE`, then task/projection rows. Admission uses thread-parent business locks. | [Execution](../../src/message/thread-feed.service.ts), [admission](../../src/message/thread-read-position.ts) |

## Current acceptance experiment

The fork under `src/business-v2/group/accept-join-request/` acquires both:

1. The existing group account scope:
   `["business-scope", "ACCOUNT", "local", groupAccount]`.
2. The new Pair scope:
   `["business-scope", "PAIR", kind, endpoint1, endpoint2]`, where each endpoint
   is a complete lowercase address (`account@domain`, e.g. `alice@local`) and
   the two addresses are sorted. Callers compose these final-form addresses from
   identities already in hand; the primitive performs no normalization,
   validation, or canonicalization lookup.

[The Pair primitive](../../src/business-v2/shared/locks/pair-business-lock.ts)
is confined to the new fork. Group scopes are acquired before Pair scopes, once
per transaction, followed by row/allocator locks. Both local and federated
applicants share the authoritative group's group lock and acquire their own
member Pair lock. The peer allocator row remains a separate lower-level lock.
The pending request already has a Pair row, so this path locks it without the
legacy insert/no-op threadId-update sequence.

The tables above describe production paths. Their existing lock behavior is not
changed by this fork. New Intent writers require a Relationship Pair Lock;
account metadata writes require an Account Meta Lock. When both apply, acquire
Account Meta Locks before Relationship Pair Locks. Do not infer metadata-lock
requirements merely from a group endpoint. Before narrowing an existing group
scope, preserve cross-Pair invariants and compatibility with legacy writers as
required by the business mutation standard.

After commit, the directed ACK wakes only the applicant peer through the existing
throttled notification path. Group-wide Meta projection remains the responsibility
of `FAN_OUT_GROUP_META_HEAD`, with `{ threadId }` and its existing initial cursor.

## Maintenance rule

When adding a task or changing its responsibility/locking path, update its row
here in the same change. Keep branch-specific scopes explicit. Do not infer locks
from task names, queue lanes, or a helper's `InTx` suffix. Link the execution path
that actually acquires the lock, including transitive domain helpers.

This inventory records current behavior, including the different read-position
admission/execution paths. It does not silently change those paths or certify
them as having adopted the new mutation pattern.
