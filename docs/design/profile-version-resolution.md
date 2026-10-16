# Profile Version Resolution: Exact Federation Evidence Cutover

Status: historical cutover design, not the current physical schema or client request contract. The domain-bearing five-tuple, staged migration names, source-coordinate columns, and pending approvals below describe that checkpoint. Current storage and projection-free demands are summarized in [the database model](../overview/database.md), [account/profile separation](./account-profile-separation.md), and [profile presentation](./profile-presentation.md). The federation wire contract remains [Profiles](../../spec/v1/profiles.md). Do not use this historical plan to add removed fields or deploy mixed contracts.

## 1. Identity, cache, and request boundary

A complete client-visible immutable profile resolution is keyed by
`(publisherNamespaceId, profileNamespaceId, account, domain, profileRev)`. The
profile subject namespace identifies the account revision; the publisher
namespace identifies the disclosure route that authorized materialization. A
client resolution first looks for this five-tuple locally; the backend likewise
checks its in-memory LRU and PostgreSQL before constructing a federation request. On a miss, the
backend uses the client's selected revision and evidence to choose the
federation operation. The publisher, not this local read-through cache, checks
federation disclosure. No local audience/roster/intent authorization preflight
should prevent a valid historical revision from being fetched; a client may
still hold a reference older than the latest local projection.

A selected reference always includes `profileRev > 0`. Zero means no lookup.
Source coordinates select a route; they are **not** part of the profile subject
identity. The client-to-backend demand carries the publisher namespace
explicitly. A federation exact-profile response must match the requested
profile subject tuple, including the revision. An unavailable or
mismatched revision cannot be replaced with the publisher's current profile.

Keep the bounded backend profile-fetch scheduler (1,000 pending exact keys,
eight concurrent network requests) and per-five-tuple single-flight. A pending
item is keyed by the exact `(publisherNamespaceId, profileNamespaceId, account, domain, rev)` and owns one
final fetch demand plus session listeners. Later demands for the same exact key
join that item; there is no method list, fallback sequence, or projection
upgrade path on the fetch queue. A not-found response or network failure
removes the exact-key item, allowing a later demand to retry. A successful
_exact, non-null_ response stores the profile once, touches the profile LRU as
soon as the network result is accepted, then completes the matching five-tuple
key after durable materialization; it never completes a _different_ revision's
key. Profile absence need not reach the UI as a revision update: existing
address/avatar fallbacks remain, and a later demand may retry. A lost SSE frame
is likewise recoverable by a later cache read/demand.

`PROFILE_AVAILABLE` signals only the resolved five-tuple, with no evidence or
profile body. Remove evidence from the backend SSE method and payload, browser
and native event decoding, wake models, and code which uses a returned evidence
to rebase a local reference. The client API registers only its authenticated
session on the exact-key item; an internal demand never registers a session. On
exact success, send `PROFILE_AVAILABLE { publisherNamespaceId, profileNamespaceId, account, domain, rev }`
only to the item's registered sessions, then remove the item. On failure,
remove the item and notify those sessions with session-scoped
`PROFILE_UNAVAILABLE` carrying the same key if retained for retry signaling,
without retaining a separate subscription or negative cache. A later demand can
register again.
Failure handling must release scheduler capacity and must not manufacture a new
revision. Message evidence projection has its own capped queue and LRU; it is
not part of profile fetch scheduling.

## 2. Source-coordinate model

The thread feed publishes an exact `profile` reference and one nullable profile
source coordinate alongside it. `AccountThreadState` persists that coordinate
with `threadProfileRev`; client `threads` records persist it with the selected
profile. The existing P2P client `peerProfileMessageSeq` becomes this shared,
meaningfully named coordinate rather than remaining a P2P-only field. Use the
thread's existing `MessageThread.type` / thread-feed `type` to interpret it:

| Thread                                                | Source coordinate                                                     | Profile lookup on a cache miss                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| P2P, initial establishment                            | null; revision from the peer-authored effective Relationship Intent   | Account Profile at the peer's origin                                   |
| P2P, updated by a peer-authored message               | that selected message's committed seq; revision from the same message | Account Profile at the peer's origin                                  |
| GROUP, newly activated from the group-authored intent | null; revision from that intent                                       | Account Profile at the group origin                                    |
| GROUP, selected by Meta                               | the selected `GROUP_PROFILE` item's feed ID; revision from that item  | Account Profile at the group origin, authorized by current Group Meta |

