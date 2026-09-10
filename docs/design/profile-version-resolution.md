# Profile Version Storage and Resolution

Status: profile-version storage, exact account/message/group-member resolution,
shared client dispatch, and bounded backend scheduling are implemented.

## 1. Scope and separation

This document is the SOMS implementation design. The federation documents in
[`spec/v1`](../../spec/v1/README.md) define only peer-observable wire behavior;
they do not prescribe the tables, NestJS providers, RxJS graph, LRU container,
or component lifecycle described here.

The change has four goals:

1. retain immutable profile versions while keeping one local default revision;
2. resolve remote profiles without putting names, biographies, or avatar bytes
   in State Feed, Group Meta, relationship intents, or message wire objects;
3. merge duplicate backend and frontend resolution work; and
4. deliver asynchronous results through the existing authenticated `/events`
   realtime stream together with `MEDIA_STATUS`.

The temporary `/user/resolve-federated-stream` remains an add-friend lookup
surface only. Thread lists, message items, incoming-intent UI, and group
management must use the new session-authenticated profile-resolution API.

## 2. Profile storage and update

One immutable profile-version record contains:

```ts
interface ProfileVersion {
  account: string;
  domain: string;
  rev: number;
  name: string;
  bio: string;
  avatarBase64: string | null;
}
```

Each local user or group stores `defaultProfileRev`. A successful update creates
a new complete version and moves that default pointer to it in one transaction.
The pointer is only a local authoring default; federation peers cannot query it,
and a future implementation may select another retained revision for a
particular peer. An older version is never updated in place.

Within one account, a revision is permanently bound to one immutable version
and is never reused. `defaultProfileRev` is an authoring default, not an active
or validity flag. Moving it does not deactivate an older retained version.

Name, biography, and avatar are one update operation. The client submits one
JSON body containing the complete name/bio values and an optional Base64 avatar
value. The backend validates decoded byte size, canonical Base64, magic bytes,
image dimensions, decompression limits, and supported formats before image
normalization and the database commit. Omitting the avatar field preserves the
current avatar; an explicit `null` removes it in the new revision.

Historical profile data is a soft retention dependency. Storage degradation
SHOULD preserve versions referenced by serviceable messages and current Group
Meta projections. If cleanup must remove one, it must not rewrite a message to
another version or delete otherwise retained message content.

## 3. Message and Group Meta binding

The federation message wire carries the selected author's `profileRev`. When a
server commits a message copy, that field becomes part of the immutable
publisher-local `(thread, seq)` object. Replaying that coordinate always carries
the same revision.

For a P2P thread:

- before any peer-authored message is available, the thread list uses the
  default revision retained by the account-owned `THREAD_STATE` snapshot;
- after messages are loaded, the profile bound to the greatest `seq` authored
  by the peer becomes the thread display profile;
- a locally authored message never replaces the peer's thread avatar; and
- the numeric revision alone does not order messages—the greatest qualifying
  thread `seq` wins.

For a group thread, member-message profiles do not select the thread avatar.
The greatest committed Group Meta `GROUP_PROFILE.feedId` selects that item's
exact `profileRev`; the client resolves the group `(account, rev)` and uses that
result for the thread avatar. It never compares group profile revisions.

Each group roster also stores a group-scoped profile reference for every
member. The member-authored join intent selects the initial exact reference in
canonical Group Meta without display bytes. A mirror resolves it only through
Group Member Profile on the group origin. A newly read message may
later update only its author's reference in that message's group, ordered by
message `seq`; the immutable revision number is not used as a clock. The
resolved name, biography, and avatar are written back only if the member still
selects that exact revision in the client. It does not update canonical Group
Meta or the mirror server's latest replicated member `UPSERT.profileRev`.
Consequently, one account may render with different revisions in different
groups without a global User projection overwriting either group.
The same mechanism leaves room for an author to select different retained
revisions per friendship or group while the current sender defaults to
`defaultProfileRev`.

