# Federation v1 Machine-readable Release Package

Status: `RELEASE CANDIDATE`

Release: `v1.0.0-rc.0`

This directory ships with the v1 normative text as a non-normative validation resource and uses JSON Schema Draft 2020-12. The normative text defines transaction, permission, signature, cursor, and state-machine semantics. The schemas define mechanically checkable JSON shapes. If they conflict, the normative text prevails and the release package must be corrected.

## Files

- `common.schema.json`: shared Federation types for identity, time, cursors, digests, and addresses.
- `discovery.schema.json`: cross-version bootstrap and key discovery at `/.well-known/socfp`.
- `identity.schema.json`: closed JSON shapes for Recognize, Healthy, and feed-head hints.
- `state-feed.schema.json`: complete pages and all six event bodies.
- `message-feed.schema.json`: message index feed pages and `thread + messageEndSeq` items.
- `message-tombstone-feed.schema.json`: tombstone index feed pages and `thread + tombstoneEndSeq` items.
- `message-query.schema.json` and `message-tombstone-query.schema.json`: messages and authoritative deletion facts returned by thread queries.
- `message-content.schema.json`: all parsed core message-content variants selected by `contentType`.
- `call.schema.json`: every call lifecycle and signal operation with its closed conditional field set.
- `profile.schema.json`, `forward-bundle.schema.json`, and `error.schema.json`: the remaining JSON operations.
- `http-parameters.schema.json`: normalized query and path parameter objects.

JSON Schema checks closed shapes, dependencies, and canonical decimal forms. The numeric upper bound of a `PositiveSafeInteger` query string and cross-field numeric relations such as `through >= after` MUST be checked semantically after parsing into an exact integer. Implementations MUST NOT first convert such values to a potentially lossy floating-point number. A semantic failure returns `400 FEDERATION_MALFORMED` for the relevant operation.

- `http-manifest.json`: the complete operation surface and its authentication, status, media-type, and schema mappings.
- `vectors/valid.json` and `vectors/invalid.json`: positive and negative JSON vectors.
- `vectors/http-message-signature.json`: a general fixed Ed25519 HTTP Message Signature vector.
- `vectors/call-http-message-signature.json`: a completely signed `/s2s/v1/call` vector.
- `vectors/feed-query-semantics.json`: structured state-machine assertions for state-first processing, fixed `through`, relationship restoration, deferred queries, and unknown-thread recovery.

## Validation

Run from the repository root:

```bash
npm run federation:conformance
```

The command compiles every schema; validates positive and negative vectors; verifies secondary parsing of message `content`; checks strictly increasing version arrays; verifies the complete HTTP manifest; compares the normative error registry exactly with the error schema; and verifies fixed signature vectors. The CLI does not import implementation constants or services from SOMS `src/`. Repository unit tests additionally compare the manifest, schema enums, normative text, and Nest route metadata to prevent drift between release artifacts and the reference implementation.

Third-party implementations can validate their own JSON:

```bash
npm run federation:conformance -- \
  --schema urn:socfp:v1:call \
  --file ./call-frame.json
```

The CLI is an offline conformance tool. It does not participate in runtime negotiation and does not require test private keys to be exposed by production nodes.