A group's selected `GROUP_PROFILE.feedId` is **not** `GroupMeta.metaEndId` or
`groupMetaFeedEndId`: subsequent member/announcement items can advance those
heads without selecting another group profile. Persist the actual selected
item coordinate on the origin and mirror and fan it out with the revision.
Meta rounds compare actual Meta coordinates, not numerical profile revisions.
Remove the `next.profileRev > plan.profileRev` pull/rebase gate and the
independent `pullRemoteGroupProfile` HTTP path, **but retain eager profile
resolution**: apply the selected `GROUP_PROFILE` item's revision and feed ID
as part of the Meta fact and fanout path, without waiting for profile bytes.
After the Meta transaction commits, submit only a prefetch hint for a changed
positive revision; an unchanged revision or revision zero needs no profile
fetch. The scheduler must not write Meta-derived evidence. The Meta round discovery gate is an active peer
namespace plus `federationRoundsEnabled`; relationship mutations maintain the
latter, and the publisher performs its own audience authorization. The Meta
round discovery SQL itself does not JOIN the relationship table.

Group member selection is scoped to `(group thread, member address)`. The
server's current `GroupMetaMemberFeed` has a nullable `profileSourceSeq` beside
the canonical `MEMBER_UPSERT.feedId`. The source seq is **backend-only**
evidence for comparing committed member messages; the Meta feed ID is the
published member-reference coordinate. A member-authored message selecting a
different revision does not update the client directly or modify the member
fact in its landing transaction. For a remote member, the common profile
resolver obtains the exact positive snapshot and may replace the origin member
fact in a separate transaction with a newly allocated Meta feed ID and fan
out the new head. Revision zero needs no snapshot. Crucially, **selection never
waits for the snapshot**: the member fact advances from committed message
evidence regardless of whether the exact profile bytes are cached locally, and
a missing, delayed, or failed fetch must never be a precondition of the
selection write. A local member does **not**
enter the profile-fetch scheduler: after message commit, use the shared
candidate selection helper and call the origin's Meta update in a separate
transaction. Neither branch calls
the Meta writer from the message landing transaction. A full resolver queue
may omit remote-member work: do not block message delivery or roll back a
committed message; a later committed member message can submit another
candidate. A message admitted as a validated federated media `STUB` already
commits its profile evidence and may advance selection; `FAILED` placeholders
never do.
An unchanged revision updates neither the selected source seq nor the
published member reference. Ordinary profile edits without a selecting message
do not publish member Meta items.

The client member record needs only the Meta item's feed ID, member identity,
role, and exact namespace and revision; remove its message-source anchor rather
than renaming it. On a cache miss, the client sends group thread, member
address, namespace, and revision to the backend, which resolves Group Member
Profile at the group origin. The client never selects a member version from
message rows. A
`MEMBER_DEPART` need not clear backend message evidence; a new membership
incarnation initializes it instead of inheriting the previous anchor.

A null source ID means no previous source coordinate is competing: any
eligible positive candidate ID passes the ID gate, regardless of its revision
number. It still must carry a **different** revision to change the selection.
Once a source ID exists, first compare the candidate ID in the same coordinate
space: only an ID strictly greater than the stored ID may replace the
selection. An older or equal ID must not write either field, even if it carries
a different revision. **Only after the ID passes** compare `profileRev`:
update **both** the source ID and the revision only if the revision differs.
When the revision is unchanged, leave **both fields** untouched even if the
candidate ID is newer. For P2P and backend member-message candidates, compare message **seq** to
the last selected message seq. Meta fact ordering uses **feed ID**. These are
different coordinate spaces: never compare a Meta feed ID with a message seq
or choose a profile by the larger `profileRev`. On a mirror, commit the incoming Meta item and its role/membership changes
and arrange any required fanout first. After commit, submit an internal profile
demand **only if the selected profile revision actually changes**. For a
member Meta item, only a newly selected positive revision needs a profile
lookup; a zero reference needs no bytes. For `GROUP_PROFILE`, a changed
selection to zero is already projected by the Meta path and needs no fetch.
An unchanged revision, including a role-only update, submits no profile
demand. Meta carries no member-message evidence: if a committed member
message already backs a selected revision, an incoming Meta item can update
the role without replacing that selected revision or its source seq. If the
role, selected revision, and source are all unchanged, do not write a new
projection solely because an item arrived (the authentic feed cursor still
advances). Await the origin's new Meta coordinate for client publication;
never invent one on the mirror. A fresh
membership incarnation initializes its selection from its new intent. The
client compares only published feed coordinates, never message seq for a
member profile. Group-profile selection never uses a member-authored message.