A locally authored message reads the sender's `defaultProfileRev` in the
message commit transaction and stores that exact value on the immutable message
row. Copies, group submissions, authoritative group distributions, and receipts
preserve the incoming revision. Per-thread authoring defaults are deliberately
deferred; this version has one account-level `defaultProfileRev`.

Relationship intents carry the source account's revision selected for that
request flow. A profile update must not rewrite or republish the intent. An
incoming positive intent may trigger exact-revision resolution after the
backend has validated the durable intent and the owner's disclosure policy.
This is independent warm-up: group membership, canonical Group Meta, audience,
and head fan-out commit without querying the profile store or waiting for the
coordinator.
For a group join, the committed member-authored `REQUESTED` is sufficient
authorization for the group origin to start that exact warm-up; bilateral active
membership is not a download precondition. A later member UPSERT reuses the
request revision.
For an established P2P relationship, only a later peer-authored message reveals
a changed profile reference.

For this implementation, a direct remote user-profile lookup is authorized
only when the effective locally authored Relationship Intent toward the
requesting peer carries the requested revision. A direct group-profile lookup
is authorized against the requesting peer's current audience and the canonical
Group Meta `GROUP_PROFILE` reference. These are local authorization-index choices, not
additional federation wire requirements.

## 4. Backend resolution coordinator

The client API uses the shared discriminated `ProfileSelector` union: `EXACT`,
`MESSAGE_AUTHOR`, or `GROUP_MEMBER`. Thread defaults use `EXACT`; there is no
thread-default selector. A matching account-owned `THREAD_STATE` grants access
to its retained exact version, including after revocation. Re-establishment
can replace that reference; ordinary profile changes cannot. See
[account-owned thread state](thread-state.md) for the publication and recovery
contract. Every resolved client profile also carries its captured `namespaceId`.


One application-wide singleton owns remote profile work. It has three entry
paths:

- account resolution: `(domain, account, rev)`; `rev` is always required;
- group-member resolution: `(groupOrigin, groupAccount, memberAddress, rev)`;
- message resolution: `(publisherDomain, normalizedThread, messageSeq)`; the
  remote response must match the revision carried by that message.

For a native author, message and group-member selectors read the exact referenced
revision from the native user in namespace zero, even when the reference arrived
through a foreign authoritative group. Both `local` and the server's canonical
domain identify that native author. A missing native revision returns `NOT_FOUND`;
it never falls back to S2S, a foreign source-scoped self copy, or the latest revision.
Thread and roster authorization still applies before resolving the profile.

For foreign authors, the coordinator first checks durable profile versions. A miss joins an
in-flight registry; equal immutable snapshot
keys share one job and one backend-generated `requestId`. Message coordinates
are candidate authorization proofs for the shared snapshot job rather than
independent HTTP jobs.

Every federation profile response contains `bio` and is stored as the same
complete immutable profile-version shape. Materializing a referenced revision
must not move the user's default pointer. Before appending a positive member
UPSERT, the group origin obtains and retains the join-intent snapshot. It then
serves that group-scoped reference to every authorized mirror, including when
the member's account belongs to another domain. A mirror never serves another
federation peer as authority for the remote group and never redirects it to the
member's account home.

`ProfileVersion` is the only profile-snapshot table. A user version is keyed by
`(userId, rev)` and a group version by `(groupId, rev)`; both store the complete
name, biography, and logical nullable-avatar snapshot. The database encodes a
null avatar as its existing empty-string sentinel. A profile row does not
duplicate `sourceDomain` or `sourceNamespaceId`, because its owning `User`
already carries the materializing namespace.

Profile materialization still accepts the authenticated `sourceDomain` as an
operation argument, but never persists it on the version. If `(owner, rev)` is
absent, the operation inserts the complete snapshot. If it already exists, an
incoming profile whose `sourceDomain` equals the profile's claimed `domain` may
replace that same revision atomically; any other source uses first-write-wins
and cannot overwrite the retained row. Neither case changes
`defaultProfileRev`.

