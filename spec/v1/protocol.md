# Simple Open Messaging Federation Protocol v1

- Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)
- Protocol identifier: `1`
- S2S API prefix: `/s2s/v1`
- Cross-version discovery path: `/.well-known/somfp`
- DNS SRV service name: `_somfp._tcp`

This core specification defines Federation v1 versioning, HTTP surface, transport, shared Federation types, request signatures, common responses, error classification, retry behavior, and base cursor semantics. The referenced normative operation documents define operation-specific bodies, authorization, and state machines. Implementation database fields, workers, queues, configuration, and local product limits are not protocol requirements.

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, and `MAY` are to be interpreted as described in RFC 2119 and RFC 8174.

## 0. Normative documents and precedence

Federation v1 requirements are jointly defined by this document and the explicitly referenced [Transport and Security](./transport-security.md), [Peer Recognition](./recognition.md), [State Feed](./state-feed.md), [Group Meta Feed](./group-meta.md), [Departed Member Profile Feed](./departed-member-profile-query.md), [Message Query](./message-feed.md), [Message Tombstone Query](./message-tombstone-feed.md), [Resources](./resources.md), [Calls](./calls.md), and [Stable Error Registry](./errors.md). This document owns the shared protocol contract. An operation document MAY tighten fields, states, and authorization for its operation without weakening this document's security baseline. Conflicting requirements for the same externally observable behavior are a specification defect. An implementation MUST fail closed and MUST NOT choose the less restrictive interpretation.

JSON Schema, the HTTP manifest, and vectors under `schema/` are validation artifacts and cannot override normative text. They MUST remain aligned field by field with the text, with conformance checks preventing drift.

## 1. Scope, roles, and terminology

- **Server**: a protocol participant that implements Federation v1 and sends or receives S2S requests.
- **Server domain**: the server's stable federation identity, represented by a normalized `Domain`. A host, port, or IP obtained through DNS or SRV determines only where to connect and is not the server domain.
- **Peer**: a remote server with which the local server is establishing or has established bidirectional recognition.
- **Origin**: the sole authority for a group's identity, roster, and accepted timeline, including terminal deletion facts. A member from a third-party domain remains the message author, but its home server submits only to the origin; only the origin publishes accepted facts to group mirrors.
- **Mirror**: a group copy held by a non-origin server. A mirror consumes authoritative group state, messages, and deletions only from the origin and MUST NOT republish received group facts to a third peer.
- **Submission**: a message or withdrawal request sent by a member's home server to the group origin. A submission is not an authoritative fact for group mirrors; the origin MUST validate and durably accept it before authoritative distribution.
- **Authoritative distribution**: direct publication by the group origin of accepted group facts to peers holding a mirror. It is not arbitrary peer relay and has no mirror-to-mirror next hop.
- **Publisher**: the server providing a feed, resource, or authoritative state in an operation or synchronization direction.
- **Source**: the server acting as publisher in a feed or query context. `source` is not a separate identity or trust role; outside feed and query contexts, use `publisher`.
- **Consumer**: the server that requests, validates, and commits publisher data in an operation or synchronization direction. The same server MAY be publisher and consumer in different operations or opposite synchronization directions.

The Federation v1 data plane uses a fixed authoritative topology. An author's home server directly publishes a P2P authored message or withdrawal to the other endpoint. Group data has only a submission leg from member home to origin and an authoritative distribution leg from origin to mirrors. Recognition creates mesh connectivity; it does not allow an arbitrary recognized peer to relay another authority's facts.

- **Durable fact**: business state retained by a server, such as a relationship direction, group-roster snapshot, or message copy. Its validity and lifecycle follow business state and do not depend on delivery of a feed-head hint.
- **Durable change**: an ordered source record allocated by a publisher for a specific peer to discover or synchronize a durable fact. It has a source feed coordinate and is exposed according to cursor and compacted-projection rules. Reading is not an acknowledgement; removing the source record does not remove the corresponding durable fact.
- **Feed-head hint**: a lossy wake-up carrying consistent inclusive feed endpoints.
- **Cursor**: a source feed or query position safely committed by the consumer. A hint or failed response cannot advance it.
- **Reset**: an administrator-authorized destructive identity lifecycle. An ordinary disconnect or DNS change is not a reset.
- **Wire format**: the method, path, query, headers, and body bytes actually transferred over HTTP; it excludes database structure, internal objects, and local execution strategy.

## 2. Versioning and compatibility

SOMFP distinguishes the wire-protocol major from the specification-package version. The wire negotiates only a positive integer major such as `1`; URLs use `/s2s/v1`, and discovery uses `protocolVersions: [1]`. The package containing normative text, JSON Schema, vectors, and conformance tooling uses Semantic Versioning, such as `1.0.0-rc.0` or `1.0.0`. The package version MUST NOT appear in an S2S body, URL, or version-selection algorithm and MUST NOT be used for capability negotiation. A v1 patch release may contain only errata and artifact corrections that do not change peer-observable wire behavior. Any wire behavior change requires a new integer major.

Every Federation v1 S2S data-plane endpoint is under `/s2s/v1/*`. The public discovery endpoint is fixed at `/.well-known/somfp` because a caller cannot rely on an API prefix before reading discovery.

`/.well-known/somfp` is a cross-version discovery document, not a response owned by one Federation major. `protocolVersions` is Federation's permanent cross-version bootstrap field. Every present or future major using `/.well-known/somfp` MUST support and return it and MUST NOT remove or rename it or change its type or selection semantics. It MUST be a non-empty JSON number array of unique, strictly increasing positive safe integers and MUST completely list every Federation major that the node currently enables and fully implements. A node MUST NOT publish a major for which it implements only some mandatory behavior.

