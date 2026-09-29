# Federation identity namespaces

## Purpose

A federation domain is a stable public identity name, not a connection target, but its verified
holder can change. A destructive reset must not delete history or let a newly verified holder
inherit the previous holder's users, relationships, authorization, synchronization cursors, or
pending work. Conversely, the same holder may legitimately move to a new public domain; identity
must survive that move without touching any stored fact.

The database therefore separates identity from domain through integer namespaces, and the wire
separates identity from domain through the local-subject marker and the peer-assigned namespace.
Locality, ownership, and receipt association are decided by namespace coordinates only. A domain
string is a routing and display coordinate; no query, converter, or authorization decision may
compare a domain with the local configuration domain to decide that a subject is local.

## The three namespace coordinates

| Concept                                                        | Scope                                                                                                       | Wire field                                                                | Local storage                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Publisher namespace (`publisherNamespaceId`)                   | Local to the receiving server; one verified identity epoch of one peer                                      | never serialized as a profile field; inferred from the authenticated peer | `IdentityNamespace.id` referenced by peer-owned rows                         |
| Profile-subject namespace (`profileNamespaceId`)               | Local to one publisher; identifies the subject inside that publisher's store                                | `namespaceId` in a profile/subject reference                              | stored verbatim on the receiving side as part of the reference               |
| Peer-assigned local namespace (`peerAssignedLocalNamespaceId`) | The namespace one peer allocated for THIS server's identity; one per relationship epoch                     | disclosed in `Recognize` `recognized` and positive `HealthResult`         | column on the local `IdentityNamespace` row for that peer                    |
| Sender-assigned local namespace                                | The namespace THIS server's local store allocated for one peer's identity epoch; one per relationship epoch | `namespaceId` in the `Recognize` request body                             | disclosed to the peer, which stores it as its `peerAssignedLocalNamespaceId` |

`IdentityNamespace.id` remains the local publisher namespace: routing, authorization,
synchronization, quotas, and integrity checks key on it. Namespace `0`, domain `local`, is the
permanent namespace for every local identity; verified remote holders use positive IDs.

`peerAssignedLocalNamespaceId` is stored on the row representing the peer (not on the peer's
subjects). It changes only when the peer re-establishes our identity after the previous epoch is
retired; within an epoch it is stable and is refreshed from recognition responses.

## Wire encoding rules

The wire contract is defined normatively by `spec/v1/protocol.md` Section 6.2.1; this section
records the implementation consequences.

Outbound serialization by publisher P:

- A subject hosted by P itself is sent as `domain: "local"` with `namespaceId: 0`. P performs no
  local-to-real-domain conversion anywhere on the outbound path.
