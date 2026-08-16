# Protocol Production Readiness

The original protocol-stack rollout is complete. Current HTTP behavior is defined
by [the API reference](../api/api.md), generated OpenAPI, DTOs, and tests. This
file tracks only production hardening that remains actionable.

## Authentication abuse response

The server has in-process IP/account controls, trusted-proxy handling, graduated
bans, and endpoint-specific throttles. Multi-instance shared rate-limit storage is
not planned because SOMS is intentionally single-instance.

Remaining outcomes:

- review thresholds and ban durations against account-lockout denial-of-service;
- add structured events/metrics for throttles and bans without logging secrets;
- decide whether escalating delay or account-owner notification is warranted;
- audit authenticated mutation endpoints and add narrowly scoped policies where
  resource cost or abuse risk justifies them.

Acceptance requires unit tests for boundary/reset behavior and PostgreSQL-backed
coverage for the externally visible error contract.

Relevant code: `src/rate-limit/`, `src/auth/throttle.guard.ts`, and the auth
controllers.

## Upload production limits

Resumable uploads, quotas, staged publication, cleanup, and federation resume are
implemented. Remaining work is deployment-policy work rather than basic upload
support:

- document and verify concurrency and temporary-disk limits under sustained
  uploads;
- decide whether an object-storage backend is needed for supported deployment
  sizes; do not add one solely for theoretical horizontal scaling;
- retain tests proving abandoned temporary data and unreferenced media are
  reclaimed.

Relevant code: `src/upload/`, `test/resumable-upload.e2e-spec.ts`, and
`test/media-gc.e2e-spec.ts`.

## Completion rule

Remove an item when its behavior and operational constraints are documented in
the maintained API or operations documentation and covered by proportionate
tests. Do not append completed implementation history here.
