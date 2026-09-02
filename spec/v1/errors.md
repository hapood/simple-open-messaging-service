# Simple Open Messaging Federation Protocol v1 Error Code Registry

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)
Normative scope: this document defines S2S HTTP failure classes, HTTP `200` application results, stable `code` values, structured `data`, and caller actions.

## Error envelope

Except for the privacy-preserving `health` status result and raw media responses, every non-zero result from an S2S JSON operation MUST use:

```ts
interface FederationError<T = null> {
  code: number;
  message: string;
  data?: T | null;
}
```

`code` MUST be a non-zero JSON safe integer from the table below. `message` MUST be a string and is for human diagnostics only; a consumer MUST NOT parse its text to determine behavior. The [Structured error data](#structured-error-data) section defines the presence and shape of `data`. The envelope is closed; an unknown top-level field makes the response malformed and MUST NOT be used for error classification, caller action, identity, or cursor semantics. Duplicate JSON members, encoding, and primitive types remain subject to the common JSON rejection rules in protocol.md.

JSON responses MUST use `Content-Type: application/json`. HTTP status expresses only whether the request reached application processing and whether the peer relationship can continue. Application results are expressed only by `code`, not by borrowing an HTTP error status. A sender MUST use the combinations defined below.

## HTTP layer

Federation v1 JSON endpoints define only these non-success HTTP statuses:

|  HTTP | Layer semantics                                                                                   | Peer lifecycle                                                                    |
| ----: | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `400` | HTTP, JSON, or protocol shape cannot enter application processing                                 | No change                                                                         |
| `401` | Request authentication, signature, certificate, or identity binding failed                        | No direct change                                                                  |
| `409` | The authenticated federation relationship has a registered non-automatically-recoverable conflict | Enter `halted` only with a valid fatal code                                       |
| `503` | The target peer is temporarily unable to provide federation service                               | An established peer enters `degraded`; a peer in handshake remains `establishing` |

Normal success and all ordinary application results use HTTP `200`. Application results include resource absence, permission denial, quota exhaustion, operation payload limits, cursor conflicts, and concurrency conflicts. These results MUST NOT change peer lifecycle. Network failure, timeout, and Health `200 unavailable` have the same availability-degradation effect as HTTP `503`.

Raw media response statuses `206` and `416`, with their associated headers, belong to HTTP Range semantics and are explicit exceptions to the JSON status set above.

A complete generic error without structured recovery data is:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{"code":50007,"message":"request body is malformed","data":null}
```

For a code without structured recovery data, `data` MAY be omitted. A consumer MUST identify the error by `code`, not `message`.

On a status/code conflict, a consumer MUST reject response `data` and application side effects. It MUST NOT use a code to promote an HTTP `200` application result into an HTTP lifecycle signal, nor delete a pin, cursor, or committed recognition fact solely because of the conflicting response.

An unknown non-zero code in HTTP `200` MUST be treated as an application failure of the current operation. The consumer MUST NOT accept its `data`, commit application side effects, or advance a cursor. An unknown code or status/code conflict in a non-`200` response provides no finer-grained semantics; the consumer handles only the HTTP class: `503` still degrades availability, `400` and `401` still reject only the current request, and `409` without a registered fatal code MUST NOT trigger `halted`. An unknown code MUST NOT trigger identity replacement, destructive reset, or a permanent authorization change.

### Peer lifecycle mapping

A peer-lifecycle action MUST be determined jointly by response provenance, HTTP status, and, where required, stable code:

| Class                          | Wire characteristics                                                                                                 | Peer lifecycle action                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Hard stop                      | A hostname-verified target peer or authority returns HTTP `409` with a fatal code explicitly listed in this registry | Record the exact code and evidence, enter `halted`, and stop automatic communication             |
| Retryable availability failure | Timeout, disconnect, HTTP `503`, or valid Health `unavailable`                                                       | An established peer enters `degraded`; an incomplete handshake remains `establishing`            |
| Current-request failure        | HTTP `400`, `401`, or a non-zero application code in HTTP `200`                                                      | Correct or handle the current operation according to code; do not directly change peer lifecycle |

HTTP `409` alone is insufficient to trigger `halted`. Only HTTP `409` combined with `FEDERATION_PEER_BLOCKED`, `FEDERATION_IDENTITY_MISMATCH`, or `FEDERATION_PROTOCOL_VERSION_UNSUPPORTED` is a hard stop for the peer relationship. A status/code conflict, unknown code, or response not provably originating from the target peer MUST NOT trigger `halted`.

## Stable code registry

|  code | Name                                               | HTTP | Caller action                                                                                                                                                                                                                                                |
| ----: | -------------------------------------------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 10000 | `VALIDATION_FAILED`                                |  200 | Correct the application request; MUST NOT retry unchanged.                                                                                                                                                                                                   |
| 10001 | `NOT_FOUND`                                        |  200 | The current resource does not exist; retry only after application state changes.                                                                                                                                                                             |
| 10004 | `FORBIDDEN`                                        |  200 | The current application identity may not access the resource; MUST NOT retry unchanged.                                                                                                                                                                      |
| 10005 | `RATE_LIMITED`                                     |  503 | The peer is temporarily rate-limiting; retry using locally bounded, jittered backoff.                                                                                                                                                                        |
| 10999 | `INTERNAL`                                         |  503 | Retain pins and cursors; retry with backoff.                                                                                                                                                                                                                 |
| 50001 | `FEDERATION_RECOGNITION_REQUIRED`                  |  401 | The operation lacks a required pinned identity or bidirectional recognition fact. Stop data-plane requests and complete the missing recognition. Transport-only `degraded` MUST NOT produce this error.                                                      |
| 50002 | `FEDERATION_BAD_SIGNATURE`                         |  401 | Stop unchanged retries and audit the signature, digest, keyId, or certificate; MUST NOT accept response data.                                                                                                                                                |
| 50003 | `FEDERATION_BINDING_VIOLATION`                     |  401 | Correct signer/body/address binding; MUST NOT retry unchanged.                                                                                                                                                                                               |
| 50007 | `FEDERATION_MALFORMED`                             |  400 | Correct the JSON/header profile, primitive type, time parameter, query, media type, or content coding; MUST NOT retry unchanged.                                                                                                                             |
| 50009 | `FEDERATION_PEER_BLOCKED`                          |  409 | Fatal: record the remote-blocked reason, enter `halted`, and stop automatic communication.                                                                                                                                                                   |
| 50010 | `FEDERATION_GROUP_AUTHOR_LEFT`                     |  200 | This author path has terminated; stop this stream without affecting other streams.                                                                                                                                                                           |
| 50011 | `FEDERATION_QUOTA_EXCEEDED`                        |  200 | Back off for `data.retryAfter` seconds; MUST NOT degrade the peer or advance the failed page cursor.                                                                                                                                                         |
| 50014 | `FEDERATION_LOCAL_IDENTITY_LOST`                   |  503 | The peer temporarily cannot provide federation service safely; retain the old pin and retry with backoff.                                                                                                                                                    |
| 50015 | `FEDERATION_IDENTITY_MISMATCH`                     |  409 | Fatal: retain the old pin, record the identity contradiction, and enter `halted`; MUST NOT automatically adopt the new identity.                                                                                                                             |
| 50019 | `FEDERATION_FEED_CURSOR_UNAVAILABLE`               |  200 | Do not apply the page; validate `resumeAfter/resumeBefore` and follow the requesting operation's recovery rules.                                                                                                                                             |
| 50020 | `FEDERATION_PROTOCOL_VERSION_UNSUPPORTED`          |  409 | Fatal: record the version reason and enter `halted`; MUST NOT transparently downgrade.                                                                                                                                                                       |
| 50021 | `FEDERATION_RANGE_NOT_SATISFIABLE`                 |  416 | The current single range is unsatisfiable; read `Content-Range` under the media rules and MUST NOT interpret the resource as absent.                                                                                                                         |
| 50023 | `FEDERATION_PROFILE_NOT_DISCLOSED`                 |  200 | The requested profile or revision is outside the owner's disclosure policy for this peer; stop unchanged retries without changing relationship or peer lifecycle. A publisher may use `NOT_FOUND` instead to conceal whether the account or revision exists. |
| 50024 | `FEDERATION_MESSAGE_QUERY_RATE_LIMITED`            |  200 | The message query rate is too high. Do not advance its cursor; wait at least `data.retryAfter` seconds and retry with jitter without changing peer lifecycle.                                                                                                |
| 50025 | `FEDERATION_MESSAGE_QUERY_TEMPORARILY_UNAVAILABLE` |  200 | The message query temporarily cannot produce a consistent page. Do not advance its cursor; wait at least `data.retryAfter` seconds and retry with jitter without changing peer lifecycle.                                                                    |
| 70001 | `CALL_NOT_ALLOWED`                                 |  200 | Unknown callId or privacy-collapsed account, relationship, block, tenant, or call-admission failure. Terminate this call and MUST NOT degrade the peer.                                                                                                      |
| 70004 | `CALL_BUSY`                                        |  200 | The remote participant is busy. Terminate, or initiate later with a new `callId`; MUST NOT replay the same incoming frame.                                                                                                                                   |
| 70007 | `CALL_CANCELLED`                                   |  200 | The caller cancelled the call. Converge locally to cancelled and stop media, timers, and dependent frames; MUST NOT degrade the peer.                                                                                                                        |
| 70008 | `CALL_TERMINATED`                                  |  200 | Another terminal outcome ended the call. Converge locally to terminal and stop media, timers, and dependent frames; MUST NOT degrade the peer.                                                                                                               |

## Structured error data

Except for codes explicitly listed in this section, `data` MUST be omitted or JSON `null`. Every object below is closed. An unknown field, missing field, `null`, wrong type, or non-safe integer makes the error response malformed; the consumer MUST NOT use its data.

```ts
interface FederationQuotaExceededData {
  // Non-negative integer delta-seconds, measured from complete receipt.
  retryAfter: SafeInteger;
}

type FederationCursorUnavailableData =
  | {
      // Feed-ID coordinate space.
      resumeAfter: DecimalString;
      resumeBefore: DecimalString;
    }
  | {
      // Thread message- or deletion-sequence coordinate space.
      resumeAfter: SafeInteger;
      resumeBefore: SafeInteger;
    };

interface FederationQueryRetryData {
  // Non-negative integer seconds, measured from complete receipt.
  retryAfter: SafeInteger;
}
```

`FEDERATION_QUOTA_EXCEEDED` MUST carry `FederationQuotaExceededData` with `retryAfter >= 0`. The operation itself identifies the limited application category; the response MUST NOT carry a category, limit, unit, window, or server-policy parameter. An implementation may place a specific quota reason in diagnostic-only `message`; a consumer MUST NOT parse that text to determine behavior.

`FEDERATION_FEED_CURSOR_UNAVAILABLE` MUST carry both fields of
`FederationCursorUnavailableData`. Together they describe the current open
serviceable window `(resumeAfter, resumeBefore)`: `resumeAfter` is the exclusive
lower boundary and `resumeBefore` is the exclusive upper boundary. Both values
MUST use the same representation and `resumeBefore` MUST be greater than
`resumeAfter`. Feed operations return non-negative exact decimal strings.
Message and tombstone queries return JSON
`SafeInteger` values.

A forward query resumes with `after=resumeAfter`; a reverse thread query resumes
with `before=resumeBefore`. The response always contains both fields regardless
of request direction or bootstrap. A consumer MUST NOT use one field in place
of the other. State and tombstone feeds MUST NOT use this result to conceal a
current projection required for reconstruction. Message feed MAY advance its
retained lower boundary under its capacity rules. A tombstone query MUST NOT
move its lower boundary because of cleanup.

For a Group Meta delta below either the canonical feed's retention floor or the
authenticated audience's visibility floor, the consumer starts a full replacement
drain with `after=resumeAfter` and fixed `through=resumeBefore-1`. Full mode
contains only the current roster at that boundary and does not disclose
pre-authorization departures. The consumer discards
no committed roster until replacement succeeds atomically and MUST NOT skip
full merely because its local cursor is numerically equal to or greater than
one of the returned boundaries.

The resume fields are exclusive positions, not item coordinates. If the first
potentially serviceable positive coordinate is `N`, then
`resumeAfter = N - 1`. If the last is `M`, then `resumeBefore = M + 1`. The
protocol does not guarantee that items exist at `N` or `M`, because the relevant
coordinate space may contain unallocated, filtered, or unauthorized holes.

`FEDERATION_MESSAGE_QUERY_RATE_LIMITED` and `FEDERATION_MESSAGE_QUERY_TEMPORARILY_UNAVAILABLE` MUST carry `FederationQueryRetryData` and may be used only by `GET /s2s/v1/messages`. Both are application deferrals after HTTP and identity authentication. They MUST NOT conceal signature, binding, authorization, or malformed errors, and MUST NOT be used by tombstone query, State Feed, Group Meta Feed, Authorized Profile, Group Member Profile, Message Author Profile, or for federation-wide service unavailability. They do not use the HTTP `Retry-After` header.

Complete wire example:

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"code":50011,"message":"message query quota exceeded","data":{"retryAfter":60}}
```

This application result promises only that the current operation may be retried after waiting at least `60` seconds. It discloses no quota threshold, unit, window, or algorithm. The following is a valid correction for a message query into a range whose content has been purged:

```json
{
  "code": 50019,
  "message": "requested message history is no longer retained",
  "data": { "resumeAfter": 120, "resumeBefore": 501 }
}
```

The example above is a valid content-retention-floor response. The following is the corresponding invalid counterexample:

```json
{
  "code": 50019,
  "message": "requested message history is no longer retained",
  "data": { "resumeAfter": 100, "resumeBefore": 501 }
}
```

Assuming query `after=100` and that position is not beyond the source's current end, the counterexample `resumeAfter` does not advance strictly; the consumer MUST reject it. If the request itself is clearly beyond the current end, the source returning a strictly smaller valid position is the other out-of-range correction and is not covered by this example.

Federation v1 application quotas use only `data.retryAfter`. HTTP `Retry-After` MUST NOT be sent for them, to avoid confusing an application result with an HTTP availability failure. If this value is malformed, the consumer MUST ignore it and use locally bounded, jittered backoff.

## Shared validation-failure mapping

Unless an operation document explicitly defines a stricter mapping, the common HTTP validation pipeline for a signed request MUST use the table below. This table only disambiguates common validation failures that could map to multiple codes; it does not repeat lifecycle, discovery, or operation-specific application errors. These conditions MUST NOT map to another 4xx response.

| Condition                                                                                             | HTTP / code                                                          |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Invalid JSON/header/query/path shape, duplicate security header, signature profile, or time parameter | `400 FEDERATION_MALFORMED`                                           |
| `Content-Type`, content coding, or character encoding violates v1                                     | `400 FEDERATION_MALFORMED`                                           |
| Request, header, or body exceeds the recipient's finite local HTTP/JSON limit before parsing          | `400 FEDERATION_MALFORMED`                                           |
| Content-Digest mismatch, Ed25519 verification failure, unauthorized keyId, or invalid certificate     | `401 FEDERATION_BAD_SIGNATURE`                                       |
| Signer is not bound to body, address, or resource identity                                            | `401 FEDERATION_BINDING_VIOLATION`                                   |
| Pinned identity or bidirectional recognition facts are insufficient, with no identity contradiction   | `401 FEDERATION_RECOGNITION_REQUIRED`                                |
| Transport-only `degraded`, with recognition, identity, and authorization otherwise valid              | Continue processing; MUST NOT return an error solely for this reason |

Block, identity contradiction, protocol version, local identity, application quota, and server-failure mappings use the registry above and the corresponding operation documents directly and are not repeated here.

An unsatisfiable media Range uses HTTP `416` with `FEDERATION_RANGE_NOT_SATISFIABLE` and `data: null`, and sends `Content-Range: bytes */<current-length>` as required by the media operation. This does not mean the resource itself is absent. [Resources, Section 3.3](./resources.md#33-media-errors) further distinguishes `FORBIDDEN` for insufficient audience or message proof, `NOT_FOUND` for a missing digest binding or CAS blob, an unsatisfiable Range, and transient storage failure. The first three MUST NOT degrade the peer; only a registered HTTP `503` availability failure triggers that lifecycle action.

Media HTTP `200` may be either a complete `application/octet-stream` resource success or an `application/json` non-zero error envelope. A consumer MUST distinguish them using the presence of Range on the request, HTTP status, `Content-Type`, and envelope together, and MUST NOT write JSON error bytes into CAS. A stream failure after response headers have been sent is beyond the boundary at which a JSON error can be returned. The publisher MUST terminate the stream, and the consumer MUST discard the incomplete range and detect failure through length and digest validation.

How a mirror displays, retains, or marks a message whose resource returned `NOT_FOUND` is local consumer policy. The result is not itself message deletion or a tombstone. See Resources Sections 3.3 and 4.4 for the precise boundaries.

Unlisted local client application codes are not part of the Federation v1 wire
registry. An S2S publisher MUST NOT send them as protocol errors. The stable v1
code registry is closed: adding a stable error semantic or changing an existing
code's meaning, retryability, identity action, cursor effect, or structured data
requires a new protocol major. A package revision may only correct an artifact
to match an already-defined v1 semantic without allocating a new wire code.

`GET /s2s/v1/health` is a status-query operation. For a parseable request involving an unknown peer, a peer not recognized locally, insufficient authorization, or failure to verify an existing identity, `unavailable` is the normal query result defined by recognition.md and is not an error in this registry. Generic malformed HTTP or signature structure uses `400 FEDERATION_MALFORMED`. Temporary rate limiting and server failure independent of peer existence uniformly use HTTP `503`, with `RATE_LIMITED` or `INTERNAL`, respectively, for diagnostic classification.
