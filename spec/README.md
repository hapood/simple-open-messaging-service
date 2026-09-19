# Simple Open Messaging Federation Protocol Specification

This directory publishes the **Simple Open Messaging Federation Protocol** (SOMFP) for independent implementers. The normative text defines only the observable, interoperable wire contract between nodes. SOMS is the reference implementation; its implementation audits, internal design, and operations documentation live in [`docs/`](../docs/) and cannot override this specification.

## Directory layout

```text
spec/
  README.md                   Release rules and version index
  RELEASE.json                Machine-readable version and release status
  LICENSE                     License for standalone distribution of spec/
  GOVERNANCE.md               Change, decision, and release governance
  SECURITY.md                 Protocol security reporting and support policy
  v1/
    README.md                 v1 status and reading order
    CONFORMANCE.md            v1 conformance scope and module dependencies
    protocol.md               Core protocol
    transport-security.md     Discovery, TLS, keys, and HTTP Message Signatures
    recognition.md            Bidirectional peer recognition and identity continuity
    state-feed.md             Relationship/profile references and feed heads
    group-meta.md             Group roster, roles, and profile-reference sync
    authorized-profile.md     Authorized account and profile-revision lookup
    group-meta-profile.md   Group-projection-authorized member profile lookup
    message-author-profile.md Exact-message-authorized display profile query
    message-feed.md           Per-thread message query and skip-mode rules
    message-tombstone-feed.md Authoritative per-thread deletion query
    message.md                Message content-type overview and entry point
    message/                  Message envelope and content-type specifications
    resources.md              Profiles, media, and forward bundles
    calls.md                  WebRTC, call state machine, and TURN boundary
    errors.md                 Stable error codes and caller actions
    schema/                   JSON Schema, HTTP manifest, and conformance vectors
```

Fourteen normative documents—the core protocol and thirteen subject specifications—jointly define v1. The machine-readable package bearing the same version supports automated validation. If normative text conflicts with a Schema, test vector, or tool, the normative text prevails and the other artifact should be corrected in the same release candidate.

Protocol changes and releases follow [Governance](./GOVERNANCE.md). Security issues follow the [Security Policy](./SECURITY.md). `RELEASE.json` provides version metadata to release tools but does not alter the normative text.

## Release status

- `DRAFT`: the protocol scope or model may still change and should not be treated as a stable interoperability target.
- `RELEASE CANDIDATE`: the model and mandatory features are closed. Editorial clarifications and consistency corrections are allowed. Protocol gaps found before freezing may still be fixed, but wire-level changes must be identified in the reviewable release history.
- `FINAL`: the current major version's wire contract is frozen. Incompatible changes require a new URL major version.
- `SUPERSEDED`: a later major version has replaced this one; it remains available for compatible implementations and historical reference.

The current candidate is [Simple Open Messaging Federation Protocol v1.0.0-rc.0](./v1/README.md). Every implementation claiming compatibility, including SOMS, must demonstrate conformance through tests. Implementation code, implementation-specific reviews, JSON Schema, and examples cannot independently alter the meaning of the normative text.

The conformant discovery identifiers are `/.well-known/somfp` and `_somfp._tcp`. No alternative discovery identifier belongs to the SOMFP v1 surface.
