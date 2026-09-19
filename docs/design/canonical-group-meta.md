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
| Group Meta current facts         | One operation per stable member key    | One group-scoped replica and remote cursor | None                                                 |
| Member role                      | Current canonical `UPSERT`             | Current replica `UPSERT`                   | Current member role                                  |
| Initial member profile reference | Current canonical `UPSERT.profileRev`  | Current replica `UPSERT.profileRev`        | Current member `profileRev`                          |
| Later message-selected profile   | Immutable `Message.profileRev`         | Immutable `Message.profileRev`             | May replace that member's displayed revision locally |
| Group-member profile authority   | Retained group-scoped snapshot         | Requests and caches from origin            | Requests through its local backend                   |

The mirror's latest replicated operation is its replaceable current-state
projection, but is not local authorization proof. A client member row has a
current-only lifecycle and is physically removed by `DEPART`. Historical
message rendering uses the immutable message author Address and
`Message.profileRev`, not a retained roster row.

An origin serves local clients from the canonical current facts. A mirror retains one
current fact per member key and one group-profile fact in its group-scoped
replica, sharing those rows and remote coordinates among all local accounts.
Per-account state contains only a
compacted head and device cursor; it never copies member-feed rows. The replica
can be rebuilt by a full Group Meta synchronization.
Origin and mirror facts share one table and one global unique stable-member
key. Each new operation replaces the previous operation and feed coordinate.

## 3. Canonical Group Meta storage

Every group has one feed record and one ordered coordinate space. The origin
authors it; a mirror stores the received coordinates:

```text
GroupMeta(groupId)
  metaEndId                             origin allocation end | mirror applied cursor
  profileRev                            the newest GROUP_PROFILE row's revision
  metaTargetId                          greatest target merged from State Feed heads
  metaProcessedThroughId                greatest source feed id durably scanned
  metaRecoveryThroughId                 open recovery drain's fixed through; NULL selects delta

GroupMetaMemberFeed(groupId, feedId)
  fact subject = account + domain (a member, or the group itself for GROUP_PROFILE)
  operation = UPSERT | DEPART | GROUP_PROFILE
  body = { role, profileRev } | {} | { profileRev }
```

Member namespace is not stored in Group Meta. Local identity queries derive it
from the member's relationship pair, or from the mirror group's source
namespace for third-party projected members. The Group Meta unique index is
`(threadId, memberAccount, memberDomain)`.

The compacted GROUP_PROFILE item is a stored feed fact like any member fact:
a profile mutation allocates one new coordinate, stores the row with the group
itself as the subject, and advances `metaEndId`; the newest such row (greatest
`feedId`) is the group's current profile reference. On an origin, `metaEndId`
is the last allocated canonical coordinate. On a mirror, it is the last
completely applied fixed-through round cursor, and
`metaProcessedThroughId`/`metaTargetId` are the scheduler's start and target.
`metaRecoveryThroughId` selects the mode: an open recovery drain (non-null
through) means the mirror is inside a full-snapshot drain, null means delta
rounds.

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

The current facts are both the origin's roster projection and its federation feed.
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
enqueue local and federation thread fan-out
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
enqueue/coalesce local and federation thread fan-out after the final audience write
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
enqueue/coalesce local and federation thread fan-out
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
enqueue/coalesce local and federation thread fan-out after the final audience write
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
UPSERT -> upsert one current member by stable key at its remote canonical feedId
DEPART -> delete that member's current fact
GROUP_PROFILE -> upsert one current row with the group itself as the subject
  and update the mirrored group profile reference