## 3. Database and projection change inventory

This is a breaking rebuild, **not a historical data backfill**. The reviewed
PostgreSQL names and DDL are staged across append-only migrations, including
the historical source-coordinate and publisher/profile namespace cutovers (now represented in the [current SQL baseline](../../database/migrations/0000_base.sql)),
and in [Drizzle schema](../../src/database/schema.ts); no deployed migration is
rewritten. The Web IndexedDB and Tauri SQLite cache changes remain subject to
separate review before implementation. Keep SQL and Drizzle in sync. Recreate versioned Web IndexedDB and
Tauri SQLite account caches, without converting old profile-source rows or
falling back to legacy column names. Five-tuple profile snapshots themselves
remain independent of evidence. Review concrete DDL and client cache schema
changes before running them.

| Store                                    | Required structural change                                                                                                                 | Writer/read boundary                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL `AccountThreadState`          | Nullable selected-profile source ID next to `threadProfileRev`, constrained to a positive ID when set                                      | Establishment/acceptance; post-commit internal profile resolution for P2P messages and group `GROUP_PROFILE`; thread-feed query and publication |
| PostgreSQL current `GroupMetaMemberFeed` | Nullable backend-only message-source seq for `MEMBER_UPSERT`                                                                               | New upsert; post-commit origin member-profile publication; mirror Meta reconciliation; departure/rejoin                                         |
| Browser `threads`, native thread row     | Rename P2P-only `peerProfileMessageSeq` to shared nullable source ID; persist the same type, revision, and coordinate from the thread feed | Atomic feed snapshot/cursor commit, display projection, avatar resolution                                                                       |
| Browser/native group member row          | Remove the message-source field; retain the published member Meta `feedId` and revision                                                    | Meta page application, full reset and rejoin, roster and system-message lookup                                                                  |

### Physical schema and pending client-cache approval

PostgreSQL column names below are staged. Web and native cache names and
recreation still require their own approval before implementation:

| Store                                      | Exact proposed field / reset                                             | Null and write semantics                                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| PostgreSQL `AccountThreadState`            | `"profileSourceId" integer NULL`, Drizzle `profileSourceId: integer()`   | `NULL` for an intent-initialized P2P or GROUP profile; P2P message seq or the selected GROUP_PROFILE feed ID otherwise; positive when non-null; update atomically with `threadProfileRev`                  |
| PostgreSQL `GroupMetaMemberFeed`           | `"profileSourceSeq" integer NULL`, Drizzle `profileSourceSeq: integer()` | Backend-only selected member message seq; changed revisions replace the current upsert with a newly allocated `feedId` and its exact `body.profileRev`; departures need not clear it, but rejoin resets it |
| Web `threads` row and shared thread record | `profileSourceId?: number                                                | null`instead of`peerProfileMessageSeq`                                                                                                                                                                     | Persist the server thread-feed field with type and revision; delete the P2P-only field |
| Web `members` row                          | Remove `profileMessageSeq`; do not add `profileSourceSeq`                | Persist the existing Meta `feedId` and its selected revision atomically; remove message-based member selection                                                                                             |
| Native SQLite `threads`                    | `profile_source_id INTEGER` instead of `peer_profile_message_seq`        | Same thread-feed value as Web; type is the existing `kind` column                                                                                                                                          |
| Native SQLite `members`                    | Remove `profile_message_seq`; do not add `profile_source_seq`            | Persist the existing Meta `feedId` and revision; remove message-based member selection                                                                                                                     |

