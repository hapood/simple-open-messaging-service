# Documentation Closeout Audit

This is a temporary remediation tracker, not part of the normative protocol.
Keep it while any tracked item remains open or deferred. Once all remediation
and verification items are closed, delete this document and remove its incoming
links; retain peer-observable decisions in the specification review history.

## User-directed remediation progress

The numbers below preserve the user's 1–12 review order. A documentation
correction does not certify production interoperability or close a remaining
implementation task.

| No. | Finding | Decision and progress |
| --- | --- | --- |
| 1 | F1 message author | Documentation corrected to nested namespace-only authors; schema, examples, vectors, and shape regression checks updated |
| 2 | F2 Group Meta | Documentation corrected after checking all four operations: common `{ feedId, operation, body }`, subject identity in body, no domain; schema and vectors updated |
| 3 | F3 profile responses | Documentation and both response schemas corrected to omit domain for all three S2S profile routes |
| 4 | F4 binding status | Pending separate discussion; contract and implementation unchanged |
| 5 | F5 absent-target quote digest | Pending separate discussion; existing contract and implementation unchanged |
| 6 | F6 group receipts | Contract and implementation corrected: origin forward/reverse message queries send `includeSelf=false`; inbound routing skips non-home authors before receipt association. Federation unit suite passes; database E2E remains part of V1 |
| 7 | F7 mention space | Contract and implementation corrected: backend attention, web rendering, optimistic sends, and editor self filtering use exact group-origin namespace/account identity; required nullable viewer coordinate persists in web and Rust caches. Unit and PostgreSQL regressions pass; schema versions remain 1 without compatibility paths |
| 8 | S1 local cached-profile disclosure check | **Deferred** by user; the local check is not implemented, and this pass does not add it or approve cache sharing as policy |
| 9 | S2 provenance peer binding | **Deferred** by user; no behavior change |
| 10 | V1 executable interoperability coverage | Pending later review; package/schema checks below are not producer/consumer certification |
| 11 | V2 standalone validation | Pending later review |
| 12 | V3 whole-project test typing | Pending later review; no fixture or runtime changes in this pass |

## Conclusion and scope

The working SOMFP package is **DRAFT — Final Review**, version
`1.0.0-draft.0`, with machine-readable `status: draft` and
`reviewStage: final-review`. This describes the specification's review stage,
not implementation completion, a frozen contract, or certified interoperability.
The integer wire major remains `1`.

**Do not promote the package to a release candidate or final solely on the basis
of the checks below.** There are confirmed field-level implementation/specification
differences and unresolved protocol semantics. Existing same-product tests do
not resolve those differences.

This pass covered:

- A repository-wide local Markdown target/heading scan of the root README,
  `docs/`, and `spec/` (100 Markdown documents before adding this audit).
- Release metadata, chapter statuses, protocol reading order, normative HTTP
  surface, manifest, schemas, vectors, and validation tooling.
- Detailed source comparisons for message envelopes, Group Meta, profile and
  namespace lookup, provenance, quote handling, session policy, SSE, thread feeds,
  account/profile storage, and relationship profile publication.
- Static separation checks for implementation references inside `spec/`.

This is not a line-by-line correctness proof for every retained design/proposal,
platform adapter, deployment recipe, or E2E handoff. It does not certify live DNS,
TLS, PostgreSQL concurrency, browser rendering, or Android/WebRTC behavior. Those
require their own executable verification. Historical plans and test-run reports
remain historical evidence, not current guarantees.

## Specification / implementation boundary

`spec/` defines independently interpretable peer-observable requirements.
Implementation findings, source paths, progress, and rollout advice belong here
or in other `docs/` documents, not in normative chapters. A working implementation
is evidence of its behavior, not authority to redefine the protocol.

When a difference is found, decide explicitly whether to correct the
implementation or revise the draft. A wire revision must update normative text,
artifacts, cross-implementation tests, and pre-freeze history together. The audit
must not silently rewrite the draft to match current source.

## Corrected documentation and validation defects

