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

| Field     | Type                               | Requirement                                                                                                                               |
| --------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `after`   | `DecimalString` query string       | Optional exclusive consumer scan position. When omitted, both resume boundaries are returned, not a page.                                |
| `take`    | `PositiveSafeInteger` query string | Optional requested maximum number of items. The publisher MAY return fewer but MUST NOT return more.                                      |
| `through` | `DecimalString` query string       | Optional inclusive upper bound for this scan. It MUST be greater than or equal to `after` and remain unchanged across bounded pagination. |

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
the current exclusive boundaries `resumeAfter` and `resumeBefore`, where
`resumeBefore=stateFeedEndId+1`. The consumer atomically stores the window and
starts normal reads with `after=resumeAfter`; it MUST NOT guess an initial ID.
The publisher defines the lower starting point.
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

The consumer validates the page envelope and every item. After
`hasMore: true`, the next page MUST use this page's `scannedThrough`; a bounded
drain MUST also reuse the original `through`.

### 2.1 Compact projection without source acknowledgements

The publisher does not maintain `acknowledgedThrough`, `lastServedThrough`, or
another consumer cursor. Every `after` in `[0, stateFeedEndId]` is readable,
including repeated or older positions. The publisher MUST NOT treat `after` as
an acknowledgement or remove the current projection because it was read.

The publisher MUST durably retain the latest snapshot for every current stable
key. When its business content changes, the publisher MUST
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
  | 'RELATIONSHIP_INTENT'
  | 'GROUP_META';

interface StateFeedItemBase {
  account: Account;
  domain: Domain;
  eventType: StateEventType;
  feedId: PositiveDecimalString;
  body: StateBody;
}

interface RelationshipIntentItem extends StateFeedItemBase {
  eventType: 'RELATIONSHIP_INTENT';
  localAccount: Account;
}
```

Every item and body is a closed object. The stable key is:

```text
(domain, account, eventType)
(domain, account, RELATIONSHIP_INTENT, localAccount)
```

`feedId` is both the scan position and the ordering coordinate for the snapshot.
Consumers apply items in increasing `feedId` order and atomically commit the
page effects with its cursor. Repeated reads are idempotent because items at or
below the committed cursor are not applied again. Except for relationship
confirmation or reconfirmation, an unchanged body does not receive a new
`feedId`. Disclosure dependencies follow the revision reuse and repair rules in
Section 5.2.

Only `RELATIONSHIP_INTENT` carries `localAccount`, which is hosted by the
receiving authority. Every other event MUST omit `localAccount`.

| Event                 | `account/domain`         | `localAccount` | Signer requirement                                                                                                                                |
| --------------------- | ------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROFILE`             | Profile subject          | Omitted        | `domain` MUST equal the signer domain.                                                                                                            |
| `MEMBER_PROFILE`      | Member profile subject   | Omitted        | The signer publishes this source-scoped snapshot; the subject may belong to another domain.                                                       |
| `RELATIONSHIP_INTENT` | Remote relationship end  | Local end      | `domain` MUST equal the signer; `localAccount` is hosted by the consumer. Endpoints MUST be user/user or user/group; group/group is invalid.      |
| `GROUP_META`          | Origin-owned group       | Omitted        | Group domain MUST equal the pinned signer/origin.                                                                                                 |

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
to a peer with an effective relationship. The subject may be a `UserAccount`
in a friendship or an origin-owned `GroupAccount` in a group relationship.

```ts
interface ProfileBody {
  profileRev: SafeInteger;
  displayName: string;
  bio: string;
  avatar: ProfileAvatar | null;
}
```

A publisher MUST allocate `PROFILE` only after both directions are authorizing
and its locally authored direction is `ACCEPTED`. A lone request does not grant
state-feed profile visibility. Explicit acceptance, crossed requests, and a
valid peer `ACCEPTED` that confirms the local `REQUESTED` all cause the local
direction to publish `ACCEPTED`; `PROFILE.feedId` MUST be greater than that
locally published item.

Exact user lookup is a separate disclosure context. `GET /users/:account`
returns only the minimum public identity card defined by the resource
specification and MUST NOT be expanded merely because `PROFILE` contains `bio`
state. A consumer MUST NOT treat a proxied lookup result as a
relationship or state projection. A local initiation or acceptance creates the
placeholder account and thread; a later home-authored `PROFILE` supplies display
state but grants no additional authority.

### 4.2 `MEMBER_PROFILE`

