# Message Provenance — Implementation Strategy

This document records the implementation choices for the
[Message Provenance Query](../../spec/v1/message-provenance.md) operation. The
protocol spec defines only the wire contract and the answer states; this file
records how this implementation produces those states and how the local
`CONFIRMED` state relates to them. The two documents are deliberately
decoupled: the protocol links to nothing here, and a different implementation
of the same protocol is free to make different choices.

## Overview

`POST /s2s/v1/message-provenance` lets a recognized peer ask this server
whether it published a message at `(thread, seq)` whose canonical `content`
hashes to a supplied `contentDigest`. The server answers per query with
`yes` / `no` / `declined`, or declines the whole batch with the
`FEDERATION_PROVENANCE_DECLINED` error code.

The protocol defines two mutually exclusive refusal forms:

1. **Per-query `declined`** — the batch still returns HTTP `200` with `code`
   `0` and a `results` array; the refused query is `known: "declined"` while
   the other queries keep their own answers.
2. **Whole-batch `declined`** — the response is HTTP `200` with
   `code` `50031 FEDERATION_PROVENANCE_DECLINED` and **no** `results` array;
   every query in the batch is refused at once.

This implementation supports both, exposed as overridable policy hooks so a
deployer can adopt a privacy strategy without rewriting the lookup logic.

## Refusal policy hooks

`FederationMessageProvenanceService` exposes two `protected` hooks:

- `shouldDeclineBatch(): boolean` — when `true`, `query()` throws
  `FEDERATION_PROVENANCE_DECLINED` before answering any query. Use this when
  policy refuses provenance wholesale (for example an unconfigured responder,
  or a privacy-collapsed deployment that must not disclose any `yes`/`no`).
- `shouldDeclineQuery(q): boolean` — when `true` for a single query,
  `queryOne()` answers `known: "declined"` for that query while the rest of
  the batch is still answered. Use this for per-thread, per-content-type, or
  per-peer rate refusals.

Both default to `false`, so the out-of-the-box behavior is honest `yes`/`no`
from the retained digests. A deployer overrides either hook (typically by
subclassing the service in a deployment module) to install a refusal policy.
The two hooks are independent: a deployer may decline the batch, decline
selected queries, or neither, but the protocol forbids mixing whole-batch
`declined` with per-query answers in one response, and the service enforces
that by checking `shouldDeclineBatch()` first and returning before any
per-query work.

## Answer production

`queryOne()` looks up candidate messages by the indexed
`(contentDigest, seq)` columns, then verifies the candidate's thread resolves
to the query `ThreadAddress`:

- **GROUP thread** — the local `messageThread.groupAccount` must equal the
  wire `thread.account`.
- **P2P thread** — the local `messageThread.type` must be `P2P`. The local
  thread table does not store the peer account pair directly; the
  content-addressed `contentDigest` plus `seq` is strong evidence, and a
  deployer needing stricter P2P binding can override `threadMatches`.

A `yes` requires a retained `contentDigest` that equals the supplied value at
the supplied coordinate. A `no` covers every other case (no message, a
message with a different digest, a deleted message whose digest is no longer
retained); the wire never distinguishes these sub-cases.

## The `CONFIRMED` local state

The `MessageLocalState` enum gained a `CONFIRMED` state, ordered
`STUB | FAILED | READY | CONFIRMED`. `READY` is the visible baseline; a
message becomes `CONFIRMED` only after its content digest is independently
verified:

- **Locally created messages** are stored as `CONFIRMED` directly. The local
  author is the origin, so there is no transit step whose tampering a receipt
  would catch; the digest the author stored at creation is already the
  trusted digest. (This is the "self-originated, cannot be tampered" case.)
- **Inbound messages** (received from a peer) are stored as `READY` first.
  When the corresponding processing receipt arrives, the receipt's wire
  `content` is hashed with the same JCS canonicalization and compared to the
  `contentDigest` retained at receipt time. A match upgrades the message to
  `CONFIRMED`; a mismatch emits a warning and leaves the state at `READY`.

`READY` is **not** a provenance-attested state. A `yes` answer from the
origin server is the protocol-level attestation; `CONFIRMED` is the local
record that the origin's retained digest matched what the receipt carried.
This keeps the protocol honest: provenance answers `yes` based on what the
origin retained, not on whether a downstream peer has reached `CONFIRMED`.

## Retention and deletion

`contentDigest` is stored at message creation (local author) and at inbound
receipt (peer origin). The provenance lookup reads this column directly, so a
deleted message whose row is removed answers `no` (no retained digest). A
deployer that retains digests after deletion (for example in a separate
ledger) can answer `yes` for deleted messages; the default schema does not do
this, so deletion makes a message answer `no`.

The `contentDigest` column is nullable for rows created before the migration;
those rows answer `no` because the indexed lookup finds no matching digest.
