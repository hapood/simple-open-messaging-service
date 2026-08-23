# Simple Open Chat Federation Protocol v1 State Feed

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document is entirely normative. `GET /s2s/v1/state-feed` is the
per-peer compacted feed for relationship facts, home-authored profiles, and
group-meta feed-head hints. Group members, roles, and source-scoped member
profiles are available only from [Group Meta Feed](./group-meta.md).

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
  | 'PROFILE'
  | 'RELATIONSHIP_INTENT'
  | 'GROUP_META_FEED_HEAD';

interface StateFeedItem {
  account: Account;
  domain: Domain;
  eventType: StateEventType;
  feedId: PositiveDecimalString;
  body: ProfileBody | RelationshipIntentBody | GroupMetaFeedHeadBody;
}

interface RelationshipIntentItem extends StateFeedItem {
  eventType: 'RELATIONSHIP_INTENT';
  localAccount: Account;
}
```

Stable keys are `(domain, account, eventType)` and, for a relationship,
`(domain, account, RELATIONSHIP_INTENT, localAccount)`. Only relationship
items carry `localAccount`. Unknown event types or fields are malformed.

## 4. PROFILE

```ts
interface ProfileBody {
  profileRev: SafeNonNegativeInteger;
  displayName: string;
  bio: string;
  avatar: ProfileAvatar | null;
}
```

A `PROFILE` is a complete home-authored user or group identity profile.
Its `domain` MUST equal the signer domain. `displayName` contains 1–30
Unicode code points and `bio` contains 0–120. The avatar rules from the core
profile type apply. Profile data grants no relationship, membership, message,
or resource permission.

The source publishes a profile only while the target peer has the corresponding
effective disclosure source. An unchanged `profileRev` MUST have identical
content and does not allocate another feed ID.

## 5. RELATIONSHIP_INTENT

```ts
interface RelationshipIntentBody {
  status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED';
  note: string;
  requestedAt: EpochMilliseconds | null;
  expiresAt: EpochMilliseconds | null;
}
```

This item is one source-authored user/user or user/group direction.
`account/domain` is the signer-hosted end and `localAccount` is hosted by
the receiver. Group/group relationships are invalid. Request, acceptance,
expiration, revocation, restoration, authorization, and confirmation semantics
remain those defined by the core protocol. `REVOKED` is a current compacted
fact, not a group-member deletion.

A `REQUESTED` direction loses all authorization at its absolute `expiresAt`, independently of
background processing. After that boundary, the author MAY atomically materialize the direction as
`REVOKED` and allocate the resulting snapshot at a newer state-feed position. A receiver MUST NOT
publish or otherwise invent that terminal fact on the author's behalf; until the author publishes a
new snapshot, the receiver retains the expired `REQUESTED` as an ineffective authored fact.

## 6. GROUP_META_FEED_HEAD

```ts
interface GroupMetaFeedHeadBody {
  groupMetaFeedEndId: DecimalString;
}
```

The item account MUST be an origin-owned group and its domain MUST equal the
signer. `groupMetaFeedEndId` is the latest `feedId` in that target peer and
group's Group Meta feed. It MUST NOT contain a roster, member profile, owner, active flag,
dissolution flag, group setting, or other meta fact.

The origin commits the target peer's group-meta projection before allocating
this item. On first synchronization the receiver requests `group-meta` in
`full` mode. Later synchronizations use `delta` from the last atomically committed
Group Meta feed cursor. If delta history is unavailable, the receiver returns to
`full`. The receiver MUST commit a Group Meta cursor greater than or equal to
`groupMetaFeedEndId` before committing this state item; a later projection may
legitimately overtake the feed-head hint while the consumer is fetching it.

The group owner is derived from the member carrying role `OWNER`; membership
and active local participation are derived from current member keys.
Non-member-derived settings are not federated.

## 7. Ordering, recovery, and authorization

A source commits a relationship direction before dependent `PROFILE` or
`GROUP_META_FEED_HEAD` items become visible. The consumer applies relationship
and identity dependencies before materializing group-meta effects, regardless
of their relative placement within one fetched page.

A malformed item is isolated according to the common permanent-item rules. A
failed group-meta fetch or page transaction does not advance the state cursor.
Hints may be lost, repeated, or reordered; startup and periodic reconciliation
must drain from the durable local cursor.

Removing a current state-feed projection allocates no deletion item unless the
event's own state machine defines a durable terminal fact, such as
`RELATIONSHIP_INTENT/REVOKED`. Projection omission cannot by itself delete
messages, users, threads, or group-member state.