A caller MUST first read `protocolVersions`, select the highest value `V` in the intersection of both version arrays, and then validate the shared and version-specific well-known fields according to version `V`. An empty intersection prevents federation establishment. The `/s2s/v<V>` path explicitly expresses the selected version; state, message, command, and Recognize bodies MUST NOT repeat a version field.

Beyond the permanently mandatory `protocolVersions`, later majors SHOULD retain semantically compatible shared fields and MAY add fields to the same well-known object. A field with the same name MUST retain the same type and semantics across every major listed in `protocolVersions`; a changed meaning MUST use a new field name. Only a handshake selecting the defining major interprets a field added by that major. An implementation selecting v1 MUST ignore fields undefined by v1 and MUST NOT allow them to change v1 identity, authorization, surface, or security behavior.

The optional `software` field is diagnostic only. A consumer MUST NOT enable, disable, or change v1 protocol behavior based on a product name, software version, or build number. An implementation MAY publish `1` in `protocolVersions` only when it fully supports every mandatory behavior in this specification.

Each `/s2s/v<major>` handler MUST accept only a major currently published by the node and MUST NOT transparently downgrade an unsupported version. If a successful well-known refresh establishes that a known peer no longer shares a version with the node, the node MUST record the version reason, enter `halted`, stop automatic communication, and reject the peer's ordinary data plane. It MUST NOT thereby delete identity pins, cursors, mirrors, or authorization. Recovery is local administration. A node need not refresh well-known before every request; refresh frequency and connection lifecycle are implementation choices, but request behavior MUST NOT create tight polling or traffic amplification.

The node MUST reject a request for a syntactically recognized `/s2s/v<major>` that it does not enable and SHOULD return HTTP `409` with `FEDERATION_PROTOCOL_VERSION_UNSUPPORTED`. It MUST NOT route the request to another major's handler.

The v1 wire surface and every v1 object are closed. Unknown fields and unknown enum values are malformed unless an operation explicitly says otherwise. Adding, removing, or renaming a field or enum value, changing its meaning, or changing an endpoint, authentication, status code, idempotency, or cursor semantics is incompatible and requires a new `/s2s/v2` major. Errata, non-normative explanation, and implementation optimization that does not change externally observable protocol behavior MAY be released within v1.

## 3. Federation v1 HTTP surface

The following table is the complete v1 surface. Its synchronization surface contains three GET feeds, two GET thread queries, and one POST feed-head hint. The authentication context determines how signature validation obtains a key and which peer states MAY invoke an operation; it does not change the Section 6 signature wire format.

| Method | Absolute path                       | Authentication context | Request                   | Success     | Response                 |
| ------ | ----------------------------------- | ---------------------- | ------------------------- | ----------- | ------------------------ |
| `GET`  | `/.well-known/somfp`                | public TLS             | no query or body          | `200`       | bare discovery object    |
| `POST` | `/s2s/v1/recognize`                 | bootstrap signed       | empty JSON object         | `200`       | bare Recognize OK        |
| `GET`  | `/s2s/v1/health`                    | status signed          | no query or body          | `200`       | bare privacy-safe status |
| `POST` | `/s2s/v1/feed-heads`                | lightweight signed     | JSON feed-head hint       | `200`       | success ACK envelope     |
| `GET`  | `/s2s/v1/state-feed`                | recognized signed      | feed query                | `200`       | success data envelope    |
| `GET`  | `/s2s/v1/group-meta`                | recognized signed      | group/meta mode query     | `200`       | success data envelope    |
| `GET`  | `/s2s/v1/departed-member-profiles`  | recognized signed      | group sequence query      | `200`       | success data envelope    |
| `GET`  | `/s2s/v1/messages`                  | recognized signed      | thread data query         | `200`       | success data envelope    |
| `GET`  | `/s2s/v1/message-tombstones`        | recognized signed      | thread data query         | `200`       | success data envelope    |
| `POST` | `/s2s/v1/call`                      | recognized signed      | JSON call frame           | `200`       | success data envelope    |
| `GET`  | `/s2s/v1/users/:account`            | recognized signed      | path account              | `200`       | success data envelope    |
| `GET`  | `/s2s/v1/media/:digest`             | recognized signed      | path/query/optional Range | `200`/`206` | raw bytes                |
| `GET`  | `/s2s/v1/forward-bundles/:bundleId` | recognized signed      | path bundle ID            | `200`       | success data envelope    |

All four signed contexts use the same HTTP Message Signature profile but have different authorization boundaries:

- **bootstrap signed** applies only to `recognize`. The receiver obtains the root key and a valid signing-key certificate from the signer domain's current well-known document, validates the HTTP signature and domain binding, and only then commits the directional recognition fact in one transaction. One request MUST NOT be interpreted as bidirectional recognition.
- **status signed** applies only to `health`. The receiver attempts validation using only an existing pinned/recognition identity. A recognized but not-yet-converged peer MAY receive `degraded`. Unknown, unrecognized, or unauthorized requesters uniformly receive privacy-safe `unavailable`; the query MUST NOT trigger first recognition.
- **lightweight signed** applies only to `feed-heads`. Before returning Recognize `OK` to a signer, the receiver MUST atomically open this directional gate. The signer MAY send this operation only after receiving `OK`. This context does not require full `available` state and cannot authorize another data-plane operation.
- **recognized signed** requires a pinned root, complete bidirectional recognition facts, a currently valid signing-key certificate, and the operation's own business authorization. A receiver MUST NOT reject a request merely because its cached availability view is `degraded`. A successfully validated and processed request/response round trip MAY clear transport-only degradation as defined by recognition.md. `halted` remains a hard protocol or policy gate whose specific cause is retained outside the lifecycle. calls.md further defines safe termination of an existing active call binding.

