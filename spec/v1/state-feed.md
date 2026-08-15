# Simple Open Chat Federation Protocol v1 State Feed

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document is entirely normative.

This document defines the compact snapshot feed `GET /s2s/v1/state-feed`. It
shares the `feedId/after/through/take` scan model with the two index feeds, but
each item directly contains an idempotently mergeable current state snapshot;
no additional query is required. Common identity, signing, response, and error
rules are defined in the [core protocol](./protocol.md).

## 1. Request

The query is a closed parameter set:

| Field | Type | Requirement |
| --- | --- | --- |
| `after` | `DecimalString` query string | Optional exclusive consumer scan position. When omitted, only `resumeAfter` is returned, not a page. |
| `take` | `PositiveSafeInteger` query string | Optional requested maximum number of items. The publisher MAY return fewer but MUST NOT return more. |
| `through` | `DecimalString` query string | Optional inclusive upper bound for this scan. It MUST be greater than or equal to `after` and remain unchanged across bounded pagination. |

`take` neither guarantees a page of that size nor promises a safe response byte
size. A publisher MUST accept every valid `PositiveSafeInteger` and MAY return
fewer items to enforce finite local item or response-byte limits. It MUST NOT
return `FEDERATION_MALFORMED` merely because `take` exceeds its page size. Every
individual snapshot allocated to the feed MUST be returnable in full by that
publisher. v1 specifies no common JSON byte limit, but a snapshot MUST NOT be
truncated. A consumer MAY stop if a response exceeds its local capacity.
`through` only freezes the scan window; it does not acknowledge, delete, or
downgrade state.

When `after` is omitted, `take` and `through` MUST also be omitted. The source
MUST return HTTP `200 FEDERATION_FEED_CURSOR_UNAVAILABLE` whose data contains
only the currently available exclusive cursor `resumeAfter`. The consumer
atomically stores that value and starts normal reads with `after=resumeAfter`;
it MUST NOT guess an initial ID. The publisher defines this starting point.
Feed item IDs are positive integers, while cursors and ends are non-negative
integers. `0` is the exclusive cursor before the first item, not an item ID.
Draining from `resumeAfter` MUST reconstruct the complete current state
projection. If current items exist, the publisher MUST NOT use
`stateFeedEndId` as the bootstrap point and thereby skip them.

## 2. Pages and reliable cursors

The `data` of a successful envelope MUST be this closed object:

```ts
interface StateFeedPage {
  items: StateFeedItem[];
  scannedThrough: DecimalString;
  stateFeedEndId: DecimalString;
  hasMore: boolean;
}
```

The publisher reads `stateFeedEndId` from one consistent source snapshot and
calculates:

```text
scanEnd = through is present ? min(stateFeedEndId, through) : stateFeedEndId
```

Every successful page MUST satisfy all of the following:

1. `after <= scannedThrough <= scanEnd <= stateFeedEndId`.
2. Every `item.feedId` is in `(after, scannedThrough]`, in strictly increasing
   numeric order.
3. `hasMore` is true if and only if `scannedThrough < scanEnd`.
4. If `hasMore` is true, `scannedThrough > after`.
5. If `hasMore` is false, `scannedThrough === scanEnd`.
6. A page may contain no items; gaps and compacted keys do not prevent
   `scannedThrough` from advancing.
7. A stable key appears at most once in a page.

The consumer MUST fully validate a page and atomically commit all its effects
with `scannedThrough`. A malformed item, identity or binding mismatch, or
authorization failure MUST roll back the entire page and cursor. After
`hasMore: true`, the next page MUST use this page's `scannedThrough`; a bounded
drain MUST also reuse the original `through`.

### 2.1 Compact projection without source acknowledgements

The publisher does not maintain `acknowledgedThrough`, `lastServedThrough`, or
another consumer cursor. Every `after` in `[0, stateFeedEndId]` is readable,
including repeated or older positions. The publisher MUST NOT treat `after` as
an acknowledgement or remove the current projection because it was read.

The publisher MUST durably retain the latest snapshot for every current stable
key. When a greater business revision supersedes it, the publisher MUST
allocate a `feedId` greater than every earlier ID in that feed. It MUST NOT
reuse an old ID or rewrite an ID a consumer may have passed. The older version
may be compacted immediately. An omitted `after` or an `after` greater than
`stateFeedEndId` may receive a valid `resumeAfter`; compaction alone MUST NOT
make a cursor unavailable.

## 3. Common item and identity

```ts
type StateEventType =
  | 'PROFILE'
  | 'MEMBER_PROFILE'
  | 'P2P_INTENT'
  | 'GROUP_INVITE_INTENT'
  | 'GROUP_JOIN_INTENT'
  | 'GROUP_META';

interface StateFeedItem {
  account: Account;
  domain: Domain;
  eventType: StateEventType;
  subjectAccount: Account | '';
  subjectDomain: Domain | '';
  revision: DecimalString;
  feedId: PositiveDecimalString;
  body: StateBody;
}
```

