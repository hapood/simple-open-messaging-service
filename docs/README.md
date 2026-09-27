# Documentation

The federation wire contract lives separately under [`spec/`](../spec/README.md).
Documents in this directory describe the SOMS product, implementation, operation,
and client behavior.

## Start here

- [Local development](./development/local-development.md)
- [NAS deployment](./deployment/nas.md)
- [Architecture](./overview/architecture.md)
- [Database model](./overview/database.md)
- [Client and administration API](./api/api.md)
- [Web browser E2E test plan](./development/browser-e2e-test-plan.md)
- [Android E2E test plan](./development/android-e2e-test-plan.md)
- [Cross-platform AI E2E runner](./development/cross-platform-ai-e2e.md)
- [Browser E2E reusable tools](./development/browser-e2e-tools.md)

## Design

- [Business mutation SQL pattern](./design/business-mutation-sql-pattern.md)

- [Database concurrency and locking](./design/database-concurrency-and-locking.md)
- [Local call history](./design/local-call-history.md)
- [Quota enforcement](./design/quota-enforcement.md)

- [Consumer UI guidelines](./design/consumer-ui-guidelines.md)
- [Client message history synchronization](./design/client-message-history-sync.md)
- [Canonical Group Meta and asymmetric mirrors](./design/canonical-group-meta.md)
- [Group announcement](./design/group-announcement.md)
- [Durable task scheduling](./design/durable-task-scheduling.md)
- [Task responsibilities and business locks](./design/durable-task-responsibilities-and-locks.md)
- [Message deletion](./design/message-deletion.md)
- [Message inline entities](./design/message-entities.md)
- [Federation consistency stress testing](./design/federation-consistency-stress-testing.md)
- [Federation P2P observed-fact oracle](./design/federation-p2p-consistency-state-machine.md)

## Platform

- [Android calls](./platform/android/calls.md)
- [Android native composer](./platform/android/native-composer.md)

## Operations

- [Authentication rate limiting](./operations/rate-limiting.md)
- [Business and task execution measurement](./operations/execution-measurement.md)

Completed plans and superseded implementation notes are not retained here. Git
history remains available when implementation-era context is needed.

- [System messages](design/system-messages.md): reserved sender, event-specific content, participant profiles, and departure boundaries.
