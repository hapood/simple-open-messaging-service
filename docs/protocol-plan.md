# Protocol Stack Plan

This document is the target design baseline for the SOMS **backend API and frontend-backend interaction protocol stack**, used for team alignment and subsequent incremental implementation. Based on a review of the existing code (5 backend controllers, `EventGateway`, `AuthService`, and the frontend `AuthInterceptor` / `WebsocketService`), it proposes a layered target contract, an error code system, a WS event catalog, and an evolution roadmap.

- **Status**: P0/P1 completed and verified; real-time communication was migrated from WebSocket to **SSE** on 2026-06-30 (§4.5 / §5.5 / §Six P2 have been rewritten accordingly); this document only retains the to-do items (P2 increments / P2+ / P3 + ESM side task). Last updated 2026-07-01.
- **Scope**: HTTP APIs, data contracts, authentication, real-time communication, frontend-backend coordination
- **Goal**: Under the positioning of "concise and easy for third-party applications to integrate", round out the contracts, correctness, and reliability

---

## Table of Contents

- [1. Background and Goals](#1-background-and-goals)
- [2. Current State Assessment](#2-current-state-assessment)
- [3. Design Principles and Preserved Items](#3-design-principles-and-preserved-items)
- [4. Target Protocol Stack Layering](#4-target-protocol-stack-layering)
- [5. Target Contract Specifications (Summary)](#5-target-contract-specifications-summary)
- [6. Evolution Roadmap](#6-evolution-roadmap)
- [7. Appendix: Refactor Points → File Mapping](#7-appendix-refactor-points--file-mapping)

---

## 1. Background and Goals

SOMS's core flows (registration/login, friends, P2P/group threads, message send/receive and real-time push) are already functional. However, the current API protocol has systematic gaps in **standardization, contract-ification, correctness, and reliability**, mainly manifested as:

- All errors are returned as HTTP 200 + a business `status`, losing HTTP semantics so that standard clients cannot take the error branch.
- No OpenAPI, no DTOs; frontend and backend types are hand-copied, conflicting with the "easy for third-party integration" positioning.
- Real bugs and security risks exist (refresh is in-memory only, `logout` reads the wrong field, secrets hardcoded, CORS wide open).
- WS has no heartbeat and no message sequence, so push reliability on weak networks is not guaranteed.

**Goal**: While preserving the existing sound design, evolve the protocol stack in four priority tiers (P0–P3) to "clear contracts, correct semantics, reliable and observable", and provide a discoverable, generatable, versioned API for third-party integration.

---

## 2. Current State Assessment (Baseline Before P0/P1, For Retrospective Only)

> The following is a snapshot of the protocol stack at planning time (2026-06-22). Items marked ⚠️ (no `/api/v1` prefix, all errors go through HTTP 200, refresh only in memory dict, `Date.toJSON` hack, no OpenAPI, no global filter/ValidationPipe) **have all been fixed in P0/P1**. The legacy "WS has no heartbeat, no sequence" was eliminated by the **WS→SSE migration** on 2026-06-30 (SSE `:ping` heartbeat + frame `id` + reconnect cursor catch-up) — see [§4.5](#45-real-time-communication-sse-downstream) / [§Six P2](#6-evolution-roadmap).

### Discovered Protocol-Layer Bugs and Risks

> The originally listed 8 protocol-layer bugs/risks (refresh in-memory dict and key mismatch, renew-refresh null pointer, logout reading wrong field, hardcoded secrets, CORS wide open, `StandardResponse` duplicated definition, file domain dead code, `Date.toJSON` global hack) **have all been fixed in P0/P1**; see git history for details.

---

## 3. Design Principles and Preserved Items

### Preserved Existing Designs (Planning Revolves Around These)

1. **Unified thread abstraction**: `MessageThread` / `UserMessageThread` unifies P2P and GROUP; `status` drives the lifecycle.
2. **Separation of responsibilities**: HTTP handles "write and query", SSE handles "push".
3. **Dual-token renewal**: short-lived access (stateless) + long-lived refresh (revocable).
4. **Cursor pagination**: `lastId` + `skip/take`.
5. **Downstream push (SSE)**: SSE unidirectionally pushes the **full message body** (`{ threadId, ...message }`, already serialized via `serializeBody`); the frontend can render directly upon receipt with no second fetch needed. The separation of responsibilities — HTTP for "write and query" + SSE for "push" — is unchanged. (The WS-era "thin payload `{threadId, msgId}` + secondary fetch" design was retired in the WS→SSE migration on 2026-06-30 — see [§4.5](#45-real-time-communication-sse-downstream).)

### Design Principles

- **Contract first**: OpenAPI as the single source of truth; frontend types generated from it.
- **Semantic correctness**: HTTP status codes reflect transport/auth/parameter-layer results; business codes carry the fine-grained business outcome.
- **Incremental evolution**: Preserve the existing `{status,message,data}` envelope mental model; iterate in tiers; no big-bang rewrite.
- **Observable, debuggable**: Unified exception exit + structured logging + traceId.

---

## 4. Target Protocol Stack Layering

### 4.1 Transport and HTTP Protocol

1. **Version prefix**: All APIs sit under `/api/v1`. This is a hard requirement for third-party integration — breaking changes go through version numbers.
2. **Method semantics**: Keep the existing **action-style RPC paths** (`POST /api/v1/message/send`), consistent with IM platform conventions (Slack/Discord/open platforms all do this); do not force a REST conversion. Use HTTP methods to distinguish read/write, but **the key is that HTTP status codes must be correct**.
3. **HTTP status codes + business envelope used together**:
   - Auth/parameter/rate-limit/server errors → corresponding HTTP 4xx/5xx, letting standard clients take the error branch.
   - Business results (already a friend, state-machine branches, etc.) → HTTP 200 + business `code`.

### 4.2 Data Contract

1. **DTO + validation**: Introduce `class-validator` + `class-transformer` + a global `ValidationPipe`; one DTO class per endpoint; parameter rules sink into decorators (replacing the hand-written regex in `register`).
2. **OpenAPI**: Introduce `@nestjs/swagger`; serve docs at `/api/v1/docs`, as a core deliverable for third-party integration.
3. **Frontend type generation**: Use `openapi-typescript` to generate TS types from OpenAPI, eliminating hand-copying.
4. **Unified pagination DTO**: Consolidate the scattered `skip/take/lastId/orderBy` into `CursorPageQuery<T>` + `CursorPage<T>`.
5. **De-hacked serialization**: Remove the global `Date.prototype.toJSON`; use a **response serialization interceptor** to uniformly convert `Date → millisecond timestamp` and `BigInt → string`, replacing the manual `convertBigIntId`.

### 4.3 Exceptions and Observability

1. **Global `ExceptionFilter`**: All exceptions (including uncaught ones) are uniformly converted to `ApiResult` + the correct HTTP code; never leak stacks.
2. **Structured logging** (`nest-winston` / `pino`) + inject a `traceId` per request, and write it into `ApiResult.traceId`.
3. **Health check** `GET /api/v1/health` (including DB connectivity), for deployment probes.

### 4.4 Authentication and Security

1. **Persist refresh_token to DB** (replacing the in-memory dict): see [Five, 4](#5-3-authentication-and-security-contract). Supports multiple devices, is revocable, and survives restarts; also fixes the key mismatch bug along the way.
2. **Fix `logout`**: take refreshToken from the request body, not from the JWT payload.
3. **Externalize secrets**: JWT secret and invite token secret moved to `env`.
4. **Rate limiting**: `@nestjs/throttler` globally; stricter on login/renew/send-message.
5. **Production security**: explicit CORS origin allowlist, `helmet`, enforce HTTPS/WSS, request body size limits.
6. access_token remains a pure short-lived stateless JWT; when "immediate kick-out" is needed, add a short-TTL revocation list (Redis blacklist) later.

### 4.5 Real-Time Communication (SSE Downstream)

> On 2026-06-30 the real-time channel was migrated from WebSocket to **SSE (Server-Sent Events)**: WS only carried downstream push yet bore the entire complexity of connection/reconnect/heartbeat/subprotocol auth (it once spawned 31 token/WS bugs); switching to SSE's "push-only" dedicated channel eradicated this in one stroke. The downstream direction is a SSE unidirectional stream; **all client upstream (sending messages, future typing) goes through HTTP**.

1. **Channel**: `GET /api/v1/events` (`text/event-stream`), manual `res.writeHead` + `X-Accel-Buffering: no` (to prevent Nginx from buffering into batches); the first frame `: connected` comment flushes the header to trigger the frontend `onopen`. A user may have multiple connections (multiple tabs/devices); `res.on('close')` does cleanup.
2. **Auth**: Reuses the same `JwtAuthGuard` as ordinary protected routes (verify signature + expiry + jti blacklist + `tokenVersion` revocation awareness); the token goes in the `Authorization: Bearer` header and **never in the URL** (no log/Referer leakage). On failure → HTTP 401; the frontend renews and reopens upon `onopen`. The WS `AUTH` handshake frame is no longer needed.
3. **Heartbeat and liveness detection**: The server writes a `: ping` comment frame every 25s (< Nginx `proxy_read_timeout` 60s); SSE is unidirectional with no pong, and detects disconnection via `res.write` returning `false` (peer gone / backpressure) → `res.end()` → `close` callback cleanup. The liveness detection window is ≤ 25s.
4. **Push payload**: Pushes the **full message body** (`serializeBody({ threadId, ...message })`, BigInt→string / Date→ms, same conversion as HTTP responses); the frontend can render directly upon receipt and **needs no second `query-messages`** (the former WS "thin payload `{threadId, msgId}` + secondary fetch" design has been retired). The frame carries `id: <msgId>`.
5. **Ordering and integrity**: While a single SSE connection stays alive, messages arrive **strictly ordered and intact** — guaranteed by the underlying TCP (the server's `write` order is the client's receipt order; the byte stream is reliably reassembled). The SSE layer needs no self-added `seq`; this is exactly the complexity saved by the migration.
6. **Reconnection and resumption**: The SSE stream itself does not replay history (the server does not consume `Last-Event-ID`). Messages during a disconnect (including the ≤25s false-dead window) will be lost; after a successful reconnect the frontend emits a `reconnect$` signal, and each thread does an HTTP incremental catch-up by the `newestMsgId` cursor (`refillNewer`). Multiple connections of the same user are each individually ordered; ordering across connections is not guaranteed.
7. **Forced logout**: All-device logout / password change / admin kick-out triggers the `auth.sessions-invalidated` event → `SseService` pushes `FORCE_LOGOUT` to all of that user's connections and immediately disconnects.
8. **Extended events** (all downstream): `USER_PRESENCE` (to be implemented), `NOTIFY` (**implemented**: a friend request triggers `NotifyService.recordFriendRequest` to atomically write a row + light up the badge, and `SseService.onNotify` pushes it in real time; the frontend `home` lights up the unread badge upon receipt; see [§Six P2](#p2--real-time-experience-and-reliability)). Note that `USER_TYPING` is a **client upstream** event and cannot be carried by SSE; a new HTTP endpoint is required.

### 4.6 Frontend-Backend Coordination

1. **Renewal single-flight** ✅ Landed: `renewAccessToken()` uses `shareReplay({ bufferSize:1, refCount:true })` + `finalize`; concurrent 401s share the same in-flight request, replacing hand-written flags. Unified to only hit `/auth/renew-access` (the backend also rotates refresh); deleted the old 7-day timer / `renewRefreshToken` / `tokenCreateTime` machinery.
2. **SSE reconnect: exponential backoff + full jitter** ✅ Landed: `delay = random(0, min(1000·2^attempt, 30000))`, base 1s, capped at 30s, reset to zero on successful connect (anti-thundering-herd); 401 renews then immediately reopens separately (not counted toward backoff). Replaces the previous fixed 10s.
3. **Unified frontend error handling** ✅ Partially landed: 401 → single-flight renew + retry once (bounded, non-recursive); renew failure (reuse `10006` / invalidated `10003`) → `redoLoginAuth` forces re-login; SSE `FORCE_LOGOUT` → disconnect + force re-login. **Still TODO**: 429 backoff, 5xx degraded prompt (see P3).

---

## 5. Target Contract Specifications (Summary)

### 5.1 Unified Response Envelope

```ts
// Reuses the existing structure with semantic field names; status may be kept or renamed to code
interface ApiResult<T = unknown> {
  code: number;        // 0 = success; non-0 = business error code (stable, enumerable)
  message: string;
  data?: T;
  traceId?: string;    // for debugging
}
```

### 5.2 HTTP Status Codes + Business Error Code Table

**HTTP status codes** (only protocol/system-layer errors keep HTTP codes for coarse categories; business results are always 200 + business code):

| Scenario | HTTP | Notes |
| --- | --- | --- |
| Success / business failure | 200 | Business results (including DTO parameter validation failures) always 200 + business `code` |
| Unauthenticated | 401 | token missing/expired (JwtAuthGuard) |
| Resource not found | 404 | Prisma P2025 |
| Conflict | 409 | Prisma P2002 (unique constraint) |
| Server error | 500 | Caught by the global filter as a fallback; no stack leaked |

> Design tradeoff (benchmarked against WhatsApp/Telegram, see §1/§3): the business code is the authoritative source of errors; HTTP codes only provide system-layer coarse categories.
> Therefore DTO parameter validation failures are **folded into the business flow** (200 + `10000`), not 400 — so the frontend can branch uniformly by `code` in the success callback.
> 201/403/429 are currently unused (resource creation uses 200; unauthorized/rate-limited are covered by business codes or P3 throttler).

**Business `code` segment allocation** (grouped by domain prefix, benchmarked against WhatsApp Cloud API; full definitions in `src/common/business-code.ts`):

| Segment | Meaning | Major code values |
| --- | --- | --- |
| `0` | Success | `OK` |
| `10xxx` | Common | `10000` parameter validation / `10001` not found / `10002` already exists / `10003` unauthenticated / `10004` no permission / `10005` rate-limited · IP banned / `10999` server error |
| `20xxx` | Friend · thread state machine | `20001` add self as friend / `20002` unknown status / `20003` no pending request |
| `30xxx` | Message domain | `30001` empty content / `30002` thread not approved / `30003` no such thread |
| `40xxx` | Group domain | `40001` not a group member / `40002` cannot invite non-friend / `40003` invalid invite token |

> Principle: the HTTP code answers "does the protocol/system layer hold"; the business `code` answers "what is the business result". The two do not conflict.
> P1b landed: 19 business failure points renumbered per the table above (see [docs/api.md](./api.md) "Business Error Codes" section).

### 5.3 Authentication and Security Contract

**Persist refresh_token to DB** (Prisma draft, replacing `_refreshTokenDict`):

```prisma
model RefreshToken {
  id         BigInt   @id @default(autoincrement())
  userId     Int
  user       User     @relation(fields: [userId], references: [id])
  tokenHash  String   @unique          // store a hash, not plaintext
  device     String?                   // multi-device identifier
  createdAt  DateTime @default(now())
  expiresAt  DateTime
  revokedAt  DateTime?                 // soft revocation
  @@index([userId])
}
```

- Login: after issuance, `(userId, hash(token), device, expiresAt)` is written to the DB.
- Renewal: verify the `hash` matches and is not expired/revoked → set `revokedAt` on the old record and issue a new record (**rotation**).
- Logout: set `revokedAt`.
- Periodically clean up records past `expiresAt` (replacing the existing 15-day in-memory cleanup).

**Secrets** (`.env`):

```bash
JWT_ACCESS_SECRET=...    # optional; if unset, auto-generated on first start in ./data/jwt-*.key
JWT_REFRESH_SECRET=...   # recommended to be separate from access (likewise optional, auto-generated)
```

### 5.4 Pagination Contract

```ts
interface CursorPageQuery<TCursor = number> {
  cursor?: TCursor;   // corresponds to the existing lastId
  take: number;       // upper bound clamped by the backend (e.g. ≤ 50)
  order: 'asc' | 'desc';
}

interface CursorPage<T> {
  list: T[];
  nextCursor?: number;
  hasMore: boolean;
}
```

### 5.5 SSE Event Catalog

Generic frame (SSE text stream, empty line `\n\n` delimits frames; the `event` line names the event, the `id` line acts as the cursor, and the `data` line is a JSON string):

```
event: <EVENT_NAME>
id: <msgId>          # only NEW_MESSAGE carries this line
data: <json>
```

Authentication is not in the frame — it goes through HTTP: if `JwtAuthGuard` fails on connection it returns 401 directly (frontend renews + reopens), so **there is no `AUTH` frame**. `: connected` / `: ping` are SSE comment lines (not counted as events), used for header flushing and heartbeat.

| Event | Direction | `data` | Notes |
| --- | --- | --- | --- |
| `NEW_MESSAGE` | S→C | `{ threadId, id, content, contentType, createdAt, ... }` (full message body, already serialized) | The other party / a group member sent a new message; the frontend can render directly upon receipt, no secondary fetch needed. Frame `id` = message id |
| `FORCE_LOGOUT` | S→C | `{ event:'FORCE_LOGOUT', status:0, message:<reason> }` | All-device logout / password change / admin kick-out; the frontend disconnects + forces re-login |
| `USER_PRESENCE` | S→C (to be implemented) | `{ userId, online }` | Presence |
| `NOTIFY` | S→C (implemented) | `{ event:'NOTIFY', type:'FRIEND_REQUEST', fromUserId }` | Triggered by a friend request: atomically writes the `Notify` row + lights up the `hasUrFriendReq` badge + real-time SSE push (`SseService.onNotify`) |

> **Upstream constraint**: SSE is unidirectional; the client does not send business messages to the server. `USER_TYPING` (typing) and other upstream traffic all go through HTTP `POST` (endpoint to be added). The WS-era `@SubscribeMessage` upstream channel was deleted with the migration.

---

## 6. Evolution Roadmap

Each tier lists **content**, **affected files**, and **acceptance**.

### P0 — Correctness and Security ✅ Completed

Global exception filter, ValidationPipe+DTO, refresh_token persisted to DB (fixing the logout/renew-access/renew-refresh bugs), externalized secrets, CORS allowlist + helmet have all landed and been verified end-to-end; backend dependency upgrades (NestJS 11 / Prisma 7 / TS 5.9, keeping CJS) are done. See git history for details.

### P1 — Contract and Integration ✅ Completed

Swagger (`/api/v1/docs`), `/api/v1` version prefix, HTTP status code alignment, full class-validator DTOs, full OpenAPI, frontend `openapi-typescript` type generation, serialization interceptor (removing the `Date.toJSON` hack), and business code segment rationalization have all landed. The request/response shape of each endpoint is governed by the **live OpenAPI** (`/api/v1/docs` + frontend generated types) as the single source of truth.

> **P1 Side Task (Engineering Infrastructure) — Whole-backend ESM Conversion** ✅ **Completed** (2026-07, branch `refactor/cjs-to-esm`). What landed: `tsconfig` (`module/moduleResolution: NodeNext`, `target ES2022`, `esModuleInterop: true`, `useDefineForClassFields: false` — the latter must be explicitly false, otherwise ES2022 defaults to true and breaks Nest property injection + the `@nestjs/swagger` metadata plugin) + `package.json` `type:"module"` + repo-wide relative imports patched with `.js` (codemod 148 spots) + 5 CJS-isms converted to default imports (`compression`/`sharp`/`argon2`×2/`dayjs`). **Pre-flight test net added**: first built an auth e2e smoke (register→login→guarded, `soms_test` isolated DB), green under CJS as a regression anchor, still green after ESM. **Toolchain**: dev runs `tsx` (ts-node ESM is deprecated), tests switched to `Vitest` (native ESM). **Root-cause payoff**: Prisma 7 `generate` emits an ESM client under NodeNext; Node 24 module-detection no longer misjudges; the Dockerfile's `COPY tsconfig` ordering is preserved (`generate` still needs to read `module`), but the CJS-avoidance pin for node 24.16 was dropped to `node:24`. The `require("@nestjs/swagger")` injected by the `@nestjs/swagger` CLI plugin is emitted by tsc as a createRequire-based `__require`, which runs fine under ESM. See the memory `prisma-generate-tsconfig-order`.


### P2 — Real-Time Experience and Reliability

> Reconciliation after the 2026-06-30 WS→SSE migration: the original first two P2 items (WS heartbeat / seq catch-up) were meant to fix WS reliability, which SSE now achieves more simply; the latter two (presence · Notify) are pure incremental features, and because SSE is unidirectional the upstream portion must go through HTTP.
> On 2026-06-30 read receipts were removed from the roadmap (consistent with `docs/chat-message-list-design.md`'s "read receipts: not doing it"); the `UserMessageThread.lastRead` field remains as an unused dead field (not migrated for now).

| Content | Status | Affected | Acceptance |
| --- | --- | --- | --- |
| Heartbeat and liveness detection | ✅ SSE landed | `src/gateway/sse.service.ts` | `: ping @25s` + `write` failure for liveness; false-dead connections cleaned within ≤25s (exceeds the original 90s target) |
| Reconnect catch-up | ✅ SSE landed | Frontend `websocket.service.ts` (`reconnect$` + `refillNewer`) | After reconnect, the messages missed during the outage are caught up via HTTP by the `newestMsgId` cursor |
| Typing / presence | ⏳ TODO | New HTTP upstream endpoint (typing) + SSE downstream event (`USER_PRESENCE`) + frontend component | Presence refreshes in real time. **Note**: SSE is unidirectional; typing must go through HTTP POST and can no longer use `@SubscribeMessage` |
| Notify integration | ✅ Landed | `notify.service.ts` (`recordFriendRequest` atomically writes a row + lights the badge), `controller/notify.controller.ts` (`mark-friend-req-read` clears the badge), `gateway/sse.service.ts` (`onNotify` real-time push), frontend `home.component.ts` (clears the badge on `NOTIFY`) | New friend request: atomically writes the `Notify` row + lights up the `hasUrFriendReq` badge + real-time SSE push of `NOTIFY`; after the user views it, `mark-friend-req-read` clears the badge |

> **Next focus of work** = P2 presence / typing (**Notify already landed**): under unidirectional SSE, typing requires a new HTTP upstream endpoint + a `USER_PRESENCE` downstream event + a frontend component; this is the main gap in real-time experience after the SSE migration, and the preferred follow-up once the current branch `refactor/sse-token` merges into `dev`.

### P2+ — Friend Domain Feature Completion (Product Alignment)

> Already fixed in this round (2026-06-26): the mutual-add-friend auto-approve parameter-order bug (`makeFriendRequest` FROM_PENDING branch), inaccurate status copy in `sendFriendRequest`/`acceptFriendRequest`, the frontend search results now distinguishing "can add / already a friend / already sent / the other side sent to you" by thread status (no longer always showing Send Request), the mis-set error copy on `ngOnInit` success, and several typos.
> **Decline friend request** is implemented: `POST user/decline-friend-request` + a frontend Decline button on Pending items. Semantics = delete this pair of request rows (both FROM_PENDING/TO_PENDING), returning to the initial state, without notifying the other party, and allowing a resend (benchmarked against Telegram).
> **Cancel sent request** is implemented: `POST user/cancel-friend-request` + a frontend Cancel button on "my sent" items. Reuses decline's "both rows → DELETED" logic; semantics = I proactively retract my own pending request, the other party is unaware, and a resend is allowed.
> **Real-time notification** is implemented (landed with P2 "Notify integration", see above): new friend requests are pushed in real time via SSE `NOTIFY`, no longer relying on frontend polling.
> The following are remaining **feature gaps** (modeled in schema but with no endpoint / no UI); by product benchmarking (Telegram/Discord) they should be added, and are listed as TODO for now:

| Content | Current State | Affected |
| --- | --- | --- |
| Delete friend / block | `DELETED`/`BLOCKED` statuses exist but no endpoint writes them | Cannot unfriend; no anti-harassment |
| Request message | The `UserMessageThread.reqMessage` field is unused; `send-friend-request` only accepts `userId` | Cannot carry verification info (benchmarked against WeChat/Telegram request messages) |

### P3 — Engineering and Production Readiness

| Content | Affected Files | Acceptance |
| --- | --- | --- |
| Structured logging + traceId (including a traceId field in the response envelope) | Global middleware/interceptor, `api-result.ts`, `exception.filter.ts` | Logs carry traceId to correlate requests; the response envelope injects a traceId (benchmarked against WhatsApp `fbtrace_id`) for the client to attach on error reports and the server to look up logs by |
| Structured `details` field in the response envelope | `api-result.ts`, `exception.filter.ts` | Additional data such as rate-limit info (`bannedUntil`/`retry_after`) goes through `details`, benchmarked against Telegram `parameters` / WhatsApp `error_data`; P1b temporarily puts it in `data` |
| Health check | New controller | `/api/v1/health` returns DB status |
| Login rate limiting (shared storage + tiered response) | `src/auth/local.strategy.ts` → `@nestjs/throttler` / `rate-limiter-flexible` + Redis | **Landed (in-process memory)**: sliding window (15min) + dual dimensions of IP/account (account) + `trust proxy` for the real IP + graduated banning (30min/3h/24h ladder, see `local.strategy.ts`). **P3 TODO**: ① multi-instance shared storage (Redis; current in-process state is lost on restart and each replica counts separately); ② tiered response (CAPTCHA / added delay / notify the account owner, replacing pure hard bans); ③ gentler ban durations and refined thresholds (24h is currently too long and risks account-lockout DoS); ④ ban observability (structured logging/alerting); ⑤ coverage of renewal/send-message and other endpoints |
| File upload (large files / object storage) | `src/upload/*` (chat image upload + avatar `sharp` multi-size rewrite **already landed**) | **Landed**: chat image + avatar upload, returning `/uploads/...` URLs (chat images skip `sharp` to preserve GIF quality; avatars go through `sharp`); **TODO**: large-file chunking / object storage, rate limiting / concurrent memory / orphan cleanup (see the image-upload security roadmap) |

---

## 7. Appendix: Refactor Points → File Mapping

| Refactor Point | Files |
| --- | --- |
| Version prefix + CORS + serialization interceptor + helmet + global pipe/filter | [src/main.ts](../src/main.ts), [src/app.module.ts](../src/app.module.ts) |
| Exception filter | New `src/common/exception.filter.ts` |
| DTOs and validation | [src/controller/*](../src/controller/), new `src/common/dto/` |
| Response envelope consolidation | [src/model.ts](../src/model.ts), [src/controller/utils.ts](../src/controller/utils.ts) |
| Persist refresh to DB + bug fixes + secrets | [src/auth/auth.service.ts](../src/auth/auth.service.ts), [src/auth/constants.ts](../src/auth/constants.ts), [src/controller/auth.controller.ts](../src/controller/auth.controller.ts), [prisma/schema.prisma](../prisma/schema.prisma) |
| SSE downstream (auth / heartbeat / push / liveness / forced logout) | [src/gateway/events.controller.ts](../src/gateway/events.controller.ts) + [src/gateway/sse.service.ts](../src/gateway/sse.service.ts) |
| File upload | [src/upload/](../src/upload/) (`upload.controller` + `upload.service`; chat image upload implemented; avatar `sharp` multi-size rewrite shares `src/upload/`) |
| Frontend renewal single-flight + SSE reconnect backoff | [web/src/app/auth.interceptor.ts](../web/src/app/auth.interceptor.ts), [web/src/app/services/auth.service.ts](../web/src/app/services/auth.service.ts), [web/src/app/services/websocket.service.ts](../web/src/app/services/websocket.service.ts) (filename kept; internals switched to `@microsoft/fetch-event-source`) |
| Frontend type generation | [web/](../web/) (new openapi-typescript pipeline) |
