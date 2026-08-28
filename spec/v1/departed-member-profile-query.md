# Simple Open Messaging Federation Protocol v1 Departed Member Profile Feed

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

Normative scope: this entire document is normative.

This document defines `GET /s2s/v1/departed-member-profiles`. The operation is
a reverse-only compressed feed. It returns source-scoped profiles for members
whose last allocated authored group-message sequence lies in a selected
historical interval and who are absent from the origin-authoritative current
roster. It complements complete historical member projections retained from
Group Meta `DEPART` items during ordinary forward synchronization. It does not
reconstruct a historical roster or assert current membership.

## 1. Request and authorization

The closed query contains `account`, optional `before`, and optional `through`
and `take` when `before` is present:

| Field     | Type                               | Rule                                                             |
| --------- | ---------------------------------- | ---------------------------------------------------------------- |
| `account` | `GroupAccount`                     | Required origin-owned group.                                     |
| `before`  | `DecimalString`                    | Optional exclusive reverse message-sequence cursor.              |
| `through` | `DecimalString`                    | Optional fixed inclusive lower bound of a bounded reverse query. |
| `take`    | `PositiveSafeInteger` query string | Optional suggested maximum number of returned profiles.          |

`take` and `through` MAY appear only when `before` is present. For
`before=B&through=T`, `T` MUST be at most `B`. `after` is not a parameter of
this operation. Unknown, duplicate, or malformed parameters return
`400 FEDERATION_MALFORMED`. The fixed query-key order is `account`, `before`,
`through`, then `take`; omitted optional fields leave no placeholder.

All cursors use the selected group's authoritative message `seq` coordinate
space and are non-negative canonical decimal strings no greater than
`SafeInteger`. They are not feed IDs and do not create another message sequence
space.

The source MUST be the selected group's origin. The verified signer MUST hold a
currently authorized mirror of the group and MUST be authorized to query the
corresponding message interval. Otherwise the source returns `FORBIDDEN`. A
successful result discloses no member or profile outside the signer's
historically visible message allocation.

## 2. Bootstrap and continuous reverse processing

Omitting `before` bootstraps the feed. The source returns
`FEDERATION_FEED_CURSOR_UNAVAILABLE { resumeAfter, resumeBefore }` and no
profiles. The boundaries MUST equal the current open serviceable window of the
corresponding group message query from the same consistent source state.

A skip-mode reverse consumer MUST first converge the latest state feed, finish
a current Group Meta full drain, and commit the `THREAD_CONTENT_HEAD` item that selects
the group tail. If that item's inclusive `messageEndSeq` is `E`, the first
reverse profile request MUST use `before=E+1`, matching the first reverse
message window. Every later page MUST use the preceding successfully committed
page's `scannedThrough` as `before` while retaining the original `through`. A
consumer MUST NOT start at an unrelated intermediate sequence. If the selected
cursor is outside the current serviceable window, the consumer applies common
cursor recovery and reconciles a new thread-content boundary. This continuity
requirement MUST survive consumer restart.

The source stores no consumer acknowledgement and need not enforce that a
cursor equals the consumer's preceding page.

## 3. Page and compressed selection

```ts
interface DepartedMemberProfilePage {
  members: DepartedMemberProfile[];
  scannedThrough: SafeInteger;
  hasMore: boolean;
}

interface DepartedMemberProfile {
  account: UserAccount;
  domain: Domain;
  lastSentSeq: PositiveThreadSequence;
  profileRev: SafeInteger;
  displayName: string;
  avatar: InlineProfileAvatar | null;
}
```

For every returned member, the source MUST establish from one consistent
snapshot that the member is absent from the current authoritative roster and
authored at least one message allocated to the target peer in the selected
group. A reverse window `[T, B)` returns a departed member when that member's
last allocated authored-message sequence for the target peer lies in the
window. The returned `lastSentSeq` is that selection sequence. It is a JSON
`PositiveThreadSequence` and MUST satisfy `T <= lastSentSeq < B` for the
request. This is an observable selection requirement; the protocol does not
prescribe an index, database field, or storage strategy.

The returned profile is source-scoped exactly as in Group Meta. A consumer MUST
isolate it by `(source origin domain, member domain, member account)`, MUST merge
only a greater `profileRev`, and MUST NOT treat it as a public profile or a
current membership assertion. No historical role is returned or inferred by
this reverse feed.

Results are ordered by `lastSentSeq` descending. The order among members with
the same `lastSentSeq` is not significant. The source MUST NOT split members
with the same `lastSentSeq` across pages. A member appears at most once in one
bounded drain. A consumer uses `lastSentSeq` for selection, ordering, and
pagination.

If candidates remain below the response, `scannedThrough` equals the smallest
fully scanned message sequence and `hasMore=true`; otherwise it equals the
inclusive `through` bound and `hasMore=false`. Returned selection sequences lie
in `[scannedThrough, before)`, and the next page uses
`before=scannedThrough`. An empty page may scan directly to the lower bound.
`take` is a suggestion and MUST NOT split members at one `lastSentSeq` or cause
a qualifying member to be skipped across `scannedThrough`.

Applying a page's profiles and adopting `scannedThrough` MUST be atomic.
Repeated pages are semantically idempotent. A lower or equal `profileRev` MUST
NOT replace a newer committed source-scoped profile.

## 4. Publication and consumption ordering

Before a newly accepted group message becomes queryable, the origin MUST
commit the author, membership, audience, Group Meta projection, and reverse
selection fact needed to answer every authorized feed query consistently. The
origin MUST make the message queryable only after that closure is visible, then
publish the dependent `THREAD_CONTENT_HEAD` item, and only then send a `feed-heads`
lightweight hint. Every allocated authored message MUST update the member's
last-message selection fact atomically with that allocation.

Ordinary forward synchronization MUST NOT query this feed. It obtains complete
retained historical members from Group Meta `DEPART` items. The consumer SHOULD
drain and commit the required Group Meta head, including each departure's
member body, while reconciling the corresponding group-message interval. If
Group Meta has not converged, the stable author Address remains valid, the
consumer MUST continue the Group Meta drain, and it MUST NOT infer a role or
current-membership state from the absent profile projection.

Skip-mode reverse reconstruction MUST apply the corresponding departed-member
profile page before completing reconciliation of that reverse window. A failed
or incomplete page cannot be bypassed.

A historical author who has rejoined is omitted because the author is again
present in the source's current roster; that member converges through a newer
Group Meta `UPSERT`. If that projection has not yet reached the consumer, the
stable author Address remains valid and the consumer MUST continue draining
Group Meta until the current-member projection commits.

Temporary absence caused by this race MUST NOT invalidate the message, imply
that the author never belonged to the group, or imply deletion. The exception
applies only to an author omitted because that author is current at the source;
it MUST NOT cover another missing profile or a reverse query that started at an
intermediate sequence. The forward tombstone publication barrier is unchanged.