The append-only PostgreSQL migration contains two `ALTER TABLE ... ADD COLUMN`
statements, positive-if-present checks on both columns, and P2P intent
re-establishment trigger updates. It does not rewrite `0000_base.sql` or
backfill existing rows. The existing `thread_feed_before_write()` trigger allocates a
new thread-feed version on `threadProfileRev` change, **not** on a change to
`profileSourceId` alone. A source-only change is not an accepted profile
selection or publication trigger.
There is no extra index: account/thread and group/member current-fact lookups
already have keys. Match actual DB DDL and `src/database/schema.ts` exactly.
Before deployment, use a **fresh database** for this breaking cutover, not an
implicit NULL-as-historical-intent interpretation of old populated rows.

Web increments `CACHE_SCHEMA_VERSION` from 34 to 35 and rebuilds the existing
account cache; leave the separate `MESSAGE_CACHE_SCHEMA_VERSION` at 6 because
message bytes/schema do not change. Native increments `CACHE_SCHEMA_VERSION`
from 36 to 37 and recreates its account cache. The Web IndexedDB format
version may remain 1 because the account cache is explicitly deleted/recreated
on logical schema-version mismatch. Rebuilds must not silently restore old
conversation/member source fields. Before editing **any** of these schema
files, stop and request approval of both client cache schemas. Approval of
the PostgreSQL migration does not imply approval of browser/native cache resets.

The existing group member fact's `feedId` remains its canonical Meta ordering
coordinate. A message-selected different revision replaces the current origin
member fact with a newly allocated ID as soon as the committed message
evidence selects a different revision. The snapshot fetch is independent
display-cache work: for a remote member, the group origin requests that exact
version from the member home using `account-profiles` with confirmed group-member relationship
and serviceable member-message evidence; other peers and clients request
`group-member-profiles` from the group origin. The demand always keeps namespace
roles separate: the publisher namespace is the local namespace of the peer that
will answer the profile request, while the profile namespace is the answering
publisher's subject namespace for the member profile. Ordinary message demands
use the message source as publisher namespace and the federated message
`namespaceId` as target profile namespace. Mirrored Group Meta prefetch uses the
mirror group's publisher namespace and the `MEMBER_UPSERT` profile namespace.
Validate the authenticated publisher namespace when materializing either
response; do not require the profile subject domain to equal the publisher
domain for a group-origin-disclosed member. A mirror must not fabricate an
origin Meta ID or let an incoming evidence-free Meta profile reference regress
a locally selected, message-backed member revision. Its Meta transaction first
advances the authentic feed cursor, applies the local member fact (including
role-only changes where message evidence already selects the revision), and
arranges fanout. Only after that transaction commits does it offer a prefetch hint for a
newly selected positive remote revision. If the selected revision and role
are already current, projection application is a no-op. Preserve canonical received item
contents separately from a locally selected member fact if the two differ;
full recovery must not discard newer committed message evidence.

Only a message-derived internal projection commits the selected P2P thread
revision and message source in a separate post-fetch database transaction;
a changed `threadProfileRev` publishes via the existing thread-feed trigger,
while an unchanged revision does not update the source. Group Meta selects its
group thread revision and feed-ID source in its own fact/fanout path, before
any optional profile prefetch. At the origin, a changed member revision allocates a new
Meta ID and schedules durable audience head fanout in a separate transaction;
an unchanged revision does neither. Client-only resolution never changes
either projection. A no-op must not regress a coordinate. Preserve the
existing account/thread/group lock order for these new post-fetch transactions.
Remove default-profile-edit-driven member Meta propagation: only a selecting
member message (or a new membership interval) changes the member profile
reference.

Audit every establishment path, especially local and mirrored group invitation
acceptance and application approval: initialize the new member's revision and
source consistently with the effective intent and first `MEMBER_UPSERT`;
subsequent identical upserts must not reset an active member's message
selection. Departures retain evidence; rejoin starts a new selection. P2P
establishment selects the **opposite** participant's intent; post-commit
internal message profile resolution sets the shared thread source only when it
selects a different thread profile revision. An intent-initialized group thread starts with the group-authored intent
revision and a null source; later Meta selection takes its source and revision
from the same `GROUP_PROFILE` item, never from a general Meta head or member
item. If Meta supplies the same revision, leave the intent selection unchanged.
Meta-derived selection never waits for a snapshot or a scheduler callback.

## 4. Selector conversion and federation endpoints

