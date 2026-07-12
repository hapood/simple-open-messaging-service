# Backend Review — Follow-ups

A review of the **API/interface design** and the **database connection-pool design** (2026-07-09).
The P0 items are done; this file tracks the remaining items, grouped by priority, for future work.
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

## P1 — security & resilience

### Global `JwtAuthGuard` + `@Public()` convention
Auth is opt-in per route: every handler carries `@UseGuards(JwtAuthGuard)` (~40 endpoints), there is no
`APP_GUARD` and no `@Public()`/`IS_PUBLIC` metadata. A new endpoint added without `@UseGuards` is
**silently unauthenticated** — the highest structural risk in the API layer.
**Fix:** register `JwtAuthGuard` as a global guard (`APP_GUARD`) and mark the handful of public endpoints
(login, register, vapid-key, `.well-known`, `s2s/*`) with `@Public()`. The other three auth mechanisms
(`NotificationTokenGuard`, `AdminAuthGuard`, `S2sSignatureGuard`) are already route-scoped and coexist
fine with a global JWT guard by overriding on their routes.

### Boot DB connection retry + healthcheck
`PrismaService.onModuleInit` calls `$connect()` once (`src/prisma.service.ts`); a transiently-unavailable
PostgreSQL at boot rejects and the process exits with no backoff. (A container healthcheck + restart
policy now exist — `HEALTHCHECK` in the Dockerfile and `restart: unless-stopped` + `init: true` in
docker-compose.yml — so the orchestrator re-loops the whole container, but the app itself has no
connect-time retry.)
**Fix:** add a bounded retry loop around `$connect()` (e.g. 5 attempts × exponential backoff) so a
transiently-down PG is tolerated within one boot rather than only via container restart.

### Prisma query logging
`PrismaService` passes no `log:` config — an operational blind spot for slow queries and N+1 detection in
production.
**Fix:** add `log: ['warn', 'error']` (and `'query'` behind a dev flag if desired) to the `PrismaClient`
super options. Respect the project's no-diagnostic-logs preference by keeping it at warn/error, not info.

## P2 — consistency & maintainability

### Response envelope enforced by infrastructure
`ApiResult<T>` (`src/common/api-result.ts`) is the standard shape, but every handler **hand-builds**
`{ code, message, data }`. The global `SerializeInterceptor` only does BigInt/Date serialization; it does
not wrap the envelope. A handler that forgets `code`/`message` produces a malformed body.
**Fix:** envelope-ize in an interceptor (wrap the raw return value, with a `@Raw()` escape hatch for
SSE/file streams). `SerializeInterceptor` is the natural place.

### Conversation-list pagination: `hasMore` + dead `lastId`
`QueryValidThreadDto.lastId` (`src/dto/user.dto.ts`) is declared but never used, and the conversation list
is the only offset-based list endpoint and the only one that returns **no `hasMore`** — inconsistent with
the message/search keyset paths.
**Fix:** return `hasMore` (take+1 trick) and either wire up `lastId` as a keyset cursor or delete it.

### Error vs success response shape
`AllExceptionsFilter` (`src/common/exception.filter.ts`) emits `{ code, message, data: null }` with no
`messageKey`/`hasMore`, while success responses may carry them. If the frontend ever keys off these fields,
errors behave differently.
**Fix:** document the asymmetry or align the shapes.

### Invite model — GC sweep + GROUP follow-up (2026-07-09 invite redesign)
Friend-add was rebuilt on a unified `Invite` table (`kind` FRIEND/GROUP); the `Friendship` and `Notify`
tables were dropped (the friend-request unread badge stays as the inline `User.hasUrFriendReq`, now driven
directly by `InviteService`). Two deferred items:

- **Invite expiry GC sweep (TODO, low priority).** Today expiry is validated at accept time only; a
  PENDING row past `expiresAt` stays PENDING (kept as history). The table stays small because duplicates
  overwrite in place (partial unique indexes `invite_friend_pending_uq` / `invite_group_pending_uq` on
  `(from,to)` / `(to,thread)`), so cleanup is low-priority. **TODO:** a periodic sweep
  `UPDATE "Invite" SET status='EXPIRED' WHERE status='PENDING' AND "expiresAt" < now()` + recompute
  `hasUrFriendReq`, as part of the larger garbage-collection feature (pattern: `FederationReconnectService`
  hosted worker). No row is ever hard-deleted.
- **GROUP live-flow switchover (TODO).** Group invites still use the legacy JWT-token-in-message mechanism
  (`group.controller.writeInvites` → `groupService.generateInviteToken` + `ContentType.INVITE`); the table
  is GROUP-ready (`InviteKind.GROUP` + the `(to,thread)` overwrite index). Migrate when the frontend group
  display is built — card carries inviter + group name/avatar + invite id; validity fetched on dlg-open
  via a new `/invite/detail { inviteId }`; only owner/admin may invite.

## P3 — hygiene & minor

- **`buildUnreadSnapshot` fan-out.** `message.controller.ts` calls `buildUnreadSnapshot` (4–5 queries,
  `src/notification/notification-query.service.ts`) **per online backgrounded recipient per message**.
  Fine for P2P (≤1), scales with group size × backgrounded devices. Batch the unread computation for all
  notification recipients into one query if profiling shows pressure. Queries are short — not a pool risk.
- **`peerUsers` hydration is O(P×U).** `notification-query.service.ts` does `.find()` inside `.forEach`;
  a Map lookup is cleaner. Trivial at current scale.
- **Single-instance in-memory state.** `SseService` connection maps (`isUserOnline`), `ThrottleGuard`'s
  in-memory fallback, and `LocalStrategy`'s brute-force ban maps won't survive multi-instance deploys.
  Already noted as deferred (P3): needs Redis-backed shared state for horizontal scaling.
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
