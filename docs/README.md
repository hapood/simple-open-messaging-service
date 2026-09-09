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

## Design

- [Local call history](./design/local-call-history.md)

- [Consumer UI guidelines](./design/consumer-ui-guidelines.md)
- [Client message history synchronization](./design/client-message-history-sync.md)
- [Canonical Group Meta and asymmetric mirrors](./design/canonical-group-meta.md)
- [Durable task scheduling](./design/durable-task-scheduling.md)
- [Message deletion](./design/message-deletion.md)
- [Message inline entities](./design/message-entities.md)
- [Federation consistency stress testing](./design/federation-consistency-stress-testing.md)
- [Federation P2P observed-fact oracle](./design/federation-p2p-consistency-state-machine.md)

## Platform

- [Android calls](./platform/android/calls.md)
- [Android native composer](./platform/android/native-composer.md)

## Operations

- [Authentication rate limiting](./operations/rate-limiting.md)

Completed plans and superseded implementation notes are not retained here. Git
history remains available when implementation-era context is needed.