The client profile request is the same exact-revision demand shape used by
backend resolution. It carries two explicitly named namespace roles: the
publisher namespace used to route/authorize the federation request, and the
profile namespace that identifies the immutable profile subject. The local-to-wire mapping is fixed:

```text
publisherNamespaceId       = local IdentityNamespace.id of the authenticated peer
target.profileNamespaceId  = wire namespaceId emitted by that peer
```

For an outbound profile read, `publisherNamespaceId` selects the peer connection
and recognized identity, while `target.profileNamespaceId` becomes the
`:namespaceId` path segment. If `target.profileNamespaceId` is `0`, every
subject-domain path variable in the selected operation is serialized as the
literal `local`; otherwise the retained target domain is serialized. This
conversion is performed at the S2S request boundary and does not mutate the
stored profile target. `publisherNamespaceId` is never sent as a profile field. The demand does not contain presentation evidence or local asynchronous
projection coordinates.

```ts
interface ProfileTarget {
  profileNamespaceId: number;
  account: string;
  domain: string;
  rev: number;
}

type ClientProfileResolutionDemand =
  | {
      publisherNamespaceId: number;
      lookup: 'ACCOUNT_PROFILE';
      target: ProfileTarget;
    }
  | {
      publisherNamespaceId: number;
      lookup: 'ACCOUNT_PROFILE';
      target: ProfileTarget;
      account: string;
    }
  | {
      publisherNamespaceId: number;
      lookup: 'GROUP_MEMBER_PROFILE';
      target: ProfileTarget;
      groupAccount: string;
    };
```

This is intentionally isomorphic with the backend prefetch demand. The client
supplies both namespaces; it must not omit either or infer one from the profile
domain. `target.profileNamespaceId` is the publisher-scoped subject namespace
and is meaningful only with `publisherNamespaceId`. `publisherNamespaceId`
identifies the local federation publisher allocation used to route the S2S
request and validate the disclosure context.
The lookup value maps directly to the S2S operation:

```text
ACCOUNT_PROFILE              → account-profiles
GROUP_MEMBER_PROFILE         → group-member-profiles
ACCOUNT_PROFILE  → account-profiles
```

The client request contains no `evidence`, `threadId`, `messageSeq`, Meta
feed ID, source sequence, or `projection`. A visible component derives the
complete demand from the persisted message, relationship, or Group Meta
record, then passes that demand to the profile repository. It does not pass a
second evidence object beside the demand. Backend message evidence projection
is a separate server-only queue because only the backend can revalidate and
commit projection evidence.

`ACCOUNT_PROFILE` is used for an exact account snapshot, including a P2P
message-selected author or a group profile. `GROUP_MEMBER_PROFILE` is used
for a member snapshot through the group origin and includes `groupAccount`.
`ACCOUNT_PROFILE` is used for an exact relationship-intent
snapshot and includes `account`. No generic thread-profile operation and
no legacy `EXACT`, `MESSAGE_AUTHOR`, or `GROUP_META` client selector remains.

All three demand variants carry an exact positive revision. A cache miss may
request only that revision. The client must never replace it with a newer or
older cached profile. The cache key remains
`(publisherNamespaceId, profileNamespaceId, account, domain, rev)`. `PROFILE_AVAILABLE` and
`PROFILE_UNAVAILABLE` wake events carry only that exact key; they do not carry
or reconstruct evidence.
The signed federation profile reads are:

```text
GET /s2s/v1/accounts/:account
GET /s2s/v1/account-profiles/:namespaceId/:account/:profileRev
GET /s2s/v1/group-member-profiles/:groupAccount/:namespaceId/:memberAccount/:profileRev
GET /s2s/v1/account-profiles/:namespaceId/:account/:account/:profileRev
```

These are the only profile-read operations on the federation surface. Respect
canonical percent-encoded path segments and publisher-origin routing:
group/member Meta comes from the group origin;
relation-counterpart account profiles come from the account's home server
(including the origin's internal request for a remote member's message rev);
intent profiles come from the intent author. Publisher authorization, current readable
message range, effective intent and current Group Meta audience/reference, and
uniform `200 NOT_FOUND` for unavailable exact profiles follow the federation
specification. No federation response may substitute another revision.

Do not reinterpret an absent response as `PROFILE_AVAILABLE` and do not retain
a negative cache that prevents later retry. Exact-key fetch failures remove the
pending item; a later demand can retry that five-tuple. Tests cover strict
revision equality and group-origin-to-member-home account requests rather than
local group-member revision drift.

