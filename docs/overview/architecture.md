# Architecture Design

This document describes the system architecture, module responsibilities, authentication mechanism, real-time communication, and core business flows of SOMS.

## Table of Contents

- [Overall Architecture](#overall-architecture)
- [Backend Module Responsibilities](#backend-module-responsibilities)
- [Frontend Structure](#frontend-structure)
- [Unified Response Format](#unified-response-format)
- [Authentication Mechanism](#authentication-mechanism)
- [Real-time Communication (SSE Downstream)](#real-time-communication-sse-downstream)
- [Core Business Flows](#core-business-flows)
- [Known Issues and Improvements](#known-issues-and-improvements)

---

## Overall Architecture

```
┌───────────────────────────────┐        HTTP (POST)          ┌───────────────────────────────┐
│  Angular web client           │ ───────────────────────────▶│      NestJS Backend (:3000)    │
│  - Zoneless + Signals         │◀────────────────────────────│  - Fastify controllers (HTTP)  │
│  - IndexedDB repository layer │   unified {code,message,data}│  - Services (business)         │
│  - SSE in a Web Worker        │                             │  - Gateway (SSE downlink)      │
└──────────────┬────────────────┘                             └──────────────┬────────────────┘
               │                                                            │
               │  SSE  GET /api/v1/events (httpOnly cookie / Bearer)        │ Drizzle (@Global)
               └───────────────────────────────────────────────────────────▶│
                                                                            ▼
                                                                 ┌──────────────────────────┐
                                                                 │   PostgreSQL (+ Timescale)│
                                                                 └──────────────────────────┘
```

**Responsibility Separation Principle**

- **HTTP handles "writes and queries"**: registration, login, sending messages, querying history, creating groups, invites, calls, federation — all go through HTTP `POST` (JSON body; `multipart/form-data` for uploads).
- **SSE handles "push"**: the server pushes **identity-only signals** and the full message body one-way via SSE (`GET /api/v1/events`). SSE is a downstream-only channel — all client→server upstream business traffic goes through HTTP.

The web/admin SPAs are served by Caddy (not the app). `@fastify/static` serves only `/uploads/*` (auth-gated media). The app runs on Fastify (HTTP/1.1 plain, or HTTP/2-over-TLS when `TLS_CERT`/`TLS_KEY` are set), global prefix `/api/v1` (excluding `/.well-known/socfp`).

## Backend Module Responsibilities

The application root module [src/app.module.ts](../../src/app.module.ts) imports `EventEmitterModule.forRoot()` plus 23 in-project modules, and directly registers 13 controllers. Modules marked `@Global()` (7) are shared app-wide.

| Module                               | Key Files                                                                  | Responsibilities                                                                                                                                                                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AuthModule**                       | [src/auth/](../../src/auth/)                                               | Opaque **SessionToken** issue/validate (`SessionTokenService` + `BearerAuthService`), login by password / OTP / QR, argon2 hashing, shared `BruteForceService` ban engine, the global `SessionAuthGuard` (`APP_GUARD`) and `SessionCookieInterceptor` (`APP_INTERCEPTOR`) |
| **UserModule**                       | [src/user/](../../src/user/)                                               | `UserService` — profile, register, friend/block helpers, and peer-trust status                                                                                                                                                                                            |
| **GatewayModule**                    | [src/gateway/](../../src/gateway/)                                         | SSE downlink (`EventsController` + `SseService`): connection registry, heartbeat, `HELLO`, durable-feed and message/media wake-ups, ephemeral call coordination, and `FORCE_LOGOUT`; `CallStateRegistry` mirrors active-call state for `HELLO`                            |
| **MessageModule**                    | [src/message/](../../src/message/)                                         | `MessageService` — message write (per-thread atomic `seq`) + paginated query primitives; `MessageFanoutService` (global) does unified `NEW_MESSAGE` fan-out                                                                                                               |
| **GroupModule**                      | [src/group/](../../src/group/)                                             | `GroupService` + `RolesGuard` — group create/invite/members/leave/kick/transfer/role/update                                                                                                                                                                               |
| **ThreadParticipantModule**          | [src/thread-participant/](../../src/thread-participant/)                   | `ThreadParticipantService` (raw thread-roster mutator) + `ThreadAccessGuard` (membership guard reused by message/group routes)                                                                                                                                            |
| **InviteModule**                     | [src/invite/](../../src/invite/)                                           | `InviteService` — directed friend/group request facts, pair reconciliation and friend-request badge; delegates roster writes to ThreadParticipantService                                                                                                                  |
| **UserBlockModule**                  | [src/user-block/](../../src/user-block/)                                   | `UserBlockService` — block/unblock state consumed by message fan-out + user queries                                                                                                                                                                                       |
| **ThreadRevisionModule** (`@Global`) | [src/thread-revision/](../../src/thread-revision/)                         | maintains the per-user state cursor and compact thread/profile delta entries                                                                                                                                                                                              |
| **UploadModule**                     | [src/upload/](../../src/upload/)                                           | Media pipeline: `UploadService`, content-addressed `MediaAssetService` (sha256 CAS + refcount), `MediaAccessService` (per-object authz), `AvatarStackService` (sharp multi-size webp)                                                                                     |
| **PushModule**                       | [src/push/](../../src/push/)                                               | `PushService` — FCM (Android) / Web Push dispatch; skips recipients with a live SSE connection                                                                                                                                                                            |
| **FederationModule** (`@Global`)     | [src/federation/](../../src/federation/)                                   | Server-to-server protocol: identity/signatures, commands, compacted per-peer state feed, message miss feed, and media/message pull                                                                                                                                        |
| **QuotaModule** (`@Global`)          | [src/quota/](../../src/quota/)                                             | `QuotaService` — unified daily-quota enforcement (local node + each federated peer); DB-atomic counters                                                                                                                                                                   |
| **CallsModule**                      | [src/calls/](../../src/calls/)                                             | `CallsService` — 1:1 audio/video call state machine (initiate/accept/ringing/connected/decline/cancel/end/signal) + inbound S2S frame bridge; server is signaling coordinator only (never media)                                                                          |
| **LinkPreviewModule**                | [src/link-preview/](../../src/link-preview/)                               | SSRF-safe OG fetch (`SafeFetchService`) + short-lived generation ownership and OpenGraph/CAS asset processing for `ContentType.LINK` cards                                                                                                                                |
| **ShellModule**                      | [src/shell/](../../src/shell/)                                             | `ShellService` — serves the web-shell manifest/bundle for the desktop Tauri wrapper (`/api/v1/shell/*`, incl. FCM runtime config via `compat`)                                                                                                                            |
| **DiagnosticsModule**                | [src/diagnostics/](../../src/diagnostics/)                                 | `DiagnosticsService` + `DiagnosticsGcService` — client support-bundle list/download/GC                                                                                                                                                                                    |
| **AdminModule**                      | [src/admin/](../../src/admin/)                                             | Admin console: 13 controllers, `AdminAuthService` (opaque `AdminSession`, separate secret), TOTP 2FA, WebAuthn passkeys, dashboard, audit, manage, GC, federation/quota admin; `AdminAuditInterceptor` (`APP_INTERCEPTOR`)                                                |
| **LoggerModule**                     | [src/logger/](../../src/logger/)                                           | `nestjs-pino` multistream (stdout + rotating file + ring buffer) + admin `LogViewerService`                                                                                                                                                                               |
| **KvStoreModule** (`@Global`)        | [src/kv-store/](../../src/kv-store/)                                       | In-process `Map` KV (`KvStoreService` — NOT Redis) backing the SessionToken validation cache + throttle counters                                                                                                                                                          |
| **SettingsModule** (`@Global`)       | [src/settings/](../../src/settings/)                                       | `SettingsService` — runtime settings facade (VAPID, Firebase config, login mode, …)                                                                                                                                                                                       |
| **DatabaseModule** (`@Global`)       | [src/database/database.service.ts](../../src/database/database.service.ts) | Single shared Drizzle / `node-postgres` pool; `@Global` so every module injects the same instance                                                                                                                                                                         |

> SOMS is **single-instance by design** — the in-process maps in `SseService`, `ThrottleGuard`, `BruteForceService`, `KvStoreService` are intentional (not a gap); there is no Redis layer, and multi-instance horizontal scaling is a non-goal.

### Global providers

- `APP_GUARD → SessionAuthGuard` ([src/auth/auth.module.ts](../../src/auth/auth.module.ts)) — every route is authenticated unless it opts out with `@Public()`.
- `APP_INTERCEPTOR → SessionCookieInterceptor` — re-issues the browser session cookie on sliding.
- `APP_INTERCEPTOR → AdminAuditInterceptor` — logs `@Audit`-tagged admin actions.
- `useGlobalPipes(ValidationPipe)` / `useGlobalFilters(AllExceptionsFilter)` / `useGlobalInterceptors(SerializeInterceptor)` — registered in [src/bootstrap.ts](../../src/bootstrap.ts).

### Controllers Overview

All sit under `/api/v1` (set in `bootstrap.ts`). Most use `@Controller()` with the full path on each method.

| Controller                          | File                                                                                                                                                                | Route prefix / key routes                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AuthController                      | [src/controller/auth.controller.ts](../../src/controller/auth.controller.ts)                                                                                        | `auth/login` (password), `auth/logout`, `auth/logout-all`, `auth/change-password`, `auth/set-password`, `auth/sessions`, `auth/revoke-session`                  |
| AuthOtpController                   | [src/controller/auth-otp.controller.ts](../../src/controller/auth-otp.controller.ts)                                                                                | `auth/otp/login`                                                                                                                                                |
| AuthQrController                    | [src/controller/auth-qr.controller.ts](../../src/controller/auth-qr.controller.ts)                                                                                  | `auth/qr/{create,poll,scan,confirm}`                                                                                                                            |
| UserController                      | [src/controller/user.controller.ts](../../src/controller/user.controller.ts)                                                                                        | `user/{register,my-profile,update-avatar,update-profile,query-state/delta,delete-friend,block,query,peer-trust-status,resolve,search,thread-info}`              |
| MessageController                   | [src/controller/message.controller.ts](../../src/controller/message.controller.ts)                                                                                  | `send-message`, `send-media`, `query-messages`, `thread/{by-user-id,mark-read,set-muted,set-pinned,clear-history,set-alias}`, `search-messages`, `media-status` |
| GroupController                     | [src/controller/group.controller.ts](../../src/controller/group.controller.ts)                                                                                      | `group/{create,invite,info,members,leave,kick,transfer,set-role,update}`                                                                                        |
| InviteController                    | [src/controller/invite.controller.ts](../../src/controller/invite.controller.ts)                                                                                    | `invite/{friend,accept,reject,revoke,incoming,outgoing,detail,mark-read}`                                                                                       |
| DeviceController                    | [src/controller/device.controller.ts](../../src/controller/device.controller.ts)                                                                                    | `devices/register` (POST), `devices/register/:token` (DELETE)                                                                                                   |
| NotificationController              | [src/controller/notification.controller.ts](../../src/controller/notification.controller.ts)                                                                        | `notifications/{vapid-key,missed-summary,missed,action}`                                                                                                        |
| CallsController                     | [src/controller/calls.controller.ts](../../src/controller/calls.controller.ts)                                                                                      | `calls/{initiate,accept,ringing,connected,decline,cancel,end,signal,ice-servers,:callSid/signaling}`                                                            |
| ShellController                     | [src/shell/shell.controller.ts](../../src/shell/shell.controller.ts)                                                                                                | `shell/{compat,web-manifest,web-bundle}`                                                                                                                        |
| HealthController / ConfigController | [src/controller/health.controller.ts](../../src/controller/health.controller.ts) · [src/controller/config.controller.ts](../../src/controller/config.controller.ts) | `health` / `config` (both `@Public`, GET)                                                                                                                       |
| EventsController                    | [src/gateway/events.controller.ts](../../src/gateway/events.controller.ts)                                                                                          | `GET /events` (SSE stream)                                                                                                                                      |

Admin routes (`admin/*`) and federation routes (`s2s/*`, `.well-known/socfp`) are registered inside their own modules; see [api.md](../api/api.md) and [federation-s2s-api.md](../api/federation-s2s-api.md).

## Frontend Structure

The web client is an Angular (zoneless + Signal-driven) SPA. It runs in three shells — browser, Tauri desktop, and Android WebView — selected at runtime by [web/src/app/services/runtime.ts](../../web/src/app/services/runtime.ts).

**Bootstrap & global config** [web/src/app/app.config.ts](../../web/src/app/app.config.ts)

- `provideZonelessChangeDetection()` — no zone.js.
- `provideHttpClient(withFetch(), withInterceptorsFromDi(), withInterceptors([correlationIdInterceptor, httpTraceInterceptor]))` + a `TauriHttpBackend` override (under Tauri, `/api/v1` is routed through Rust's `api_request` IPC; in the browser it delegates to the stock fetch backend).
- `provideTransloco` (en + zh-CN), `provideServiceWorker('ngsw-worker.js')` (PWA, prod + non-Tauri), `provideAnimationsAsync()` (Angular animations retained; `motion` is used per-component for spring physics).
- An `APP_INITIALIZER` calls `AuthService.restoreSession()` before the router resolves (restores a native trusted-device session from OS secure storage on cold start; no-op on browser).

**Auth on the web client** — JS **never holds the credential**. The browser authenticates via the **httpOnly session cookie** (auto-attached same-origin; `SessionCookieInterceptor` re-issues it on sliding). Login state in JS is a boolean read from a non-httpOnly `logged_in` presence cookie. Under the Tauri/Android shell the Rust/Kotlin transport injects the `Authorization: Bearer` header from OS secure storage. The `AuthInterceptor` ([web/src/app/auth.interceptor.ts](../../web/src/app/auth.interceptor.ts)) attaches **no** credential — it only catches 401 and triggers re-login (`redoLoginAuth`); there is no token renewal.

**Repository layer (3-tier: UI ↔ repositories ↔ backend)** [web/src/app/services/](../../web/src/app/services/)

- `WebdbService` — IndexedDB primitive, per-user DB (`soms-webdb-u<userId>`), object stores for messages / threads / avatars / profiles / meta.
- `MessageRepository` (`message-repository.service.ts`) — sole issuer of message reads (`query-messages`) and sole consumer of the `NEW_MESSAGE` body cache; reads/writes through `WebdbService`.
- `ThreadRepository` (`thread-store.service.ts`) — conversation/thread tier. The web client is **local-first**: on chat open it renders from IndexedDB, then reconciles with SSE + HTTP in the background (the production loading skeleton is only a cold-cache fallback).

**Realtime transport** — `WebsocketService` (filename retained) is now a **facade** over three pluggable `RealtimeTransport` implementations ([realtime-transport.ts](../../web/src/app/services/realtime-transport.ts)): `WorkerSseTransport` (browser — SSE parsed inside `sse.worker.ts`, a Web Worker, off the main thread), `RustChannelSseTransport` (Tauri desktop — Rust-side supervisor), `NativeEventTransport` (Android — Kotlin `/events` bridge).

**Virtual scroll kernel** — the message list is driven by `ChatBoxScroller` ([web/src/app/lib/chat-box/chat-box-scroller.ts](../../web/src/app/lib/chat-box/chat-box-scroller.ts)), a framework-agnostic, array-index + source-driven kernel with manual scrollTop compensation. It pulls data asynchronously through `HttpItemSource`.

**Component layer** — ~90+ standalone components across chat surface, responsive desktop shell, mobile shell, auth, settings/profile, calls, threads/groups, media viewers, and shared primitives. The UI consumes **Angular Material** (`@angular/material` ^20) with a layer of custom Material-styled components on top.

## Unified Response Format

All HTTP endpoints return the `ApiResult` envelope ([src/common/api-result.ts](../../src/common/api-result.ts)):

```ts
interface ApiResult<T = any> {
  code: number; // 0 = success; non-0 = business error code (segmented by domain)
  message: string;
  data?: T;
  hasMore?: boolean; // populated by paginated endpoints
}
```

Business results always return HTTP 200 + `code`; only unauthenticated (401) / not found (404) / conflict (409) / server error (500) retain HTTP status codes for broad categories (DTO validation failures are folded into the business flow as 200 + `10000`). **Business codes are segmented by domain** (`10xxx` general / `20xxx` friend·invite / `30xxx` message / `40xxx` group / `50xxx` federation / `60xxx` push / `70xxx` call); full definitions in [src/common/business-code.ts](../../src/common/business-code.ts), summarized in [api.md → Business Error Codes](../api/api.md#business-error-codes).

> Serialization is handled uniformly by the global `SerializeInterceptor` ([src/common/serialize.interceptor.ts](../../src/common/serialize.interceptor.ts)): `Date → millisecond timestamp`, `BigInt → string`.

## Authentication Mechanism

### Session Token Model (single credential)

SOMS uses **one opaque, per-device session credential** (`SessionToken`) — there is **no access/refresh JWT pair** for users. The plaintext token is returned once at login, stored as a sha256 hash in the `SessionToken` table, and presented by the client on every authenticated request.

| Aspect     | Detail                                                                                                                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token      | opaque `randomBytes(32)`; sha256-hashed at rest; plaintext shown once                                                                                                                                                                                          |
| Transport  | browser/desktop: **httpOnly cookie** (auto-attached same-origin, JS-unreadable); native (`app`): **`Authorization: Bearer`** header                                                                                                                            |
| Lifetime   | **TRUSTED** device (token in OS secure storage — native app by default, or desktop opting into OS keyring): `expiresAt = NULL` (revocation-only). **UNTRUSTED** (browser, or desktop not opting in): sliding 14-day deadline, extended on use via `lastSeenAt` |
| Revocation | a DB row flip (`revokedAt` + `revokeReason`); logout / logout-all / password-change / admin-disable / admin-purge                                                                                                                                              |
| Validation | `BearerAuthService` resolves the token; the global `SessionAuthGuard` authenticates every route unless `@Public()`                                                                                                                                             |

Admin auth is physically separate (its own `adminSecret`, opaque `AdminSession` rows in the `AdminSession` table) but shares the account namespace — an admin is a linked profile on a `User` row.

### Login (three methods, all platforms)

1. **Password** `POST /auth/login` (`{ account, password }`) → `LocalStrategy` + `PasswordHasherService` (argon2) → `BruteForceService` (shared engine: ip/user dims, sliding window + graduated ban ladder).
2. **OTP** `POST /auth/otp/login` — admin-issued one-time login code (argon2-hashed `LoginCode`, single-use) → mints an `app` session.
3. **QR** `POST /auth/qr/{create,poll,scan,confirm}` — desktop shows a QR; an already-logged-in device scans it to delegate login.

On success each path issues a `SessionToken` and returns `{ sessionToken }`. Failure codes: `10003` unauthenticated, `10005` rate-limited/banned (+ `data.bannedUntil`), `10009` invalid credentials, `10012-10016` OTP/QR invalid/expired/consumed, `10017` password-not-set (OTP/QR-only account), `10018` must-change-password.

### Session management

- `POST /auth/sessions` lists the user's active sessions; `POST /auth/revoke-session` revokes one.
- `POST /auth/logout` revokes the current session; `POST /auth/logout-all` revokes **all** of the user's sessions.
- `POST /auth/change-password` / `set-password` rotate the password and revoke other sessions. All revocations also force-disconnect the user's SSE connections (`FORCE_LOGOUT`).

There is **no renew endpoint** — a long-lived session token needs no rotation; a revoked/expired token yields `10007` (`SESSION_REVOKED`) and the client re-logs in.

## Real-time Communication (SSE Downstream)

**Endpoint** [src/gateway/events.controller.ts](../../src/gateway/events.controller.ts) + [src/gateway/sse.service.ts](../../src/gateway/sse.service.ts): `GET /api/v1/events` (`text/event-stream`, same port as HTTP). SSE is a one-way downstream channel — push-only; all client upstream goes through HTTP.

### Connection Authentication

Authentication reuses the same credential as HTTP — the global `SessionAuthGuard` resolves the **session token** (cookie or `Bearer` header). `EventsController.stream()` hijacks the Fastify reply, hands the raw response to `SseService.register(userId, res)`, which writes the stream headers, flushes a leading `: connected` comment, records the connection, and starts the heartbeat. Authentication failure → HTTP 401 (no frame); the client reconnects.

### HELLO handshake

On connect, `SseService` pushes a `HELLO` frame carrying the newest-message cursor, `stateRevision`, and `activeCall`. The state range includes PROFILE, CLIENT_STATE, and thread ADD/DELETE entries. HELLO is load-bearing because state catch-up and missed-summary recovery start from durable local cursors.

### Heartbeat and Liveness

The server writes a `: ping` comment frame every 25s. SSE is one-way (no pong); disconnection is detected via `res.write` returning `false` → `res.end()` → the `close` callback cleans up. Liveness window ≤ 25s.

### Push Events

```
event: <EVENT_NAME>
data: <json>
```

| Event                      | Purpose                                            | Recovery source                           |
| -------------------------- | -------------------------------------------------- | ----------------------------------------- |
| `HELLO`                    | connection handshake and current high-water marks  | sent on every connection                  |
| `STATE_REV_UPDATED`        | identity-only unified client-state wake            | `HELLO.stateRevision` + ranged state pull |
| `NEW_MESSAGE`              | identity-only message wake `{ threadId, seq, ts }` | missed-message/message query              |
| `DELETED_MESSAGE_UPDATED`  | identity-only deletion-log wake                    | deletion HWM/log                          |
| `MEDIA_STATUS`             | media-localization completion wake                 | message/media query                       |
| `CALL_EVENT`/`CALL_SIGNAL` | ephemeral call lifecycle and WebRTC signaling      | active-call snapshot/new negotiation      |
| `FORCE_LOGOUT`             | terminate a revoked session                        | authentication state                      |

Group/profile/friend/request/thread-setting/read state has no dedicated SSE event. The mutation and its
client-state revision commit atomically; SSE then carries only `STATE_REV_UPDATED`.

### Reconnection Recovery

The SSE stream does not replay history (no `Last-Event-ID`). After a reconnect, the client catches up via HTTP from `stateRevision`, then pulls per-thread messages from its message cursors. The native client retains SSE out of process and replays HELLO on wake.

## Core Business Flows

### Threads, Participants, and Invites

All conversations are `MessageThread` rows (`type` `P2P` or `GROUP`). Membership is **`ThreadParticipant`** — one row per (user, thread) carrying `lastReadSeq`, `role` (GROUP only), `muted`, `pinned`, `clearedSeq`, `alias`, `leftAt`. There is no longer a polymorphic `UserMessageThread` or a separate `GroupMember` table.

Friend and group requests are stored as independent directed facts:

- **FRIEND**: `FriendRequest(A,B)` and `FriendRequest(B,A)` retain separate notes and revisions. Both
  must explicitly be `FRIEND` to activate the canonical `FriendPair` and P2P thread; an unexpired
  `REQUESTED` row alone never grants messaging. Requests expire after seven days; accepting advances
  the local direction and confirmation returns through the state feed, not a special S2S command.
- **GROUP**: `GroupMembershipRequest` stores GROUP→USER invitation and USER→GROUP join directions. The
  group origin remains authoritative and activates mirrors through `GROUP_META`.

The friend-request badge is derived from the revision of the latest incoming REQUESTED `P2P_INTENT` in the unified state delta versus a per-device seen revision stored in the local account database.

### Thread-list versioning

Profile changes, incoming friend requests, and roster mutations share the public `stateRevision` cursor. `POST /user/query-state/delta` returns a range. The client commits state data plus its cursor atomically; missed-summary rows and their cursor are committed in a separate atomic transaction.

### Message Sending

`POST /send-message` (`{ threadId, content, contentType?, clientMessageId? }`) → `MessageService.writeMsgToThread()`:

1. `ThreadAccessGuard` validates membership (P2P additionally that the peer is an active participant).
2. Allocates a per-thread `seq` atomically (`UPDATE curSeq = curSeq + 1 RETURNING`) inside the create tx — gapless, no retry loop.

### Read HWM and unread badges

The message viewport records a monotonically increasing local read HWM only after a message is fully visible
and the viewport has been stable for 500 ms. It does not calculate or optimistically clear unread badges.
On chat close or thread switch, the client submits that HWM to `POST /thread/mark-read`; one PostgreSQL
statement takes the maximum with the stored cursor and returns the authoritative capped count and mention set.

While that request is in flight, the thread-list badge breathes and the client buffers only the newest
`NEW_MESSAGE` SSE for that thread. After the response (or failure), it replays the buffered signal through the
normal missed-summary pull, so the server remains the only unread-count authority.

Two consistency boundaries are deliberate:

- A crash or OS kill before normal chat close may lose the in-memory local HWM; restart uses server state.
- Read state is not broadcast by a dedicated SSE. Other devices converge on their next existing unread pull,
  reconnect, or restart rather than clearing immediately.

3. `MessageFanoutService` pushes `NEW_MESSAGE` to all participants via SSE (full body) + fires push for offline recipients.
4. `clientMessageId` is the send-idempotency key (a retry returns the original message). `contentType` spans `PURE_TEXT / IMAGE / VIDEO / FILE / AUDIO / LINK / CALL` (media sends go through `/send-media` + the CAS pipeline; `CALL` is server-authored only).

### Local System Messages

After an authoritative friend or group-state transaction commits, the server may best-effort append a
local `SYSTEM` message for client display. Supported events are `FRIEND_ADDED`, `FRIEND_REMOVED`,
`GROUP_JOINED`, `GROUP_LEFT`, `GROUP_ADMIN_GRANTED`, `GROUP_ADMIN_REVOKED`, and
`GROUP_OWNER_TRANSFERRED`; voluntary leave and removal both render as `GROUP_LEFT`.

These rows are server-authored presentation records, not business-state facts. They cannot be sent by a
client or used as commands. Generation failures are logged without rolling back the committed state, and
client parsing/rendering failures are logged and replaced with a generic localized fallback.

### 1:1 Calls

`CallsController` (`/calls/*`) drives a state machine (initiate → ringing → connected → end; decline/cancel/signal). The server is a **signaling coordinator + lifecycle owner only** — it never touches media. On termination `CallsService` authors a terminal `ContentType.CALL` chat bubble (bilateral). Federated calls relay over signed S2S `/s2s/v1/call`. See [docs/android-calls-client.md](../android-calls-client.md) and [docs/roadmap/android-calls-followup.md](../roadmap/android-calls-followup.md).

### Federation

Two SOMS instances federate over HTTPS with RFC 9421-signed S2S requests (`FederationModule`). Identity is `user@domain`; state and messages propagate through two pull feeds plus a lightweight revision hint, while media uses exact-message-authorized `/media/:digest` Range requests. Pinned peer identity and daily quotas bound the trust and traffic. See [federation-protocol.md](./federation-protocol.md).

## Known Issues and Improvements

> Items found during code review that affect integration and deployment. Several early items record the P0/P1 hardening of the _original_ dual-JWT auth model, which has since been **entirely replaced by the single SessionToken model** above — read those as historical milestones, not the current design.

1. ~~**Hardcoded secrets**~~ ✅ Fixed (P0): secrets externalized; auto-generated at first startup under `./data/` when unset. (The subsequent SessionToken rewrite removed the access/refresh secrets entirely for users.)
2. ~~**refresh_token stored only in memory**~~ ✅ Fixed (P0): persisted as a sha256 hash, revocable, rotating. (Later superseded: the dual access/refresh pair was replaced by the single opaque `SessionToken`.)
3. ~~**`NotifyModule` not wired up**~~ ✅ Resolved: notification state uses unified revisions plus device-local read cursors; there is no `NotifyModule` to wire up.
4. ~~**File upload**~~ ✅ Implemented: `UploadModule` provides `/upload` + `/send-media` through the content-addressed (sha256 CAS, refcounted `MediaAsset`) pipeline, and `/user/update-avatar` (sharp multi-size webp). Per-user rate limiting / orphan cleanup remain a deferred hardening item.
5. ~~**Frontend authGuard not in effect**~~ ✅ Fixed: route guards are mounted (auth/guest).
6. **`/user/query` privacy**: allows batch queries of any non-deleted user's information with no relationship-level visibility isolation. (Open.)
7. ~~**`Date.prototype.toJSON` global override**~~ ✅ Removed (P1): replaced by the global `SerializeInterceptor`.
