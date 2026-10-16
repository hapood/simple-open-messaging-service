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

These changes do not decide namespace-binding status fields or the absent-target
quote-digest policy. The draft wire major remains `1`; earlier working shapes
are not compatibility aliases.

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
