# Active Roadmap

This directory contains only work that is still actionable. Completed plans and
superseded implementation sketches are removed once their durable conclusions
have been incorporated into design, API, operations, or platform documentation.

## Current work

- [Android call follow-ups](./android-calls-followup.md): device-only reliability
  and release verification that cannot be established from unit tests.
- [Protocol production readiness](./protocol-plan.md): the small set of backend
  hardening tasks that remains after the protocol-stack rollout.

## Maintenance rule

A roadmap item should describe an uncompleted outcome, its acceptance evidence,
and the source area involved. Do not retain completed implementation narratives
here; Git history is the implementation record. Move stable behavioral rules to
the appropriate document under `docs/` before removing a completed plan.

The July 2026 roadmap cleanup and its disposition decisions are recorded in
[the roadmap archive note](../archive/2026-07-roadmap-cleanup.md).
