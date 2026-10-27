# Simple Open Messaging Federation Protocol v1 Profiles

Status: `DRAFT` — Final Review (`v1.0.0-draft.2`)

This document is entirely normative. It defines the three Federation v1 profile
read operations:

```http
GET /s2s/v1/accounts/:account
GET /s2s/v1/account-profiles/:namespaceId/:account/:profileRev
GET /s2s/v1/group-member-profiles/:groupAccount/:namespaceId/:memberAccount/:profileRev
```

All three operations use `recognized signed` authentication and have no
request body. Resource identity is carried by path variables. The two exact
profile-validation operations accept no query parameters; the public
current-profile lookup accepts exactly two required query parameters,
`publicKey` and `challenge` (Section 3).

The public current-profile lookup has no `namespaceId` path variable because it
resolves only the responding server's authoritative current profile for the
local account. The two exact profile-validation operations carry the profile
subject namespace as a required `namespaceId` path variable. That value is
scoped by the responding publisher and identifies the requested profile subject
inside that publisher's namespace space. A `namespaceId` of `0` requests the
responding server's own local subject and is served from its local profile
store; a positive value selects the namespace that publisher holds for a
foreign identity. Responses do not carry `domain`; subject identity comes from
the authenticated publisher, requested account, and profile namespace.

Profile reads do not use feed cursors, scan windows, modes, or byte ranges.
The public current-profile lookup still requires `publicKey` and `challenge`
as specified above.

## 1. Common request rules

Every profile path variable follows the canonical path-variable encoding in
Transport and Security Section 3.1. Path variables are encoded independently.
Only unreserved characters `ALPHA / DIGIT / "-" / "." / "_" / "~"` appear
unencoded; every other UTF-8 byte uses upper-case hexadecimal `%HH`.

A group account's leading `!` is not an unreserved character, so its canonical
path-segment representation is `%21`. The following path-only illustrations
show the decoded group account `!team` as `%21team`; they are not complete
requests. The public lookup additionally requires the `publicKey` and
`challenge` query parameters of Section 3:

```http
GET /s2s/v1/accounts/%21team
GET /s2s/v1/account-profiles/0/%21team/7
GET /s2s/v1/group-member-profiles/%21team/0/alice/7
```

A literal `!team` path segment is non-canonical and returns
`400 FEDERATION_MALFORMED`. The receiver performs exactly one UTF-8
percent-decoding pass before grammar validation and MUST NOT decode twice, fold
case, or re-encode before signature verification.

