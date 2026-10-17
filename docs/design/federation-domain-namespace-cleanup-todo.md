# Federation Namespace Identity and Remaining Cleanup

## Current model

Domain is transport, discovery, binding, or display metadata, not an identity
coordinate. Account identity is `{ account, namespaceId }`. Exact profile
identity is `{ publisherNamespaceId, profileNamespaceId, account, rev }`.

- Message rows use `creatorAccount`, `publisherNamespaceId`, and
  `profileNamespaceId`; profile selection includes the exact revision.
- Group message wire authors are `{ account, namespaceId }`; P2P authors are
  `{ ref, namespaceId }`. Neither carries an author domain.
- Group Meta uses `{ feedId, operation, body }`; member identity is the body's
  `account` and `namespaceId`, scoped to the group origin.
- Peer and client state feeds use `subjectNamespaceId` for subject identity.
  Transport domains do not participate in exact profile keys or profile demands.
- User mentions use `somfp://user/<namespaceId>/<account>`. In groups, the
  namespace belongs to the group origin, regardless of the publishing home.
  The complete namespace/account pair determines a match. An unknown viewer
  namespace is not namespace zero; `@all` remains a separate entity.
- Federation preserves valid message content across hops without rewriting
  mention namespaces or CONTACT_CARD subjects.
- CONTACT_CARD client targets contain account, namespace ID, and profile
  revision. The server resolves the wire domain from the namespace binding.
  The retained public key identifies the card subject's home, not a message
  author, and receipt alone does not establish trust.
- Forward inner snapshots contain display profiles rather than author identity.
  `ForwardBundle.sourceDomain` is local import provenance, not a profile key.
  Outer message bindings authorize closure and asset retrieval.
- Pending media keeps the publisher namespace for author identity and separate
  source/transport fields needed to resume downloads.
- Locality is determined from namespace identity, not a domain sentinel.

Do not introduce domain-based identity fallbacks in caches, SSE wake keys,
profile targets, authorization checks, or mention matching.

## Storage

The unpublished baseline is [`0000_base.sql`](../../database/migrations/0000_base.sql),
kept consistent with [`schema.ts`](../../src/database/schema.ts).

- `Profile` has the exact publisher/account/profile-namespace/revision key.
- `ThreadAudience` represents local/peer targets with `localUserId` and
  `targetNamespaceId`.
- `PeerStateFeed` compaction uses namespace-based subject identity.
- `ClientStateFeed.domain` is account transport metadata, not subject identity.
- `PendingMedia` and `FileSyncProgress` use `publisherNamespaceId`.

## Remaining cleanup

These items are not known PostgreSQL or NestJS DI infrastructure blockers:

- [ ] Audit locality decisions expressed indirectly or in SQL. A literal
  TypeScript search alone is not a complete locality audit.
- [ ] Remove `MessageThread.groupDomain` from the schema and baseline, replacing
  its unique-index and CHECK-constraint responsibilities with
  `authorityNamespaceId`. Preserve uniqueness on
  `(groupAccount, authorityNamespaceId)` and the existing concurrency rules.

These are tracked tasks, not authorization to change the business model or
rewrite stored data.

## Related contracts and acceptance

- [Namespace model](./federation-namespaces.md)
- [Canonical Group Meta](./canonical-group-meta.md)
- [Thread state and exact profile resolution](./thread-state.md)
- [Forward wire contract](../../spec/v1/message/forward.md)
- [Implementation scope and acceptance boundary](../development/federation-implementation-handoff.md)
- [Independent conformance scope](../../spec/v1/CONFORMANCE.md)

Automated testing is paused at the operator's request. Static checks and
completed implementation tasks are not runtime or release acceptance.
