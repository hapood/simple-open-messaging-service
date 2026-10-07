# Provider Dependency Cleanup

> Checklist-driven cleanup of dependency cycles and DI hygiene across the
> NestJS provider graph. Modeled on
> [`federation-domain-namespace-cleanup-todo.md`](./federation-domain-namespace-cleanup-todo.md):
> work one section at a time and re-run the listed verification before moving
> on.

## Status Summary

The provider graph has **two real runtime dependency cycles** and a set of
hygiene defects. The cycles exist at both the Nest instantiation level
(constructor injection) and the ESM module-load level; the ESM form is the
live failure — a TDZ crash (`Cannot access 'FederationNamespaceService before
initialization`) aborts 43 e2e spec files during module load.

**Cycle A (services):**

```
FederationThreadAccessService  --ctor-->  FederationNamespaceService
FederationNamespaceService     --ctor-->  ProfileNamespaceService
ProfileNamespaceService    --ctor-->  FederationThreadAccessService
```

**Cycle B (through non-`*Service` providers):**

```
ProfileNamespaceService --ctor--> FederationPeerHttp
FederationPeerHttp          --ctor--> FederationRecognitionService, FederationPeerLifecycle
FederationPeerLifecycle     --ctor--> FederationRecognitionService
FederationRecognitionService--ctor--> FederationNamespaceService
FederationNamespaceService  --ctor--> ProfileNamespaceService   (shared with Cycle A)
```

Both cycles share the backbone `FederationNamespaceService →
ProfileNamespaceService`. The single root cause: `ProfileNamespaceService`
is a local cache store that also performs outbound network IO — its private
`fetchBindings` path injects `FederationThreadAccessService`,
`FederationTrustedPeerClient`, and `FederationPeerHttp`, and those three
constructor edges are exactly every return path of both cycles.

Remaining hygiene defects:

- A stale `@Inject(forwardRef(() => RelationshipService))` in
  `src/federation/federation.service.ts` — no cycle exists at the DI, module,
  or ESM level (verified); leftover from a cycle that no longer exists.
- A module cycle `Upload → Message → LinkPreview → Upload` held open by two
  `forwardRef` module imports. The provider graph is already a DAG; the cycle
  exists only because upload-side message promotion (controller +
  `ResumableUploadService`) lives inside `UploadModule`.
- Four `SOMS_TEST_*` injection tokens: three are dead (never provided
  anywhere), one (`SOMS_TEST_RATE_LIMIT_CONFIGURATION`) routes tests around
  the production configuration path instead of covering it.
- Type-only ESM cycles (erased at compile time, runtime-harmless) around
  `FederationStateFeedConsumerService` → membership-intent services →
  `import type FederationService`. Tracked in Section 5.

## Ground Rules

1. **Import direction is downward.** L0 primitives (keypair, signature,
   discovery, transport config, feeds) → L1 peer-context / thread
   authorization → L2 identity facts (namespace, profile-namespace cache) →
   L3 outbound clients (peer-http, lifecycle, trusted-peer, resource clients)
   → L4 data-plane consumers (inbound pipeline, feed consumers) → L5
   orchestration (rounds, schedulers, pulls) → L6 facade. Imports point
   strictly downward.
2. **A dependency cycle is a defect at two levels.** Nest `forwardRef` defers
   DI resolution but cannot fix ESM TDZ (see the prior art comment in
   `src/gateway/call-state.registry.ts`). Cycles are fixed by moving
   capabilities to their owning layer, never by indirection.
3. **No test vocabulary in production constructors.** No `SOMS_TEST_*`
   tokens, no `testXxx` parameters, no `@Optional` test-only branches. Tests
   stub real dependencies (e.g. `DatabaseService`) or override real tokens so
   they exercise production paths.
4. **A cache or fact store does not perform network IO.** Outbound fetches
   belong to orchestration services; stores answer from local rows only.
5. **Guard rail:** `npx madge --circular --extensions ts src` must report no
   runtime cycles once Section 4 lands.

---

## 1. Extract the ProfileNamespace outbound refresh

Goal: kill Cycles A and B at both levels by cutting all three outbound
constructor edges of `ProfileNamespaceService` in one move.

- [x] Create `src/federation/profile-namespace-refresh.service.ts`: move the
      refresh flight engine (`refreshFlights`, `scheduleRefresh`, `refresh`,
      `refreshDirectRow`, `fetchBindings`, `STALE_FETCH_MAX_ATTEMPTS`). Deps:
      `DatabaseService`, `FederationThreadAccessService`,
      `FederationTrustedPeerClient`, `FederationPeerHttp`,
      `ProfileNamespaceFeedService`, `SseService`.
- [x] `ProfileNamespaceService` keeps `resolveBatch` (cache read + tomb
      demand fill) and `seedDirectRowInTx`; its only constructor dep becomes
      `DatabaseService`.
- [x] `resolveBatch` must not call the refresh engine itself — that would
      re-form the cycle as `namespace → PNI → Refresh → ThreadAccess →
namespace`. It returns entries **plus** the pending refresh list; the two
      callers (`src/controller/profile-namespace.controller.ts`,
      `src/federation/federation-profile.service.ts`) forward pending refreshes
      to the refresh service.