`MEMBER_PROFILE` is display metadata that a target peer needs for an explicit
source such as a shared group. It does not assert membership in any particular
group; only `GROUP_META.members` defines the roster.

```ts
interface MemberProfileBody {
  profileRev: SafeInteger;
  displayName: string;
  avatar: ProfileAvatar | null;
}
```

For each `(target peer, member Address)`, the publisher MUST maintain the
complete current set of visibility sources:

- When the first source appears, it publishes a complete `MEMBER_PROFILE`.
- While at least one source remains, adding or removing another source does not
  remove the snapshot.
- A profile update is published only to peers that still have a source.
- When the last source disappears, the publisher removes the stable key from
  the current projection without allocating a removal item or retaining a
  visibility tombstone.

The source set is authoritative; a source count is only derived data. A
consumer MUST scope snapshots by `(signer domain, member Address)`. Snapshots
of the same member from different signers may diverge and MUST NOT be merged by
member address across signers.

Projection omission is not a deletion event. A consumer may remove an
unreferenced source-scoped snapshot only after atomically completing a bounded
state-feed drain to a fixed target. That target is either a feed-head hint or
the `stateFeedEndId` returned by the first successful page in a drain that did
not specify `through`; that first page is part of the same drain, and every
later page MUST use `through=target`. Cleanup is permitted only after committing
all page effects and the final cursor with
`hasMore: false && scannedThrough === target`.

The consumer then evaluates snapshots against the latest committed account
relationships and complete replacement group rosters from that signer. A
member snapshot may be removed only when the member is neither a friend of a
local user nor shares any group with a local user. Cleanup MUST NOT occur
between pages, after a failed page, or before reaching the target. Removing
display metadata MUST NOT remove messages or their stable author addresses.
State re-indexed beyond the fixed target is reconciled by a later hint or
periodic drain.

## 5. Directed account relationships

User friendships and user/group membership use the same directed state:

```ts
type IntentStatus = 'REQUESTED' | 'ACCEPTED' | 'REVOKED';

interface IntentBody {
  status: IntentStatus;
  note: string;
  requestedAt: EpochMilliseconds | null;
  expiresAt: EpochMilliseconds | null;
}

type RelationshipIntentBody = IntentBody;
```

- `REQUESTED` means this direction authorizes the relationship and asks the
  other account to authorize its direction. The publisher MUST create its local
  thread and local authorization state before publishing it. `requestedAt` and
  `expiresAt` MUST be non-null.
- `ACCEPTED` means this direction authorizes the relationship in response to a
  current reverse `REQUESTED`. The accepting side MUST create or activate its
  local thread atomically with this state. `expiresAt` MUST be `null`.
- `REVOKED` means this direction rejects, withdraws, or terminates the
  relationship. `expiresAt` MUST be `null`.
- `note` describes only this direction, grants no permission, and contains at
  most 255 Unicode code points.
- These statuses are current state for the ordered account pair, not events
  bound to a request instance. `requestedAt` and `expiresAt` determine whether a
  `REQUESTED` snapshot is currently effective; they are not a generation ID or
  causal correlation token.
- Expiry invalidates only `REQUESTED` and does not itself allocate a new
  `feedId`. An expired request may be omitted from the current projection
  without a `REVOKED` event. A consumer MUST stop treating it as effective at
  its absolute expiry time whether or not the key appears again.

`REQUESTED` MUST have a non-null `expiresAt` satisfying
`requestedAt < expiresAt <= requestedAt + 7 days`. v1 does not permit a
permanently pending relationship request.

`REVOKED` has no semantic expiry. It is a best-effort notification of refusal,
withdrawal, or termination. The publisher SHOULD retain its current projection
as long as practical but MAY later omit the key without a removal event. A
consumer MUST NOT interpret omission as restoration. Current authorization
checks and immediate message-query refusal provide eventual convergence after
cleanup.

### 5.1 Reverse-direction matching and confirmation

A consumer applies an incoming intent by looking up the latest locally authored
intent whose actor and subject are reversed. It MUST use those two durable
directions as the complete relationship state; protocol behavior does not
depend on which UI operation originally produced them.

Relationship decisions use current committed snapshots, not causal
acknowledgements. At the moment of a local operation, the implementation MUST
treat the latest committed item for the reverse stable key as the peer's current
state and evaluate the operation against that item. It MUST NOT attempt to infer
whether the peer observed an intermediate local state from feed ends, unrelated
feed IDs, timing, or delivery attempts. A later item for the reverse key is a new
current snapshot and is matched again through the same transition table. The
protocol carries no relationship ACK, causal token, or peer-awareness watermark.

