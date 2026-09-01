# Profile Version Storage and Resolution

Status: implemented.

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
  revision referenced by the current relationship request flow;
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
member. A newly read message updates only its author's reference in that
message's group, ordered by message `seq`; the immutable revision number is not
used as a clock. The resolved name and avatar are written back only if the
member still selects that exact revision. Consequently, one account may render
with different revisions in different groups without a global User projection
overwriting either group. The same mechanism leaves room for an author to
select different retained revisions per friendship or group while the current
sender defaults to `defaultProfileRev`.

Relationship intents carry the source account's revision selected for that
request flow. A profile update must not rewrite or republish the intent. An
incoming positive intent may trigger exact-revision resolution after the
backend has validated the durable intent and the owner's disclosure policy.
For an established P2P relationship, only a later peer-authored message reveals
a changed profile reference.

For this implementation, a direct remote user-profile lookup is authorized
only when the effective locally authored Relationship Intent toward the
requesting peer carries the requested revision. A direct group-profile lookup
is authorized against the requesting peer's current Group Meta
`GROUP_PROFILE` allocation. These are local authorization-index choices, not
additional federation wire requirements.

## 4. Backend resolution coordinator

One application-wide singleton owns remote profile work. It has two entry
paths:

- account resolution: `(domain, account, rev)`; `rev` is always required;
- message resolution: `(publisherDomain, normalizedThread, messageSeq)`; the
  remote response must match the revision carried by that message.

The coordinator first checks durable local profile versions. A miss joins an
in-flight map; equal normalized keys share one job and one backend-generated
`requestId`.

An account/revision response is stored as a complete immutable profile version.
A Message Author Profile response deliberately omits `bio`, so it is stored in
a separate referenced-display record containing only `(user, rev, name,
avatar)`. It must not be promoted to a complete profile version or move the
user's default pointer. This disclosure-limited record lets a group origin or
other direct publisher continue serving the exact display snapshot after the
upstream peer becomes unavailable.

Completed immutable-key results use an access-ordered LRU capped at 1,000
entries. The in-flight map is separate and is never evicted by the result LRU.
Every success cache key contains an explicit revision. Permanent disclosure
failures may use a short bounded negative cache, but they must not occupy the
immutable success cache indefinitely.

The authenticated client endpoint accepts either an exact
`(domain, account, rev)` selector or a local `(threadId, messageSeq)` selector.
It rejects a selector without either revision or exact message coordinate. Its
response union is:

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