- [x] Rewire external `scheduleRefresh` callers
      (`src/admin/federation-namespace-admin.service.ts`,
      `src/federation/federation-profile-namespace-pull.service.ts`) to the
      refresh service.
- [x] Register the new provider in `src/federation/federation.module.ts`.
- [x] Keep `FederationNamespaceService → seedDirectRowInTx`: namespace birth
      atomically seeds the handshake row in the same transaction; cohesion beats
      edge-count.
- [x] Remove the stale `@Inject(forwardRef(() => RelationshipService))` in
      `src/federation/federation.service.ts` (plain constructor injection).
- [x] Adapt `profile-namespace-info.service.spec.ts`; add a refresh-service
      spec covering the flight/stale-guard behavior.

Verification:

```bash
npm run build:be
npx vitest run src/federation/profile-namespace-info.service.spec.ts
npx vitest run src/federation src/admin
npx madge --circular --extensions ts src
```

## 2. Split resumable upload out of UploadModule

Goal: turn the module graph into a DAG and delete both module-level
`forwardRef` imports.

- [x] `UploadModule` becomes the CAS core (`UploadService`,
      `MediaAssetService`, `MediaAccessService`, `MediaMetadataService`); imports
      only `QuotaModule`. `bootstrap.ts` keeps resolving `MediaAccessService` via
      `app.get()`.
- [x] New `ResumableUploadModule` owns `ResumableUploadService` +
      `UploadController` (the staged-send-to-message promotion that needs
      `MessageService`); imports `UploadModule`, `MessageModule`, `QuotaModule`.
      `AdminModule` imports it for `MediaTransferAdminController`; `AppModule`
      registers `UploadController` from it.
- [x] `LinkPreviewModule` and `UploadModule` drop their `forwardRef` imports;
      resulting chain is
      `ResumableUpload → Message → LinkPreview → Upload → Quota`.

Verification:

```bash
npm run build:be
npx vitest run src/upload src/link-preview src/message
```

## 3. Remove SOMS*TEST*\* tokens

Goal: zero test vocabulary in production constructors.

- [x] `src/settings/settings.service.ts`: replace the
      `SOMS_TEST_VAPID_KEY_PATH` / `SOMS_TEST_FIREBASE_CLIENT_PATH` tokens with
      neutral `@Optional()` path-override parameters (`vapidPathOverride`,
      `firebaseClientPathOverride`). The DI tokens were dead, but the specs
      inject the paths positionally — the seam itself is a legitimate
      configuration override once the test vocabulary is gone.
- [x] `src/push/push.service.ts`: same replacement
      (`fcmCredentialPathOverride`); the spec injects a non-existent path to
      keep FCM unconfigured in unit tests.
- [x] `src/rate-limit/rate-limit-mode.service.ts`: delete the
      `testConfiguration` parameter; `onModuleInit` guard becomes
      `if (this.database)`.
- [x] `src/rate-limit/rate-limit.http.spec.ts`: instead of the token, provide
      a `DatabaseService` stub whose `db.query.systemSetting.findFirst` resolves
      the configured `rateLimit:authPolicies` row, so the suite covers the
      production `defaultConfigs() → DB override` path.

Verification:

```bash
npm run build:be
npx vitest run src/rate-limit src/settings src/push
```

## 4. madge cycle gate

Goal: no new cycles land.

- [x] Add a check (npm script + CI step) running
      `madge --circular --extensions ts src` and failing on any runtime cycle.
      Added `npm run check:cycles` (devDep `madge@8`) + a `Check circular
    dependencies` step in `.github/workflows/ci.yml`.
- [x] Decide the type-only policy: either configure the gate to skip
      type-only imports until Section 5 clears them, or fix Section 5 first.
      Fixed Section 5 first (see below); the gate runs plain `madge` with no
      skip and reports zero cycles on `src/`.

## 5. Deferred hygiene (non-blocking)

- [x] Slim `FederationService` (29 constructor dependencies, 63 methods):
      move owned logic into capability services; keep a thin delegation facade.
      Completed beyond the original scope: dead code was deleted first, the
      remaining logic moved into capability services (state-feed push,
      relationship intent expiry, inbound message effects, …), every caller
      was transitioned to inject the owning service directly, and the facade
      (`src/federation/federation.service.ts`) was then removed entirely
      together with its module provider/export entry.
- [x] Replace the type-only imports of `FederationService` in the
      membership-intent / user-intent family with a narrow state-feed push
      publisher leaf (clears the remaining madge cycles). Done: the
      `FederationStateFeedPusher` seam in
      `src/federation/federation-state-feed.events.ts` is satisfied
      structurally by `FederationStateFeedPushService`; `madge --circular`
      now reports zero cycles.
- [ ] Revisit `FederationThreadAccessService` (fan-in 10): if capture
      delegation pressure returns, extract a `PeerContextService` leaf.
- [ ] Add class doc comments to the services that still lack them
      (`CallHistoryService`, the `durable-task` family, `UserService`, …).

## Verification Commands

```bash
npm run build:be
npx vitest run shared/ src/
npx madge --circular --extensions ts src
cd web && npm run build
cd admin-web && npm test && npm run build
```

PostgreSQL-backed e2e re-runs once Section 1 lands (the TDZ blocker clears):
`npm run test:e2e`.
