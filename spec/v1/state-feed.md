# Simple Open Messaging Federation Protocol v1 State Feed

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document is entirely normative. `GET /s2s/v1/state-feed` is the
per-peer compacted feed for relationship facts, group-meta feed-head hints,
and per-thread message and deletion query heads. It carries no user or group
profile display data; Relationship Intent carries an authorization snapshot and an exact revision
reference. Message-author display data is resolved only through the exact-message
[Message Author Profile](./message-author-profile.md) operation.

## 1. Request and bootstrap

The closed query contains optional `after`, `take`, and `through`.
`after` is an exclusive non-negative decimal cursor. `take` is a positive
safe-integer suggestion. `through` is an inclusive bound and MUST be at least
`after`. `take` and `through` require `after`.

When `after` is omitted, the source returns
`FEDERATION_FEED_CURSOR_UNAVAILABLE { resumeAfter, resumeBefore }` and no
page. `resumeBefore=stateFeedEndId+1`. Draining from `resumeAfter` MUST
reconstruct the complete current projection. A source MUST retain every current
stable-key item and MUST NOT establish a time- or capacity-based floor that
prevents reconstruction from the advertised oldest boundary.

## 2. Page and compaction

```ts
interface StateFeedPage {
  items: StateFeedItem[];
  scannedThrough: DecimalString;
  stateFeedEndId: DecimalString;
  hasMore: boolean;
}
```

For one consistent source snapshot:

```text
scanEnd = through is present ? min(stateFeedEndId, through) : stateFeedEndId
```

Every item is in `(after, scannedThrough]` and items are strictly increasing
by `feedId`. If candidates remain, `hasMore=true` and
`scannedThrough>after`; otherwise `hasMore=false` and
`scannedThrough=scanEnd`. Gaps and an empty page may advance
`scannedThrough`. The consumer applies page effects and its cursor atomically.

The publisher retains one newest item per stable key. A semantic change
allocates a greater `feedId` and may immediately replace the older version.
Current non-deletion projections MUST remain available for a complete rebuild.
Reading is not acknowledgement and the source stores no consumer cursor.

## 3. Items

```ts
type StateEventType =
  | 'RELATIONSHIP_INTENT'
  | 'GROUP_META_FEED_HEAD'
  | 'THREAD_CONTENT_HEAD';

interface StateFeedItemBase {
  account: Account;
  eventType: StateEventType;
  feedId: PositiveDecimalString;
}

interface RelationshipIntentItem extends StateFeedItemBase {
  eventType: 'RELATIONSHIP_INTENT';
  peerAccount: Account;
  body: RelationshipIntentBody;
}

interface GroupMetaFeedHeadItem extends StateFeedItemBase {
  account: GroupAccount;
  eventType: 'GROUP_META_FEED_HEAD';
  body: GroupMetaFeedHeadBody;
}

interface P2PThreadContentHeadItem extends StateFeedItemBase {
  account: UserAccount;
  peerAccount: UserAccount;
  eventType: 'THREAD_CONTENT_HEAD';
  body: ThreadContentHeadBody;
}

interface GroupThreadContentHeadItem extends StateFeedItemBase {
  account: GroupAccount;
  eventType: 'THREAD_CONTENT_HEAD';
  body: ThreadContentHeadBody;
}

type StateFeedItem =
  | RelationshipIntentItem
  | GroupMetaFeedHeadItem
  | P2PThreadContentHeadItem
  | GroupThreadContentHeadItem;
```

`eventType` discriminates the item union; it is not part of an event's business
stable key. Within one authenticated source feed, each event type defines its
own stable key: `RELATIONSHIP_INTENT` uses the directed pair
`(account, peerAccount)`, `GROUP_META_FEED_HEAD` uses the group `account`,
and `THREAD_CONTENT_HEAD` uses the Thread Address defined in Section 6. The
source domain is the authenticated publisher and is not repeated in an item.
Only relationship and P2P thread-content items carry `peerAccount`. Unknown
event types or fields are malformed.

## 4. RELATIONSHIP_INTENT

