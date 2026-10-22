# Simple Open Messaging Federation Protocol v1 Message Provenance Query

Status: `DRAFT` — Final Review (`v1.0.0-draft.0`)

This document is entirely normative.

This document defines the batch provenance query
`POST /s2s/v1/message-provenance`. A recognized peer asks the server that
published a message whether it still recognizes a given content digest as the
content it published at a given direct-origin coordinate. The answer is
per-query and one of three states.

## 1. Purpose and scope

A consumer that received a message over federation holds its content, asset manifest, and optional quoted-message digest. Canonicalization follows
[Core Protocol 6.1.1](./protocol.md#611-canonical-json-jcs-for-stringified-content-fields), and the payload digest follows Section 7 below.
It MAY later want to confirm that the publishing server actually published that
exact content at the claimed coordinate, for example to detect local data
corruption, an altered relay, or a stale cache before acting on a message.

This operation answers that question. It does not transfer message bytes,
authorize the requester to read the message, reveal message metadata beyond the
yes/no/declined answer, or change any peer relationship. It is a read-only,
stateless-with-respect-to-the-protocol query: the responder's published fact
does not change as a result of answering.

The query is scoped to the **direct-origin identity** of the message
([Message Envelope, Section 4](./message/envelope.md#4-identity-and-immutability)):

```text
(source domain, normalized thread, wire seq)
```

The requester sends the query to the server identified by that source domain.
Only that server can answer authoritatively, because only it assigned the `seq`
and retained the content it published at that coordinate. A query sent to any
other server has no defined meaning for that coordinate and the requester MUST
NOT infer an answer from a non-source server.

## 2. Authorization and transport

The endpoint requires a recognized, authenticated peer. The request MUST be
HTTP Message Signed and pass the same
[HTTP Message Signature validation](./transport-security.md#35-validation-order-and-failure-boundaries) as
other authenticated operations; an unauthenticated or unrecognized request
MUST be rejected before any query is evaluated, using the applicable authentication error from the common error registry. A missing recognition grant uses `401 FEDERATION_RECOGNITION_REQUIRED`; a malformed signature or other transport failure retains its own prescribed error.

Recognition authorizes the requester to ask the question. It does not oblige
the responder to answer. Authorization to receive a positive answer is a
separate, implementation-defined decision (Section 6).

This operation adds no recognition evidence and changes no peer lifecycle
beyond the reachability evidence supplied by any successfully authenticated
exchange. A response, including a `declined` response, is not recognition
acceptance.

## 3. Request

```ts
interface MessageProvenanceRequest {
  queries: MessageProvenanceQuery[];
}

interface MessageProvenanceQuery {
  thread: ThreadAddress;
  seq: ThreadSequence;
  payloadDigest: Sha256Hex;
}
```

- `thread` is the normalized thread of the message as the requester received it
  from this source. For P2P it is
  `{ account: UserAccount; peerAccount: UserAccount }`; for GROUP it is
  `{ account: GroupAccount }`. It MUST match the `thread` field this server
  published with the message.
- `seq` is the `FederatedMessage.seq` that this source server assigned to the
  message when it served it to the requester. It is the source-scoped
  coordinate from the direct-origin identity, not the requester's local copy
  coordinate and not the message's nullable `originSeq`.
- `payloadDigest` is SHA-256 over the UTF-8 bytes of the JCS canonical payload object defined in Section 7. It covers parsed wire `content`, the sorted asset descriptors, and `quoteDigest` when present. A requester MUST compute it from that complete object, not the content string alone or the raw HTTP body.

The `queries` array MUST contain at least one query and MUST NOT contain more
than **64** entries in a single request. A request outside this range is
malformed and MUST be rejected with `400 FEDERATION_MALFORMED`. Within the
array, each `(thread, seq)` pair MUST appear at most once; a duplicate pair is
malformed. `payloadDigest` MAY differ for the same `(thread, seq)` pair only
across separate requests, never within one.

## 4. Response

On success the response is HTTP `200` with `code` `0` and a closed `data`
object containing one result per query, in the same order as the request:

```ts
interface MessageProvenanceResponse {
  results: MessageProvenanceResult[];
}

interface MessageProvenanceResult {
  thread: ThreadAddress;
  seq: ThreadSequence;
  known: 'yes' | 'no' | 'declined';
}
```

- `yes`: the responder published a message at `(thread, seq)` whose canonical
  payload object defined in Section 7 hashes to the supplied `payloadDigest`.
- `no`: the responder did not publish such a message at `(thread, seq)` with
  that `payloadDigest`. This includes the case where a message exists at the
  coordinate but its content hash differs, the case where no message exists at
  the coordinate, and the case where the message has been deleted and the
  responder no longer retains a content digest for it. The responder MUST NOT
  distinguish these sub-cases on the wire.
- `declined`: the responder chooses not to answer this individual query. The
  responder MAY return `declined` for any subset of queries for any
  implementation-defined reason, including privacy, rate, or policy.
  `declined` is not an error; the response is still HTTP `200` with `code` `0`
  and the other queries in the same response keep their own `yes`/`no`/`declined`
  answers.

`thread` and `seq` in each result MUST equal the corresponding request query
exactly, so the requester can correlate results by position and value without
assuming array order preservation across intermediaries.

A `no` or `declined` answer MUST NOT be interpreted as evidence that the
message does not exist, that the content is wrong, or that the relationship has
changed. A `yes` answer asserts only that the responder published the supplied
content digest at the supplied coordinate at some time; it does not assert that
the message is currently visible, undeleted, or still served.

## 5. Error handling

The operation uses the common
[error registry](./errors.md). In addition to the transport errors of Section 2,
the following apply:

| HTTP | code | Condition |
| ---: | ---: | --- |
| `400` | `50007` `FEDERATION_MALFORMED` | The request body is not a closed `MessageProvenanceRequest`, `queries` is empty or longer than 64, a `(thread, seq)` pair is duplicated, or any field has an invalid type or shape. |
| `200` | `50031` `FEDERATION_PROVENANCE_DECLINED` | The responder declines the entire batch. The response is HTTP `200` with this non-zero `code` and no `data.results`; the requester MUST NOT treat it as a transport or peer-lifecycle event. Use this when policy refuses every query in the request at once (for example an unconfigured or privacy-collapsed responder). Per-query refusal that keeps the batch HTTP `200`/`code` `0` uses the individual `known: "declined"` result instead. |
| `503` | `10999` `INTERNAL` | The responder is temporarily unable to answer. Retain recognition; retry with backoff. |

The operation defines no fatal `409` code and no quota code. A responder MAY
throttle the operation using transport-level `503`. Refusal is expressed in one
of two mutually exclusive ways: a per-query `known: "declined"` result inside
an otherwise successful HTTP `200`/`code` `0` response, or a single
`50031 FEDERATION_PROVENANCE_DECLINED` for the whole batch with no result array.
The responder MUST NOT mix the two in one response.

## 6. Answer policy is implementation-defined

The protocol specifies only the wire contract and the three answer states. It
does not constrain when a responder returns `yes`, `no`, or `declined` beyond
the following normative rules:

- The responder MUST return `yes` only when it has retained a content digest
  for `(thread, seq)` that equals the supplied `payloadDigest`.
- The responder MUST NOT return `yes` for a coordinate at which it never
  published, or for a content digest it never retained for that coordinate.
- Beyond these two honesty rules, the choice among `yes`, `no`, and `declined`
  is an implementation decision. A responder MAY return `declined` for every
  query, for all queries from a given peer, for a content type, or at random,
  without violating this protocol. A responder MAY retain or discard content
  digests after deletion under its own retention policy, in which case it
  returns `no` for deleted messages whose digest is no longer retained.

A responder that returns `no` to avoid disclosing a `yes`, and a responder that
returns `declined` to avoid disclosing either, both conform. The protocol does
not require the three states to be indistinguishable to a passive observer; an
implementation that needs indistinguishability for a given query MUST collapse
the unwanted states itself before responding, and the protocol permits that.

## 7. Relationship to other operations

Answers from this operation MUST NOT be used to advance, invalidate, or
revalidate any cursor, relationship, or recognition fact. It is not a substitute for
[Message Query](./message-feed.md) authorization: a `yes` does not authorize
the requester to receive the message, and a `no` does not revoke an existing
authorization.

The `payloadDigest` value MUST be the lower-case hexadecimal SHA-256 digest of the UTF-8 JCS serialization of the following payload object:

```text
JCS({
  content: JSON.parse(content),
  assets: assets sorted by digest,
  quoteDigest?: quoted message payloadDigest,
})
```

`content` MUST be the parsed wire content object. `assets` MUST always be present, including an empty array, and MUST contain the message's complete `{ digest, bytes }` descriptors sorted by ascending digest in ASCII order. `quoteDigest` MUST be present exactly when the message carries it and MUST be omitted otherwise. An absent quoted-message digest MUST NOT be represented by `null`.

The payload object excludes coordinates, timestamps, author fields, namespace identifiers, `contentType`, and the hop-local `quoteTarget`. It is stable across re-publication when the logical payload is unchanged. It is not an HTTP `Content-Digest`.
