# P2P user intent: production switch

Status: steps 1 landed on `dev`; the federated/addressed de-tasking (former
step 1 of this list) is complete in the working tree. The user-authored side of
the [unified intent family](./unified-group-intent-decision.md)
(`UserIntentService`) is now the production write path for **all** P2P
relationship intents — local and addressed/federated — driven synchronously by
the HTTP controller.

## What switched

`POST /relationship/request|accept|revoke` P2P branches call
`execute({userId, decision, target, note?})` directly. The durable-task
indirection is gone for this family: `SEND_LOCAL_RELATIONSHIP_REQUEST`,
`ACCEPT_RELATIONSHIP_REQUEST`, `SEND_FEDERATED_RELATIONSHIP_REQUEST` and
`ACCEPT_ADDRESSED_RELATIONSHIP_REQUEST` (types, handlers, specs) are deleted,
and `REVOKE_USER_RELATIONSHIP` lost its user-admission enqueue sites — the task
type survives for the system-attributed `RESPOND_TO_REVOKE` reverse tasks and
the `!`-group scope.

Contract deltas, chosen to keep the client surface stable:

- Request/accept responses: `{status:'OK', threadId?}`. `threadId` is present
  only when the pair is active after the command (fresh acceptance, its no-op
  on an already-active pair, and the REQ+REQ collapse). The web client reads
  exactly this field to flip to FRIEND
  (`friend-invite-dialog.component.ts`), so a satisfied no-op must be
  indistinguishable from a fresh activation — idempotent success.
- Quota admission moved into the intent transaction via the service's optional
  `admissionInTx` hook — the legacy tick slot, so a rollback also rolls the
  tick back. The `disabledAt` admission check (admin disable is independent of
  `availability`) moved to the controller through
  `UserService.findRelationshipAdmissionAccounts`.
- Stale revocations keep the legacy client-facing code: the controller maps the
  family's generic `NOT_FOUND` onto `FRIEND_NOT_FOUND`. The async-only
  `INVITE_*` codes died with the task layer (clients never saw them).
- `expectedAuthorizationEpoch` revocation fences are dropped with `endP2P`'s
  task entry: no production enqueue site ever carried one.

Provider wiring: the service takes a single dependencies object, so AppModule
wires it as a factory — AppModule is the one scope holding every dependency
without a module cycle (`FederationModule` imports `RelationshipModule`).

## Coexistence surface (deliberate)

| Artifact the business service emits                            | Consumer                                                          | State                      |
| -------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------- |
| `FAN_OUT_THREAD_CONTENT`, `FAN_OUT_ACCOUNT_THREAD_CONTENT`     | shared executors                                                  | unchanged                  |
| `REVOKE_USER_RELATIONSHIP` (`RESPOND_TO_REVOKE`, system actor) | `FederationReverseRevokeService` → legacy `writeP2PIntentInTx`    | stays legacy               |
| `ClientStateFeed` `RELATIONSHIP_INTENT` rows                   | `GET /user/state-feed`, read watermark                            | unchanged                  |
| `PeerStateFeed` `RELATIONSHIP_INTENT` items                    | peer `GET /s2s/v1/state-feed` → legacy `applyRemoteP2PIntentInTx` | inbound apply stays legacy |
| wakes (`notifyFeedUpdates`, `pushStateFeedDomains`)            | SSE + state-feed push scheduler                                   | unchanged                  |

## Remaining steps

1. **Inbound apply migration.** `applyRemoteP2PIntentInTx` (peer
   `RELATIONSHIP_INTENT` application) and the reverse-task handler entry
   (`RESPOND_TO_REVOKE` → `REVOKED` as system actor) move onto the intent family.
   This is the last writer duality; migration removes the legacy writer rather
   than retaining a compatibility path.
3. **Dead-code cleanup.** `REJECT_RELATIONSHIP_REQUEST`,
   `REVOKE_RELATIONSHIP_REQUEST`, `REVOKE_ADDRESSED_RELATIONSHIP_REQUEST` and
   `END_FRIENDSHIP` have no enqueue sites left (handlers + constants +
   `USER_PAIR` coalescing cases). When the constants go,
   `test/durable-task-queue.e2e-spec.ts` and `test/system-account.e2e-spec.ts`
   — which use them as sample coalescing types, not flow tests — need one more
   re-point. Legacy service paths
   (`createRelationshipRequest`/`acceptRelationshipRequest`/`reject`/`revoke`/
   `endP2P`/`writeLocalP2PIntentInTx`) retire with step 1.
3. **Verification.** Point `dev/federation-lab/p2p/random-execute` at a mixed
   build (new authoring, legacy inbound apply) before step 1; the three-node
   `RelationshipPair.active` oracle is the coexistence proof. The business e2e suite
   (`test/user-intent-decision-experiment.e2e-spec.ts`) owns flow semantics;
   legacy HTTP-level specs were deleted under their semantics-porting audit.

## Test-suite migration state

The synchronous contract removed `taskId` from every P2P response, so the
shared helpers and the specs that drove P2P flows through them were re-pointed:

- `test/durable-task-helpers.ts`: `waitForLocalRelationshipRequest` takes the
  response body, waits only when a `taskId` is still present, and asserts the
  synchronous `{status:'OK'}` shape otherwise.
- Federation specs assert the synchronous response and keep their
  `vi.waitFor` blocks for cross-server convergence (delivery is now the peer
  state-feed pull, not a task on the answering server).
- Because the composed revocation revokes both directions in one statement,
  the initiator side no longer enqueues a `RESPOND_TO_REVOKE` ack when the
  peer's reverse lands — convergence, not another task.
  `test/federation-address-friend.e2e-spec.ts` asserts that outcome.
- Group-addressed branches (`!`-accounts) keep the durable-task contract and
  their `waitForAcceptedDurableTask` waits.