The reverse matcher uses the following transition table. Crossed effective
requests and a valid peer `ACCEPTED` confirming a local effective `REQUESTED`
upgrade the local direction and publish `ACCEPTED`. A new effective peer
`REQUESTED` also re-indexes an already local `ACCEPTED` without changing its
business state. Other incoming states do not rewrite locally authored state.
`Peer may query
local` is controlled only by the consumer's authored direction. `Local may
query peer` is controlled only by the incoming peer direction. The two query
permissions are independent.

| Local before | Incoming remote | Local after | Peer may query local | Local may query peer | Required local action |
| ------------ | --------------- | ----------- | -------------------- | -------------------- | --------------------- |
| absent       | `REQUESTED`     | absent      | no                   | yes                  | Store the incoming request; local queries may return the peer's empty thread, but do not create a local thread or publish a response. |
| absent       | `ACCEPTED`      | absent      | no                   | no                   | Ignore the unmatched acceptance for admission; do not materialize a thread. |
| absent       | `REVOKED`       | absent      | no                   | no                   | Store or discard the remote negative fact according to local policy. |
| `REQUESTED`  | `REQUESTED`     | `ACCEPTED`  | yes                  | yes                  | Atomically upgrade the local direction and publish `ACCEPTED`. |
| `REQUESTED`  | `ACCEPTED`      | `ACCEPTED`  | yes                  | yes                  | Atomically upgrade the local direction and publish `ACCEPTED`; query permission and coordinates remain unchanged. |
| `REQUESTED`  | `REVOKED`       | `REQUESTED` | yes                  | no                   | Keep serving the locally authorized direction and publish no response. |
| `ACCEPTED`   | `REQUESTED`     | `ACCEPTED`  | yes                  | yes                  | Keep the business state unchanged, but re-index and publish the local `ACCEPTED` for this new effective request flow. |
| `ACCEPTED`   | `ACCEPTED`      | `ACCEPTED`  | yes                  | yes                  | Retain both query directions without publishing a response. |
| `ACCEPTED`   | `REVOKED`       | `ACCEPTED`  | yes                  | no                   | Stop querying the peer; continue serving the locally authorized direction. |
| `REVOKED`    | `REQUESTED`     | `REVOKED`   | no                   | yes                  | The local side may query the peer, but the peer may not query local data; keep the request available for explicit acceptance. |
| `REVOKED`    | `ACCEPTED`      | `REVOKED`   | no                   | no                   | Ignore the unmatched acceptance and do not restore authorization automatically. |
| `REVOKED`    | `REVOKED`       | `REVOKED`   | no                   | no                   | Keep both query directions disabled. |

Local actions use the same authored direction but are not incoming-match rows:

| Local action | Proposed local state | Evaluation |
| ------------ | -------------------- | ---------- |
| Initiate     | `REQUESTED`          | Create the local thread and authorization, then publish `REQUESTED`; the peer may query it immediately, including receiving an empty page before any message exists. |
| Accept       | `ACCEPTED`           | Valid only with a current, unexpired remote `REQUESTED`; create the local thread and authorization, publish `ACCEPTED`, and enable both query directions immediately. |
| Reject, withdraw, or terminate | `REVOKED` | Publish `REVOKED` and make the relationship inactive. |

Accepting a remote request from local `absent` or `REVOKED` therefore creates a
new local `ACCEPTED`; it does not mutate the stored remote `REQUESTED` and does
not require a second confirmation.

A local initiate, accept, revoke, or terminate operation MUST atomically store
its authored direction and allocate the target peer's next state-feed ID
(`stateFeedEndId + 1`) under Section 2.1. After commit it MUST advertise the new
end through `feed-heads` under Core Protocol Section 9.2. Applying an incoming
item MUST NOT publish a relationship intent or allocate another intent feed ID
except for either `REQUESTED` confirmation row or the `ACCEPTED + REQUESTED`
reconfirmation row above. Each upgrade or reconfirmation allocates a new local
`ACCEPTED` and advertises the new feed end. Receiving `ACCEPTED` while the local
direction is already `ACCEPTED`, absent, or `REVOKED` produces no relationship
item. Dependent state newly authorized or reopened by the transition follows
its own publication rules.

Query authorization is directional. A source MUST allow the target peer to
query the relationship while the source's authored direction is an unexpired
`REQUESTED` or a valid `ACCEPTED`; it MUST return `FORBIDDEN` when that direction
is absent, expired, or `REVOKED`. The reverse direction is used only to validate
that an `ACCEPTED` belongs to a current request flow; it is not otherwise a
requirement for serving the source's authored grant. A newly requested empty
thread therefore returns a successful empty page rather than `FORBIDDEN`. The
two latest directions determine the two independent query permissions. A
feed-head hint or uncommitted page effect MUST NOT enable either permission.
For the same federation-thread stable key, `REQUESTED` and `ACCEPTED` grant
identical message and tombstone query permission. Reverse confirmation MUST NOT
expand or reset that permission or its sequence-coordinate space solely because
of confirmation.

Without either matching state, the consumer MUST ignore the peer `ACCEPTED` for
admission. It MUST NOT create an incoming request, materialize a persistent
remote account, create or activate a thread, change the local direction, or
grant message or resource access. An existing foreign account row MUST NOT
bypass this gate. After validating the item, the consumer may still commit the
page and advance its feed cursor.

An explicit accept of the current reverse `REQUESTED` always publishes a new
local `ACCEPTED`. Crossing `REQUESTED` items cause each consumer to upgrade its
own direction to `ACCEPTED`. A valid peer `ACCEPTED` likewise confirms and
upgrades a local `REQUESTED`. These upgrades open profile disclosure without an
additional user decision and terminate after both directions are `ACCEPTED`.

When a new effective peer `REQUESTED` arrives while the local direction is
already `ACCEPTED`, the publisher MUST allocate a new `feedId` for its unchanged
`ACCEPTED`. This reconfirmation binds the retained local acceptance to the new
request flow and lets a requester recover after an earlier confirmation was
delayed past request expiry or otherwise passed without admission. It is not a
response loop: an incoming `ACCEPTED` against an already local `ACCEPTED` does
not publish another item.

As soon as a party publishes `REVOKED`, its authored grant becomes ineffective:
the target peer MUST stop querying that publisher and the publisher stops future
allocation to that peer. The reverse authored grant remains independently
effective until it expires or is revoked. An incoming item updates only the
remote direction.

`RELATIONSHIP_INTENT` is a closed body. It MUST NOT contain `owner`, `sinceSeq`,
`messageFeedEndId`, `tombstoneFeedEndId`, a data-feed cursor, or a historical
authorization boundary. Feed ends are global index scan bounds, not
thread-closure bounds. After receiving `REVOKED`, a consumer MUST invalidate
message and tombstone query targets against that publisher and stop retrying
them. Its own independently authored grant remains unchanged. The source MAY
independently remove the thread's current
projections from the two index feeds. If a query returns `FORBIDDEN` before
state convergence, the consumer MUST perform the same invalidation and
prioritize another state-feed drain.

After a relationship closes or is restored, the source determines the currently
readable message and tombstone ranges from durable facts and local policy. A
per-peer feed ID MUST NOT be interpreted as thread-message authorization, and
restoration MUST NOT decrease a committed thread-local query cursor.

### 5.2 Post-acceptance dependency closure

After every newly published `ACCEPTED`, including a reconfirmation that leaves
the business relationship unchanged, the publisher MUST ensure that its current
effective projection contains the complete disclosure dependency closure for
that relationship. The closure consists of the required `PROFILE`, applicable
`GROUP_META`, and every `MEMBER_PROFILE` referenced by that group snapshot.
Every retained snapshot MUST carry the publisher's current `profileRev` or
`rosterRev`.

When an effective snapshot already has the current business revision, the
publisher SHOULD reuse it without allocating another `feedId`. When a required
snapshot is absent or has an older business revision, the publisher MUST publish
the current complete snapshot at a new `feedId`. Newly allocated dependencies
MUST follow the `ACCEPTED` in this order: `PROFILE`, applicable `GROUP_META`, then
newly allocated `MEMBER_PROFILE` snapshots. Snapshot content MUST NOT change
without advancing its business revision.

This is a closure check after every acceptance, not an instruction to republish
the whole closure after every acceptance. A publisher MUST finish repairing any
missing or stale required dependency before it treats the acceptance publication
as complete.

### 5.3 Projection removal and retention

The publisher MUST remove a `PROFILE`, `GROUP_META`, or `MEMBER_PROFILE` stable
key from the effective projection after its last relationship, group, or member
visibility source disappears. Removing a key is projection compaction, not a
removal event, and MUST NOT erase retained messages or stable author addresses.
If another visibility source still requires the same key, the publisher MUST
retain it.

An expired `REQUESTED` stable key MAY be removed without publishing `REVOKED`.
A current `REVOKED` stable key MAY also be removed as historical cleanup because
live authorization is derived independently and still MUST reject access. These
permissions do not weaken the mandatory cleanup of no-longer-needed profile,
group-meta, and member-profile disclosure.

### 5.4 Account types and materialization

The account grammar determines the relationship kind. `UserAccount` to
`UserAccount` is a friendship direction. `GroupAccount` to `UserAccount` is the
group-authored direction, including an invitation or origin confirmation.
`UserAccount` to `GroupAccount` is the member-authored direction, including a
join request or acceptance of an invitation. A relationship between two group
accounts is invalid.

A group invitation MUST be initiated by an authorized local user under origin
policy; it MUST NOT bypass friendship or group policy. The initiating side
creates its local placeholder group/account and thread before publishing
`REQUESTED`. A receiving side stores the request by stable addresses and creates
its placeholder and thread only when it accepts or independently initiates the
reverse direction. Missing display fields use address-derived placeholders and
are updated when the later `PROFILE` arrives.

Before publishing `ACCEPTED`, the accepting side MUST complete its admission
checks and ensure that it can honor the acceptance, including capacity and
policy requirements. It MUST atomically create or activate its local
relationship, roster, audience, and thread as applicable. No second
confirmation is required.

## 6. `GROUP_META`

```ts
type GroupRole = 'OWNER' | 'ADMIN' | 'MEMBER';

