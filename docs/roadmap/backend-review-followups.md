# Backend Review — Follow-ups

A review of the **API/interface design** and the **database connection-pool design** (2026-07-09).
The P0 and P1 items are done; this file tracks the remaining items, grouped by priority, for future work.
Each entry lists the problem, where it lives (`file:line`), why it matters, and the suggested fix.

## Done

- **Connection-pool multiplication (P0).** `PrismaService` was declared in 13 feature modules'
  `providers:`, which under NestJS module-scoped DI minted 13 `PrismaClient` instances = 13 `pg.Pool`s
  (default `max=10` each) → up to 130 connections from one Node process vs PostgreSQL's default
  `max_connections=100`. Fixed: one `@Global() PrismaModule` (`src/prisma.module.ts`) provides + exports
  `PrismaService`; the 13 local declarations and their imports were removed. Verified by `auth.e2e-spec`
  (AppModule boots, `app.get(PrismaService)` resolves).
- **`countUnreadByThread` raw SQL `m.id` → `m.seq` (P0).** The unread-count query compared the global
  autoincrement `id` against the per-thread `lastReadSeq` watermark — two different number spaces —
  producing silently wrong unread counts. Now `m.seq > COALESCE(tp."lastReadSeq", 0)`.
- **`Message` id/seq refactor reconciled (P0).** `id BigInt @id` (internal global surrogate, never
  serialized — a global autoincrement would leak cross-conversation throughput) + `seq Int` (per-thread
  external ordering key). Schema, migration `20260710030000_message_id_seq_split`, generated client, and
  the raw SQL are all consistent; `omit: { id: true }` enforces the "never exposed externally" rule.