A hard gate MUST preserve the specific wire result that caused `halted` and MUST NOT collapse it into a generic “untrusted” error. A policy block uses `FEDERATION_PEER_BLOCKED`, an identity contradiction uses the appropriate identity error, and version incompatibility uses `FEDERATION_PROTOCOL_VERSION_UNSUPPORTED`. These causes share a lifecycle that stops automatic communication but retain distinct reasons and security meaning.

[Resources](./resources.md) completely defines the path/query, response, authorization, Range, closure, and error contracts of the three resource operations. Neither this summary nor the surface table overrides its field-level requirements.

A path absent from this complete surface is not part of Federation v1. [Peer Recognition](./recognition.md) defines the fields, bidirectional state, pinning, retry, and privacy rules for `recognize` and `health`.

The local peer lifecycle is the closed enum `unrecognized`, `establishing`, `available`, `degraded`, or `halted`. It is distinct from the privacy projection `available | degraded | unavailable` returned by Health:

- `unrecognized` means there is no usable pinned/recognition identity.
- `establishing` means the root is pinned but bidirectional Recognize or service-readiness facts have not converged. An initiator MUST enter this state before sending its first Recognize HTTP request.
- `available` means bidirectional recognition, service readiness, and reachability have all converged.
- `degraded` means bidirectional recognition is established but current reachability has a retryable failure.
- `halted` is the uniform, non-automatically-recoverable state after a verifiable hard failure. The specific HTTP error or local security cause is retained separately for administrator action.

`available` and `degraded` are local availability and scheduling information and do not independently authorize an ordinary operation. An operation gate MUST be calculated from pinned identity, directional confirmation facts, version, policy, and business authorization. recognition.md defines the complete states and transitions.

Before returning Recognize `OK`, a receiver MUST atomically open its directional receive gate for `feed-heads`. A server sending reverse Recognize MUST complete local service preparation before sending the HTTP request so that the peer's later Health query returns at least `degraded`, rather than `unavailable`. recognition.md defines the exact commit boundaries and race timing.

## 4. Well-known discovery and keys

[Transport and Security, Section 1](./transport-security.md) is the sole normative definition of the discovery document, root identity, signing-key certificates, and rotation.

## 5. Network, TLS, and logical authority

[Transport and Security, Section 2](./transport-security.md) is the sole normative definition of SRV, connection targets, TLS hostnames, logical authority, redirects, and identity recovery.

## 6. Common protocol rules

### 6.1 JSON encoding and object rules

A JSON body MUST be UTF-8 without a BOM and use `Content-Type: application/json`. v1 does not use `Content-Encoding` for JSON requests. A sender MUST NOT compress a JSON request, and a receiver MUST reject every content coding other than HTTP `identity` (no encoding). A receiver MUST reject duplicate member names in the same JSON object and MUST NOT continue using either a first-value-wins or last-value-wins rule.

Each operation specification defines its body's top-level type, required fields, `null` semantics, and unknown-field policy. A missing field, JSON `null`, an empty string, and numeric zero are four distinct JSON representations and MUST NOT substitute for one another. Unless an operation explicitly permits them, a non-finite number, unsafe integer, or unknown field MUST be rejected as malformed. Member order in an ordinary JSON object has no business meaning. Only an operation explicitly requiring canonical JSON or a fixed-order signature MAY include serialization order in a digest or detached signature.

### 6.2 Shared Federation types

When an operation references a type in this table, it MUST follow the listed format, range, and normalization requirements and MUST NOT redefine or weaken them.