Completed immutable-key results use an access-ordered LRU capped at 1,000
entries. Only completed results count toward this capacity. Queued and active
jobs live in a separate in-flight registry and are never evicted by, or counted
against, the result LRU. Every success cache key contains an explicit revision. Permanent disclosure
failures may use a short bounded negative cache, but they must not occupy the
immutable success cache indefinitely.

### 4.1 Pending queue and HTTP concurrency

An in-flight job is either `QUEUED` or `ACTIVE`. A bounded pending queue feeds a
bounded application-wide HTTP pool; waiting for retry backoff consumes neither
an HTTP slot nor a completed-LRU entry. Equal jobs merge before queue admission.
The pool enforces both a global maximum and a smaller per-peer-domain maximum,
and schedules domains fairly so one history drain cannot monopolize every
connection.

Priority is, from highest to lowest: a group origin's required snapshot before
authoritative distribution, an interactive UI request, a newly committed
message warm-up, and historical background warm-up. Queue pressure may drop a
background warm-up because rendering can enqueue it later. It must not silently
drop a snapshot required before group distribution; that path applies
backpressure to message promotion.

The pending queue is bounded independently from active concurrency. Completed
successes leave the in-flight registry before entering the result LRU. A
temporary failure uses bounded jittered backoff; a permanent disclosure failure
completes every joined waiter without changing relationship or peer lifecycle.

The authenticated client endpoint accepts an exact `(domain, account, rev)`, a
group-member selector whose revision is read from the local current roster
projection,
or a local `(threadId, messageSeq)` selector. A UI caller does not invent a
group member revision. The backend supplies the exact committed reference to
the federation request. The endpoint rejects a selector without an applicable
durable revision or exact message coordinate. Its response union is:

```ts
type ProfileResolutionStart =
  | { status: 'READY'; profile: ResolvedProfile }
  | { status: 'PENDING'; requestId: string };
```

A local durable/cache hit returns `READY` directly. A new or reused remote job
returns `PENDING`; reuse returns the existing job's `requestId`.

The client never ignores this HTTP response. It consumes `READY` as the
terminal result and uses the backend-generated `requestId` from `PENDING` to
correlate exactly one terminal result from the shared realtime stream. SSE is
the asynchronous completion channel, not a replacement for the start response.

`FEDERATION_PROFILE_NOT_DISCLOSED` is the remote policy-denial result. Locally
it is presented as unavailable profile data. It must not enter relationship
denial handling, end a friendship, revoke membership, or degrade a peer.

### 4.2 Message commit integration

An ordinary inbound message page commits messages and its cursor without
waiting for profile HTTP. After commit, each newly selected immutable snapshot
is offered to the global coordinator. A durable/cache hit updates local display
state immediately; a miss enters the bounded queue. Resolution completion
updates a P2P thread avatar only when the selecting message remains the greatest
committed peer-authored `seq`, and updates only the client-side group member
display when that member still selects the exact revision.

A group origin accepting a member submission is stricter: before promoting and
distributing the authoritative copy, it must durably retain the referenced
display snapshot. This mandatory use of the same coordinator is a message-
promotion dependency, not a database transaction dependency.

### 4.3 Forward-bundle snapshots

A forward bundle always stores the source author's Address separately from an
optional frozen display snapshot. Bundle creation reads only the exact durable
profile version selected by the source message's `profileRev`. It must not read
the mutable `User.name/avatar` projection and must not substitute the user's
`defaultProfileRev`.

If that exact version is already durable, the bundle stores `displayName` and,
when present, the avatar's CAS digest. The existing bundle asset closure owns
and deduplicates that digest. If the exact version has not been resolved, bundle
creation omits the entire profile snapshot and continues without waiting for or
enqueuing remote profile work. A known profile without an avatar still stores
its display name; only its avatar digest is absent.