```

Every Group Meta synchronization round fixes one remote `through`. A delta
round freezes `through` at the current `metaTargetId` in scheduler memory; a
full-snapshot recovery drain persists its through on the row
(`metaRecoveryThroughId`) when it opens, so a restart resumes the same drain
instead of re-deriving it. The mode is read from the mirror's
`metaRecoveryThroughId`: an open drain selects full mode, null selects delta.

A delta round consumes one feed item per transaction. Each commit rejects a
coordinate at or below the committed cursor, replaces the stable-key fact or
deletes it for DEPART, and writes GROUP_JOINED for an observed join or
GROUP_LEFT for a third-party departure. A local join requires a matching
active relationship pair, while a local departure notice comes from the
REVOKED relationship-intent transaction. Active local pairs determine the
audience, and the system writer
admits the local thread fan-out — or admits the same fan-out directly when the
item carries no transition (a meta-only advance is legitimate member-visible
progress), and advances `metaProcessedThroughId` to that item's feed id. Delta
needs no absence cleanup because every removal arrives as an explicit DEPART.
A crash resumes from the durable cursor. The round's last item — the page without `hasMore` — additionally
advances `metaEndId` to `through` and refreshes the group-shell projection in
the same transaction.

A full round fetches all pages at one fixed boundary, then clears and replaces
the mirror roster, writes the profile revision, advances both cursors, and
admits fan-out in one transaction. It writes no system messages. An incomplete
scan changes no mirror facts. If the origin replaces a compacted fact above
the fixed boundary during the scan, that fact disappears from remaining full
pages. No new fact can appear below the boundary; the next delta round reads
the newest replacement and converges the roster.

Full and delta application share one per-group round lane in the federation
thread round scheduler: at most one in-flight round per mirror thread, a dirty
mark coalescing heads that arrive mid-round. The implementation does not block unsolicited local reads during a round.
Readers see either the roster before or after a full drain's commit.

When applying a peer State Feed `THREAD_CONTENT_HEAD` carrying
`groupMetaFeedEndId`, the consumer merges that target into `metaTargetId` —
creating the mirror's `GroupMeta` row with a zero cursor and an open recovery
drain fixed at the merged target when
absent — and enqueues a `meta` round wake in the same short transaction, then
advances the State Feed cursor. The consumer does not wait for the round and
may continue applying later State Feed items. The round drains from
`metaProcessedThroughId` using the item and batch rules above. The drain's
final transaction advances the mirrored head, applies the local group-shell
projection, and writes compacted client State Feed heads, so the new end
coordinate — and with it the newest drained GROUP_PROFILE row — reaches every
member's thread feed; the per-item and per-batch fan-out admissions already
carried the intermediate advances.
A round that advanced the applied profile revision then pulls the exact
revision's content from the origin (`/s2s/v1/profiles/:account?rev=`), because
the GROUP_PROFILE feed item carries the revision only; a failed pull degrades
display until the next head re-admits it. Group Meta item and batch
transactions publish nothing beyond the fan-out admissions described above.

An unknown `DEPART` is a valid current-state removal. Full recovery clears the
replica before its first page, and both page modes continue above the committed
cursor. Full items upsert by stable key in one batch; a duplicate coordinate
aborts the transaction. Delta items upsert by stable key, changing their coordinate, or
delete that key on DEPART. The current fact per stable member determines
membership, role, and initial
`profileRev`. Receiving or sending a later message does not mutate it. The
message row keeps its own revision.

A mirror is not promised a terminal `DEPART` after its last local account loses
authorization: the origin removes that peer audience before subsequent head
fan-out. The mirror may consequently retain the last validated `UPSERT` as
historical replica state. It must not treat that row as authorization or expose
it as current membership after the local relationship has ended.

#### Mirror authorization denial

An origin may close the mirror's audience without appending a synthetic empty
roster or a final `DEPART`. A later Group Meta or content query can therefore
return HTTP 200 `FORBIDDEN`. The mirror stops that round without advancing its
cursor, records the event at debug level, and waits for the next State Feed
push. It does not translate the denial into a local dissolution, revoke local
members, synthesize `GROUP_LEFT`, or disable future federation rounds.

The protocol permits a receiving peer to end relationship directions it
authors locally after an authenticated denial, but this is optional (`MAY`),
not required convergence. A mirror that retains the relationship must still
treat current authorization checks—not retained Group Meta rows—as the access
gate. A later push retries from the last committed cursor and can carry the
facts that converge or restore authorization.

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
  -> serves GET /s2s/v1/group-meta-profile

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

Authorization for Group Meta Profile requires all of:

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

After `DEPART`, Group Meta Profile no longer resolves that member. A
historical message uses Message Author Profile with its exact message
coordinate instead.

## 8. Thread-head fan-out and mirror dependency

Canonical mutations are O(1) feed writes inside the authoritative transaction.
Their audience notification projection uses the existing asynchronous thread
fan-out tasks:

```text
FAN_OUT_THREAD_CONTENT { threadId, messageEndSeq, tombstoneEndSeq }
FAN_OUT_FEDERATION_THREAD_CONTENT { threadId, messageEndSeq, tombstoneEndSeq }
```

Each pending coalescing key is `(taskType, threadId)`. No Meta revision or
audience snapshot is embedded. Execution reads the latest canonical end while
projecting the current local or peer audience. One projection transaction:

```text
lock the thread and re-read the PROCESSING DurableTask row
yield if a newer pending task covers both content coordinates
read and revalidate the next local account or federation namespace
read the latest canonical groupMetaFeedEndId
write the complete local thread-feed snapshot or peer THREAD_CONTENT_HEAD
commit
emit the corresponding best-effort wake hint
```

The tasks write no canonical or replica Group Meta rows. Replaying a projection
against an unchanged complete head allocates no new feed ID. A successor task
covers a greater canonical end committed after that audience was already
visited.

Each executor revalidates current membership or routing under the thread lock
before writing. Wake hints are best effort, while every serving path continues
to enforce current authorization.

A mirror instead discovers a remote end from an already ordered State Feed
item. Applying that item atomically merges the target into `GroupMeta.metaTargetId`,
wakes the mirror's `meta` round lane, and advances the State Feed cursor. Its
delta page transactions write only shared replica facts and the durable
processed cursor. The final transaction advances the mirror end, derives local
client state from the completed replica, and admits a local thread fan-out when
needed. The round executor then publishes the client hint post-commit. The
mirror therefore neither retries the consumed State Feed item nor needs a
second audience-fan-out task.

An executing round keeps its frozen target. A later greater head is either
absorbed by the dirty mark after the round completes or starts a successor
round; a running round is never rewritten.

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
- Full at or above the floor returns current UPSERT items still at or below its
  fixed boundary, including older feed IDs, and no departed members. Items
  compacted above that boundary are restored by the following delta round.
- Removing the last member from one peer removes its audience while other peers
  retain access to the same canonical coordinate space.

### 9.3 Mirror and client

- A mirror retains one current UPSERT per stable member key and no DEPART row.
- A client UPSERT creates or updates one current member, while DEPART physically
  deletes that client member row.
- Unknown and replayed DEPART operations are idempotent current-state removals.
- Full replacement deletes absent members only after the complete bounded drain
  commits.
- A partial delta drain resumes from its durable cursor. A failed full scan
  leaves the committed roster intact and retries from its fixed boundary.
- Full and delta application for one mirrored group never overlap.
- The complete full scan replaces the roster and commits its cursor in one
  transaction; a delta round needs no absence cleanup.
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
- Every mirror requests Group Meta Profile from the group origin, including
  when the member belongs to a third domain.
- A mirror cannot serve another peer as authority for a remote group.
- Departure, audience revocation, wrong revision, and non-origin requests fail
  closed.
- Concurrent equal resolutions share one in-flight request and one HTTP pool
  slot; completed results alone affect LRU capacity.

### 9.5 Fan-out and recovery

- Membership and group-profile mutations coalesce into one pending head task.
- A mirror State Feed item merges the target into `GroupMeta.metaTargetId` and
  wakes the mirror's `meta` round lane, advances no mirror cursor itself, and
  authors no canonical Group Meta.
- P2P thread lookup and peer resolution use `RelationshipPair.threadId` and its
  two endpoints without a member projection.
- The mutation, canonical item, final audience state, and task admission commit
  atomically.
- One page transaction has a strict audience bound and writes no Group Meta.
- Crash before page commit repeats the page; crash after commit resumes after
  its checkpoint.
- Delayed hints never restore revoked access.