| Name                     | v1 wire grammar and semantics                                                                                                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Domain`                 | A lower-case ASCII DNS name, 1–253 characters overall, with labels of 1–63 characters containing only `a-z`, `0-9`, and `-`. A label MUST NOT begin or end with `-`. The wire value has no trailing root dot.                                                                                               |
| `UserAccount`            | A normalized lower-case ASCII user account matching `^[a-z0-9][a-z0-9._-]{0,29}$`, 1–30 characters overall.                                                                                                                                                                                                 |
| `GroupAccount`           | A globally unique, immutable group identifier: `!` followed by a normalized lower-case ASCII opaque ID matching `^![a-z0-9]{2,30}$`, 3–31 characters overall. Creators MUST mint it with enough cryptographic randomness to make federation-wide collision negligible, and MUST retry on a local collision. |
| `Account`                | A `UserAccount` or `GroupAccount`. It is case-sensitive and accepts only the lower-case forms above. An operation MUST reject an account of the wrong resource type.                                                                                                                                        |
| `Address`                | The closed JSON object `{ "account": Account, "domain": Domain }`.                                                                                                                                                                                                                                          |
| `DecimalString`          | The literal `"0"`, or a non-empty string of ASCII decimal digits without a leading `0`. It MUST NOT be replaced by a JSON number.                                                                                                                                                                           |
| `SignedDecimalString`    | The literal `"0"`, or an optional `-` followed by a non-empty string of ASCII decimal digits without a leading `0`. `-0` is forbidden. It MUST NOT be replaced by a JSON number.                                                                                                                            |
| `PositiveDecimalString`  | A non-empty string whose first character is `1..9` and remaining characters are `0..9`.                                                                                                                                                                                                                     |
| `SafeInteger`            | A JSON integer in `0..9007199254740991`.                                                                                                                                                                                                                                                                    |
| `PositiveSafeInteger`    | A JSON integer in `1..9007199254740991`.                                                                                                                                                                                                                                                                    |
| `ThreadSequence`         | A JSON integer in `1..9007199254740990` (`SafeInteger - 1`). The remaining safe-integer value is reserved as the maximum exclusive reverse-query cursor.                                                                                                                                                    |
| `EpochMilliseconds`      | Unix epoch milliseconds encoded as a `SafeInteger`.                                                                                                                                                                                                                                                         |
| `Sha256Hex`              | `^[a-f0-9]{64}$`.                                                                                                                                                                                                                                                                                           |
| `Base64Ed25519Key`       | RFC 4648 padded base64 decoding to exactly 32 bytes.                                                                                                                                                                                                                                                        |
| `Base64Ed25519Signature` | RFC 4648 padded base64 decoding to exactly 64 bytes.                                                                                                                                                                                                                                                        |
| `KeyId`                  | `Domain "/" KeyName`, where `KeyName` matches `^[A-Za-z0-9._-]{1,64}$`; the complete string before the first `/` is the signer domain.                                                                                                                                                                      |
| `CanonicalUuid`          | Lower-case RFC 4122 text form with version nibble `1..8` and variant nibble `8`, `9`, `a`, or `b`.                                                                                                                                                                                                          |
| `InlineProfileAvatar`    | The closed inline profile-avatar object defined below.                                                                                                                                                                                                                                                      |

```ts
interface InlineProfileAvatar {
  digest: Sha256Hex;
  mimeType: string;
  base64: string;
  width: PositiveSafeInteger;
  height: PositiveSafeInteger;
}
```

`InlineProfileAvatar.base64` MUST contain 4–1,048,576 characters of strict RFC
4648 padded Base64 without whitespace or a `data:` prefix. It MUST decode to a
non-empty image of at most 786,432 bytes. `digest` MUST equal the SHA-256 of the
decoded bytes, and `mimeType` MUST be a non-empty media type matching the
decoded image. `width` and `height` MUST equal the decoded image's actual pixel
dimensions, and `width * height` MUST NOT exceed 16,000,000. A consumer MUST
verify the decoded bytes, digest, media type, and dimensions; declared metadata
is not trusted allocation metadata. Unknown fields are forbidden.

v1 accepts only normalized `Domain` and `Account` values on the wire. A sender MUST send both as lower-case ASCII. The RFC 6762 special-use `.local` namespace is not a globally stable server identity, so `local` and any `Domain` ending in `.local` MUST NOT appear on the SOMFP wire. An implementation may use `local` as an internal storage marker, but it MUST convert that marker to the server's real `Domain` at the federation boundary and MUST NOT expose it to a peer.

An `Account` MUST come from an already-normalized Federation account ID. A sender MUST NOT place a display name or raw user input without identity mapping directly in an S2S request. Before entering the S2S boundary, the sender MUST deterministically normalize or reject case, whitespace, a Unicode domain, or a trailing root dot from user input. A receiver MUST reject a transmitted `Domain` or `Account` containing upper-case letters, whitespace, Unicode, or another non-canonical form. It MUST NOT lower-case, trim, or loosely normalize received values in a way that treats two distinct transmitted values as the same identity. A local database ID MUST NOT be used as an inter-server identity coordinate.

#### 6.2.1 Permanent account binding

An `Address` is a permanent identity coordinate across time, not a reassignable display name or recyclable username. After a domain first publishes `{ account, domain }` as the identity of a user or group:

- The `Address` MUST identify the same logical entity at all times, and its resource type, user or group, MUST NOT change.
- The user's or group's `account` MUST NOT be renamed, migrated, or replaced in place. Changing a display name, profile, group owner, roster, or other mutable attribute does not change this binding.
- After a user is deleted, disabled, inaccessible, or otherwise disappears, or after a group is dissolved, deleted, or inaccessible, its `Address` MUST remain permanently bound and occupied. It MUST NOT be released, recycled, or assigned to a new user or group.
- An implementation MAY stop returning a disappeared entity's profile or business resources, but it MUST durably retain a tombstone or reservation sufficient to prevent reassignment of the `Address`. Physical deletion of business data MUST NOT delete the occupancy fact.

A consumer observing later profile or group state for the same `Address` MUST therefore interpret it as evolution of the original entity and MUST NOT interpret it as transfer of the account to a new entity. If an implementation cannot establish the permanent binding, it MUST fail closed and MUST NOT resolve the conflict by creating a new entity.

### 6.3 Signed-request construction and validation

[Transport and Security, Section 3](./transport-security.md) is the sole normative definition of request targets, body digests, required headers, HTTP Message Signatures, validation order, and fixed examples. An operation document defines only its method, path/query parameters, body shape, and authentication context. It MUST NOT establish another signature profile or change the shared validation order.

## 7. Responses, errors, and caller actions

### 7.1 Media types and response kinds

Successful `well-known`, `recognize`, and `health` responses are the bare JSON objects defined by their operation specifications. Every other successful JSON operation uses an envelope from this section. A JSON response MUST use `Content-Type: application/json`; HTTP `204` MUST NOT be used.

`media/:digest` is the only raw binary response. A complete response uses `200`, a satisfiable single Range uses `206`, and an unsatisfiable Range uses `416`. An error occurring before any bytes are sent uses the JSON error envelope and retains the error HTTP status. After successful headers or body bytes have been sent, a mid-stream read failure MUST terminate the connection and MUST NOT append JSON to the binary body.

### 7.2 Success envelope

A successful response carrying a business result MUST be:

```json
{
  "code": 0,
  "message": "successful",
  "data": {}
}
```

`code` MUST be the JSON integer `0`. `message` MUST be a string for human diagnostics only; a consumer MUST NOT branch on its text. `data` MUST be present, with a shape defined by the operation. The envelope is closed; a consumer MUST reject an unknown top-level field as a malformed success response.

An acknowledgement operation that conveys acceptance without a business result uses:

```json
{
  "code": 0,
  "message": "successful"
}
```

In v1, `feed-heads` is an acknowledgement operation. Another operation MUST NOT omit `data` unless its specification explicitly defines `data: null` for a resultless operation.

### 7.3 Error envelope

Every JSON error response MUST use the `FederationError` envelope defined by the [Federation v1 Stable Error Registry](./errors.md). That registry is the sole authority for stable codes, exact HTTP status, structured `data`, unknown fields and codes, status/code conflicts, and caller actions. An operation document MUST NOT redefine the common envelope.

Health's fixed `unavailable` value is a successfully parsed status result, not an error envelope. The success and mid-stream failure boundary for raw media remains governed by Section 7.1.

### 7.4 Retry and commit boundaries

A successful `feed-heads` request returns HTTP `200`. This means the feed-head hint was accepted, not that the peer completely drained its durable feeds. `call` returns `200` after synchronous validation and transient-state processing of the frame; it does not mean an endpoint received the event or media connected. A network error, unparseable proxy response, or retryable `5xx` MAY be retried with the identical business request, but `Date`, `created`, `expires`, and the HTTP signature MUST be regenerated. A malformed, binding, authorization, or identity conflict MUST NOT be retried unchanged without bound. If present, `Retry-After` MUST be non-negative decimal delta-seconds. A consumer SHOULD honor it and otherwise use bounded exponential backoff with jitter.

An accepted cursor position represents every accepted item through that position. Malformed or otherwise invalid data has no protocol effect. An operation document MUST define the idempotency key and observable result for a repeated request. The same business command MUST NOT become a new command merely because the HTTP request has a new signature.

## 8. Durable state and lifecycle

`state-feed` carries home-owned `PROFILE`, one account-generic `RELATIONSHIP_INTENT`, `GROUP_META_FEED_HEAD` hints, and combined `THREAD_CONTENT_HEAD` message/deletion query bounds. The group-meta feed is the sole source of the current group roster and roles. Its `UPSERT` and `DEPART` items carry the same complete source-scoped member body, preserving author projections associated with retained messages. The reverse-only departed-member profile feed supplies source-scoped profiles needed by skip-mode reverse reconstruction. Group Meta's first read is `full`; later reads use `delta`. User/user and user/group query authorization is directional: an effective `REQUESTED` or valid `ACCEPTED` authored by the source grants the target peer identical access to that source's relationship data. Group/group relationships are invalid.

[Federation v1 State Feed](./state-feed.md) defines complete pages, its four event bodies, field constraints, compacted thread-content heads, and merge semantics. [Group Meta Feed](./group-meta.md) defines per-peer group-member projection. [Departed Member Profile Feed](./departed-member-profile-query.md) defines the reverse sequence-window projection for departed group-message authors. [Federation v1 Message Query](./message-feed.md) defines `/messages`. [Message](./message.md) defines the ten core message contents and their media and forward bodies. [Federation v1 Message Tombstone Query](./message-tombstone-feed.md) defines authoritative deletion facts and `/message-tombstones`. Those documents and this one jointly form the v1 normative text; this summary cannot override their field-level requirements.

One-to-one real-time calls use WebRTC media/JSEP and signed `/s2s/v1/call` frames for federation signaling. [Federation v1 Audio and Video Calls](./calls.md) defines the complete HTTP operation, frame, lifecycle, failure semantics, and one-way AUDIO-to-VIDEO upgrade on the same connection. Real-time frames do not enter a feed; terminal history is an ordinary `CALL` message.

Relationship revocation, leaving, removal, dissolution, and profile or roster updates MUST converge through durable state and cannot depend on a feed-head hint or ordinary message payload.

Authorization revocation stops subsequent allocation but does not delete historical proof already allocated to a peer. Historical reads and media authorization validate their respective thread audiences; a thread-content projection cannot replace resource authorization for media or a forward bundle. A server's local group capacity, quota, and retention policy are not protocol constants.

### 8.1 State-derived authorization closure

All state, group-meta, message-index, tombstone-index, thread-query, media, and
forward-bundle operations MUST derive their disclosure and authorization from
the same durable directional relationships, effective group members, thread
audiences, and historical allocation proofs that state-feed converges. An item,
feed head, retained cursor, cached mirror, or prior successful
request is never authorization proof by itself.

The required closure is:

| Operation                             | Required state-derived rule                                                                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state-feed`                          | Publishes only relationship facts, profiles, group-meta heads, and thread-content heads visible through durable authorization facts.                       |
| `group-meta`                          | Publishes only the origin-authoritative current roster; it does not provide a historical roster.                                                           |
| `/departed-member-profiles`           | Publishes a reverse-only compressed projection of source-scoped profiles for departed authors selected from an authorized group interval.                  |
| `/messages` and `/message-tombstones` | Recompute current relationship, group audience, and historical allocation authorization on every request; a stale thread-content head grants no authority. |
| Media and forward bundles             | Recompute the exact authorized message/thread binding independently of every feed cursor or hint.                                                          |

