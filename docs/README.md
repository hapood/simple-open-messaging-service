# Documentation

The federation wire contract lives separately under [`spec/`](../spec/README.md).
Documents in this directory describe the SOMS product, implementation, operation,
and client behavior.

## Start here

- [Local development](./development/local-development.md)
- [Repository conventions](../AGENTS.md)
- [Deployment](./deployment/deployment.md)
- [Building the Docker image](./development/building-the-image.md)
- [Architecture](./overview/architecture.md)
- [Database model](./overview/database.md)
- [Client and administration API](./api/api.md)
- [Web browser E2E test plan](./development/browser-e2e-test-plan.md)
- [Android E2E test plan](./development/android-e2e-test-plan.md)
- [Cross-platform AI E2E runner](./development/cross-platform-ai-e2e.md)
- [Browser E2E reusable tools](./development/browser-e2e-tools.md)
- [Federation implementation scope and acceptance](./development/federation-implementation-handoff.md)

## Federation Specification

- [Specification index](../spec/README.md)
- [SOMFP v1](../spec/v1/README.md)
- [Schemas and conformance](../spec/v1/schema/README.md)
- [Federation HTTP surface](../spec/v1/protocol.md#3-federation-v1-http-surface)
- [Protocol security](../spec/SECURITY.md)
- [Protocol governance](../spec/GOVERNANCE.md)

## Design

- [Administrator access management](./design/admin-access.md)
- [Administrator account security](./design/admin-account-security.md)
- [Business mutation SQL pattern](./design/business-mutation-sql-pattern.md)
- [Provider dependency cleanup](./design/provider-dependency-cleanup.md)

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
- [Profile Namespace Feed](./design/profile-namespace-feed.md)

## Platform

- [Tauri workspace](../src-tauri/README.md)
- [Android calls](./platform/android/calls.md)
- [Android native composer](./platform/android/native-composer.md)

## Operations

- [Authentication rate limiting](./operations/rate-limiting.md)
- [Business and task execution measurement](./operations/execution-measurement.md)

Design records, migration plans, and E2E handoffs have different scopes. A historical or proposed document is not evidence of current implementation or completed testing. Retained superseded records must state that status and point to the current contract; Git history preserves earlier revisions.

- [System messages](design/system-messages.md): reserved sender, event-specific content, participant profiles, and departure boundaries.
