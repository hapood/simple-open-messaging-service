# Canonical Group Meta and Asymmetric Mirrors

## 1. Scope

This document defines the implementation architecture for the canonical Group
Meta protocol. It deliberately separates protocol-visible requirements from
local storage and scheduling choices:

- the federation protocol is defined only under `spec/v1`;
- this document defines the backend, client, database, and durable-task design;
- table and task names are implementation details and do not appear on the
  federation wire.

The central rule is asymmetric authority over a shared storage shape. A locally
hosted group authors one canonical Group Meta feed. A remote-group mirror stores
one validated replica of that feed and never authors items in it. No
`ThreadMember` table is retained.

## 2. Ownership matrix

| State                            | Group origin                           | Group mirror                               | Local client                                         |
| -------------------------------- | -------------------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| Relationship authorization       | Authoritative local intents and pair   | Authenticated mirror of authored intents   | Device projection only                               |
| Current group roster             | Canonical Group Meta latest operations | Replica Group Meta latest operations       | Local current-member rows                            |
| Group Meta history               | Canonical append log                   | One group-scoped replica and remote cursor | None                                                 |
| Member role                      | Current canonical `UPSERT`             | Current replica `UPSERT`                   | Current member role                                  |
| Initial member profile reference | Current canonical `UPSERT.profileRev`  | Current replica `UPSERT.profileRev`        | Current member `profileRev`                          |
| Later message-selected profile   | Immutable `Message.profileRev`         | Immutable `Message.profileRev`             | May replace that member's displayed revision locally |
| Group-member profile authority   | Retained group-scoped snapshot         | Requests and caches from origin            | Requests through its local backend                   |

The mirror's latest replicated operation is its replaceable current-state
projection, but is not local authorization proof. A client member row has a
current-only lifecycle and is physically removed by `DEPART`. Historical
message rendering uses the immutable message author Address and
`Message.profileRev`, not a retained roster row.

An origin serves local clients from the canonical log. A mirror retains each
validated remote page once in its group-scoped replica so all local accounts
share the same rows and remote coordinates. Per-account state contains only a
compacted head and device cursor; it never copies member-feed rows. The replica
can be rebuilt by a full Group Meta synchronization.

## 3. Canonical Group Meta storage

Every group has one feed record and one ordered coordinate space. The origin
authors it; a mirror stores the received coordinates:

```text
GroupMetaFeed(groupId)
  feedEndId

GroupMetaMemberFeed(groupId, feedId)
  member identity
  operation = UPSERT | DEPART
  body = { role, profileRev } | {}
  fullSyncRunId = null | local mirror bookkeeping

GroupMetaProfileFeed(groupId)
  compacted feedId and profileRev
  fullSyncRunId = null | local mirror bookkeeping
```

`fullSyncRunId` is local mirror bookkeeping and never appears on the federation
or client wire. On an origin, `feedEndId` is the last allocated canonical
coordinate. On a mirror, it is the last completely applied fixed-through round
cursor. In-progress page position and the target `through` live in the durable
task checkpoint and payload instead of the feed row.

The implementation must remove target peer identity from canonical member and
profile feed keys. On the authoritative server, `ThreadAudience` remains the
current delivery projection and stores the Group Meta delta visibility boundary
required by the protocol. A mirror creates no `ThreadAudience`; its local
accounts are represented by `AccountThreadState`, while directional intents
remain the passive-query authorization facts. A separate per-peer roster
allocator is not retained.

Current membership is the latest member operation by stable source identity:

```text
latest operation is UPSERT -> current member
latest operation is DEPART -> not a current member
```

Point membership and role checks use the stable-member/feed index and newest
row. Full roster reads select the newest operation for every stable member and
retain only `UPSERT`. Normal group mutations already serialize on the canonical
group lock, so ownership checks and feed allocation observe one roster state.

The append log is both the origin's roster authority and its federation feed.
The same tables hold a remote group's non-authoritative replica. Locality
determines whether this server may append original operations: an origin may
author; a mirror may only validate and persist received operations. Adding a
separate current-roster table on either side would reintroduce two roster
representations and is prohibited.

## 4. Authoritative mutation state machines

### 4.0 Group creation

```text
create the local Group, MessageThread, and immutable group ProfileVersion rev 1
write the group-authored REQUESTED relationship intent
write the member-authored ACCEPTED intent with the owner's current profileRev
append GROUP_PROFILE { profileRev: 1 }
append the first member UPSERT { role: OWNER, profileRev: member intent rev }
materialize the local AccountThreadState and ThreadAudience
enqueue FAN_OUT_GROUP_META_HEAD
write the final group-authored ACCEPTED intent
commit
```

