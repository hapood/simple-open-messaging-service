# Simple Open Messaging Federation Protocol v1 Group Meta Feed

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document is entirely normative. `GET /s2s/v1/group-meta` is the sole
federation source of an origin-owned group's member roster, member roles, and
source-scoped member display profiles. Receivers derive group membership and
the owner from this feed. No group settings, owner field, active flag,
dissolution flag, or complete roster is carried by `state-feed`.

For each target peer, the feed covers the current roster only. It does not
provide a historical roster or guarantee a member/profile projection for every
author in retained message history.

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

interface GroupMetaItemBase {
  feedId: PositiveDecimalString;
  account: UserAccount;
  domain: Domain;
}

interface GroupMetaUpsertItem extends GroupMetaItemBase {
  operation: 'UPSERT';
  body: GroupMetaMemberBody;
}

interface GroupMetaDepartItem extends GroupMetaItemBase {
  operation: 'DEPART';
  body: Record<string, never>;
}

type GroupMetaItem = GroupMetaUpsertItem | GroupMetaDepartItem;

interface GroupMetaMemberBody {
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  profileRev: SafeInteger;
  displayName: string;
  avatar: InlineProfileAvatar | null;
}
```

`feedId` is the item coordinate in one `(target peer, group)` feed. It is
strictly increasing, never reused, and independent of every other feed.
`GROUP_META_FEED_HEAD.groupMetaFeedEndId`, `after`, `through`, `scannedThrough`, and
`groupMetaFeedEndId` use this same exact-decimal coordinate space.
Closing and later restoring authorization for the same target peer and group
MUST NOT reset this coordinate space or reuse a prior `feedId`.

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

Member display data is source-scoped. Different group origins MAY publish
different display data or profile revisions for the same member Address. A
receiver MUST isolate those projections by
`(source origin domain, member domain, member account)` and MUST NOT globally
merge them by member Address alone.

Exactly one current member has role `OWNER` in every non-empty roster. The
receiver derives the owner from that role and derives its local active state by
whether one of its own users remains in the roster. Non-member-derived settings
are local policy and are not federated facts.

An `UPSERT` supplies the member information. In delta mode, a later `DEPART`
marks that member as departed; it does not authorize the receiver to erase a
retained member or profile projection. A later `UPSERT` for the same stable key
marks the member current again and replaces its role/profile fields. The shared
`InlineProfileAvatar` rules apply to every non-null `avatar`.

## 3. Full mode

Full mode is an authoritative snapshot of the current roster at the fixed
`through`. It returns exactly one `UPSERT` for each member whose latest
operation at or below `through` is `UPSERT`, using that operation's `feedId`.
It MUST NOT return `DEPART` items or members whose latest operation at that
boundary is `DEPART`.

The consumer accumulates the bounded full drain and applies it atomically. On
successful completion it marks every previously materialized member absent
from the snapshot as departed, without deleting the retained member or profile
projection. A failed or incomplete full drain MUST NOT alter the committed
roster or cursor.

The source MUST retain the latest `UPSERT` needed to reproduce every current
member for an active bounded full drain. It has no Group Meta retention or
disclosure obligation for departed members or historical message authors.

## 4. Delta mode

Delta mode returns retained `UPSERT` and `DEPART` changes in feed order. A
consumer applies each item by stable member key and commits its page cursor in
the same transaction. `DEPART` marks the retained projection departed instead
of removing it. Items at or below the committed feed cursor are already applied
and MUST NOT be replayed.

The source MAY compact history that is not needed for a current member or a
speaker in the target peer's visible interval. If
`after` is below the delta retention floor, the source MUST return
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
