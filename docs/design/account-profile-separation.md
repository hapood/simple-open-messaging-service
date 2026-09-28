# Local accounts and source-scoped profiles

The source schema and [SQL baseline](../../database/migrations/0000_base.sql)
define the account/profile separation.

## Ownership

`Account` owns local user identity, authentication/control state, and the local
authoring default `defaultProfileRev`. Its numeric ID remains the key used by
sessions, preferences, quotas, and per-account delivery state. Its public
`account` address is unique. Local domain and namespace are always `local` and
`0`, enforced by constraints on the local account row.

`GroupAccount` owns local group identity, the local authoring default
`defaultProfileRev`, creation time, and authoritative dissolution state. Its
public account starts with `!`. It has no passwords, sessions, login capability,
or per-user delivery state. A mirrored group never receives a `GroupAccount`.

Neither account table contains display names, avatars, or biographies. Those
values belong exclusively to versioned profiles.

## Profiles

`Profile` stores immutable complete profile snapshots under the unique key
`(publisherNamespaceId, profileNamespaceId, account, domain, profileRev)`. The
`!` account prefix distinguishes
group profiles from user profiles. A snapshot contains a display name, avatar,
biography/description, and storage timestamp. It has no `userId`, `groupId`,
default-version pointer, membership, authorization, or dissolution state.

`publisherNamespaceId` identifies the local publisher context through which a
snapshot was obtained or authored. It is not necessarily the server named in
the subject's domain. `profileNamespaceId` is the profile-subject namespace
assigned by that publisher and carried by its federation reference or response.
It has no meaning without `publisherNamespaceId`; both remain part of the key
even when two publishers return the same account, domain, and revision.

An unresolved profile is represented by its reference in a message, relationship,
or roster entry. It does not require an empty profile row or a synthetic remote
account. A profile row exists only when that exact version has been resolved.

Local user profile updates lock the owning `Account`; local group profile
updates acquire the existing group business lock. Each update allocates an unused
revision, inserts the complete profile, and advances `defaultProfileRev` within
the same transaction. Group profile updates do not acquire an additional explicit
`GroupAccount` row lock. Existing snapshots are never overwritten. Runtime
readers use the exact namespace and revision selected by their context rather
than a global latest-profile projection.

## Group threads and membership

`MessageThread` retains the group address and authority namespace independently
of profile availability. A local group thread links to its `GroupAccount`; a
mirror has no such local owner row. Mirror lifecycle state belongs to the thread's
replicated group state and is not stored in a profile snapshot.

Group Meta feeds, synchronization tasks, and roster entries refer to the group
thread instead of a removed `Group.id`. Roster entries carry member address and
namespace directly instead of referencing a removed `User.id`.

`RelationshipPair` already stores addressed endpoints. Its callers must operate
on those coordinates rather than materializing a remote user to obtain an ID.
Local delivery resolves an endpoint to `Account.id`; source membership facts do
not grant login capability or create an `Account`.

## Client identity and profile selection

The source coordinate of a message or roster fact remains distinct from the
identity/profile coordinate of its subject. A local-account mapping must not
erase the source namespace used for synchronization, replay, or archival.

The implementation keeps three coordinates separate:

| Coordinate | Meaning |
| --- | --- |
| Subject address | Stable `account + domain`; local storage may normalize this server's public domain to `local` |
| Publisher namespace | Local `IdentityNamespace.id` of the server that emitted or disclosed the profile reference |
| Profile namespace | Opaque subject namespace carried by that publisher |

For a locally authored profile, both namespace values are `0`. For a consumed
federation reference, the captured peer identity supplies `publisherNamespaceId`
and the wire `namespaceId` supplies `profileNamespaceId`. A group origin that
serves a retained member snapshot becomes the publisher for that response even
when the member's subject domain names another server. Source coordinates remain
on the enclosing feed or message and are not inferred from the subject address.

The server projects the normalized identity to the client and
resolves the exact message- or roster-selected profile version locally. It does
not substitute the current default or request the group publisher for a missing
local version. Profile resolution reads the stored subject namespace directly;
it does not independently infer a namespace from the subject domain. Federation
serialization expands the local domain sentinel back to the public domain.

MEMBER_UPSERT, MEMBER_DEPART, message-author serialization, profile-cache keys, and self/member
matching must use the same mapping. IndexedDB and native SQLite must agree. The
source group namespace remains attached to the enclosing group synchronization
coordinate even when a roster subject maps to namespace `0`.

