# System messages

Status: implemented.

## Sender and event identity

Every system notification is a local `Message` with `contentType = SYSTEM`.
The existing message `creator` field is its sender, always
`{ account: '$system', domain: 'local', namespaceId: 0 }`. Do not add a second
`sender` field. This is the reserved disabled `Account.kind = SYSTEM` account,
which has no published profile. Notification rows use profile revision zero and
source namespace zero. They are never published as federation messages.

The sender says who delivers the notification. The content says what happened.
There is no generic `actor` or `subject` in notification content. In particular,
the sender cannot determine whether a participant is the current viewer.

Durable task `actorUserId` remains the business operator: a local user or the
system account for an automatic operation. A handler/worker executes the task;
it is not that actor. Relationship `intentAuthorUserId` identifies the direction
being changed and may differ from the operator. Task attribution is not copied
into system-message content. Event producers supply semantic participants instead.

## Closed event content

[The shared contract](../../shared/system-message-content.ts) defines a
validated discriminated union used by both backend and frontend. Addresses
contain exactly `account` and `domain`; local participants use `domain: local`
and remote participants retain their home domain. Internal user IDs are resolved
before content is persisted.

| Type                            | Content fields besides `type`                                 |
| ------------------------------- | ------------------------------------------------------------- |
| `FRIEND_ADDED`                  | None                                                          |
| `FRIEND_REMOVED`                | Required `initiator` address                                  |
| `GROUP_JOINED`                  | `member` address                                              |
| `GROUP_LEFT`                    | `member` address                                              |
| `GROUP_ADMIN_GRANTED`           | `member` address                                              |
| `GROUP_ADMIN_REVOKED`           | `member` address                                              |
| `GROUP_OWNER_TRANSFERRED`       | `previousOwner` and `newOwner` addresses                      |
| `MESSAGE_WITHDRAWN`             | `author` address                                              |
| `MESSAGES_MODERATED`            | Positive integer `count`                                      |
| `FEDERATION_NAMESPACE_ARCHIVED` | `domain`                                                      |
| `CALL_ENDED`                    | The independent [call-history content](local-call-history.md) |

Do not store viewer-relative `isSelf` or incoming/outgoing fields. Both local
endpoints read the same notification. The renderer compares the event's
`initiator`, `member`, `author`, or `caller` to the current account as appropriate.
A friendship removal always records its initiator. Local automatic operations
use `{ account: '$system', domain: 'local' }`; received federation revocations
use the remote relationship endpoint. There is no `reason` field and no attempt
to infer whether a remote human or remote automation caused the change. The
renderer uses the participant identity for viewer perspective; a local system
initiator uses neutral wording. Group departures describe the resulting absence.

## Rendering and profile resolution

Group participant names resolve with the current thread's `GROUP_MEMBER`
selector, independently of the system sender. Direct conversations use the
peer profile already selected by that thread. If a profile is unavailable,
empty, or no longer disclosed after a departure, the address remains visible:
local `account`, federated `account@domain`. No global account-name lookup and
no profile request for `$system` is needed.

[SystemRowComponent](../../web/src/app/components/message-cards/system-row/system-row.component.ts)
uses the shared parser and localized templates. Invalid content has a generic
localized fallback. Subscriptions to participant resolution are released when
rows are replaced or destroyed.

## Persistence and boundaries

[MessageService](../../src/message/message.service.ts) accepts typed event input
through one transactional system-message writer. Call history persists its
terminal snapshot with the same sender invariant. The database constraint
rejects a normal user as a SYSTEM sender, `$system` as an authored-message sender,
and nonzero system profile/source coordinates.

Departures commit the notification, history visibility boundary, and ordinary
plus directed account fanout atomically with the relationship transition. Group
directed fanout uses the event member; P2P directed fanout uses the relationship
endpoints, independently of its initiator. Best-effort roster notices
remain post-commit decorations and do not grant authorization.

Mirror group joins are observed from committed Group Meta deltas. An initial
`UPSERT` or an `UPSERT` following `DEPART` creates `GROUP_JOINED` for either a
local or remote member; repeated `UPSERT` profile/role updates do not. Full
snapshots establish a baseline without replaying historical joins. Mirror invite
acceptance defers its notification to this authoritative delta path.

The delta finalizer calls the existing transactional system-message writer,
which reuses `enqueueThreadFanoutInTx` to admit `FAN_OUT_THREAD_CONTENT`.
Notification rows, local fanout admission, and the committed meta cursor share
one transaction, so rollback and retries cannot leave a partial notification.

There is no legacy content conversion or compatibility decoder. Old generic
actor/subject payloads are rejected. The schema migration establishes the sender
invariant without translating historical event content; old content is outside
the supported contract. Database migration history remains append-only.
