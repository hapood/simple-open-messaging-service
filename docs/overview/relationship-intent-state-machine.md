# Relationship Intent State Machine and Projections

SOMS represents friendship and group membership with the same pair of independently authored,
directed `RelationshipIntent` facts. Relationship facts are authoritative. Every projection in this
document is a derived read model and never grants relationship authority by itself.

## Notation

```text
∅   = no directed RelationshipIntent
REQ = RelationshipIntent.REQUESTED with expiresAt > now
ACK = RelationshipIntent.ACCEPTED
REV = RelationshipIntent.REVOKED
*   = any state
```

`ACK` is a persisted directed state, not a network acknowledgement message. An incoming
`REQUESTED` with `expiresAt <= now` is a no-op: it is neither `REQ` nor `REV` and cannot update a
relationship or projection. The local expiry sweep converts a currently stored expired request by
performing the explicit `REQUESTED -> REVOKED` transition.

## Authoritative directed state machine

For a valid pair `(A, B)`, storage may contain two ordered facts:

```text
A -> B
B -> A
```

Each author owns only its direction. The authored transitions are:

| Current              | Authored operation      | Reverse direction | Next  |
| -------------------- | ----------------------- | ----------------- | ----- |
| `∅`                  | Request                 | Not effective     | `REQ` |
| `REV`                | Request                 | Not effective     | `REQ` |
| `∅`, `REQ`, or `REV` | Request                 | Effective         | `ACK` |
| `REQ`                | Accept                  | Effective         | `ACK` |
| `REQ`                | Revoke or local expiry  | Any               | `REV` |
| `ACK`                | Revoke                  | Any               | `REV` |
| Any                  | Receive expired request | Any               | No-op |

An explicit acceptance is valid only while the reverse direction is effective. A newly authored
request is stored as `ACK` when its reverse is already effective. This is crossed-request promotion;
it does not add another state or protocol round.

## Pair folding

A direction is effective when it is `ACK`, or when it is `REQ` before expiry. The pair algebra is:

```text
REQ + ∅   = UNCONFIRMED
∅   + REQ = UNCONFIRMED
REQ + ACK = CONFIRMED
ACK + REQ = CONFIRMED
ACK + ACK = CONFIRMED
REQ + REQ = CONFIRMED, then atomically promote the locally owned REQ to ACK
REV + *   = UNCONFIRMED
*   + REV = UNCONFIRMED
```

Runtime authorization requires two effective directions and at least one persisted `ACK`.
`RelationshipPair.active` materializes this folded result and is the fact read by
runtime permission checks. `ThreadMember` retains roster linkage, role, and
history visibility; `ThreadParticipant` retains local account settings. Neither
table grants access.

For a group/member pair, direction supplies the business meaning without another state machine:

| Group → member | Member → group | Folded result               | Meaning                                 |
| -------------- | -------------- | --------------------------- | --------------------------------------- |
| `REQ`          | `∅`            | `UNCONFIRMED`               | Group invitation waiting for the member |
| `∅`            | `REQ`          | `UNCONFIRMED`               | Join application waiting for a manager  |
| `REQ`          | `ACK`          | `CONFIRMED`                 | Member accepted the invitation          |
| `ACK`          | `REQ`          | `CONFIRMED`                 | Group accepted the application          |
| `REQ`          | `REQ`          | `CONFIRMED`, then promotion | Invitation and application crossed      |
| `ACK`          | `ACK`          | `CONFIRMED`                 | Fully converged membership              |
| `REV`          | `*`            | `UNCONFIRMED`               | Group direction is closed               |
| `*`            | `REV`          | `UNCONFIRMED`               | Member direction is closed              |

## Projections are side effects

Relationship projections do not define additional state machines. The pair row is the locked,
materialized bilateral fact used for authorization; other projections are disposable,
query-oriented records written as side effects after an authored intent has passed the authoritative
state machine and committed. The committed directional facts remain the sole inputs to pair folding
and authorization.

A projection writer consumes the explicit authored direction and status. It MUST NOT infer an intent
from a pair result, compare `updatedAt` values to choose a winner, or create request history from an
`ACCEPTED` or `REVOKED` fact for which it cannot find the corresponding live request projection.
Repeated delivery of the same committed fact has the same result as applying it once.

| Projection                   | Storage/owner | Purpose                                                                    |
| ---------------------------- | ------------- | -------------------------------------------------------------------------- |
| Pair activation projection   | Server        | Materialize the authoritative pair fold for efficient authorization checks |
| User request projection      | Client        | Render friend requests, group invitations, and outgoing group applications |
| Group application projection | Server        | Render member-authored join applications in group management               |
| Group invitation projection  | Server        | Render group-authored invitations waiting for members in group management  |

Rebuilding a projection from the same directed intents cannot change the folded relationship.

## User-view request projection

The client uses one request-projection shape and one set of write rules for both user/user and
member/group relationships. `kind: FRIEND | GROUP` changes only presentation text and available
buttons. It does not select another projection state machine or another fact-merging algorithm.

For the user viewing the client:

```text
local  = Viewer -> Counterparty
remote = Counterparty -> Viewer
```

