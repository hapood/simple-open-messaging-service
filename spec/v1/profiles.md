# Simple Open Messaging Federation Protocol v1 Profiles

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document is entirely normative. It defines the four Federation v1 profile
read operations:

```http
GET /s2s/v1/accounts/:account
GET /s2s/v1/account-profiles/:namespaceId/:account/:profileRev
GET /s2s/v1/group-member-profiles/:groupAccount/:namespaceId/:memberAccount/:memberDomain/:profileRev
GET /s2s/v1/intent-profiles/:namespaceId/:account/:peerAccount/:profileRev
```

All four operations use `recognized signed` authentication and have no
request body. Resource identity is carried by path variables. The three
exact profile-validation operations accept no query parameters; the public
current-profile lookup accepts exactly two required query parameters,
`publicKey` and `challenge` (Section 3).

The public current-profile lookup has no `namespaceId` path variable because it
resolves only the responding server's authoritative current profile for the
local account. The three exact profile-validation operations carry the profile
subject namespace as a required `namespaceId` path variable. That value is
scoped by the responding publisher and identifies the requested profile subject
inside that publisher's namespace space. A `namespaceId` of `0` requests the
responding server's own local subject and is served from its local profile
store; a positive value selects the namespace that publisher holds for a
foreign identity. When a profile request includes a subject-domain path
variable for the requested subject, `namespaceId: 0` requires that path segment
to be `local`, even if the requester stores the responding server's public
domain for that subject. `memberDomain` path variables and response `domain`
values follow the same local-subject marker rules as every publisher-serialized
address ([Core Protocol Section 6.2.1](./protocol.md#local-subject-marker-and-namespace-interpretation)):
the responding server serializes its own subjects with the literal `local`,
and a requester MUST NOT infer subject locality from a domain string.

Feed cursors, scan windows, modes, and byte ranges use query parameters in
their own operations; profile reads have none.

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
GET /s2s/v1/account-profiles/0/%21team/7
GET /s2s/v1/group-member-profiles/%21team/0/alice/local/7
GET /s2s/v1/intent-profiles/0/%21team/alice/7
```

A literal `!team` path segment is non-canonical and returns
`400 FEDERATION_MALFORMED`. The receiver performs exactly one UTF-8
percent-decoding pass before grammar validation and MUST NOT decode twice, fold
case, or re-encode before signature verification.

`namespaceId` path variables use canonical non-negative decimal text with a
value no greater than `SafeInteger`. A subject-domain path variable is coupled
to that namespace: when `namespaceId` is `0`, it MUST be the literal `local`;
when `namespaceId` is positive, it MUST be a canonical `Domain` and MUST NOT
be `local`. This applies to `memberDomain` in the Group Member Profile
operation. The conversion from a stored target domain to `local` for a zero
namespace is performed by the outbound request builder; it does not change the
stored target. `profileRev` path variables use canonical positive decimal text
with a value no greater than `SafeInteger`. JSON Schema patterns validate the canonical decimal spelling; receivers MUST additionally
parse the value and reject one greater than `SafeInteger`. The revision value
`0` is the no-profile sentinel and MUST NOT be requested. Unknown query
parameters, duplicate parameters, malformed path variables, non-canonical path
encoding, an invalid namespace, or an invalid revision return `400
FEDERATION_MALFORMED`.

## 2. Response shapes

### 2.1 Public current profile

`GET /s2s/v1/accounts/:account` returns the current public profile
for an exact local account on the responding server. Its success `data`
is a closed object with exactly these fields:

```ts
interface PublicAccountProfile {
  account: Account;
  domain: Domain;
  displayName: string;
  bio: string;
  avatar: InlineProfileAvatar | null;
  profileRev: PositiveSafeInteger;
  proof: string;
}
```

The public current-profile response includes `profileRev` because the requester
must learn which current snapshot was selected. It does not include
`namespaceId`; this lookup is only for the responding server's authoritative
local account namespace.

`proof` is the answer to the request's sealed challenge: the responder opens
the `challenge` box with the private counterpart of the supplied `publicKey`
and returns exactly the recovered plaintext. The lookup therefore doubles as
a possession proof — the card is served by the holder of the named key's
private counterpart, not merely by the current domain endpoint, so a
temporary domain takeover that lost the key material cannot serve a
verifiable card under the old root. The responder treats the plaintext as
opaque bytes and MUST NOT validate, interpret, or reject it by content.

The caller controls the challenge semantics. The protocol does not require
any particular plaintext; a caller MAY bind it to this lookup, for example
by sealing the canonical JSON `{"account":"<account>","domain":"<domain>"}`,
so the answer is specific to exactly this card. The caller MUST be able to
compare the returned `proof` byte-for-byte with what it sealed, SHOULD seal
a fresh value for each lookup, and SHOULD discard the value after
comparing. The sealed-box construction is defined in
[Transport and Security, Section 3.7](./transport-security.md#37-sealed-challenge-construction);
the stateless possession-proof discipline is defined in
[Peer Recognition, Section 12](./recognition.md#12-sealed-challenge-verification-and-namespace-identity-service).

### 2.2 Exact evidence profiles

The other three operations name both `namespaceId` and `profileRev` in the path.
Their success `data` is a closed object with exactly these fields:

```ts
interface EvidenceProfile {
  account: Account;
  // 'local' is the publisher-scoped subject marker of Core Protocol 6.2.1.
  domain: Domain | 'local';
  displayName: string;
  bio: string;
  avatar: InlineProfileAvatar | null;
}
```

The three exact profile-validation operations return only the profile content
and subject address. Their request path already supplies `namespaceId` and
`profileRev`; the caller combines those request values with the returned
content to reconstruct the complete profile reference. These coordinates are
not repeated in the response, so a response cannot conflict with its request
parameters. The publisher MUST NOT substitute a default, newer, older, or
otherwise retained namespace or revision.

For every successful profile response, `displayName` contains 1-31 Unicode
code points without unpaired surrogates. `bio` contains 0-120 Unicode code
points without unpaired surrogates. `avatar` is either `null` or the shared
inline `InlineProfileAvatar` object `{ mimeType, base64, width, height }`; no
URL, digest, or independently fetchable avatar reference is returned.

## 3. Public Account Profile

```http
GET /s2s/v1/accounts/:account
```

`account` MAY be a `UserAccount` or `GroupAccount`. The operation resolves only
an account local to the publisher's own domain; a path, query, or header MUST NOT
select another domain. It returns the account's current public profile only
when the profile is currently public. Any `recognized signed` peer MAY query
this public profile, but the query grants no P2P, group, message, media, or
subsequent profile permission. A dissolved group is unavailable.

The request MUST carry exactly two query parameters. `publicKey` is a
`Base64Ed25519Key` naming one of the responder's published keys — current or
retired — that the caller wants the card bound to; `challenge` is a
`Base64SealedChallenge` sealed under that key (Transport and Security,
Section 3.7). A public key not present in the responder's retained key
history returns the error envelope with `FEDERATION_PUBLIC_KEY_UNRECOGNIZED`;
a missing, duplicated, malformed, or unknown additional query parameter, or
a challenge that fails to open under the supplied key, returns
`400 FEDERATION_MALFORMED`. Both parameters travel in the URL, so they are
covered by the signed `@query` component and cannot be altered in transit.

An account that is not an existing local user or live group, or whose current
public profile is unavailable to the signer, returns HTTP `200 NOT_FOUND` with
`data: null`.

## 4. Account Profile by Current Account Evidence

```http
GET /s2s/v1/account-profiles/:namespaceId/:account/:profileRev
```

`account` MAY be a `UserAccount` or a `GroupAccount` owned by the responding
domain.

For a user `Account`, the publisher MUST authorize the request by current
serviceable message evidence for an authenticated signer hosting the user's
relationship counterpart. The publisher MUST find at least one non-system
message authored by the requested `account` at the responding domain, carrying
the requested `namespaceId` and `profileRev`, and lying within the signer's
current serviceable message interval in either of these relationships:

- a currently readable P2P thread whose peer endpoint is hosted by the signer
  domain; or
- a currently confirmed membership of that user in a GROUP thread whose group
  origin is hosted by the signer domain. Only the group origin may use this
  relationship to fetch the member's account profile; another group member's
  server is not the member's relationship counterpart for this operation.

The publisher derives the lower and upper serviceable message boundaries from
the signer's current relationship authorization and the published read range.
The message `seq` MUST be greater than the lower boundary and no greater than
the upper boundary; the requester does not supply either boundary. When the
exact namespace and revision match, the publisher SHOULD return its immutable
snapshot.
Recognition, membership in another group, knowledge of the account or revision,
a stale thread-content head, or a message outside the current readable
interval is not authorization proof.

For a `GroupAccount`, the responding server MUST be the group origin. The origin
MUST verify that the signer currently has an authorized Group Meta audience for
that group. The group Profile evidence is the current Group Meta group-profile
reference, not a group message. Its `namespaceId` and `profileRev` MUST equal
the requested values; when they match, the origin SHOULD return the exact
snapshot. A mirror MUST NOT serve this operation for a remote group and MUST NOT
redirect another peer to a mirror.

## 5. Group Member Profile

```http
GET /s2s/v1/group-member-profiles/:groupAccount/:namespaceId/:memberAccount/:memberDomain/:profileRev
```

Path variables are:

| Variable        | Requirement                                                                            |
| --------------- | -------------------------------------------------------------------------------------- |
| `groupAccount`  | `GroupAccount` owned by the responding origin                                          |
| `namespaceId`   | Profile namespace in the responding origin's namespace space                           |
| `memberAccount` | `UserAccount` of the member                                                            |
| `memberDomain`  | Canonical `Domain` of the member account, or `local` exactly when `namespaceId` is `0` |
| `profileRev`    | Positive canonical decimal profile revision                                            |

The group origin serves complete member profile snapshots for both the
current Group Meta member reference and serviceable group messages. The
operation is separate from Account Profile because the origin may retain and
disclose a member snapshot whose account is hosted by another domain. The
requester supplies the exact namespace and revision but no feed ID or message
sequence.

For every request the group origin MUST:

1. resolve the origin-owned live group exactly;
2. verify that the signer currently has an authorized Group Meta audience for
   that group;
3. verify at least one of these two proofs for the exact requested member and
   revision:
   - the current `MEMBER_UPSERT` for `(memberDomain, memberAccount)` carries
     the requested `namespaceId` and `profileRev`; or
   - a non-system message authored by that member in this group carries the
     requested `namespaceId` and `profileRev` and lies within the signer's
     current serviceable message interval for the group; and
4. SHOULD return the exact immutable snapshot for that revision.

For message evidence the origin derives both readable boundaries from the
signer's current authorization and the published group read range; the
requester does not choose the interval. The origin MUST check both applicable
proofs and MUST NOT substitute a current Meta revision for the requested
message-backed revision. Recognition, knowledge of the member address or
revision, a stale Group Meta item, a message outside the current readable
interval, or an earlier successful response is not authorization. A mirror
MUST NOT serve this endpoint for a remote group and MUST NOT redirect another
peer to the member's home server.

## 6. Intent Profile

```http
GET /s2s/v1/intent-profiles/:namespaceId/:account/:peerAccount/:profileRev
```

Path variables are:

| Variable      | Requirement                                         |
| ------------- | --------------------------------------------------- |
| `namespaceId` | Profile namespace in the responding namespace space |
| `account`     | `Account` owned by the responding domain            |
| `peerAccount` | `Account` owned by the authenticated signer         |
| `profileRev`  | Positive canonical decimal profile revision         |

The URL identifies the intent by its two endpoint accounts. The responding
server's domain supplies `account`'s domain, and the authenticated signer domain
supplies `peerAccount`'s domain. No additional intent identifier appears on the
wire.

For every request the publisher MUST:

1. resolve the directed Relationship Intent whose author endpoint is
   `(account, responding domain)` and whose other endpoint is
   `(peerAccount, signer domain)`;
2. verify that the intent is currently effective as `REQUESTED` or `ACCEPTED`;
3. verify that the intent's profile namespace and `profileRev` equal the
   requested `namespaceId` and `profileRev`; and
4. SHOULD return the exact immutable snapshot for that revision.

Recognition, knowledge of either account, knowledge of the revision, a reciprocal
intent, an expired `REQUESTED` intent, a `REVOKED` intent, or an earlier
successful response is not authorization. No intent authorizes a different
account, opposite direction, peer account, peer domain, or revision.

## 7. Business no-data result

For any exact evidence profile operation, if its required account, group,
member, authorization, exact namespace and revision, or retained snapshot is
unavailable, or none of that operation's applicable intent, current Meta
reference, or
serviceable message proofs matches, the publisher returns HTTP `200 NOT_FOUND`
with `data: null`. The publisher MUST NOT
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
