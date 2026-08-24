# SOMFP Security Policy

## Supported versions

The not-yet-published `v1.0.0-rc.0` accepts protocol security corrections. A release candidate may include an incompatible security fix; the protocol must not retain a confirmed vulnerability merely to preserve RC compatibility.

## Reporting

Report ordinary security issues through a GitHub Issue. For directly exploitable identity impersonation, signature bypass, replay, or authorization disclosure, reporters should use GitHub private vulnerability reporting to avoid publishing attack details first. Until that feature is enabled for the repository, this file states the limitation but does not require reporters to switch to email or another platform.

Use GitHub Issues and Pull Requests for non-sensitive protocol issues and changes.

## Response principles

Maintainers should acknowledge a report, distinguish protocol defects from implementation defects, and coordinate affected implementations when necessary. A protocol fix must update the normative text, Schema, vectors, conformance checks, and release metadata together. An implementation fix cannot silently alter the wire contract.
