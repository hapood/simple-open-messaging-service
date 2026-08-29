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
Identity-derived data, authorization, cursors, retries, and synchronization state are
namespace-scoped.

## Federation transaction context

Every federation entry point which can read or mutate identity-derived state resolves the active
namespace exactly once and carries this context through its complete call graph:

```ts
interface FederationContext {
  domain: string;
  namespaceId: number;
  rootKeyFingerprint: string;
}
```

Nested methods never resolve the current namespace again. A queued retry is a new entry and must
resolve the then-active namespace.

An in-flight operation may finish after its namespace is retired. It keeps its captured namespace
and may commit there. Retirement prevents new work from selecting the namespace; it does not reject
an already-authorized transaction. This gives reset a precise boundary without cancelling or
retargeting work.

## Reset lifecycle

Reset is a short metadata transaction rather than a deletion job:

1. Lock the stable `FederatedPeer` row.
2. Require an identity-mismatch halt and reject an administratively blocked domain.
3. Retire the referenced namespace.
4. Clear `activeNamespaceId` and all holder-specific recognition state.
5. Move the peer back to the unrecognized lifecycle state and append reset audit facts.
6. Publish a client state-feed namespace change for affected local accounts.

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
- peer state, group metadata, message, tombstone, and synchronization cursors;
- pending media, downloads, key cache entries, calls, receipts, and scheduler recovery state.

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

## Client projection and display

Client state feed adds `NAMESPACE_CHANGED` with the public domain, previous namespace, and active
namespace. Web IndexedDB and native SQLite retain the active namespace for every observed federation
domain and persist namespace IDs on remote identities and message authors.

The namespace does not alter the wire address. The client changes only presentation:

```text
remote namespace identity   -> alice@17.example.com.local
local identity              -> alice@local
```

The synthetic `.local` value is never sent to the server and is never stored as the identity's
public domain.

## Migration

This is a clean-cut schema migration. Existing application data is discarded; no legacy identity,
reset generation, tombstone, or compatibility projection is retained. The new schema is recreated,
then the permanent `(0, 'local')` identity namespace is inserted before normal writes resume.