Consumers MUST drain state first and MUST NOT use data learned from another
feed to invent a relationship or member absent from the applicable state
closure. Publishers MUST return `FORBIDDEN` when the current closure does not
authorize an operation. When a peer's last effective group member leaves, the
origin-authored `RELATIONSHIP_INTENT` becomes `REVOKED` and group-meta access
ends; no terminal group-meta exception exists. Member `DEPART` records remain
available only to other peers whose origin-authored `ACCEPTED` relationship
still authorizes group-meta access.

## 9. Feeds, delivery, cursors, and media recovery

The following publication, recovery, and loop-prevention rules form part of the v1 contract:

- A feed consists of durable changes allocated for a target peer. A change references or carries its visible durable fact; it is not an author-filtered view that excludes content originating with the requester.
- `state-feed` MAY return a directional fact first proposed by the requester and later persisted, confirmed, rejected, or revised by the publisher. A consumer MUST apply it by compacted key in `feedId` order and MUST NOT discard a fact merely because the consumer originally authored it.
- A message item's `seq/createdAt` is the current publisher's local-copy coordinate and persistence time. A message published by the current publisher as timeline authority MUST have `originSeq/originCreatedAt` equal to `null/null`. A non-authoritative copy formed by pulling MUST store the direct publisher's `seq/createdAt` as its own `originSeq/originCreatedAt`.
- After consumer B pulls and durably stores a message from publisher A, B SHOULD make its stored copy readable by A through message query as a processing receipt. B allocates the copy back to A, advances that thread's `messageEndSeq` toward A, and publishes a new `THREAD_CONTENT_HEAD` item. A then reads the copy through B's `/messages` query. `(thread, author, originSeq)` identifies which message previously published by A was durably processed by B. B's publisher-local `seq/createdAt` gives B's copy coordinate and time, while `originSeq/originCreatedAt` equals the original A item’s `seq/createdAt`. The processing acknowledgement therefore comes from the queried message, not the State Feed item.
- A MUST correlate the receipt's `(thread, author, originSeq)` with its previously published `(thread, author, seq)`. It MUST NOT create a duplicate message, rewrite the original, or allocate another thread-content item for the receipt itself. A processing receipt is visible only to the direct publisher of that copy; the fixed v1 topology has no further receipt-distribution step. A receipt is a recommended diagnostic facility, not a reliable ACK. Its absence means only that A has not observed a durably stored copy; it cannot prove that B did not receive it, discarded it, or isolated it for a particular reason.
- After a group origin receives a third-party-authored submission from a member's home server, it MUST validate the author, membership, and content and durably accept the submission before distribution. Only the origin may then distribute it authoritatively to mirrors. A mirror accepts only the known group origin as the group's distribution source and MUST NOT republish the fact to another peer. v1 carries no end-to-end message signature from the author's server. A mirror trusts the authenticated group origin's authoritative assertion about its accepted timeline, not an arbitrary thread participant's retelling.
- A v1 item at `(source domain, thread, seq)` is immutable. A repeated item's authored content, resources, and coordinate fields MUST be semantically identical. The v1 message wire does not carry publisher-local `updatedAt` and does not use it to express edits, withdrawals, or deletion. Withdrawals and effective moderation deletions use `/message-tombstones`.