`namespaceId` path variables use canonical non-negative decimal text with a
value no greater than `SafeInteger`. `profileRev` path variables use canonical positive decimal text
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
  generatedAt: EpochMilliseconds;
  profileRev: SafeNonNegativeInteger;
  profile: {
    displayName: string;
    bio: string;
    avatar: InlineProfileAvatar | null;
  } | null;
  proof: string;
}
```

A `profileRev` of `0` denotes no current public profile snapshot; `profile`
MUST be `null`. A positive `profileRev` identifies an immutable snapshot;
`profile` MUST be a non-null closed object containing exactly `displayName`,
`bio`, and `avatar`. A revision-0 result MUST NOT be used as exact profile
evidence.

The response omits `namespaceId` because the lookup resolves only the responding
server's authoritative local account namespace.

`proof` is the answer to the request's sealed challenge: the responder opens
the `challenge` box with the private counterpart of the supplied `publicKey`
and returns the recovered plaintext bytes as canonical padded base64 using
the answer encoding of Transport and Security, Section 3.7. The lookup therefore doubles as
a possession proof — the card is served by the holder of the named key's
private counterpart, not merely by the current domain endpoint, so a
temporary domain takeover that lost the key material cannot serve a
verifiable card under the old root. The responder treats the plaintext as
opaque bytes and MUST NOT validate, interpret, or reject it by content.

The caller controls the challenge semantics. The protocol does not require
any particular plaintext; a caller MAY bind it to this lookup, for example
by sealing the canonical JSON `{"account":"<account>","domain":"<domain>"}`,
so the answer is specific to exactly this card. The caller MUST be able to
compare the base64-decoded `proof` byte-for-byte with what it sealed, SHOULD seal
a fresh value for each lookup, and SHOULD discard the value after
comparing. The sealed-box construction is defined in
[Transport and Security, Section 3.7](./transport-security.md#37-sealed-challenge-construction);
the stateless possession-proof discipline is defined in
[Peer Recognition, Section 12](./recognition.md#12-sealed-challenge-verification-service).

Possession proof is required even for revision-0 responses.

### 2.2 Exact evidence profiles

The other two operations name both `namespaceId` and `profileRev` in the path.
Their success `data` is a closed object with exactly these fields:

```ts
interface EvidenceProfile {
  account: Account;
  generatedAt: EpochMilliseconds;
  displayName: string;
  bio: string;
  avatar: InlineProfileAvatar | null;
}
```

The two exact profile-validation operations return the profile content,
subject account, and generation time, without a domain. Their request path already supplies `namespaceId` and
`profileRev`; the caller combines those request values with the returned
content to reconstruct the complete profile reference. These coordinates are
not repeated in the response, so a response cannot conflict with its request
parameters. The publisher MUST NOT substitute a default, newer, older, or
otherwise retained namespace or revision.

For every non-null public `profile` and every successful exact evidence profile
response, `displayName` contains 1-31 Unicode
code points without unpaired surrogates. `bio` contains 0-120 Unicode code
points without unpaired surrogates. `avatar` is either `null` or the shared
inline `InlineProfileAvatar` object `{ mimeType, base64, width, height }`; no
URL, digest, or independently fetchable avatar reference is returned.

### 2.3 Generation time

Every successful profile response MUST carry top-level `generatedAt` as
non-negative Unix epoch milliseconds encoded as a safe JSON integer. For a
positive revision, it is the original profile authority's generation time for
that immutable revision. Every publisher disclosing the revision MUST preserve
that time unchanged, including a group origin disclosing a foreign member's
profile. Receiving, retaining, reading, or retransmitting a revision MUST NOT
replace its generation time with a local timestamp. Conflicting content or
generation times for the same exact profile reference MUST NOT overwrite the
accepted revision. A public revision-0 response MUST carry
`generatedAt: 0` because no profile version exists.

`generatedAt` is not response generation, transmission, or receipt time.
Profile identity and revision selection use the account, namespace, and
`profileRev`, not this timestamp. Clock corrections and inter-server clock
skew are permitted: consumers MUST NOT require timestamp monotonicity or
reject an otherwise valid profile because this time is old or in the future.
It is not an authorization boundary or replay-protection credential. Missing,
null, negative, fractional, non-numeric, or unsafe-integer values are malformed.

## 3. Public Account Profile

```http
GET /s2s/v1/accounts/:account
```

`account` MAY be a `UserAccount` or `GroupAccount`. The operation resolves only
an account local to the publisher's own domain; a path, query, or header MUST NOT
select another domain. Any `recognized signed` peer MAY query this operation,
subject to the responder's disclosure policy.

For an existing local user or live group whose public lookup is available to
the signer, the responder returns the current public profile, or the revision-0
null-profile result defined in Section 2.1 if no current profile snapshot exists.
Otherwise, it returns HTTP `200 NOT_FOUND` with `data: null`, including for a
dissolved group. Absence of a profile snapshot alone MUST NOT cause `NOT_FOUND`.

A successful lookup discloses account existence but grants no P2P, group,
message, media, or subsequent profile permission.

The request MUST carry exactly two query parameters, in this order:
`publicKey`, then `challenge`. `publicKey` is a
`Base64Ed25519Key` naming one of the responder's published keys — current or
retired — that the caller wants the card bound to; `challenge` is a
`Base64SealedChallenge` sealed under that key (Transport and Security,
Section 3.7). A public key not present in the responder's retained key
history returns the error envelope with `FEDERATION_PUBLIC_KEY_UNRECOGNIZED`;
a missing, duplicated, malformed, or unknown additional query parameter, or
a challenge that fails to open under the supplied key, returns
`400 FEDERATION_MALFORMED`. Both parameters travel in the URL, so they are
covered by the signed `@query` component and cannot be altered in transit.

## 4. Account Profile by Account Evidence

```http
GET /s2s/v1/account-profiles/:namespaceId/:account/:profileRev
```

`account` MAY be a `UserAccount` or a `GroupAccount` owned by the responding
domain.

For a user `Account`, the publisher MUST authorize the request by at least one
of these proofs for the exact requested `namespaceId` and `profileRev`:

- current serviceable message evidence for an authenticated signer hosting the
  user's relationship counterpart; or
- a current directed Relationship Intent authored by the requested account and
  addressed to the authenticated signer's account, with matching
  `namespaceId` and `profileRev`, whose status is `ACCEPTED` or an
  unexpired `REQUESTED`.

For message evidence, the publisher MUST find at least one non-system message
authored by the requested `account` at the responding domain, carrying the
requested `namespaceId` and `profileRev`, and lying within the signer's current
serviceable message interval in either of these relationships:

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
snapshot. Recognition, membership in another group, knowledge of the account or
revision, a reciprocal intent, an expired `REQUESTED` intent, a `REVOKED`
intent, a stale thread-content head, or a message outside the current readable
interval is not authorization proof.

For a `GroupAccount`, the responding server MUST be the group origin. The origin
MUST verify that the signer currently has an authorized Group Meta audience for
that group, or that a current directed Relationship Intent authored by the
group and addressed to the authenticated signer grants the requested exact
revision. The group Profile evidence is otherwise the current Group Meta
group-profile reference, not a group message. Its `namespaceId` and
`profileRev` MUST equal the requested values; when they match, the origin
SHOULD return the exact snapshot. A mirror MUST NOT serve this operation for a
remote group and MUST NOT redirect another peer to a mirror.

## 5. Group Member Profile

```http
GET /s2s/v1/group-member-profiles/:groupAccount/:namespaceId/:memberAccount/:profileRev
```

Path variables are:

| Variable        | Requirement                                                  |
| --------------- | ------------------------------------------------------------ |
| `groupAccount`  | `GroupAccount` owned by the responding origin                |
| `namespaceId`   | Profile namespace in the responding origin's namespace space |
| `memberAccount` | `UserAccount` of the member                                  |
| `profileRev`    | Positive canonical decimal profile revision                  |

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
   - the current `MEMBER_UPSERT` for `(namespaceId, memberAccount)` carries
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

## 6. Business no-data result

For any exact evidence profile operation, if its required account, group,
member, authorization, exact namespace and revision, or retained snapshot is
unavailable, or none of that operation's applicable current intent, current
Meta reference, or serviceable message proofs matches, the publisher returns
HTTP `200 NOT_FOUND` with `data: null`. The publisher MUST NOT reveal which
condition caused the no-data result, MUST NOT return generic `FORBIDDEN`, and
MUST NOT mutate relationship, membership, Group Meta, peer lifecycle, or cursor
state.

## 7. Retention and degradation

The publisher SHOULD retain historical profile revisions referenced by
serviceable messages, current Relationship Intents, or current Group Meta
profile references so those objects remain visually complete during storage
degradation. If a referenced revision is nevertheless unavailable, the
publisher MUST NOT substitute another revision. The profile read returns
`NOT_FOUND`; the message, thread, stable address, role, intent, and other
retained content remain valid.
