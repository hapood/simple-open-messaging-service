# Simple Open Messaging Federation Protocol v1 Group Member Profile

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document is entirely normative. It defines the on-demand operation
`GET /s2s/v1/group-member-profile`. A group mirror uses it to resolve the
immutable complete profile snapshot referenced by an exact current member item
in the group origin's canonical Group Meta Feed. It does not discover a
member's default profile revision.

Profile authority is deliberately asymmetric. The group origin retains and
serves every positive member reference published by its canonical Group Meta
Feed, including references for members whose account home is another domain. A
mirror requests this operation only from the group origin, may cache the exact
response for its local clients, and MUST NOT serve the operation to another
federation peer as if it owned the group. It also MUST NOT redirect another
mirror to the member's account home.

## 1. Request

The closed query is:

```ts
interface GroupMemberProfileQuery {
  account: GroupAccount;
  memberAccount: UserAccount;
  memberDomain: Domain;
  rev: DecimalString;
}
```

`account` MUST identify a group owned by the responding origin. `memberAccount`
and `memberDomain` identify the exact member Address carried by Group Meta.
`rev` is required, canonical, positive, and no greater than `SafeInteger`. The
value `0` is the no-profile sentinel and MUST NOT be requested. The fixed
query-key order is `account`, `memberAccount`, `memberDomain`, then `rev`.
Unknown, duplicate, missing, zero, non-canonical, or incorrectly ordered
parameters return `400 FEDERATION_MALFORMED`.

The requester obtains all four values from a current `UPSERT` in durable Group Meta state. It MUST
NOT guess a revision, substitute a message-carried revision, or request an
unreferenced numerically greater value.

## 2. Successful response

The success `data` is:

```ts
interface GroupMemberProfile {
  account: UserAccount;
  domain: Domain;
  profileRev: PositiveSafeInteger;
  displayName: string;
  bio: string;
  avatar: InlineProfileAvatar | null;
}
```

The response `account/domain` MUST equal the requested member Address and
`profileRev` MUST equal `rev`. `displayName` contains 1–30 Unicode code points
without unpaired surrogates. `bio` contains 0–120 Unicode code points without
unpaired surrogates. `avatar` is `null` or the shared Base64-bearing
`InlineProfileAvatar`. The response carries no relationship, presence,
membership, or role data.

The response object and every field shown above are required; `profileRev` is
never absent or `null`. The value `0` cannot appear in a successful response.

A consumer keys the result by `(group origin domain, group account, member
account, member domain, profileRev)`. It MUST NOT treat the snapshot as the
member's public, default, or numerically newest profile.

## 3. Authorization

For every request the group origin MUST:

1. resolve the origin-owned group exactly;
2. verify that the signer currently has an authorized Group Meta audience for
   that group;
3. verify that the canonical Group Meta member's latest operation is `UPSERT`
   and carries the exact `(member account, member domain, profileRev)`
   reference;
4. return only the immutable snapshot retained or lazily resolved for that
   canonical reference.

Recognition, current membership alone, knowledge of the member Address,
knowledge of a revision, possession of a Group Meta item while unauthorized, or an
earlier successful response is not authorization proof. The operation is
read-only and grants no relationship, membership, message, media, or later
profile permission.

An unauthorized read returns `FEDERATION_PROFILE_NOT_DISCLOSED`; the origin MAY
privacy-collapse it to `NOT_FOUND`. Neither result changes relationship, group,
or peer lifecycle. After authorization succeeds, an origin missing the exact
snapshot MAY resolve that revision from the member's account authority. It MUST
NOT redirect the requester to that authority and MUST NOT substitute the
member's default profile or a snapshot selected by another Group Meta item.
The member-authored `REQUESTED` carrying that revision is the origin's
authorization proof for the upstream exact-account lookup; active membership is
not required to begin this independent warm-up.

## 4. Publication and retention

Publishing a member `UPSERT` never waits for profile retrieval. The positive
reference is the exact revision selected by the member-authored join intent;
membership, audience, Group Meta, and State Feed commits are independent of the
snapshot's current availability. The origin MAY warm the exact snapshot after
commit. On an authorized cache miss, it resolves that same revision from the
member's account authority, retains the result, and serves it as the group
origin. Equal work may be coalesced locally. A zero reference means no profile
and requires no snapshot or profile request. `DEPART` carries no profile
reference and ends Group Member Profile authorization for that member. A later
`UPSERT` after rejoining may select a different revision.

Profile resolution MUST NOT mutate group state. Temporary upstream or storage failure returns
HTTP `503 INTERNAL`; the requester retains its roster and retries with backoff.
Permanent absence or disclosure denial returns the existing privacy-safe
`NOT_FOUND` or `FEDERATION_PROFILE_NOT_DISCLOSED` result. None of these outcomes
changes membership, role, audience, Group Meta, State Feed, or peer identity.

A member profile update by itself MUST NOT allocate a Group Meta item, change a
committed member projection's `profileRev`, advance `groupMetaFeedEndId`, or
cause a State Feed update. A role or membership mutation may publish a new
member item while preserving the preceding exact revision; it need not discover
or select the member's then-default revision.

The origin SHOULD retain a resolved complete profile snapshot while the member's
latest canonical Group Meta operation is the referencing `UPSERT`. If
degradation removes it, the origin lazily resolves the exact revision again or
returns the result defined above; it MUST NOT rewrite the Group Meta reference
or substitute another revision. Message-bound profile retention is independent
and follows Message Author Profile.