The JSONB bundle message already owns this optional snapshot, and the existing
bundle-to-asset relation owns its CAS references, so this shape requires no new
database column or table. Imported and nested bundles preserve the received
optional snapshot exactly; later resolution does not mutate an immutable
bundle.

## 5. Shared client SSE and race handling

There is exactly one authenticated user realtime downlink: `/events`.
`MEDIA_STATUS`, `PROFILE_RESOLVED`, and `PROFILE_FAILED` are event types on that
same stream. No profile request, message item, or media item opens a second SSE
connection.

The profile event shapes are:

```ts
interface ProfileResolvedEvent {
  requestId: string;
  profile: {
    account: string;
    domain: string;
    rev: number;
    name: string;
    bio: string;
    avatarBase64: string | null;
  };
}

interface ProfileFailedEvent {
  requestId: string;
  reason: 'NOT_FOUND' | 'NOT_DISCLOSED' | 'TEMPORARILY_UNAVAILABLE';
}
```

The client coordinator waits until the shared realtime facade has completed its
`HELLO` handshake before starting a request that may return `PENDING`. It does
not merely wait for the transport socket's `open` state.

The backend generates `requestId`, so an SSE terminal event can race ahead of
the HTTP `PENDING` response. A root-scoped dispatcher subscribes to all profile
events continuously and stores terminal events in a bounded, short-lived map by
`requestId`. After HTTP returns, `awaitResult(requestId)` first checks that map
and otherwise subscribes for the future event. This removes any dependency on
HTTP/SSE delivery order.

If the SSE disconnects and a terminal event is missed, the client retries the
authenticated start endpoint after the next `HELLO`. A completed backend job
has already materialized its profile and therefore returns `READY`; no durable
per-client SSE delivery log is required.

The existing media availability subscription continues consuming
`MEDIA_STATUS` from `/events`. Any separate one-shot or feature-specific SSE
introduced for routine profile or download-status waiting is removed rather
than maintained alongside the shared stream.

## 6. RxJS ownership and cancellation

The client profile coordinator deduplicates equal normalized selectors. Each
component receives an RxJS subscription to shared resolution state.

When a message item is unmounted, an add-friend dialog closes, or group
management closes, that component unsubscribes immediately. This action:

- prevents callbacks and rendering in the destroyed component;
- does not close `/events`;
- does not cancel another subscriber waiting on the same request; and
- does not discard a valid result at application scope.

The root dispatcher still validates and persists a late result in the local
profile store/IndexedDB, so it warms subsequent rendering even when the
initiating component has gone away. A result is ignored completely only when it
is malformed, belongs to another authenticated user/session context, or its
bounded orphan-result entry has expired before it can be safely correlated.

Reference counts may remove an idle frontend waiter, but a backend federated
fetch normally continues: another tab/device may share the job, and completing
it warms the durable store and LRU. Logout clears waiters, orphan results, and
session-scoped request correlation while the realtime facade closes `/events`.

## 7. Client profile and roster cache

The browser IndexedDB and native SQLite caches use the same clean-cut identity
model as the backend. A cached `User` is keyed by
`(account, domain, namespaceId)` and does not persist `sourceDomain`.
`namespaceId` is a foreign-key association to the namespace registry, not a
field of a profile snapshot. A group roster member references the same User
identity and stores its group-scoped selected `profileRev` separately.

Resolved group-member display data consists of `profileName`, `profileAvatar`,
and the required `profileBio` value together with `resolvedProfileRev`. An
absent avatar is represented by the existing empty-string client sentinel; an
absent biography is an empty string. Resolution writes all fields atomically
only while the member still selects the returned revision. The Tauri column
`members.profile_bio` is `NOT NULL`; both client caches are disposable and
recreate the whole cache on a schema-version mismatch instead of migrating or
reading an older shape.

Client identity strings and roster cursors use the explicit JSON tuple
`[namespaceId, domain, account]`. They are parsed and compared field by field;
control-character separators are not a persistence format or hidden client
protocol. NUL rejection and sanitization remain only at input/protocol security
boundaries.
