# Federation Implementation Handoff

## Scope

This records the earlier implementation closeout and the subsequent incremental
protocol review. The six identified review issues have been addressed, including
display-only forward snapshots, the 31-code-point name limit, shared-child DAGs,
and the documentation corrections. Final submission review remains separate.
Previous runtime test/build results below predate the Forward revisions.
Operator acceptance remains owned by the user, and automated tests are currently
paused. Static TypeScript checks for the root, production, separate E2E, Web
application, and Web test projects pass after the Forward revisions (Web checks
use `--rootDir ..`). Formatting and `git diff --check` pass; these are not runtime
or device acceptance.
The independent protocol package remains **DRAFT — Final Review**,
`1.0.0-draft.0`, wire major 1. This is not a release freeze or a claim of complete
protocol conformance.

## Retained decisions

- Exact namespace/account identity is preserved in messages, mentions, profiles,
  receipts, and fixtures. Binding lifecycle is local state, not a wire field.
- Forward bundles use internal bigint keys and external SHA-256 content digests.
  DIRECT preserves an existing complete bundle without adding depth; HISTORY
  adds a wrapper. Inner snapshot author identities have been removed; only
  frozen display profiles remain. The browser and desktop/Android WebViews use
  the same detail renderer. Native Rust transports the API response and media;
  it has no separate bundle author model to migrate. See [the API](../api/api.md#message-api) and
  [database model](../overview/database.md).
- Mirror departure is intent-owned and independent of Group Meta. Client Meta
  cancellation and renderer state share one durable commit event stream;
  departure preserves cached history. See [Group Meta](../design/canonical-group-meta.md)
  and [thread state](../design/thread-state.md).
- Exact profile revisions are immutable. The lab audit deduplicates identical
  direct/relayed copies and rejects conflicting content instead of replacing a
  prior copy. New revisions, current-revision pointers, and namespace binding
  refresh are distinct operations.
- Cached exact profile reads intentionally have no local per-caller disclosure
  authorization. Cache misses retain new-resolution authorization. See
  [profile resolution](../design/thread-state.md#exact-profile-resolution).
- Requester-to-publication identity binding is not added to provenance lookup in
  this scope. Ordinary federation signature authentication remains required.
  The stronger protocol property is not claimed as verified; see
  [provenance implementation scope](../design/message-provenance.md#current-lookup-and-identity-binding-scope).
- No compatibility alias or cache-version migration was introduced. The
  unpublished database baseline and Drizzle schema are synchronized.

## Recorded verification

These runs predate the display-only forward snapshot change and are not its
validation evidence. Tests have not been rerun for that change. Existing
author-bearing development bundles are not supported by the revised shape;
no database/cache reset or data rewrite has been performed. Stored snapshots
with unknown fields are rejected on closure construction rather than stripped
and republished under a changed digest. Removing fields must not silently rewrite
an immutable bundle under its prior digest.

The forward display-name limit is now consistently 1–31 Unicode code points,
matching profiles and CONTACT_CARD snapshots without truncation. A positive
boundary vector includes a supplementary-plane character. Tests remain paused.
Shared-child references are allowed. Closure bodies and stored dependency edges
are deduplicated, while each message reference remains intact. The local
500-message limit counts the full reference expansion; depth uses the longest
path (local maximum 3). Imported and newly created card counts, and shared
Web/native detail counts, follow the same rule. Tests remain paused; previous
runtime results do not validate this graph change.

| Check | Result |
| --- | --- |
| Backend/shared unit suite | 219 files, 1,990 tests passed |
| Complete PostgreSQL E2E suite | 95 files, 680 tests passed |
| Root, production, separate E2E TypeScript | Passed; E2E diagnostics reduced from 183 to 0 |
| Web Angular suite | 194 files, 1,492 tests passed; clean exit |
| Administration suite | 17 files, 63 tests passed |
| Rust library | 141 tests passed |
| Cross-platform driver helpers | 5 files, 23 tests passed |
| Lab helpers after immutable-profile aggregation change | 192 tests passed |
| PostgreSQL lab readers after that change | 2 files, 4 tests passed |
| Backend, Web, administration production builds | Passed |
| Standalone conformance tool | Passed; clean-directory validation and 18 CLI tests also recorded |

The complete PostgreSQL run preceded the bounded immutable-profile lab audit
aggregation change; the lab-reader regressions and full diagnostic workload were
rerun afterward. The administration build retains a non-fatal >500 kB chunk
warning. No warning limit or test timeout was raised to obtain these results.

Latest full three-node lab command:

```sh
npm run federation:test -- --seed=2781109758
```

Diagnostic session `20261017043949816`, workload `20261017044001315-p2p`:
600 random decisions and 608 logical operations completed. DIRECT, HISTORY,
DEEP_HISTORY and download authorization checks passed. All 75 referenced
profiles resolved without immutable-revision conflicts. Final consistency passed
three consecutive samples; admin provenance checks passed on alpha 32/32,
bravo 52/52, and charlie 33/33. The runner reported `SUCCEEDED` and shut down its
owned processes normally.

## Acceptance boundary

Browser end-to-end, Android/native devices, WebRTC, deployment, and final release
acceptance remain with the operator. An earlier immediate mirror leave/rejoin
failure did not recur in subsequent complete suites; its original ordering was
not established, so passing reruns are not a causal explanation or proof of all
interleavings. Provenance smoke results do not prove the omitted requester
identity binding. Do not promote the draft based solely on this report.
