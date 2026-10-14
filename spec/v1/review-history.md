# Federation v1 pre-freeze review history

This records peer-observable changes made while the v1 specification is a release candidate. It does not introduce a wire capability or version field. Earlier candidates are not interchangeable with a revised candidate solely because both use the not-yet-frozen major 1.

## Answer correlation and generation-bound ICE

Approved as a coordinated pre-freeze Call Profile revision. Implementation and conformance verification are in progress.

Breaking changes:

- An `answer` signal requires the additional canonical UUID `payload.inReplyTo`, referring to the answered offer's `payload.signalId`. Other signal kinds forbid that field.
- Endpoint ICE payloads require a valid nonempty `usernameFragment` identifying their actual ICE generation. Federation servers continue to relay the payload string without parsing it.
- New answers must satisfy the call-bound offer reference and one-answer constraints. Accepted-ID retries retain no-op semantics; endpoints must not apply an answer to an unrelated negotiation.

Unchanged:

- `/s2s/v1/call`, authenticated call binding, caller-only offer ownership, opaque SDP/ICE relay, and existing lifecycle operations.
- Signal IDs identify logical messages, not transport attempts. No independent negotiation ID, outer ICE generation field, compatibility fallback, or partial-profile capability negotiation is added.
- A frozen/released v1 contract cannot be changed using this pre-freeze exception. Supporting external released implementations with different behavior would require a new wire major.

All supported endpoint implementations and participating servers must adopt the revised contract together. Protocol text, schema and conformance artifacts must describe the same revision; application test success alone is not conformance evidence.