```ts
interface RelationshipIntentFields {
  profileRev: SafeInteger;
  note: string;
  requestedAt: EpochMilliseconds | null;
  expiresAt: EpochMilliseconds | null;
}

type RelationshipIntentBody = RelationshipIntentFields & (
  | {
      status: 'REQUESTED' | 'ACCEPTED';
      messageEndSeq: ThreadSequence;
      tombstoneEndSeq: ThreadSequence;
    }
  | {
      status: 'REVOKED';
      messageEndSeq?: ThreadSequence;
      tombstoneEndSeq?: ThreadSequence;
    }
);
```

This item is one source-authored user/user or user/group direction.
`account` is hosted by the authenticated source domain and `peerAccount` is
hosted by the receiver. Group/group relationships are invalid. Each direction is
controlled exclusively by its author; a receiver MUST NOT invent or publish a
transition on the author's behalf. `ACCEPTED` is a durable acknowledgement of a
request flow, not a second request and not a transport acknowledgement.

Every positive direction (`REQUESTED` or `ACCEPTED`) MUST carry both
`messageEndSeq` and `tombstoneEndSeq` as non-null, inclusive, non-negative
thread coordinates. The publisher MUST obtain the pair from one consistent
snapshot containing the latest committed queryable coordinates at the time it
authors the State Feed item. It MUST NOT reuse an older authorization snapshot
or read the two coordinates from different snapshots. Later commits do not
invalidate an already authored item; transport retries may retransmit it.
`0/0` is a valid snapshot of an empty thread, not a fallback for missing values.

The authorization snapshot supplies a synchronization starting point for initial
access and reauthorization. Neither case requires a separate
`THREAD_CONTENT_HEAD` publication before the receiver can start synchronization.
The snapshot does not require the receiver to reconstruct earlier thread history:
the receiver MAY backfill all, some, or none of the history available under the
publisher's query and retention policies. Snapshot selection across repeated
intents or multiple receiver-hosted accounts sharing a thread, local state layout,
and transaction boundaries are implementation choices. A different `feedId`
does not by itself create a new thread coordinate space or require another
history initialization. Feed ordering and current authorization still apply.

`profileRev` is required and non-null. A positive value is the source account's
immutable profile reference selected when the current request flow was authored;
`0` means that the flow carries no profile and the consumer performs no profile
request. `REQUESTED -> ACCEPTED` and the later `REVOKED` transition retain that
same value. A new request flow after revocation selects the author's chosen
revision, normally its local default, or zero when it has none.

While `REQUESTED` remains unexpired or the direction is `ACCEPTED`, the source
MUST allow the receiver to resolve that positive exact reference through
[Authorized Profile](./authorized-profile.md). This grant applies equally when
the receiver-hosted endpoint is a user or a group and ends when the direction
expires or becomes `REVOKED`.

A profile update by itself MUST NOT mutate or republish a
`RELATIONSHIP_INTENT`, allocate a new State Feed item, or change its
`profileRev`. Consequently, a peer with no later peer-authored message keeps
displaying the revision referenced by the relationship flow. P2P profile
changes become visible through a later message carrying a different
`profileRev`, not through relationship-state churn.

### 4.1 Authored intent state machine

A `RELATIONSHIP_INTENT` is a single directed state machine from its author to
its peer:

```text
account@source-domain -> peerAccount@receiver-domain
```

The reverse direction is a separate `RELATIONSHIP_INTENT`, independently
authored and transitioned by the reverse direction's author. Observing or
validating the reverse direction does not merge the two intents or transfer
authority over either one.

The timestamp fields have the following state-dependent invariants:

- `REQUESTED` MUST have non-null `requestedAt` and `expiresAt`, with
  `requestedAt < expiresAt` and a lifetime no greater than seven days.
- `ACCEPTED` MUST have a non-null `requestedAt` identifying the request flow
  that was confirmed and MUST have `expiresAt: null`. It does not expire.
- `REVOKED` MUST have `expiresAt: null`. Its `requestedAt` MAY retain the time of
  the superseded request flow or be `null`; it has no effect on revocation.

### 4.2 Derived relationship