interface GroupMetaBody {
  rosterRev: SafeInteger;
  active: boolean;
  dissolved: boolean;
  owner: Address | null;
  membersCanInvite: boolean;
  members: Array<Address & { role: GroupRole }>;
}
```

`members` is a complete replacement, not a patch. It MUST be sorted by domain in ascending
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

The publisher MUST make the authoritative `GROUP_META` update, the corresponding
relationship activation, and the opening or closing of that peer's group-message
audience visible atomically. It MUST NOT publish group profile or roster state
until its locally authored direction is `ACCEPTED`. The local `ACCEPTED` that
opens disclosure MUST have a lower `feedId` than `PROFILE`; the publisher then
allocates `PROFILE` and `GROUP_META`. Message-feed allocation that depends on a
new audience may occur only afterward. A consumer MUST commit state-feed effects
before processing subsequently fetched data-feed items.

After every `GROUP_META` publication, the publisher MUST ensure that complete
`MEMBER_PROFILE` snapshots for all members visible to the target peer exist in
the effective projection. A member snapshot already carrying the current
`profileRev` SHOULD be reused. A missing or older member snapshot MUST be
published after that `GROUP_META` at a greater `feedId`. The publisher MUST NOT
publish a newly disclosed member snapshot before the corresponding group
snapshot or before the relationship becomes effective.

A consumer MAY reject, ignore, quarantine, or defer a `PROFILE`, `GROUP_META`,
or `MEMBER_PROFILE` whose required preceding relationship or state closure is
absent or inconsistent. Regardless of local handling, such an item MUST NOT
grant relationship, membership, message, or resource authorization.

`active: false` revokes future allocation and makes current message-query
access return `FORBIDDEN`, but does not erase historical allocation proofs or
reset query coordinates. If the audience later becomes effective again, it
restores access only to those historical proofs and to new allocations made
after restoration; messages created during the inactive interval are not
backfilled. The publisher MUST retain enough facts to reproduce this result
across restart, replay, audience closure, and restoration.

## 7. Application, recovery, and safety

The consumer MUST validate page structure, identity, bindings, and each stable
key in increasing `feedId` order. A valid dependency chain consequently applies
the disclosure-opening `ACCEPTED` before `PROFILE`, `PROFILE` before
`GROUP_META`, and `GROUP_META` before the `MEMBER_PROFILE` items it authorizes.
A re-indexed item with an identical body is a business no-op, but its feed cursor
still advances.

`MEMBER_PROFILE` visibility is determined by the publisher's current source
set. Consumers perform reference-closure cleanup only after a complete bounded
drain and do not interpret projection omission as a deletion event. A malformed
item, signer-binding error, or cross-signer merge is invalid.
Source-scoped member metadata MUST remain keyed by
`(source signer domain, member Address)` wherever it is exposed locally; it
MUST NOT be merged solely by a local identifier or member address. Stable
author addresses in historical messages MUST be retained.

A feed-head hint contains no business body and cannot replace the state feed
or alter the three drain targets. Restart, lost
hints, repeated pages, reordered hints, compacted intermediate revisions, and
page boundaries MUST all converge to the same final projection through the
latest snapshot for each stable key.
