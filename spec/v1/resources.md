# Simple Open Messaging Federation Protocol v1 Resources

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document is entirely normative.

This document defines three Federation v1 read operations: public user profiles,
media resources, and forward bundles. Implementations MUST also follow the
shared types and JSON rules in [Core Protocol Section 6](./protocol.md#6-common-protocol-rules),
the response and error envelopes in [Core Protocol Section 7](./protocol.md#7-responses-errors-and-caller-actions),
the request construction and signature rules in
[Transport and Security Section 3](./transport-security.md#3-request-construction-overview),
and the status/code combinations in the [stable error registry](./errors.md#stable-code-registry).

All three operations use the `recognized signed` authentication context. The
signature covers the complete path and raw query. Before reading a resource or
returning success, the server MUST validate the signature, peer recognition,
and the resource-specific authorization defined here.

## 1. Common request rules

| Property                        | Requirement                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------- |
| Method                          | `GET`                                                                            |
| Request body                    | Exactly zero bytes                                                               |
| `Content-Type`                  | MUST NOT be sent                                                                 |
| `Content-Length`                | May be omitted or sent as `0`; not signed in v1                                  |
| `Date`                          | Required; represents the same whole UTC second as `Signature-Input.created`      |
| `Content-Digest`                | Required literal `sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:`        |
| `Signature-Input` / `Signature` | Required; the single `sig1` profile from Transport and Security Section 3.4      |
| Signed components               | `"@method" "@path" "@query" "@authority" "date" "content-digest"`, in that order |
| Authentication                  | `recognized signed`                                                              |
| JSON response                   | `application/json` success or error envelope                                     |
| Successful media response       | `application/octet-stream`, without a JSON envelope                              |

An encoded JSON object, `null`, `{}`, a newline, or any other byte is not an
empty GET body. A non-empty body, `Content-Type` on a GET, an incorrect empty
body digest, or duplicate security header MUST be rejected before business
authorization according to the [shared validation mapping](./errors.md#shared-validation-failure-mapping).

Except for the media query and `Range` defined below, these requests accept no
query parameters. A duplicate name, empty value, decoding failure,
non-canonical encoding, unknown parameter, or incorrect parameter order MUST
return HTTP `400 FEDERATION_MALFORMED`. Path variables are encoded individually
as specified by Transport and Security Section 3.1. The receiver performs
exactly one UTF-8 percent-decoding pass before grammar validation and MUST NOT
decode twice, fold case, or re-encode before signature verification.

An HTTP `200` business error still uses the JSON error envelope. Consumers
MUST classify it by `Content-Type` and envelope before interpreting it as a
resource response.

## 2. User profiles

### 2.1 Operation

```http
GET /s2s/v1/users/:account
```

| Property       | Requirement                                                    |
| -------------- | -------------------------------------------------------------- |
| Path variable  | `account: UserAccount`                                         |
| Query          | None                                                           |
| Success        | HTTP `200` success envelope with Section 2.2 data              |
| Business error | HTTP `200 NOT_FOUND` or `200 FEDERATION_PROFILE_NOT_DISCLOSED` |

`account` MUST be a `UserAccount`, not a `GroupAccount`. The operation resolves
only a user local to the publisher's own domain; a path, query, or header MUST
NOT select another domain. Any `recognized signed` peer MAY query this public profile,
but the query grants no P2P, group, message, or media permission.

### 2.2 Successful response

The success `data` is this closed object:

```ts
interface PublicUserProfile {
  account: UserAccount;
  domain: Domain;
  displayName: string;
  bio: string;
  avatar: InlineProfileAvatar | null;
  profileRev: SafeInteger;
}
```

Lengths below count Unicode code points, not UTF-8 bytes or UTF-16 code units.

| Field         | Requirement                                                  |
| ------------- | ------------------------------------------------------------ |
| `account`     | Equal to the normalized path `account`                       |
| `domain`      | Equal to the responding server's canonical logical authority |
| `displayName` | 1–30 code points, without unpaired surrogates                |
| `bio`         | 0–120 code points, without unpaired surrogates               |
| `avatar`      | `null` or a shared `InlineProfileAvatar`                     |
| `profileRev`  | Monotonically non-decreasing `SafeInteger` for this user     |

The shared inline-avatar validation rules apply. `avatar: null` explicitly
means no avatar. A response with an equal
or lower `profileRev` MUST NOT replace a newer committed profile for the same
`account/domain`. Unknown data fields MUST be rejected.

This is the public user profile for exact-account lookup. It MUST NOT contain
relationship directions, group membership, presence, contact information,
deletion reasons, or another peer's visibility state.
Full friend and member display profiles are published through the state feed
only when the corresponding visibility exists. v1 defines no fuzzy user search
or account-enumeration operation.

### 2.3 Errors and application

- A malformed path account returns HTTP `400 FEDERATION_MALFORMED`.
- An account that is not an existing local user returns HTTP `200 NOT_FOUND`.
- If the user does not disclose the public profile to this peer, the publisher
  MAY return HTTP `200 FEDERATION_PROFILE_NOT_DISCLOSED` or privacy-collapse it
  to HTTP `200 NOT_FOUND`. A consumer MUST accept either and MUST NOT infer
  account existence from the distinction.
- Shared signature, recognition, identity, policy, and service failures follow
  the error registry.

Reads have no side effects. The consumer MUST validate the complete envelope,
field constraints, account/domain binding, and avatar before atomically
applying `profileRev`. An error response MUST NOT modify a saved profile.

### 2.4 Example

```http
GET /s2s/v1/users/alice HTTP/1.1
Host: b.example
Date: Tue, 14 Nov 2023 22:13:20 GMT
Content-Digest: sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:
Signature-Input: sig1=("@method" "@path" "@query" "@authority" "date" "content-digest");created=1700000000;expires=1700000300;keyid="a.example/key-1";alg="ed25519"
Signature: sig1=:7Sw4YpBdQ16AZg4H90xMjZc3FhFbBfIBmo9L1kEzvIbnUfI5hLNhF2U6bPdFx+V4YLOqadmO3HxFapgJm+T9Dg==:
```

The request has no body. With no query parameters, the signed `@query` value
is `?`.

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"code":0,"message":"successful","data":{"account":"alice","domain":"b.example","displayName":"Alice","bio":"","avatar":null,"profileRev":7}}
```

## 3. Media resources

### 3.1 Operation and authorization coordinate

```http
GET /s2s/v1/media/:digest?fromAccount=:fromAccount&fromDomain=:fromDomain&toAccount=:toAccount&seq=:seq
```

| Property                  | Requirement                                                    |
| ------------------------- | -------------------------------------------------------------- |
| Path variable             | `digest: Sha256Hex`                                            |
| Query                     | The four required fields below, in the listed order            |
| Additional request header | At most one `Range` as defined in Section 3.2                  |
| Success                   | HTTP `200` full raw bytes or HTTP `206` single-range raw bytes |
| Error                     | JSON error envelope according to Section 3.3                   |

| Parameter     | Location | Meaning                                                                                           |
| ------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `digest`      | Path     | `Sha256Hex` of the complete resource bytes                                                        |
| `fromAccount` | Query    | Exact message author's `UserAccount`                                                              |
| `fromDomain`  | Query    | Exact message author's `Domain`                                                                   |
| `toAccount`   | Query    | Signer-hosted recipient for P2P, or the `GroupAccount` for a group                                |
| `seq`         | Query    | Exact outer message `seq`, encoded as a `PositiveDecimalString` no greater than `SafeInteger - 1` |

The query order is fixed as `fromAccount`, `fromDomain`, `toAccount`, `seq`.
The signer domain comes only from the verified HTTP Message Signature and is
not repeated in the query.

Federated media content contains a `BlobDescriptor`, not a download URL. Its
`digest` binds the message or forward closure to exact bytes and lets the
consumer decide what it is authorized to request. The identical digest in the
CAS path identifies and verifies the requested bytes. These are deliberately
the same value in two different contexts; a mismatch invalidates the request
derivation. `BlobDescriptor.bytes` states the complete expected length so a
consumer can reject an excessive resource before downloading and verify the
completed transfer.

The consumer MUST validate the content descriptor against the outer message's
`assets` descriptors and derive every query coordinate from that verified
`FederatedMessage`. It MUST NOT use `originSeq`, `feedId`, display metadata, a
LINK page URL, or a guessed coordinate.

Before returning bytes, the publisher MUST prove that the undeleted message
identified by `(fromAccount, fromDomain, toAccount, seq)` was durably allocated
to the signer's thread audience and that `digest` is directly bound to that
message or belongs to the complete parent forward bundle bound by it. A bundle
ID is not part of the media request. Knowledge of a digest or bundle ID,
receipt of a feed page, or a current federation relationship is insufficient.
Feed compaction or acknowledgement MUST NOT by itself erase a historical
allocation proof.

### 3.2 Range requests and successful responses

Without `Range`, success is HTTP `200` containing the complete bytes and these
headers:

- `Content-Type: application/octet-stream`
- `Content-Length: <complete length>`
- `Accept-Ranges: bytes`

v1 sets no universal media-size maximum. A consumer MAY decline or stop a
download under its finite local policy, but doing so MUST NOT block a message
or query cursor, alter peer lifecycle, or create a message tombstone. A
publisher MAY refuse bytes under its quota or service limits using Section 3.3.

v1 supports one RFC 9110 byte range: `bytes=start-end`, `bytes=start-`, or
`bytes=-suffixLength`. Successful range delivery is HTTP `206` and includes
`Content-Length`, `Accept-Ranges: bytes`, and exact
`Content-Range: bytes <start>-<end>/<complete length>`. The server MUST NOT
compress or transform the bytes.

`Content-Digest` MAY appear on a `206`; if present, it is the SHA-256 structured
field for that response body's bytes. In all cases the consumer MUST reassemble
ranges without overlaps or gaps, verify the final length against
`BlobDescriptor.bytes`, and verify the complete SHA-256 against the path
`digest` before committing the blob. An interrupted connection, inconsistent
length or range, digest mismatch, or unknown content coding invalidates the
current range.

A syntactically valid but unsatisfiable range returns HTTP `416` with the JSON
error `FEDERATION_RANGE_NOT_SATISFIABLE` and
`Content-Range: bytes */<complete length>`. A malformed range, multiple ranges,
or unsupported range unit returns HTTP `400 FEDERATION_MALFORMED`; it MUST NOT
silently degrade to a full `200`.

### 3.3 Media errors

The publisher MUST classify an error before sending any resource byte:

| Condition                                                                                      | HTTP / code                            | Consumer action                                                                             |
| ---------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------- |
| Malformed path, query, encoding, or Range; duplicate, unknown, or out-of-order query           | `400 FEDERATION_MALFORMED`             | Correct the request; do not retry unchanged or alter peer lifecycle.                        |
| Failed pinned identity, recognition, or signature                                              | Registered `401` code                  | Reject response data and follow the registry.                                               |
| No authorized message/audience proof for the coordinate                                        | `200 FORBIDDEN`                        | Treat as a permanent business refusal; do not guess another coordinate or degrade the peer. |
| Authorized message exists but the digest is not bound to it                                    | `200 NOT_FOUND`                        | Retry only after relevant message/resource state changes or manual action.                  |
| A forward root or its complete closure does not bind the digest                                | `200 NOT_FOUND`                        | Do not substitute child IDs, inner authors, or another publisher.                           |
| Binding exists but the complete blob is deleted, missing, or unreadable as a complete resource | `200 NOT_FOUND`                        | Keep the message and mark only the asset unavailable under local policy.                    |
| Media-operation quota is exhausted                                                             | `200 FEDERATION_QUOTA_EXCEEDED`        | Accept no bytes; wait at least `data.retryAfter`; do not alter peer lifecycle.              |
| Valid single range is outside the resource                                                     | `416 FEDERATION_RANGE_NOT_SATISFIABLE` | Validate `Content-Range` and stop that offset; do not infer absence.                        |
| The publisher is temporarily unable to read storage and cannot establish absence               | `503 INTERNAL`                         | Retain the coordinate and cursor; retry with bounded backoff according to the registry.     |

`NOT_FOUND` means only that this publisher cannot provide this digest under the
authorized coordinate. It does not prove global absence. Lack of audience
proof MUST NOT be downgraded to `NOT_FOUND`, and a confirmed missing blob MUST
NOT be promoted to `503` to induce indefinite automatic retries.

An asset failure is not a source message deletion and MUST NOT create or relay
a tombstone. Error responses are `application/json` and contain no resource
bytes. If streaming fails after `200/206` headers and partial bytes, the server
terminates the stream; it cannot replace it with a JSON error. The consumer
discards an incomplete or invalid range. Quota is determined before any raw
byte and returns only the closed `{ retryAfter }` data.

### 3.4 Range example

The complete resource is the 16 ASCII bytes `hello federation`, whose SHA-256
is the path digest below. This request asks for the first five bytes:

```http
GET /s2s/v1/media/d831d6f2797f986eb5453ea3c86e1b6ac7eac94ba35edd17730b939536059afa?fromAccount=alice&fromDomain=b.example&toAccount=bob&seq=42 HTTP/1.1
Host: b.example
Date: Tue, 14 Nov 2023 22:13:20 GMT
Content-Digest: sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:
Range: bytes=0-4
Signature-Input: sig1=("@method" "@path" "@query" "@authority" "date" "content-digest");created=1700000000;expires=1700000300;keyid="a.example/key-1";alg="ed25519"
Signature: sig1=:6YAuNShBJXwELU+pYCbi+PijcgbC+rvmdio7U6mLEKSuVs1nreRH++To7aIduclGuBCy9XJ5kRRBQULPlPNPBQ==:
```

```http
HTTP/1.1 206 Partial Content
Content-Type: application/octet-stream
Content-Length: 5
Content-Range: bytes 0-4/16
Accept-Ranges: bytes
Content-Digest: sha-256=:LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=:

hello
```

`Range` is not a v1 signature component. The response digest covers these five
bytes; the path digest covers the complete resource.

## 4. Forward bundles

### 4.1 Operation and authorization

```http
GET /s2s/v1/forward-bundles/:bundleId
```

| Property       | Requirement                                                           |
| -------------- | --------------------------------------------------------------------- |
| Path variable  | Bounded opaque `bundleId`                                             |
| Query          | None                                                                  |
| Success        | HTTP `200` success envelope containing a complete `ForwardWireBundle` |
| Business error | HTTP `200 NOT_FOUND`                                                  |

`bundleId` MUST be a non-empty, case-sensitive opaque string of at most 26
characters and at most 26 UTF-8 bytes after path decoding. It MUST NOT contain
NUL or `/`.

The publisher MUST prove that the bundle is bound to at least one undeleted
FORWARD message durably allocated to the signer's thread audience. Knowledge
of the bundle ID, a child reference, or current recognition is insufficient.

### 4.2 Successful response and invariants

Success `data` is the closed `ForwardWireBundle` defined by
[Message Section 11](./message.md#11-forward), with these additional invariants:

- `id` equals the path `bundleId`. A `children[].id` is not an independent query
  target.
- `children` is the flat set of all nested child bundles and has unique IDs in
  this response. Internal references may form cycles; no recursive-depth test
  is applied.
- Each bundle has an independent message-ID space. `quoteTargetId` resolves
  only within its enclosing `messages` array.
- The publisher MUST return its previously published closure in full. v1 sets
  no common byte, child-count, or message-count maximum. A consumer MAY decline
  it under finite local limits but MUST NOT commit a partial closure or block
  the outer FORWARD message/query cursor.
- `assets` is the deduplicated union of all assets referenced by the root and
  child messages and authors.
- Counts are derived from the received arrays and are not wire fields.
- The consumer retains the binding between the closure and the outer FORWARD
  message through which it was discovered.

A closure is an immutable snapshot. Repeated successful reads of a
`bundleId` from the same publisher MUST be semantically identical. Binary
assets are not embedded; they use the media operation and the exact coordinate
of the outer FORWARD message.

### 4.3 Closure asset retrieval

The bundle operation returns only JSON. After validating the complete closure,
the consumer derives a media request for a needed asset as follows:

| Media parameter | Sole source                                                     |
| --------------- | --------------------------------------------------------------- |
| `digest`        | `BlobDescriptor.digest` in the root bundle's `assets` union     |
| `fromAccount`   | `FederatedMessage.author.account`                               |
| `fromDomain`    | `FederatedMessage.author.domain`                                |
| `toAccount`     | Signer-hosted participant for P2P; `thread.account` for GROUP   |
| `seq`           | Outer `FederatedMessage.seq` encoded as `PositiveDecimalString` |

The request MUST NOT contain a bundle ID. An inner author, child ID, local
bundle message ID, and `quoteTargetId` are not authorization coordinates. The
publisher re-establishes the outer FORWARD binding, durable audience, and the
digest's membership in that root's complete closure before returning bytes.

A consumer MAY download the same digest only once and asset ordering has no
protocol meaning. A range retry preserves every query parameter and changes
only `Range`. An asset becomes available only after its complete length equals
`BlobDescriptor.bytes` and its complete digest verifies. A failed asset does
not change the validity of the already verified closure and does not authorize
digest-based retrieval from another publisher.

### 4.4 Errors and application

- A malformed path returns HTTP `400 FEDERATION_MALFORMED`.
- A missing or invisible bundle, or one without message/audience binding to the
  signer, returns HTTP `200 NOT_FOUND`.
- Exhausted bundle-operation quota returns
  `200 FEDERATION_QUOTA_EXCEEDED` with only `{ retryAfter }`. The consumer does
  not commit a partial closure or alter peer lifecycle and waits at least that
  many seconds before retrying.
- Shared failures follow the error registry.

`NOT_FOUND` is not a message deletion signal and MUST NOT create, propagate, or
imply a tombstone. A saved summary or partial closure MUST NOT be presented as
the complete bundle. The consumer validates the entire closed shape, flat
reference closure, local message-ID scopes, its local finite limits, and every
descriptor before one atomic commit. Internal cycles are valid references; any
other failure rejects the entire bundle without retaining an authorizing
partial graph.

### 4.5 Minimal example

```http
GET /s2s/v1/forward-bundles/01hzy3m8x7v6t5r4q2p1n0k9jc HTTP/1.1
Host: b.example
Date: Tue, 14 Nov 2023 22:13:20 GMT
Content-Digest: sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:
Signature-Input: sig1=("@method" "@path" "@query" "@authority" "date" "content-digest");created=1700000000;expires=1700000300;keyid="a.example/key-1";alg="ed25519"
Signature: sig1=:slzsnwcoWsHW5o63VWAaCis5u/akBYIblV5PbwKoj6I2v8wcqIZ/hHnRfOiwTWkiTwpLGB/mUSWw9QZCGhp9BQ==:
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "code": 0,
  "message": "successful",
  "data": {
    "id": "01hzy3m8x7v6t5r4q2p1n0k9jc",
    "messages": [
      {
        "id": 1,
        "author": {
          "displayName": "Alice",
          "account": "alice",
          "domain": "b.example"
        },
        "contentType": "PURE_TEXT",
        "content": "{\"text\":\"hello\"}",
        "sentAt": 1700000000000
      }
    ],
    "children": [],
    "assets": []
  }
}
```
