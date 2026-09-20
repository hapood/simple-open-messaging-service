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
- [Current Limitation](#current-limitation)

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
- **SSE handles "push"**: the server pushes **identity-only signals** one-way via SSE (`GET /api/v1/events`). Message and state bodies remain in durable HTTP-queryable feeds. SSE is a downstream-only channel — all client→server upstream business traffic goes through HTTP.

The web/admin SPAs are served by Caddy (not the app). `@fastify/static` serves only `/uploads/*` (auth-gated media). The app runs on Fastify (HTTP/1.1 plain, or HTTP/2-over-TLS when `TLS_CERT`/`TLS_KEY` are set), global prefix `/api/v1` (excluding `/.well-known/somfp`).

## Backend Module Responsibilities

The application root module [src/app.module.ts](../../src/app.module.ts) composes the
feature modules and controllers. Modules marked `@Global()` are shared app-wide.

| Module                           | Key Files                                                      | Responsibilities                                                                                                                                                                                                                                                          |
| -------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AuthModule**                   | [src/auth/](../../src/auth/)                                   | Opaque **SessionToken** issue/validate (`SessionTokenService` + `BearerAuthService`), login by password / OTP / QR, argon2 hashing, shared `BruteForceService` ban engine, the global `SessionAuthGuard` (`APP_GUARD`) and `SessionCookieInterceptor` (`APP_INTERCEPTOR`) |
| **UserModule**                   | [src/user/](../../src/user/)                                   | `UserService` — profile, registration, and friend/block helpers                                                                                                                                                                                                           |
| **GatewayModule**                | [src/gateway/](../../src/gateway/)                             | SSE downlink (`EventsController` + `SseService`): connection registry, heartbeat, `HELLO`, durable-feed/media wake-ups, ephemeral call coordination, and `FORCE_LOGOUT`; `CallStateRegistry` mirrors active-call state for `HELLO`                                        |
| **MessageModule**                | [src/message/](../../src/message/)                             | `MessageService` — message write (per-thread atomic `seq`) + paginated query primitives; durable thread fanout publishes compacted thread-feed snapshots and dispatches client wakes                                                                                      |
| **GroupModule**                  | [src/group/](../../src/group/)                                 | `GroupService` + `RolesGuard` — group create/invite/members/leave/kick/transfer/role/update                                                                                                                                                                               |
| **AccountThreadStateModule**     | [src/account-thread-state/](../../src/account-thread-state/)   | `AccountThreadStateService` (local AccountThreadState state and pair-derived P2P endpoints) + `ThreadAccessGuard`                                                                                                                                                         |
| **RelationshipModule**           | [src/relationship/](../../src/relationship/) | `RelationshipService` — directed relationship facts, pair reconciliation, and request projections; delegates roster writes to AccountThreadStateService                                                                                                                   |
| **UserBlockModule**              | [src/user-block/](../../src/user-block/)                       | `UserBlockService` — block/unblock state consumed by message fan-out + user queries                                                                                                                                                                                       |
| **UploadModule**                 | [src/upload/](../../src/upload/)                               | Media pipeline: `UploadService`, content-addressed `MediaAssetService` (sha256 CAS with reachability-based liveness), `MediaAccessService` (per-object authz), and validated byte-preserving avatar storage                                                               |
| **PushModule**                   | [src/push/](../../src/push/)                                   | `PushService` — FCM (Android) / Web Push dispatch; suppresses only the exact device session that owns a live SSE connection                                                                                                                                               |
| **FederationModule** (`@Global`) | [src/federation/](../../src/federation/)                       | Server-to-server protocol: identity/signatures, directional recognition, bounded Health scheduling, durable tasks, compacted per-peer state feed, message feeds, and media/message pull                                                                                   |
| **QuotaModule** (`@Global`)      | [src/quota/](../../src/quota/)                                 | `QuotaService` — unified daily-quota enforcement (local node + each federated peer); DB-atomic counters                                                                                                                                                                   |
| **CallsModule**                  | [src/calls/](../../src/calls/)                                 | `CallsService` — 1:1 audio/video call state machine (initiate/accept/ringing/connected/decline/cancel/end/signal) + inbound S2S frame bridge; server is signaling coordinator only (never media)                                                                          |
| **LinkPreviewModule**            | [src/link-preview/](../../src/link-preview/)                   | SSRF-safe OG fetch (`SafeFetchService`) + short-lived generation ownership and OpenGraph/CAS asset processing for `ContentType.LINK` cards                                                                                                                                |
| **ShellModule**                  | [src/shell/](../../src/shell/)                                 | `ShellService` — serves the web-shell manifest/bundle for the desktop Tauri wrapper (`/api/v1/shell/*`, incl. FCM runtime config via `compat`)                                                                                                                            |

Federation reachability checks use a dedicated scheduler. Each periodic round
scans eligible peers by domain, keeps at most 32 pending domains in memory, and
runs at most four Health requests concurrently. A new interval tick is
coalesced while the previous round remains active, so slow requests cannot
accumulate rounds. Concurrent callers for the same domain share one in-flight
Health request. The scheduler controls admission; the transport request still
uses the shared per-domain request slot and timeout.

A locally `degraded` peer retains its identity pin, recognition facts, and
business state, but the ordinary outbound data plane remains closed. Only
recognition recovery and Health probes continue; a successful authenticated
Health round trip clears the transport degradation and reopens ordinary
outbound traffic.

Federated address resolution has no mutating `ensure trust` operation. It reads
the two local recognition-direction facts, explicitly starts recognition only
when either fact is missing, and then checks signed Health once per second for
up to 30 seconds. An `available` or `degraded` Health result is the peer's
recognition acknowledgement, so the requester records the pending inbound fact
before evaluating its outbound readiness gate. Recognition and Health progress
is carried on the temporary resolve SSE; the client does not perform a separate
trust pre-flight request.
| **DiagnosticsModule** | [src/diagnostics/](../../src/diagnostics/) | `DiagnosticsService` + `DiagnosticsGcService` — client support-bundle list/download/GC |
| **AdminModule** | [src/admin/](../../src/admin/) | Admin console, `AdminAuthService` (opaque `AdminSession`, separate secret), TOTP 2FA, WebAuthn passkeys, dashboard, audit, management, GC, federation/quota controls, and `AdminAuditInterceptor` (`APP_INTERCEPTOR`) |
| **LoggerModule** | [src/logger/](../../src/logger/) | `nestjs-pino` multistream (stdout + rotating file + ring buffer) + admin `LogViewerService` |
| **KvStoreModule** (`@Global`) | [src/kv-store/](../../src/kv-store/) | In-process `Map` KV (`KvStoreService` — NOT Redis) backing the SessionToken validation cache + throttle counters |
| **SettingsModule** (`@Global`) | [src/settings/](../../src/settings/) | `SettingsService` — runtime settings facade plus fixed-file VAPID loading and key status |
| **DatabaseModule** (`@Global`) | [src/database/database.service.ts](../../src/database/database.service.ts) | Single shared Drizzle / `node-postgres` pool; `@Global` so every module injects the same instance |

> SOMS is **single-instance by design** — the in-process maps in `SseService`, `ThrottleGuard`, `BruteForceService`, `KvStoreService` are intentional (not a gap); there is no Redis layer, and multi-instance horizontal scaling is a non-goal.

### Global providers

- `APP_GUARD → SessionAuthGuard` ([src/auth/auth.module.ts](../../src/auth/auth.module.ts)) — every route is authenticated unless it opts out with `@Public()`.
- `APP_INTERCEPTOR → SessionCookieInterceptor` — re-issues the browser session cookie on sliding.
- `APP_INTERCEPTOR → AdminAuditInterceptor` — logs `@Audit`-tagged admin actions.
- `useGlobalPipes(ValidationPipe)` / `useGlobalFilters(AllExceptionsFilter)` / `useGlobalInterceptors(SerializeInterceptor)` — registered in [src/bootstrap.ts](../../src/bootstrap.ts).

HTTP routes use the `/api/v1` global prefix except for the SOMFP well-known
endpoint. The maintained route summaries are the [client/admin API](../api/api.md)
and the [SOMFP v1 HTTP surface](../../spec/v1/protocol.md#3-federation-v1-http-surface).

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
- `MessageRepository` (`message-repository.service.ts`) — sole issuer of message reads (`query-messages`). It advances each thread's query ceiling from committed thread-feed snapshots and reads/writes through `WebdbService`.
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

On connect, `SseService` pushes a `HELLO` frame carrying `stateFeedEndId`, `threadFeedEndId`, `activeCall`, `sessionId`, and `pushSubscriptionRev`. Metadata and relationship updates use the state feed; content, unread, mention, and preview snapshots use the thread feed. Each feed advances its own durable local cursor after a complete page commit. Session push registrations live directly in `SessionToken`; confirmed permanent delivery failures increment `pushSubscriptionRev` and notify only that session through `PUSH_SUBSCRIPTION_CHANGED`. The shared Web/Android coordinator recovers via live events or HELLO, without periodic synchronization.

### Heartbeat and Liveness

The server writes a `: ping` comment frame every 25s. SSE is one-way (no pong); disconnection is detected via `res.write` returning `false` → `res.end()` → the `close` callback cleans up. Liveness window ≤ 25s.

### Push Events

```
event: <EVENT_NAME>
data: <json>
```

| Event                      | Purpose                                           | Recovery source                            |
| -------------------------- | ------------------------------------------------- | ------------------------------------------ |
| `HELLO`                    | connection handshake and current high-water marks | sent on every connection                   |
| `STATE_FEED_UPDATED`       | identity-only Client State Feed wake `{ feedId }` | `HELLO.stateFeedEndId` + ranged state pull |
| `MEDIA_STATUS`             | media-localization completion wake                | message/media query                        |
| `CALL_EVENT`/`CALL_SIGNAL` | ephemeral call lifecycle and WebRTC signaling     | active-call snapshot/new negotiation       |
| `FORCE_LOGOUT`             | terminate a revoked session                       | authentication state                       |

Group/profile/friend/request/thread-setting/read/message-head state has no dedicated SSE event. The mutation
and its Client State Feed item commit first; SSE then carries only the coalesced `STATE_FEED_UPDATED` high
watermark. Coalescing is process-local and per account, and the highest observed `feedId` remains pending
until emitted rather than being limited to one fixed timer window.

### Reconnection Recovery

The SSE stream does not replay history (no `Last-Event-ID`). After a reconnect, the client catches up via HTTP
from its local Client State Feed cursor through `HELLO.stateFeedEndId`, then pulls per-thread message bodies up
to the message/tombstone ceilings in thread-feed snapshots. The native client retains SSE out of process and replays HELLO on wake.

## Core Business Flows

### Threads, Participants, and Invites

All conversations are `MessageThread` rows (`type` `P2P` or `GROUP`). A P2P
thread's identities are the source-correct `RelationshipPair` endpoints. Group
rosters use canonical Group Meta on the origin and a validated replica on a
mirror; the latest operation per member defines current state.
**`AccountThreadState`** is the optional
independent fact containing one local account's role, read, and presentation
state. Both tables reference the thread but never each other. Neither table
grants access. Passive federation query permission reads the publisher-authored
`RelationshipIntent`; mutually confirmed sends read `RelationshipPair.active`.
For a locally hosted group, peer content-head publication additionally uses the
current `ThreadAudience`. A remote-group mirror has no audience row: local
conversation state is represented by `AccountThreadState`, and outbound heads
are addressed directly to the authority recorded by the group.

Friend and group requests use the same pair of directed account facts. User/user
pairs become P2P relationships; user/group pairs become memberships; group/group
pairs are invalid. An unexpired source-authored `REQUESTED` grants the target
peer passive query access, but publishes no combined thread head until the
relationship is mutually confirmed. Initiating or accepting creates the local
placeholder and thread. Crossed requests and a valid
peer `ACCEPTED` both upgrade a matching local `REQUESTED` to `ACCEPTED`; an
already accepted direction creates no echo.
For a P2P request shell, both member rows can be materialized immediately;
their presence grants no permission. Sending and P2P friendship require both
directions to be effective (`ACCEPTED`, or `REQUESTED` before expiry). Group
membership uses the same mutual rule between the member and group identity.
Group capacity counts the effective group-authored direction independently of
whether the candidate has accepted.

The complete directed transition, pair-folding, crossed-request, revocation, renewal, and request
projection-side-effect rules are documented in the
[relationship intent state machine](./relationship-intent-state-machine.md).

The request badge is derived from the revision of the latest incoming
`RELATIONSHIP_INTENT/REQUESTED` in the unified state delta versus a per-device
seen revision stored in the local account database.

### Thread-list versioning

Profile changes, incoming requests, roster mutations, and paired message/tombstone heads share the client state feed.
`GET /user/state-feed` returns a bounded page after a consumer-owned cursor. The
client commits the page and its cursor atomically. Message bodies and tombstone
bodies are separate per-thread queries; tombstone queries begin only after that
chatbox opens.

### Message Sending

Message writes allocate their thread sequence and admit one durable thread-fanout
task in the same source transaction. The fanout executor processes the current
audience, checkpoints progress, and can yield to newer work. Each recipient's
transaction reuses the shared head writer to publish content ends, unread count,
mention position, and database preview references. Blocked recipients are skipped.
Committed thread-feed heads wake clients through SSE or device Push.

The message Push payload is `NEW_MESSAGE` plus `threadFeedEndId`, not a separate
notification snapshot. Page workers, native Rust, and the Push Service Worker use
the common thread-feed drain. Ordinary sync requests one preview; notification
sync requests up to five and stores only the newest preview. A target already
consumed by ordinary synchronization does not produce a second reminder.

### Read positions and unread badges

The viewport advances a local optimistic read position and submits explicit read
requests through the existing throttled path. The backend processes read changes
through durable tasks and publishes the resulting thread-feed snapshot. Clients
reconcile its server count using the known message-slot interval between server
and optimistic read positions, including tomb slots and excluding own messages.
Server read positions correct the optimistic projection rather than blindly
replacing it. There is no pending-read barrier or implicit read on message send.

Notification presentation consumes committed projections. Real login and logout
clear message notifications and pending navigation; ordinary cold restoration
preserves notification taps. Task execution checks the account lifetime, but
notification payloads and pending thread IDs do not carry an epoch.

### Local System Messages

The server writes local `SYSTEM` messages for client display. Supported events are `FRIEND_ADDED`, `FRIEND_REMOVED`,
`GROUP_JOINED`, `GROUP_LEFT`, `GROUP_ADMIN_GRANTED`, `GROUP_ADMIN_REVOKED`, and
`GROUP_OWNER_TRANSFERRED`; voluntary leave and removal both render as `GROUP_LEFT`.

These rows are server-authored presentation records, not business-state facts. They cannot be sent by a
client or used as commands. `FRIEND_ADDED` is written in the transaction that activates the relationship,
along with its client content heads. Only an inactive-to-active transition creates the notice; duplicate
requests and federation confirmations do not. A write failure rolls back the activation. The writer
reuses the held relationship parents and passes its thread content lock to the message service.
`FRIEND_REMOVED` is also transactional where its sequence establishes the retained-history visibility
boundary. Other notices may be appended on a best-effort basis after their authoritative state commits.
Client notifications remain best-effort after commit, and missed notifications are recoverable through
state-feed synchronization. Client parsing/rendering failures use a generic localized fallback.

### 1:1 Calls

`CallsController` (`/calls/*`) drives a state machine (initiate → ringing → connected → end; decline/cancel/signal). The server is a **signaling coordinator + lifecycle owner only** — it never touches media. On termination `CallsService` commits a local `SYSTEM / CALL_ENDED` notice on each participating server. Federated calls relay over signed S2S `/s2s/v1/call`. See the [Android calls client contract](../platform/android/calls.md).

### Federation

Two SOMS instances federate over HTTPS with RFC 9421-signed S2S requests (`FederationModule`). Identity is `user@domain`; state, Group Meta, message indexes, and tombstone indexes propagate through pull feeds plus lightweight feed-head hints, while media uses exact-message-authorized `/media/:digest` Range requests. Pinned peer identity and daily quotas bound the trust and traffic. The wire contract is defined exclusively by the [federation specification](../../spec/README.md).

## Current Limitation

`/user/query` allows batch queries of any non-deleted user's information without
relationship-level visibility isolation.
