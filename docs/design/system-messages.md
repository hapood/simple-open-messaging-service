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
validated discriminated union used by both backend and frontend. Each participant has exactly `account`, `domain`, `namespaceId`, and
`profileRev`. Local identities use `domain: local`, `namespaceId: 0`;
remote identities retain their home domain and participant namespace. The
writer captures revisions at the event boundary; internal user IDs are not
persisted in event content.

| Type                      | Content fields besides `type`                                 |
| ------------------------- | ------------------------------------------------------------- |
| `FRIEND_ADDED`            | Required `participants` pair                                  |
| `FRIEND_REMOVED`          | Required `initiator` and `participants` pair                  |
| `GROUP_CREATED`           | `creator` address                                             |
| `GROUP_JOINED`            | `member` address                                              |
| `GROUP_LEFT`              | `member` address                                              |
| `GROUP_DISSOLVED`         | None                                                          |
| `GROUP_ADMIN_GRANTED`     | `member` address                                              |
| `GROUP_ADMIN_REVOKED`     | `member` address                                              |
| `GROUP_OWNER_TRANSFERRED` | `previousOwner` and `newOwner` addresses                      |
| `CALL_ENDED`              | The independent [call-history content](local-call-history.md) |

Do not store viewer-relative `isSelf` or incoming/outgoing fields. Both local
endpoints read the same notification. The renderer compares the event's
`initiator`, `creator`, `member`, or `caller` to the current account as appropriate.
A friendship removal always records its initiator. Local automatic operations
use `{ account: '$system', domain: 'local', namespaceId: 0, profileRev: 0 }`; received federation revocations
use the remote relationship endpoint. There is no `reason` field and no attempt
to infer whether a remote human or remote automation caused the change. The
renderer uses the participant identity for viewer perspective; a local system
initiator uses neutral wording. Group departures describe the resulting absence.

## Rendering and profile resolution

Participant names are read from local cached profiles selected by each event's
identity and revision; rows never search the current roster by address. Authorized
join and friendship activation events may resolve event evidence, while departures
only use committed local snapshots. Local P2P aliases override those names where
applicable. If a profile is unavailable, empty, or no longer disclosed, the address remains visible:
local `account`, federated `account@domain`. No global account-name lookup and
no profile request for `$system` is needed.

[SystemRowComponent](../../web/src/app/components/message-cards/system-row/system-row.component.ts)
uses the shared parser and localized templates. Invalid content has a generic
localized fallback. Profile-cache subscriptions are released when rows are replaced
or destroyed.

## Persistence and boundaries

[MessageService](../../src/message/message.service.ts) accepts typed event input
through one transactional system-message writer. Call history persists its
terminal snapshot with the same sender invariant. The database constraint
rejects a normal user as a SYSTEM sender, `$system` as an authored-message sender,
and nonzero system profile/source coordinates.

Authoritative-group departures commit the notification, history visibility
boundary, and ordinary plus directed account fanout atomically with the
relationship transition. Group directed fanout uses the event member; P2P
directed fanout uses the relationship endpoints, independently of its initiator.
Group Meta is the authoritative group's roster projection, not its membership
truth. An active-to-inactive pair transition produces the authoritative
`GROUP_LEFT`; an inactive-to-active transition produces `GROUP_JOINED`.

Mirror group joins and third-party departures are triggered by committed Group
Meta deltas. An initial `MEMBER_UPSERT` or a `MEMBER_UPSERT` following `MEMBER_DEPART` creates
`GROUP_JOINED` for either a local or remote member; repeated `MEMBER_UPSERT`
profile/role updates do not. Full
snapshots establish a baseline without replaying historical joins. Mirror invite
acceptance does not mint a notice from the intent. If the accepted member first
appears in a full snapshot, that snapshot establishes the member as baseline
without a join notice; a later delta join can mint one. The mirror stores
relationships only between its local members and the group. A local member's
delta join requires its pair to be active. Its `GROUP_LEFT` is written in the
transaction that changes its relationship pair from active to inactive while
authoring or consuming a `REVOKED` intent. That transaction sets the departing
member's readable boundary through the notice and admits ordinary and directed
account fan-out. A later Meta `MEMBER_DEPART` updates the replica fact without replaying
the local notice. Other members' Meta items describe their departures; active
local pairs determine who can observe them.

The delta finalizer calls the existing transactional system-message writer,
which reuses `enqueueThreadFanoutInTx` to admit `FAN_OUT_THREAD_CONTENT`.
Notification rows, local fanout admission, and the committed meta cursor share
one transaction, so rollback and retries cannot leave a partial notification.

There is no legacy content conversion or compatibility decoder. Old generic
actor/subject payloads are rejected. The schema migration establishes the sender
invariant without translating historical event content; old content is outside
the supported contract. Database migration history remains append-only.

## Participant profile selection

The implemented content contract gives every displayed participant `account`, `domain`,
`namespaceId`, and `profileRev`. Revision zero means no available profile;
`$system@local` has namespace and revision zero. A group member's namespace
comes from that member's identity, not necessarily the group's authority
namespace. The same four-tuple is already used by authored messages.

P2P friendship transitions now write both endpoint identities and their
relationship-intent revisions. The viewer chooses the other endpoint for its
label; a local conversation alias also takes precedence in message avatars.
A removal retains its initiator solely to select the localized perspective. Call history captures both caller and callee
identities with their namespaces, but writes `profileRev: 0` for both: call
notices do not disclose or request participant profiles. Event content is written
with the relationship or roster transition, not inferred later from the current roster.

The presentation layer reads committed local snapshots using the event's
four-tuple. A join or friendship activation may resolve its authorized event
evidence; a departure does not ask the departed relationship for new profile
data. When authorized Group Meta resolution returns a different revision, the
runtime retains the actual profile and the client corrects **only the invoking
local system-message row's** participant revision. Neither the server message
nor other historical system rows are rewritten. A later cache refill of the
same row preserves this correction; a different body or tombstone does not.
The parser rejects old address-only payloads; there is no historical conversion.
