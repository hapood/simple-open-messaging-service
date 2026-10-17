# Federation v1 pre-freeze review history

This records peer-observable changes made before the v1 wire contract is frozen, including draft and release-candidate review. It does not introduce a wire capability or version field. Earlier working packages are not interchangeable with a revised package solely because both use the not-yet-frozen major 1.

## Final-review draft

The working package is `v1.0.0-draft.0`, status `DRAFT`, review stage `final-review`. The integer wire major remains `1`; this status change creates no wire negotiation field.

Consistency corrections align the HTTP surface with the separately specified Verify and Message Provenance operations, and align the validation artifacts with the mandatory `quoteDigest` field. The payload digest definition consistently includes parsed content, sorted asset descriptors, and the optional quoted-message digest; hashing content alone is not equivalent.

## Namespace-only subjects and group message direction

Coordinated pre-freeze corrections to the wire contract:

- Every message has a closed nested `author`: `{ ref, namespaceId }` for P2P,
  `{ account, namespaceId }` for GROUP. Top-level `authorRef`, top-level
  `namespaceId`, and author `domain` are no longer part of the envelope.
- Every Group Meta item uses `{ feedId, operation, body }`. Member upsert and
  departure bodies contain `{ account, namespaceId, role, profileRev }`;
  GROUP_PROFILE contains `{ account, namespaceId, profileRev }` with the page's
  group account; announcement remains `{ text }`. No subject domain is carried.
- Public current and exact evidence profile responses omit `domain`.
- Group origins use `includeSelf=false` in forward and reverse message queries
  to member homes and consume only those homes' own authored submissions, not
  receipts for origin-distributed copies. Submitting homes still consume their
  accepted authoritative copies from the origin with `includeSelf=true`.
- Embedded group user-mention namespace IDs always belong to the group origin's
  namespace space. Their meaning does not change when the message publisher
  changes; valid tokens are preserved across hops.

The draft wire major remains `1`; earlier working shapes are not compatibility
aliases.

## Positive reply coordinates

A coordinated pre-freeze correction removes the zero-valued `quoteTarget.seq`
placeholder. Both `seq` and `originSeq` must be positive thread sequences.
Replies retain their source-scoped coordinate and `quoteDigest` even when the
target body is not yet available or has been withdrawn. The target's existence
is not a prerequisite for accepting a valid reply. `quoteTarget` and
`quoteDigest` must appear together; ordinary messages omit both.

There is no zero-coordinate compatibility form. Bundle-local `quoteTargetId`
is a separate reference space and retains its existing absent-entry semantics.
The draft wire major remains `1`.

## Retained image filenames and contact-card root keys

Pre-freeze artifact corrections add fields omitted from the earlier closed
content schemas and examples:

- IMAGE and GALLERY image items require a nonempty `name`, retained as display
  metadata across publishers and covered by the message payload digest.
- CONTACT_CARD requires `publicKey`, the referenced home's retained Ed25519
  root public key. Later card resolution binds its possession proof to that
  key; receipt of the card itself establishes neither possession nor trust.

These fields are not optional compatibility extensions. Content schemas,
examples, and positive/negative vectors describe the same revision. The draft
wire major remains `1`.

## Acyclic forward-bundle dependencies

A pre-freeze consistency correction removes the earlier permission for self-cycles
and mutual cycles in forward closures. Bundle dependencies must form a directed
acyclic graph, consistent with the recursive content-digest definition. Consumers
must reject dependency cycles before committing a closure, even though children
are represented as a flat array.

This correction does not define whether multiple messages may reference the same
child, change the digest input formula, or introduce a common depth limit. The
draft wire major remains `1`.

## Direct-child inputs to forward-bundle digests

A pre-freeze clarification distinguishes the digest input from the response's
flat closure. Each bundle hashes its own messages and the sorted direct child
digest references extracted from those messages, not every descendant ID in the
response's `children[]`. Each reference contributes one entry without
deduplication. The root hashes the complete closure asset manifest; children hash
an empty asset array, as before.

The response still carries the full flat child closure. This clarification does
not decide whether repeated child references are accepted and does not change
that graph-validation policy in the reference implementation. The draft wire
major remains `1`.

## Display-only forward snapshots

A coordinated pre-freeze change removes the inner snapshot message's `author`
object, including its account, domain, and optional root key. Snapshots retain
only their required display profile, content, time, bundle-local ID, and optional
quote/child references. The ordinary outer message author and CONTACT_CARD
content's target address and public key are unchanged.

Removing identity fields changes the canonical body and therefore the digest.
Earlier author-bearing bundles are not a compatible wire shape and must not be
rewritten under their old digest. Display names and avatars do not identify a
shared author or grant profile/resource access. The draft wire major remains `1`.

## Forward display-name limit

The forward snapshot display-name limit is 1–31 Unicode code points, consistent
with profile responses and CONTACT_CARD snapshots. This corrects the earlier
1–30 prose limit; the existing JSON Schema and implementation limit remain 31.
A valid source display name does not need truncation when captured in a forward.
The limit counts Unicode code points, not UTF-16 code units or grapheme clusters.
The draft wire major remains `1`.

## Shared forward children and expanded counts

Multiple messages may reference the same child digest. The flat closure contains
one body per digest, while every reference contributes to the canonical direct-
child digest list. Cycle rejection remains mandatory. Depth uses the longest
reference path; message counts include each reference occurrence recursively,
not just unique stored bodies. Consumers can memoize node metrics without
materializing the expansion. Numeric resource limits remain local policy.
This resolves the shared-reference question left open by the earlier graph and
digest corrections. The draft wire major remains `1`.

## Answer correlation and generation-bound ICE

A coordinated pre-freeze Call Profile revision. This entry records the protocol change, not any implementation's completion or conformance status.

Breaking changes:

- An `answer` signal requires the additional canonical UUID `payload.inReplyTo`, referring to the answered offer's `payload.signalId`. Other signal kinds forbid that field.
- Endpoint ICE payloads require a valid nonempty `usernameFragment` identifying their actual ICE generation. Federation servers continue to relay the payload string without parsing it.
- New answers must satisfy the call-bound offer reference and one-answer constraints. Accepted-ID retries retain no-op semantics; endpoints must not apply an answer to an unrelated negotiation.

Unchanged:

- `/s2s/v1/call`, authenticated call binding, caller-only offer ownership, opaque SDP/ICE relay, and existing lifecycle operations.
- Signal IDs identify logical messages, not transport attempts. No independent negotiation ID, outer ICE generation field, compatibility fallback, or partial-profile capability negotiation is added.
- A frozen/released v1 contract cannot be changed using this pre-freeze exception. Supporting external released implementations with different behavior would require a new wire major.

All supported endpoint implementations and participating servers must adopt the revised contract together. Protocol text, schema and conformance artifacts must describe the same revision; application test success alone is not conformance evidence.