### 9.1 Feed-coordinate vocabulary

This specification uses the following feed-coordinate terms consistently. An unqualified `HWM` MUST NOT refer to more than one of them:

- `feedId`: a positive item ID allocated by the source in a feed-coordinate space. State Feed has one per-peer space; Group Meta and departed-member profile feeds use their operation-specific spaces. IDs strictly increase and are never reused but need not be contiguous.
- `after`: the exclusive scan position supplied by the consumer. The source does not treat it as an ACK or validate monotonicity.
- `through`: the inclusive upper bound of a bounded drain. It is not an acknowledgement.
- `scannedThrough`: the direction-relative boundary through which a page has scanned continuously. It becomes the next `after` for a forward query or the next `before` for a reverse thread query after successful commit.
- `resumeAfter` and `resumeBefore`: the source's exclusive lower and upper serviceable boundaries for feed and thread-query recovery. A forward query adopts `resumeAfter`, while a reverse thread query adopts `resumeBefore`. Group Meta delta recovery changes to Full mode as defined by [Group Meta Feed](./group-meta.md).
- `stateFeedEndId`: the sole inclusive State Feed drain bound published by `feed-heads`. It is a drain target, not a consumer cursor, business revision, thread-authorization boundary, or relationship-terminal position.
- `messageEndSeq` and `tombstoneEndSeq`: inclusive upper bounds carried together by `THREAD_CONTENT_HEAD`. They belong to two thread-local coordinate spaces and are not feed IDs. `messageEndSeq` is a JSON `PositiveThreadSequence`; `tombstoneEndSeq` is a JSON `ThreadSequence` and may be zero when no deletion exists.
- The stable federation-thread key is the canonical source-user/target-peer-user
  pair for P2P, or the group-address/target-peer-domain pair for a group. Within
  each key, exposed message and tombstone sequence bounds never decrease or
  reset across relationship-state transitions.

Feed IDs use non-negative decimal strings. Thread message and deletion
sequences, their per-thread ends, and thread-query response boundaries use JSON
safe integers; HTTP query parameters carry their canonical decimal text.
Business sequences are positive integers. `0` is the exclusive cursor before
the first valid ID or sequence and is not itself an item ID or business
sequence. An implementation MAY begin allocation above `1` and MAY leave gaps,
provided allocated values strictly increase, are never reused, and the open
bootstrap window `(resumeAfter, resumeBefore)` contains every currently
serviceable coordinate. Resume boundaries do not promise that either adjacent
coordinate contains an item.

Thread queries use mutually exclusive exclusive cursors. `after=A` scans toward
greater sequence values, while `before=B` scans toward smaller values. The
optional `through` is inclusive and fixed at the other end of the bounded
query. The departed-member profile feed uses only the reverse message-sequence
coordinate space and does not itself return messages. Every thread-query cursor MUST be at most `SafeInteger`. To preserve an
exclusive upper cursor for reverse queries, publishers MUST NOT allocate a
message `seq` or tombstone `deletionSeq` greater than `SafeInteger - 1`.