Group creation does not insert a separate roster row. `initialRole=OWNER` is a
creation-only input to the membership fold and applies only when no current
canonical member fact exists. It never promotes an existing member or replaces
that member's retained role. The owner profile reference comes from the
member-authored intent, not from a second read of `User.defaultProfileRev`.

### 4.1 Membership entry

```text
lock the group aggregate
fold the two relationship-intent directions
if membership did not become active: stop without Group Meta work
read profileRev from the effective MEMBER-authored join intent
append canonical UPSERT { role, profileRev }
materialize pair.active
update AccountThreadState and ThreadAudience
if this creates an audience, set its deltaVisibleAfter to the canonical end
enqueue/coalesce FAN_OUT_GROUP_META_HEAD after the final audience write
commit
```

The revision is selected by the intent that established this membership
interval. The transaction must not substitute a later `User.defaultProfileRev`
observed while asynchronous fan-out is pending. A zero reference requires no
snapshot.

Profile availability is not a membership precondition. The transaction neither
queries `ProfileVersion` nor submits or waits for HTTP work. After commit, a
positive reference may be offered to the existing global profile coordinator as
best-effort warm-up. Warm-up success, failure, cancellation, and retry have no
effect on pair activity, Group Meta, audiences, or head fan-out.

Warm-up may start earlier than membership. A committed member-authored
`REQUESTED { profileRev }` is the authorization proof for the group origin to
query that exact account revision from the member's authority. The request
transaction commits first, then offers the immutable key to the global
coordinator. It does not wait for the opposite intent or active membership. If
the pair later becomes active, canonical `UPSERT` reuses that intent revision
whether the warm-up succeeded or is still pending.

### 4.2 Role and ownership change

```text
lock the group aggregate
validate the current canonical roster
append one UPSERT for each changed member
preserve the member's current profileRev unless a new membership interval began
enqueue/coalesce FAN_OUT_GROUP_META_HEAD
commit
```

Ownership transfer appends the former and new owner's updates in one aggregate
transaction. Exactly one latest current member must remain `OWNER` at commit.

### 4.3 Departure or removal

```text
lock the group aggregate
fold the relationship state to inactive
append canonical DEPART with an empty stored body
update AccountThreadState and ThreadAudience
apply the thread authorization-interval transition
enqueue/coalesce FAN_OUT_GROUP_META_HEAD after the final audience write
commit
```

The departing target does not need a terminal Group Meta notification. If its
last effective member left, its audience is removed before fan-out observes the
page. Other still-authorized audiences receive a head covering the canonical
`DEPART`.

### 4.4 Re-entry and coalescing

A re-entry appends a new `UPSERT` with the new member-authored intent revision.
Canonical Group Meta records both committed transitions even if head fan-out
has not executed yet. Pending head tasks collapse to the newest canonical end;
they never collapse or rewrite the canonical mutations themselves.

### 4.5 Group profile change and dissolution

A group profile mutation appends one canonical compacted `GROUP_PROFILE` item
and coalesces the same head-fan-out task. Default user-profile changes append no
Group Meta item and create no group fan-out task.

Group dissolution revokes relationships and audiences but does not append a
synthetic empty roster, delete Group Meta, or fan out a terminal head. Retained
canonical history remains inaccessible without current authorization.

## 5. Audience visibility and serving

Each active group `ThreadAudience` records `groupMetaVisibleAfter`, expressed in
the group's canonical coordinate space. On first authorization and every
reauthorization it is set to the canonical end observed by that transaction.

Serving rules are:

- reject every request without a current audience;
- reject delta when `after` is below the audience visibility floor;
- reject a full drain whose fixed `through` is below the audience visibility
  floor;
- allow full mode to return an older current `UPSERT` whose feed ID is below
  the floor, because it reveals current state rather than historical changes;
- never return `DEPART` in full mode;
- return bodyless `DEPART` in delta mode.

This prevents a new peer from enumerating former members while allowing it to
construct the current roster.

## 6. Mirror and client application

### 6.1 Mirror server

The mirror applies Group Meta into its group-scoped replica:

```text
UPSERT -> retain the validated operation at its remote canonical feedId
DEPART -> retain the validated bodyless operation at its remote canonical feedId
GROUP_PROFILE -> update the mirrored group profile reference
```

Every Group Meta synchronization round fixes one remote `through`, whether the
round uses delta or full mode. Each bounded page transaction writes replica
facts and its durable pull checkpoint only. It does not advance `feedEndId`,
create a Client State Feed head, or emit a wake hint. A
multi-page delta round needs no absence cleanup. A full round additionally
marks observed rows with `fullSyncRunId` and removes unobserved rows in bounded
keyset cleanup transactions.