Every item and body is a closed object. The stable key is:

```text
(domain, account, eventType, subjectDomain, subjectAccount)
```

`revision` is the business version of that stable key. Business content may
change only with a strictly greater revision; an equal or lower revision MUST
NOT replace the body. Consumers merge idempotently by stable key and revision,
not by `feedId`. If an already stored revision arrives with a semantically
different body, the consumer MUST reject the page and record a protocol
conflict. Except for the member-before-group dependency repair in Section 6,
an identical revision and body does not receive a new `feedId`.

For `PROFILE`, `MEMBER_PROFILE`, and `GROUP_META`, both subject fields MUST be
`""`. For each intent, the subject fields MUST form a complete non-empty
`Address`.

| Event | `account/domain` | `subjectAccount/subjectDomain` | Signer requirement |
| --- | --- | --- | --- |
| `PROFILE` | Profile subject | Empty | `domain` MUST equal the signer domain. |
| `MEMBER_PROFILE` | Member profile subject | Empty | The signer publishes this source-scoped snapshot; the subject may belong to another domain. |
| `P2P_INTENT` | Actor for this direction | Other party | Actor domain MUST equal the signer and subject domain MUST equal the consumer. Both accounts MUST be `UserAccount`. |
| `GROUP_INVITE_INTENT` | Origin-owned group | Invited member | Group domain MUST equal the signer and member domain MUST equal the consumer. |
| `GROUP_JOIN_INTENT` | Origin-owned group | Applying member | Group domain MUST equal the consumer and member domain MUST equal the signer. |
| `GROUP_META` | Origin-owned group | Empty | Group domain MUST equal the pinned signer/origin. |

## 4. Display profiles and minimum disclosure

```ts
interface ProfileAvatar {
  digest: Sha256Hex;
  mimeType: string;
  base64: string;
  width: PositiveSafeInteger;
  height: PositiveSafeInteger;
}
```

`base64` MUST be whitespace-free RFC 4648 padded Base64 that strictly decodes
to non-empty image bytes. `digest` MUST equal the SHA-256 of those bytes.
`width` and `height` MUST equal the decoded image's actual dimensions, and
their product MUST NOT exceed `16000000`. `mimeType` MUST be a non-empty MIME
string matching the actual image format.

`displayName` contains 1–30 Unicode code points and `bio` contains 0–120. They
MUST NOT contain unpaired surrogates. Display fields, avatars, and biographies
grant no identity, relationship, membership, message, or resource permission.

### 4.1 `PROFILE`

`PROFILE` is the complete account profile published by an identity home server
to a peer with direct profile visibility. The subject may be a `UserAccount`
needed for an exact P2P request or existing P2P relationship, or an
origin-owned `GroupAccount` needed for a group invitation or audience.

```ts
interface ProfileBody {
  displayName: string;
  bio: string;
  avatar: ProfileAvatar | null;
  deleted: boolean;
  extensions?: Record<ExtensionId, JsonObject>;
}
```