When starting or recovering a forward thread query, a consumer MUST use the
numerically greater of the source-advertised `resumeAfter` and its last
continuously committed cursor for that query. If `resumeAfter` is greater, the
consumer MUST atomically discard the gap between its prior cursor and
`resumeAfter`, treat that gap as absent from its local replicated history, and
continue only after the new start. It MUST NOT retain the gap as pending work or
interpret the local absence as a source-side deletion or acknowledgement. An
operation MAY impose stricter bootstrap or cross-query ordering but MUST NOT
weaken this recovery rule. This source-imposed recovery rule does not authorize
an elective capacity skip; Message Query Section 3 defines that separate
operation.

### 9.2 Common feed rules

State Feed permits omitting `after` to query its current available window. The source then returns `FEDERATION_FEED_CURSOR_UNAVAILABLE` with both `resumeAfter` and `resumeBefore` and no page. A request omitting `after` MUST NOT carry another page parameter. `resumeAfter` is the feed's forward bootstrap base and `resumeBefore` is one greater than `stateFeedEndId`. Draining from that base MUST reconstruct the complete current projection, including every current `THREAD_CONTENT_HEAD`.

State Feed permits optional `take` and the inclusive feed-ID upper bound `through`. `take` is only the consumer's suggested scan count; the source SHOULD consider it but MAY choose another page size according to service capacity. Consecutive pagination with `through` MUST keep the value unchanged. It limits only the read window and is not an acknowledgement, deletion, or historical-degradation operation. The source does not retain a consumer ACK or cursor. A page returns `scannedThrough`, `stateFeedEndId`, and `hasMore`.

Every feed-ID window is open on the left and closed on the right. `after=A&through=T` means `(A, T]`: `A` has already been committed by the consumer and is excluded, while `T` is included as the drain bound. A page actually completes `(after, scannedThrough]`, so `feedId === scannedThrough` is included and `feedId === after` MUST NOT be applied again. Omitting `through` means only that the request uses the source's frozen current `*FeedEndId`; it does not change the interval rule. HTTP byte ranges, time intervals, and other non-feed coordinates are outside this convention.

Applying a page and adopting its cursor position MUST be atomic from the protocol's perspective. A repeated page MUST be idempotent. An empty page may still advance through `scannedThrough`. The source does not validate whether `after` equals the preceding page; the consumer ensures its local cursor never moves backward. Feed IDs need only strictly increase, not remain contiguous. `scannedThrough` and the next item ID MAY cross arbitrarily large deleted or unallocated gaps.

Feed retention is operation-specific. State Feed MUST retain every current non-deletion stable-key projection needed to rebuild from its advertised oldest boundary. Group Meta MUST retain the latest `UPSERT` needed for every current roster member and every complete `DEPART` needed to associate an author projection with a still-serviceable ordinary forward message interval allocated to that peer; its delta retention floor cannot cross either dependency. A completed full snapshot infers departure from absence but does not replace a required historical member projection. Message query has an independent serviceable window. Tombstone facts remain permanent even when loss of authorization removes their current thread-content projection.

The closed `feed-heads` body contains only `stateFeedEndId`. The authenticated signer domain identifies the feed source and is not repeated in the body. The value is an inclusive State Feed scan bound used only for wake-up and bounded draining; it is not an ACK, business revision, or query sequence. A hint may be lost, duplicated, or reordered and MUST NOT be the sole recovery mechanism.

For each authenticated publisher, a consumer MUST retain the greatest
`stateFeedEndId` it has observed but not yet durably covered. A duplicate or
smaller reordered hint MUST NOT reduce a queued target, an active drain target,
or the committed State Feed cursor. A greater hint received during an active
bounded drain creates subsequent work rather than changing that drain's frozen
`through` value.

After receiving hint `S`, a consumer drains State Feed from its committed cursor:

```text
state-feed?after=<committedStateCursor>&through=S
```

The consumer commits the applicable relationship, profile, and Group Meta dependencies before accepting a `THREAD_CONTENT_HEAD` target. The item supplies both thread end sequences; `/messages` and `/message-tombstones` provide actual content. For a normal forward group-message interval, the consumer SHOULD first commit the required Group Meta head, including complete profile-bearing `DEPART` items. When that profile projection is temporarily unavailable, the stable author Address remains valid, the consumer MUST continue Group Meta convergence, and it MUST NOT infer a role or current-membership state from the absent projection. It MUST NOT query the reverse-only departed-member profile feed. For the same forward thread interval, the bounded tombstone and message queries MAY execute concurrently. The interval is not reconciled until both required query drains have committed; the tombstone drain uses its fixed `maxMessageSeq` even if the message drain commits first. Compaction may move an item to a greater feed ID during a drain; a later hint or periodic reconciliation MUST discover it again.

Absence of a `THREAD_CONTENT_HEAD` from the current State Feed projection is not a deletion notice. State Feed relationship facts remain the primary path for relationship termination. If a consumer retains an old P2P end, message query returns `FORBIDDEN`, and both retained authored directions are still `REQUESTED` or `ACCEPTED`, the consumer MUST invalidate the thread's current pending query target and publish `REVOKED` for its own direction without rewriting the peer-authored fact. It publishes no transition if either direction is already `REVOKED` or absent. A GROUP denial only invalidates the query target and prioritizes State Feed convergence because the peer-level query address does not identify one consumer-authored member direction. Neither path moves a feed cursor or committed thread-local cursor backward.

At startup and during periodic reconciliation, even without a hint, a consumer MUST read and drain State Feed from its committed cursor. The `stateFeedEndId` returned by the first successful page without `through` may be fixed as that drain's target. That first page participates in the drain, and later pages use the target as `through`.

### 9.3 Forward reconciliation and reverse reconstruction rounds

