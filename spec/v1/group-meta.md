# Simple Open Messaging Federation Protocol v1 Group Meta Feed

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document is entirely normative. `GET /s2s/v1/group-meta` is the sole
federation source of an origin-owned group's member roster and roles. Receivers
derive group membership and the owner from this feed. It also carries the
group's exact profile revision as a compacted `GROUP_PROFILE` item. It carries
no member name, avatar, biography, or profile revision. No group settings,
owner field, active flag, dissolution flag, or complete roster is carried by
`state-feed`.

## 1. Request

The closed query contains the Group Meta-specific `account` and `mode` fields
plus the common feed parameters `after`, `take`, and `through`:

```ts
type GroupMetaMode = 'full' | 'delta';
```

- `account` MUST be an origin-owned `GroupAccount`.
- `mode` MUST be `full` or `delta`.
- `after` is an optional exclusive non-negative `DecimalString` feed cursor.
- `take` is an optional positive safe-integer suggestion.
- `through` is an optional inclusive `DecimalString` upper bound and MUST be at
  least `after`.
- Unknown, duplicate, or invalid parameters return `400 FEDERATION_MALFORMED`.

When `after` is omitted, `take` and `through` MUST also be omitted. The source
returns HTTP `200 FEDERATION_FEED_CURSOR_UNAVAILABLE` with `resumeAfter=0` and
`resumeBefore=groupMetaFeedEndId+1`. The consumer uses that window for the
initial full drain. An unavailable delta cursor returns the same full-recovery
window.

Both modes use the common feed paging contract. A bounded drain fixes `through`
on its first page and MUST reuse that value on every later page. Initial full
synchronization starts with `after=0`; delta starts with the last atomically
committed `scannedThrough`.

The authenticated peer MUST have a durable target projection for the group.
For this operation, that projection exists only while an origin-authored
`ACCEPTED` relationship authorizes at least one effective member from the peer;
the core protocol's more general `REQUESTED` query grant does not by itself
authorize Group Meta. Otherwise the source returns `FORBIDDEN`. A departing
peer converges the leave through `RELATIONSHIP_INTENT/REVOKED`; it has no
terminal Group Meta access. Member `DEPART` records remain visible to other
peers that are still authorized.

## 2. Page and coordinates

```ts
interface GroupMetaFeedPage {
  account: GroupAccount;
  mode: GroupMetaMode;
  items: GroupMetaItem[];
  scannedThrough: DecimalString;
  groupMetaFeedEndId: DecimalString;
  hasMore: boolean;
}

interface GroupMetaMemberItemBase {
  feedId: PositiveDecimalString;
  account: UserAccount;
  domain: Domain;
}

interface GroupMetaUpsertItem extends GroupMetaMemberItemBase {
  operation: 'UPSERT';
  body: GroupMetaMemberBody;
}

interface GroupMetaDepartItem extends GroupMetaMemberItemBase {
  operation: 'DEPART';
  body: GroupMetaMemberBody;
}

interface GroupMetaProfileItem {
  feedId: PositiveDecimalString;
  operation: 'GROUP_PROFILE';
  body: {
    profileRev: SafeInteger;
  };
}

type GroupMetaItem =
  | GroupMetaUpsertItem
  | GroupMetaDepartItem
  | GroupMetaProfileItem;

interface GroupMetaMemberBody {
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}
```

`feedId` is the item coordinate in one `(target peer, group)` feed. It is
strictly increasing, never reused, and independent of every other feed.
`GROUP_META_FEED_HEAD.groupMetaFeedEndId`, `after`, `through`, `scannedThrough`, and
`groupMetaFeedEndId` use this same exact-decimal coordinate space.
Closing and later restoring authorization for the same target peer and group
MUST NOT reset this coordinate space or reuse a prior `feedId`.

Member items have stable key `(member account, member domain)`. The single
`GROUP_PROFILE` projection has a separate group-wide stable key and carries no
member identity. Its `profileRev` applies to the page's group `account`. Group
Meta does not carry the group name, biography, or avatar bytes.

When the group profile changes, the origin allocates a new `GROUP_PROFILE` item
for every authorized target peer and advances that target's
`groupMetaFeedEndId`. Compaction may replace the older item for the same stable
key, but the surviving item's original `feedId` is preserved. The consumer
selects the committed `GROUP_PROFILE` item with the greatest `feedId`; it does
not compare `profileRev` values. It resolves that exact `(group account,
profileRev)` through [Authorized Profile](./authorized-profile.md).

