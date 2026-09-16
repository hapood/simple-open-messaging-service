# Business Aggregate Mutation Locking

Status: local implementation design. Federation wire behavior remains defined by the
normative documents under [`spec/v1`](../../spec/v1/).

## 1. Purpose

This document defines the target aggregate-lock implementation. The three
explicit business locks are **Account State Lock**, **Relationship Pair Lock**,
and **Thread Content Lock**, with responsibilities defined in the
[business mutation standard](./business-mutation-sql-pattern.md).

Every user and group is identified by one account address. Mutations may
originate from a local API request or an inbound federation intent. An
aggregate can also be created for the first time while another transaction is
accepting, revoking, joining, leaving, or otherwise updating it. Database rows
alone cannot serialize that bootstrap interval because the rows may not exist
yet.

Every mutation starts by acquiring all applicable explicit locks in global
class order. Existing database rows are then locked in one fixed order and all
mutation decisions are made from data re-read after those locks were acquired.

The Account State Lock serializes only state owned by the acting group or user.
Membership relationships use their Pair locks; messages use their Thread lock.
All mutation entry points, including federation inbound processing and fanout,
must acquire their applicable explicit lock at the transaction boundary.

## 2. Canonical scopes

A user or group address is represented as the pair `[domain, account]`.
Domains are lowercased before key construction. Account strings remain
unchanged. Both kinds of identity use the same lock-key shape:

```text
["business-scope", "ACCOUNT", domain, account]
```

An account-state mutation locks each account whose owned state it changes. It
does not lock an endpoint merely because a Pair references it. When one
transaction needs multiple account locks, it deduplicates and sorts their
complete encoded keys before acquiring any of them.

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

All transactions use this explicit lock order:

```text
Account State advisory locks (canonical account-address order)
Relationship Pair advisory locks (canonical pair-key order)
Thread Content row locks (thread-id order)
```

Within the remaining implicit row locks, federation namespace allocators are
acquired by namespace ID and account-owned allocators by account ID. A transaction
must not acquire an earlier explicit class from an internal helper. A namespace
allocator is terminal: no Account State, Relationship Pair, or Thread Content
lock may be acquired after it. Namespace retirement changes only namespace and
peer lifecycle state; it does not author thread messages.

Typical P2P mutations acquire resources in this order:

```text
applicable Account State advisory scopes
Relationship Pair advisory scope
Thread Content lock when content changes
RelationshipPair
RelationshipIntent A
RelationshipIntent B
AccountThreadState (accountId order)
```

Group mutations acquire resources in this order:

```text
applicable Account State advisory scopes
Relationship Pair advisory scopes (pair-key order)
Thread Content lock when content changes
Group
RelationshipPair
RelationshipIntent A
RelationshipIntent B
GroupMeta allocator or replica cursor
AccountThreadState (accountId order)
```

Missing rows are skipped without changing the relative order of rows that do
exist. When multiple projection rows are needed, their identifiers are sorted
before locking. Intent rows are always locked in canonical author-side order,
never in caller or local-versus-remote order.

The group Account State Lock protects state authored by the group account. It
does not replace the individual Pair Lock for each member relationship. A
member-authored membership command locks the member's Account State scope, not
the group account merely because the group is the other Pair endpoint.
Cross-pair group invariants use their shared canonical row/allocator lock (for
example `GroupMeta`) in the documented implicit order.

The explicit locks are a complete ownership taxonomy, not a claim that row locks
can be acquired arbitrarily. Every implicit conflict must be dominated by one
explicit lock or follow a canonical row order.

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

The acting user's Account State scope applies to a P2P command. The other
endpoint is covered by the Pair scope for intent and relationship-derived state;
its Account State scope is not acquired unless that same transaction separately
changes state owned by that account.

The group account scope applies whenever the group aggregate is updated. Current entry
points include requests and invitations to join, acceptance, rejection or
revocation, member leave and removal, owner-managed roster role changes
(`SET_ROLE` and ownership transfer mutate canonical Group Meta facts and take
no member Pair lock; the GroupMeta allocator row orders them against both
authored directions), and equivalent inbound federation
transitions. Local and federated entry points use the same locking primitive;
the source of an intent only determines which canonical author-side row may be
changed.

When a local member leaves a remote group, the same locked transaction checks
whether another active `GROUP_MEMBER` pair still connects that group to a local
user. The thread authorization epoch advances only after the last such local
member leaves; this aggregate condition is derived from the relationship facts
and is not persisted separately on the group.

Read-only endpoints do not need the advisory lock. A caller that already holds
the required account scopes may use lower-level helpers, but it must preserve
the global address and row orders above.

## 6. Transaction boundary

A relationship command has one caller-owned database transaction. The command
service accepts that transaction and does not open an inner transaction. The
business advisory lock, lock-protected re-read, intent transition, active-pair
fold, canonical Group Meta append, federation authorization projection, and
head-fan-out task admission all commit or roll back together. Audience
enumeration, State Feed head writes, and network profile resolution are not part
of this transaction. When a successful transition first materializes a Group,
MessageThread, or AccountThreadState, that creation is part of the applicable
transaction as well. No `ThreadMember` table is retained: P2P endpoints come
from `RelationshipPair`, while group membership comes from canonical Group Meta
or its validated replica.

A committed member-authored `REQUESTED` selects the immutable `profileRev` and
may offer that exact revision to the global profile coordinator only after the
request transaction commits. The coordinator performs no work inside the
relationship transaction or group lock. A later activation transaction folds
the current intents and appends the member `UPSERT` with the revision already
selected by the effective request; it never waits for profile retrieval or
revalidates profile availability.

SSE delivery, lightweight federation notifications, and State Feed high-water
mark pushes occur only after that transaction commits. Here, "push" means the
network wake-up; creation and persistence of the referenced feed items remains
inside the transaction. Pushes are hints and are never part of the atomic
relationship state change.

## 7. Task lookup

See the [task responsibility and business-lock index](./durable-task-responsibilities-and-locks.md)
for each task type, its branch-specific scope, and the current execution path.
The [business mutation SQL pattern](./business-mutation-sql-pattern.md) defines
the transaction-owner convention for subsequent refactors; existing task paths
are not assumed to have been migrated already.