A **forward reconciliation round** is one bounded attempt to incorporate a
lightweight hint or a periodic reconciliation observation. The consumer first
drains State Feed to one fixed inclusive `through` target. A larger hint received
during that drain creates subsequent work and MUST NOT enlarge the active page
sequence. Every retry retains the original `through`; each response's
`scannedThrough` is progress toward that fixed target, not a replacement target.

The round is a coordination and retry scope, not an atomic transaction and not
a source-side session. A transport failure MUST NOT roll back an already
committed State Feed page or thread-query page. After recovery, a consumer
derives bounded work from committed coordinates and newly observed heads.

After the State Feed barrier is committed, the consumer selects nondecreasing
per-thread targets from each `THREAD_CONTENT_HEAD` item's `messageEndSeq` and
`tombstoneEndSeq`. It freezes the targets it will process before issuing content
queries. It MAY drain `/messages` and `/message-tombstones` concurrently, but
does not complete reconciliation of the message interval until both bounded
results have been applied. A forward tombstone drain SHOULD include a fixed
`maxMessageSeq` equal to the frozen message target for the same forward thread
round. For a tombstone-only round, it is the greatest publisher message
coordinate the consumer had already covered when the round began. The value
remains unchanged across all pages and cursor-recovery retries. A later message
target belongs to a later tombstone drain. No wire-level round ID or source-side
round state exists; the fixed boundaries and consumer's durable cursors define
the round.

A **reverse reconstruction round** is consumer-local history recovery. It is
initialized when the consumer first commits an authoritative thread-content
head and is not created by `feed-heads` alone. Its initial exclusive `before` is one
greater than the inclusive `messageEndSeq` from the committed `THREAD_CONTENT_HEAD`
that selected the thread tail. It retains an inclusive lower `through` target.
Each reverse page moves its direction-relative `scannedThrough` downward, and
the next page uses that value as `before` while retaining the original
`through`. `hasMore=true` continues that bounded page sequence;
`hasMore=false` completes only its frozen target. A cursor-unavailable result
abandons the invalid sequence and causes recovery from newly reconciled durable
State Feed projection and the returned serviceable window. A later
`THREAD_CONTENT_HEAD` observation creates later work and MUST NOT enlarge an
active bounded sequence.

Before completing reconstruction of a message window, a consumer SHOULD apply
its currently discovered forward tombstone work;
`/message-tombstones` has no reverse direction. A GROUP consumer also applies
the departed-member profile drain corresponding to the actual window ending at
the message page's `scannedThrough`. An unresolved message dependency blocks
completion until the message can be accepted or an authoritative tombstone
terminates it. Reverse progress MUST NOT move a forward cursor backward or
alter an active forward round. A later deletion is incorporated by the
forward tombstone query target carried by a later `THREAD_CONTENT_HEAD`.

Typical uses are initial synchronization that chooses recent history and later
recovery when finite capacity makes the saved forward backlog impractical. Both
use the skip-mode entry and safety rules in
[Message Query Section 3](./message-feed.md#3-consumer-fast-forward-and-tail-initialization).

If a `THREAD_CONTENT_HEAD` references a thread whose required state has not yet converged, the consumer SHOULD continue the State Feed drain before accepting its targets. The publisher's dependency ordering supports convergence when the required state is merely delayed. After process recovery, the consumer confirms the cached peer root identity and a usable signing certificate before draining.

Media content carries only explicit digests, not publisher display or download URLs. The consumer constructs `media/:digest` Range requests from the outer message's authorization coordinates. Download authorization MUST join the signer's current thread audience and validate the digest binding to the exact message or its forward closure. It MUST NOT depend on a collected thread-content head. A download failure or quota pause MUST NOT roll back a committed feed cursor; retrying must preserve the exact message and resource binding. A forward bundle is a bounded, immutable, digest-validated closure.

## 10. Identity continuity and reset requirements

This section defines the security baseline that Recognize and subsequent identity continuity MUST NOT cross. [Federation v1 Peer Recognition](./recognition.md) defines the empty Recognize body, bidirectional confirmation, failure retries, privacy-safe Health status, and atomic transitions.

The first bidirectional Recognize separately confirms “A recognizes B” and “B recognizes A” and pins both root public keys. It does not exchange cursors or initialize business mirrors. The root identity is the long-lived continuity anchor; a signing key is only a request-signing key authorized by that root and rotatable online under Section 4. Ordinary transport degradation MUST preserve identity pins, bidirectional confirmation facts, and synchronization state. It MUST NOT automatically repeat recognition or rewrite the initial confirmation time.

Any contradiction with a pinned root identity MUST retain the old pin, record the reason, and atomically enter fail-closed `halted`. The current domain controller, a signing key not authorized by the pinned root, deletion of a peer row, or ordinary rediscovery cannot inherit old authorization.

Diagnostics, recovery, reset, or renewed recognition after `halted` are local administrative behavior; v1 defines no endpoint or workflow for them. Communication MUST NOT resume automatically before explicit administrator action. A new root MUST NOT automatically inherit recognition facts or business authorization from the old identity.

## 11. Conformance and publication

The normative document set in Section 0 defines v1 conformance. JSON Schema, the HTTP manifest, positive and negative vectors, and the offline Conformance CLI ship with the text as non-normative validation resources. If a tool conflicts with the text, the text prevails and the tool must be corrected.

Conformance is not a v1 endpoint, negotiated capability, or runtime prerequisite, and the protocol does not require implementers to use a particular test facility. The included CLI checks JSON shapes, fixed signature vectors, and the HTTP surface. Implementers remain responsible for validating transactions, identity continuity, and state convergence; a particular test strategy is not part of the protocol.
