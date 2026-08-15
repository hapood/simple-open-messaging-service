# SOCFP v1 Conformance

An implementation may claim `SOCFP v1 conformant` and publish `1` in discovery `protocolVersions` only if it fully supports every mandatory behavior in this release package. v1 defines neither partial conformance nor per-chapter negotiation.

## Mandatory specification modules

| Module | Dependencies | v1 requirement |
| --- | --- | --- |
| Core Protocol | None | Mandatory |
| Transport and Security | Core | Mandatory |
| Peer Recognition | Core, Transport | Mandatory |
| State Feed | Core, Recognition | Mandatory |
| Message Feed and Query | Core, Recognition | Mandatory |
| Message Tombstone Feed and Query | Core, Message | Mandatory |
| Message | Core | Mandatory, including every v1 content type |
| Resources | Core, Message | Mandatory |
| Call Signaling | Core, Transport, Message | Mandatory |
| Stable Error Registry | Every operation | Mandatory |

JSON Schema, the HTTP manifest, and test vectors are non-normative validation artifacts, but a formal release must not ship with a known conflict between those artifacts and the normative text. Passing these artifacts does not by itself prove compliance with the timing, security, authorization, and durable-state requirements in the normative text.

## Independent validation

Run this command from the repository root:

```bash
npm run federation:conformance
```

Validate third-party JSON with:

```bash
npm run federation:conformance -- \
  --schema urn:socfp:v1:call \
  --file ./call.json
```

The CLI reads only the `spec/v1` release package and does not import the SOMS implementation under `src/`. Each implementation maintains its own route, business-code, and state-machine tests; those tests cannot replace independent validation of this release package.