### Internal profile demands

Backend work uses the same namespace-role split internally. It is never stored
with an ambiguous bare namespace name: `publisherNamespaceId` routes and
authorizes the federation request, while `target.profileNamespaceId` identifies
the exact profile subject. `target.account`, `target.domain`, and `target.rev`
complete the immutable profile key. The transport path conversion is explicit:
when `target.profileNamespaceId` is `0`, a subject-domain path variable is
`local`; for a positive namespace it is the retained canonical domain. The
transport peer domain is resolved from local federation state when the request is sent and is not part of the profile resource coordinate.

`lookup` names the actual S2S operation and determines the endpoint:

```ts
interface ProfileTarget {
  profileNamespaceId: number;
  account: string;
  domain: string;
  rev: number;
}

interface ProfileProjectionKey {
  threadId: number;
  messageSeq: number;
}

type ProfilePrefetchDemand =
  | {
      publisherNamespaceId: number;
      lookup: 'ACCOUNT_PROFILE';
      target: ProfileTarget;
    }
  | {
      publisherNamespaceId: number;
      lookup: 'ACCOUNT_PROFILE';
      target: ProfileTarget;
      account: string;
    }
  | {
      publisherNamespaceId: number;
      lookup: 'GROUP_MEMBER_PROFILE';
      target: ProfileTarget;
      groupAccount: string;
    };

type ProfileResolutionDemand = ProfilePrefetchDemand;

type ProfileEvidenceProjection =
  | {
      profile: ProfileKey;
      lookup: 'ACCOUNT_PROFILE';
      projection: ProfileProjectionKey;
    }
  | {
      profile: ProfileKey;
      lookup: 'GROUP_MEMBER_PROFILE';
      groupAccount: string;
      projection: ProfileProjectionKey;
    };
```

`ACCOUNT_PROFILE` always calls `account-profiles`,
`GROUP_MEMBER_PROFILE` always calls `group-member-profiles`, and
`ACCOUNT_PROFILE` always calls `account-profiles`. The common
`target` carries the exact publisher-scoped profile subject identity and
revision. `publisherNamespaceId` completes the cache/pending/wake key and
identifies the request publisher namespace. A resolution demand only fetches
and stores the exact snapshot. It does not contain projection evidence and
never updates thread or Group Meta source coordinates.

Message-landed evidence uses a separate `ProfileEvidenceProjection` queue. It
never fetches profiles. It revalidates the committed `{ threadId, messageSeq }`
coordinate against local durable state and then updates either P2P thread
profile evidence (`ACCOUNT_PROFILE`) or origin Group Meta member evidence
(`GROUP_MEMBER_PROFILE`). Its LRU is independent from the profile fetch LRU and
is keyed by the evidence slot, not by the exact snapshot revision. The stored
LRU value is the greatest successfully applied message sequence; lower or equal
message evidence is skipped, while a greater value waits behind any in-flight
projection for the same slot and is replayed once as trailing work. A no-op DB
projection does not advance the evidence LRU because the durable evidence did
not change. If the evidence queue is full and the item cannot merge into an
existing slot, the update is skipped with a warning; a later message can submit
a greater coordinate.

The demand locates the exact publisher route, profile namespace, revision, and federation endpoint. A
message-landing source may emit both a fetch demand and an evidence projection,
but they are scheduled independently. All other scheduler work is a prefetch
hint without evidence. A system-event sequence may be retained only as backend
lookup context; it is never persisted as profile evidence. Neither
`projection` nor backend source fields are accepted in the client API.
Ordinary non-system messages derive the target from their non-null `creator`
and carried `profileNamespaceId` and `profileRev`. P2P author messages emit an `ACCOUNT_PROFILE` fetch
demand and a separate account evidence projection. A remote member message at a
group origin emits a `GROUP_MEMBER_PROFILE` fetch demand and a separate member
evidence projection; the projection publishes the replacement `MEMBER_UPSERT`
without waiting for the fetch, a media `STUB` commits its evidence at
admission, and a local group member bypasses the
federation scheduler for the same Meta capability.
System messages are the explicit creator exception: their creator is the local
`$system` account and must not become the profile target; event participants
supply any prefetch target instead.

