# SOMS Federation Implementation Documentation

This directory describes how SOMS implements the Simple Open Chat Federation
Protocol, including implementation audits and historical design records. The
specification for independent implementations is published as a first-class
artifact under [`spec/`](../../spec/). Implementation details here cannot
override the normative wire contract.

## Sources of truth

When documents disagree, use this order to determine the behavior of a SOMS node:

1. the [Federation Protocol v1 specification](../../spec/v1/README.md);
2. routing, validation, and processing code in `src/federation/`;
3. behavior verified by `test/federation*.e2e-spec.ts` two-node tests;
4. the code-and-test snapshot in [the implementation baseline](./protocol-baseline.md).

The specification defines what a node must do. The remaining sources establish
what SOMS currently does. A conflict must be fixed in the implementation or
introduced through an explicit new URL major; incidental implementation behavior
must not be written back into v1 as a replacement contract.

## Document map

| Category | Purpose | Document |
| --- | --- | --- |
| Baseline | Audited snapshot of the SOMS implementation, not an independent protocol promise | [Implementation baseline](./protocol-baseline.md) |
| API closure audit | Producer, consumer, request, response, recovery, and test closure by endpoint | [API closure audit](./api-closure-audit.md) |
| Design history | Implemented or superseded internal designs | [Bounded in-memory message feed](./memory-message-feed.md), [per-peer state feed](./per-peer-state-feed-design.md) |
| Overview | Current protocol and deployment overview | [Federation overview](../overview/federation-protocol.md) |
| API reference | Current SOMS S2S endpoint summary | [S2S API reference](../api/federation-s2s-api.md) |
| Specification | Normative v1 wire contract for independent implementers | [Federation v1](../../spec/v1/README.md) |

## Documentation rules

- Current documentation must name current endpoints directly; readers should not
  have to mentally translate retired routes.
- Normative documents must not depend on NestJS services, database tables, or
  frontend state to define wire behavior.
- Build status, tests, and internal implementation detail belong in implementation
  documents, not normative text.
- JSON Schema, the HTTP manifest, positive/negative vectors, fixed HTTP Message
  Signature vectors, and the offline conformance CLI ship with the normative text.
  They are not part of runtime negotiation.
- Fix implementation deviations against the published specification. A necessary
  wire-contract break requires a new URL major.
- Mark an API `CLOSED` only when its request, response, error, recovery, producer,
  consumer, and regression evidence are all present.

## Machine-readable release artifacts

The [v1 schema package](../../spec/v1/schema/README.md) contains the complete JSON
Schema set, HTTP manifest, positive and negative vectors, and fixed signature
vectors. Run `npm run federation:conformance` to validate the release package or
third-party JSON offline. These artifacts ship with the ten normative documents;
they neither restore retired endpoints nor change the v1 wire contract.
