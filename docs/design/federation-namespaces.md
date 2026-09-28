# Federation identity namespaces

## Purpose

A federation domain is a stable public identity name, not a connection target, but its verified holder can change. A destructive
reset must not delete history or let a newly verified holder inherit the previous holder's users,
relationships, authorization, synchronization cursors, or pending work.

The database therefore separates the public domain from a local integer namespace. One namespace is
created when a remote identity is first verified, or when an identity is verified after a reset.
Revalidating the current identity does not create another namespace. These local namespace IDs are
publisher namespaces: they identify the peer version recognized by this server and are used for
routing, authorization, synchronization, quotas, and local integrity checks.

Federation message envelopes also carry a field named `namespaceId`. That field is not a publisher
namespace and must not be interpreted as this server's `IdentityNamespace.id`. In a message envelope,
`namespaceId` is the current publisher's profile-subject namespace for the message author. Outside
that envelope, documentation and APIs must use explicit names: `publisherNamespaceId` for the local
recognized peer version, and `profileNamespaceId` for the publisher-scoped profile subject value.
A durable profile identity is the combination `(publisherNamespaceId, profileNamespaceId, account,
domain, profileRev)`; the profile namespace alone is intentionally opaque outside the publisher
that emitted or disclosed it.

| Concept | Scope | Federation wire | Local implementation |
| --- | --- | --- | --- |
| Recognized publisher identity version | Local to the receiving server | Inferred from the authenticated peer; never sent as a profile field | `publisherNamespaceId`, backed by `IdentityNamespace.id` |
| Profile-subject namespace | Local to one publisher | `namespaceId` in a profile reference | `profileNamespaceId` |
| Complete immutable profile key | Local storage | No single wire field | `(publisherNamespaceId, profileNamespaceId, account, domain, profileRev)` |

When this server consumes a federation object, it maps the authenticated peer's captured
`IdentityNamespace.id` to `publisherNamespaceId` and the object's wire `namespaceId` to
`profileNamespaceId`. When it sends a profile request, `publisherNamespaceId` selects the peer and
`profileNamespaceId` becomes the request path's `:namespaceId`. The local publisher namespace is
never serialized as a profile field.

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

Administrative peer blocking, routing, and lifecycle audit remain domain-scoped. Federation quota overrides, usage, allowances, and breaker flags belong to the identity namespace; a newly verified identity starts with default limits and fresh counters.
Identity-derived data and authorization are namespace-scoped. A thread owns one immutable authority
namespace. Incoming synchronization states and history gaps additionally carry their source
namespace: one locally authoritative group receives independent streams from multiple peers.

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

Nested methods never resolve the current namespace again. A synchronization round uses the source
namespace captured by its wake or durable state, which need not equal the thread authority namespace.

An in-flight operation may finish after its namespace is retired. It keeps its captured namespace
and may commit there. Retirement does not cancel or retarget an already-running operation.
Inbound federation processing keeps the captured namespace and the thread's bound coordinate
space; it is not redirected to a replacement identity. Local sends, startup recovery, and retries
have separate admission checks described below.

## Reset lifecycle

Reset is a short metadata transaction rather than a deletion job:

1. Lock the stable `FederatedPeer` row.
2. Require an identity-mismatch halt and reject an administratively blocked domain.
3. Retire the referenced namespace.
4. Clear `activeNamespaceId` and all holder-specific recognition state.
5. Move the peer back to the unrecognized lifecycle state and append reset audit facts.

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

`MessageThread.authorityNamespaceId` identifies the immutable thread authority.
`FederationThreadSyncState` is keyed by `(threadId, namespaceId)`, and
`FederationThreadHistoryGap` also carries its source namespace. A composite foreign key ensures
that a state's active gap belongs to both the same thread and the same source. Local authorities
can therefore track several remote publisher coordinate spaces without mixing their progress.

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

The local-send check is not applied to inbound federation writes, an already-running
synchronization round, history-gap recovery, or system-message insertion. Those operations remain
bound to the existing thread and may finish after a namespace transition.

Permission to finish does not imply permission to restore or retry work indefinitely. On process
startup the scheduler restores only work whose thread authority namespace is active. After a
network failure it checks that namespace before scheduling and immediately before executing a
retry; work with an inactive thread authority namespace is removed.
A locally authoritative group remains writable when one of its remote members belongs to an
archived namespace because the group thread itself is owned by namespace `0`.

## Client projection and display

Web IndexedDB and native SQLite use equivalent logical tables. Both maintain a namespace registry,
persist `MessageThread.authorityNamespaceId`, and persist publisher namespace IDs on remote
identities. Message authors additionally carry a publisher-scoped profile namespace from the
federation envelope. SQLite enforces local publisher-namespace references with foreign keys.
IndexedDB cannot declare foreign keys, so its repositories validate the same local references within
the write transaction; publisher-scoped profile namespace values are stored only together with their
publisher namespace.

Client identity and group-member rows use `namespaceId` for the registered publisher namespace,
while `domain` remains the claimed wire address. This client column is an identity/publisher
coordinate, not the wire profile-reference field of the same name. Profile references and cache
rows separately retain `profileNamespaceId`. UI identity keys and roster cursors encode the explicit
JSON tuple `[namespaceId, domain, account]`; pagination compares those fields directly.

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
public domain. A thread bound to an archived remote namespace hides its composer.

## Migration

This is a clean-cut application contract. No legacy reset method, reset generation, tombstone, or
runtime compatibility reader is retained. Schema migration establishes the new constraints; a
fresh database inserts the permanent `(0, 'local')` identity namespace before normal writes resume.