A mirror never creates a Meta item from a member message. It commits its Meta
fact and required fanout first, then submits `GROUP_MEMBER_PROFILE` only as a
prefetch when a selected positive remote-member revision changed. Role-only,
unchanged, zero-revision, departure, and removal cases submit no profile work.
Mirrored Meta prefetch does not use the evidence projection LRU; it continues
to rely on database fences in the Meta application path. Backend projection
authority comes exclusively from local committed message evidence. A client
request cannot supply or trigger a projection mutation. Equivalent client and
internal fetch demands may share one exact-key network request without losing
client listeners.

After each committed message batch, outside its message transaction, source-specific
selectors produce final demands. Ordinary messages use `creator` and the carried
revision; their publisher namespace is the message publisher namespace, and their
target profile namespace is the federated message `namespaceId`. System messages
use event participants rather than the system `creator`. Mirrored Group Meta is
a separate post-commit source: its `MEMBER_UPSERT` supplies the member target,
target profile namespace, and revision, while the mirror group's namespace
supplies the publisher namespace. These sources share the final
`ProfileResolutionDemand` vocabulary but do not share a common evidence shape. Friend-add uses ordinary intent lookup; a mirrored group's remote member
join/role/owner event uses ordinary group-member lookup. Local participants
and events that terminate access yield no prefetch hint. P2P and group callers
both use this helper, then
filter by their own projection authority: for P2P, submit remote peer evidence;
for a group, process member evidence only at the origin, from both locally
authored and remote submissions. Local members use the direct, separate Meta
transaction; only remote members enter the capped profile-fetch scheduler.
Other peers wait for the origin's new Meta item rather than selecting a member
profile from the message. Do not choose the numerically greatest revision,
merge seq and rev from different messages, or call federation for an
uncommitted batch. Submit eligible remote message candidates as internal demands; submit system
event hints only for prefetch. A `GROUP_PROFILE` Meta item commits its group
thread revision and source in the Meta fact/fanout path. **After** that
transaction, a newly selected positive remote revision may submit a prefetch
hint, including after partial delta pages and full recovery batches; unchanged
or zero revisions submit nothing. A full queue may skip opportunistic work without rolling
back message or Meta facts. A later message can resubmit an omitted member
candidate; do not rely on a client demand to publish an as-yet-unpublished
member revision. Existing message prefetch must move to this batch admission
so internal projection work cannot be bypassed by an independent per-recipient
lookup.

The resolver checks the memory LRU, then PostgreSQL `Profile`, then federation.
For a positive network result, it first persists the exact immutable snapshot
in a completed transaction. Only a message projection candidate then attempts
a separate evidence/projection transaction; a prefetch hint is finished once
the snapshot is stored. On a cache hit, skip the redundant snapshot write;
message projection candidates still take their separate evidence path, while
prefetch hints do not. The projection transaction checks stored source ID
(null or strictly smaller), then checks revision (must differ). A failed
ID/revision gate makes no projection write. Snapshot success does not imply evidence success:
revalidate the committed candidate and current authorization when committing
evidence, and do not roll back stored bytes if that attempt fails. For a member
at the origin, a changed remote-member revision
replaces the current `MEMBER_UPSERT` with a newly allocated `feedId`, updates
the backend message-source seq, and enqueues durable Meta publication; the
direct local-member path uses the same origin Meta update. For a thread, update
the source and revision together so the existing `threadProfileRev` change
drives the thread feed. After a new snapshot is persisted, populate or touch
the in-memory LRU; do not persist an already stored immutable profile a second
time. The LRU is not a second source of truth. A prefetch hint or client-only
demand persists fetched bytes but never writes a profile source or selected
revision.

Fetch identity is the exact profile key. Internal prefetch and client demand
for the same five-tuple join the same pending item; the item has no method list
or projection behavior. Message evidence projection is scheduled independently
and never changes which federation endpoint is called. An exact non-null
success settles the fetch item after durable profile materialization completes.
`NOT_FOUND` or network failure removes the exact-key item and its sessions so a
later request can retry. Never negatively cache an empty response. SSE emits
only the exact five-tuple on success.

## 5. System messages

