# Federation P2P Final-Friend Oracle

## Purpose

This document defines the first executable federation consistency workload. It
runs against three Federation Lab nodes with 20 local users per node. User
creation, OTP login, and all relationship mutations use public HTTP APIs.
Direct database access is read-only and has two separate purposes:

1. choose an API operation that is legal for the pair's currently observed
   state; and
2. audit final friendships after all work has completed.

The action-selection read is not a reference model. The harness does not
implement a second copy of the production relationship state machine.

## Stable identities

A user is identified by its federation Address:

```text
<account>@<home-domain>
```

A P2P pair key is the lexicographically sorted unordered pair of two distinct
Addresses:

```ts
type PairKey = `${Address}|${Address}`;
```

Database values using the domain `local` are normalized to the database node's
configured federation domain.

## API-only provisioning and mutation

For every generated local user, the runner creates the account through the
administrator API, issues a login code, logs in through the OTP API, and reads
the authenticated profile. Administrator and user actors live only in harness
memory. Passwords, OTPs, cookies, and tokens are never written to artifacts.

All workload mutations use the public relationship surface:

| User action                | Endpoint                     |
| -------------------------- | ---------------------------- |
| Request or reverse-request | `POST /relationship/request` |
| Accept an incoming request | `POST /relationship/accept`  |
| Reject a request           | `POST /relationship/revoke`  |
| Revoke a request           | `POST /relationship/revoke`  |
| End a friendship           | `POST /relationship/revoke`  |

The target domain is `local` when the target belongs to the actor's node and is
the real federation domain otherwise.

## Online action selection

Work is generated in rounds. The runner shuffles unordered pairs, selects each
pair at most once in a round, and randomly fixes the direction before reading
current state. For selected direction `A -> B`, the observed state selects one
of the APIs the production system currently permits:

```text
active friendship          -> A revokes the relationship
no active or pending fact  -> A sends a request to B
A -> B pending             -> B randomly accepts, rejects, or sends B -> A
B -> A pending             -> A randomly accepts, rejects, or sends A -> B
```

This mapping is only workload admission logic. It does not predict a resulting
intent or relationship state. The operation journal records the selected
direction, observed state, real HTTP request, returned durable task ID, and
terminal task result.

## Round barrier

The runner admits independent operations with bounded concurrency. It then
polls the existing administrator task API until admitted tasks are terminal and
there are no `PENDING`, `PROCESSING`, or `ASYNC_PROCESSING` tasks on the three
nodes. It waits an additional five seconds for asynchronous federation delivery
before selecting the next round. Progress and active task IDs are printed to the
console.

## Final acceptance oracle

After the last round barrier and propagation delay, the auditor reads
`RelationshipPair` rows for the test cohort. Only final friendship is in scope:

- a pair is a friend on a node exactly when its P2P row has `active = true`;
- a cross-node pair passes when `active` has the same value on both endpoint
  home nodes;
- both endpoint values must be `true` for the pair to count as one final
  friendship;
- a same-node pair has one authoritative home node; and
- an active pair must not exist on an unrelated third node.

The gate also rejects duplicate normalized active rows and structurally invalid
active P2P rows. It must pass for three consecutive samples.

This phase deliberately does not validate:

- whether an inactive `RelationshipPair` row exists on either node;
- whether a pair was ever a friendship;
- `RelationshipIntent` or federated-request records; or
- profile, request-time, revision, feed, or message fields.

Those facts can legitimately reflect in-flight or retained history and require
separate, explicitly defined acceptance oracles. They cannot be inferred from
operation names in this test.
