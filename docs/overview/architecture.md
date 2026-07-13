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
│  Angular 18 Frontend (web)    │ ───────────────────────────▶│      NestJS Backend (:3000)    │
│  - Standalone + Signal        │◀────────────────────────────│  - Controllers (HTTP)          │
│  - Custom Material components │        HTTP response        │  - Services (business)         │
│  - SSE client                 │                             │  - Gateway (SSE downstream)    │
└───────────────────────────────┘                             └──────────────┬────────────────┘
        │                                                                      │
        │   SSE (GET /api/v1/events, Authorization: Bearer JWT)                │ Prisma
        └────────────────────────────────────────────────────────────────────▶│
                                                                               ▼
                                                                    ┌──────────────────┐
                                                                    │   PostgreSQL     │
                                                                    └──────────────────┘
```

**Responsibility Separation Principle**

- **HTTP handles "writes and queries"**: Registration, login, sending messages, querying history, creating groups, invitations, etc. all go through HTTP `POST`.
- **SSE handles "push"**: The server pushes the **complete message body** one-way via SSE (`GET /api/v1/events`); the client renders it on receipt with no secondary fetch required. SSE is a downstream-only channel — all client→server upstream business traffic (sending messages, future typing) goes through HTTP.

## Backend Module Responsibilities

The application root module [src/app.module.ts](../../src/app.module.ts) imports `EventEmitterModule`, `RedisModule`, `AuthModule`, `UserModule`, `GatewayModule`, `MessageModule`, `GroupModule`, `UploadModule`, and `AdminModule`; controllers are declared within their respective modules (the root module directly registers `MessageController` / `AuthController` / `UserController` / `GroupController`).

| Module | Key Files | Responsibilities |
| --- | --- | --- |
| **AuthModule** | [src/auth/](../../src/auth/) | Passport `local` + `jwt` strategies, JWT dual-token generation and validation, argon2 password hashing, login-failure IP banning |
| **UserModule** | [src/user/](../../src/user/) | User registration (transactional creation of User + UserExtra + userNotiBox), user queries, thread queries |
| **MessageModule** | [src/message/](../../src/message/) | Message writing and paginated queries, **friend request state machine** (`makeFriendRequest` / `approveFriendRequest`) |
| **GroupModule** | [src/group/](../../src/group/) | Group CRUD, member management, issuing and decoding group invitation JWT tokens |
| **GatewayModule** | [src/gateway/](../../src/gateway/) | SSE downstream push (`EventsController` + `SseService`): connection registration, heartbeat, new-message push, forced logout, online connection snapshots |
| **UploadModule** | [src/upload/](../../src/upload/) | Chat image upload (`/upload`, magic-number validation), avatar `sharp` multi-size webp rewriting |
| **AdminModule** | [src/admin/](../../src/admin/) | Independent admin account system (`Admin` / `AdminRefreshToken`) + user/thread/ban/reuse-alert management endpoints |
| **RedisModule** | [src/redis/](../../src/redis/) | Redis client wrapper (access jti blacklist, etc.) |
| **PrismaService** | [src/prisma.service.ts](../../src/prisma.service.ts) | `PrismaClient` wrapper, auto-connects on `onModuleInit` |

> Unimported modules: Only `NotifyModule` is not yet imported into `AppModule` (`UserManageModule` has been activated by `AdminModule` for `admin/users`; `UploadModule` is already wired up, so image/avatar upload is available). See [Known Issues](#known-issues-and-improvements).

### Controllers Overview

| Controller | File | Endpoint Prefix |
| --- | --- | --- |
| AuthController | [src/controller/auth.controller.ts](../../src/controller/auth.controller.ts) | `/auth/*` |
| UserController | [src/controller/user.controller.ts](../../src/controller/user.controller.ts) | `/user/*` |
| MessageController | [src/controller/message.controller.ts](../../src/controller/message.controller.ts) | `/send-message`, `/query-messages`, `/thread/by-user-id` |
| GroupController | [src/controller/group.controller.ts](../../src/controller/group.controller.ts) | `/group/*` |
| UploadController | [src/upload/upload.controller.ts](../../src/upload/upload.controller.ts) | `/upload` (images), `/user/update-avatar` (avatar) |
| AdminController | [src/admin/admin.controller.ts](../../src/admin/admin.controller.ts) | `/admin/*` (independent admin JWT, `AdminAuthGuard`) |
| EventsController | [src/gateway/events.controller.ts](../../src/gateway/events.controller.ts) | `GET /events` (SSE downstream stream, reuses `JwtAuthGuard`) |

## Frontend Structure

The frontend is an Angular 18 standalone application using experimental Zoneless change detection + Signal-driven reactivity.

**Bootstrap & Global Config** [web/src/app/app.config.ts](../../web/src/app/app.config.ts)

- `provideExperimentalZonelessChangeDetection()` — no zone.js
- `AuthInterceptor` — HTTP interceptor, auto-injects `Bearer <access_token>`, auto-renews on 401
- `provideRouter(routes, withComponentInputBinding())`
- `provideHttpClient(withInterceptorsFromDi())`

**Service Layer** [web/src/app/services/](../../web/src/app/services/)

| Service | Responsibilities |
| --- | --- |
| `AuthService` | Login/logout, token storage and auto-renewal; access_token in memory (BehaviorSubject), refresh_token in storage |
| `WebsocketService` | SSE downstream channel (`@microsoft/fetch-event-source`, filename retained): stream establishment / exponential-backoff reconnect / 401 renewal reopen / forwards `NEW_MESSAGE`·`FORCE_LOGOUT`; emits `reconnect$` on disconnect to trigger cursor-based catch-up fetch |
| `UserService` | Registration, profile, friend requests, thread queries |
| `MsgService` | Send messages, query history |
| `GroupService` | Create/invite/join groups |
| `RouteService` | Page navigation + dialog stack (dialogs are pushed onto browser history, so Back closes them) |

**Component Layer** A total of 25 standalone components: 6 page components (home / login / register / forbidden / 404 / navigator) + 19 business/UI components. The highlight is `MsgGroupFactory` — a virtual-scroll engine providing message grouping + on-demand loading + height pre-computation + scroll-position maintenance. The UI is built entirely with custom Material-style components (buttons/inputs/checkboxes/dialogs/menus/progress bars/icons/avatars), with no dependency on Angular Material.

## Unified Response Format

All HTTP endpoints return the `ApiResult` envelope (since P1a the `status` field has been renamed to `code`; see [src/common/api-result.ts](../../src/common/api-result.ts)):

```ts
interface ApiResult<T = any> {
  code: number;      // 0 = success; non-0 = business error code (segmented by domain)
  message: string;
  data?: T;
  hasMore?: boolean; // populated by paginated endpoints
}
```

Business results always return HTTP 200 + `code`; only unauthenticated (401) / not found (404) / conflict (409) / server error (500) retain HTTP status codes for broad categories (DTO parameter validation failures are also folded into the business flow as 200 + `10000`). **Business codes are segmented by domain** (`10xxx` general / `20xxx` friend·state machine / `30xxx` message / `40xxx` group); see [api.md → Business Error Codes](../api/api.md#business-error-codes).

> Serialization is handled uniformly by the global `SerializeInterceptor` ([src/common/serialize.interceptor.ts](../../src/common/serialize.interceptor.ts)): `Date → millisecond timestamp`, `BigInt → string`. P1 removed the former `Date.prototype.toJSON` global hack and the manual `convertBigIntId()`.

## Authentication Mechanism

### Dual-Token Model

| Token | Payload | Validity | Signing Secret | Frontend Storage |
| --- | --- | --- | --- | --- |
| access_token | `{ sub, jti, tokenVersion, device }` | 15 minutes | `JWT_ACCESS_SECRET` | Memory (BehaviorSubject, lost on refresh) |
| refresh_token | Family-based (familyId + rotation + reuse detection) | 14 days | `JWT_REFRESH_SECRET` (separate from access) | `sessionStorage` (don't stay logged in) / `localStorage` (stay logged in) |

> ✅ P0 persisted to DB: refresh_token is stored as a sha256 hash in the `RefreshToken` table (`userId / tokenHash / device / expiresAt / revokedAt`); it survives restarts, is revocable, and rotates on renewal. Access and refresh use separate secrets (`JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`).

### Login Flow (Local Strategy)

1. `POST /auth/login` (body: `account`, `password`) → `LocalAuthGuard` → `LocalStrategy.validate()`.
2. **IP ban check**: Looks up the in-memory `_ipBlackDict[ip]`; if not yet unbanned, the request is rejected outright.
3. `AuthService.validateUser()`: Looks up the user, then verifies the password with `argon2.verify`.
4. **Failure counting and banning** ([src/auth/local.strategy.ts](../../src/auth/local.strategy.ts)): Cumulative failures `>3` bans for 30 minutes, `>6` bans for 3 hours, `>9` bans for 24 hours; records older than 2 days are purged every 24 hours.
5. On success, returns access + refresh; wrong credentials return `code:10003`; IP ban returns `code:10005` + `data.bannedUntil`.

### JWT Validation (Jwt Strategy)

- `JwtStrategy` extracts the token from `Authorization: Bearer <token>`, and after decoding attaches `{ userId: payload.sub }` to `req.user`.
- Controllers access `req.user.userId` via `@Req() req`.

### Renewal and Logout

- `POST /auth/renew-access` / `POST /auth/renew-refresh`: The two are synonymous — a **full family-based rotation** using the refresh_token (the old refresh is marked `rotated`, and a new access + new refresh are issued); if reuse is detected, `code:10006` revokes the entire family at the root. The frontend uniformly calls only `renew-access`.
- `POST /auth/logout` (public, refresh in body): Sets the refresh `revokeReason='logout'`; optionally pass `accessJti` to immediately add the current access to the jti blacklist.
- `POST /auth/logout-all` / `change-password` / admin kick: `invalidateAllSessions` bumps `tokenVersion` (all access tokens immediately invalidated) + revokes all refresh tokens, and disconnects all of the user's SSE connections via the `auth.sessions-invalidated` event.

### Frontend Coordination

- `AuthInterceptor`: Injects the `Bearer` header for non-public requests (public paths are determined by a URL whitelist; the former `Authorization:'public'` marker is deprecated); when there is no token, it proactively drives `renewAccessToken()` (with a definite endpoint, never hanging forever); on 401, it single-flights a renew and retries once (capped, non-recursive).
- Renewal: `AuthService.renewAccessToken()` single-flights (`shareReplay` bufferSize:1 + refCount + finalize); concurrent callers share the same in-flight request; on success it swaps in a new access + rotates refresh, on failure (`10006` / `10003`) it triggers `redoLoginAuth` to force re-login. The old 7-day timer / `renewRefreshToken` mechanism has been removed.

## Real-time Communication (SSE Downstream)

**Endpoint** [src/gateway/events.controller.ts](../../src/gateway/events.controller.ts) + [src/gateway/sse.service.ts](../../src/gateway/sse.service.ts): `GET /api/v1/events` (`text/event-stream`, same port 3000 as HTTP). SSE is a one-way downstream channel — push-only; all client business upstream (sending messages, future typing) goes through HTTP.

### Connection Authentication

Authentication reuses the same `JwtAuthGuard` as normal protected routes (signature verification + expiry + jti blacklist + `tokenVersion` revocation awareness); the token travels in the `Authorization: Bearer <access_token>` header, **never in the URL**:

1. `EventsController.stream()` takes `req.user.userId` and calls `SseService.register(userId, res)`.
2. `register`: Writes the streaming response headers (`X-Accel-Buffering: no` to prevent Nginx batching) → flushes the leading `: connected` comment frame → records into `clients[userId]` (an array; one user may have multiple connections) → starts the heartbeat.
3. Authentication failure: `JwtAuthGuard` throws 401 directly (**no `AUTH` frame**); the frontend `onopen` handler renews and reopens on receipt.

### Heartbeat and Liveness Detection

The server writes a `: ping` comment frame every 25s (< Nginx `proxy_read_timeout` 60s). SSE is one-way with no pong; disconnection is detected via `res.write` returning `false` (peer gone / backpressure) → `res.end()` → the `close` callback cleans up the connection and heartbeat. The liveness-detection window is ≤ 25s, with `res.on('close')` as a cleanup backstop.

### Push Events

`SseService.onNewMessage(userId, data)` pushes the **complete message body** to all of the target user's connections (`serializeBody({ threadId, ...message })`, BigInt→string / Date→ms, same serialization as HTTP responses):

```
event: NEW_MESSAGE
id: <msgId>
data: {"threadId":1,"id":"123","content":"...","createdAt":1719000000000,...}
```

The frontend can render directly on receipt, **with no secondary `query-messages` fetch**. It is invoked by `MessageController` (pushes both parties for P2P / all members for groups) after writing the message.

`FORCE_LOGOUT`: `SseService` listens for the `auth.sessions-invalidated` event (triggered by logout-all / password change / admin kick), pushes `FORCE_LOGOUT` to all of that user's connections, then disconnects immediately.

### Ordering, Completeness, and Reconnection Recovery

- **While alive**: On a single SSE connection, messages arrive strictly ordered and complete — guaranteed by the underlying TCP (the server's `write` order is the client's receipt order). The SSE layer needs no self-added `seq`.
- **During disconnection**: The SSE stream does not replay history (the server does not consume `Last-Event-ID`). After a successful reconnect, the frontend emits `reconnect$`, and each thread does an HTTP incremental catch-up fetch (`refillNewer`) of missed messages using the `newestMsgId` cursor.
- **Multiple connections**: A single user's multiple connections are each individually ordered; ordering is not guaranteed across connections.

### Frontend Handling ([websocket.service.ts](../../web/src/app/services/websocket.service.ts), internally `@microsoft/fetch-event-source`)

- `onopen` receives 401: Throws `AuthNeededError` → the outer loop single-flights `renewAccessToken()`; on success it reopens immediately (not counted toward backoff), on failure it triggers `redoLoginAuth`.
- Receives `NEW_MESSAGE`: Forwards to the thread component for direct rendering (the payload is already the complete message body).
- Receives `FORCE_LOGOUT`: `disconnect` + `redoLoginAuth`; no further reconnection.
- Network/server errors: Exponential backoff + full jitter (`random(0, min(1000·2^attempt, 30000))`); resets to zero once successfully connected.

## Core Business Flows

### Thread Abstraction (Key Design)

All threads are uniformly abstracted as `MessageThread` (type `P2P` or `GROUP`). Each user holds one `UserMessageThread` per thread, and its `status` drives the thread lifecycle:

```
UserMessageThreadStatus:
  FROM_PENDING  → request I sent, awaiting the other party's action
  TO_PENDING    → request I received, awaiting my action
  APPROVED      → thread established
  BLOCKED       → blocked
  DELETED       → deleted
```

- **P2P**: The two users each hold a `UserMessageThread` with `toObjType=P2P` and `toObjId=the other user's ID`; after the friend request is approved, they share the same `MessageThread`.
- **GROUP**: Each member holds a `UserMessageThread` with `toObjType=GROUP` and `toObjId=the group ID`.

### Friend Request State Machine

`MessageService.makeFriendRequest(from, to)` ([src/message/message.service.ts](../../src/message/message.service.ts)) branches on the other party's current `UserMessageThread` status within a transaction:

```
Other party's status  Action                                               Status
─────────────────────────────────────────────────────────────────────────────────────
(none)                Create both records (FROM_PENDING/TO_PENDING)        0
APPROVED              Already friends                                     1
DELETED               Reset to pending                                    2
FROM_PENDING          Other party requested first → establish friendship  3
TO_PENDING/BLOCKED    No further action                                   5
```

`approveFriendRequest(from, to)`: Validates the status is `FROM_PENDING`; on first approval creates a `MessageThread(P2P)`, sets both parties' status to `APPROVED`, and binds the `threadId`.

### Message Sending

`POST /send-message` (body: `userThreadId`, `content`) → `MessageService.writeMsgToThread()`:

1. Validates the sender's `UserMessageThread` is `APPROVED`.
2. P2P: Additionally validates the other party is also `APPROVED`; writes the `Message(PURE_TEXT)`; SSE pushes to both parties.
3. GROUP: Writes the `Message`; SSE pushes to all group members.
4. Pushes the complete message body (`{ threadId, ...message }`, already serialized); the frontend renders directly on receipt with no secondary fetch.

### Group Creation and Invitation

- **Create** (`POST /group/create`): In a transaction, creates `MessageThread(GROUP)` → `Group` (owner, associated thread) → the creator's `UserMessageThread(APPROVED)` + `GroupMember`.
- **Invite** (`POST /group/invite`): Validates that the inviter is a member and the invitee is a friend (both `APPROVED`); writes a `ContentType.INVITE` message in the two users' P2P thread whose content is JSON: `{ type: 'GROUP_INVITE', fromUserId, groupName, expiryDate, token }`. The `token` is a JWT signed with an independent secret (`{ sub: toUserId, exp, gid: groupId }`, valid for 3 days).
- **Join** (`POST /group/join`): Decodes the invitation token → creates `GroupMember` + `UserMessageThread(APPROVED)`.

## Known Issues and Improvements

> Lists items found during code review that affect integration and deployment.

1. ~~**Hardcoded secrets**~~ ✅ Fixed (P0): JWT access/refresh/admin secrets are now externalized; when not explicitly set, they are auto-generated at first startup under `./data/jwt-*.key` (no longer fail-fast; see `src/auth/jwt-secret.ts`). Group invitations switched to the `GROUP_INVITE` message type and no longer use the signing secret.
2. ~~**refresh_token stored only in memory**~~ ✅ Fixed (P0): refresh_token is now persisted to the `RefreshToken` table (storing the sha256 hash); it survives restarts, is revocable (`revokedAt`), and rotates on renewal. This also fixed three bugs — `logout` (reads refresh from the body instead of the JWT payload where it was always undefined, and was made a public endpoint), `renew-access` (no longer mistakenly deletes the refresh, which would break the 7-day scheduled renewal), and `renew-refresh` (now null-checks before revoking, fixing a null-pointer 500).
3. **`NotifyModule` not wired up**: Not yet imported into `AppModule` (Prisma already models `Notify` / `userNotiBox`, but the code does not consume them). `UserManageModule` has been activated by `AdminModule` (`admin/users`), and `UploadModule` is wired up (image/avatar upload is available).
4. ~~**File upload**~~ ✅ Implemented: `UploadModule` ([src/upload/](../../src/upload/)) provides `/upload` (chat images, magic-number validation + 10MB limit) and `/user/update-avatar` (`sharp` multi-size webp rewriting). When switching to object storage in production, only the write target changes; the API contract stays the same.
5. ~~**Frontend authGuard not in effect**~~ ✅ Fixed: `authGuard` / `guestGuard` are now mounted on routes (home/nav use authGuard, login/register use guestGuard).
6. **`/user/query` privacy**: Allows batch queries of any non-deleted user's information, with no relationship-level visibility isolation.
7. ~~**`Date.prototype.toJSON` global override**~~ ✅ Removed (P1): Replaced by the global `SerializeInterceptor` which uniformly converts `Date → ms` / `BigInt → string`, no longer polluting the prototype.