After every page and any full cleanup complete, one final short transaction
advances `feedEndId`. Full and delta application share one
per-group consumer lane. Their durable page cursor, plus the full cleanup cursor
and run identifier when applicable, allow a crash to resume. The implementation
does not block unsolicited local reads during a round; clients are expected to
pull only after their normal head notification, so direct reads may observe
intermediate facts as part of the accepted eventual-consistency model.

When applying a peer State Feed `GROUP_META_FEED_HEAD`, the consumer creates or
merges a Group Meta task with that item's target `through` in the same short
transaction, then advances the State Feed cursor. The consumer does not wait
for the task and may continue applying later State Feed items. The task drains
from `feedEndId` using the page rules above. Its final transaction advances the
mirrored head, applies the completed local projection, writes compacted client
State Feed heads, and marks the task successful. Only its post-commit handler
offers the resulting wake hints to the scope-specific schedulers. Group Meta
page transactions publish nothing. No implementation may prefetch every Group
Meta page into memory and combine them into one transaction.

An unknown `DEPART` is a valid idempotent current-state removal. Replaying an
item with the same canonical coordinate and content is a no-op; conflicting
content at an existing coordinate is a protocol failure. The newest replicated
operation per stable member determines current membership, role, and initial
`profileRev`. Receiving or sending a later message does not mutate it. The
message row keeps its own revision.

A mirror is not promised a terminal `DEPART` after its last local account loses
authorization: the origin removes that peer audience before subsequent head
fan-out. The mirror may consequently retain the last validated `UPSERT` as
historical replica state. It must not treat that row as authorization or expose
it as current membership after the local relationship has ended.

### 6.2 Local client

The local client uses the same current-only semantics:

```text
UPSERT -> upsert member and initial role/profileRev
DEPART -> physically delete member
successful full replacement -> delete members absent from the snapshot
```

After message or profile resolution, the client may update its own member
display revision. That local choice does not write back to the server's
canonical/replica Group Meta or any federation feed.

For a locally hosted group, the client Group Meta endpoint reads the canonical
log directly. For a mirrored group, it reads the shared group-scoped delivery
replica; a full recovery renders current state from each member's latest
replicated operation.
Account authorization is checked on every request. Each account stores only its
State Feed head and device cursor, so N local accounts do not create N copies of
the same Group Meta page.

## 7. Asymmetric member-profile resolution

The profile path follows group ownership, not member account ownership:

```text
member account authority
  -> authorizes the group origin through MEMBER REQUESTED
  -> owns the exact revision named by that request

group origin
  -> may warm the revision immediately after REQUESTED commits
  -> publishes the stable reference without waiting for profile bytes
  -> lazily resolves and caches the exact revision through the global coordinator
  -> serves GET /s2s/v1/group-member-profile

group mirror
  -> requests only from the group origin
  -> caches the immutable result
  -> exposes it only to its own authorized local clients
```

A mirror never serves another federation peer as the profile authority for a
remote group and never redirects a mirror to the member's home server.

The application-wide profile coordinator uses the immutable key:

```text
(groupOrigin, groupAccount, memberAccount, memberDomain, profileRev)
```

Equal requests share one in-flight job. In-flight jobs live in a separate
registry and do not consume LRU capacity. Jobs waiting for HTTP capacity remain
queued behind the global bounded request pool. Only completed cache entries
participate in LRU eviction.

Authorization for Group Member Profile requires all of:

- the responding server owns the group;
- the signer has a current audience;
- the latest canonical member operation is `UPSERT`;
- that `UPSERT` carries the requested positive revision.

These checks run before any upstream request. A successful response additionally
requires the exact immutable snapshot. If it is not yet retained, the request
joins the global coordinator outside every group
transaction and lock. Temporary failure returns a retryable availability result;
permanent absence or disclosure denial returns the privacy-safe profile result.
Neither path mutates the group.

After `DEPART`, Group Member Profile no longer resolves that member. A
historical message uses Message Author Profile with its exact message
coordinate instead.

## 8. Durable head fan-out and mirror dependency

Canonical mutations are O(1) feed writes inside the authoritative transaction.
Their audience notification projection is asynchronous:

```text
FAN_OUT_GROUP_META_HEAD { threadId }
```

Its pending coalescing key is `(taskType, threadId)`. No revision or audience
snapshot is embedded. Execution reads the latest canonical end and scans peer
and local audiences. One audience page is one transaction:

