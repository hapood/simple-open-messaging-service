# API Reference

The SOMS backend listens on `http://localhost:3000` with the global prefix `/api/v1`. Unless otherwise noted, **all endpoints are `POST`** (including query-type endpoints), with JSON request bodies and a unified response format. File upload endpoints use `multipart/form-data`.

## Table of Contents

- [Common Conventions](#common-conventions)
- [Authentication API](#authentication-api)
- [User API](#user-api)
- [Invite API](#invite-api)
- [Message API](#message-api)
- [Group API](#group-api)
- [Calls API](#calls-api)
- [Device & Notification API](#device--notification-api)
- [File / Media API](#file--media-api)
- [Admin API](#admin-api)
- [SSE Events](#sse-events)

---

## Common Conventions

### Authentication model

SOMS authenticates users with a **single opaque session token** — there is **no access/refresh JWT pair**.

- The token is returned once at login (`{ sessionToken }`) and stored sha256-hashed in the `SessionToken` table.
- **Browser / desktop (web shell)**: the server sets it as an **httpOnly cookie** (auto-attached same-origin; JS never reads it). A non-httpOnly `logged_in` presence cookie lets the SPA observe login state.
- **Native (`app`)**: the client sends `Authorization: Bearer <sessionToken>` (stored in OS secure storage; under Tauri the Rust transport injects it).
- Every route is authenticated by the global `SessionAuthGuard` (`APP_GUARD`) unless it opts out with `@Public()` — registration, login, `health`, `config`, `.well-known/*`, and `s2s/*` are public.
- There is **no token-renewal endpoint**. A long-lived token needs no rotation; a revoked/expired token yields `10007` (`SESSION_REVOKED`) and the client re-logs in. On 401 the web client navigates to login (`redoLoginAuth`).
- **Admin** routes use a separate opaque session (`AdminSession`, own secret, `AdminAuthGuard`) — physically isolated from user sessions but sharing the `User` account namespace.

### Response Format

```ts
interface ApiResult<T = any> {
  code: number; // 0 = success; non-0 = business error code (segmented by domain, see below)
  message: string;
  data?: T;
  hasMore?: boolean; // populated for paginated endpoints
}
```

> Business results always use HTTP 200 + `code`; only unauthenticated (401) / not found (404) / conflict (409) / server error (500) retain HTTP status codes. DTO validation failures are folded into the business flow (200 + `10000`). `Date` → ms timestamp; BigInt → string (global `SerializeInterceptor`).

### Business Error Codes

Segmented by domain prefix. Full definitions: [src/common/business-code.ts](../../src/common/business-code.ts) (`BusinessCode` enum).

| Segment | Domain          | Primary codes                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`     | Success         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `10xxx` | General         | `10000` validation · `10001` not found · `10002` already exists · `10003` unauthenticated · `10004` forbidden · `10005` rate-limited/IP-banned · `10007` session revoked · `10008` quota exceeded · `10009` invalid credentials · `10010` registration disabled · `10011` login method disabled · `10012-10016` OTP/QR invalid/expired/consumed · `10017` password not set · `10018` must change password · `10019-10025` admin 2FA / WebAuthn · `10999` server error |
| `20xxx` | Friend · Invite | `20001` friend self · `20002` friend not found · `20004` invalid target (e.g. a group account) · `20010` invite not found · `20011` invite expired · `20012` invite not yours · `20013` invite already handled                                                                                                                                                                                                                                                        |
| `30xxx` | Message         | `30001` empty content · `30002` thread not approved · `30003` thread not found                                                                                                                                                                                                                                                                                                                                                                                        |
| `40xxx` | Group           | `40002` non-friend · `40003` invalid invite token · `40004` owner must transfer · `40005` role forbidden · `40006` target not a member                                                                                                                                                                                                                                                                                                                                |
| `50xxx` | Federation      | `50011` peer daily-quota exceeded (HTTP 429)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `70xxx` | Call            | `70001` not allowed (not friends) · `70002` call not found · `70003` not a participant · `70004` busy · `70005` invalid state transition                                                                                                                                                                                                                                                                                                                              |

---

## Authentication API

> Controllers: [src/controller/auth.controller.ts](../../src/controller/auth.controller.ts) · [auth-otp.controller.ts](../../src/controller/auth-otp.controller.ts) · [auth-qr.controller.ts](../../src/controller/auth-qr.controller.ts) · Service: [src/auth/auth.service.ts](../../src/auth/auth.service.ts)

### POST `/auth/login` — Password login `@Public`

- **Body**: `{ account: string, password: string, client?: 'app'|'web'|'desktop', persistent?: boolean, trusted?: boolean, device?: string }`
  - `client` defaults to `web`. `persistent` (default `true`) = 14-day sliding cookie vs session cookie. `trusted = client==='app' || (client==='desktop' && trusted===true)` → permanent (revocation-only) session.
- **Behavior**: `LocalStrategy` verifies the password (argon2); on success issues a `SessionToken` and sets the session cookies (browser) / returns `{ sessionToken }` (native). Failures are counted by the shared `BruteForceService` (ip + user dims, sliding window + graduated ban ladder).
- **Errors**: `10009` invalid credentials · `10005` banned (`data.bannedUntil`) · `10017` password not set (OTP/QR-only account) · `10018` must change password (admin-generated initial password).

### POST `/auth/otp/login` — OTP login (Android app session) `@Public`

- **Body**: `{ account: string, code: string, device?: string }` — the admin-issued 6-digit one-time login code.
- **Behavior**: verifies the `LoginCode` (argon2, single-use via updateMany guard) → issues a trusted `app` `SessionToken`.
- **Errors**: `10012` OTP invalid · `10013` expired · `10014` consumed.

### POST `/auth/qr/{create,poll,scan,confirm}` — QR login `@Public`

- Desktop calls `create` to render a QR; an already-logged-in device `scan`s it and the desktop `poll`s / `confirm`s to receive a session. Errors: `10015` QR invalid · `10016` expired.

### POST `/auth/logout` — Logout (current session) `@Public`

- Revokes the current `SessionToken` (`revokeReason='logout'`) and clears the session cookies.

### POST `/auth/logout-all` — Logout all devices

- `invalidateAllSessions` — revokes **all** of the user's `SessionToken`s and force-disconnects their SSE connections (`FORCE_LOGOUT`).

### POST `/auth/change-password` · `POST /auth/set-password`

- `change-password`: `{ oldPassword, newPassword }` — verify old, rotate, revoke **every** session (the client re-logs in). `10000` message=`old password wrong` on mismatch.
- `set-password`: forced first-time set after an admin-generated initial password (clears `mustChangePassword`); the caller is already session-authenticated.

### POST `/auth/sessions` · `POST /auth/revoke-session`

- `sessions`: list the user's active `SessionToken`s (device / userAgent / ip / createdAt / expiresAt / lastSeenAt).
- `revoke-session`: `{ sessionId }` revoke one of the user's sessions.

> Full session-hardening rationale (opaque token, trusted vs sliding lifetime, revocation reasons, SSE coordination) is in [architecture.md → Authentication](../overview/architecture.md#authentication-mechanism).

---

## User API

> Controller: [src/controller/user.controller.ts](../../src/controller/user.controller.ts)

### POST `/user/register` `@Public`

- **Body**: `{ account, password, name? }`. Validation: account `^(?=[\w.-]{1,20}$)(?:[\d_.-]*[a-zA-Z]){3}[\w.-]*$`; password 6–20, allowed charset.
- **Behavior**: creates a `User` (profile columns inline — name defaults to account); `domain='local'`, `isForeigner=false`.
- **Errors**: `10002` already exists · `10010` registration disabled (admin-provisioned accounts only — the common mode).

### POST `/user/my-profile` · `/user/update-profile` · `/user/update-avatar`

- `my-profile`: current user info (password hash omitted).
- `update-profile`: `{ name?, bio? }` (handle cannot change; bumps `profileRev`).
- `update-avatar`: `multipart/form-data` `file` → `sharp` multi-size webp (32/64/128/256/512, EXIF-oriented, cover-cropped, bomb-guarded); returns `{ avatar }` (the 512px URL).

### POST `/user/query-state/delta` — Client state delta

- **Body**: `{ fromRevision: number, toRevision: number }` (revision range). Returns hydrated thread
  ADD/DELETE, PROFILE/PROFILE_DELETE, complete MEMBER_PROFILE snapshots and compacted CLIENT_STATE entries since the
  client's `stateRevision` cursor. An ADD is an authoritative replacement snapshot and may represent a
  group/roster/role change or a per-user thread-setting/read-state change, not only a new conversation.
  The current user's own avatar/name/bio update is included as PROFILE in this same log.
  MEMBER_PROFILE carries the source-scoped address, local `userId`, display name, avatar, profile revision,
  and affected thread ids. Clients persist it locally and never merge source-scoped displays by userId alone.

### POST `/user/query` · `/user/resolve` · `/user/search`

- `query`: `{ userIds: number[] }` (`@ArrayMaxSize(100)`) batch user lookup.
- `resolve` / `search`: local exact/fuzzy lookup. A foreign domain is rejected by `resolve`; federated
  exact lookup must use the temporary stream below. (`10001` not found.)

### GET `/user/resolve-federated-stream` — Temporary federated exact lookup

- **Query**: `{ account, domain }`; authenticated temporary SSE, with a 30-second server-side bound.
- Emits one terminal `resolved` or `failed` event and closes. Closing the client connection cancels client
  interest; the server-to-peer request keeps its normal bounded timeout.
- The result is an untrusted display card plus relationship status. It is never persisted and never creates
  a stub; clients may close it and start another lookup at any time.

### POST `/user/delete-friend` · `/user/block`

- `delete-friend`: `{ threadId }` unfriend (drops the P2P `ThreadParticipant` rows; `20002` if not friends).
- `block`: `{ userId }` one-way block (creates a `UserBlock`).

### POST `/user/peer-trust-status` · `/user/thread-info`

- Peer-trust status and per-thread details respectively. Federated profiles and group metadata arrive through the server state feed; there is no client-triggered freshness probe.

---

## Invite API

> Controller: [src/controller/invite.controller.ts](../../src/controller/invite.controller.ts) · Service: [src/invite/invite.service.ts](../../src/invite/invite.service.ts)

Friend and group requests use directed facts. `FriendRequest(A,B)` and `FriendRequest(B,A)` are independent
rows with independent notes; group invitation and join intent are likewise separate
`GroupMembershipRequest` directions. The former polymorphic `Invite` table has been removed. REST
`inviteId` values are stringified ids of the corresponding directed fact.

### POST `/invite/friend` — Send friend invite

- **Body**: `{ toUserId: number, note?: string(≤255) }`. Upserts the caller's directed request. A new
  request expires after seven days; an explicit resend after expiry renews the
  absolute expiry. `20001` friending self · `20004` invalid target.

### POST `/invite/federated-friend` — Send a pre-stub federated request

- **Body**: `{ account, domain, note?, displayName?, avatar? }`. `account + domain` are the immutable target
  Address; `displayName/avatar` are only the untrusted request-card snapshot returned by the temporary
  lookup. The client is session-authenticated but does not sign this application or its snapshot.
- The server does not create a target stub. A human foreign stub is created only after the peer publishes
  valid `ACCEPTED` state and a verified home-owned PROFILE is available.
- The response echoes `{ account, domain }`; no federated request id or foreign User stub is exposed.

### POST `/invite/accept` · `/invite/reject` · `/invite/revoke`

- **Body**: local request `{ inviteId }`; pre-stub federated request `{ account, domain }`.
- `accept`: authors the caller's reverse direction. A P2P thread becomes active only when both friend
  directions are effective in the same transaction; a federated group mirror becomes active only after
  the origin's state snapshot confirms membership.
- `reject` / `revoke`: close only the caller-owned direction. Federation convergence is asynchronous
  through the state feed; there are no S2S invite command endpoints.
- Every pending friend/group request has an absolute expiry of at most seven days. Expired requests are
  ineffective even if an old feed projection remains. REVOKED has no expiry and is retained best-effort.

### POST `/invite/incoming` · `/invite/outgoing`

- Lists received / sent invites (`{ status?, kind? }` filters).

### POST `/invite/detail`

- `detail`: `{ inviteId }` full invite + resolution to accounts.
- Reading an incoming request is client-local; each device stores its own seen state revision.

---

## Message API

> Controller: [src/controller/message.controller.ts](../../src/controller/message.controller.ts) · DTO: [src/dto/message.dto.ts](../../src/dto/message.dto.ts)

### POST `/send-message` — Send message

- **Body**: `{ threadId: number, content: string, contentType?: 'PURE_TEXT'|'LINK', clientMessageId?: UUID }`. Media messages use `/send-media` followed by the matching `/upload*` endpoint.
- **Behavior**: `ThreadAccessGuard` checks membership; allocates a per-thread `seq` atomically from `curSeq`; `MessageFanoutService` pushes `NEW_MESSAGE` (full body) to all participants + fires push for offline recipients. `clientMessageId` is the send-idempotency key (a retry returns the original message).
- **Errors**: `30001` empty · `30002` not approved · `30003` thread not found.

### POST `/send-media` — Send media (staged)

- **Body**: `{ threadId, contentType: 'IMAGE'|'FILE'|'VIDEO'|'AUDIO', clientMessageId, ...display meta }`. Stages a `PendingMedia` row; the bytes land via `/upload` and are promoted to a `Message` once confirmed. (`/query-media-stages`, `/media-status`, `/relocalize-media` support the staging lifecycle.)

### POST `/send-forward` — Send an immutable forwarded-message bundle

- **Body**: `{ threadId, sourceMessages: [{ threadId, seq }], clientMessageId }` (1–100 source messages).
- **Behavior**: the server, never the client, snapshots sender display data and content into a `ForwardBundle.manifest` JSONB document. `manifest.children` is an ordered array of directly nested bundle ids; `ForwardBundleDependency` mirrors it for indexed traversal. Attachment and avatar bytes remain deduplicated CAS objects referenced by `ForwardBundleAsset`. The resulting `Message` has `contentType: 'FORWARD'`; its small JSON content contains only `bundleId`, up to three 100-grapheme summary lines and counts.
- **Depth**: a leaf bundle is depth 1 and a parent is `1 + max(child.depth)`. Maximum depth is 3. Attempting to forward an existing depth-3 card returns `30004`; the server recomputes this regardless of frontend checks.
- **Read**: `GET /forward-bundles/:bundleId` returns the visible root and its complete child closure after checking that the caller participates in a thread containing the root card.

### POST `/query-messages` — Paginated history

- **Body**: `{ threadId, skip, take, lastId?, orderBy? }` — keyset cursor pagination over `(threadId, seq)`.

### POST `/thread/{by-user-id, mark-read, set-muted, set-pinned, clear-history, set-alias}`

- Per-`ThreadParticipant` mutations: the P2P thread lookup, read watermark advance, mute, pin, clear-history, and per-thread alias. `search-messages` does in-chat search.

`mark-read` commits a viewport-dwelled HWM on chat close/switch:

- **Body**: `{ threadId, localReadHwm }`.
- The server stores `max(ThreadParticipant.lastReadSeq, localReadHwm)` and returns
  `{ threadId, lastReadSeq, unreadCount, mentionUnread }`.
- `unreadCount` is capped at `1000`; `1000` means 1000 or more and clients render it as `999+`.
- `mentionUnread` is an unordered, duplicate-free set encoded as an array containing zero or more of
  `"all"` and `"me"`. Empty means no mention; the legacy `"none"` value is not valid. Clients must not
  attach meaning to array order.
- Both count and mentions are derived from the same first 1000 unread, non-self-authored messages after the
  committed HWM.
- This contract is intentionally incompatible with the retired `lastReadSeq` request and scalar mention
  response; callers and servers must be deployed together.

---

## Group API

> Controller: [src/controller/group.controller.ts](../../src/controller/group.controller.ts) · DTO: [src/dto/group.dto.ts](../../src/dto/group.dto.ts)

### POST `/group/create`

- **Body**: `{ name, avatar?, bio?, inviteUserIds?: number[] }`. Creates `MessageThread(GROUP)` + the
  `!`-User group identity + `Group`; writes a GROUP→USER invitation direction for every selected friend.
  Returns `{ threadId }`.

### POST `/group/invite`

- **Body**: `{ groupId, userIds: number[] }` — mint GROUP invites for existing friends. `40002` non-friend.

### POST `/group/info`

- `info` (`{ groupId }`): complete group profile plus authoritative membership/role facts. Conversation ADD
  snapshots carry the same roster facts; member display metadata arrives as PROFILE/MEMBER_PROFILE state and
  is read from the client's local database. There is no separate roster-fetch or client-triggered sync endpoint.

### POST `/group/{leave, kick, transfer, set-role, update}`

- `leave` (`40004` owner must transfer first) · `kick` (`40005` forbidden, `40006` target not a member) · `transfer` (ownership) · `set-role` (ADMIN/MEMBER) · `update` (name/avatar/bio).

---

## Calls API

> Controller: [src/controller/calls.controller.ts](../../src/controller/calls.controller.ts) · Service: [src/calls/calls.service.ts](../../src/calls/calls.service.ts)

1:1 audio/video calls. The server is a **signaling coordinator + lifecycle owner only** — it never touches media. On a terminal state `CallsService` authors a `ContentType.CALL` chat bubble (bilateral).

- `POST /calls/initiate` `{ callSid, calleeUserId, callType }` → `{ callSid, threadId }` (`70001` not friends · `70004` busy).
- `POST /calls/{accept, ringing, connected, decline, cancel, end, signal}` drive the FSM (`70002` not found · `70003` not a participant · `70005` invalid transition).
- `GET /calls/ice-servers` — TURN/STUN helper (TURN off by default; misconfig throws).
- `GET /calls/:callSid/signaling` — caller-side answer fetch.

See [docs/android-calls-client.md](../android-calls-client.md) and [docs/roadmap/android-calls-followup.md](../roadmap/android-calls-followup.md).

---

## Device & Notification API

> Controllers: [device.controller.ts](../../src/controller/device.controller.ts) · [notification.controller.ts](../../src/controller/notification.controller.ts)

- `POST /devices/register` / `DELETE /devices/register/:token` — register/unregister a push token (FCM registration token for ANDROID, Web Push subscription for WEB; a device's token is re-owned to the current user on re-register).
- `GET /notifications/vapid-key` (`@Public`) — Web Push VAPID public key.
- `POST /notifications/missed-summary` · `/notifications/missed` · `/notifications/action` — missed-notification catch-up (identity-only signals; the client fetches bodies) + notification action dispatch. Missed notifications carry a server-authored descriptor.

---

## File / Media API

> Controller: [src/upload/upload.controller.ts](../../src/upload/upload.controller.ts) · Service: [src/upload/upload.service.ts](../../src/upload/upload.service.ts)

### POST `/upload` — Upload (chat media / avatar)

- **Body**: `multipart/form-data`, field `file`; for chat media, plus `w`/`h` form fields. Allowed: jpg/png/gif/webp (magic-number validated). Size limit per type (video up to ~100 MB; `@fastify/multipart` 100 MB part cap).
- **Behavior**: writes bytes through the **content-addressed CAS pipeline** — `MediaAsset` uses sha256 of the raw bytes and stores exactly one extensionless blob at `data/cas/<dd>/<dd>/<digest>`; filename, MIME and message type remain message metadata. Avatars use the separate `sharp` multi-size webp pipeline. The returned `/uploads/cas/<dd>/<dd>/<digest>` URL is gated by `MediaAccessService` and only READY assets are readable.
- **Response `data`**: `{ url, w, h }` (chat) or `{ avatar }` (avatar).
- **Media serving**: `/uploads/*` is served by `@fastify/static` with a root `preHandler` that honors the httpOnly `media_token` cookie **or** a `Bearer` header (resolved by `BearerAuthService`), plus per-object CAS-shard authorization. (Avatars are public.)

> When switching to object storage (S3/OSS/MinIO), only the write target + URL generation change; the API contract stays the same.

---

## Admin API

> Controllers under `src/admin/` · Service: [src/admin/admin-auth.service.ts](../../src/admin/admin-auth.service.ts)

Admin auth is a **separate opaque session** (`AdminSession`, own `adminSecret`, `AdminAuthGuard`) — physically isolated from user sessions, but an admin is a linked profile on a `User` row (`Admin.userId → User.id`). `/admin/login` verifies `User.hashPwd` then issues an admin session. All admin routes except `admin/login` require the admin session (httpOnly admin cookie).

### Authentication

- `POST /admin/login` `{ account, password }` → `{ sessionToken }` (sets the admin cookie); updates `Admin.lastLoginAt/lastLoginIp`. `10009` invalid credentials / disabled.
- `POST /admin/logout` — revokes the admin session.
- Opt-in second factors: **TOTP** (RFC 6238, AES-GCM secret + backup codes) and **WebAuthn passkeys** — enroll/verify flows under `TwoFactorController` / `WebAuthnController`.

### Management

- `POST /admin/users` `{ skip?, take?, search? }` → `{ list, total }`.
- `POST /admin/users/:id/{disable,enable,force-logout,sessions,reset-password}` — disable (soft-delete + invalidate sessions), enable, force logout, view sessions, reset password (all invalidate sessions).
- `POST /admin/bans` · `/admin/bans/unban` `{ ip?, account? }` — list/unban login bans (the shared `BruteForceService`; one unban clears all account-keyed dims — password + OTP).
- `POST /admin/sessions` `{ skip?, take?, userId?, ip? }` · `/admin/sessions/purge` — system-wide session overview / one-click purge.
- `POST /admin/audit` — `@Audit`-tagged action log (`AdminActionLog`).
- Federation / quota admin: `AdminFederationController` (peer trust timeline), `AdminQuotaController` (per-peer quota overrides). Diagnostics + log viewer: `AdminDiagnosticsController`, `LogViewerController` (`/admin/logs/*`).

---

## SSE Events

> Endpoint: [src/gateway/events.controller.ts](../../src/gateway/events.controller.ts) + [src/gateway/sse.service.ts](../../src/gateway/sse.service.ts) · `GET /api/v1/events` (`text/event-stream`)

### Connection & HELLO

The browser opens the stream via a fetch-backed SSE client inside a Web Worker (the native EventSource API cannot set headers). The credential travels as the **httpOnly cookie** (browser) or `Authorization: Bearer` (native) — never in the URL. Authentication failure → HTTP 401 (no frame); the client reconnects.

On connect the server pushes a **`HELLO`** frame with catch-up cursors: newest-message cursor,
`stateRevision`, and `activeCall`. `stateRevision` covers hydrated thread state (including group/roster
invalidation and per-user settings/read state), cached profile changes, source-scoped member profiles, and
incoming friend requests. Heartbeat: a `: ping` comment frame every 25s.

### Frame format

```
event: <EVENT_NAME>
data: <json>
```

### Event list (backend → frontend)

| Event                        | Purpose                                            | Recovery source                           |
| ---------------------------- | -------------------------------------------------- | ----------------------------------------- |
| `HELLO`                      | connection handshake and current high-water marks  | sent on every connection                  |
| `STATE_REV_UPDATED`          | identity-only unified client-state wake            | `HELLO.stateRevision` + ranged state pull |
| `NEW_MESSAGE`                | identity-only message wake `{ threadId, seq, ts }` | missed-message/message query              |
| `DELETED_MESSAGE_UPDATED`    | identity-only deletion-log wake                    | deletion HWM/log                          |
| `MEDIA_STATUS`               | media-localization completion wake                 | message/media query                       |
| `CALL_EVENT` / `CALL_SIGNAL` | ephemeral call lifecycle and WebRTC signaling      | active-call snapshot/new negotiation      |
| `FORCE_LOGOUT`               | terminate a revoked session                        | authentication state                      |

There are no dedicated group, profile, friend/request, thread-metadata, or read-state SSE events. Those
changes are committed to the unified state log first and SSE carries only `STATE_REV_UPDATED`.

> Ordering & completeness: on a live connection, strict ordering is guaranteed by TCP; state missed during a disconnect is caught up from `stateRevision`, and messages are caught up from the per-thread message cursors (the stream does not replay history — no `Last-Event-ID`).

### Client → Server

SSE is unidirectional; **clients do not send business messages over SSE**. All writes (sending messages, invites, calls, future typing) go through HTTP `POST`.
