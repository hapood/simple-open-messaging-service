# Simple Open Messaging Federation Protocol v1 Group Meta Profile

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document is normative. It defines `GET /s2s/v1/group-meta-profile`, the
group-origin profile lookup for either the group itself or one current member.
The request carries Group Meta evidence and does not carry a profile revision.

## 1. Request

The closed query is one of:

```ts
interface GroupProfileQuery {
  account: GroupAccount;
  subject: 'GROUP';
}

interface GroupMemberProfileQuery {
  account: GroupAccount;
  subject: 'MEMBER';
  memberAccount: UserAccount;
  memberDomain: Domain;
}
```

The fixed query order is `account`, `subject`, then, for `MEMBER`,
`memberAccount`, `memberDomain`. Unknown, duplicate, missing, or incorrectly
ordered parameters return `400 FEDERATION_MALFORMED`. A `GROUP` request MUST
NOT carry member fields.

`account` identifies a group owned by the responding origin. The origin derives
the selected revision from its current canonical `GROUP_PROFILE` fact for
`GROUP`, or the current canonical member `UPSERT` for `MEMBER`. The requester
does not state or guess that revision.

## 2. Successful response

The response is the complete shared profile shape:

```ts
interface GroupMetaProfile {
  account: Account;
  domain: Domain;
  profileRev: PositiveSafeInteger;
  displayName: string;
  bio: string;
  avatar: InlineProfileAvatar | null;
}
```

For `GROUP`, `account` is the requested group account. For `MEMBER`, the
response address equals the requested member address. `profileRev` is the
revision selected by canonical Group Meta at request execution time. It is not
required to equal a revision previously observed by the requester.

The response carries no relationship, presence, membership, or role data. A
consumer MUST identify the returned immutable snapshot by
`(account, domain, profileRev)` and MUST NOT treat it as a mutable
latest-profile record.

## 3. Authorization

For every request the group origin MUST:

1. resolve the origin-owned group exactly;
2. verify that the signer currently has an authorized Group Meta audience;
3. resolve the current canonical subject fact;
4. return only the immutable snapshot retained for that fact's revision.

Recognition, knowledge of the address, a previously observed revision, or an
earlier successful response is not authorization. An unauthorized or absent
subject returns `FEDERATION_PROFILE_NOT_DISCLOSED` or the privacy-collapsed
`NOT_FOUND` result. Neither result changes relationship, membership, Group
Meta, audience, or peer lifecycle.

The group origin is the sole federation authority for this operation, including
member accounts hosted by another domain. A mirror MUST NOT serve this endpoint
for a remote group and MUST NOT redirect another mirror to the member's home.

## 4. Consistency

The requester may have an older Group Meta projection than the origin. A
successful response with a different `profileRev` remains valid. A requester
MUST interpret the response according to its returned `profileRev`; it MUST NOT
reinterpret the response as the revision in an older local Group Meta
projection.

This read does not mutate Group Meta. Temporary failure of the operation does
not change membership, role, Group Meta audience, or peer identity.