| Area | Confirmed defect | Correction |
| --- | --- | --- |
| Release identity | RC labels and version coexisted with a request for final-review Draft; metadata claimed Chinese authority over English text | Root badge, package/chapter status, security/governance text, metadata, and metadata validation now agree on the English final-review draft |
| Normative inventory | The core document omitted Message, Message Provenance, and Profile Namespace Feed from its normative inventory | Added the references and the missing reading/conformance entries; removed the stale fixed document count |
| HTTP surface | The purported complete core table omitted Verify and Message Provenance; manifest and CLI omitted provenance | Restored the operations from their existing subject specifications, added provenance schemas/vectors, and check table/manifest/controller route equality |
| Digest terminology | Provenance Section 3 hashed content alone, while Section 7 defined content + assets + quote digest; HTTP digest was conflated with embedded content | Use the existing complete payload-object definition consistently; distinguish it from HTTP `Content-Digest` |
| Quote artifact | Envelope required `quoteDigest`, but the closed message schema rejected it and the immutable-field list omitted it | Aligned the schema, immutable-field list, example, vectors, and regression tests with the existing normative requirement; sentinel-policy difference remains open below |
| Health | Recognition's authentication summary said failures use error envelopes, contradicting its detailed privacy rules | Summary now follows the uniform unavailable projection and its explicit rate-limit exception |
| Protocol neutrality | Normative message text described the current client's reply UI; review history mixed in implementation progress | Removed those implementation-specific statements; completion belongs outside the specification |
| Links | Source paths, migration files, and several specification heading anchors no longer existed | Updated active references to current capabilities, SQL baseline, and headings |
| Accounts and storage | Overview still described physical User/Group tables, inline profiles, old media staging, and removed enums | Rewrote the database overview around Account, GroupAccount, Profile, current threads/feeds and inbound STUB jobs |
| Sessions | Documentation promised permanent trusted sessions and a 14-day browser-only lifetime | Documented the required sliding inactivity deadline for every client, default 30 days, and current login fields |
| Thread/API identity | Mutation inputs used domain/user IDs; thread feed and profile-demand shapes were obsolete | Updated verified client inputs to namespace-bound targets, current thread snapshots and domain-free exact demands; call initiation selects a P2P thread |
| SSE and reads | Architecture promised 25-second heartbeats, raw-response registration, a single feed, five previews, and durable read tasks | Documented Observable ownership, no idle heartbeat, separate state/thread feeds, three previews, receipts, and synchronous read commits |
| Relationships | Overview required a second PROFILE feed item after every relationship fact | Replaced with exact profile references and independent lazy resolution; no PROFILE State Feed event |
| Historical state | Completed-plan policy contradicted retained plans; old baseline paragraphs were labeled current | Clarified document roles, marked the obsolete profile cutover as historical, and labeled pre-change media baseline explicitly |

The initial documentation pass changed only validation tooling and tests, not
application behavior. The subsequent user-authorized F6 correction below changes
message-query filtering and inbound routing. No database schema change is made.

## Open release gates

### F1 — Message author wire shape (documentation corrected)

The user selected the existing namespace-only implementation shape:

```text
P2P:   author: { ref, namespaceId }
GROUP: author: { account, namespaceId }
```

The [envelope](../../spec/v1/message/envelope.md),
[schema](../../spec/v1/schema/message-query.schema.json), related chapters,
examples, and vectors now use that closed shape and reject legacy top-level
coordinates and redundant author domains. Source evidence remains the
[feed projection](../../src/federation/federation-message-feed.service.ts),
[author type](../../src/federation/federated-message-types.ts), and
[inbound validator](../../src/federation/federation-inbound-message-validator.service.ts).
Real producer/consumer coverage remains V1, not a completion claim here.

### F2 — Group Meta layout (documentation corrected)

The user selected the existing [page builder](../../src/group/meta/group-meta-page.ts)
layout. All four operations use exactly `{ feedId, operation, body }`:

- `MEMBER_UPSERT` and `MEMBER_DEPART`: `{ account, namespaceId, role, profileRev }`.
- `GROUP_PROFILE`: `{ account, namespaceId, profileRev }`, with the page's group account.
- `GROUP_ANNOUNCEMENT`: `{ text }`.

The [chapter](../../spec/v1/group-meta.md), schema, and vectors now agree.
Member identity and profile identity are consistently body-local; no item
carries a domain. No implementation restructuring was needed for this shape.

### F3 — Profile response shape (documentation corrected)

The user confirmed that the documentation lagged the implementation.
[Profiles](../../spec/v1/profiles.md), the public schema, and the exact evidence
schema now omit `domain`, matching all three routes in the
[S2S controller](../../src/federation/s2s.controller.ts). Exact request identity
comes from the authenticated publisher and path namespace/account/revision;
public lookup selects the publisher's own local account. The challenge proof
may still contain opaque caller-selected text, including a domain; that is not
a response identity field.

### F4 — Namespace binding response contains an unspecified field (blocking)

