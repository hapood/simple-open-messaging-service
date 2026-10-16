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

| State                            | Group origin                                                      | Group mirror                                                    | Local client                                          |
| -------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| Relationship authorization       | Authoritative local intents and pair                              | Authenticated mirror of authored intents                        | Device projection only                                |
| Current group roster             | Canonical Group Meta latest operations                            | Replica Group Meta latest operations                            | Local current-member rows                             |
| Group Meta current facts         | Member, group-profile, and announcement projections               | One group-scoped replica and remote cursor                      | Current display projections                           |
| Member role                      | Current canonical `MEMBER_UPSERT`                                 | Current replica `MEMBER_UPSERT`                                 | Current member role                                   |
| Initial member profile reference | Current canonical `MEMBER_UPSERT.profileNamespaceId + profileRev` | Current replica `MEMBER_UPSERT.profileNamespaceId + profileRev` | Current member profile namespace + `profileRev`       |
| Later message-selected profile   | Immutable `Message.profileNamespaceId + profileRev`               | Immutable `Message.profileNamespaceId + profileRev`             | May replace that member's displayed reference locally |
| Group-member profile authority   | Retained group-scoped snapshot                                    | Requests and caches from origin                                 | Requests through its local backend                    |

The mirror's latest replicated operation is its replaceable current-state
projection, but is not local authorization proof. A client member row has a
current-only lifecycle and is physically removed by `MEMBER_DEPART`. Historical
message rendering uses the immutable message author Address and
`Message.profileNamespaceId + profileRev`, not a retained roster row.

An origin serves local clients from the canonical current facts. A mirror retains one
current fact per member key, one group-profile fact, and one announcement
projection in its group-scoped replica, sharing those rows and remote coordinates among all local accounts.
Per-account state contains only a
compacted head and device cursor; it never copies member-feed rows. The replica
can be rebuilt by a full Group Meta synchronization.
Origin and mirror member/profile facts share one table and one global unique
stable-member key. The group-wide announcement instead occupies nullable
columns on `GroupMeta`, with the same coordinate allocator and a distinct
stable key. Each new operation replaces its previous projection and feed
coordinate.

## 3. Canonical Group Meta storage

Every group has one feed record and one ordered coordinate space. The origin
authors it; a mirror stores the received coordinates:

```text
GroupMeta(threadId)
  metaEndId                             origin allocation end | mirror applied cursor
  profileRev                            the newest GROUP_PROFILE row's revision
  announcementFeedId                    current announcement id; NULL means unknown
  announcementText                      plain text or explicit NULL clear when id exists
  metaTargetId                          greatest target merged from State Feed heads
  metaProcessedThroughId                greatest source feed id durably scanned
  metaRecoveryThroughId                 open recovery drain's fixed through; NULL selects delta

GroupMetaMemberFeed(threadId, feedId)
  stable member subject = account + profileNamespaceId (stored columns)
  operation = MEMBER_UPSERT | MEMBER_DEPART | GROUP_PROFILE
  member body = { account, namespaceId, role, profileRev }
  group profile body = { account, namespaceId, profileRev }
```

`namespaceId` in the stored/published body is the profile-subject namespace; the indexed member column is named `profileNamespaceId`. Departure retains the same complete member body rather than `{}`. The S2S item envelope is `{ feedId, operation, body }` for all four operations, including announcements with body `{ text }`. Subject identity remains in the operation body; no item carries a domain. The final-review draft and schemas now describe these body-based wire shapes.

`GroupMetaMemberFeed` stores member and profile facts. The announcement
projection resides on `GroupMeta` rather than borrowing a member identity.
A positive `announcementFeedId` with null `announcementText` means a known
clear; a null coordinate means unknown. Full/delta page readers merge its
current coordinate with the compacted member/profile rows in feed order.
Client presentation and its per-account acknowledgement are described in
[Group announcement](./group-announcement.md).