- **Pool size is now env-configurable.** `DATABASE_POOL_MAX` (default 10, pg's native default) is read
  in `src/prisma.service.ts` via `optionalIntEnv` and passed as `pg.PoolConfig.max` to `PrismaPg`. Documented
  in `.env` / `.env.example`. Keep `max × app-replica count ≤ PostgreSQL max_connections`.
- **Global auth guard + `@Public()` opt-out (P1).** Auth was opt-in per route (~40 `@UseGuards(JwtAuthGuard)`
  endpoints, no `APP_GUARD`); a new route added without it was silently unauthenticated. Fixed AND taken
  further — JWT is now removed entirely. The global guard is `SessionAuthGuard`, registered as `APP_GUARD`
  in `src/auth/auth.module.ts`; every route is authenticated unless it opts out with `@Public()`
  (`src/common/public.decorator.ts`). Consumer auth resolves an opaque session token via `BearerAuthService`
  (cookie-first, Bearer fallback); admin auth is `AdminAuthGuard` (`ADMIN_SESSION_COOKIE` →
  `validateAdminSession`) — also session-based. `@UseGuards(SessionAuthGuard)` count across `src/` is 0.
- **Boot DB connect retry (P1).** `PrismaService.onModuleInit` called bare `$connect()`; a transiently-down
  Postgres at boot exited the process with no backoff (only the container restart re-looped it). Fixed:
  `connectWithRetry` in `src/prisma.service.ts` — bounded exponential backoff + full jitter, knobs
  `DATABASE_CONNECT_RETRIES` (5) / `_BASE_DELAY_MS` (500) / `_MAX_DELAY_MS` (5000); final failure re-throws
  for the restart policy. Covered by `src/prisma.service.spec.ts`.
- **Prisma query logging (P1).** `PrismaService` passed no `log:` config — an ops blind spot. Fixed:
  `log: ['warn','error']` always, plus `'query'` outside production (N+1 / slow-query detection), via the
  string-array (stdout) form. Deliberately not `$on`/`emit:'event'` — Prisma infers `$on`'s `LogOpts` from
  the literal `log:` array, which a conditionally-built event array would break.
- **DB reachability on `/health` (P1).** The liveness probe `GET /api/v1/health` was zero-I/O — no way for
  monitoring to see DB-down short of user-facing 5xx. Fixed: a `database: "up"|"down"` field on the existing
  `/health` body, probed by a fail-fast `SELECT 1` (3s `Promise.race`). HTTP 200 is returned unconditionally
  — an orchestrator (Docker HEALTHCHECK) never restarts a live process over a DB blip; monitoring alerts on
  `database === "down"`. A k8s liveness/readiness split was deliberately NOT adopted: SOMS is
  single-instance by decision (no LB to reroute on a readiness failure). Covered by
  `src/controller/health.controller.spec.ts` and `test/health.e2e-spec.ts`.
- **Invite GROUP live-flow switchover (P2).** Group invites were the last holdout on the legacy JWT-token-
  in-message mechanism (`generateInviteToken` + `ContentType.INVITE` carrying the token); friend-add had
  already moved to the unified `Invite` table. Done: `generateInviteToken` is gone; `writeInvites`
  (src/controller/group.controller.ts) writes an `InviteKind.GROUP` row via `createGroupInvite` (local) /
  `federationService.sendInvite({kind:'GROUP'})` (federated); the `ContentType.INVITE` message is now a
  display card (group account/name/avatar, not a token); the invitee resolves + accepts via `/invite/detail`
  + `/invite/accept`. Frontend renders it (invite-row card + invite-detail dialog). The two stale
  `@ApiOperation` summaries that still said "invite token" have been reworded.

## P2 — consistency & maintainability

### Response envelope enforced by infrastructure
`ApiResult<T>` (`src/common/api-result.ts`) is the standard shape, but every handler **hand-builds**
`{ code, message, data }`. The global `SerializeInterceptor` (`src/common/serialize.interceptor.ts`,
registered in `src/bootstrap.ts`) only does BigInt/Date serialization; it does not wrap the envelope. A
handler that forgets `code`/`message` produces a malformed body, and success vs error shapes are built in
two different places (handlers vs `AllExceptionsFilter`).

**Approach — planned; execute AFTER the auth/threadlist WIP lands.** This refactor touches ~40 handlers and
overlaps that rewrite heavily, so doing it on the current dirty tree causes merge pain and rework.

1. **Fold envelope-wrapping into `SerializeInterceptor`** (it already runs on every response). Pipeline
   order: escape-hatch check → carrier unwrap → wrap raw data → existing `serializeBody` (BigInt/Date).
   - **Success**: handler returns the raw payload (`return user`); the interceptor emits
     `{ code: BusinessCode.OK, message: 'successful', data }`.
   - **Business failure**: handler `throw new BusinessException(code, msg, httpStatus?)`. `AllExceptionsFilter`
     (`src/common/exception.filter.ts`) already renders exceptions as `{ code, message, data: null }`, so
     success and error shapes are finally built one place each and align. Wire-compatible: a thrown
     `BusinessException` at the default HTTP 200 emits the exact body a `return { code: nonzero }` does
     today, so the `return`→`throw` conversion is behavior-preserving.
   - **Extra fields** (`hasMore` on paginated lists, `messageKey` on some successes): a branded carrier —
     `envelope(data, { hasMore?, messageKey? })` — the interceptor recognizes by brand, unwraps, and merges.
     `hasMore` is runtime-computed, so it cannot be a static decorator.
2. **`@Raw()` escape hatch** (class- or method-level `SetMetadata`, read by the interceptor like `@Public()`)
   for every handler that must NOT be enveloped:
   - **S2S controllers** (`src/federation/s2s.controller.ts`) — class-level; they deliberately return inline
     `{ code, message, data }` / raw GET payloads because HTTP status drives sender retry. Without `@Raw()`
     they get double-wrapped (`{ code:0, data: { code, ... } }`) — the canonical trap.
   - **SSE** (`src/gateway/events.controller.ts`, `reply.hijack()`).
   - **Static/stream serving** — shell `web-bundle`/`web-manifest`/`compat` (`src/shell/shell.controller.ts`),
     `.well-known/soms` (`src/federation/well-known.controller.ts`), anything writing a buffer/string.
   - This audit is the bulk of the work: **missing one `@Raw()` = malformed response.**
3. **Gradual, compat-layer migration** (no flag-day):
   - Land the interceptor in a mode that ALSO passes through a pre-built `ApiResult` (detected via an
     explicit `__apiResult: true` brand stamped on legacy returns) without re-wrapping. Existing handlers
     keep working unchanged.
   - Migrate per-module: `return { code:0, ..., data }` → `return data`; `return { code: nonzero }` →
     `throw new BusinessException(...)`. The brand makes detection unambiguous, avoiding a shape-heuristic
     false-positive on a domain payload that happens to carry `code`+`data`.
   - Once every handler is migrated, delete the passthrough branch + the brand; the interceptor then
     always wraps.
4. **Bonus**: supersedes the "Error vs success response shape" item below — both sides become
   `{ code, message, data }` via filter/interceptor respectively.

**Verification**: unit-test the interceptor directly — raw payload → wrapped envelope; `@Raw()` → untouched;
`ApiEnvelope` carrier → merged `hasMore`/`messageKey`; branded `ApiResult` (migration phase) → passthrough,
no double-wrap; `throw new BusinessException` → `{ code, message, data: null }` via the filter. The existing
e2e suite must stay green (wire format unchanged), with an explicit assertion that an S2S response is NOT
double-wrapped.

### Error vs success response shape
`AllExceptionsFilter` (`src/common/exception.filter.ts`) emits `{ code, message, data: null }` with no
`messageKey`/`hasMore`, while success responses may carry them. If the frontend ever keys off these fields,
errors behave differently.
**Fix:** document the asymmetry or align the shapes. **Resolved by** the response-envelope interceptor
above — once that lands, both success and error bodies are `{ code, message, data }` built by the
interceptor and `AllExceptionsFilter` respectively; drop this item then.

## P3 — hygiene & minor

- **`buildUnreadSnapshot` fan-out.** `message.controller.ts` calls `buildUnreadSnapshot` (4–5 queries,
  `src/notification/notification-query.service.ts`) **per online backgrounded recipient per message**.
  Fine for P2P (≤1), scales with group size × backgrounded devices. Batch the unread computation for all
  notification recipients into one query if profiling shows pressure. Queries are short — not a pool risk.
- **`peerUsers` hydration is O(P×U).** `notification-query.service.ts` does `.find()` inside `.forEach`;
  a Map lookup is cleaner. Trivial at current scale.
- **Single-instance in-memory state (non-goal, not a defect).** `SseService` connection maps
  (`isUserOnline`), `ThrottleGuard`'s in-memory fallback, and `BruteForceService`'s ban maps are
  in-process by design — **SOMS is single-instance by decision (2026-07); no Redis-backed shared state or
  horizontal scaling is planned.** These maps won't survive a multi-replica deploy, but that topology is
  out of scope; treat the in-memory state as intentional, not a gap to close.
- **`@Controller()` empty prefix + full path per route** (`@Post('send-message')`, `@Post('user/my-profile')`).
  Non-idiomatic; `@Controller('message')` + `@Post('send')` would group routes. Low functional impact.
- **Three pagination schemes** coexist (keyset+skip0/1, offset+dead-cursor, timestamp-cursor) with no
  shared pagination DTO base. Federation S2S uses a fourth (query-param cursor, no envelope).
- **`NotificationTokenGuard` imports `Request` from `'express'`** (`src/auth/notification-token.guard.ts`)
  while the app runs on Fastify; works because it only reads headers/sets `req.user`, but it's typed
  against the wrong runtime. Use the `fastify-request-user.d.ts` augmentation.
- **S2S controllers return inline literal `{ code, message, data: null }`** instead of `ApiResult`, and
  GET S2S handlers return raw payloads with no envelope. Deliberate (HTTP status drives sender retry;
  see `business-code.ts`), but a shared `S2sResult` type would tidy the code.
- **OpenAPI tidiness.** `user/register` is cross-tagged `@ApiTags('auth')` inside `UserController`;
  `user/thread-info` has a stray leading slash (`@Post('/user/thread-info')`); admin controllers use POST
  for reads and deletes (everything is POST-action, the most verb-abusive surface).
