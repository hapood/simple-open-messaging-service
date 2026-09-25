# Simple Open Messaging Federation Protocol v1 Profiles

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document is entirely normative. It defines the four Federation v1 profile
read operations:

```http
GET /s2s/v1/accounts/:account
GET /s2s/v1/account-profiles/:account/:profileRev
GET /s2s/v1/group-member-profiles/:groupAccount/:memberDomain/:memberAccount/:profileRev
GET /s2s/v1/intent-profiles/:account/:peerAccount/:profileRev
```

All four operations use `recognized signed` authentication, have no request body,
and accept no query parameters. Resource identity is carried by path variables.
Feed cursors, scan windows, modes, and byte ranges use query parameters in their
own operations; profile reads have none.

## 1. Common request rules

Every profile path variable follows the canonical path-variable encoding in
Transport and Security Section 3.1. Path variables are encoded independently.
Only unreserved characters `ALPHA / DIGIT / "-" / "." / "_" / "~"` appear
unencoded; every other UTF-8 byte uses upper-case hexadecimal `%HH`.

A group account's leading `!` is not an unreserved character, so its canonical
path-segment representation is `%21`. For example, the decoded group account
`!team` appears as `%21team`:

```http
GET /s2s/v1/accounts/%21team
GET /s2s/v1/account-profiles/%21team/7
GET /s2s/v1/group-member-profiles/%21team/a.example/alice/7
GET /s2s/v1/intent-profiles/%21team/alice/7
```

A literal `!team` path segment is non-canonical and returns
`400 FEDERATION_MALFORMED`. The receiver performs exactly one UTF-8
percent-decoding pass before grammar validation and MUST NOT decode twice, fold
case, or re-encode before signature verification.

`profileRev` path variables use canonical positive decimal text with a value no
greater than `SafeInteger`. The value `0` is the no-profile sentinel and MUST NOT
be requested. Unknown query parameters, duplicate parameters, malformed path
variables, non-canonical path encoding, or an invalid revision return
`400 FEDERATION_MALFORMED`.

## 2. Response shapes

### 2.1 Public current profile

`GET /s2s/v1/accounts/:account` returns the current public profile for an exact
local account. Its success `data` is a closed object with exactly these fields:

```ts
interface PublicAccountProfile {
  account: Account;
  domain: Domain;
  displayName: string;
  bio: string;
  avatar: InlineProfileAvatar | null;
  profileRev: PositiveSafeInteger;
}
```

`profileRev` is included because the requester did not name a revision and must
learn which immutable snapshot it received.

### 2.2 Exact evidence profiles

The other three operations name `profileRev` in the path. Their success `data` is
a closed object with exactly these fields:

```ts
interface EvidenceProfile {
  account: Account;
  domain: Domain;
  displayName: string;
  bio: string;
  avatar: InlineProfileAvatar | null;
}
```

The requested revision is part of the authorization coordinate. A successful
response asserts that the returned bytes are the exact immutable snapshot named
by the path. The publisher MUST NOT substitute a default, newer, older, or
otherwise retained revision.

For every profile response, `displayName` contains 1-31 Unicode code points
without unpaired surrogates. `bio` contains 0-120 Unicode code points without
unpaired surrogates. `avatar` is either `null` or the shared Base64-bearing
`InlineProfileAvatar`; no URL or independently fetchable avatar reference is
returned.

## 3. Public Account Profile

```http
GET /s2s/v1/accounts/:account
```

`account` MAY be a `UserAccount` or `GroupAccount`. The operation resolves only
an account local to the publisher's own domain; a path, query, or header MUST NOT
select another domain. Any `recognized signed` peer MAY query this public
profile, but the query grants no P2P, group, message, media, or subsequent
profile permission. A dissolved group is unavailable.

An account that is not an existing local user or live group, or whose public
profile is unavailable to the signer, returns HTTP `200 NOT_FOUND` with
`data: null`.

## 4. Account Profile by Current Account Evidence

```http
GET /s2s/v1/account-profiles/:account/:profileRev
```

`account` MAY be a `UserAccount` or a `GroupAccount` owned by the responding
domain.

For a user `Account`, the publisher MUST authorize the request by current
serviceable single-chat message evidence for the authenticated signer domain.
The publisher MUST find at least one currently readable P2P thread whose peer
endpoint is hosted by the signer domain and at least one non-system message in
that thread where:

1. the message author is the requested `account` at the responding domain;
2. the message carries the requested `profileRev`;
3. the message `seq` is greater than the current lower serviceable message
   boundary for that signer and thread; and