Client `users` and `groups` profile projections are removed in favor of exact
profile references and a shared versioned profile cache. Threads and roster
entries continue to exist when a referenced profile is not cached. Session
account identity is retained separately from display information.

## Removal and verification

The implementation removes the old source-user materialization helpers and all
`User`/`Group` foreign-key dependencies. It does not preserve the old API internally
through compatibility views or create default-profile rows for unresolved peers.
Historical data recovery and conversion are outside this change. Previously
published SQL migrations remain immutable; a new migration expresses the schema
transition without operating on the running federation lab during development.

Verification must cover:

- local user and group creation, profile update atomicity, and exact old-version reads;
- unresolved P2P endpoints and roster members without any profile/account row;
- separate cached versions for the same foreign subject through different publishers;
- local subjects in mirror rosters and messages, including MEMBER_UPSERT/MEMBER_DEPART identity matching;
- namespace retirement without retargeting retained messages or profiles;
- friendship activation/removal, group leave/kick/dissolution, rollback, and replay;
- system-message recipients when multiple local accounts share one mirrored group;
- equivalent IndexedDB and native SQLite projection and profile-cache behavior.

## Implementation checkpoint

The source schema now defines local `Account`, local `GroupAccount`, and addressed
`Profile` snapshots. Local user profile writes use the account default pointer and
immutable snapshots. The former source-user materialization helper and foreign
user localization methods have been removed.

Group Meta member facts and group-request projections now carry member address
and namespace directly. Mirror ingestion normalizes local subjects without an
account lookup. Local delivery and role projections still resolve real account
IDs. Federation source authorization and query-denial convergence inspect active
relationship endpoints directly; they do not require foreign account rows.
Existing authorization-epoch checks continue to reject stale query failures. Group dissolution enumerates relationship endpoints, including foreign
members, without joining an identity table.

Messages now keep `sourceNamespaceId` for the direct publisher/source and
`profileNamespaceId` for the author's profile namespace. Incoming messages
normalize their creator identity without changing `sourceNamespaceId`. Profile
resolution reads the stored message/member namespace and does not fetch a
missing local revision from a group publisher.

P2P peer queries and the group invitation picker derive foreign identities from
relationship endpoints. The invitation picker now paginates by P2P thread ID.
Its client presentation uses addressed identities instead of synthetic user IDs.

IndexedDB and native SQLite now store exact snapshots in `profiles`; the old
`users` and `groups` caches and their lookup commands have been removed. Roster
rows retain identity, role, and selected revision, and join profiles for display.
Missing snapshots do not hide members or abort message rendering. Resolved
message profiles are cached under their exact subject coordinates and revision.

Client subject normalization maps the local sentinel or namespace zero to
`local / 0`. It does not rewrite a message's source namespace or a mirrored
group's authority namespace. Profile facts update only matching namespaces in
both persistent and in-memory thread projections. Conflicting exact snapshots
abort the IndexedDB transaction, preserving the previous state-feed cursor.

The old Group table is now removed. MessageThread carries group coordinates and
mirror state; a read-only query joins local GroupAccount controls and exact Profile
snapshots. Mirror presentation selects GroupMetaProfileFeed.profileRev directly.
There is no additional committed-profile pointer or whole-round snapshot mechanism.
Group transactions retain their existing boundaries and business locks without an
extra explicit GroupAccount row lock.

Call initiation now identifies the authorized P2P thread. Foreign peers have no
synthetic Account ID in routing, signaling, busy slots, or stored call content.

Migration 0003 expresses the cutover and requires empty old business tables. It
performs no historical data conversion and has been applied only to isolated E2E
databases. Never start the new source against an unmigrated database.

Database-backed regression coverage includes:

- `test/account-profile-separation.e2e-spec.ts`: removed tables, concurrent local
  group profile updates, publication rollback, and immediate mirror profile selection.
- `test/federation-thread-parent-lock.e2e-spec.ts`: group business scope ordering
  and thread allocation without an extra group-account control-row lock.
- `test/friend-added-transaction.e2e-spec.ts` and
  `test/departure-system-message.e2e-spec.ts`: transactional system messages,
  rollback, replay, local/foreign departures, and shared-mirror local recipients.
- `test/local-author-profile-resolution.e2e-spec.ts`: local roster/message
  subjects resolve through namespace zero while retaining the foreign source scope.
- `test/federation-address-friend.e2e-spec.ts`: addressed foreign friendships,
  pending request refreshes, and outgoing withdrawal without remote account rows.

The two-node federation and reverse-round suites additionally exercise real signed
traffic, shared mirror membership, leave/rejoin boundaries, and message receipts.
