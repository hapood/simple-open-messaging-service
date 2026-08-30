# Federation identity namespaces

## Purpose

A federation domain is a stable network address, but its verified holder can change. A destructive
reset must not delete history or let a newly verified holder inherit the previous holder's users,
relationships, authorization, synchronization cursors, or pending work.

The database therefore separates the public domain from a local integer namespace. One namespace is
created for each successful identity verification. Namespace IDs are storage-only and never appear
on the federation wire.

## Domain and namespace ownership

`FederatedPeer` is the stable domain aggregate. Its nullable `activeNamespaceId` points at the one
namespace available to new federation work. `IdentityNamespace` stores the immutable root-key
evidence for one verified holder and a nullable retirement timestamp. Namespace `0`, whose domain
is `local`, is the permanent namespace for every local identity; verified remote holders use
positive IDs.

The database enforces:

- a namespace belongs to exactly one public domain;
- a domain has at most one unretired namespace;
- an active namespace referenced by a peer belongs to that peer's domain;
- namespace rows are retained indefinitely and cannot be deleted through the reset workflow.

Administrative blocking, quota accounting, routing, and lifecycle audit remain domain-scoped.
Identity-derived data and authorization are namespace-scoped. A thread owns one immutable authority
namespace; its cursors, retries, and synchronization state are owned transitively by that thread and
do not repeat the namespace ID.

## Federation transaction context

Every federation entry point which selects identity-derived state by domain resolves the active
namespace exactly once and carries this context through its complete call graph:

```ts
interface FederationContext {
  domain: string;
  namespaceId: number;
  rootKeyFingerprint: string;
}
```

Nested methods never resolve the current namespace again. Work for an existing thread instead uses
the immutable authority namespace already bound to that thread. Federation synchronization and
history-gap recovery do not require that namespace to remain active.

An in-flight operation may finish after its namespace is retired. It keeps its captured namespace
and may commit there. Retirement does not cancel or retarget federation work. Active-namespace
validation is performed only when a local user sends a new message to a remotely authoritative
thread; federation processing continues against the thread's bound coordinate space.

## Reset lifecycle

Reset is a short metadata transaction rather than a deletion job:

1. Lock the stable `FederatedPeer` row.
2. Require an identity-mismatch halt and reject an administratively blocked domain.
3. Retire the referenced namespace.
4. Clear `activeNamespaceId` and all holder-specific recognition state.
5. Move the peer back to the unrecognized lifecycle state and append reset audit facts.
6. Append one namespace-archived system message to each affected remotely authoritative
   thread.

No user, group, message, thread, relationship, media, feed, or cursor row is deleted. No replacement
namespace is created during reset. A later successful identity verification creates a new namespace
and atomically activates it.

The legacy reset generation, reset tombstone, background thread truncation, and physical deletion
workflow are removed. Physical deletion is deliberately deferred to a future design.

## Persistence boundaries

Rows whose identity or processing coordinate is owned by a verified peer carry a namespace foreign
key. Public domain columns remain for routing, wire serialization, diagnostics, and readable query
plans, but they are not identity boundaries.

Important namespace-scoped data includes:

- remote user and group projections;
- message source and creator identity;
- remote thread authority and thread audience authorization;
- relationship endpoints;
- peer state, group metadata, message, and tombstone cursors;
- pending media, downloads, key cache entries, calls, receipts, and scheduler recovery state.

`MessageThread.authorityNamespaceId` is the sole owner of a thread's publisher coordinate space and
never changes. `FederationThreadSyncState` is keyed by `threadId`, and
`FederationThreadHistoryGap` belongs to its thread by `threadId`; neither repeats a namespace ID.
This removes an otherwise unenforceable possibility that thread and synchronization rows disagree.

The common integrity shape for peer-owned state is a composite foreign key from
`(peerDomain, namespaceId)` to `(IdentityNamespace.domain, IdentityNamespace.id)`. Namespace
deletion is restricted.

Identity namespace columns are non-null. Local identities use namespace `0`; remote identities use
the positive namespace captured by their federation transaction. Nullable namespace columns are
reserved for optional provenance associations where the whole association is absent, not for an
identity address.

Relationship and client-state facts use the federation context namespace whenever either endpoint
is federated. Both authored directions of the same relationship therefore fold within one
namespace. Namespace `0` is used only when both endpoints and the complete fact are local.

## Local sending boundary

A local message-send request is allowed when the target thread's authority namespace is `0`, or
when it equals the active namespace of its owning federation domain. A remote authority namespace
which is archived, or a domain whose active namespace is null, disables local sending without
changing the thread lifecycle; the server rejects such sends with `FEDERATION_NAMESPACE_INACTIVE`.

This check is not applied to inbound federation writes, an already-running synchronization round,
history-gap recovery, or system-message insertion. Those operations remain bound to the existing
thread and may finish gracefully after a namespace transition. On process startup the scheduler
restores only work whose thread authority namespace is active. After a network failure it checks
the namespace before scheduling and immediately before executing a retry; inactive work is removed.
A locally authoritative group remains writable when one of its remote members belongs to an
archived namespace because the group thread itself is owned by namespace `0`.

## Client projection and display

Web IndexedDB and native SQLite use equivalent logical tables. Both maintain a namespace registry,
persist `MessageThread.authorityNamespaceId`, and persist namespace IDs on remote identities and
message authors. SQLite enforces references with foreign keys. IndexedDB cannot declare foreign
keys, so its repositories validate the same references within the write transaction.

There is no namespace-activation client-state event. Registration is an optimistic, monotonic client
projection: the first newly discovered namespace for a remote domain is active; a newly discovered
greater ID becomes active and archives every smaller ID for that domain. Rediscovering a known row
never changes its status, so an in-flight historical fact cannot reactivate a namespace which the
client has already archived. Namespace `0` is the permanent local active row.

The server remains authoritative for local sends. If it rejects a send with
`FEDERATION_NAMESPACE_INACTIVE`, the client archives the thread's current authority namespace and
suppresses the composer for every thread bound to that domain and namespace. This projection does
not mutate `MessageThread.conversationState`, which independently represents relationship or group
lifecycle. A genuinely new, greater namespace may later become active when normal server data
introduces it.

The namespace does not alter the wire address. The client changes only presentation:

```text
active remote identity      -> alice@example.com
archived remote identity    -> alice@17.example.com.local
local identity              -> alice@local
```

The synthetic `.local` value is never sent to the server and is never stored as the identity's
public domain. A thread bound to an archived remote namespace hides its composer. Its system message
is represented by the structured type `FEDERATION_NAMESPACE_ARCHIVED`; clients may render it as:

> The other server updated the identity binding for this domain. This conversation is archived and
> can no longer send messages.

## Migration

This is a clean-cut application contract. No legacy reset method, reset generation, tombstone, or
runtime compatibility reader is retained. Schema migration establishes the new constraints; a
fresh database inserts the permanent `(0, 'local')` identity namespace before normal writes resume.