System events already carry each participant's immutable `profileNamespaceId`
and `profileRev` and address. Keep that frozen profile reference; do not add a
message-source coordinate to event
content, and remove client-side `correctSystemMessageProfile` and related
profile-rebase behavior. The renderer first reads the five-tuple cache. On a
miss, choose an **ordinary selector by event type**, not a special
system-event evidence selector and not a message-seq lookup:

| Participant in event                                                             | Lookup on a cache miss                                                                                                                  |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Remote participant in friendship add                                             | `ACCOUNT_PROFILE` for the event's frozen revision when the directed intent remains effective                                |
| Remote member joining a mirrored group (or appearing in role/owner changes)      | `GROUP_MEMBER_PROFILE` using the containing group conversation's ordinary group selector and the event's frozen member address/revision |
| Friendship removal or group departure                                            | Cache-only `PROFILE_KEY`; never request a profile for the departing participant                                                         |
| Mirror's own local group member, local group creator, or other local participant | Local five-tuple only; no federation read                                                                                               |
| `$system`, revision zero, or call notice with no participant profile             | No lookup                                                                                                                               |

The containing conversation already identifies the group for an ordinary
group-member selector; no **additional** thread or system-message context is
sent by the client. If the exact namespace and revision is no longer authorized
or retained, use the locally cached snapshot or address fallback. The backend
likewise submits no prefetch demand for friendship removal or group departure. Do not request
or write a different revision, or invent intent evidence for a historical
departure. Ordinary message-row avatars also use their author address and rev
to choose `ACCOUNT_PROFILE` (P2P) or `GROUP_MEMBER_PROFILE` (GROUP); the
message seq is not submitted for profile lookup. System event producer tests
must cover friendship activation/removal, group creation/join/leave, role and
owner changes, and invitation/application acceptance (including mirrored
joins).

## 6. Removal and verification checklist

- Move the currently staged P2P message `threadProfileRev`/`profileSourceId`
  update **out of** `ThreadFeedHeadWriter.advanceInTx` and into the internal
  resolver's post-fetch transaction. The content-head fanout still advances
  message heads, unread counts and previews independently of profile fetch.
  Keep intent-based establishment and mirror-initialization writes in their
  establishment transactions. Audit the analogous group Meta projections: select Meta-derived evidence in
  the Meta fact/fanout path; optional eager prefetch is after commit, never
  inside the Meta transaction.
- Delete revision rebase/drift in the backend coordinator, browser profile
  store/worker and group-member storage, native `native_db_apply_group_member_profile_drift`,
  and system-row correction; remove obsolete special message/system evidence
  selectors, commands, and tests. Do **not**
  remove unrelated unread-count rebase or the bounded profile scheduler.
- Remove evidence from `PROFILE_AVAILABLE` across SSE payloads, client
  protocols, native/browser wake handling, and corresponding tests; do not
  require evidence-specific notification delivery for correct fallback.
- Assert the selected revision and source coordinate travel together through
  thread feed and IndexedDB/native storage, and the server's group-member
  message evidence and newly allocated Meta item. Exercise unchanged rev with
  a newer candidate ID (neither field changes), and decreasing rev with newer
  **message seq** (a new origin Meta ID and revision);
  never use rev magnitude to order candidates.
- Test alternate evidence for one five-tuple, null response, network error,
  exact success, retry after method/item removal, internal-over-client
  precedence, cached profile with pending internal projection, and
  wrong-revision response rejection. Test that a client-only cache miss never
  mutates thread or member evidence and full queues do not roll back message
  or Meta facts.
- Test session-scoped profile notifications: one subscribed session receives
  the key; another session of the same user does not; multiple connections of
  the subscribed session receive it; invalidated sessions and a key whose
  last method failed leave no listeners or pending item. `PROFILE_AVAILABLE`
  carries no evidence. Other SSE
  events must not change delivery semantics.
- Test P2P intent-to-message selection, group `GROUP_PROFILE` independent of
  later unrelated Meta items, member Meta-to-message selection, repeated
  upserts, departures and rejoin; local/mirror group invitation acceptance and
  application approval; historical system messages and missing cached bytes.
- Run backend unit and PostgreSQL-backed federation E2E tests, Web unit/build,
  native Rust tests/build, protocol/schema/conformance checks, and database
  migration/schema consistency checks. Review the server DDL, Web and Tauri
  cache recreation separately before rollout.