The member subject key is `(threadId, memberAccount, profileNamespaceId)`. The
`profileNamespaceId` is the opaque profile-subject namespace supplied by the
profile publisher and must not be derived from a member relationship endpoint.
The recognized publisher namespace is tracked separately from this profile
namespace. Domain is namespace metadata used for routing or display, not the
canonical member identity key.

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
latest operation is MEMBER_UPSERT -> current member
latest operation is MEMBER_DEPART -> not a current member
```

Point membership and role checks use the stable-member/feed index and newest
row. Full roster reads select the newest operation for every stable member and
retain only `MEMBER_UPSERT`. Normal group mutations already serialize on the canonical
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
append GROUP_PROFILE { profileNamespaceId, profileRev: 1 }
establish GROUP_ANNOUNCEMENT { text: null }
append the first member MEMBER_UPSERT { role: OWNER, profileNamespaceId, profileRev: member intent rev }
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
append canonical MEMBER_UPSERT { role, profileNamespaceId, profileRev }
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
`REQUESTED { profileNamespaceId, profileRev }` is the authorization proof for the group origin to
query that exact account revision from the member's authority. The request
transaction commits first, then offers the immutable key to the global
coordinator. It does not wait for the opposite intent or active membership. If
the pair later becomes active, canonical `MEMBER_UPSERT` reuses that intent revision
whether the warm-up succeeded or is still pending.

### 4.2 Role and ownership change

```text
lock the group aggregate
validate the current canonical roster
append one MEMBER_UPSERT for each changed member
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
append canonical MEMBER_DEPART with the departing member's final role and selected profile reference body
update AccountThreadState and ThreadAudience
apply the thread authorization-interval transition
enqueue/coalesce local and federation thread fan-out after the final audience write
commit
```

The departing target does not need a terminal Group Meta notification. The departure body preserves the final profile coordinate for event rendering and continuity, but does not trigger a profile fetch. If its
last effective member left, its audience is removed before fan-out observes the
page. Other still-authorized audiences receive a head covering the canonical
`MEMBER_DEPART`.

### 4.4 Re-entry and coalescing

A re-entry appends a new `MEMBER_UPSERT` with the new member-authored intent revision.
Each committed transition receives a new Group Meta coordinate even if head
fan-out has not executed yet. Compaction may replace the earlier fact for the
same stable key. Pending head tasks collapse to the newest canonical end
without changing the allocated coordinates.

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
- allow full mode to return an older current `MEMBER_UPSERT` whose feed ID is below
  the floor, because it reveals current state rather than historical changes;
- never return `MEMBER_DEPART` in full mode;
- return `MEMBER_DEPART` with its final member body in delta mode;

This prevents a new peer from enumerating former members while allowing it to
construct the current roster.

## 6. Mirror and client application

### 6.1 Mirror server

The mirror applies Group Meta into its group-scoped replica:

```text
MEMBER_UPSERT -> upsert one current member by stable key at its remote canonical feedId
MEMBER_DEPART -> delete that member's current fact
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
removes it for `MEMBER_DEPART`, and writes GROUP_JOINED for an observed join or
GROUP_LEFT for a third-party departure. A local join requires a matching
active relationship pair, while a local departure notice comes from the
REVOKED relationship-intent transaction. Active local pairs determine the
audience, and the system writer
admits the local thread fan-out — or admits the same fan-out directly when the
item carries no transition (a meta-only advance is legitimate member-visible
progress), and advances `metaProcessedThroughId` to that item's feed id. Delta
needs no absence cleanup because every removal arrives as an explicit MEMBER_DEPART.
A crash resumes from the durable cursor. Completing the final page
(`hasMore=false`) also advances `metaEndId` to `through` and refreshes the
group-shell projection, including when that page contains no items.

A full round fetches all pages at one fixed boundary, then clears and replaces
the mirror roster, group-profile reference, and announcement, advances both cursors, and
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
A round that advanced the applied group-profile reference then pulls the exact
snapshot content from the origin through
`/s2s/v1/account-profiles/:namespaceId/:account/:profileRev`, because the
`GROUP_PROFILE` feed item carries the selected namespace and revision but no
display bytes; a failed pull degrades display until the next head re-admits it.
Group Meta item and batch transactions publish nothing beyond the fan-out
admissions described above.

An unknown `MEMBER_DEPART` is a valid current-state removal. Full recovery accumulates
pages above its scan cursor and replaces the committed replica only after the
complete bounded scan succeeds. Full items apply by stable key in that final
transaction; a duplicate coordinate aborts it. Delta items upsert by stable key, changing their coordinate, or
delete that key on MEMBER_DEPART. The current fact per stable member determines
membership, role, and initial
`profileRev`. Receiving or sending a later message does not mutate it. The
message row keeps its own revision.

A mirror is not promised a terminal `MEMBER_DEPART` after its last local account loses
authorization: the origin removes that peer audience before subsequent head
fan-out. The mirror may consequently retain the last validated `MEMBER_UPSERT` as
historical replica state. It must not treat that row as authorization or expose
it as current membership after the local relationship has ended.

#### Mirror authorization denial

An origin may close the mirror's audience without appending a synthetic empty
roster or a final `MEMBER_DEPART`. A later query can therefore return HTTP `200`
`FORBIDDEN`. A denial never advances the failed query's cursor or proves group
dissolution.

