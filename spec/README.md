# Simple Open Messaging Federation Protocol Specification

This directory publishes the **Simple Open Messaging Federation Protocol** (SOMFP) for independent implementers. The normative text defines only the observable, interoperable wire contract between nodes. SOMS is the reference implementation; its implementation audits, internal design, and operations documentation are outside this release package and cannot override this specification.

See the [changelog](./CHANGELOG.md) for versioned draft changes and compatibility impact.

## Directory layout

```text
spec/
  README.md                   Release rules and version index
  RELEASE.json                Machine-readable version and release status
  CHANGELOG.md                Versioned changes and compatibility notes
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
    profiles.md               Public and exact profile lookup
    message-feed.md           Per-thread message query and skip-mode rules
    message-tombstone-feed.md Authoritative per-thread deletion query
    message-provenance.md      Batched direct-publisher payload attestation
    message.md                Message content-type overview and entry point
    message/                  Message envelope and content-type specifications
    resources.md              Media and forward bundles
    calls.md                  WebRTC, call state machine, and TURN boundary
    errors.md                 Stable error codes and caller actions
    schema/                   JSON Schema, HTTP manifest, and conformance vectors
```

The core protocol and its referenced subject specifications jointly define v1. The machine-readable package bearing the same version supports automated validation. If normative text conflicts with a Schema, test vector, or tool, the normative text prevails and the other artifact should be corrected in the same review revision.

Protocol changes and releases follow [Governance](./GOVERNANCE.md). Security issues follow the [Security Policy](./SECURITY.md). `RELEASE.json` provides version metadata to release tools but does not alter the normative text.

## Independent validation

This specification package contains protocol text, schemas, and vectors, not
an npm project. The accompanying SOMFP offline validator **1.0.0-draft.1** is a
separate tool distribution with its own dependency lock and regression tests.
It accepts the copied specification directory through `--spec`; neither package
requires a SOMS checkout or a database.

See [conformance](./v1/CONFORMANCE.md#independent-validation) for reproducible
installation and validation commands. The tool is a non-normative validation
artifact, not a runtime conformance certification.

## Release status

- `DRAFT`: the protocol scope or model may still change and should not be treated as a stable interoperability target.
  The current draft is in **Final Review**: the intended protocol scope is settled for closeout review. This is a maturity qualifier within `DRAFT`, not a release candidate, a frozen contract, or a conformance certification. Review may still identify security, interoperability, or specification gaps requiring explicit corrections.
- `RELEASE CANDIDATE`: the model and mandatory features are closed. Editorial clarifications and consistency corrections are allowed. Protocol gaps found before freezing may still be fixed, but wire-level changes must be identified in the reviewable release history.
- `FINAL`: the current major version's wire contract is frozen. Incompatible changes require a new URL major version.
- `SUPERSEDED`: a later major version has replaced this one; it remains available for compatible implementations and historical reference.

The current working package is [Simple Open Messaging Federation Protocol v1.0.0-draft.1 — Draft, Final Review](./v1/README.md). Every implementation claiming compatibility, including SOMS, must demonstrate conformance through tests. Implementation code, implementation-specific reviews, JSON Schema, and examples cannot independently alter the meaning of the normative text.

The conformant discovery identifiers are `/.well-known/somfp` and `_somfp._tcp`. No alternative discovery identifier belongs to the SOMFP v1 surface.