For one consistent source snapshot:

```text
scanEnd = through is present ? min(groupMetaFeedEndId, through) : groupMetaFeedEndId
```

Items MUST be strictly increasing by `feedId` and lie in
`(after, scannedThrough]`. If candidates remain through `scanEnd`,
`hasMore=true` and `scannedThrough>after`; otherwise `hasMore=false` and
`scannedThrough=scanEnd`. Gaps and an empty page may advance
`scannedThrough`. `take` is a suggested scan count and the source MAY use a
different finite page size. The consumer commits page effects and
`scannedThrough` atomically.

Exactly one current member has role `OWNER` in every non-empty roster. The
receiver derives the owner from that role and derives its local active state by
whether one of its own users remains in the roster. Non-member-derived settings
are local policy and are not federated facts.

Both `UPSERT` and `DEPART` carry the same role-only body. A `DEPART` preserves
the stable Address and final role but carries no member profile. The consumer
marks the member departed instead of deleting the retained roster projection.
A later `UPSERT` for the same stable key marks the member current again and
replaces its role.

`feedId`, message `seq`, and `profileRev` are distinct coordinate spaces. A
Group Meta `feedId` selects the newest group-profile reference but MUST NOT be
used as a profile revision or message coordinate.

## 3. Full mode

Full mode is an authoritative snapshot of the current roster at the fixed
`through`. It returns exactly one `UPSERT` for each member whose latest
operation at or below `through` is `UPSERT`, using that operation's `feedId`.
It MUST NOT return `DEPART` items or members whose latest operation at that
boundary is `DEPART`. It also returns exactly one `GROUP_PROFILE`: the newest
such item at or below `through`.

The consumer accumulates the bounded full drain and applies it atomically. On
successful completion it marks every previously materialized member absent
from the snapshot as departed, without deleting the retained roster
projection. A failed or incomplete full drain MUST NOT alter the committed
roster or cursor.

The source MUST retain the latest `UPSERT` needed to reproduce every current
member and the latest `GROUP_PROFILE` needed to reproduce the current group
profile reference for an active bounded full drain. Full Group Meta has no
member display-profile or historical-message-author obligation.

## 4. Delta mode

Delta mode returns retained `UPSERT`, `DEPART`, and `GROUP_PROFILE` changes in
feed order. A consumer applies member items by stable member key, applies
`GROUP_PROFILE` by its separate group-wide stable key, and adopts its page
cursor atomically. `DEPART` marks the retained projection departed instead of
removing it. Items at or below the committed feed cursor are already applied
and MUST NOT be replayed.

The source MAY compact an older `DEPART` after it is no longer required by an
active bounded drain or by the current roster result. Message-author profile
retention is independent of Group Meta and is defined by
[Message Author Profile](./message-author-profile.md). If `after` is below the
delta retention floor, the source MUST return
`FEDERATION_FEED_CURSOR_UNAVAILABLE` with the common exclusive
`resumeAfter/resumeBefore` boundaries. The consumer restarts with
`mode=full`, `after=resumeAfter`, and fixed
`through=resumeBefore-1`. It MUST discard no committed roster until that
replacement full drain succeeds atomically.

## 5. State-feed dependency

For each visible target peer, the origin commits Group Meta items before
publishing `GROUP_META_FEED_HEAD { groupMetaFeedEndId }` in state-feed. The
hint's `groupMetaFeedEndId` MUST equal the target group feed's latest committed `feedId` at publication time. The
receiver first commits relationship and group identity dependencies, drains
Group Meta until its committed cursor is at least `groupMetaFeedEndId`, and only then
commits that state-feed item. The hint is not roster data and cannot itself add
or remove a member.

Before an origin makes a newly accepted group message queryable or publishes
its `THREAD_CONTENT_HEAD`, the author's Address and role projection MUST
already be committed in Group Meta. The corresponding `GROUP_META_FEED_HEAD`
MUST precede the thread-content item in State Feed. A later lightweight
`feed-heads` hint advertises a `stateFeedEndId` covering both items. The
consumer drains that state and Group Meta dependency while reconciling the
corresponding message interval. The author's display data is not a Group Meta
dependency and is fetched using the exact message coordinate when needed.