4. the message `seq` is less than or equal to the current message read upper
   bound for that signer and thread.

The read upper bound is derived by the publisher from the signer's current
authorization and the published thread read range. The requester does not supply
it. The requested
`profileRev` MUST equal the `profileRev` carried by the qualifying message;
when it matches, the publisher SHOULD return the exact snapshot. Recognition,
knowledge of the account, knowledge of the revision, a stale thread-content head,
or a message outside the current readable interval is not authorization proof.

For a `GroupAccount`, the responding server MUST be the group origin. The origin
MUST verify that the signer currently has an authorized Group Meta audience for
that group. The group Profile evidence is the current Group Meta group-profile
reference, not a group message. Its `profileRev` MUST equal the requested
`profileRev`; when it matches, the origin SHOULD return the exact snapshot. A
mirror MUST NOT serve this operation for a remote group and MUST NOT redirect
another peer to a mirror.

## 5. Group Member Profile

```http
GET /s2s/v1/group-member-profiles/:groupAccount/:memberDomain/:memberAccount/:profileRev
```

Path variables are:

| Variable        | Requirement                                     |
| --------------- | ----------------------------------------------- |
| `groupAccount`  | `GroupAccount` owned by the responding origin   |
| `memberDomain`  | Canonical `Domain` of the member account        |
| `memberAccount` | `UserAccount` of the member                     |
| `profileRev`    | Positive canonical decimal profile revision     |

The group origin serves the complete member profile snapshot currently selected
by its canonical Group Meta state. The operation is separate from Account
Profile because the group origin may retain and disclose a member snapshot whose
account is hosted by another domain. Member Profile evidence is the current
Group Meta member-profile reference, not a group message.

For every request the group origin MUST:

1. resolve the origin-owned live group exactly;
2. verify that the signer currently has an authorized Group Meta audience for
   that group;
3. resolve the current Group Meta member-profile reference for the requested
   `(memberDomain, memberAccount)`;
4. verify that its `profileRev` equals the requested `profileRev`; and
5. SHOULD return the exact immutable snapshot for that revision.

Recognition, knowledge of the member address, knowledge of the revision, a stale
Group Meta item, or an earlier successful response is not authorization. A
mirror MUST NOT serve this endpoint for a remote group and MUST NOT redirect
another peer to the member's home server.

## 6. Intent Profile

```http
GET /s2s/v1/intent-profiles/:account/:peerAccount/:profileRev
```

Path variables are:

| Variable      | Requirement                                 |
| ------------- | ------------------------------------------- |
| `account`     | `Account` owned by the responding domain    |
| `peerAccount` | `Account` owned by the authenticated signer |
| `profileRev`  | Positive canonical decimal profile revision |

The URL identifies the intent by its two endpoint accounts. The responding
server's domain supplies `account`'s domain, and the authenticated signer domain
supplies `peerAccount`'s domain. No additional intent identifier appears on the
wire.

For every request the publisher MUST:

1. resolve the directed Relationship Intent whose author endpoint is
   `(account, responding domain)` and whose other endpoint is
   `(peerAccount, signer domain)`;
2. verify that the intent is currently effective as `REQUESTED` or `ACCEPTED`;
3. verify that the intent's `profileRev` equals the requested `profileRev`; and
4. SHOULD return the exact immutable snapshot for that revision.

Recognition, knowledge of either account, knowledge of the revision, a reciprocal
intent, an expired `REQUESTED` intent, a `REVOKED` intent, or an earlier
successful response is not authorization. No intent authorizes a different
account, opposite direction, peer account, peer domain, or revision.

## 7. Business no-data result

For exact evidence profile operations, if the account, group, member, directed
intent, authorization, requested revision, retained snapshot, readable message
evidence, or the current Group Meta profile reference is unavailable or
mismatched, the
publisher returns HTTP `200 NOT_FOUND` with `data: null`. The publisher MUST NOT
reveal which condition caused the no-data result, MUST NOT return generic
`FORBIDDEN`, and MUST NOT mutate relationship, membership, Group Meta, peer
lifecycle, or cursor state.

## 8. Retention and degradation

The publisher SHOULD retain historical profile revisions referenced by
serviceable messages, current Relationship Intents, or current Group Meta
profile references so those objects remain visually complete during storage
degradation. If a referenced revision is nevertheless unavailable, the publisher
MUST NOT substitute another revision. The profile read returns `NOT_FOUND`; the
message, thread, stable address, role, intent, and other retained content remain
valid.