The [bindings specification](../../spec/v1/profile-namespace-feed.md#6-namespace-bindings-query)
and [closed schema](../../spec/v1/schema/profile-namespace.schema.json) contain
`domain`, `rootPublicKey`, and `profileNamespaceFeedEndId` only. The
[service](../../src/federation/profile-namespace-feed.service.ts) additionally
emits `status: ACTIVE | ARCHIVED`. The product design already relies on that
lifecycle distinction. Either specify it through an explicit draft revision or
remove it from the S2S surface and preserve the intended behavior another way;
current strict consumers cannot accept both forms.

### F5 — Absent-target quote digest policy differs (blocking)

The [envelope](../../spec/v1/message/envelope.md#5-conditional-fields) requires
`quoteDigest` exactly whenever `quoteTarget` exists, including `{ seq: 0 }`.
The [publisher](../../src/federation/federation-message-feed.service.ts) and
[inbound page application](../../src/federation/federation-inbound-message-page.service.ts)
allow an absent-target sentinel without a digest.

The artifact correction deliberately follows the existing normative rule;
it does not resolve this semantic difference. Specify whether a sentinel means
unknown original payload, retained original digest, or a distinct no-target
case. Then align live sends, re-publication, validation, digest calculation,
and positive/negative vectors.

### F6 — Origin submission-only queries (contract and implementation corrected)

User decision: in A→G→B, G does not fetch B's copy of A's message as a receipt.
G queries B only for B's own authored submissions, with `includeSelf=false` in
both forward and reverse message scans. B still queries G with `true`, so B's
own submissions receive their authoritative coordinate confirmation.
[Message Query](../../spec/v1/message-feed.md), envelope, core protocol, and
conformance text now express that asymmetric contract.

Implementation correction authorized by the user:

- The [feed service](../../src/federation/federation-message-feed.service.ts)
  already had the direction-aware filter: `MIRROR_TO_ORIGIN` with
  `includeSelf=false` selects author `profileNamespaceId = 0`, in addition to
  the own-submission/direct-source publication predicate. This excludes
  origin-distributed copies and is not merely a requester-author exclusion.
- The [forward executor](../../src/federation/federation-thread-forward-round-executor.service.ts)
  and [reverse executor](../../src/federation/federation-thread-reverse-round-executor.service.ts)
  now send `includeSelf=false` when
  `source.kind === 'GROUP' && source.localGroupAuthority`; mirror queries to
  their origin and P2P queries retain `true`.
- [Inbound routing](../../src/federation/federation-inbound-message-route.service.ts)
  no longer routes returned mirror copies to a local-origin receipt branch.
  If the source is not the group's origin, only source-local authors
  (`author.namespaceId = 0`) may proceed to active-member routing. Other
  authors, including G's own authors and third-party authors, are classified as
  malformed and skipped by the page applier, with or without origin coordinates.
  They never reach receipt association or message writes. A valid page continues
  to later items; ordinary validated cursor progress is not blocked.
- The mirror-side authoritative confirmation path and P2P receipt path remain.
  Tombstone queries and semantics are unchanged. The publisher's generic
  serialization branch was not expanded or removed; G no longer requests or
  processes its mirrored copies as receipts.

Regression tests cover forward/reverse query parameters for origin, mirror, and
P2P; origin filtering for both receiver-local and third-party authors, with and
without origin coordinates; same-account/different-namespace identities;
continuation to a valid home-authored replay without receipt side effects; and
forward empty-page cursor advancement. The full federation unit suite passes.
Database-backed multi-node verification is still tracked under V1.

### F7 — Group-origin mention namespace (contract and implementation corrected)

User decision: mention namespace IDs always use the group origin's space.
[Text entities](../../spec/v1/message/text.md#3-inline-entities) now explicitly
distinguish the immutable embedded token from the current publisher-scoped
outer `author.namespaceId`. Submission and mirror hops preserve token bytes
and meaning; consumers resolve the token through the origin's roster/bindings,
not the serving mirror's unrelated bindings.

The [message controller](../../src/controller/message.controller.ts) parses the
namespace/account pair and calls
[`GroupService.resolveActiveMember`](../../src/group/group.service.ts), which
resolves the current Group Meta roster by both coordinates and serializes the
roster namespace unchanged. This supports the documented origin-space rule.

Implementation correction authorized by the user:

- [`mentionsAccount`](../../src/message/thread-feed-head.writer.ts) now compares
  the exact namespace/account pair. The viewer's group-origin namespace comes
  from `0` for a local group or the origin's `peerAssignedLocalNamespaceId` for
  a remote group; unknown binding never becomes namespace zero.
- The client thread-feed snapshot carries required nullable
  `selfMentionNamespaceId`. It is null for P2P or unknown mapping. Missing is
  invalid, not a legacy alias for null. Backend response DTO and client types
  describe the same shape; this is a client API change, not a new S2S field.
- Web mention rendering, optimistic sends, and editor self-candidate exclusion
  all receive the viewer identity in the group origin's space. Same-account
  targets in another namespace remain other members, not self mentions.
- Web typed thread records and Rust typed SQLite thread state persist and
  restore the coordinate. Native feed decoding requires the nullable field.
  Native and web cache schema versions remain `1`; no old-record fallback,
  automatic column upgrade, or migration compatibility is added because the
  product has not been released.
- Tests cover local origin zero, remote positive mapping, null binding,
  same-account/different-namespace targets, immutable tokens, required-field
  rejection, and Rust state round trips. PostgreSQL tests verify actual mapping
  reads, client feed output, and mention selection on a mirror. Two generic
  attention regressions now use real local-group fixtures for user mentions
  rather than applying group tokens in a P2P fixture; their assertions remain.

Backend, web, and Rust verification results are recorded below. Device UI and
multi-node federation acceptance are not claimed.

### S1 — Cached exact profile reads bypass caller disclosure checks (deferred)

Deferred by the user. The local per-caller check has not been implemented.
This is not approval of shared-cache disclosure and no policy is changed here.

The old API text promised authorization before any cache read. In
[`ProfileResolutionCoordinatorService.start`](../../src/profile-resolution/profile-resolution-coordinator.service.ts),
`readCached` occurs first; a hit returns immediately. The authenticated
`{ demand, evidence: null }` wrapper calls `startCacheOnly`, which also returns
cached snapshots without a per-caller disclosure check.

The implementation is verified; whether account-wide cached display snapshots
are intentionally shareable is a policy decision requiring explicit approval.
If exact historical profile disclosure is meant to be per-user, this behavior
must change, with two-user/revocation tests on both memory and durable cache
hits. Documentation now describes the actual behavior rather than claiming an
unimplemented security property. This does not weaken the S2S disclosure rules.

### S2 — Provenance query lacks authenticated peer context (deferred)

Deferred by the user for later review; no authorization or query behavior changes.

The [controller](../../src/federation/s2s.controller.ts) passes only queries to
[`FederationMessageProvenanceService.query`](../../src/federation/federation-message-provenance.service.ts).
Candidate matching checks digest/sequence and account-based thread data, but
does not receive the authenticated requesting namespace or a per-recipient
publication association. A matching payload alone cannot establish that the
server published at that requester's exact direct-origin coordinate.

Review two foreign identities with the same peer account, historical namespace
replacement, and mirrored groups. Add adversarial binding tests before asserting
that every `yes` satisfies the protocol's publication honesty requirement.
This is not a claim that a profile or message byte-disclosure exploit has been
reproduced; the endpoint returns only digest confirmation states.

### V1 — Validation coverage is incomplete (release verification)

The added checks prove package metadata, normative table/manifest/controller
route agreement, enum lists, selected closed shapes, quote-field dependence,
provenance batch shape/duplicate handling, and fixed signature vectors. They do
not run actual emitted message, Group Meta, profile, and namespace responses
through every published schema. The original F1–F4 discrepancies demonstrated
why a green package CLI is insufficient; correcting F1–F3's artifacts does not
close that executable verification gap.

Add actual producer/consumer round trips and PostgreSQL-backed authorization,
revocation, and three-node convergence tests. Review the entire negative-input
boundary, not just valid JSON examples. Browser, Android, and WebRTC endpoint
conformance need separate runs; no completed E2E handoff substitutes for them.

### V2 — Standalone distribution needs a reproducible validation entry point

[Governance](../../spec/GOVERNANCE.md) requires independently distributable
`spec/`, but current validation instructions invoke a root package script and
[`scripts/federation-conformance.ts`](../../scripts/federation-conformance.ts),
which are outside a copied `spec/` tree. Reading the protocol does not require
SOMS source, but validating the standalone bundle still requires an explicit
tool distribution/install entry point. Test the eventual release artifact in a
clean directory before claiming the package is independently distributable.

### V3 — Whole-project type checking still fails

`npx tsc --noEmit -p tsconfig.json` fails in two test files not changed by this documentation pass:

- [Group Meta client tests](../../src/federation/federation-group-meta-client.service.spec.ts) still construct item-level `account` fields against the current body-based item type.
- [Inbound message validator tests](../../src/federation/federation-inbound-message-validator.service.spec.ts) have union narrowing / negative-fixture casts incompatible with the current nested-author type.

These are further evidence that the wire cutover is not fully reconciled across tests. Fix the fixtures and type-safe malformed-input construction without using casts to conceal a real contract disagreement. A green targeted Vitest run is not a whole-project type-check pass.

## Verification performed

Latest F7 implementation correction:

- `npm test` — **217 files, 1,951 tests passed**.
- PostgreSQL E2E: `thread-attention` and `mention-mirror-member-resolution` —
  **45 tests passed** after correcting the group-specific fixtures.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib --quiet` — **139 tests passed**.
- Web focused Vitest via `web/vitest-base.config.ts`, jsdom and globals —
  **4 files, 18 tests passed**, with normal process exit.
- Angular test builder also reported **6 files, 51 tests passed**, but the CLI
  did not exit before the 120-second command timeout. A second smaller Angular
  run likewise passed its tests but timed out on process shutdown; this is not
  reported as a clean Angular command pass.
- From repository root, `npx tsc --noEmit -p web/tsconfig.app.json` and
  `npx tsc --noEmit -p web/tsconfig.spec.json` — PASS. Invoking the app check
  from `web/` instead exposed TS6059 shared-file rootDir errors; no unrelated
  build configuration changes were made.
- Final `git diff --check`, changed TypeScript formatting, and
  `npm run federation:conformance` — PASS.
- Production backend type check — PASS. Whole-project check still fails only
  in the two pre-existing test files under V3; those fixtures remain deferred.

Earlier F6 implementation correction:

- `npx vitest run src/federation` — **68 files, 632 tests passed**.
- Initial focused routing, page-isolation, executor, and feed run — **94 tests passed**.
- `npx tsc --noEmit -p tsconfig.build.json` — PASS.
- `npm run federation:conformance` — PASS.
- `git diff --check` — PASS; changed TypeScript formatted with Prettier.
- No PostgreSQL-backed multi-node E2E run in this correction.

Previous user-directed documentation correction pass:

- `npm run federation:conformance` — PASS with revised shapes and vectors.
- `npx vitest run src/federation/federation-protocol-doc.spec.ts` — **14 tests passed**, including new closed author, Group Meta body, and domain-free profile checks.
- Five targeted Vitest files — **62 tests passed** in total: protocol docs,
  message feed, forward executor, reverse executor, and S2S controller. Existing
  executor tests passing does not close F6: they still exercise the current
  `includeSelf=true` requests.
- `git diff --check` and changed JSON/TypeScript Prettier checks — PASS.
- Local Markdown links/headings — **101 files, zero issues**.
- Static checks only for F6/F7 runtime paths; no application behavior changed.

Earlier closeout pass (retained baseline, not rerun results for this correction):

- `npm run federation:conformance` — PASS after the artifact corrections.
- Ten targeted Vitest files — **153 tests passed**: protocol docs, provenance,
  message feed, S2S controller, federation profiles, federated content, profile
  resolution, session tokens, SSE, and thread feed.
- `npx tsc --noEmit -p tsconfig.build.json` — PASS for production backend source.
- `npx tsc --noEmit -p tsconfig.json` — FAIL in the unchanged test files listed under V3; not reported as a passing build.
- Prettier applied to the modified validation TypeScript and JSON artifacts.
- Local Markdown file/heading targets checked across root README, docs, and spec;
  final scan: **101 Markdown files, zero local target/heading issues**.

Not performed: full backend/frontend/native suites, PostgreSQL E2E, federation
lab reset/workload, deployment, or browser/Android device acceptance. Do not
interpret this audit as an approval to freeze.

## Recommended closeout order

1. Discuss F4/F5 separately. F6/F7 code corrections and focused verification
   are complete; multi-node acceptance remains V1.
   F1–F3 and F7 documentation now follow user decisions,
   recorded without runtime details in the normative review history.
2. Resume deferred S1/S2 only when the user requests their review; add focused
   adversarial tests with the eventual approved policies.
3. Align emitters, consumers, schemas, and vectors; validate real responses
   against the independently maintained contract.
4. Run database-backed convergence/concurrency and supported endpoint suites;
   verify the standalone release artifact.
5. Re-review normative consistency and only then decide whether to publish a
   release candidate. Final Review remains a draft stage until those gates pass.
