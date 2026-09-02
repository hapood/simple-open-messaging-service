# Simple Open Messaging Federation Protocol v1 Group Meta Feed

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document is entirely normative. `GET /s2s/v1/group-meta` exposes the one
canonical Group Meta Feed owned by a group's origin. The feed is the origin's
authoritative member roster and role state; it is not copied once per target
peer. Mirrors derive group membership and the owner from this feed. It also carries the
group's exact profile revision as a compacted `GROUP_PROFILE` item. Member
items carry an exact immutable profile reference but no member name, avatar, or
biography. No group settings,
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

The authenticated peer MUST have at least one effective source-authored
group-to-member `REQUESTED` or `ACCEPTED` direction whose member belongs to that
peer. One effective direction authorizes passive Group Meta querying, but the
source MUST NOT publish a Group Meta head or wake hint until the relationship is
confirmed. For GROUP, at least one member hosted by that peer MUST remain
confirmed. Otherwise the source returns
`FORBIDDEN`. A departing peer converges the leave through
`RELATIONSHIP_INTENT/REVOKED`; it has no terminal Group Meta access. Each peer
authorization segment has a delta visibility floor in the canonical group
coordinate space. A newly authorized
or reauthorized peer MUST NOT use delta mode to enumerate changes committed
before that floor; full mode exposes only the current roster at its fixed
boundary.

The visibility floor applies differently to the two modes. A delta request
MUST have `after` at or above the floor. A full drain's fixed `through` MUST be
at or above the floor, but the current `UPSERT` selected for a member MAY have
an older `feedId`; exposing that current item is necessary to construct the
roster and does not expose an intervening historical mutation. A full request
with an upper bound below the floor is unavailable. These rules prevent a new
audience from selecting a pre-authorization historical roster while still
allowing the peer to initialize the current roster.

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
  profileRev: SafeInteger;
}
```

`feedId` is the item coordinate in the origin-owned group's one canonical feed.
It is strictly increasing, never reused, and independent of every other group.
`GROUP_META_FEED_HEAD.groupMetaFeedEndId`, `after`, `through`, `scannedThrough`, and
`groupMetaFeedEndId` use this same exact-decimal coordinate space.
Closing and later restoring one peer's authorization does not reset the group
coordinate space or create a peer-specific copy. Reauthorization advances that
audience's delta visibility floor instead.

Member items have stable key `(member account, member domain)`. Their required,
non-null `profileRev` selects an immutable complete profile snapshot retained by the
group origin when positive. The value `0` means that the projection has no
profile; the consumer MUST NOT issue a Group Member Profile request for it. A
positive reference is resolved through
[Group Member Profile](./group-member-profile.md) and is not an assertion about
the member's default or numerically newest profile. A member profile update by
itself MUST NOT republish a member item or advance this feed.

The `UPSERT` that first makes a membership current MUST carry the exact
`profileRev` selected by the effective member-authored join intent. The origin
MUST NOT replace it with the member's default revision observed later while
asynchronous work is pending. Later profile changes and messages do not mutate
that current Group Meta member reference. A new membership interval selects a
new initial reference from its new member-authored intent; a role-only mutation
may preserve the current reference.

The single
`GROUP_PROFILE` projection has a separate group-wide stable key and carries no
member identity. Its `profileRev` applies to the page's group `account`. Group
Meta does not carry the group name, biography, or avatar bytes. A zero value
means that the group has no profile and MUST NOT trigger Authorized Profile.

When the group profile changes, the origin allocates one new `GROUP_PROFILE`
item in the canonical group feed and advances the group's
`groupMetaFeedEndId`. The newly allocated item replaces the older projection
for the same stable key; compaction preserves the new item's allocated `feedId`
rather than retaining or reusing the older item's coordinate. The consumer
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

Only `UPSERT` carries role and profile reference state. `DEPART` is a distinct
closed item with only `feedId`, member Address, and `operation`; `body`, `role`,
and `profileRev` MUST be absent. A mirror deletes its current member projection
when it commits `DEPART`. A later `UPSERT` for the same stable key creates a new
current member projection with the newly selected role and exact profile
reference. A role mutation MAY preserve the preceding `profileRev`; it does not
need to discover the member's default revision.

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
successful completion it deletes every mirror member absent from the snapshot.
A failed or incomplete full drain MUST NOT alter the committed roster or
cursor.

The source MUST retain the latest `UPSERT` needed to reproduce every current
member and the latest `GROUP_PROFILE` needed to reproduce the current group
profile reference for an active bounded full drain. The group origin retains
the exact complete member profile snapshots separately for Group Member Profile; Group
Meta has no historical-message-author obligation.

## 4. Delta mode

Delta mode returns retained `UPSERT`, `DEPART`, and `GROUP_PROFILE` changes in
feed order. A consumer applies member items by stable member key, applies
`GROUP_PROFILE` by its separate group-wide stable key, and adopts its page
cursor atomically. `DEPART` deletes the mirror's current member projection.
Items at or below the committed feed cursor are already applied and MUST NOT be
replayed.

The source MAY compact an older `DEPART` after it is no longer required by an
active bounded drain or by the current roster result. Message-author profile
retention is independent of Group Meta and is defined by
[Message Author Profile](./message-author-profile.md). If `after` is below the
audience visibility floor or the feed's delta retention floor, the source MUST return
`FEDERATION_FEED_CURSOR_UNAVAILABLE` with the common exclusive
`resumeAfter/resumeBefore` boundaries. The consumer restarts with
`mode=full`, `after=resumeAfter`, and fixed
`through=resumeBefore-1`. It MUST discard no committed roster until that
replacement full drain succeeds atomically.

## 5. State-feed dependency

The origin commits a canonical Group Meta item once, then asynchronously
publishes `GROUP_META_FEED_HEAD { groupMetaFeedEndId }` to each currently
authorized audience. The hint's `groupMetaFeedEndId` MUST identify a committed
position in the canonical group feed at publication time. The
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
