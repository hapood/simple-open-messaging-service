# Federation Implementation Scope

## Status and acceptance

The project is unpublished. The independent protocol package is **DRAFT — Final
Review**, `1.0.0-draft.0`, wire major 1. This is not a release freeze or a claim
of complete protocol conformance. Git history records implementation changes;
this document describes the current scope, not a changelog.

Unrelated automated suites remain paused at the operator's request. The operator
subsequently authorized targeted root-rotation validation: 40 backend unit tests,
9 admin client tests, and 20 PostgreSQL E2E tests passed. This scoped execution
does not lift the pause for other work or imply release acceptance. The current Forward
snapshot and shared-child rules have static TypeScript checks but have not been
runtime-tested. Earlier successful runs do not validate these revisions.
Browser end-to-end, Android/native devices, WebRTC, deployment, and final release
acceptance remain with the operator. The ordering behind an immediate mirror
leave/rejoin failure has not been established; successful reruns do not prove
all interleavings safe.

## Identity and profiles

- The protocol recommends (SHOULD) predecessor possession checking; our local
  root-rotation approval policy requires a fresh sealed challenge under the review's
  predecessor root. The challenge runs outside database row locks; approval
  revalidates the captured review and current pin before committing. A failed
  challenge or concurrent binding change cannot authorize a successor. The
  separate admin check endpoint and its client controls have been removed;
  approval automatically performs the proof. The federation sealed-challenge
  service remains available. Targeted unit and PostgreSQL-backed concurrency
  tests passed, including review changes during challenge and pin revalidation.
- An approved peer root rotation preserves the existing namespace id and the
  retained peer-assigned namespace. The approval updates the root binding and
  records the Profile Namespace Feed change in the same transaction; it does
  not rewrite message, member, or profile references. The rotating server's
  own key lifecycle is separate and announces its binding change at namespace
  `0`. Expanded root-rotation regression tests passed, including real dual-node
  approval-time challenge, stable namespace disclosure, and binding-feed updates.
- Root/domain approval preserves existing peer acceptance without scheduling
  a new reciprocal handshake. Pending domain reviews do not erase acceptance
  under the original binding. Approval installs the validated successor
  certificate set atomically with the binding, review decision, reachability
  update, and feed changes. Successful verification makes an already accepted,
  locally prepared peer available, but does not create missing acceptance or
  revive a halted peer. An immediate Health can authenticate using the installed
  certificates without discovery. PostgreSQL fault-injection tests verify full
  rollback on certificate insertion and final review-write failure. The
  [alignment plan](./federation-contract-alignment-plan.md) records validation
  scope and remaining boundary cases.
- Messages, mentions, profiles, receipts, and client state use exact namespace
  coordinates. Binding lifecycle is local state, not a wire field.
- Exact profile revisions are immutable. Identical direct/relayed copies may be
  deduplicated; conflicting content is rejected. New revisions, current-revision
  pointers, and namespace binding refresh do not overwrite an exact snapshot.
- An authenticated local caller receives `READY` for an exact profile cache hit
  without a per-caller disclosure check, including after relationship revocation
  or without a relationship. New resolution on a cache miss requires
  authorization; a cache-only miss returns `NOT_FOUND` without fetching.
  This does not grant Group Meta page access or change S2S disclosure rules.
- Provenance lookup retains federation signature authentication but does not
  bind requester identity to the original publication recipient in this scope.
  Smoke checks cannot establish that stronger property.

See [profile resolution](../design/thread-state.md#exact-profile-resolution),
[provenance scope](../design/message-provenance.md#current-lookup-and-identity-binding-scope),
and [remaining namespace cleanup](../design/federation-domain-namespace-cleanup-todo.md).

## Forward bundles

- Storage keys are bigint; public bundle references are SHA-256 content digests.
- DIRECT retains a complete existing FORWARD bundle without adding depth;
  HISTORY adds a wrapper.
- Inner messages contain frozen display profiles, not author identity objects.
  Display names contain 1–31 Unicode code points. Equal names or avatars do not
  identify a shared author. Ordinary outer message authors and CONTACT_CARD
  subject identities remain separate.
- Dependencies form a DAG with shared children. Closure bodies and stored edges
  are deduplicated, but every reference contributes to the digest input and
  expanded message count. Local limits are 500 expanded messages and depth 3;
  depth follows the longest path. Assets are deduplicated by digest.
- Outer message bindings authorize closure and media retrieval. Browser and
  desktop/Android WebViews share the detail renderer; Rust transports API
  responses and media without a separate bundle-author model.
- Author-bearing stored bundles are unsupported. Unknown snapshot fields are
  rejected rather than stripped and republished under the prior digest. No
  database/cache reset or data rewrite is implied. There are no compatibility
  aliases or cache-version migrations.

See [the API](../api/api.md#message-api) and
[database model](../overview/database.md). The unpublished database baseline and
Drizzle schema describe the same storage model.

## Membership and client lifecycle

Mirror departure is intent-owned and independent of Group Meta. Renderer updates
and Meta cancellation consume durable thread commits. Departure preserves cached
history while revoking in-flight membership-dependent work; reopening does not
revive a revoked token.

See [Group Meta](../design/canonical-group-meta.md) and
[thread state](../design/thread-state.md).

## Validation resources

The specification contains text, schemas, and vectors, not an npm project.
The [offline validator](../../tools/federation-conformance/README.md) is a separate
package with an explicit `--spec` argument. Offline validation does not certify
runtime authorization, concurrency, device behavior, or release readiness.