For message and tombstone queries, the mirror revalidates the captured
relationship state and applies the locally authored revocation rules in
[Message Query, Section 4](../../spec/v1/message-feed.md#4-authorization-and-state-reconciliation).
This convergence is required when the denial remains applicable, not optional
cleanup. A Group Meta denial alone does not trigger that thread-query exception;
relationship termination still converges through State Feed.

### 6.2 Local client

The local client uses the same current-only semantics:

```text
MEMBER_UPSERT -> upsert member and initial role/profileNamespaceId + profileRev
MEMBER_DEPART -> physically delete member
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
  -> serves GET /s2s/v1/group-member-profiles/:groupAccount/:namespaceId/:memberAccount/:profileRev

group mirror
  -> requests only from the group origin
  -> caches the immutable result
  -> exposes it only to its own authorized local clients
```

A mirror never serves another federation peer as the profile authority for a
remote group and never redirects a mirror to the member's home server.

The application-wide profile coordinator uses the immutable key:

```text
(publisherNamespaceId, profileNamespaceId, memberAccount, profileRev)
```

Equal requests share one in-flight job. In-flight jobs live in a separate
registry and do not consume LRU capacity. Jobs waiting for HTTP capacity remain
queued behind the global bounded request pool. Only completed cache entries
participate in LRU eviction.

Authorization for Group Meta Profile requires all of:

- the responding server owns the group;
- the signer has a current audience;
- the latest canonical member operation is `MEMBER_UPSERT`;
- that `MEMBER_UPSERT` carries a positive revision selected by the origin, not supplied
  by the requester.

These checks run before any upstream request. A successful response additionally
requires the exact immutable snapshot. If it is not yet retained, the request
joins the global coordinator outside every group
transaction and lock. Temporary failure returns a retryable availability result;
permanent absence or disclosure denial returns the privacy-safe profile result.
Neither path mutates the group.

For `subject=GROUP`, the origin instead selects its current `GROUP_PROFILE`
reference under the same audience check. The response revision may differ from
the requester's earlier projection; an exact account/revision request uses
Authorized Profile and its separate disclosure rules.

After `MEMBER_DEPART`, Group Meta Profile no longer resolves that member. Its body
preserves the final profile coordinate but does not authorize or trigger a profile
fetch. A historical message uses Message Author Profile with its exact message
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

A mirror discovers a remote end from an ordered State Feed item. Applying that
item atomically merges the target into `GroupMeta.metaTargetId` and advances
the State Feed cursor, then wakes the mirror's `meta` lane after commit.
Replica commits and local fan-out follow Section 6.1. Their completion never
requires replaying the consumed State Feed item.

An executing round keeps its frozen target. A later greater head is either
absorbed by the dirty mark after the round completes or starts a successor
round; a running round is never rewritten.

## 9. Required verification

### 9.1 Authority

- The first active membership appends exactly one canonical `MEMBER_UPSERT` carrying
  the effective member intent revision.
- A later default-profile update and later messages do not mutate that item or
  append another member item.
- Role changes preserve profileRev unless a new membership interval begins.
- Departure appends one `MEMBER_DEPART` with the final member body; re-entry appends a new `MEMBER_UPSERT`.
- Point membership, owner checks, and full roster reads agree on latest
  canonical operations.
- Concurrent ownership and membership changes serialize and never commit zero
  or multiple current owners.

### 9.2 Visibility

- First authorization and reauthorization set a new visibility floor.
- Delta below the visibility floor fails with full recovery.
- Full below the visibility floor fails.
- Full at or above the floor returns current MEMBER_UPSERT items still at or below its
  fixed boundary, including older feed IDs, and no departed members. Items
  compacted above that boundary are restored by the following delta round.
- Removing the last member from one peer removes its audience while other peers
  retain access to the same canonical coordinate space.

### 9.3 Mirror and client

- A mirror retains one current MEMBER_UPSERT per stable member key and no MEMBER_DEPART row.
- A client MEMBER_UPSERT creates or updates one current member, while MEMBER_DEPART physically
  deletes that client member row.
- Unknown and replayed MEMBER_DEPART operations are idempotent current-state removals.
- Full replacement deletes absent members only after the complete bounded drain
  commits.
- A partial delta drain resumes from its durable cursor. A failed full scan
  leaves the committed roster intact and retries from its fixed boundary.
- Full and delta application for one mirrored group never overlap.
- The complete full scan replaces the roster and commits its cursor in one
  transaction; a delta round needs no absence cleanup.
- State Feed commits the Group Meta dependency and its own cursor together,
  without waiting for retrieval. Group Meta commits publish their local hints
  after commit and never replay the already consumed State Feed item.
- One inbound page is retained once per mirrored group, while any number of
  local accounts receive only compacted heads and read the shared rows.
- Message profile resolution may update client display state but never server
  canonical/replica Group Meta.

### 9.4 Profile authority

- A positive membership MEMBER_UPSERT commits even when the exact snapshot is not yet
  local; profile availability never delays or rolls back membership.
- A committed positive member REQUESTED can enqueue warm-up before membership
  becomes active, using that exact intent revision as authorization.
- Profile HTTP runs without a database transaction or group lock and performs
  no group mutation when it finishes.
- Revocation while profile resolution is in flight makes the eventual Group
  Meta Profile authorization recheck fail without resurrecting membership.
- Every mirror requests Group Meta Profile from the group origin, including
  when the member belongs to a third domain.
- A mirror cannot serve another peer as authority for a remote group.
- Departure, audience revocation, and non-origin requests fail closed. A
  changed current reference returns its actual revision, never the requester's
  previously observed revision with different content.
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