```text
lock and re-read the PROCESSING DurableTask row
yield if a newer pending task has the same coalescing key
read the next bounded ThreadAudience page
read the latest locally serviceable groupMetaFeedEndId
lock and revalidate every selected audience target
write compacted peer/client GROUP_META_FEED_HEAD items
advance afterAudienceId to the last scanned row
commit
revalidate current audience and emit coalesced wake hints
```

The task writes no canonical or replica Group Meta rows. Replaying a
page against an unchanged serviceable end allocates no new State Feed ID. A successor task
starting at audience cursor zero covers an audience inserted behind a running
scan or a greater canonical end committed after that audience was already
visited.

Audience row locking serializes page writes with removals. A post-commit
audience check suppresses stale wake hints, while every serving path continues
to enforce current authorization.

A mirror instead discovers a remote end from an already ordered State Feed
item. Applying that item atomically creates or merges `SYNC_GROUP_META` and
advances the State Feed cursor. Its bounded page and cleanup transactions write
only shared replica facts and task progress. The final transaction advances
the mirror end, derives local client state from the completed replica, and
completes the task. Its post-commit handler then publishes the client hint. The
mirror therefore neither retries the consumed State Feed item nor needs a
second audience-fan-out task.

An executing sync task keeps its fixed target and checkpoint. A later greater
head is merged into a pending successor; an existing pending successor may be
raised in place. A running task is never rewritten.

## 9. Required verification

### 9.1 Authority

- The first active membership appends exactly one canonical `UPSERT` carrying
  the effective member intent revision.
- A later default-profile update and later messages do not mutate that item or
  append another member item.
- Role changes preserve profileRev unless a new membership interval begins.
- Departure appends one bodyless `DEPART`; re-entry appends a new `UPSERT`.
- Point membership, owner checks, and full roster reads agree on latest
  canonical operations.
- Concurrent ownership and membership changes serialize and never commit zero
  or multiple current owners.

### 9.2 Visibility

- First authorization and reauthorization set a new visibility floor.
- Delta below the visibility floor fails with full recovery.
- Full below the visibility floor fails.
- Full at or above the floor returns all current members, including current
  UPSERT items with older feed IDs, and no departed members.
- Removing the last member from one peer removes its audience while other peers
  retain access to the same canonical coordinate space.

### 9.3 Mirror and client

- A mirror retains UPSERT and bodyless DEPART feed operations; the latest
  operation determines current membership.
- A client UPSERT creates or updates one current member, while DEPART physically
  deletes that client member row.
- Unknown and replayed DEPART operations are idempotent current-state removals.
- Full replacement deletes absent members only after the complete bounded drain
  commits.
- A partial or crashed delta/full drain is resumable; no page publishes a head.
- A full round removes unobserved rows in bounded cleanup pages before its final
  head, while a delta round needs no absence cleanup.
- Full and delta application for one mirrored group never overlap.
- Every full page and cleanup transaction obeys a strict row bound; no final
  transaction deletes the complete old roster.
- No delta/full data page or full cleanup page creates a Client State Feed item
  or client wake hint. Finalization wakes the blocked State Feed drain locally;
  only the subsequently committed State Feed item publishes client state.
- One inbound page is retained once per mirrored group, while any number of
  local accounts receive only compacted heads and read the shared rows.
- Message profile resolution may update client display state but never server
  canonical/replica Group Meta.

### 9.4 Profile authority

- A positive membership UPSERT commits even when the exact snapshot is not yet
  local; profile availability never delays or rolls back membership.
- A committed positive member REQUESTED can enqueue warm-up before membership
  becomes active, using that exact intent revision as authorization.
- Profile HTTP runs without a database transaction or group lock and performs
  no group mutation when it finishes.
- Revocation while profile resolution is in flight makes the eventual Group
  Member Profile authorization recheck fail without resurrecting membership.
- Every mirror requests Group Member Profile from the group origin, including
  when the member belongs to a third domain.
- A mirror cannot serve another peer as authority for a remote group.
- Departure, audience revocation, wrong revision, and non-origin requests fail
  closed.
- Concurrent equal resolutions share one in-flight request and one HTTP pool
  slot; completed results alone affect LRU capacity.

### 9.5 Fan-out and recovery

- Membership and group-profile mutations coalesce into one pending head task.
- A mirror State Feed item creates or merges `SYNC_GROUP_META`, advances no
  cursor while that dependency is pending, and authors no canonical Group Meta.
- P2P thread lookup and peer resolution use `RelationshipPair.threadId` and its
  two endpoints without a member projection.
- The mutation, canonical item, final audience state, and task admission commit
  atomically.
- One page transaction has a strict audience bound and writes no Group Meta.
- Crash before page commit repeats the page; crash after commit resumes after
  its checkpoint.
- Delayed hints never restore revoked access.