`extensions` follows [Core Protocol Section 2.1](./protocol.md#21-extension-capability).
The publisher MAY include only entries accepted by the target peer in the most
recent valid Health response and still advertised by that peer's v1 discovery
response. Omission is equivalent to an empty object. Extension data is part of
the complete profile snapshot; adding, changing, or removing a sent entry MUST
allocate a greater profile `revision`. A consumer strictly validates supported
entries and ignores unsupported entries within their bounded values. It MUST
NOT reject an otherwise valid `PROFILE` because an entry is unsupported.

`revision` is the subject's profile revision. `deleted: true` is an account
profile tombstone; it neither resets server identity nor implicitly revokes an
independently published relationship direction. A publisher MUST allocate the
profile only to a peer that currently has direct P2P or group profile
visibility, or needs it for an exact P2P request or group-invitation mirror.

Exact user lookup is a separate disclosure context. `GET /users/:account`
returns only the minimum public identity card defined by the resource
specification and MUST NOT be expanded merely because `PROFILE` contains `bio`
or tombstone state. A consumer MUST NOT treat a proxied lookup result as a
relationship or state projection. A human user's home-authored profile is not
sufficient to establish a persistent relationship identity: a valid
`ACCEPTED` intent and a non-deleted profile from that identity home are both
required. This rule does not constrain lazy materialization of group mirrors.

### 4.2 `MEMBER_PROFILE`

`MEMBER_PROFILE` is display metadata that a target peer needs for an explicit
source such as a shared group. It does not assert membership in any particular
group; only `GROUP_META.members` defines the roster.

```ts
interface MemberProfileBody {
  displayName: string;
  avatar: ProfileAvatar | null;
  extensions?: Record<ExtensionId, JsonObject>;
}
```

Its `extensions` follow the same unidirectional capability, complete-snapshot,
and revision rules as `PROFILE.extensions`. They remain source-scoped display
metadata and grant no membership or other permission.

For each `(target peer, member Address)`, the publisher MUST maintain the
complete current set of visibility sources:

- When the first source appears, it publishes a complete `MEMBER_PROFILE`.
- While at least one source remains, adding or removing another source does not
  remove the snapshot.
- A profile revision is published only to peers that still have a source.
- When the last source disappears, the publisher removes the stable key from
  the current projection without allocating a removal item or retaining a
  visibility tombstone.

The source set is authoritative; a source count is only derived data. A
consumer MUST scope snapshots by `(signer domain, member Address)`. Snapshots
of the same member from different signers may diverge and MUST NOT be merged by
member address or profile revision across signers.

Projection omission is not a deletion event. A consumer may remove an
unreferenced source-scoped snapshot only after atomically completing a bounded
state-feed drain to a fixed target. That target is either a feed-head hint or
the `stateFeedEndId` returned by the first successful page in a drain that did
not specify `through`; that first page is part of the same drain, and every
later page MUST use `through=target`. Cleanup is permitted only after committing
all page effects and the final cursor with
`hasMore: false && scannedThrough === target`.

The consumer then evaluates snapshots against the latest committed P2P
relationships and complete replacement group rosters from that signer. A
member snapshot may be removed only when the member is neither a friend of a
local user nor shares any group with a local user. Cleanup MUST NOT occur
between pages, after a failed page, or before reaching the target. Removing
display metadata MUST NOT remove messages or their stable author addresses.
State re-indexed beyond the fixed target is reconciled by a later hint or
periodic drain.

## 5. Directional intents

P2P relationships, group invitations, and group join requests share one
directional state:

```ts
type IntentStatus = 'REQUESTED' | 'ACCEPTED' | 'REVOKED';

interface IntentBody {
  status: IntentStatus;
  note: string;
  requestedAt: EpochMilliseconds | null;
  expiresAt: EpochMilliseconds | null;
}

type P2PIntentBody = IntentBody;
```

- `REQUESTED` means this direction currently requests or agrees to establish
  the relationship. `requestedAt` MUST be non-null.
- `ACCEPTED` means this direction has observed and confirmed successful
  completion of both sides' flow. `expiresAt` MUST be `null`.
- `REVOKED` means this direction rejects, withdraws, or terminates the
  relationship. `expiresAt` MUST be `null`.
- `note` describes only this direction, grants no permission, and contains at
  most 255 Unicode code points.
- Expiry invalidates only `REQUESTED` and does not implicitly increase its
  revision. An expired request may be omitted from the current projection
  without a `REVOKED` event. A consumer MUST stop treating it as effective at
  its absolute expiry time whether or not the key appears again.

For every intent type, `REQUESTED` MUST have a non-null `expiresAt` satisfying
`requestedAt < expiresAt <= requestedAt + 7 days`. v1 does not permit a
permanently pending friend request, group invitation, or group join request.

`REVOKED` has no semantic expiry. It is a best-effort notification of refusal,
withdrawal, or termination. The publisher SHOULD retain its current projection
as long as practical but MAY later omit the key without a removal event. A
consumer MUST NOT interpret omission as restoration. Current authorization
checks and immediate message-query refusal provide eventual convergence after
cleanup.

### 5.1 P2P

A P2P relationship exists only when the latest direction from each party is
`ACCEPTED`. On receiving a valid peer `REQUESTED`, an implementation with an
effective local direction may advance its direction to `ACCEPTED` and return
it. Crossing requests converge idempotently through stable-key revisions. As
soon as either party publishes `REVOKED`, the relationship becomes invalid and
future P2P message allocation to that closed audience stops. The other
direction is not rewritten as if authored by the revoking party.

`P2P_INTENT` is a closed body. It MUST NOT contain `messageFeedEndId`,
`tombstoneFeedEndId`, a data-feed cursor, or a historical authorization
boundary. Feed ends are global index scan bounds, not thread-closure bounds.
After receiving `REVOKED`, a consumer MUST invalidate current message and
tombstone query targets for that peer/thread and stop retrying them. The source
MAY independently remove the thread's current projections from the two index
feeds. If a query returns `FORBIDDEN` before state convergence, the consumer
MUST perform the same invalidation and prioritize another state-feed drain.

After a relationship closes or is restored, the source determines the
currently readable message and tombstone ranges from durable facts and local
policy. A per-peer feed ID MUST NOT be interpreted as thread-message
authorization, and restoration MUST NOT decrease a committed thread-local
query cursor.

### 5.2 Group invitations and join requests

A group invitation MUST be initiated through an established P2P relationship
between the inviter and invitee; it MUST NOT bypass friendship admission. The
state projection visible to the invitee MUST contain the inviter profile and
the group profile needed to present the invitation. Any referenced group
roster MUST also satisfy the member-before-group ordering in Section 6. A
consumer MUST NOT rely on a later user lookup to complete invitation state.

`GROUP_INVITE_INTENT` additionally carries the current owner needed to create a
lazy mirror:

```ts
interface GroupInviteIntentBody extends IntentBody {
  owner: Address;
}
```

`owner` MUST be a `UserAccount` hosted by the origin domain.
`GROUP_JOIN_INTENT` has exactly the closed `IntentBody`; it MUST NOT contain an
owner, historical message boundary, or feed cursor.

After an effective invite `REQUESTED` and join `REQUESTED` converge, the origin
MAY apply local admission policy. On admission, the origin publishes a greater
revision of the invite as `ACCEPTED` and an authoritative `GROUP_META`. After
the member server observes that member in the authoritative roster, it
publishes a greater revision of the join as `ACCEPTED`. Either direction's
`REVOKED` prevents new admission or requests removal of an existing member,
but `GROUP_META` remains the final membership authority. An intent alone grants
no message, media, or group-resource permission.

## 6. `GROUP_META`

```ts
type GroupRole = 'OWNER' | 'ADMIN' | 'MEMBER';

interface GroupMetaBody {
  active: boolean;
  dissolved: boolean;
  owner: Address | null;
  membersCanInvite: boolean;
  members: Array<Address & { role: GroupRole }>;
}
```

`revision` is the roster revision allocated by the origin. `members` is a
complete replacement, not a patch. It MUST be sorted by domain in ascending
ASCII order and then account in ascending ASCII order, with unique addresses.
Ordering provides deterministic encoding and duplicate detection only; array
position has no business meaning.

An undissolved group MUST contain exactly one `OWNER`, equal to the non-null
`owner`, and that owner MUST be hosted by the origin domain. When
`dissolved: true`, `active` MUST be false, `owner` MUST be null, and `members`
MUST be empty.

`active` is the server-level audience projection for the target peer. It is
true if and only if the undissolved roster contains at least one member hosted
by that peer. Federation v1 provides no transport-level or cryptographic
history isolation among local members on the same peer. A consumer may apply a
stricter local display policy but MUST NOT interpret it as origin-verifiable
per-member access control.

The publisher MUST make the authoritative `GROUP_META` update and the
corresponding opening or closing of that peer's group-message audience visible
atomically. Message-feed allocation that depends on a new audience may occur
only afterward. A consumer MUST commit state-feed effects before processing
subsequently fetched data-feed items.

For each member newly referenced by `GROUP_META.members`, the publisher MUST
ensure that the target peer's current state projection contains the matching
`MEMBER_PROFILE` with a lower `feedId` before allocating the `GROUP_META`
`feedId`. If a later member-profile update receives a `feedId` above a
`GROUP_META` that still references it, the publisher MUST re-index the related
`GROUP_META` so the compact current projection preserves member-before-group
order. This dependency repair MAY allocate a new `feedId` while retaining an
identical body and business revision; consumers treat it as an idempotent
no-op while still advancing the feed cursor. A consistent page snapshot MUST
NOT contain a group snapshot whose referenced member projection cannot be
resolved.

`active: false` revokes future allocation and makes current message-query
access return `FORBIDDEN`, but does not erase historical allocation proofs or
reset query coordinates. If the audience later becomes effective again, it
restores access only to those historical proofs and to new allocations made
after restoration; messages created during the inactive interval are not
backfilled. The publisher MUST retain enough facts to reproduce this result
across restart, replay, audience closure, and restoration.

## 7. Application, recovery, and safety

The consumer MUST validate page structure, identity, bindings, and each stable
key revision in wire `feedId` order. After the entire page validates, it first
applies `PROFILE` and `MEMBER_PROFILE`, then the `GROUP_META` and intent items
that reference them. An equal or lower business revision does not replace a
newer snapshot. A dependency-repair item with an identical revision and body
is a no-op, but its feed cursor still advances.

`MEMBER_PROFILE` visibility is determined by the publisher's current source
set. Consumers perform reference-closure cleanup only after a complete bounded
drain and do not interpret projection omission as a deletion event. A malformed
item, signer-binding error, or cross-signer merge MUST fail the entire page.
Source-scoped member metadata MUST remain keyed by
`(source signer domain, member Address)` wherever it is exposed locally; it
MUST NOT be merged solely by a local identifier or member address. Stable
author addresses in historical messages MUST be retained.

A feed-head hint contains no core business body, and optional `extensions`
cannot replace the state feed or alter the three drain targets. Restart, lost
hints, repeated pages, reordered hints, compacted intermediate revisions, and
page boundaries MUST all converge to the same final projection through the
latest snapshot for each stable key.
