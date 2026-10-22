# Message Provenance — Implementation Strategy

This document describes SOMS, not an extension of the
[Message Provenance Query](../../spec/v1/message-provenance.md) contract. The
protocol defines the wire states and their meaning; implementation behavior
cannot override them.

## Payload digest

`Message.payloadDigest` stores the SHA-256 digest computed by
[`payloadDigest`](../../src/federation/canonical-json.ts). The input is the JCS
serialization of an object containing parsed wire `content`, complete asset
descriptors sorted by digest, and `quoteDigest` when present. It is not the old
content-only digest, not a hash of local storage JSON, and not the HTTP
`Content-Digest`.

[`wirePayloadDigest`](../../src/federation/federated-message-content.ts)
projects stored content to its wire representation before hashing. Coordinates,
timestamps, author references, namespaces, and `quoteTarget` are excluded from
the payload object. The nested quoted-message digest remains part of the
payload when present.

## Refusal policy

[`FederationMessageProvenanceService`](../../src/federation/federation-message-provenance.service.ts)
provides two protected policy hooks:

- `shouldDeclineBatch()` causes a whole-batch `50031
  FEDERATION_PROVENANCE_DECLINED` business result, HTTP 200, without results.
- `shouldDeclineQuery(q)` returns the individual `known: 'declined'` result
  inside an otherwise successful batch.

Both default to false. Whole-batch refusal is checked first, so the two refusal
representations cannot be mixed. Default answers use retained digests rather
than a remote read or a profile lookup.

## Current lookup and identity-binding scope

The service selects candidates by retained `(payloadDigest, seq)` and then
checks the local thread. For GROUP it checks the group account; for P2P it
checks retained `RelationshipPair` endpoints, including a local namespace-0
source endpoint. `threadMatches` is private; it is not an overridable public
policy hook.

Ordinary federation signature authentication remains required. The current
service's `query` input does not carry the authenticated peer context, and this
implementation scope deliberately does not add a requester-to-publication
identity-binding check. This is separate from disabling transport authentication.

The retained lookup is not a conformance proof of exact direct-publisher
identity: equal account strings under distinct peer identities and publication
history still matter to the protocol's assertion. Do not treat a successful
same-product provenance test as proof of that stronger property. This limitation
is accepted for the current implementation scope, not a redefinition of the
independent wire contract.

## Local materialization state

`MessageLocalState` has `STUB`, `FAILED`, `READY`, and `CONFIRMED` values.
`CONFIRMED` is local integrity/materialization state, not another provenance
wire result or an authorization grant. Local authoring and incoming/receipt
paths choose and advance it under their own validation rules. A successful
receipt comparison must use the complete payload digest, including assets and
any quoted-message digest, rather than content alone.

The provenance response remains `yes`, `no`, or `declined`. A retained digest
match is necessary for `yes`; neither a local enum value nor cached relationship
state can prove that a message was published at an unrelated coordinate.

## Deletion and retention

The lookup reads retained `Message.payloadDigest` directly. Absence of a retained
matching row yields `no`; a null digest cannot yield `yes`. This is distinct from
promising that every deleted row is immediately removed or that every deletion
must return `no`. The protocol permits retaining historical digests, and the
answer must not imply current message visibility or permission to retrieve it.