The relationship is derived by folding two independently authored directional
intents. The following table is a relationship-derivation matrix, not the state
machine of either intent. In the table, an effective `REQUESTED` has not
expired, and a valid `ACCEPTED` is an acknowledgement admitted under the rules
below:

| Direction `A -> B`            | Direction `B -> A`                        | Derived relationship |
| ----------------------------- | ----------------------------------------- | -------------------- |
| effective `REQUESTED`         | absent, expired, or `REVOKED`             | unconfirmed          |
| effective `REQUESTED`         | effective `REQUESTED`                     | confirmed            |
| effective `REQUESTED`         | valid `ACCEPTED`                          | confirmed            |
| valid `ACCEPTED`              | effective `REQUESTED` or valid `ACCEPTED` | confirmed            |
| absent, expired, or `REVOKED` | any state                                 | unconfirmed          |

Equivalently, for two effective positive directions, `REQUESTED + REQUESTED`,
`REQUESTED + ACCEPTED`, and `ACCEPTED + ACCEPTED` all derive a confirmed
relationship. This is a derivation rule; it does not merge the two
source-authored facts or transfer authority over either direction.

An author MAY transition its direction from `REVOKED` to `REQUESTED` to begin a
new request flow. When two effective requests cross, each source MUST promote
its own direction to `ACCEPTED`. When a valid reverse `ACCEPTED` confirms an
effective local `REQUESTED`, that request's source MUST likewise promote its own
direction. A node that first observes `REQUESTED + REQUESTED` MUST durably commit
its own promotion to `ACCEPTED` in the same atomic relationship transition that
applies confirmed-dependent local effects. It MUST NOT expose a confirmed
relationship on the assumption that a later promotion will succeed.

Consequently, `REQUESTED + REQUESTED` is a confirmation trigger rather than a
stable pending state: after one node processes it, that node holds
`ACCEPTED + REQUESTED` and publishes its authored `ACCEPTED`. During subsequent
convergence, `REQUESTED + ACCEPTED` is already confirmed and triggers promotion
of the remaining authored request. A node MUST NOT wait for
`ACCEPTED + ACCEPTED` before applying the derived relationship, although that is
the normal converged representation.

A receiver may admit a newly observed `ACCEPTED` only when it confirms the
receiver's still-effective local `REQUESTED`, or completes a peer request that
the receiver has already answered with its own `ACCEPTED`. An unsolicited
`ACCEPTED` has no relationship or authorization effect and MUST NOT become valid
merely because the addressed account or an earlier relationship is known. Once
valid, `ACCEPTED` remains effective without a time limit. Either author may end
the relationship by publishing `REVOKED` for its direction. Re-establishment
requires a new effective request flow; an old or replayed `ACCEPTED` cannot
override a newer negative fact.

A `REQUESTED` direction loses all authorization at its absolute `expiresAt`,
independently of background processing. After that boundary, the author MAY
atomically materialize the direction as `REVOKED` and allocate the resulting
snapshot at a newer state-feed position. Until the author publishes a newer
snapshot, the receiver retains the expired `REQUESTED` as an ineffective
authored fact. `REVOKED` is a current compacted fact, not a group-member
deletion.

## 5. GROUP_META_FEED_HEAD

```ts
interface GroupMetaFeedHeadBody {
  groupMetaFeedEndId: DecimalString;
}
```

The item account MUST be a group owned by the authenticated source domain.
`groupMetaFeedEndId` is a committed `feedId` in the origin-owned group's one
canonical Group Meta feed. It MUST NOT contain a roster, member display data, owner, active flag,
dissolution flag, group setting, or other meta fact.

The origin commits each canonical group-meta mutation once before allocating
this item for an authorized audience. On first synchronization the receiver requests `group-meta` in
`full` mode. Later synchronizations use `delta` from the last atomically committed
Group Meta feed cursor. If delta history is unavailable, the receiver returns to
`full`. The receiver MUST commit a Group Meta cursor greater than or equal to
`groupMetaFeedEndId` before committing this state item; a later projection may
legitimately overtake the feed-head hint while the consumer is fetching it.
The State Feed item is audience-specific; the Group Meta coordinate it names is
not. A newly authorized or reauthorized audience cannot use that common
coordinate to bypass its Group Meta delta visibility floor.