- A subject hosted elsewhere is sent as the domain P currently retains for it (which may be stale
  after the subject's home renamed itself; the value is display-only) with `namespaceId` equal to
  P's namespace for that subject's home-server identity. When P re-serves a subject it received
  from another server, P re-encodes the reference into its own namespace space this way; the
  carried `profileRev` stays the exact revision P retained. For profile reads, this address
  conversion is applied at the request boundary: a zero profile namespace is serialized with
  `domain: 'local'` (including `memberDomain` path variables), while a positive profile namespace
  uses the retained canonical domain; the stored profile target is not mutated.

Inbound conversion by receiver R from authenticated peer P (converter owns this and only this):

- `domain: "local"` is validated first. Only `namespaceId: 0` is valid and denotes P's own subject. A positive namespace together with `local` is structurally contradictory and MUST be rejected or skipped; it MUST NOT enter the self-subject path merely because it equals `peerAssignedLocalNamespaceId(P)`.
- For the valid `domain: "local"`, `namespaceId: 0` case, store the publisher-scoped subject as `(account, domain: 'local', publisherNamespaceId = captured namespace of P, profileNamespaceId = 0)`. The authenticated peer's current public domain remains routing/provenance context, not the subject domain.
- For a non-`local` domain, `namespaceId == peerAssignedLocalNamespaceId(P)` → R's own subject mirrored in P's store. This is the receipt/self-subject path: for a message item with non-null `originSeq`, locate the local message with that origin coordinate and write the processing receipt; a missing target is a warning, not an error, and the carried profile reference is not rewritten. For a Group Meta member item, the member is one of R's local users and is normalized accordingly.
- Any other non-`local` combination → foreign subject: store with the wire `profileNamespaceId`, the publisher namespace of P, and the domain as received (display-only).

No inbound or outbound converter may consult the configured local domain. The only domain
comparisons remaining in the codebase are: the storage convention `domain = 'local'` for local
rows (paired with `namespaceId = 0`), signature/discovery hostname validation, and administrative
routing.

## Profile resolution

A stored profile reference is the five-tuple `(publisherNamespaceId, profileNamespaceId, account,
domain, profileRev)`.

- `publisherNamespaceId = 0` together with `profileNamespaceId = 0` is the only local profile
  path: rows with `domain = 'local'`, written by the local profile store.
- When this server requests a five-tuple profile from a peer and the wire `namespaceId` is `0`,
  the request selects the peer's own local subject, uses `local` in any subject-domain path
  variable, and the peer serves it from its local profile store.
- A positive wire `namespaceId` selects the namespace the publisher holds for a foreign identity;
  the publisher serves the exact snapshot it retained under that identity.
- Equality between a wire `namespaceId` and the stored `peerAssignedLocalNamespaceId` for that
  peer identifies this server's own subject; it never authorizes a different lookup path by
  itself, it only selects receipt/self-subject processing at the message and meta boundary.

All profile and identity queries select by namespace coordinates; none compares a domain with the
configuration domain.

## Domain and namespace ownership

`IdentityNamespace` is the sole peer aggregate. Each row stores one immutable verified identity
and its current route domain, lifecycle/trust state, health evidence, and activity flag. The
`active` flag identifies the namespace available to new federation work; the nullable
`peerAssignedLocalNamespaceId` is the namespace the holder disclosed for this server.

The database enforces:

- a namespace belongs to exactly one public domain, and a domain has at most one unretired
  namespace;
- at most one unretired namespace per root-key fingerprint, so root-identity matching during
  recognition is unique by construction;
- at most one positive namespace is active for each current route domain.

Foreign keys from peer-owned state reference `IdentityNamespace.id` alone. The domain columns on
those rows are provenance and display: after a domain re-binding they may legitimately differ from
the peer's current domain, which is exactly why no query may treat them as identity. Composite
`(domain, id)` foreign keys are removed for the same reason.

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
namespace captured by its wake or durable state, which need not equal the thread authority
namespace. An in-flight operation may finish after its namespace is retired; it keeps its captured
namespace and may commit there.

## Reset lifecycle

Reset remains a short metadata transaction: lock the active namespace, require an identity-mismatch halt,
retire it, clear its activity and holder-specific recognition state (including the peer-assigned
value), and leave no active namespace for the domain. No business row is
deleted; no replacement namespace is created during reset. A later successful identity verification
creates a new namespace, atomically activates it, and discloses a fresh
`peerAssignedLocalNamespaceId` to the peer on the next recognition exchange.

## Persistence boundaries

Rows whose identity or processing coordinate is owned by a verified peer carry a namespace foreign
key to `IdentityNamespace.id`. Public domain columns remain for routing, wire serialization,
diagnostics, and readable query plans; they are not identity boundaries. Local identities use
`domain = 'local'` with `namespaceId = 0`; remote identities use the positive namespace captured
by their federation transaction with the domain as last seen.

`MessageThread.authorityNamespaceId` identifies the immutable thread authority.
`FederationThreadSyncState` is keyed by `(threadId, namespaceId)`, and
`FederationThreadHistoryGap` carries its source namespace, so a locally authoritative group tracks
several remote publisher coordinate spaces independently.

Relationship and client-state facts use the federation context namespace whenever either endpoint
is federated; namespace `0` is used only when both endpoints and the complete fact are local.

## Local sending boundary

A local message-send request is allowed when the target thread's authority namespace is `0`, or
when it equals the active namespace of its owning federation domain. A remote authority namespace
which is archived, or a domain whose active namespace is null, disables local sending with
`FEDERATION_NAMESPACE_INACTIVE` without changing the thread lifecycle. The check reads the
namespace, never a domain comparison.

The local-send check is not applied to inbound federation writes, an already-running
synchronization round, history-gap recovery, or system-message insertion. On process startup the
scheduler restores only work whose thread authority namespace is active, and after a network
failure it rechecks that namespace before scheduling and before executing a retry.

## Client projection and display

Web IndexedDB and native SQLite keep equivalent logical tables with a namespace registry,
`MessageThread.authorityNamespaceId`, and publisher namespace IDs on remote identities. UI
identity keys and roster cursors encode the explicit JSON tuple `[namespaceId, domain, account]`.

The synthetic presentation domain for archived identities (`alice@17.example.local`) remains a
client display convention only. Because the wire no longer converts `local`, client-side message
authors received from the server already carry the canonical stored form; clients must not
re-derive locality from domains either.

## Domain re-binding

A peer that changed its public domain re-enters through `recognize`: the recipient matches the
presented root key against its unretired namespaces instead of resolving by domain, records a
pending re-binding, and an administrator approves or rejects it. Approval re-binds the peer and
its live namespace to the new domain; every namespace-scoped fact keeps working unchanged. The
complete flow, its schema adjustments, and its security analysis are defined in
[Domain re-binding](./federation-domain-change.md).

## Migration

This is a clean-cut application contract; deployment resets local data. No legacy reader,
domain-keyed locality check, or composite domain foreign key is retained. A fresh database inserts
the permanent `(0, 'local')` identity namespace before normal writes resume.
