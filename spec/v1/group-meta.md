# Simple Open Chat Federation Protocol v1 Group Meta Feed

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document is entirely normative. `GET /s2s/v1/group-meta` is the sole
federation source of an origin-owned group's member roster, member roles, and
source-scoped member display profiles. Receivers derive group membership and
the owner from this feed. No group settings, owner field, active flag,
dissolution flag, or complete roster is carried by `state-feed`.

## 1. Request

The closed query contains the Group Meta-specific `account` and `mode` fields
plus the common feed parameters `after`, `take`, and `through`:

```ts
type GroupMetaMode = 'full' | 'delta';
```

- `account` MUST be an origin-owned `GroupAccount`.
- `mode` MUST be `full` or `delta`.
- `after` MUST be an exclusive non-negative `DecimalString` feed cursor.
- `take` is an optional positive safe-integer suggestion.
- `through` is an optional inclusive `DecimalString` upper bound and MUST be at
  least `after`.
- Unknown, duplicate, or invalid parameters return `400 FEDERATION_MALFORMED`.

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
terminal Group Meta access. Member `DELETE` records remain visible to other
peers that are still authorized.

## 2. Page and coordinates

```ts
interface GroupMetaPage {
  account: GroupAccount;
  mode: GroupMetaMode;
  items: GroupMetaItem[];
  scannedThrough: DecimalString;
  groupMetaFeedEndId: DecimalString;
  hasMore: boolean;
}

interface GroupMetaItem {
  feedId: PositiveDecimalString;
  account: UserAccount;
  domain: Domain;
  rev: SafeNonNegativeInteger;
  operation: 'UPSERT' | 'DELETE';
  body: GroupMetaMemberBody | Record<string, never>;
}

interface GroupMetaMemberBody {
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  profileRev: SafeNonNegativeInteger;
  displayName: string;
  avatar: ProfileAvatar | null;
}
```

`feedId` is the item coordinate in one `(target peer, group)` feed. It is
strictly increasing, never reused, and independent of every other feed.
`GROUP_META_FEED_HEAD.groupMetaFeedEndId`, `after`, `through`, `scannedThrough`, and
`groupMetaFeedEndId` use this same exact-decimal coordinate space.
Closing and later restoring authorization for the same target peer and group
MUST NOT reset this coordinate space or reuse a prior `feedId`.

Member `rev` is a separate business revision scoped to the stable member key
`(domain, account)`. Each changed `UPSERT` or `DELETE` for that key MUST have a
strictly greater member `rev`; rejoining MUST NOT reset it. Member revisions
from different stable keys are unrelated and MAY be equal. A consumer uses
`feedId` for paging and member `rev` to reject an older member projection.

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

## 3. Full mode

Full mode scans the latest record for every stable member key as of the fixed
`through`. It returns current `UPSERT` records and filters current `DELETE`
records. Completing the bounded drain is sufficient to reconstruct membership
from no prior state. The consumer MUST stage all full pages and atomically
replace its roster only after the drain completes; a partial full drain has no
roster effect.

The source MUST retain enough stable-key history to reproduce the full
projection for an active bounded drain. It MUST retain every current `UPSERT`
for as long as the target projection exists. Compaction or a concurrent update
MUST NOT make a member that was current at the fixed `through` disappear from
that full reconstruction.

## 4. Delta mode

Delta mode returns retained `UPSERT` and `DELETE` changes in feed order. A
consumer applies each item by stable member key and commits its page cursor in
the same transaction. Replaying a committed-or-older member `rev` is a business
no-op, while its valid feed coordinate still participates in scanning.

The source MAY compact obsolete history when service capacity is insufficient,
but MUST retain the newest stable-key record needed for full reconstruction. If
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