The group owner is derived from the member carrying role `OWNER`; membership
and active local participation are derived from current member keys.
Non-member-derived settings are not federated.

## 6. THREAD_CONTENT_HEAD

```ts
interface ThreadContentHeadBody {
  messageEndSeq: ThreadSequence;
  tombstoneEndSeq: ThreadSequence;
}
```

This item is the compacted discovery projection for one thread. A P2P item uses
the stable key `(account, peerAccount)`: `account` is the source-hosted user and
`peerAccount` is the receiver-hosted user. A group item uses its globally unique
group `account`, and `peerAccount` MUST be absent. The authenticated exchange
supplies both domains, so neither is repeated in the body.

`messageEndSeq` is the inclusive upper bound currently committed and queryable
through `/messages`. It is a non-negative JSON integer no greater than
`SafeInteger - 1`. `tombstoneEndSeq` is the inclusive upper bound currently
queryable through `/message-tombstones`. It is a non-negative JSON integer no
greater than `SafeInteger - 1`; zero means that no tombstone has yet been
allocated for this thread and receiver.

For one stable thread key, neither coordinate may decrease or be reused across
relationship transitions. An increase of either coordinate is a semantic
change to the same compacted item and MUST allocate a greater State Feed
`feedId`. The unchanged coordinate MUST carry its current value in the new
complete body. The item contains no message or tombstone content, grants no
authorization, and is not an acknowledgement. The corresponding query
operations recompute authorization from durable state.

The publisher MUST obtain both coordinates from one consistent snapshot
containing the latest committed queryable message and tombstone coordinates
when it authors the item. It MUST NOT read the two coordinates from different
snapshots or reuse stale coordinates for a newly authored head. An authorized
empty thread MAY publish `messageEndSeq: 0, tombstoneEndSeq: 0`. Relationship
closure MAY remove the current projection without allocating a deletion item.
Confirmation or restored access does not require an immediate thread-content
publication: the positive intent already carries the latest sequence pair.
If the publisher later recreates a removed thread-content projection, it MUST
allocate a new, greater `feedId`, even when both coordinates are unchanged.

## 7. Ordering, recovery, and authorization

A source commits a relationship direction before dependent
`GROUP_META_FEED_HEAD` items become visible. It MUST allocate every
`THREAD_CONTENT_HEAD` after the current State Feed projections required to
identify and authorize that thread. For a group, the required
`GROUP_META_FEED_HEAD` precedes the thread-content item.

An effective one-way `REQUESTED` authorizes the passive queries defined by the
message, tombstone, and profile operations, but it does not make these dependent
head projections visible. The source MUST wait until the derived relationship is
confirmed before allocating or publishing `GROUP_META_FEED_HEAD` or
`THREAD_CONTENT_HEAD` for that peer. For GROUP, at least one member hosted by
that peer MUST remain confirmed.

A relationship change alone does not require creating or reindexing a
thread-content item: its positive intent already provides the latest sequence
pair. For a complete rebuild, the consumer applies current relationship facts
before selecting thread targets; an older head must not replace a newer
authorization snapshot. If a required Group Meta projection moves to a greater
`feedId`, the publisher MUST reindex an existing dependent thread-content item
at a still greater `feedId`, sampling a fresh latest sequence pair. The consumer
applies relationship and roster dependencies before accepting their
thread-content targets, regardless of placement within one fetched page.

A malformed item is isolated according to the common permanent-item rules. A
failed group-meta fetch or page transaction does not advance the state cursor.
Hints may be lost, repeated, or reordered; startup and periodic reconciliation
must drain from the durable local cursor. The consumer retains the maximum
observed pending `stateFeedEndId`; an older hint never moves pending, active, or
committed progress backward.

Removing a current state-feed projection allocates no deletion item unless the
event's own state machine defines a durable terminal fact, such as
`RELATIONSHIP_INTENT/REVOKED`. Projection omission cannot by itself delete
messages, users, threads, or group-member state.