`INCOMING` and `OUTGOING` are relative to that viewer, never to federation transport. A request
projection is rooted in the `REQUESTED` fact that created it and retains that authored direction.
In the client state feed, an `OUTGOING REQUESTED` always carries a non-null `localThreadId` for the
viewer's local thread shell; an `INCOMING REQUESTED` may carry `null` until the backend promotes it.
Every `ACCEPTED` fact carries a non-null `localThreadId`, regardless of viewer-relative direction.
Later facts update a matching live request projection as follows:

| Committed fact     | Projection side effect                                                                 |
| ------------------ | -------------------------------------------------------------------------------------- |
| Local `REQUESTED`  | Immediately upsert the outgoing request and overwrite the compacted same-direction row |
| Local `ACCEPTED`   | No-op                                                                                  |
| Local `REVOKED`    | Mark a matching, still-live local request projection `REVOKED`; otherwise no-op        |
| Remote `REQUESTED` | Immediately upsert the incoming request and overwrite the compacted same-direction row |
| Remote `ACCEPTED`  | Mark a matching, still-live local request projection `ACCEPTED`; otherwise no-op       |
| Remote `REVOKED`   | Mark a matching, still-live remote request projection `REVOKED`; otherwise no-op       |

An expired `REQUESTED` is not live and produces no projection write. An `ACCEPTED` or `REVOKED`
never manufactures a missing request card. A later new request flow may overwrite the compacted row
for the same authored direction through the `REQUESTED` rule.

For `kind = FRIEND`, an incoming row is shown as a friend request. For `kind = GROUP`, the same
incoming row is shown as a group invitation, and an outgoing row is shown as a join application.
Only labels and valid user actions differ.

## Identity profile publication

Every non-`REVOKED` federated relationship publication MUST include the author's home-owned
`PROFILE`, irrespective of whether the author is a user account or a `!`-sigil group identity. The
publisher writes the compacted `RELATIONSHIP_INTENT` first and the compacted `PROFILE` second. A
receiver can therefore authorize the dependent profile from the preceding request and hydrate the
request projection before either side accepts the relationship.

This is one identity rule, not separate friend and group behavior:

| Authored relationship publication | Required identity publication |
| --------------------------------- | ----------------------------- |
| User → user `REQUESTED`           | Author user `PROFILE`         |
| Group → member `REQUESTED`        | Author group `PROFILE`        |
| Member → group `REQUESTED`        | Author member `PROFILE`       |
| Any non-`REVOKED` confirmation    | Author identity `PROFILE`     |

`PROFILE` is a dependent snapshot and does not create a relationship or grant authority. A receiver
may temporarily materialize an address-based placeholder while applying an intent, but it MUST fold
the following PROFILE into every matching live request projection. `REVOKED` publishes no profile;
the publisher instead removes the profile projection when no other authorized relationship retains
it. Reindexing a renewed request MUST also reindex PROFILE so an older compacted profile cannot sort
before the new request.

## Group-view request projections

Group management has two backend projections of the same directional request facts:

| Authored request        | Group-management surface                         |
| ----------------------- | ------------------------------------------------ |
| Member `->` Group `REQ` | Join applications                                |
| Group `->` Member `REQ` | Invitations, shown as inviting / waiting to join |

Both projections use the same response shape, pagination model, status vocabulary, retention rule,
and side-effect semantics. The invitation query and action API MUST have the same contract shape as
the join-application API even when they use distinct routes and enforce direction-specific actions.

For either direction, `REQUESTED` upserts its compacted request projection. The opposite author's
`ACCEPTED` marks that request `ACCEPTED` only when a matching live projection exists. The request
author's `REVOKED` marks that request `REVOKED` only when a matching live projection exists. All
other events are no-ops for that projection.

A member accepting a group invitation therefore updates the existing group invitation; it does not
create a join application. Likewise, a group accepting an application updates the existing join
application; it does not create an invitation. Projection retention and garbage collection are
presentation concerns and cannot affect membership.

## Consistency rules

- Directed writes and pair folding are serialized by the canonical relationship-pair transaction
  lock.
- Relationship transitions, pair activation, and dependent projections commit atomically.
- A feed consumer applies each item's facts, pair fold, and projection effect in order, then publishes
  projection refreshes only after the complete batch commits. Server SSE hints are coalesced to the
  highest committed feed ID per affected user; they never carry an intermediate projection state.
- Projections consume explicit committed authored facts; they do not independently infer intent
  state from a folded pair result or from two `updatedAt` values.
- `updatedAt` is local persistence metadata, not causal order. Federation delay, clock skew, retry,
  and replay make timestamp comparison invalid for state transitions.
- Federation transports authored facts. A receiver applies valid, unexpired facts idempotently and
  performs the same pair fold locally.
- An expired incoming request is a no-op for the authoritative pair and every projection.

Relevant implementation entry points are
[`RelationshipIntentService`](../../src/invite/relationship-intent.service.ts),
[`deriveRelationshipIntentTransition`](../../src/invite/relationship-intent-state.ts), and the client
request projection in
[`FriendRequestProjection`](../../web/src/app/services/friend-request-state.ts).
