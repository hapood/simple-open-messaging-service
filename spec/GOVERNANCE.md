# SOMFP Governance

This repository maintains the Simple Open Messaging Federation Protocol (SOMFP), but the protocol is independent of any single implementation. SOMS is the reference implementation and has no special authority to change the meaning of the specification.

## Proposing changes

Protocol issues and changes are accepted through this repository's GitHub Issues and Pull Requests. Contributors need no standards-body application, registration form, or additional process document; a clear description of the problem and proposed change is sufficient. In each Pull Request, maintainers review compatibility, security impact, and whether normative text and tests must change together. Implementation behavior alone does not constitute a protocol change.

Editorial corrections may be merged within the same release candidate. Any addition, removal, or change to observable wire behavior requires a new release candidate and must be identified in the reviewable Pull Request and release notes. After `FINAL`, incompatible changes require a new major URL version.

## Decisions and releases

Maintainers decide changes and releases through the reviewable history of GitHub Pull Requests. Release candidates are maintained to the quality level of a freezable protocol but are not automatically promoted to `FINAL`. A release keeps the following artifacts at the same version:

- normative text and its status;
- JSON Schema, HTTP manifest, and test vectors;
- the conformance tool version or reproducible instructions for running it.

`spec/` MUST be independently distributable and include, at minimum, version metadata, a license, a specification entry point, machine-readable artifacts, and validation instructions. A recipient must not need to read SOMS source code to interpret the wire contract.

The release package is the smallest unit with a release status. Ordinary chapters do not have independent maturity levels. An extension specification may have its own version, status, dependencies, and conformance requirements only if it can be implemented and tested independently.

## Implementation neutrality

Normative text may constrain only behavior observable by a peer. SOMS-specific database, configuration, deployment, client, and migration policy belongs in `docs/`. The reference implementation may provide compatibility endpoints outside the protocol, but it must not publish them as negotiated SOMFP v1 capabilities or conformance requirements.

## License and security

The specification text and validation artifacts are distributed under the [MIT License](./LICENSE) included in the release package. Security issues follow the [Security Policy](./SECURITY.md).
