# Business Aggregate Mutation Locking

Status: local implementation design. Federation wire behavior remains defined by the
normative documents under [`spec/v1`](../../spec/v1/).

## 1. Purpose

The application has two business aggregates whose mutations must be serialized:
a pair of users and a group. Mutations may originate from a local API request or
an inbound federation intent. An aggregate can also be created for the first
time while another transaction is accepting, revoking, joining, leaving, or
otherwise updating it. Database rows alone cannot serialize that bootstrap
interval because the rows may not exist yet.

Every aggregate mutation therefore starts with one transaction-scoped
PostgreSQL advisory lock for the logical business scope. Existing database rows
are then locked in one fixed order and all mutation decisions are made from data
re-read after those locks were acquired.

The advisory lock closes the bootstrap gap; it does not replace row locks.
Row locks still protect concrete records, foreign-key projections, and code
that does not participate in business-scope locking.

## 2. Canonical scopes

A user address is represented as the pair `[domain, account]`. Domains are
lowercased before key construction. Account strings remain unchanged.

For a user-pair aggregate, the two addresses are sorted lexicographically by
domain and then account. The lock key is the JSON encoding of:

```text
["business-scope", "USER_PAIR", [domainA, accountA], [domainB, accountB]]
```

For a group aggregate, the group's address is the complete scope. The lock key
is the JSON encoding of:

```text
["business-scope", "GROUP", groupDomain, groupAccount]
```

The representation deliberately keeps domain and account in separate JSON
values. It does not concatenate an address with a punctuation separator. The
key has no version component: concurrently deployed implementations must derive
the same lock key to exclude one another.

The string key is mapped to a PostgreSQL advisory-lock integer with
`hashtextextended` and acquired using `pg_advisory_xact_lock`. A hash collision
can only serialize unrelated scopes; it cannot allow conflicting mutations to
run concurrently. PostgreSQL releases the lock automatically when the
transaction ends. A rollback, connection loss, process crash, or service restart
therefore cannot leave a stale business lock behind.

## 3. Lock order

User-pair mutations acquire resources in this order:

```text
USER_PAIR advisory scope
RelationshipPair
MessageThread
RelationshipIntent A
RelationshipIntent B
ThreadParticipant (accountId order)
```

Group mutations acquire resources in this order:

```text
GROUP advisory scope
Group
MessageThread
RelationshipPair
RelationshipIntent A
RelationshipIntent B
ThreadMember (userId order)
ThreadParticipant (accountId order)
```

Missing rows are skipped without changing the relative order of rows that do
exist. When multiple projection rows are needed, their identifiers are sorted
before locking. Intent rows are always locked in canonical author-side order,
never in caller or local-versus-remote order.

The group address identifies the whole group aggregate, not one member's
relationship with that group. The shared scope serializes participating group
mutations for different members as well as changes to the group itself. This
allows group metadata, membership projections, and
`Group.federationAuthorized` to be rebuilt from a stable aggregate state.

## 4. Bootstrap and revalidation

Creation starts from stable endpoint identities:

1. Locate enough address data to derive the canonical scope.
2. Acquire the advisory scope lock.
3. Re-read endpoint and relationship state.
4. Create any missing Group, MessageThread, RelationshipPair, or intent rows.
5. Acquire the remaining row locks in canonical order.
6. Revalidate the requested transition and apply its effects.

The first lookup is only a locator. It must not authorize a transition. Status,
expiry, ownership, membership, role, active-pair, and thread decisions that can
change concurrently are evaluated again from the locked state.

## 5. Covered transitions

The user-pair scope applies whenever the pair aggregate is updated. Current
entry points include local friend requests, acceptance, rejection or revocation,
established relationship termination, and equivalent inbound federation
`ACCEPTED` or `REVOKED` transitions.

The group scope applies whenever the group aggregate is updated. Current entry
points include requests and invitations to join, acceptance, rejection or
revocation, member leave and removal, and equivalent inbound federation
transitions. Local and federated entry points use the same locking primitive;
the source of an intent only determines which canonical author-side row may be
changed.

For a remote group, `Group.federationAuthorized` is refreshed inside the same
locked transaction after an active group-member pair changes. It is true when
at least one active `GROUP_MEMBER` pair connects the remote group to a local
user. Local groups always retain false.

Read-only endpoints do not need the advisory lock. A caller that already holds
the canonical scope may use lower-level helpers, but it must preserve the row
order above and must not acquire a second business scope in the same transaction
without a separately defined cross-scope ordering rule.

## 6. Transaction boundary

A relationship command has one caller-owned database transaction. The command
service accepts that transaction and does not open an inner transaction. The
business advisory lock, lock-protected re-read, intent transition, active-pair
fold, membership projections, federation authorization projection, and durable
client or peer feed writes all commit or roll back together. Profile and Group
Meta projection processing is part of this transaction. When a successful
transition first materializes a Group, MessageThread, ThreadMember, or
ThreadParticipant, that creation is part of the same transaction as well.

SSE delivery, lightweight federation notifications, and State Feed high-water
mark pushes occur only after that transaction commits. Here, "push" means the
network wake-up; creation and persistence of the referenced feed items remains
inside the transaction. Pushes are hints and are never part of the atomic
relationship state change.
